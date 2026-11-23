package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func TestWhatsAppGroupContinuityPostgresPreservesRowsAndOrigin(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, db)
	repos := NewRepositories(db)
	old, newDevice, otherDevice := uuid.New(), uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$4,'old','connected'),($2,$4,'new','connected'),($3,$4,'other','connected')`, old, newDevice, otherDevice, f.account)
	jid := "12009901@g.us"
	pn, lid := "51900000001@s.whatsapp.net", "70001@lid"
	oldChat, err := repos.Chat.GetOrCreateGroup(ctx, f.account, old, jid, "History")
	if err != nil {
		t.Fatal(err)
	}
	if oldChat.BindingState != "" {
		t.Fatal("legacy physical group was presented as pending continuity")
	}
	metadata := &domain.ChatGroup{Subject: "History", MembershipStatus: "member", Kind: "group"}
	if err = repos.Chat.SaveGroup(ctx, f.account, oldChat.ID, metadata, []domain.GroupParticipant{{JID: lid, IsSelf: true}}); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC().Truncate(time.Second)
	oldMessage := uuid.New()
	integrityExec(t, db, `INSERT INTO messages(id,account_id,device_id,chat_id,message_id,from_jid,is_from_me,body,timestamp) VALUES($1,$2,$3,$4,'same-stanza',$5,true,'old snapshot',$6)`, oldMessage, f.account, old, oldChat.ID, lid, at)
	// Actual deletion semantics preserve all rows and erase only device links.
	integrityExec(t, db, `UPDATE chats SET device_id=NULL WHERE id=$1`, oldChat.ID)
	integrityExec(t, db, `DELETE FROM devices WHERE id=$1`, old)
	owner, err := repos.Chat.BindWhatsAppOwner(ctx, f.account, newDevice, pn, lid, "new-session")
	if err != nil {
		t.Fatal(err)
	}
	newChat, err := repos.Chat.GetOrCreateGroup(ctx, f.account, newDevice, jid, "Current")
	if err != nil {
		t.Fatal(err)
	}
	if newChat.ID != oldChat.ID || newChat.DeviceID == nil || *newChat.DeviceID != newDevice {
		t.Fatal("same authenticated owner did not reclaim proven orphan")
	}
	if _, err = repos.Chat.BindWhatsAppOwner(ctx, f.account, otherDevice, "51900000002@s.whatsapp.net", "70002@lid", "other-session"); err != nil {
		t.Fatal(err)
	}
	other, err := repos.Chat.GetOrCreateGroup(ctx, f.account, otherDevice, jid, "Other perspective")
	if err != nil {
		t.Fatal(err)
	}
	if other.ID == newChat.ID {
		t.Fatal("different own identity claimed history")
	}
	if other.ContactID == nil || newChat.ContactID == nil || *other.ContactID != *newChat.ContactID {
		t.Fatal("group Contact was duplicated")
	}
	// Model duplicates produced before this release: same group, another UUID,
	// each with its own history. Current connected view must be canonical.
	duplicateDevice := uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'legacy live','connected')`, duplicateDevice, f.account)
	duplicate, err := repos.Chat.GetOrCreateGroup(ctx, f.account, duplicateDevice, jid, "Legacy current")
	if err != nil {
		t.Fatal(err)
	}
	if err = repos.Chat.SaveGroup(ctx, f.account, duplicate.ID, metadata, []domain.GroupParticipant{{JID: pn, LID: lid, IsSelf: true}}); err != nil {
		t.Fatal(err)
	}
	duplicateMessage := uuid.New()
	integrityExec(t, db, `INSERT INTO messages(id,account_id,device_id,chat_id,message_id,from_jid,is_from_me,body,timestamp,is_revoked) VALUES($1,$2,$3,$4,'same-stanza',$5,true,'enriched snapshot',$6,true)`, duplicateMessage, f.account, duplicateDevice, duplicate.ID, pn, at)
	integrityExec(t, db, `UPDATE messages SET media_url=$2::text,message_type='image',is_view_once=TRUE,forwarding='{"state":"frequently_forwarded","score":5}'::jsonb,forwarding_source='provider',sharing_limits='{"max_chats":1,"max_groups":1}'::jsonb WHERE id=$1`, oldMessage, "/api/media/"+f.account.String()+"/continuity-image.jpg")
	if err = repos.Chat.EndWhatsAppOwnerEpoch(ctx, f.account, newDevice); err != nil {
		t.Fatal(err)
	}
	integrityExec(t, db, `UPDATE chats SET binding_revision=9 WHERE id=$1`, oldChat.ID)
	if _, err = repos.Chat.BindWhatsAppOwner(ctx, f.account, duplicateDevice, pn, lid, "legacy-session"); err != nil {
		t.Fatal(err)
	}
	if _, err = repos.Chat.ReconcileWhatsAppGroups(ctx, f.account, duplicateDevice, pn, lid); err != nil {
		t.Fatal(err)
	}
	canonical, err := repos.Chat.ResolveCanonicalChatID(ctx, f.account, oldChat.ID)
	if err != nil || canonical != duplicate.ID {
		t.Fatalf("unique connected canonical not selected: %v", err)
	}
	staleTx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = LockMessageConversationTx(ctx, staleTx, f.account, oldChat.ID); !errors.Is(err, ErrChatBindingChanged) {
		t.Fatal("stale alias ingress was not rejected", err)
	}
	_ = staleTx.Rollback(ctx)
	physical, err := repos.Chat.ConversationChatIDs(ctx, f.account, oldChat.ID)
	if err != nil || len(physical) != 2 {
		t.Fatal("physical chat alias lost", err)
	}
	var contacts, chats, messages, aliases int
	integrityScanCount(t, db, `SELECT count(*) FROM contacts WHERE account_id=$1 AND jid='12009901@g.us'`, f.account, &contacts)
	integrityScanCount(t, db, `SELECT count(*) FROM chats WHERE account_id=$1 AND jid='12009901@g.us'`, f.account, &chats)
	integrityScanCount(t, db, `SELECT count(*) FROM messages WHERE account_id=$1`, f.account, &messages)
	integrityScanCount(t, db, `SELECT count(*) FROM whatsapp_message_aliases WHERE account_id=$1`, f.account, &aliases)
	if contacts != 1 || chats != 3 || messages != 2 || aliases != 1 {
		t.Fatalf("physical counts changed: contacts=%d chats=%d messages=%d aliases=%d", contacts, chats, messages, aliases)
	}
	var revokedCopies int
	integrityScanCount(t, db, `SELECT count(*) FROM messages WHERE account_id=$1 AND is_revoked`, f.account, &revokedCopies)
	if revokedCopies != 2 {
		t.Fatal("raw alias UUID bypasses canonical revocation")
	}
	var restrictedCopies int
	integrityScanCount(t, db, `SELECT count(*) FROM messages WHERE account_id=$1 AND is_view_once AND forwarding->>'state'='frequently_forwarded' AND sharing_limits->>'max_chats'='1' AND sharing_limits->>'max_groups'='1'`, f.account, &restrictedCopies)
	if restrictedCopies != 2 {
		t.Fatal("restrictive metadata was not preserved on all historical UUIDs")
	}
	var keeper uuid.UUID
	if err = db.QueryRow(ctx, `SELECT canonical_message_id FROM whatsapp_message_aliases WHERE account_id=$1 AND alias_message_id=$2`, f.account, duplicateMessage).Scan(&keeper); err != nil || keeper != oldMessage {
		t.Fatal("placeholder concealed available historical media", err)
	}
	if err = repos.Message.ReconcileConversationMessage(ctx, f.account, canonical, "same-stanza"); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, `SELECT canonical_message_id FROM whatsapp_message_aliases WHERE account_id=$1 AND alias_message_id=$2`, f.account, duplicateMessage).Scan(&keeper); err != nil || keeper != oldMessage {
		t.Fatal("existing alias was promoted after media changed", err)
	}
	var provenance *uuid.UUID
	if err = db.QueryRow(ctx, `SELECT device_id FROM messages WHERE account_id=$1 AND id=$2`, f.account, oldMessage).Scan(&provenance); err != nil || provenance != nil {
		t.Fatal("historical message origin rewritten", err)
	}
	var canonicalOwner uuid.UUID
	if err = db.QueryRow(ctx, `SELECT whatsapp_owner_id FROM chats WHERE account_id=$1 AND id=$2`, f.account, canonical).Scan(&canonicalOwner); err != nil || canonicalOwner != owner {
		t.Fatal("canonical owner lost", err)
	}
	if _, err = repos.Chat.ResolveCanonicalChatID(ctx, uuid.New(), oldChat.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("canonical lookup crossed account", err)
	}
	var revision int64
	if err = db.QueryRow(ctx, `SELECT binding_revision FROM chats WHERE id=$1`, canonical).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision <= 9 {
		t.Fatal("canonical binding revision regressed below historical perspective")
	}
	if _, err = repos.Chat.ReconcileWhatsAppGroups(ctx, f.account, duplicateDevice, pn, lid); err != nil {
		t.Fatal(err)
	}
	var next int64
	if err = db.QueryRow(ctx, `SELECT binding_revision FROM chats WHERE id=$1`, canonical).Scan(&next); err != nil || next != revision {
		t.Fatal("idempotent replay changed binding", err)
	}
	// Reset/re-pairing the same UUID with a different number cannot inherit it.
	if _, err = repos.Chat.BindWhatsAppOwner(ctx, f.account, duplicateDevice, "51900000003@s.whatsapp.net", "70003@lid", "replacement-session"); err != nil {
		t.Fatal(err)
	}
	var binding *uuid.UUID
	if err = db.QueryRow(ctx, `SELECT device_id FROM chats WHERE id=$1`, canonical).Scan(&binding); err != nil || binding != nil {
		t.Fatal("replacement number retained prior group sender", err)
	}
}

func TestWhatsAppGroupContinuityPostgresRejectsUnprovenHistory(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, db)
	repo := NewRepositories(db).Chat
	old, current := uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$3,'old','disconnected'),($2,$3,'current','connected')`, old, current, f.account)
	jid := "12009902@g.us"
	legacy, err := repo.GetOrCreateGroup(ctx, f.account, old, jid, "Unproven")
	if err != nil {
		t.Fatal(err)
	}
	integrityExec(t, db, `UPDATE chats SET device_id=NULL WHERE id=$1`, legacy.ID)
	if _, err = repo.BindWhatsAppOwner(ctx, f.account, current, "51900000001@s.whatsapp.net", "70001@lid", "active"); err != nil {
		t.Fatal(err)
	}
	private, err := repo.GetOrCreate(ctx, f.account, current, "51900000999@s.whatsapp.net", "Private")
	if err != nil {
		t.Fatal(err)
	}
	if err = repo.HydrateGroups(ctx, f.account, []*domain.Chat{private}); err != nil {
		t.Fatal(err)
	}
	if private.BindingState != "" || private.DeviceID == nil || *private.DeviceID != current {
		t.Fatal("ordinary private conversation was marked pending continuity")
	}
	fresh, err := repo.GetOrCreateGroup(ctx, f.account, current, jid, "Fresh")
	if err != nil {
		t.Fatal(err)
	}
	if fresh.ID == legacy.ID {
		t.Fatal("same group JID was treated as own identity proof")
	}
	ids, err := repo.ConversationChatIDs(ctx, f.account, legacy.ID)
	if err != nil || len(ids) != 1 {
		t.Fatal("unproven history consolidated", err)
	}
	if _, err = repo.BindWhatsAppOwner(ctx, f.account, current, "51900000002@s.whatsapp.net", "70001@lid", "conflicting"); !errors.Is(err, ErrWhatsAppOwnerConflict) {
		t.Fatal("contradictory own PN/LID accepted", err)
	}
}

func TestWhatsAppGroupContinuityPostgresAmbiguousCompanionsRemainReadOnly(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, db)
	repo := NewRepositories(db).Chat
	a, b := uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$3,'A','connected'),($2,$3,'B','connected')`, a, b, f.account)
	pn, lid, jid := "51900000001@s.whatsapp.net", "70001@lid", "12009903@g.us"
	first, err := repo.GetOrCreateGroup(ctx, f.account, a, jid, "First")
	if err != nil {
		t.Fatal(err)
	}
	second, err := repo.GetOrCreateGroup(ctx, f.account, b, jid, "Second")
	if err != nil {
		t.Fatal(err)
	}
	metadata := &domain.ChatGroup{Subject: "Group", MembershipStatus: "member", Kind: "group"}
	for _, c := range []*domain.Chat{first, second} {
		if err = repo.SaveGroup(ctx, f.account, c.ID, metadata, []domain.GroupParticipant{{JID: pn, LID: lid, IsSelf: true}}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = repo.BindWhatsAppOwner(ctx, f.account, a, pn, lid, "a"); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.BindWhatsAppOwner(ctx, f.account, b, pn, lid, "b"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err = repo.ReconcileWhatsAppGroups(ctx, f.account, a, pn, lid); err != nil {
			t.Fatal(err)
		}
		canonical, err := repo.ResolveCanonicalChatID(ctx, f.account, first.ID)
		if err != nil {
			t.Fatal(err)
		}
		var device *uuid.UUID
		var state string
		if err = db.QueryRow(ctx, `SELECT device_id,binding_state FROM chats WHERE account_id=$1 AND id=$2`, f.account, canonical).Scan(&device, &state); err != nil {
			t.Fatal(err)
		}
		if device != nil || state != "conflict" {
			t.Fatal("ambiguous same-owner senders were selected during replay")
		}
	}
	integrityExec(t, db, `UPDATE devices SET status='disconnected' WHERE id=$1`, b)
	if _, err = repo.ReconcileWhatsAppGroups(ctx, f.account, a, pn, lid); err != nil {
		t.Fatal(err)
	}
	canonical, err := repo.ResolveCanonicalChatID(ctx, f.account, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	var device *uuid.UUID
	var state string
	if err = db.QueryRow(ctx, `SELECT device_id,binding_state FROM chats WHERE account_id=$1 AND id=$2`, f.account, canonical).Scan(&device, &state); err != nil {
		t.Fatal(err)
	}
	if device == nil || *device != a || state != "verified_continuity" {
		t.Fatal("unique remaining proved companion was not selected")
	}
}
