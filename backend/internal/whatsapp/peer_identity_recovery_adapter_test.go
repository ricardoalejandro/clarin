package whatsapp

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waLidMigrationSyncPayload"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestPeerUSyncPersistsOnlyExplicitWirePairs(t *testing.T) {
	pn, lid := types.NewJID("51900000001", types.DefaultUserServer), types.NewJID("7001", types.HiddenUserServer)
	rows := peerIsOnWhatsAppObservations([]types.IsOnWhatsAppResponse{
		{Query: "+51900000001", JID: lid, IsIn: true}, // query is not a returned PN
		{JID: pn, PhoneNumber: pn, IsIn: true},
		{JID: lid, PhoneNumber: pn, IsIn: false},
		{JID: lid, PhoneNumber: pn, IsIn: true},
	})
	if len(rows) != 1 || rows[0].PN != pn.String() || rows[0].LID != lid.String() || rows[0].Source != "usync_check" || rows[0].ObservedAt == nil {
		t.Fatalf("incorrect wire evidence: %+v", rows)
	}
	info := peerUserInfoObservations(map[types.JID]types.UserInfo{
		lid: {LID: lid},
		types.NewJID("51900000002", types.DefaultUserServer): {},
		pn: {LID: lid},
	})
	if len(info) != 1 || info[0].PN != pn.String() || info[0].LID != lid.String() || info[0].Source != "user_info" {
		t.Fatalf("lookup request/cache became proof: %+v", info)
	}
}

func TestPeerLegacyPNIsNormalizedOnlyInDeliveredPhoneFields(t *testing.T) {
	pn, lid := "51900000001@c.us", "7001@lid"
	name := "Original agenda"
	history := peerHistoryObservations(&waHistorySync.HistorySync{PhoneNumberToLidMappings: []*waHistorySync.PhoneNumberToLIDMapping{{PnJID: &pn, LidJID: &lid}}})
	if len(history) != 1 || history[0].PN != "51900000001@s.whatsapp.net" || history[0].LID != lid {
		t.Fatalf("delivered legacy PN lost: %+v", history)
	}
	rows := peerAppStateObservations(&events.AppState{Index: []string{appstate.IndexContact, pn}, SyncActionValue: &waSyncAction.SyncActionValue{ContactAction: &waSyncAction.ContactAction{FullName: &name, LidJID: &lid}}})
	if len(rows) != 1 || rows[0].JID != "51900000001@s.whatsapp.net" || rows[0].ObservedAt != nil {
		t.Fatalf("legacy contact or missing wire time misread: %+v", rows)
	}
	numericLID := types.NewJID("51900000001", types.HiddenUserServer)
	if !phoneIdentityJID(normalizePeerWireJID(numericLID)).IsEmpty() {
		t.Fatal("numeric LID became a phone")
	}
	invalid := types.NewJID("not-a-phone", types.LegacyUserServer)
	if !phoneIdentityJID(normalizePeerWireJID(invalid)).IsEmpty() {
		t.Fatal("invalid legacy address became phone")
	}
}

func TestPeerFullSyncContactNeverMutatesCRM(t *testing.T) {
	evt := &events.Contact{JID: types.NewJID("51900000001", types.DefaultUserServer), FromFullSync: true, Action: &waSyncAction.ContactAction{}}
	// A nil pool proves the actual handler returns before all CRM access.
	var pool *DevicePool
	pool.handleContactEvent(context.Background(), nil, evt)
	if contactEventMayMutateCRM(evt) || contactEventMayMutateCRM(nil) {
		t.Fatal("full snapshot reached CRM")
	}
	evt.FromFullSync = false
	if !contactEventMayMutateCRM(evt) {
		t.Fatal("normal incremental contact contract changed")
	}
}

func TestPeerReplayKeepsWireTimestampAndMissingUsername(t *testing.T) {
	name := "Historical name"
	at := time.Now().Add(-24 * time.Hour).UTC().Truncate(time.Millisecond)
	stamp := at.UnixMilli()
	rows := peerAppStateObservations(&events.AppState{Index: []string{appstate.IndexLIDContact, "7001@lid"}, SyncActionValue: &waSyncAction.SyncActionValue{Timestamp: &stamp, LidContactAction: &waSyncAction.LidContactAction{FullName: &name}}})
	if len(rows) != 1 || rows[0].ObservedAt == nil || !rows[0].ObservedAt.Equal(at) {
		t.Fatalf("replay gained a current observation date: %+v", rows)
	}
	if _, ok := rows[0].Fields["username"]; ok {
		t.Fatal("missing username became deletion")
	}
}

func TestPeerRecoveryRequiresPersistenceAndCompletionAcknowledgement(t *testing.T) {
	instance := &DeviceInstance{}
	epoch := &peerIdentityRecoveryEpoch{}
	peerIdentityRecoveryEpochs.Store(instance, epoch)
	defer peerIdentityRecoveryEpochs.Delete(instance)
	if epoch.result() == nil {
		t.Fatal("missing sync completion acknowledged")
	}
	recordPeerIdentitySyncComplete(instance, appstate.WAPatchRegular)
	if epoch.result() == nil {
		t.Fatal("another collection completed recovery")
	}
	recordPeerIdentitySyncComplete(instance, appstate.WAPatchCriticalUnblockLow)
	if epoch.result() != nil {
		t.Fatal("successful completed epoch rejected")
	}
	sentinel := errors.New("synthetic persistence failure")
	recordPeerIdentityPersistence(instance, sentinel)
	if !errors.Is(epoch.result(), sentinel) {
		t.Fatal("SDK success hid persistence failure")
	}
}

func TestPeerRecoveryRejectsReplacedSessionBeforePersistence(t *testing.T) {
	account, device := uuid.New(), uuid.New()
	paired := deletionTestStore()
	instance := &DeviceInstance{ID: device, AccountID: account, Client: whatsmeow.NewClient(paired, nil)}
	pool := &DevicePool{devices: map[uuid.UUID]*DeviceInstance{device: instance}}
	fingerprint := deviceSessionFingerprint(paired)
	snapshot := pool.GroupParticipantIdentities(context.Background(), account, device)
	if err := pool.requirePeerIdentitySession(instance, fingerprint); err != nil {
		t.Fatal(err)
	}
	replacement := &DeviceInstance{ID: device, AccountID: account, Client: whatsmeow.NewClient(deletionTestStore(), nil)}
	pool.devices[device] = replacement
	if _, err := snapshot.Resolve(context.Background(), []domain.GroupParticipant{{JID: "7001@lid"}}); !errors.Is(err, repository.ErrWhatsAppIdentitySessionChanged) {
		t.Fatal("stale provider-name snapshot survived session replacement")
	}
	if !errors.Is(pool.requirePeerIdentitySession(instance, fingerprint), repository.ErrWhatsAppIdentitySessionChanged) {
		t.Fatal("late response reached replaced instance")
	}
	if !errors.Is(pool.requirePeerIdentitySession(replacement, fingerprint), repository.ErrWhatsAppIdentitySessionChanged) {
		t.Fatal("new session accepted old fingerprint")
	}
}

func TestGroupIdentitySnapshotPropagatesCacheFailureWithoutMutatingRows(t *testing.T) {
	sentinel := errors.New("synthetic contacts failure")
	account, device := uuid.New(), uuid.New()
	instance := &DeviceInstance{ID: device, AccountID: account, Client: whatsmeow.NewClient(&store.Device{Contacts: &failingPeerContacts{err: sentinel}}, nil)}
	pool := &DevicePool{devices: map[uuid.UUID]*DeviceInstance{device: instance}}
	rows := []domain.GroupParticipant{{JID: "7001@lid", Name: "Existing row"}}
	result, err := pool.GroupParticipantIdentities(context.Background(), account, device).Resolve(context.Background(), rows)
	if !errors.Is(err, sentinel) || result != nil || rows[0].Name != "Existing row" {
		t.Fatalf("cache failure became an empty identity: %v %+v", err, result)
	}
}

type failingPeerContacts struct {
	store.NoopStore
	err error
}

func (c *failingPeerContacts) GetAllContacts(context.Context) (map[types.JID]types.ContactInfo, error) {
	return nil, c.err
}

func TestPeerOwnMigrationUsesOnlyDecodedDeliveredPairs(t *testing.T) {
	payload, err := proto.Marshal(&waLidMigrationSyncPayload.LIDMigrationMappingSyncPayload{PnToLidMappings: []*waLidMigrationSyncPayload.LIDMigrationMapping{{Pn: proto.Uint64(51900000001), AssignedLid: proto.Uint64(7001)}}})
	if err != nil {
		t.Fatal(err)
	}
	evt := &events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{IsFromMe: true}}, Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{LidMigrationMappingSyncMessage: &waE2E.LIDMigrationMappingSyncMessage{EncodedMappingPayload: payload}}}}
	rows := peerMigrationObservations(evt)
	if len(rows) != 1 || rows[0].PN != "51900000001@s.whatsapp.net" || rows[0].LID != "7001@lid" || rows[0].ObservedAt != nil {
		t.Fatalf("migration snapshot not captured: %+v", rows)
	}
	evt.Info.IsFromMe = false
	if len(peerMigrationObservations(evt)) != 0 {
		t.Fatal("foreign protocol imported session aliases")
	}
	evt.Info.IsFromMe = true
	evt.Message.ProtocolMessage.LidMigrationMappingSyncMessage.EncodedMappingPayload = []byte{0xff}
	if len(peerMigrationObservations(evt)) != 0 {
		t.Fatal("malformed protocol created identities")
	}
}

func TestPeerObserverPersistenceFailurePoisonsRecoveryEpoch(t *testing.T) {
	instance := &DeviceInstance{Client: whatsmeow.NewClient(deletionTestStore(), nil)}
	epoch := &peerIdentityRecoveryEpoch{}
	peerIdentityRecoveryEpochs.Store(instance, epoch)
	defer peerIdentityRecoveryEpochs.Delete(instance)
	recordPeerIdentitySyncComplete(instance, appstate.WAPatchCriticalUnblockLow)
	var pool *DevicePool
	err := pool.observePeerIdentities(context.Background(), instance, []domain.WhatsAppPeerObservation{{JID: "7001@lid", Source: "contact_action"}})
	if err == nil || epoch.result() == nil {
		t.Fatal("failed persistence was acknowledged as successful full sync")
	}
}

func TestPeerProfileDoesNotShowReassignedPhoneOwnersInfo(t *testing.T) {
	member := domain.GroupParticipant{JID: "51900000001@s.whatsapp.net", LID: "7001@lid", Phone: "51900000001"}
	if groupParticipantProfileIdentityMatches(member, types.UserInfo{LID: types.NewJID("7002", types.HiddenUserServer)}) {
		t.Fatal("phone reassignment exposed another stable identity's profile")
	}
	if !groupParticipantProfileIdentityMatches(member, types.UserInfo{LID: types.NewJID("7001", types.HiddenUserServer)}) {
		t.Fatal("matching returned identity was rejected")
	}
}

func TestPeerRecoveryIgnoresOtherAppStateCollectionErrors(t *testing.T) {
	instance := &DeviceInstance{}
	epoch := &peerIdentityRecoveryEpoch{}
	peerIdentityRecoveryEpochs.Store(instance, epoch)
	defer peerIdentityRecoveryEpochs.Delete(instance)
	recordPeerIdentitySyncComplete(instance, appstate.WAPatchCriticalUnblockLow)
	sentinel := errors.New("synthetic collection error")
	recordPeerIdentitySyncError(instance, appstate.WAPatchRegular, sentinel)
	if err := epoch.result(); err != nil {
		t.Fatalf("unrelated collection poisoned recovery: %v", err)
	}
	recordPeerIdentitySyncError(instance, appstate.WAPatchCriticalUnblockLow, sentinel)
	if !errors.Is(epoch.result(), sentinel) {
		t.Fatal("matching collection error was ignored")
	}
}

func TestPeerHistoryMissingMessageTimeIsFillOnly(t *testing.T) {
	lid, name := "7001@lid", "Undated observed name"
	message := &waWeb.WebMessageInfo{PushName: &name}
	history := &waHistorySync.HistorySync{Conversations: []*waHistorySync.Conversation{{ID: &lid, Messages: []*waHistorySync.HistorySyncMsg{{Message: message}}}}}
	rows := peerHistoryObservations(history)
	if len(rows) != 1 || rows[0].ObservedAt != nil {
		t.Fatalf("missing timestamp became a dated observation: %+v", rows)
	}
	message.MessageTimestamp = proto.Uint64(1234)
	rows = peerHistoryObservations(history)
	if len(rows) != 1 || rows[0].ObservedAt == nil || rows[0].ObservedAt.Unix() != 1234 {
		t.Fatal("actual history timestamp was discarded")
	}
}

func TestPeerRecoveryPreservesPersistenceFailureClassification(t *testing.T) {
	for _, failure := range []error{io.EOF, errors.New("synthetic database failure without pgconn type")} {
		epoch := &peerIdentityRecoveryEpoch{complete: true}
		epoch.record(failure)
		err := epoch.result()
		if !errors.Is(err, failure) {
			t.Fatal("typed persistence wrapper lost original failure")
		}
		if code := identityRecoveryFailureCode(err, "appstate_unavailable"); code != "persistence_unavailable" {
			t.Fatalf("database failure attributed to WhatsApp: %s", code)
		}
	}
}
