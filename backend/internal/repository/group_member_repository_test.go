package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestGroupMemberIdentityGuardIgnoresPresentationOnly(t *testing.T) {
	member := domain.GroupParticipant{JID: "51900000001@s.whatsapp.net", LID: "7001@lid", Phone: "51900000001", Name: "Synthetic"}
	presentation := member
	presentation.Name = "Changed"
	presentation.Role = "admin"
	if !sameGroupMemberIdentity(member, presentation) {
		t.Fatal("presentation changed identity")
	}
	presentation.Phone = "51900000002"
	if sameGroupMemberIdentity(member, presentation) {
		t.Fatal("new phone preserved old identity")
	}
	contact := uuid.New()
	ctx := WithGroupParticipantChatGuard(context.Background(), GroupParticipantChatGuard{ExpectedCanonicalContactID: &contact})
	if err := validateGroupParticipantContactSelection(ctx, &contact, &contact); err != nil {
		t.Fatal("stable canonical selection rejected", err)
	}
	if err := validateGroupParticipantContactSelection(ctx, nil, nil); !errors.Is(err, ErrGroupMemberIdentityChanged) {
		t.Fatal("missing canonical selection accepted", err)
	}
	ctx = WithGroupParticipantChatGuard(context.Background(), GroupParticipantChatGuard{})
	if err := validateGroupParticipantContactSelection(ctx, nil, &contact); !errors.Is(err, ErrGroupMemberIdentityChanged) {
		t.Fatal("an unrelated prelinked chat bypassed expected nil", err)
	}
}

func TestGroupMemberReadsAndCanonicalOpeningIsolation(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f, other := integrityProgram(t, pool), integrityProgram(t, pool)
	repo := NewRepositories(pool).Chat
	device, otherDevice := uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,phone,status) VALUES($1,$3,'First','51900000090','connected'),($2,$3,'Second','51900000091','connected')`, device, otherDevice, f.account)
	first, err := repo.GetOrCreateGroup(ctx, f.account, device, "120010@g.us", "First group")
	if err != nil {
		t.Fatal(err)
	}
	second, err := repo.GetOrCreateGroup(ctx, f.account, otherDevice, "120010@g.us", "Other device group")
	if err != nil {
		t.Fatal(err)
	}
	member := domain.GroupParticipant{JID: "51900000001@s.whatsapp.net", LID: "7001@lid", Phone: "51900000001", Name: "WhatsApp name", Role: "member"}
	lidOnly := domain.GroupParticipant{JID: "7002@lid", LID: "7002@lid", Name: "Integrante", Role: "member"}
	metadata := &domain.ChatGroup{Subject: "Synthetic", MembershipStatus: "member", Kind: "group"}
	for _, chat := range []*domain.Chat{first, second} {
		if err = repo.SaveGroup(ctx, f.account, chat.ID, metadata, []domain.GroupParticipant{member, lidOnly}); err != nil {
			t.Fatal(err)
		}
	}
	snapshot, err := repo.GroupParticipantIdentitySnapshot(ctx, f.account, first.ID)
	if err != nil || len(snapshot) != 2 {
		t.Fatalf("cached identity snapshot unavailable: %+v %v", snapshot, err)
	}
	foreignSnapshot, err := repo.GroupParticipantIdentitySnapshot(ctx, other.account, first.ID)
	if err != nil || len(foreignSnapshot) != 0 {
		t.Fatalf("cached identity snapshot crossed account: %+v %v", foreignSnapshot, err)
	}
	matching := []string{member.JID, lidOnly.JID}
	page, cursor, err := repo.GroupParticipantsMatching(ctx, f.account, first.ID, "Provider name not in stale JSON", "", 1, matching)
	if err != nil || len(page) != 1 || cursor == "" {
		t.Fatalf("resolved name search did not paginate: %+v %q %v", page, cursor, err)
	}
	secondPage, next, err := repo.GroupParticipantsMatching(ctx, f.account, first.ID, "Provider name not in stale JSON", cursor, 1, matching)
	if err != nil || len(secondPage) != 1 || secondPage[0].JID == page[0].JID || next != "" {
		t.Fatalf("resolved name search lost its page boundary: %+v %q %v", secondPage, next, err)
	}
	emptyPage, _, err := repo.GroupParticipantsMatching(ctx, f.account, first.ID, member.Name, "", 50, []string{})
	if err != nil || len(emptyPage) != 0 {
		t.Fatalf("empty authoritative matches fell back to a stale name: %+v %v", emptyPage, err)
	}
	integrityExec(t, pool, `UPDATE contacts SET jid=$2,phone=$3,name='Canonical private name',avatar_url=NULL WHERE id=$1 AND account_id=$4`, f.contact, member.JID, member.Phone, f.account)
	var beforeContacts, beforeChats int
	integrityScanCount(t, pool, `SELECT count(*) FROM contacts WHERE account_id=$1`, f.account, &beforeContacts)
	integrityScanCount(t, pool, `SELECT count(*) FROM chats WHERE account_id=$1`, f.account, &beforeChats)
	canonical, visible, err := repo.GroupMemberContacts(ctx, f.account, []domain.GroupParticipant{member}, false)
	if err != nil || canonical[0] != f.contact || len(visible) != 0 {
		t.Fatalf("Chats-only leaked Contact: %+v %+v %v", canonical, visible, err)
	}
	_, visible, err = repo.GroupMemberContacts(ctx, f.account, []domain.GroupParticipant{member}, true)
	if err != nil || visible[f.contact].Name != "Canonical private name" {
		t.Fatalf("authorized Contact missing: %+v %v", visible, err)
	}
	_, foreign, err := repo.GroupMemberContacts(ctx, other.account, []domain.GroupParticipant{member}, true)
	if err != nil || len(foreign) != 0 {
		t.Fatalf("cross-account identity: %+v %v", foreign, err)
	}
	groups, next, err := repo.GroupMemberCommonGroups(ctx, f.account, device, member, "", 50)
	if err != nil || len(groups) != 1 || groups[0].ChatID != first.ID || next != "" {
		t.Fatalf("common groups crossed device: %+v %s %v", groups, next, err)
	}
	if foreignMember, err := repo.GroupParticipant(ctx, other.account, first.ID, member.JID); err != nil || foreignMember != nil {
		t.Fatalf("foreign participant visible: %+v %v", foreignMember, err)
	}
	ids, err := repo.UpdateGroupMemberName(ctx, f.account, device, []string{member.LID}, "Updated provider name", "push_name")
	if err != nil || len(ids) != 1 || ids[0] != first.ID {
		t.Fatalf("name patch crossed device: %+v %v", ids, err)
	}
	ids, err = repo.UpdateGroupMemberNames(ctx, f.account, device, []domain.GroupParticipant{
		{JID: member.JID, LID: member.LID, Name: "History name", NameSource: "push_name"},
		{JID: lidOnly.JID, LID: lidOnly.LID, Name: "LID history name", NameSource: "push_name"},
	})
	if err != nil || len(ids) != 1 || ids[0] != first.ID {
		t.Fatalf("batch name patch failed: %+v %v", ids, err)
	}
	lidUpdated, err := repo.GroupParticipant(ctx, f.account, first.ID, lidOnly.JID)
	if err != nil || lidUpdated == nil || lidUpdated.Name != "LID history name" || lidUpdated.Phone != "" {
		t.Fatalf("LID name patch invented a phone or lost its name: %+v %v", lidUpdated, err)
	}
	untouched, err := repo.GroupParticipant(ctx, f.account, second.ID, member.JID)
	if err != nil || untouched.Name != member.Name {
		t.Fatal("other device projection changed", err)
	}
	var afterContacts, afterChats int
	integrityScanCount(t, pool, `SELECT count(*) FROM contacts WHERE account_id=$1`, f.account, &afterContacts)
	integrityScanCount(t, pool, `SELECT count(*) FROM chats WHERE account_id=$1`, f.account, &afterChats)
	if beforeContacts != afterContacts || beforeChats != afterChats {
		t.Fatal("profile reads/name reconciliation created CRM entities")
	}
	updated, err := repo.GroupParticipant(ctx, f.account, first.ID, member.JID)
	if err != nil {
		t.Fatal(err)
	}
	guard := GroupParticipantChatGuard{
		AccountID: f.account, DeviceID: device, ChatID: first.ID, Member: *updated,
		VerifiedJID: member.JID, VerifiedPhone: member.Phone, VerifiedLID: member.LID, ExpectedCanonicalContactID: &f.contact,
	}
	guard.Member.Phone = "51900000002"
	if _, err = repo.OpenManualWhatsAppChat(WithGroupParticipantChatGuard(ctx, guard), f.account, device, nil, member.JID, member.Phone, "", nil); !errors.Is(err, ErrGroupMemberIdentityChanged) {
		t.Fatalf("stale identity accepted: %v", err)
	}
	guard.Member = *updated
	// The profile resolved f.contact, then another writer removes its identity
	// while holding its row lock. The guarded transaction must re-match after
	// waiting for that writer, not retain the pre-lock Contact selection.
	writer, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(ctx)
	integrityExec(t, writer, `UPDATE contacts SET jid='detached@test.invalid',phone=NULL WHERE account_id=$1 AND id=$2`, f.account, f.contact)
	integrityExec(t, writer, `DELETE FROM contact_aliases WHERE account_id=$1 AND contact_id=$2`, f.account, f.contact)
	guardResult := make(chan error, 1)
	go func() {
		_, openErr := repo.OpenManualWhatsAppChat(WithGroupParticipantChatGuard(ctx, guard), f.account, device, &f.contact, member.JID, member.Phone, "", nil)
		guardResult <- openErr
	}()
	waitIntegrityLock(t, pool, "SELECT id FROM contacts WHERE account_id=")
	if err = writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-guardResult:
		if !errors.Is(err, ErrGroupMemberIdentityChanged) {
			t.Fatalf("removed identity was attached after waiting: %v", err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("guard did not finish after Contact writer committed")
	}
	// Nil is also an exact snapshot: a newly claimed identity is a conflict.
	newOwner := uuid.New()
	integrityExec(t, pool, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'New identity owner')`, newOwner, f.account, member.JID)
	nilGuard := guard
	nilGuard.ExpectedCanonicalContactID = nil
	if _, err = repo.OpenManualWhatsAppChat(WithGroupParticipantChatGuard(ctx, nilGuard), f.account, device, nil, member.JID, member.Phone, "", nil); !errors.Is(err, ErrGroupMemberIdentityChanged) {
		t.Fatalf("new owner bypassed expected nil: %v", err)
	}
	if _, err = repo.OpenManualWhatsAppChat(WithGroupParticipantChatGuard(ctx, guard), f.account, device, &f.contact, member.JID, member.Phone, "", nil); !errors.Is(err, ErrGroupMemberIdentityChanged) {
		t.Fatalf("reassigned owner preserved stale canonical identity: %v", err)
	}
	integrityExec(t, pool, `DELETE FROM contacts WHERE account_id=$1 AND id=$2`, f.account, newOwner)
	// A real LID-only canonical Contact must use the same matcher as the list.
	integrityExec(t, pool, `UPDATE contacts SET jid=$3,phone=NULL WHERE account_id=$1 AND id=$2`, f.account, f.contact, member.LID)
	var rejectedChats int
	integrityScanCount(t, pool, `SELECT count(*) FROM chats WHERE account_id=$1`, f.account, &rejectedChats)
	if rejectedChats != beforeChats {
		t.Fatal("a rejected canonical identity created a chat")
	}
	private, err := repo.OpenManualWhatsAppChat(WithGroupParticipantChatGuard(ctx, guard), f.account, device, &f.contact, member.JID, member.Phone, "", nil)
	if err != nil || private.ContactID == nil || *private.ContactID != f.contact {
		t.Fatalf("canonical open failed: %+v %v", private, err)
	}
	_, visible, err = repo.GroupMemberContacts(ctx, f.account, []domain.GroupParticipant{member}, false)
	if err != nil || visible[f.contact].DirectChatID == nil || *visible[f.contact].DirectChatID != private.ID {
		t.Fatalf("real private-chat context missing: %+v %v", visible, err)
	}
	newPhone := "51900000003"
	newJID := newPhone + "@s.whatsapp.net"
	newGuard := GroupParticipantChatGuard{AccountID: f.account, DeviceID: device, ChatID: first.ID, Member: lidOnly, VerifiedJID: newJID, VerifiedPhone: newPhone, VerifiedLID: lidOnly.LID}
	newPrivate, err := repo.OpenManualWhatsAppChat(WithGroupParticipantChatGuard(ctx, newGuard), f.account, device, nil, newJID, newPhone, "New group identity", nil)
	if err != nil || newPrivate == nil || newPrivate.ContactID == nil || *newPrivate.ContactID == f.contact || newPrivate.DeviceID == nil || *newPrivate.DeviceID != device {
		t.Fatalf("a verified new identity did not create Contact then Chat on the source device: %+v %v", newPrivate, err)
	}
	var messages int
	integrityScanCount(t, pool, `SELECT count(*) FROM messages WHERE account_id=$1`, f.account, &messages)
	if messages != 0 {
		t.Fatal("opening a private chat sent a message")
	}
}
