package repository

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type continuityMediaFixture struct{ account, device, root, alias, oldMessage, currentMessage uuid.UUID }

func continuityMediaTree(t *testing.T, pool *pgxpool.Pool) continuityMediaFixture {
	t.Helper()
	account, device := privatePeerFixture(t, pool)
	f := continuityMediaFixture{account, device, uuid.New(), uuid.New(), uuid.New(), uuid.New()}
	contact, owner := uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO whatsapp_conversation_owners(id,account_id,own_pn,own_lid) VALUES($1,$2,'51900000201@s.whatsapp.net','70201@lid')`, owner, account)
	integrityExec(t, pool, `INSERT INTO contacts(id,account_id,jid,is_group) VALUES($1,$2,'1200201@g.us',TRUE)`, contact, account)
	integrityExec(t, pool, `INSERT INTO chats(id,account_id,device_id,contact_id,jid,channel_key,whatsapp_owner_id,binding_state,canonical_chat_id) VALUES($1,$3,$4,$5,'1200201@g.us','synthetic-media-current',$6,'verified_continuity',NULL),($2,$3,NULL,$5,'1200201@g.us','synthetic-media-old',$6,'verified_continuity',$1)`, f.root, f.alias, account, device, contact, owner)
	integrityExec(t, pool, `UPDATE chats SET canonical_chat_id=$3 WHERE account_id=$1 AND id=$2`, account, f.alias, f.root)
	at := time.Date(2026, 10, 25, 11, 0, 0, 0, time.UTC)
	integrityExec(t, pool, `INSERT INTO messages(id,account_id,device_id,chat_id,message_id,from_jid,message_type,media_mimetype,body,is_from_me,timestamp) VALUES($1,$3,NULL,$4,'media-stanza','51900000202@s.whatsapp.net','image','image/jpeg','Original caption',FALSE,$6),($2,$3,$5,$7,'media-stanza','51900000202@s.whatsapp.net','image','image/jpeg',NULL,FALSE,$6)`, f.oldMessage, f.currentMessage, account, f.alias, device, at, f.root)
	return f
}
func reconcileContinuityMedia(t *testing.T, pool *pgxpool.Pool, f continuityMediaFixture) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = recordDuplicateGroupMessages(ctx, tx, f.account, f.root); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestWhatsAppContinuityMediaKeepsUsefulHistoricalReplica(t *testing.T) {
	for _, variant := range []string{"stored_url", "recoverable_metadata"} {
		t.Run(variant, func(t *testing.T) {
			pool := programSurveyIntegrityPool(t)
			f := continuityMediaTree(t, pool)
			ctx := context.Background()
			r := NewRepositories(pool).Message
			if variant == "stored_url" {
				integrityExec(t, pool, `UPDATE messages SET media_url=$3 WHERE account_id=$1 AND id=$2`, f.account, f.oldMessage, "/api/media/file/"+f.account.String()+"/synthetic-image.jpg")
			} else {
				integrityExec(t, pool, `INSERT INTO chat_group_media_recovery(account_id,chat_id,message_id,payload) VALUES($1,$2,$3,$4)`, f.account, f.alias, f.oldMessage, []byte("synthetic-recovery-metadata"))
			}
			reconcileContinuityMedia(t, pool, f)
			messages, err := r.GetWindowByChatID(ctx, f.account, f.root, 50, 0)
			if err != nil {
				t.Fatal(err)
			}
			if len(messages) != 1 || messages[0].ID != f.oldMessage || messages[0].ChatID != f.root {
				t.Fatalf("useful original hidden by current placeholder: %+v", messages)
			}
			visible := messages[0]
			if variant == "stored_url" && (visible.MediaURL == nil || *visible.MediaURL == "") {
				t.Fatal("historical attachment disappeared")
			}
			if err = r.HydrateMentions(ctx, f.account, f.root, messages); err != nil {
				t.Fatal(err)
			}
			if variant == "recoverable_metadata" && !visible.MediaRecoverable {
				t.Fatal("historical recovery action disappeared")
			}
			raw, err := r.GetByReference(ctx, f.account, f.root, f.oldMessage.String())
			if err != nil {
				t.Fatal(err)
			}
			if raw.ID != f.oldMessage || raw.ChatID != f.alias || raw.DeviceID != nil {
				t.Fatal("raw operation provenance was rewritten")
			}
			allowed, err := r.MessageDeviceAllowed(ctx, f.account, f.root, f.device, raw)
			if err != nil || !allowed {
				t.Fatalf("verified owner cannot use original media: %v", err)
			}
			byRetiredUUID, err := r.GetVisibleByReference(ctx, f.account, f.root, f.currentMessage.String())
			if err != nil || byRetiredUUID.ID != f.oldMessage {
				t.Fatalf("placeholder reference did not resolve to useful replica: %v", err)
			}
			// Repeated recovery/reconnect never turns the existing keeper into its own
			// alias, even if a newer replica gains another media projection later.
			integrityExec(t, pool, `UPDATE messages SET media_url=$3 WHERE account_id=$1 AND id=$2`, f.account, f.currentMessage, "/api/media/file/"+f.account.String()+"/synthetic-later.jpg")
			reconcileContinuityMedia(t, pool, f)
			again, err := r.GetVisibleByReference(ctx, f.account, f.root, f.currentMessage.String())
			if err != nil || again.ID != f.oldMessage {
				t.Fatalf("canonical media keeper changed or cycled: %v", err)
			}
			var physical int
			integrityScanCount(t, pool, `SELECT COUNT(*) FROM messages WHERE account_id=$1`, f.account, &physical)
			if physical != 2 {
				t.Fatal("media dedup removed a physical row")
			}
		})
	}
}

func TestWhatsAppContinuityMediaRemovalKeepsRestorableOriginalTombstone(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := continuityMediaTree(t, pool)
	r := NewRepositories(pool).Message
	ctx := context.Background()
	integrityExec(t, pool, `UPDATE messages SET media_url=$3 WHERE account_id=$1 AND id=$2`, f.account, f.oldMessage, "/api/media/file/"+f.account.String()+"/synthetic-old.jpg")
	integrityExec(t, pool, `UPDATE messages SET media_deleted=TRUE WHERE account_id=$1 AND id=$2`, f.account, f.currentMessage)
	reconcileContinuityMedia(t, pool, f)
	rows, err := r.GetWindowByChatID(ctx, f.account, f.root, 50, 0)
	if err != nil || len(rows) != 1 || rows[0].ID != f.currentMessage || !rows[0].MediaDeleted {
		t.Fatalf("another replica resurrected removed media: %+v %v", rows, err)
	}
	raw, err := r.GetByReference(ctx, f.account, f.root, f.oldMessage.String())
	if err != nil || raw.MediaDeleted {
		t.Fatal("dedup fabricated a tombstone without its storage removal snapshot", err)
	}
	available, err := r.SharingSourceAvailable(ctx, f.account, f.root, raw)
	if err != nil || available {
		t.Fatalf("raw replica UUID bypassed original removal: %v", err)
	}

	// The storage restore adapter owns this one original UUID. Clearing that
	// original flag must survive another dedup; no generated replica flag may
	// mark the restored reference removed again.
	integrityExec(t, pool, `UPDATE messages SET media_deleted=FALSE,media_url=$3 WHERE account_id=$1 AND id=$2`, f.account, f.currentMessage, "/api/media/file/"+f.account.String()+"/synthetic-restored.jpg")
	reconcileContinuityMedia(t, pool, f)
	rows, err = r.GetWindowByChatID(ctx, f.account, f.root, 50, 0)
	if err != nil || len(rows) != 1 || rows[0].ID != f.currentMessage || rows[0].MediaDeleted {
		t.Fatalf("restored original was retombstoned: %+v %v", rows, err)
	}
	available, err = r.SharingSourceAvailable(ctx, f.account, f.root, raw)
	if err != nil || !available {
		t.Fatalf("restored original remained blocked by a fabricated replica tombstone: %v", err)
	}

}
