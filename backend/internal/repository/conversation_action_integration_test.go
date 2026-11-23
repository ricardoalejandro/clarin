package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type conversationActionFixture struct{ account, device, contact, root, alias uuid.UUID }

func conversationActionTree(t *testing.T, pool *pgxpool.Pool) conversationActionFixture {
	t.Helper()
	account, device := privatePeerFixture(t, pool)
	f := conversationActionFixture{account, device, uuid.New(), uuid.New(), uuid.New()}
	integrityExec(t, pool, `INSERT INTO contacts(id,account_id,jid,is_group) VALUES($1,$2,'12009999@g.us',TRUE)`, f.contact, account)
	integrityExec(t, pool, `INSERT INTO chats(id,account_id,device_id,contact_id,jid,channel_key) VALUES($1,$3,$4,$5,'12009999@g.us','synthetic-root'),($2,$3,$4,$5,'12009999@g.us','synthetic-alias')`, f.root, f.alias, account, device, f.contact)
	integrityExec(t, pool, `UPDATE chats SET canonical_chat_id=$3 WHERE account_id=$1 AND id=$2`, account, f.alias, f.root)
	return f
}
func conversationActionMessage(t *testing.T, pool *pgxpool.Pool, f conversationActionFixture, chat, id uuid.UUID, provider string, at time.Time) {
	t.Helper()
	integrityExec(t, pool, `INSERT INTO messages(id,account_id,device_id,chat_id,message_id,message_type,body,is_from_me,is_read,timestamp) VALUES($1,$2,$3,$4,$5,'text','Synthetic local continuity',FALSE,FALSE,$6)`, id, f.account, f.device, chat, provider, at)
}

func TestConversationActionsReadStateAndAttentionUseVisibleTree(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := conversationActionTree(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool).Chat
	at := time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC)
	canonicalDuplicate, aliasDuplicate, oldUnique, newUnique := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	conversationActionMessage(t, pool, f, f.root, canonicalDuplicate, "duplicate-stanza", at)
	conversationActionMessage(t, pool, f, f.alias, aliasDuplicate, "duplicate-stanza", at)
	conversationActionMessage(t, pool, f, f.alias, oldUnique, "old-stanza", at.Add(time.Minute))
	conversationActionMessage(t, pool, f, f.root, newUnique, "new-stanza", at.Add(2*time.Minute))
	integrityExec(t, pool, `INSERT INTO whatsapp_message_aliases(account_id,alias_message_id,canonical_message_id) VALUES($1,$2,$3)`, f.account, aliasDuplicate, canonicalDuplicate)
	state, err := r.State(ctx, f.account, f.alias)
	if err != nil {
		t.Fatal(err)
	}
	if state.ChatID != f.root || state.UnreadCount != 3 || state.LastIncomingMessageID == nil || *state.LastIncomingMessageID != newUnique {
		t.Fatalf("state did not aggregate visible tree: %+v", state)
	}
	chat := &domain.Chat{ID: f.root, AccountID: f.account, UnreadCount: 99}
	if err = r.HydrateConversationState(ctx, f.account, []*domain.Chat{chat}); err != nil {
		t.Fatal(err)
	}
	if chat.UnreadCount != 3 || chat.StateVersion != state.Version {
		t.Fatal("list/state disagree")
	}
	unread, provider, err := r.MarkAsRead(ctx, f.account, f.alias, aliasDuplicate.String())
	if err != nil {
		t.Fatal(err)
	}
	if unread != 2 || provider != "duplicate-stanza" {
		t.Fatalf("alias watermark returned %d/%s", unread, provider)
	}
	var copiesRead int
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM messages WHERE account_id=$1 AND message_id='duplicate-stanza' AND is_read`, f.account, &copiesRead)
	if copiesRead != 2 {
		t.Fatal("physical duplicate kept unread")
	}
	oldVersion := state.Version
	state, err = r.State(ctx, f.account, f.root)
	if err != nil {
		t.Fatal(err)
	}
	if state.UnreadCount != 2 || state.Version <= oldVersion {
		t.Fatal("read state/version did not advance")
	}
	boundary, boundaryID, err := r.IncomingBoundary(ctx, f.account, f.root, oldUnique.String())
	if err != nil || boundary == nil || boundaryID == nil || *boundaryID != oldUnique {
		t.Fatalf("old physical quote not in scope: %v", err)
	}
	unread, _, err = r.MarkAsRead(ctx, f.account, f.root, oldUnique.String())
	if err != nil || unread != 1 {
		t.Fatalf("older displayed watermark read newer message: %d %v", unread, err)
	}
	if err = r.AcknowledgeAttention(ctx, f.account, f.alias, oldUnique.String()); err != nil {
		t.Fatal(err)
	}
	if _, _, err = r.MarkAsRead(ctx, uuid.New(), f.root, ""); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("foreign account read was accepted", err)
	}
	if _, _, err = r.MarkAsRead(ctx, f.account, f.root, uuid.NewString()); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("foreign message watermark was accepted", err)
	}
	state, err = r.State(ctx, f.account, f.root)
	if err != nil || state.UnreadCount != 1 {
		t.Fatalf("failed read changed tree: %+v %v", state, err)
	}
	unread, _, err = r.MarkAsRead(ctx, f.account, f.root, "")
	if err != nil || unread != 0 {
		t.Fatalf("read all visible messages: %d %v", unread, err)
	}
}

func TestConversationActionsPinsInheritOnceAndNeverResurrectUnpin(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := conversationActionTree(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool).Chat
	actor, other := uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{actor, other} {
		integrityExec(t, pool, `INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'synthetic-only')`, id, f.account, id.String(), id.String()+"@test.invalid")
	}
	integrityExec(t, pool, `INSERT INTO chat_user_preferences(account_id,user_id,chat_id,is_pinned,pinned_at,version) VALUES($1,$2,$3,TRUE,NOW(),5)`, f.account, actor, f.alias)
	chat := &domain.Chat{ID: f.root, AccountID: f.account}
	if err := r.ApplyUserPins(ctx, f.account, actor, []*domain.Chat{chat}); err != nil {
		t.Fatal(err)
	}
	if !chat.IsPinned || chat.PinVersion != 5 {
		t.Fatal("old alias pin was hidden")
	}
	unpin, err := r.SetUserPin(ctx, f.account, actor, f.alias, false)
	if err != nil {
		t.Fatal(err)
	}
	if unpin.ChatID != f.root || unpin.IsPinned || unpin.PinVersion != 6 || unpin.PinnedAt != nil {
		t.Fatalf("alias unpin was not canonical: %+v", unpin)
	}
	integrityExec(t, pool, `UPDATE chat_user_preferences SET version=99 WHERE account_id=$1 AND chat_id=$2`, f.account, f.alias)
	if err = r.ApplyUserPins(ctx, f.account, actor, []*domain.Chat{chat}); err != nil {
		t.Fatal(err)
	}
	if chat.IsPinned || chat.PinVersion != 6 {
		t.Fatal("old alias preference resurrected explicit unpin")
	}
	retry, err := r.SetUserPin(ctx, f.account, actor, f.root, false)
	if err != nil || retry.PinVersion != 6 {
		t.Fatal("pin retry changed version", err)
	}
	if err = r.ApplyUserPins(ctx, f.account, other, []*domain.Chat{chat}); err != nil {
		t.Fatal(err)
	}
	if chat.IsPinned || chat.PinVersion != 0 {
		t.Fatal("actor pin leaked")
	}
	if _, err = r.SetUserPin(ctx, uuid.New(), actor, f.alias, true); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("cross-account pin accepted", err)
	}
}

func TestConversationActionsLinkedDeletionRejectsBeforeAnyWrites(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := conversationActionTree(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool).Chat
	conversationActionMessage(t, pool, f, f.alias, uuid.New(), "old-only", time.Now())
	conversationActionMessage(t, pool, f, f.root, uuid.New(), "new-only", time.Now())
	direct, err := r.GetOrCreate(ctx, f.account, f.device, "51900000009@s.whatsapp.net", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []func() error{
		func() error { return r.Delete(ctx, f.account, f.root) },
		func() error { return r.Delete(ctx, f.account, f.alias) },
		func() error { return r.DeleteBatch(ctx, f.account, []uuid.UUID{direct.ID, f.root}) },
		func() error { return r.DeleteAll(ctx, f.account) },
	} {
		if err = action(); !errors.Is(err, ErrChatContinuityDeleteRequiresReview) {
			t.Fatalf("linked deletion should require review: %v", err)
		}
	}
	privatePeerCounts(t, pool, f.account, 2, 3, 0)
	var messages int
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM messages WHERE account_id=$1`, f.account, &messages)
	if messages != 2 {
		t.Fatal("rejected deletion changed historical messages")
	}
	// Ordinary explicit deletion retains the existing same-account Contact rule.
	if err = r.Delete(ctx, f.account, direct.ID); err != nil {
		t.Fatal(err)
	}
	privatePeerCounts(t, pool, f.account, 2, 2, 0)
}

func TestConversationActionsRejectBindingChangeBeforeWrites(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := conversationActionTree(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner := uuid.New()
	integrityExec(t, pool, `INSERT INTO whatsapp_conversation_owners(id,account_id,own_pn) VALUES($1,$2,'51900000101@s.whatsapp.net')`, owner, f.account)
	integrityExec(t, pool, `UPDATE chats SET whatsapp_owner_id=$3 WHERE account_id=$1 AND (id=$2 OR canonical_chat_id=$2)`, f.account, f.root, owner)
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err = blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,71140))`, f.account.String()+":"+owner.String()+":12009999@g.us"); err != nil {
		t.Fatal(err)
	}
	reader, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Rollback(ctx)
	var pid int
	if err = reader.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, _, e := lockConversationChatsTx(ctx, reader, f.account, f.root); done <- e }()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err = pool.QueryRow(ctx, `SELECT cardinality(pg_blocking_pids($1::int))>0`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("conversation read did not wait for repair barrier")
		case <-ticker.C:
		}
	}
	// A repair switches canonical perspective while the action waits, keeping
	// both physical histories. The delayed action must reject before mutation.
	if _, err = blocker.Exec(ctx, `UPDATE chats SET canonical_chat_id=$3 WHERE account_id=$1 AND id=$2`, f.account, f.root, f.alias); err != nil {
		t.Fatal(err)
	}
	if _, err = blocker.Exec(ctx, `UPDATE chats SET canonical_chat_id=NULL WHERE account_id=$1 AND id=$2`, f.account, f.alias); err != nil {
		t.Fatal(err)
	}
	if err = blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, ErrChatBindingChanged) {
		t.Fatalf("changed binding was not rejected: %v", err)
	}
	if err = reader.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	privatePeerCounts(t, pool, f.account, 1, 2, 0)
}
