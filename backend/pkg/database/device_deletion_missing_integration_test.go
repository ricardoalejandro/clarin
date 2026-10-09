package database

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
)

// Local detachment has no provider calls and cannot erase a replacement store.
// Like the durable deletion suite, this test refuses the application's DB.
func TestMissingDeviceSessionLocalDetachmentIsFencedAndPreservesHistory(t *testing.T) {
	if os.Getenv("CLARIN_RUN_DEVICE_DELETION_INTEGRATION") != "1" {
		t.Skip("isolated device deletion integration not enabled")
	}
	raw := os.Getenv("DEVICE_DELETION_TEST_DATABASE_URL")
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Path != "/clarin_device_deletion_test" {
		t.Fatal("DEVICE_DELETION_TEST_DATABASE_URL must target clarin_device_deletion_test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	db, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal("cannot open isolated device test database")
	}
	t.Cleanup(db.Close)
	if err = Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	container, err := sqlstore.New(ctx, "pgx", raw, nil)
	if err != nil {
		t.Fatal("cannot initialize isolated WhatsApp store schema")
	}
	t.Cleanup(func() { _ = container.Close() })
	repos := repository.NewRepositories(db)

	fixture := func(t *testing.T, seed ...func(uuid.UUID, uuid.UUID)) (*repository.DeviceDeletion, *pgxpool.Conn, uuid.UUID, uuid.UUID) {
		t.Helper()
		a, b, d := uuid.New(), uuid.New(), uuid.New()
		jid := types.NewADJID("audit"+uuid.NewString(), 0, 7).String()
		if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Local detached QA'),($2,'Foreign detached QA');`, a, b); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `INSERT INTO devices(id,account_id,name,jid,status) VALUES($1,$2,'Disconnected synthetic session',$3,'disconnected')`, d, a, jid); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cleanupCancel()
			_, _ = db.Exec(cleanupCtx, `DELETE FROM whatsmeow_device WHERE jid=$1`, jid)
			_, _ = db.Exec(cleanupCtx, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{a, b})
		})
		for _, create := range seed {
			create(a, d)
		}
		if _, err := repos.Device.BeginDeletion(ctx, a, d, jid, ""); err != nil {
			t.Fatal(err)
		}
		job, err := repos.Device.ClaimDeletion(ctx)
		if err != nil || job == nil || job.DeviceID != d {
			t.Fatalf("claim: job=%+v err=%v", job, err)
		}
		conn, err := db.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1::text,71127))`, jid); err != nil {
			conn.Release()
			t.Fatal(err)
		}
		t.Cleanup(func() {
			unlockCtx, unlockCancel := context.WithTimeout(context.Background(), time.Second)
			defer unlockCancel()
			if _, err := conn.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1::text,71127))`, jid); err != nil {
				_ = conn.Conn().Close(context.Background())
			}
			conn.Release()
		})
		return job, conn, a, b
	}
	makeReplacement := func(t *testing.T, jid string) *store.Device {
		t.Helper()
		parsedJID, err := types.ParseJID(jid)
		if err != nil {
			t.Fatal(err)
		}
		device := container.NewDevice()
		device.ID = &parsedJID
		device.Account = &waAdv.ADVSignedDeviceIdentity{Details: []byte{1}, AccountSignature: make([]byte, 64), AccountSignatureKey: make([]byte, 32), DeviceSignature: make([]byte, 64)}
		if err := device.Save(ctx); err != nil {
			t.Fatal(err)
		}
		return device
	}
	t.Run("unpaired_device_never_claims_remote_logout", func(t *testing.T) {
		a, d := uuid.New(), uuid.New()
		if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Unpaired local QA')`, a); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = db.Exec(context.Background(), `DELETE FROM accounts WHERE id=$1`, a) })
		if _, err := db.Exec(ctx, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Unpaired device','disconnected')`, d, a); err != nil {
			t.Fatal(err)
		}
		if _, err := repos.Device.BeginDeletion(ctx, a, d, "", ""); err != nil {
			t.Fatal(err)
		}
		job, err := repos.Device.ClaimDeletion(ctx)
		if err != nil || job == nil || job.DeviceID != d || job.Phase != "local_detached" {
			t.Fatalf("unpaired checkpoint falsely remote: %+v %v", job, err)
		}
		conn, err := db.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Release()
		result, err := repos.Device.FinishLocalDeletion(ctx, job, conn)
		if err != nil || result.CleanupScope != "local" || result.DeletionStatus != "completed" {
			t.Fatalf("unpaired cleanup falsely remote: %+v %v", result, err)
		}
	})
	t.Run("identity_account_operation_lease_and_fingerprint_must_match", func(t *testing.T) {
		job, conn, _, b := fixture(t)
		cases := []struct {
			name  string
			alter func(*repository.DeviceDeletion)
		}{
			{"foreign_account", func(j *repository.DeviceDeletion) { j.AccountID = b }},
			{"foreign_device", func(j *repository.DeviceDeletion) { j.DeviceID = uuid.New() }},
			{"replaced_operation", func(j *repository.DeviceDeletion) { j.OperationID = uuid.New() }},
			{"lost_lease", func(j *repository.DeviceDeletion) { j.LeaseToken = uuid.New() }},
			{"changed_companion", func(j *repository.DeviceDeletion) { j.JID = "audit-other:8@s.whatsapp.net" }},
			{"changed_fingerprint", func(j *repository.DeviceDeletion) { j.Fingerprint = "replacement" }},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				stale := *job
				tc.alter(&stale)
				if err := repos.Device.CheckpointLocalDetachment(ctx, &stale, conn); !errors.Is(err, repository.ErrDeviceSessionConflict) {
					t.Fatalf("unsafe checkpoint: %v", err)
				}
			})
		}
		if err := repos.Device.CheckpointLocalDetachment(ctx, job, nil); !errors.Is(err, repository.ErrDeviceSessionConflict) {
			t.Fatalf("unreserved checkpoint=%v", err)
		}
		if _, err := db.Exec(ctx, `UPDATE devices SET delete_lease_until=NOW()-INTERVAL '1 second' WHERE id=$1`, job.DeviceID); err != nil {
			t.Fatal(err)
		}
		if err := repos.Device.CheckpointLocalDetachment(ctx, job, conn); !errors.Is(err, repository.ErrDeviceSessionConflict) {
			t.Fatalf("expired lease checkpoint=%v", err)
		}
		assertInt(t, db, `SELECT COUNT(*) FROM devices WHERE id=$1 AND delete_phase='pending'`, 1, job.DeviceID)
	})
	t.Run("foreign_owner_or_replacement_store_prevents_local_cleanup", func(t *testing.T) {
		job, conn, _, b := fixture(t)
		foreign := uuid.New()
		if _, err := db.Exec(ctx, `INSERT INTO devices(id,account_id,name,jid,status) VALUES($1,$2,'Foreign synthetic owner',$3,'disconnected')`, foreign, b, job.JID); err != nil {
			t.Fatal(err)
		}
		if err := repos.Device.CheckpointLocalDetachment(ctx, job, conn); !errors.Is(err, repository.ErrDeviceSessionConflict) {
			t.Fatalf("foreign session owner bypass=%v", err)
		}
		if _, err := db.Exec(ctx, `DELETE FROM devices WHERE id=$1 AND account_id=$2`, foreign, b); err != nil {
			t.Fatal(err)
		}
		replacement := makeReplacement(t, job.JID)
		if err := repos.Device.CheckpointLocalDetachment(ctx, job, conn); !errors.Is(err, repository.ErrDeviceSessionConflict) {
			t.Fatalf("replacement store bypass=%v", err)
		}
		stored, err := container.GetDevice(ctx, *replacement.ID)
		if err != nil || stored == nil || stored.RegistrationID != replacement.RegistrationID {
			t.Fatal("replacement session was modified")
		}
		assertInt(t, db, `SELECT COUNT(*) FROM devices WHERE id=$1 AND delete_phase='pending'`, 1, job.DeviceID)
	})
	t.Run("replacement_after_checkpoint_is_preserved_and_completion_denied", func(t *testing.T) {
		job, conn, _, _ := fixture(t)
		if err := repos.Device.CheckpointLocalDetachment(ctx, job, conn); err != nil {
			t.Fatal(err)
		}
		replacement := makeReplacement(t, job.JID)
		if _, err := repos.Device.FinishLocalDeletion(ctx, job, conn); !errors.Is(err, repository.ErrDeviceSessionConflict) {
			t.Fatalf("replaced store finalized=%v", err)
		}
		stored, err := container.GetDevice(ctx, *replacement.ID)
		if err != nil || stored == nil || stored.RegistrationID != replacement.RegistrationID {
			t.Fatal("replacement keys were removed")
		}
		pending, err := repos.Device.PendingDeletion(ctx, job.AccountID, job.DeviceID)
		if err != nil || pending == nil || pending.CleanupScope != "local" || pending.DeletionStatus != "pending" {
			t.Fatalf("checkpoint mislabeled remote: %+v %v", pending, err)
		}
	})
	t.Run("same_companion_fence_and_history_preservation", func(t *testing.T) {
		contact, chat, message, lead, other := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
		job, conn, a, b := fixture(t, func(a, d uuid.UUID) {
			fixtures := []struct {
				query string
				args  []interface{}
			}{
				{`INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Other preserved device','disconnected')`, []interface{}{other, a}},
				{`INSERT INTO contacts(id,account_id,device_id,jid,name) VALUES($1,$2,$3,'audit-contact@s.whatsapp.net','Synthetic parent')`, []interface{}{contact, a, d}},
				{`INSERT INTO chats(id,account_id,device_id,contact_id,jid) VALUES($1,$2,$3,$4,'audit-contact@s.whatsapp.net')`, []interface{}{chat, a, d, contact}},
				{`INSERT INTO messages(id,account_id,device_id,chat_id,message_id,body,message_type,timestamp,media_url) VALUES($1,$2,$3,$4,'local-detached-history','Synthetic history','image',NOW(),'/api/media/file/synthetic-preserved-asset')`, []interface{}{message, a, d, chat}},
				{`INSERT INTO leads(id,account_id,contact_id,jid,name) VALUES($1,$2,$3,'audit-contact@s.whatsapp.net','Synthetic opportunity')`, []interface{}{lead, a, contact}},
			}
			for _, f := range fixtures {
				if _, err := db.Exec(ctx, f.query, f.args...); err != nil {
					t.Fatal(err)
				}
			}
		})
		// The worker's reserved connection keeps pairing/saving the exact
		// companion fenced until it commits local finalization.
		competing, err := db.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var locked bool
		err = competing.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1::text,71127))`, job.JID).Scan(&locked)
		competing.Release()
		if err != nil || locked {
			t.Fatalf("full companion fence was not held: %v", err)
		}
		assertInt(t, db, `SELECT COUNT(*) FROM contacts WHERE id=$1 AND device_id IS NULL`, 1, contact)
		assertInt(t, db, `SELECT COUNT(*) FROM chats WHERE id=$1 AND device_id IS NULL`, 1, chat)
		if err := repos.Device.CheckpointLocalDetachment(ctx, job, conn); err != nil {
			t.Fatal(err)
		}
		assertInt(t, db, `SELECT COUNT(*) FROM devices WHERE id=$1 AND delete_phase='local_detached'`, 1, job.DeviceID)
		if _, err := repos.Device.FinishDeletion(ctx, job); !errors.Is(err, repository.ErrDeviceSessionConflict) {
			t.Fatalf("unreserved local finish=%v", err)
		}
		foreign := *job
		foreign.AccountID = b
		if _, err := repos.Device.FinishLocalDeletion(ctx, &foreign, conn); !errors.Is(err, repository.ErrDeviceDeletionLeaseLost) {
			t.Fatalf("foreign finish=%v", err)
		}
		result, err := repos.Device.FinishLocalDeletion(ctx, job, conn)
		if err != nil || result.DeletionStatus != "completed" || result.CleanupScope != "local" || result.DevicesTotal != 1 || result.DevicesAvailable != 1 {
			t.Fatalf("completion: %+v %v", result, err)
		}
		assertInt(t, db, `SELECT COUNT(*) FROM devices WHERE id=$1`, 0, job.DeviceID)
		assertInt(t, db, `SELECT COUNT(*) FROM accounts WHERE id=ANY($1::uuid[])`, 2, []uuid.UUID{a, b})
		assertInt(t, db, `SELECT COUNT(*) FROM contacts WHERE id=$1 AND account_id=$2 AND device_id IS NULL`, 1, contact, a)
		assertInt(t, db, `SELECT COUNT(*) FROM chats WHERE id=$1 AND account_id=$2 AND contact_id=$3 AND device_id IS NULL`, 1, chat, a, contact)
		assertInt(t, db, `SELECT COUNT(*) FROM messages WHERE id=$1 AND account_id=$2 AND chat_id=$3 AND device_id IS NULL AND media_url='/api/media/file/synthetic-preserved-asset' AND body='Synthetic history'`, 1, message, a, chat)
		assertInt(t, db, `SELECT COUNT(*) FROM leads WHERE id=$1 AND account_id=$2 AND contact_id=$3`, 1, lead, a, contact)
	})
}
