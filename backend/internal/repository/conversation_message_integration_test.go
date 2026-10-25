package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"testing"
	"time"
)

func TestContinuityMessageProjectionAndImmutableForwardPostgres(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, db)
	repos := NewRepositories(db)
	oldDevice, currentDevice := uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$3,'Old synthetic','disconnected'),($2,$3,'Current synthetic','connected')`, oldDevice, currentDevice, f.account)
	jid := "12008801@g.us"
	ownPN, ownLID := "51900000801@s.whatsapp.net", "70801@lid"
	old, err := repos.Chat.GetOrCreateGroup(ctx, f.account, oldDevice, jid, "Synthetic history")
	if err != nil {
		t.Fatal(err)
	}
	current, err := repos.Chat.GetOrCreateGroup(ctx, f.account, currentDevice, jid, "Synthetic current")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []*domain.Chat{old, current} {
		if err = repos.Chat.SaveGroup(ctx, f.account, c.ID, &domain.ChatGroup{Subject: "Synthetic", MembershipStatus: "member", Kind: "group"}, []domain.GroupParticipant{{JID: ownPN, LID: ownLID, IsSelf: true}}); err != nil {
			t.Fatal(err)
		}
	}
	oldMessage := uuid.New()
	at := time.Now().UTC().Truncate(time.Second)
	integrityExec(t, db, `INSERT INTO messages(id,account_id,device_id,chat_id,message_id,from_jid,is_from_me,message_type,body,timestamp) VALUES($1,$2,$3,$4,'old-only',$5,true,'text','Synthetic searchable history',$6)`, oldMessage, f.account, oldDevice, old.ID, ownLID, at)
	integrityExec(t, db, `UPDATE chats SET device_id=NULL WHERE id=$1`, old.ID)
	integrityExec(t, db, `DELETE FROM devices WHERE id=$1`, oldDevice)
	rawBefore, err := repos.Message.GetByReference(ctx, f.account, old.ID, oldMessage.String())
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := domain.MessageForwardFingerprint(rawBefore)
	if _, err = repos.Chat.BindWhatsAppOwner(ctx, f.account, currentDevice, ownPN, ownLID, "synthetic-current"); err != nil {
		t.Fatal(err)
	}
	if _, err = repos.Chat.ReconcileWhatsAppGroups(ctx, f.account, currentDevice, ownPN, ownLID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []uuid.UUID{old.ID, current.ID} {
		messages, err := repos.Message.GetWindowByChatID(ctx, f.account, id, 50, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(messages) != 1 || messages[0].ID != oldMessage || messages[0].ChatID != current.ID || messages[0].DeviceID != nil {
			t.Fatalf("incorrect canonical projection %+v", messages)
		}
		found, total, err := repos.Message.SearchByChat(ctx, f.account, id, "searchable", 20, 0)
		if err != nil || total != 1 || len(found) != 1 || found[0].ChatID != current.ID {
			t.Fatalf("history search: %v total=%d", err, total)
		}
		offset, err := repos.Message.GetHistoryOffset(ctx, f.account, id, oldMessage)
		if err != nil || offset != 0 {
			t.Fatal("offset", offset, err)
		}
	}
	source, err := repos.Message.GetByReference(ctx, f.account, old.ID, oldMessage.String())
	if err != nil {
		t.Fatal(err)
	}
	if source.ChatID != old.ID || source.DeviceID != nil || domain.MessageForwardFingerprint(source) != fingerprint {
		t.Fatal("immutable source rewritten")
	}
	allowed, err := repos.Message.MessageDeviceAllowed(ctx, f.account, current.ID, currentDevice, source)
	if err != nil || !allowed {
		t.Fatal("proven historical source rejected", err)
	}
	allowed, err = repos.Message.MessageDeviceAllowed(ctx, uuid.New(), current.ID, currentDevice, source)
	if err != nil || allowed {
		t.Fatal("foreign account source accepted", err)
	}
	target, err := repos.Chat.GetOrCreateGroup(ctx, f.account, currentDevice, "12008802@g.us", "Synthetic target")
	if err != nil {
		t.Fatal(err)
	}
	op := &ForwardOperation{ID: uuid.New(), Mode: domain.MessageSharingCopy, ContentVariant: domain.MessageContentOriginal, AccountID: f.account, UserID: f.user, DeviceID: currentDevice, SourceChatID: old.ID, SourceMessageID: oldMessage, RequestHash: "synthetic-request", SourceFingerprint: fingerprint, Forwarding: source.Forwarding, Results: []ForwardTarget{{ChatID: target.ID, JID: target.JID, ProviderMessageID: "reserved-synthetic-id"}}}
	created, err := repos.Message.CreateForwardOperation(ctx, op)
	if err != nil || !created {
		t.Fatal("historical sharing preflight", err)
	}
	repeated, err := repos.Message.CreateForwardOperation(ctx, op)
	if err != nil || repeated {
		t.Fatal("idempotent operation changed", err)
	}
	receipt, err := repos.Message.GetForwardOperation(ctx, f.account, f.user, op.ID)
	if err != nil || receipt.SourceChatID != old.ID || receipt.SourceMessageID != oldMessage || receipt.SourceFingerprint != fingerprint || len(receipt.Results) != 1 {
		t.Fatal("immutable operation changed", err)
	}
	// Unique historical reactions survive. A deliberate removal cannot expose an
	// old physical snapshot again after a canonical refresh.
	reaction := &domain.MessageReaction{AccountID: f.account, ChatID: old.ID, TargetMessageID: "old-only", SenderJID: ownLID, Emoji: "👍", Timestamp: at}
	if _, err = repos.Reaction.Upsert(ctx, reaction); err != nil {
		t.Fatal(err)
	}
	reactions, err := repos.Reaction.GetByChatMessageIDs(ctx, f.account, current.ID, []string{"old-only"})
	if err != nil || len(reactions) != 1 || reactions[0].ChatID != current.ID {
		t.Fatal("historical reaction lost", err)
	}
	if _, err = repos.Reaction.Delete(ctx, f.account, current.ID, "old-only", ownLID, at.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	reactions, err = repos.Reaction.GetByChatMessageIDs(ctx, f.account, current.ID, []string{"old-only"})
	if err != nil || len(reactions) != 0 {
		t.Fatal("removed historical reaction resurrected", err)
	}
	if err = repos.Message.SaveGroupReceipt(ctx, f.account, current.ID, "old-only", "51900000999@s.whatsapp.net", "read", at); err != nil {
		t.Fatal(err)
	}
	receipts, _, totalReceipts, err := repos.Message.GroupReceipts(ctx, f.account, current.ID, "old-only", "", 50)
	if err != nil || len(receipts) != 1 || totalReceipts != 1 {
		t.Fatal("historical delivery receipt lost", err)
	}
	if err = repos.Message.RevokeInChat(ctx, f.account, current.ID, "old-only"); err != nil {
		t.Fatal(err)
	}
	source, err = repos.Message.GetByReference(ctx, f.account, current.ID, oldMessage.String())
	if err != nil || !source.IsRevoked || source.Body != nil {
		t.Fatal("historical revocation not persisted", err)
	}
}

func TestContinuityNewEchoDeduplicatesWithoutDeletingPhysicalRows(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, db)
	repos := NewRepositories(db)
	oldDevice, currentDevice := uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$3,'Old','disconnected'),($2,$3,'Current','connected')`, oldDevice, currentDevice, f.account)
	old, err := repos.Chat.GetOrCreateGroup(ctx, f.account, oldDevice, "12008803@g.us", "Old")
	if err != nil {
		t.Fatal(err)
	}
	current, err := repos.Chat.GetOrCreateGroup(ctx, f.account, currentDevice, old.JID, "Current")
	if err != nil {
		t.Fatal(err)
	}
	pn, lid := "51900000803@s.whatsapp.net", "70803@lid"
	if err = repos.Chat.SaveGroup(ctx, f.account, old.ID, &domain.ChatGroup{Subject: "Old", MembershipStatus: "member", Kind: "group"}, []domain.GroupParticipant{{JID: lid, IsSelf: true}}); err != nil {
		t.Fatal(err)
	}
	if err = repos.Chat.SaveGroup(ctx, f.account, current.ID, &domain.ChatGroup{Subject: "Current", MembershipStatus: "member", Kind: "group"}, []domain.GroupParticipant{{JID: lid, IsSelf: true}}); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC().Truncate(time.Second)
	integrityExec(t, db, `INSERT INTO messages(account_id,device_id,chat_id,message_id,from_jid,is_from_me,message_type,body,timestamp) VALUES($1,$2,$3,'echo-same',$4,true,'text','Synthetic original',$5)`, f.account, oldDevice, old.ID, lid, at)
	if _, err = repos.Chat.BindWhatsAppOwner(ctx, f.account, currentDevice, pn, lid, "synthetic-echo"); err != nil {
		t.Fatal(err)
	}
	if _, err = repos.Chat.ReconcileWhatsAppGroups(ctx, f.account, currentDevice, pn, lid); err != nil {
		t.Fatal(err)
	}
	oldSource, err := repos.Message.GetByReference(ctx, f.account, current.ID, "echo-same")
	if err != nil {
		t.Fatal(err)
	}
	body, kind := "Synthetic enriched echo", "text"
	message := &domain.Message{AccountID: f.account, DeviceID: &currentDevice, ChatID: current.ID, MessageID: "echo-same", FromJID: &pn, IsFromMe: true, Body: &body, MessageType: &kind, Timestamp: at}
	if err = repos.Message.Create(ctx, message); err != nil {
		t.Fatal(err)
	}
	window, err := repos.Message.GetWindowByChatID(ctx, f.account, current.ID, 50, 0)
	if err != nil || len(window) != 1 {
		t.Fatalf("echo produced duplicate: %v count=%d", err, len(window))
	}
	visible, err := repos.Message.GetVisibleByReference(ctx, f.account, old.ID, oldSource.ID.String())
	if err != nil || visible.ID != message.ID || visible.ChatID != current.ID {
		t.Fatal("old message link did not resolve to visible keeper", err)
	}
	var physical int
	integrityScanCount(t, db, `SELECT count(*) FROM messages WHERE account_id=$1`, f.account, &physical)
	if physical != 2 {
		t.Fatal("physical source removed")
	}
	foreign, foreignPerspective := uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO chats(id,account_id,contact_id,jid,channel_key,whatsapp_owner_id,canonical_chat_id,binding_state) SELECT $1,account_id,contact_id,jid,'synthetic-collision',whatsapp_owner_id,id,'verified_continuity' FROM chats WHERE account_id=$2 AND id=$3`, foreignPerspective, f.account, current.ID)
	integrityExec(t, db, `INSERT INTO messages(id,account_id,chat_id,message_id,from_jid,is_from_me,message_type,body,timestamp) VALUES($1,$2,$3,'echo-same','51900000999@s.whatsapp.net',true,'text','Synthetic distinct author',$4)`, foreign, f.account, foreignPerspective, at)
	if err = repos.Message.RevokeInChat(ctx, f.account, current.ID, "echo-same"); !errors.Is(err, ErrMessageIdentityAmbiguous) {
		t.Fatal("ambiguous message accepted", err)
	}
	var revoked bool
	if err = db.QueryRow(ctx, `SELECT COALESCE(is_revoked,FALSE) FROM messages WHERE account_id=$1 AND id=$2`, f.account, foreign).Scan(&revoked); err != nil || revoked {
		t.Fatal("provider ID joined another unverified author", err)
	}

}
