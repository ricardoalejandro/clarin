package utilities

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/pkg/database"
)

// Keeps this lock/journal acceptance check independent of a real object server.
// The database, versions, storage inventories and transactions remain real.
type checkpointMemoryObjects struct {
	mu   sync.Mutex
	data map[string][]byte
}

func (s *checkpointMemoryObjects) UploadObject(ctx context.Context, key string, data []byte, _ string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[key] = bytes.Clone(data)
	return key, nil
}

func (s *checkpointMemoryObjects) GetFileLimited(ctx context.Context, key string, limit int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, exists := s.data[key]
	if !exists || int64(len(data)) > limit {
		return nil, errors.New("fixture object missing or over limit")
	}
	return bytes.Clone(data), nil
}

func (s *checkpointMemoryObjects) DeleteFile(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, key)
	return nil
}

func TestUtilitiesPostgresReadCheckpointIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_UTILITIES_POSTGRES_INTEGRATION") != "1" {
		t.Skip("requires the dedicated loopback clarin_utilities_qa PostgreSQL database")
	}
	raw := os.Getenv("UTILITIES_TEST_DATABASE_URL")
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Path != "/clarin_utilities_qa" {
		t.Fatal("isolated loopback clarin_utilities_qa database required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	db, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	for pass := 0; pass < 2; pass++ {
		if err := database.Migrate(db); err != nil {
			t.Fatalf("migration pass %d: %v", pass, err)
		}
	}
	account, otherAccount, owner, otherOwner := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Read checkpoint QA A'),($2,'Read checkpoint QA B')`, account, otherAccount)
	for _, actor := range []uuid.UUID{owner, otherOwner} {
		exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'fixture-only')`, actor, account, actor.String(), actor.String()+"@fixture.invalid")
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		_, _ = db.Exec(cleanup, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{account, otherAccount})
	})
	service := &Service{Store: &Store{DB: db}, Objects: &checkpointMemoryObjects{data: make(map[string][]byte)}}
	document, err := service.Store.Create(ctx, account, owner, DocumentInput{Type: "json", Title: "Read checkpoint fixture", OperationID: uuid.New()})
	if err != nil {
		t.Fatal(err)
	}
	initialOperation := uuid.New()
	first, err := service.WriteContent(ctx, account, owner, document.ID, "panel-a", "text/plain;charset=utf-8", 0, initialOperation, []byte("a😀中"))
	if err != nil {
		t.Fatal(err)
	}
	changed, err := service.Changes(ctx, account, owner, document.ID, ChangeInput{Slot: "panel-a", BaseVersion: first.Content.Version, OperationID: uuid.New(), Edits: []Edit{{Offset: 3, DeleteCount: 1, Text: "listo"}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Run("read remains owner and account scoped", func(t *testing.T) {
		for _, scope := range [][2]uuid.UUID{{account, otherOwner}, {otherAccount, owner}} {
			if _, _, err := service.ReadContent(ctx, scope[0], scope[1], document.ID, "panel-a"); !errors.Is(err, ErrMissing) {
				t.Fatalf("cross-scope read returned %v", err)
			}
		}
	})
	t.Run("checkpoint cannot remove a materializing reader's journal", func(t *testing.T) {
		exec(`UPDATE utility_content_jobs SET available_at=NOW() WHERE account_id=$1 AND document_id=$2`, account, document.ID)
		paused := pausedReadObjects{ObjectStorage: service.Objects, entered: make(chan struct{}), resume: make(chan struct{})}
		var resumeOnce sync.Once
		resume := func() { resumeOnce.Do(func() { close(paused.resume) }) }
		defer resume()
		reader := *service
		reader.Objects = paused
		finished := make(chan error, 1)
		go func() {
			data, content, err := reader.ReadContent(ctx, account, owner, document.ID, "panel-a")
			if err == nil && (string(data) != "a😀listo" || content.Version != changed.Content.Version) {
				err = fmt.Errorf("reader returned incoherent bytes/version %d", content.Version)
			}
			finished <- err
		}()
		select {
		case <-paused.entered:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		checkpointErr := service.processContentJob(ctx)
		resume()
		var pgErr *pgconn.PgError
		if !errors.As(checkpointErr, &pgErr) || pgErr.Code != "55P03" {
			t.Fatalf("expected shared-reader lock conflict 55P03, got %v", checkpointErr)
		}
		select {
		case err := <-finished:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		var count int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM utility_changes WHERE account_id=$1 AND owner_id=$2 AND document_id=$3`, account, owner, document.ID).Scan(&count); err != nil || count != 1 {
			t.Fatal("failed checkpoint changed the journal", count, err)
		}
		exec(`UPDATE utility_content_jobs SET available_at=NOW() WHERE account_id=$1 AND document_id=$2`, account, document.ID)
		if err := service.processContentJob(ctx); err != nil {
			t.Fatal("checkpoint after reader release", err)
		}
		data, content, err := service.ReadContent(ctx, account, owner, document.ID, "panel-a")
		if err != nil || string(data) != "a😀listo" || content.SnapshotVersion != changed.Content.Version || content.Version != changed.Content.Version {
			t.Fatal("checkpoint lost bytes or version", err)
		}
		if err := db.QueryRow(ctx, `SELECT count(*) FROM utility_changes WHERE account_id=$1 AND owner_id=$2 AND document_id=$3`, account, owner, document.ID).Scan(&count); err != nil || count != 0 {
			t.Fatal("checkpoint did not compact the journal", count, err)
		}
	})
	t.Run("cancelled object read releases its shared document lock", func(t *testing.T) {
		if _, err := service.Changes(ctx, account, owner, document.ID, ChangeInput{Slot: "panel-a", BaseVersion: changed.Content.Version, OperationID: uuid.New(), Edits: []Edit{{Offset: 0, DeleteCount: 0, Text: "cancel-safe:"}}}); err != nil {
			t.Fatal(err)
		}
		paused := pausedReadObjects{ObjectStorage: service.Objects, entered: make(chan struct{}), resume: make(chan struct{})}
		reader := *service
		reader.Objects = paused
		readContext, stopRead := context.WithCancel(ctx)
		defer stopRead()
		finished := make(chan error, 1)
		go func() {
			_, _, err := reader.ReadContent(readContext, account, owner, document.ID, "panel-a")
			finished <- err
		}()
		select {
		case <-paused.entered:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		stopRead()
		select {
		case err := <-finished:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("expected cancellation, got %v", err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		// Connection cancellation can finish its server-side rollback just after
		// returning to the caller. A bounded lock probe waits for that cleanup.
		probeContext, stopProbe := context.WithTimeout(ctx, 5*time.Second)
		defer stopProbe()
		probe, err := db.Begin(probeContext)
		if err != nil {
			t.Fatal(err)
		}
		var locked uuid.UUID
		err = probe.QueryRow(probeContext, `SELECT id FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`, account, owner, document.ID).Scan(&locked)
		_ = probe.Rollback(probeContext)
		if err != nil {
			t.Fatal("cancelled read retained the document lock", err)
		}
		exec(`UPDATE utility_content_jobs SET available_at=NOW() WHERE account_id=$1 AND document_id=$2`, account, document.ID)
		if err := service.processContentJob(ctx); err != nil {
			t.Fatal("cancelled read retained the document lock", err)
		}
		data, _, err := service.ReadContent(ctx, account, owner, document.ID, "panel-a")
		if err != nil || string(data) != "cancel-safe:a😀listo" {
			t.Fatal("cancellation changed the document", err)
		}
	})
}
