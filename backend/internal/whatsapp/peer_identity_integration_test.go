package whatsapp

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/pkg/database"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// This regression uses the actual shared whatsmeow SQL store. The same global
// pair is visible to both provider clients, but only the device that received
// that pair in its own HistorySync may expose/use it in Clarin identity.
func TestPeerIdentityScopedProviderHistoryIntegration(t *testing.T) {
	raw := os.Getenv("INTEGRITY_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("requires dedicated synthetic PostgreSQL")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Path != "/program_survey_integrity_test" {
		t.Fatal("dedicated program_survey_integrity_test database required")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	shared, err := sqlstore.New(ctx, "pgx", raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = shared.Close() })
	repos := repository.NewRepositories(db)
	accountA, accountB, deviceA, deviceB := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err = db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Scoped identity A'),($2,'Scoped identity B')`, accountA, accountB); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(ctx, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{accountA, accountB})
	})
	if _, err = db.Exec(ctx, `INSERT INTO devices(id,account_id,name) VALUES($1,$2,'Synthetic identity A'),($3,$4,'Synthetic identity B')`, deviceA, accountA, deviceB, accountB); err != nil {
		t.Fatal(err)
	}
	// Synthetic unique identities avoid touching any existing provider mapping.
	pn := types.NewJID("519"+time.Now().UTC().Format("150405000"), types.DefaultUserServer)
	lid := types.NewJID("70"+time.Now().UTC().Format("150405000"), types.HiddenUserServer)
	if err = shared.LIDMap.PutLIDMapping(ctx, lid, pn); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec(ctx, `DELETE FROM whatsmeow_lid_map WHERE lid=$1 AND pn=$2`, lid.User, pn.User) })
	pool := &DevicePool{repos: repos, store: shared, devices: map[uuid.UUID]*DeviceInstance{}}
	makeInstance := func(account, device uuid.UUID) *DeviceInstance {
		cache := &groupCountingContacts{contacts: map[types.JID]types.ContactInfo{pn: {FullName: "Unrelated phone name"}, lid: {PushName: "Observed LID name"}}}
		paired := deletionTestStore()
		paired.Contacts, paired.LIDs = cache, shared.LIDMap
		instance := &DeviceInstance{ID: device, AccountID: account, Client: whatsmeow.NewClient(paired, nil)}
		pool.devices[device] = instance
		return instance
	}
	instanceA, instanceB := makeInstance(accountA, deviceA), makeInstance(accountB, deviceB)
	pnRaw, lidRaw := pn.String(), lid.String()
	history := &waHistorySync.HistorySync{PhoneNumberToLidMappings: []*waHistorySync.PhoneNumberToLIDMapping{{PnJID: &pnRaw, LidJID: &lidRaw}}}
	if err := pool.observePeerIdentities(ctx, instanceA, peerHistoryObservations(history)); err != nil {
		t.Fatal(err)
	}
	source := types.MessageSource{Chat: lid, Sender: lid}
	identityA := pool.resolveMessagePeerIdentity(ctx, instanceA, source)
	identityB := pool.resolveMessagePeerIdentity(ctx, instanceB, source)
	if identityA.JID != pn || identityA.Pending || identityB.JID != lid || !identityB.Pending || identityB.phone() != "" {
		t.Fatalf("provider-global mapping crossed account/device: A=%+v B=%+v", identityA, identityB)
	}
	// The pinned provider autofills SenderAlt from its global map and copies
	// PushName/BusinessName across that map. Neither can mint local proof.
	phoneSource := types.MessageSource{Chat: pn, Sender: pn, SenderAlt: lid}
	msgInfo := types.MessageInfo{MessageSource: phoneSource, Timestamp: time.Now().UTC(), PushName: "PN original name"}
	pool.observePeerMessage(ctx, instanceB, &events.Message{Info: msgInfo})
	pool.observePeerPushName(ctx, instanceB, &events.PushName{JID: pn, JIDAlt: lid, Message: &msgInfo, NewPushName: "PN updated name"})
	pool.observePeerBusinessName(ctx, instanceB, &events.BusinessName{JID: pn, Message: &msgInfo, NewBusinessName: "PN original business"})
	pool.observePeerGroupMetadata(ctx, instanceB, &types.GroupInfo{Participants: []types.GroupParticipant{{JID: lid}}}, map[types.JID]types.ContactInfo{lid: {PushName: "Copied foreign push", BusinessName: "Copied foreign business"}})
	unsafe, err := repos.Chat.WhatsAppPeerIdentities(ctx, accountB, deviceB, []string{pnRaw, lidRaw})
	if err != nil {
		t.Fatal(err)
	}
	if len(unsafe.LIDForPN) != 0 || len(unsafe.Fields[lidRaw]) != 0 {
		t.Fatalf("global-derived event/cache became local LID evidence: %+v", unsafe)
	}
	if got := pool.resolveMessagePeerIdentity(ctx, instanceB, phoneSource); got.JID != pn || !got.LID.IsEmpty() {
		t.Fatalf("canonical PN message reconciled unproved LID: %+v", got)
	}
	pollutedView, resolveErr := pool.ResolveCachedGroupParticipant(ctx, accountB, deviceB, domain.GroupParticipant{JID: lidRaw, LID: lidRaw, Name: "Observed LID name", NameSource: "push_name"})
	if resolveErr != nil {
		t.Fatal(resolveErr)
	}
	if pollutedView.Name != "Nombre no disponible" || pollutedView.Phone != "" {
		t.Fatalf("polluted alternate cache exposed a cross-identity name: %+v", pollutedView)
	}
	// An actual name event whose original JID is the LID remains usable even
	// though no phone relationship has been observed by this device.
	pool.observePeerPushName(ctx, instanceB, &events.PushName{JID: lid, JIDAlt: pn, Message: &types.MessageInfo{Timestamp: time.Now().UTC()}, NewPushName: "Observed LID name"})
	member := domain.GroupParticipant{JID: lidRaw, LID: lidRaw}
	projectedB, resolveErr := pool.ResolveCachedGroupParticipant(ctx, accountB, deviceB, member)
	if resolveErr != nil {
		t.Fatal(resolveErr)
	}
	addressB, resolveErr := pool.ResolveCachedGroupParticipantAddress(ctx, accountB, deviceB, member)
	if resolveErr != nil {
		t.Fatal(resolveErr)
	}
	if projectedB.Phone != "" || projectedB.Name != "Observed LID name" || addressB.Phone != "" {
		t.Fatalf("group/profile exposed unobserved phone: %+v %+v", projectedB, addressB)
	}
	legacyB := domain.GroupParticipant{JID: pnRaw, LID: lidRaw, Phone: pn.User, Name: "Unrelated phone name"}
	legacyViewB, resolveErr := pool.ResolveCachedGroupParticipant(ctx, accountB, deviceB, legacyB)
	if resolveErr != nil {
		t.Fatal(resolveErr)
	}
	if legacyViewB.Phone != "" || legacyViewB.JID != lidRaw || legacyViewB.Name != "Observed LID name" {
		t.Fatalf("stored old global projection exposed foreign phone: %+v", legacyViewB)
	}

	var contacts, chats int
	if err = db.QueryRow(ctx, `SELECT (SELECT count(*) FROM contacts WHERE account_id=ANY($1::uuid[])),(SELECT count(*) FROM chats WHERE account_id=ANY($1::uuid[]))`, []uuid.UUID{accountA, accountB}).Scan(&contacts, &chats); err != nil {
		t.Fatal(err)
	}
	if contacts != 0 || chats != 0 {
		t.Fatalf("history/identity queries created CRM records: contacts=%d chats=%d", contacts, chats)
	}
	// A real incoming unresolved message may create a pending LID chat, never a
	// Contact addressed by the PN learned only by the other account's session.
	pending, _, err := pool.getOrCreateMessageChat(ctx, instanceB, source, "Observed LID name")
	if err != nil || pending.JID != lidRaw {
		t.Fatalf("unknown peer imported foreign PN: %+v %v", pending, err)
	}
	var wrongPhone int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM contacts WHERE account_id=$1 AND (jid=$2 OR phone=$3)`, accountB, pnRaw, pn.User).Scan(&wrongPhone); err != nil {
		t.Fatal(err)
	}
	if wrongPhone != 0 {
		t.Fatal("canonical CRM ingestion used an unobserved global PN")
	}
	// The account-wide reconciliation scan must also require evidence from
	// the source Contact's own device, not merely the provider-global table.
	if _, err = db.Exec(ctx, `INSERT INTO contacts(id,account_id,device_id,jid,name) VALUES($1,$2,$3,$4,'Scoped source'),($5,$2,$3,$6,'Scoped phone'),($7,$8,$9,$6,'Unproven phone')`, uuid.New(), accountA, deviceA, lidRaw, uuid.New(), pnRaw, uuid.New(), accountB, deviceB); err != nil {
		t.Fatal(err)
	}
	pairs, err := repos.Contact.GetMappedLIDContactPairs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	foundA := false
	for _, pair := range pairs {
		if pair.AccountID == accountA && pair.LIDJID == lidRaw {
			foundA = true
		}
		if pair.AccountID == accountB && pair.LIDJID == lidRaw {
			t.Fatal("background reconciliation borrowed a foreign device's mapping")
		}
	}
	if !foundA {
		t.Fatal("background reconciliation ignored scoped source-device proof")
	}
	// Only delivery of this device's actual history now makes the pair usable.
	if err := pool.observePeerIdentities(ctx, instanceB, peerHistoryObservations(history)); err != nil {
		t.Fatal(err)
	}
	identityB = pool.resolveMessagePeerIdentity(ctx, instanceB, source)
	addressB, resolveErr = pool.ResolveCachedGroupParticipantAddress(ctx, accountB, deviceB, member)
	if resolveErr != nil {
		t.Fatal(resolveErr)
	}
	if identityB.JID != pn || identityB.Pending || addressB.Phone != pn.User {
		t.Fatalf("actual device history did not establish scoped pair: %+v %+v", identityB, addressB)
	}
	// A different device under A still cannot borrow A's first device's proof.
	untouchedDevice := &DeviceInstance{ID: uuid.New(), AccountID: accountA}
	if got := pool.resolveMessagePeerIdentity(ctx, untouchedDevice, source); got.JID != lid || !got.Pending {
		t.Fatalf("mapping crossed device boundary: %+v", got)
	}
}
