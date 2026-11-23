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

type privateHistorySharingFixture struct {
	account, user, device, oldDevice uuid.UUID
	source, target                   *domain.Chat
}

func privateHistorySharingSetup(t *testing.T, pool *pgxpool.Pool) privateHistorySharingFixture {
	t.Helper()
	f := integrityProgram(t, pool)
	result := privateHistorySharingFixture{account: f.account, user: f.user, device: uuid.New(), oldDevice: uuid.New()}
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$3,'Current synthetic','connected'),($2,$3,'Historical synthetic','disconnected')`, result.device, result.oldDevice, f.account)
	repos := NewRepositories(pool)
	var err error
	result.source, err = repos.Chat.GetOrCreate(context.Background(), f.account, result.device, "51900000301@s.whatsapp.net", "Synthetic source")
	if err != nil {
		t.Fatal(err)
	}
	result.target, err = repos.Chat.GetOrCreate(context.Background(), f.account, result.device, "51900000302@s.whatsapp.net", "Synthetic target")
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func privateHistorySharingSource(t *testing.T, pool *pgxpool.Pool, f privateHistorySharingFixture, origin *uuid.UUID) *domain.Message {
	t.Helper()
	id := uuid.New()
	integrityExec(t, pool, `INSERT INTO messages(id,account_id,device_id,chat_id,message_id,from_jid,is_from_me,message_type,media_url,media_mimetype,media_filename,timestamp,forwarding)
 VALUES($1,$2,$3,$4,$5,'51900000300@s.whatsapp.net',TRUE,'video',$6,'video/mp4','synthetic-history.mp4',$7,'{"state":"not_forwarded","score":0}'::jsonb)`, id, f.account, origin, f.source.ID, uuid.NewString(), "/api/media/file/"+f.account.String()+"/synthetic/history.mp4", time.Date(2026, 3, 28, 12, 0, 0, 0, time.UTC))
	message, err := NewRepositories(pool).Message.GetByReference(context.Background(), f.account, f.source.ID, id.String())
	if err != nil {
		t.Fatal(err)
	}
	return message
}
func privateHistorySharingOperation(f privateHistorySharingFixture, source *domain.Message, mode string) *ForwardOperation {
	limits := domain.EffectiveMessageSharingLimits(source)
	return &ForwardOperation{ID: uuid.New(), Mode: mode, ContentVariant: domain.MessageContentOriginal, AccountID: f.account, UserID: f.user, DeviceID: f.device, SourceChatID: f.source.ID, SourceMessageID: source.ID, RequestHash: uuid.NewString(), SourceFingerprint: domain.MessageForwardFingerprint(source), Forwarding: source.Forwarding, SharingLimits: &limits, Results: []ForwardTarget{{ChatID: f.target.ID, JID: f.target.JID, ProviderMessageID: uuid.NewString()}}}
}

func TestPrivateHistoricalCopyUsesCurrentChatSenderWithoutRewritingOrigin(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := privateHistorySharingSetup(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool).Message
	for _, origin := range []*uuid.UUID{nil, &f.oldDevice} {
		source := privateHistorySharingSource(t, pool, f, origin)
		fingerprint := domain.MessageForwardFingerprint(source)
		allowed, err := r.MessageSharingDeviceAllowed(ctx, f.account, f.source.ID, f.device, source, domain.MessageSharingCopy)
		if err != nil || !allowed {
			t.Fatalf("copy of authorized private history was blocked: %v", err)
		}
		for _, mode := range []string{domain.MessageSharingNative, ""} {
			allowed, err = r.MessageSharingDeviceAllowed(ctx, f.account, f.source.ID, f.device, source, mode)
			if err != nil || allowed {
				t.Fatal("native inherited relaxed copy origin rule", err)
			}
		}
		strict, err := r.MessageDeviceAllowed(ctx, f.account, f.source.ID, f.device, source)
		if err != nil || strict {
			t.Fatal("global action authorization was relaxed", err)
		}
		op := privateHistorySharingOperation(f, source, domain.MessageSharingCopy)
		created, err := r.CreateForwardOperation(ctx, op)
		if err != nil || !created {
			t.Fatalf("transaction rejected historical copy: %v", err)
		}
		replay, err := r.CreateForwardOperation(ctx, op)
		if err != nil || replay {
			t.Fatal("same operation was created again", err)
		}
		receipt, err := r.GetForwardOperation(ctx, f.account, f.user, op.ID)
		if err != nil || receipt.SourceMessageID != source.ID || receipt.SourceChatID != source.ChatID || receipt.SourceFingerprint != fingerprint {
			t.Fatal("operation rewrote historical source", err)
		}
		native := privateHistorySharingOperation(f, source, domain.MessageSharingNative)
		if created, err = r.CreateForwardOperation(ctx, native); created || !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("native reserved an unproven historical sender", created, err)
		}
		fresh, err := r.GetByReference(ctx, f.account, f.source.ID, source.ID.String())
		if err != nil || fresh.ChatID != source.ChatID || domain.MessageForwardFingerprint(fresh) != fingerprint {
			t.Fatal("source identity or fingerprint changed", err)
		}
		if (origin == nil && fresh.DeviceID != nil) || (origin != nil && (fresh.DeviceID == nil || *fresh.DeviceID != *origin)) {
			t.Fatal("historical device was rewritten to current sender")
		}
	}
	// A current native source still passes its existing strict rule.
	current := privateHistorySharingSource(t, pool, f, &f.device)
	if allowed, err := r.MessageSharingDeviceAllowed(ctx, f.account, f.source.ID, f.device, current, domain.MessageSharingNative); err != nil || !allowed {
		t.Fatal("current native source regressed", err)
	}
}

func TestPrivateHistoricalCopyRejectsOtherAccountChatAndSender(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := privateHistorySharingSetup(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool).Message
	source := privateHistorySharingSource(t, pool, f, nil)
	sameContactChat := uuid.New()
	integrityExec(t, pool, `INSERT INTO chats(id,account_id,device_id,contact_id,jid,channel_key) VALUES($1,$2,$3,$4,'51900000303@s.whatsapp.net','whatsapp_web')`, sameContactChat, f.account, f.device, *f.source.ContactID)
	for _, scope := range []struct{ account, chat, device uuid.UUID }{{uuid.New(), f.source.ID, f.device}, {f.account, f.target.ID, f.device}, {f.account, sameContactChat, f.device}, {f.account, f.source.ID, f.oldDevice}} {
		allowed, err := r.MessageSharingDeviceAllowed(ctx, scope.account, scope.chat, scope.device, source, domain.MessageSharingCopy)
		if err != nil || allowed {
			t.Fatal("copy escaped selected account/Chat/sender", err)
		}
		op := privateHistorySharingOperation(f, source, domain.MessageSharingCopy)
		op.AccountID, op.SourceChatID, op.DeviceID = scope.account, scope.chat, scope.device
		if created, err := r.CreateForwardOperation(ctx, op); created || !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("transaction escaped source scope", created, err)
		}
	}
	if allowed, err := r.MessageSharingDeviceAllowed(ctx, f.account, f.source.ID, f.device, source, "unsupported"); err == nil || allowed {
		t.Fatal("invalid mode accepted")
	}
	for _, mutation := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE devices SET status='disconnected' WHERE id=$1`, []any{f.device}},
		{`UPDATE devices SET provider='whatsapp_cloud_api' WHERE id=$1`, []any{f.device}},
		{`UPDATE devices SET delete_operation_id=$2 WHERE id=$1`, []any{f.device, uuid.New()}},
	} {
		integrityExec(t, pool, mutation.sql, mutation.args...)
		allowed, err := r.MessageSharingDeviceAllowed(ctx, f.account, f.source.ID, f.device, source, domain.MessageSharingCopy)
		if err != nil || allowed {
			t.Fatal("unavailable current sender accepted", err)
		}
		if created, err := r.CreateForwardOperation(ctx, privateHistorySharingOperation(f, source, domain.MessageSharingCopy)); created || !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("transaction accepted unavailable current sender", created, err)
		}
		integrityExec(t, pool, `UPDATE devices SET status='connected',provider='whatsapp_web',delete_operation_id=NULL WHERE id=$1`, f.device)
	}
	// The selected sender changed for real after preparation. A new request may
	// explicitly choose it later; the old prepared device must fail now.
	replacement := uuid.New()
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Replacement synthetic','connected')`, replacement, f.account)
	integrityExec(t, pool, `UPDATE chats SET device_id=$3 WHERE account_id=$1 AND id=$2`, f.account, f.source.ID, replacement)
	allowed, err := r.MessageSharingDeviceAllowed(ctx, f.account, f.source.ID, f.device, source, domain.MessageSharingCopy)
	if err != nil || allowed {
		t.Fatal("stale selected sender accepted", err)
	}
	if created, err := r.CreateForwardOperation(ctx, privateHistorySharingOperation(f, source, domain.MessageSharingCopy)); created || !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("old preparation survived current-device change", created, err)
	}
}

func TestPrivateHistoricalCopyDoesNotRelaxGroupOwnerRules(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := continuityMediaTree(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool).Message
	source, err := r.GetByReference(ctx, f.account, f.root, f.oldMessage.String())
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{domain.MessageSharingCopy, domain.MessageSharingNative} {
		allowed, err := r.MessageSharingDeviceAllowed(ctx, f.account, f.root, f.device, source, mode)
		if err != nil || !allowed {
			t.Fatal("verified group continuity regressed", mode, err)
		}
	}
	integrityExec(t, pool, `UPDATE chats SET binding_state='pending' WHERE account_id=$1 AND id=$2`, f.account, f.root)
	for _, mode := range []string{domain.MessageSharingCopy, domain.MessageSharingNative} {
		allowed, err := r.MessageSharingDeviceAllowed(ctx, f.account, f.root, f.device, source, mode)
		if err != nil || allowed {
			t.Fatal("private-copy exception bypassed group owner validation", mode, err)
		}
	}
}
