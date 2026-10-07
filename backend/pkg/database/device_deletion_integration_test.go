package database

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/repository"
)

// This suite has its own database-name guard and never falls back to the app's
// DATABASE_URL. Fixtures contain synthetic identities and no WhatsApp session.
func TestDeviceDeletionDurableIsolationAndMigration(t *testing.T) {
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
	// Simulate an upgraded installation with the old composite NO ACTION FK.
	if _, err = db.Exec(ctx, `ALTER TABLE contacts DROP CONSTRAINT contacts_account_device_fkey; ALTER TABLE contacts ADD CONSTRAINT contacts_account_device_fkey FOREIGN KEY(account_id,device_id) REFERENCES devices(account_id,id); ALTER TABLE chats DROP CONSTRAINT chats_account_device_fkey; ALTER TABLE chats ADD CONSTRAINT chats_account_device_fkey FOREIGN KEY(account_id,device_id) REFERENCES devices(account_id,id)`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err = Migrate(db); err != nil {
			t.Fatalf("upgrade/idempotency %d: %v", i, err)
		}
	}
	var correct int
	if err = db.QueryRow(ctx, `SELECT COUNT(*) FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='device_id' WHERE c.conname IN('contacts_account_device_fkey','chats_account_device_fkey') AND c.confdeltype='n' AND c.confdelsetcols=ARRAY[a.attnum]::smallint[] AND c.convalidated`).Scan(&correct); err != nil || correct != 2 {
		t.Fatalf("selective SET NULL constraints=%d err=%v", correct, err)
	}
	a, b, d, other, contact, chat, message, lead := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = db.Exec(cleanupCtx, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{a, b})
	})
	fixtures := []struct {
		query string
		args  []interface{}
	}{
		{`INSERT INTO accounts(id,name) VALUES($1,'Device deletion QA'),($2,'Other isolated QA')`, []interface{}{a, b}},
		{`INSERT INTO devices(id,account_id,name,jid,status) VALUES($1,$3,'Temporary QA','51999000111:7@s.whatsapp.net','connected'),($2,$3,'New temporary QA',NULL,'disconnected')`, []interface{}{d, other, a}},
		{`INSERT INTO contacts(id,account_id,device_id,jid,name) VALUES($1,$2,$3,'51999000222@s.whatsapp.net','Synthetic parent')`, []interface{}{contact, a, d}},
		{`INSERT INTO chats(id,account_id,device_id,contact_id,jid) VALUES($1,$2,$3,$4,'51999000222@s.whatsapp.net')`, []interface{}{chat, a, d, contact}},
		{`INSERT INTO messages(id,account_id,device_id,chat_id,message_id,body,message_type,timestamp) VALUES($1,$2,$3,$4,'qa-delete-message','Synthetic history','text',NOW())`, []interface{}{message, a, d, chat}},
		{`INSERT INTO leads(id,account_id,contact_id,jid,name) VALUES($1,$2,$3,'51999000222@s.whatsapp.net','Synthetic opportunity')`, []interface{}{lead, a, contact}},
	}
	for _, fixture := range fixtures {
		if _, err = db.Exec(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatalf("fixture: %v", err)
		}
	}
	repos := repository.NewRepositories(db)
	// A first pairing has no JID in the DELETE snapshot. The device reservation
	// must still serialize it against Save, even though its JID lock is empty.
	reserved, resume := make(chan struct{}), make(chan struct{})
	pairDone, deleteDone := make(chan error, 1), make(chan error, 1)
	go func() {
		pairDone <- repos.Device.WithSessionReservation(ctx, a, other, "51999000444:9@s.whatsapp.net", func(ctx context.Context) error {
			close(reserved)
			<-resume
			return repos.Device.RememberPairedSession(ctx, a, other, "51999000444:9@s.whatsapp.net")
		})
	}()
	select {
	case <-reserved:
	case pairErr := <-pairDone:
		t.Fatalf("pairing reservation: %v", pairErr)
	case <-ctx.Done():
		t.Fatal("pairing reservation timed out")
	}
	go func() { _, deleteErr := repos.Device.BeginDeletion(ctx, a, other, "", ""); deleteDone <- deleteErr }()
	select {
	case deleteErr := <-deleteDone:
		close(resume)
		t.Fatalf("blank-JID delete bypassed pairing reservation: %v", deleteErr)
	case <-time.After(100 * time.Millisecond):
	}
	close(resume)
	if pairErr := <-pairDone; pairErr != nil {
		t.Fatal(pairErr)
	}
	if deleteErr := <-deleteDone; !errors.Is(deleteErr, repository.ErrDeviceSessionConflict) {
		t.Fatalf("stale blank snapshot erased paired device: %v", deleteErr)
	}
	if err = repos.Device.Active(ctx, a, other); err != nil {
		t.Fatalf("pairing lost its operational row: %v", err)
	}
	if err = repos.Device.Active(ctx, b, d); !errors.Is(err, repository.ErrDeviceNotFound) {
		t.Fatalf("cross-account lookup=%v", err)
	}
	if _, err = repos.Device.BeginDeletion(ctx, b, d, "51999000111:7@s.whatsapp.net", "synthetic-fingerprint"); !errors.Is(err, repository.ErrDeviceNotFound) {
		t.Fatalf("cross-account delete=%v", err)
	}
	// Fail the detach statement after the device UPDATE: the whole request must
	// roll back, keeping the operational row and both Contact/Chat associations.
	if _, err = db.Exec(ctx, `ALTER TABLE contacts ADD CONSTRAINT qa_device_detach_failure CHECK(device_id IS NOT NULL) NOT VALID`); err != nil {
		t.Fatal(err)
	}
	if _, err = repos.Device.BeginDeletion(ctx, a, d, "51999000111:7@s.whatsapp.net", "synthetic-fingerprint"); err == nil {
		t.Fatal("expected detach persistence failure")
	}
	if _, err = db.Exec(ctx, `ALTER TABLE contacts DROP CONSTRAINT qa_device_detach_failure`); err != nil {
		t.Fatal(err)
	}
	if err = repos.Device.Active(ctx, a, d); err != nil {
		t.Fatalf("failed persistence disabled device: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM contacts WHERE id=$1 AND device_id=$2`, 1, contact, d)
	assertInt(t, db, `SELECT COUNT(*) FROM chats WHERE id=$1 AND device_id=$2`, 1, chat, d)
	result, err := repos.Device.BeginDeletion(ctx, a, d, "51999000111:7@s.whatsapp.net", "synthetic-fingerprint")
	if err != nil {
		t.Fatal(err)
	}
	if result.ContactsDetached != 1 || result.ChatsDetached != 1 || result.DevicesTotal != 2 || result.DevicesAvailable != 1 {
		t.Fatalf("canonical pending result=%+v", result)
	}
	repeated, err := repos.Device.BeginDeletion(ctx, a, d, "51999000111:7@s.whatsapp.net", "ignored")
	if err != nil || repeated.OperationID != result.OperationID {
		t.Fatalf("repeat must retain operation: %v", err)
	}
	if err = repos.Device.Active(ctx, a, d); !errors.Is(err, repository.ErrDeviceDeleting) {
		t.Fatalf("pending device usable: %v", err)
	}
	if err = repos.Device.UpdateName(ctx, d, "Cannot rename pending device"); !errors.Is(err, repository.ErrDeviceDeleting) {
		t.Fatalf("pending rename must report conflict: %v", err)
	}
	if err = repos.Device.UpdateReceiveMessages(ctx, d, true); !errors.Is(err, repository.ErrDeviceDeleting) {
		t.Fatalf("pending receive toggle must report conflict: %v", err)
	}
	if err = repos.Device.BindSession(ctx, other, "51999000111:7@s.whatsapp.net", "synthetic"); !errors.Is(err, repository.ErrDeviceSessionConflict) {
		t.Fatalf("session reservation bypass=%v", err)
	}
	if _, err = db.Exec(ctx, `INSERT INTO contacts(account_id,device_id,jid) VALUES($1,$2,'51999000333@s.whatsapp.net')`, a, d); err == nil {
		t.Fatal("stale ingestion reattached deleting device")
	}
	job, err := repos.Device.ClaimDeletion(ctx)
	if err != nil || job == nil || job.DeviceID != d {
		t.Fatalf("claim: %v", err)
	}
	if second, err := repos.Device.ClaimDeletion(ctx); err != nil || second != nil {
		t.Fatalf("lease double-claimed: %v", err)
	}
	if _, err = repos.Device.FinishDeletion(ctx, job); !errors.Is(err, repository.ErrDeviceDeletionLeaseLost) {
		t.Fatalf("hard delete before remote checkpoint=%v", err)
	}
	if err = repos.Device.CheckpointUnlinked(ctx, job); err != nil {
		t.Fatal(err)
	}
	t.Run("repeated_pending_delete_does_not_wait_for_finalize_locks", func(t *testing.T) {
		// Finalization holds the Device row while its FK waits for historical
		// Message rows. The committed tombstone must remain promptly readable.
		messageLock, lockErr := db.Begin(ctx)
		if lockErr != nil {
			t.Fatal(lockErr)
		}
		if _, lockErr = messageLock.Exec(ctx, `SELECT id FROM messages WHERE id=$1 FOR UPDATE`, message); lockErr != nil {
			_ = messageLock.Rollback(ctx)
			t.Fatal(lockErr)
		}
		finishCtx, finishCancel := context.WithCancel(ctx)
		finishDone := make(chan error, 1)
		go func() { _, finishErr := repos.Device.FinishDeletion(finishCtx, job); finishDone <- finishErr }()
		defer func() {
			finishCancel() // Preserve this pending fixture for the restart checks.
			_ = messageLock.Rollback(context.Background())
			select {
			case <-finishDone:
			case <-time.After(3 * time.Second):
				t.Error("cancelled finalization did not release its locks")
			}
		}()
		deadline := time.Now().Add(3 * time.Second)
		for {
			_, probeErr := db.Exec(ctx, `SELECT id FROM devices WHERE id=$1 FOR UPDATE NOWAIT`, d)
			var pgErr *pgconn.PgError
			if errors.As(probeErr, &pgErr) && pgErr.Code == "55P03" {
				break
			}
			if probeErr != nil || time.Now().After(deadline) {
				t.Fatalf("finalization did not hold the Device row: %v", probeErr)
			}
			select {
			case finishErr := <-finishDone:
				t.Fatalf("finalization bypassed historical Message lock: %v", finishErr)
			default:
			}
			time.Sleep(10 * time.Millisecond)
		}
		repeatCtx, repeatCancel := context.WithTimeout(ctx, time.Second)
		defer repeatCancel()
		repeated, repeatErr := repos.Device.BeginDeletion(repeatCtx, a, d, job.JID, "ignored")
		if repeatErr != nil || repeated.OperationID != job.OperationID || repeated.DeletionStatus != "pending" || repeated.DevicesTotal != 2 || repeated.DevicesAvailable != 1 {
			t.Fatalf("committed pending retry waited for finalize locks or changed operation: result=%+v error=%v", repeated, repeatErr)
		}
		foreignCtx, foreignCancel := context.WithTimeout(ctx, time.Second)
		defer foreignCancel()
		if _, foreignErr := repos.Device.BeginDeletion(foreignCtx, b, d, job.JID, "ignored"); !errors.Is(foreignErr, repository.ErrDeviceNotFound) {
			t.Fatalf("foreign pending device was exposed or waited for locks: %v", foreignErr)
		}
	})
	if err = repos.Device.RetryDeletion(ctx, job, time.Now().Add(-time.Second), "qa_local_failure"); err != nil {
		t.Fatal(err)
	}
	resumed, err := repos.Device.ClaimDeletion(ctx)
	if err != nil || resumed == nil || resumed.Phase != "remote_unlinked" || resumed.Attempts != 2 {
		t.Fatalf("restart durable checkpoint=%+v err=%v", resumed, err)
	}
	if err = repos.Device.CheckpointUnlinked(ctx, job); !errors.Is(err, repository.ErrDeviceDeletionLeaseLost) {
		t.Fatalf("old worker lease accepted: %v", err)
	}
	done, err := repos.Device.FinishDeletion(ctx, resumed)
	if err != nil || done.DeletionStatus != "completed" || done.DevicesTotal != 1 {
		t.Fatalf("complete=%+v err=%v", done, err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM contacts WHERE id=$1 AND account_id=$2 AND device_id IS NULL`, 1, contact, a)
	assertInt(t, db, `SELECT COUNT(*) FROM chats WHERE id=$1 AND account_id=$2 AND contact_id=$3 AND device_id IS NULL`, 1, chat, a, contact)
	assertInt(t, db, `SELECT COUNT(*) FROM messages WHERE id=$1 AND account_id=$2 AND chat_id=$3 AND device_id IS NULL`, 1, message, a, chat)
	assertInt(t, db, `SELECT COUNT(*) FROM leads WHERE id=$1 AND account_id=$2 AND contact_id=$3`, 1, lead, a, contact)
}
