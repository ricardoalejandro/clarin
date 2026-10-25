package whatsapp

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

type groupCountingContacts struct {
	store.NoopStore
	allCalls int
	contacts map[types.JID]types.ContactInfo
}

func (c *groupCountingContacts) GetAllContacts(context.Context) (map[types.JID]types.ContactInfo, error) {
	c.allCalls++
	return c.contacts, nil
}
func (c *groupCountingContacts) GetContact(context.Context, types.JID) (types.ContactInfo, error) {
	panic("per-alias contact query")
}

type groupIdentityLIDMap struct {
	store.NoopStore
	pn, lid types.JID
}

func (m *groupIdentityLIDMap) GetLIDForPN(_ context.Context, pn types.JID) (types.JID, error) {
	if pn == m.pn {
		return m.lid, nil
	}
	return types.EmptyJID, nil
}

func (m *groupIdentityLIDMap) GetPNForLID(_ context.Context, lid types.JID) (types.JID, error) {
	if lid == m.lid {
		return m.pn, nil
	}
	return types.EmptyJID, nil
}

func TestGroupIdentityPNOnlySeedStillHonorsSavedLIDName(t *testing.T) {
	a, d := uuid.New(), uuid.New()
	pn, lid := types.NewJID("51900000001", types.DefaultUserServer), types.NewJID("7001", types.HiddenUserServer)
	contacts := &groupCountingContacts{contacts: map[types.JID]types.ContactInfo{pn: {PushName: "PN push"}, lid: {FullName: "Saved LID identity"}}}
	client := whatsmeow.NewClient(&store.Device{Contacts: contacts, LIDs: &groupIdentityLIDMap{pn: pn, lid: lid}}, nil)
	pool := &DevicePool{devices: map[uuid.UUID]*DeviceInstance{d: {ID: d, AccountID: a, Client: client}}}
	got := pool.ResolveCachedGroupParticipant(context.Background(), a, d, domain.GroupParticipant{JID: pn.String()})
	if got.Name != "Saved LID identity" || got.NameSource != "full_name" || got.LID != lid.String() || contacts.allCalls != 1 {
		t.Fatalf("PN-only event ignored the saved alternate alias: %+v", got)
	}
	report := groupReportParticipantIdentity(context.Background(), pool.GetDevice(d), types.GroupParticipant{JID: pn}, contacts.contacts)
	if report.Name != got.Name || report.LID != got.LID || report.Phone != got.Phone || report.NameSource != got.NameSource {
		t.Fatalf("report disagrees with group identity: report=%+v group=%+v", report, got)
	}
}

func TestGroupIdentityPagePrefetchesProviderContactsOnce(t *testing.T) {
	a, d := uuid.New(), uuid.New()
	pn := types.NewJID("51900000001", types.DefaultUserServer)
	lid := types.NewJID("7001", types.HiddenUserServer)
	contacts := &groupCountingContacts{contacts: map[types.JID]types.ContactInfo{pn: {FullName: "Saved identity"}, lid: {PushName: "Group identity"}}}
	client := whatsmeow.NewClient(&store.Device{Contacts: contacts, LIDs: &store.NoopStore{}}, nil)
	pool := &DevicePool{devices: map[uuid.UUID]*DeviceInstance{d: {ID: d, AccountID: a, Client: client}}}
	snapshot := pool.GroupParticipantIdentities(context.Background(), a, d)
	rows := snapshot.Resolve(context.Background(), []domain.GroupParticipant{{JID: pn.String()}, {JID: lid.String(), LID: lid.String()}})
	snapshot.Resolve(context.Background(), []domain.GroupParticipant{{JID: pn.String()}})
	if contacts.allCalls != 1 || rows[0].Name != "Saved identity" || rows[1].Name != "Group identity" {
		t.Fatalf("page was not resolved in one prefetch: calls=%d rows=%+v", contacts.allCalls, rows)
	}
	if !isRedactedPhoneLabel("+51····80") || isRedactedPhoneLabel("A real name *") {
		t.Fatal("legacy redacted label classification failed")
	}
	legacy := pool.ResolveCachedGroupParticipantAddress(context.Background(), a, d, domain.GroupParticipant{JID: "7002@lid", LID: "7002@lid", Name: "+51····80"})
	if legacy.Name != "Integrante" || legacy.RedactedPhone != "+51····80" || legacy.Phone != "" {
		t.Fatalf("legacy redacted DisplayName became a personal name: %+v", legacy)
	}
	phoneOnly := pool.ResolveCachedGroupParticipantAddress(context.Background(), a, d, domain.GroupParticipant{JID: "51900000002@s.whatsapp.net", Name: "51900000002"})
	if phoneOnly.NameSource != "phone" || phoneOnly.Phone != "51900000002" {
		t.Fatalf("a numeric fallback became a personal name: %+v", phoneOnly)
	}
	var disconnected *DevicePool
	rows = disconnected.ResolveCachedGroupParticipants(context.Background(), a, d, []domain.GroupParticipant{{JID: "7002@lid", Name: "+51····80"}})
	if rows[0].Name != "Integrante" || rows[0].RedactedPhone != "+51····80" {
		t.Fatalf("disconnected cache kept an obfuscated personal name: %+v", rows[0])
	}
}

func TestGroupIdentityUsesEveryAliasAndGlobalNamePriority(t *testing.T) {
	pn := types.NewJID("51900000001", types.DefaultUserServer)
	lid := types.NewJID("7001", types.HiddenUserServer)
	part := types.GroupParticipant{JID: lid, LID: lid}
	for _, tc := range []struct {
		name         string
		contacts     map[types.JID]types.ContactInfo
		want, source string
	}{
		{"empty PN entry does not hide LID name", map[types.JID]types.ContactInfo{pn: {Found: true}, lid: {PushName: "Visible push name"}}, "Visible push name", "push_name"},
		{"saved alternate name outranks primary push", map[types.JID]types.ContactInfo{pn: {PushName: "Primary push"}, lid: {FullName: "Saved name"}}, "Saved name", "full_name"},
		{"business before push", map[types.JID]types.ContactInfo{pn: {PushName: "Push"}, lid: {BusinessName: "Verified business"}}, "Verified business", "business_name"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveGroupMemberIdentity(part, types.EmptyJID, types.EmptyJID, pn, tc.contacts)
			if got.Name != tc.want || got.NameSource != tc.source || got.Phone != pn.User || got.LID != lid.String() {
				t.Fatalf("incorrect identity: %+v", got)
			}
		})
	}
}

func TestGroupIdentityNeverTreatsRedactedPhoneOrLIDAsRealPhone(t *testing.T) {
	lid := types.NewJID("123456789012345", types.HiddenUserServer)
	got := resolveGroupMemberIdentity(types.GroupParticipant{JID: lid, DisplayName: "+51 ······ 01", IsAdmin: true}, types.EmptyJID, lid, types.EmptyJID, nil)
	if got.Phone != "" || got.Name == "+51 ······ 01" || got.RedactedPhone != "+51 ······ 01" || got.NameSource != "unavailable" || !got.IsSelf || got.Role != "admin" {
		t.Fatalf("fabricated identity: %+v", got)
	}
	invalid := resolveGroupMemberIdentity(types.GroupParticipant{JID: lid}, types.EmptyJID, types.EmptyJID, types.NewJID("12345", types.GroupServer), nil)
	if invalid.Phone != "" {
		t.Fatal("non-PN mapping became a phone")
	}
}

func TestGroupPhotoMemoryIsBoundedScopedAndExpires(t *testing.T) {
	if groupMemberPhotoTTL(nil) <= 0 || groupMemberPhotoTTL(profilePictureError(ProfilePictureCodePrivate, "private")) <= 0 || groupMemberPhotoTTL(profilePictureError(ProfilePictureCodeNotSet, "empty")) <= 0 {
		t.Fatal("stable photo outcomes lost their bounded cache")
	}
	if groupMemberPhotoTTL(context.Canceled) != 0 || groupMemberPhotoTTL(profilePictureError(ProfilePictureCodeUnavailable, "transient")) != 0 {
		t.Fatal("a transient failure prevents an immediate retry")
	}
	cache := groupMemberPhotoMemory{entries: map[string]groupMemberPhotoEntry{}}
	now := time.Now()
	for i := 0; i < groupMemberPhotoMaxEntries+20; i++ {
		cache.put(uuid.NewString(), groupMemberPhotoEntry{data: make([]byte, 200000), expires: now.Add(time.Duration(i) * time.Second)})
	}
	if len(cache.entries) > groupMemberPhotoMaxEntries || cache.bytes > groupMemberPhotoMaxBytes {
		t.Fatalf("unbounded cache: entries=%d bytes=%d", len(cache.entries), cache.bytes)
	}
	cache.put("expired", groupMemberPhotoEntry{data: []byte("thumbnail"), expires: now.Add(-time.Second)})
	if _, ok := cache.get("expired", now); ok {
		t.Fatal("expired avatar reused")
	}
	a, d := uuid.New(), uuid.New()
	member := domain.GroupParticipant{JID: "7001@lid", LID: "7001@lid"}
	base := groupMemberPhotoKey(a, d, "group@g.us", member, true)
	for _, other := range []string{groupMemberPhotoKey(uuid.New(), d, "group@g.us", member, true), groupMemberPhotoKey(a, uuid.New(), "group@g.us", member, true), groupMemberPhotoKey(a, d, "other@g.us", member, true), groupMemberPhotoKey(a, d, "group@g.us", member, false)} {
		if base == other {
			t.Fatal("photo cache crossed its scope")
		}
	}
}
