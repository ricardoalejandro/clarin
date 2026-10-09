package repository

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
)

var logbookMigrationOnce sync.Once
var logbookMigrationError error

func eventLogbookPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("EVENT_LOGBOOK_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("EVENT_LOGBOOK_TEST_DATABASE_URL required for dedicated synthetic DB")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Path != "/event_logbook_integrity_test" {
		t.Fatal("event logbook tests require exact disposable database event_logbook_integrity_test")
	}
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal("invalid integration database configuration")
	}
	cfg.ConnConfig.RuntimeParams["application_name"] = "clarin-event-logbook-integrity-test"
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal("could not connect to disposable integration database")
	}
	t.Cleanup(pool.Close)
	logbookMigrationOnce.Do(func() {
		logbookMigrationError = database.Migrate(pool)
		if logbookMigrationError == nil {
			// Match server startup; saved_filter belongs to this existing migration.
			logbookMigrationError = database.MigrateEventPipelines(pool)
		}
	})
	if logbookMigrationError != nil {
		t.Fatalf("event logbook startup migration: %v", logbookMigrationError)
	}
	return pool
}

type logbookFixture struct {
	account, event, pipeline, firstStage, secondStage, alpha, beta uuid.UUID
}

func logbookExec(t *testing.T, q interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, sql string, args ...any) {
	t.Helper()
	if _, err := q.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("synthetic logbook fixture statement: %v", err)
	}
}

func eventLogbookFixture(t *testing.T, pool *pgxpool.Pool) logbookFixture {
	t.Helper()
	f := logbookFixture{uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()}
	logbookExec(t, pool, `INSERT INTO accounts(id,name) VALUES($1,'Synthetic logbook account')`, f.account)
	t.Cleanup(func() { logbookExec(t, pool, `DELETE FROM accounts WHERE id=$1`, f.account) })
	logbookExec(t, pool, `INSERT INTO event_pipelines(id,account_id,name) VALUES($1,$2,'Synthetic pipeline')`, f.pipeline, f.account)
	logbookExec(t, pool, `INSERT INTO event_pipeline_stages(id,pipeline_id,name,color,position) VALUES($1,$2,'Invited','#123456',0),($3,$2,'Attended','#654321',1)`, f.firstStage, f.pipeline, f.secondStage)
	logbookExec(t, pool, `INSERT INTO events(id,account_id,name,status,pipeline_id) VALUES($1,$2,'Synthetic event','active',$3)`, f.event, f.account, f.pipeline)
	for i, p := range []uuid.UUID{f.alpha, f.beta} {
		contact := uuid.New()
		name := []string{"Alpha", "Beta"}[i]
		logbookExec(t, pool, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,$4)`, contact, f.account, contact.String()+"@test.invalid", name)
		logbookExec(t, pool, `INSERT INTO event_participants(id,event_id,contact_id,name,stage_id) VALUES($1,$2,$3,$4,$5)`, p, f.event, contact, name, f.firstStage)
	}
	return f
}

func createTestLogbook(t *testing.T, r *LogbookRepository, f logbookFixture, date string) *domain.EventLogbook {
	t.Helper()
	d, err := time.Parse("2006-01-02", date)
	if err != nil {
		t.Fatal(err)
	}
	lb := &domain.EventLogbook{EventID: f.event, AccountID: f.account, Date: d, Title: "Synthetic session", Status: domain.LogbookStatusPending, StageSnapshot: map[string]interface{}{}}
	if err := r.Create(context.Background(), lb); err != nil {
		t.Fatal(err)
	}
	return lb
}

func captureTestLogbook(t *testing.T, r *LogbookRepository, f logbookFixture, lb *domain.EventLogbook, filter *SnapshotFilter) *domain.EventLogbook {
	t.Helper()
	got, err := r.CaptureSnapshot(context.Background(), f.account, f.event, lb.ID, filter)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func logbookEntry(t *testing.T, lb *domain.EventLogbook, participantID uuid.UUID) *domain.EventLogbookEntry {
	t.Helper()
	for _, entry := range lb.Entries {
		if entry.ParticipantID == participantID {
			return entry
		}
	}
	t.Fatal("expected participant snapshot entry")
	return nil
}

func TestEventLogbookAccountAndHierarchyIsolation(t *testing.T) {
	pool := eventLogbookPool(t)
	r := &LogbookRepository{db: pool}
	ctx := context.Background()
	a, b := eventLogbookFixture(t, pool), eventLogbookFixture(t, pool)
	lbA := captureTestLogbook(t, r, a, createTestLogbook(t, r, a, "2026-10-10"), nil)
	lbA2 := captureTestLogbook(t, r, a, createTestLogbook(t, r, a, "2026-10-11"), nil)
	lbB := captureTestLogbook(t, r, b, createTestLogbook(t, r, b, "2026-10-10"), nil)
	entryA, entryA2, entryB := logbookEntry(t, lbA, a.alpha), logbookEntry(t, lbA2, a.alpha), logbookEntry(t, lbB, b.alpha)
	otherEvent := uuid.New()
	logbookExec(t, pool, `INSERT INTO events(id,account_id,name,status) VALUES($1,$2,'Other synthetic event','active')`, otherEvent, a.account)
	for _, tc := range []struct {
		name                           string
		account, event, logbook, entry uuid.UUID
	}{
		{"foreign entry", a.account, a.event, lbA.ID, entryB.ID},
		{"same event wrong logbook", a.account, a.event, lbA.ID, entryA2.ID},
		{"same account wrong event", a.account, otherEvent, lbA.ID, entryA.ID},
		{"foreign logbook", a.account, a.event, lbB.ID, entryB.ID},
		{"foreign account", b.account, a.event, lbA.ID, entryA.ID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := r.UpdateEntryNotes(ctx, tc.account, tc.event, tc.logbook, tc.entry, "must not persist"); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("scope mismatch should be hidden, got %v", err)
			}
		})
	}
	for _, pair := range []struct{ account, event uuid.UUID }{{b.account, a.event}, {a.account, otherEvent}} {
		if _, err := r.GetByIDForEvent(ctx, pair.account, pair.event, lbA.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("scoped read leaked logbook: %v", err)
		}
		if _, err := r.PreviewParticipants(ctx, pair.account, pair.event, lbA.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("scoped preview leaked participants: %v", err)
		}
		if err := r.Delete(ctx, pair.account, pair.event, lbA.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("scoped delete accepted wrong context: %v", err)
		}
		if _, err := r.CaptureSnapshot(ctx, pair.account, pair.event, lbA.ID, nil); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("scoped capture accepted wrong context: %v", err)
		}
		wrong := *lbA
		wrong.AccountID, wrong.EventID = pair.account, pair.event
		if _, err := r.Update(ctx, wrong.AccountID, wrong.EventID, wrong.ID, LogbookPatch{Title: &wrong.Title}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("scoped update accepted wrong context: %v", err)
		}
		if pair.account != a.account {
			if err := r.Create(ctx, &wrong); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("scoped create accepted foreign event: %v", err)
			}
			if _, err := r.AutoCreateFromDateRange(ctx, pair.event, pair.account, wrong.Date, wrong.Date.AddDate(0, 0, 1), nil); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("scoped automatic create accepted foreign event: %v", err)
			}
		}
	}
	if err := r.UpdateEntryNotes(ctx, a.account, a.event, lbA.ID, entryA.ID, "Owned note"); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		fixture  logbookFixture
		logbook  *domain.EventLogbook
		expected string
	}{{a, lbA, "Owned note"}, {a, lbA2, ""}, {b, lbB, ""}} {
		got, err := r.GetByIDForEvent(ctx, item.fixture.account, item.fixture.event, item.logbook.ID)
		if err != nil || logbookEntry(t, got, item.fixture.alpha).Notes != item.expected {
			t.Fatalf("unexpected note after scoped mutations: %v", err)
		}
	}
	// A legacy malformed entry that points at a participant in another event is
	// neither readable nor writable through the owning event context.
	corruptID := uuid.New()
	logbookExec(t, pool, `INSERT INTO event_logbook_entries(id,logbook_id,participant_id,notes) VALUES($1,$2,$3,'Retained malformed note')`, corruptID, lbA.ID, b.beta)
	if err := r.UpdateEntryNotes(ctx, a.account, a.event, lbA.ID, corruptID, "must not persist"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("participant hierarchy not enforced: %v", err)
	}
	got, err := r.GetByIDForEvent(ctx, a.account, a.event, lbA.ID)
	if err != nil || len(got.Entries) != 2 {
		t.Fatalf("malformed foreign participant leaked into entries: %v", err)
	}
}

func TestEventLogbookRecapturePreservesNotesAndConflictsAtomically(t *testing.T) {
	pool := eventLogbookPool(t)
	r := &LogbookRepository{db: pool}
	ctx := context.Background()
	f := eventLogbookFixture(t, pool)
	lb := captureTestLogbook(t, r, f, createTestLogbook(t, r, f, "2026-10-10"), nil)
	alphaID, betaID := logbookEntry(t, lb, f.alpha).ID, logbookEntry(t, lb, f.beta).ID
	if err := r.UpdateEntryNotes(ctx, f.account, f.event, lb.ID, alphaID, "Nota\nconservada"); err != nil {
		t.Fatal(err)
	}
	lb.Status = "active"
	if _, err := r.Update(ctx, f.account, f.event, lb.ID, LogbookPatch{Status: &lb.Status}); err != nil {
		t.Fatal(err)
	}
	stale := *lb
	logbookExec(t, pool, `UPDATE event_participants SET stage_id=$1 WHERE id=$2`, f.secondStage, f.alpha)
	lb = captureTestLogbook(t, r, f, lb, nil)
	alpha := logbookEntry(t, lb, f.alpha)
	if alpha.ID != alphaID || alpha.Notes != "Nota\nconservada" || alpha.StageName != "Attended" || alpha.StageColor != "#654321" || alpha.StageID == nil || *alpha.StageID != f.secondStage || logbookEntry(t, lb, f.beta).ID != betaID {
		t.Fatal("recapture changed stable entry identity/notes or failed to refresh stage")
	}
	// A metadata editor opened before capture must not overwrite newer metrics.
	stale.Title = "Edited title"
	if _, err := r.Update(ctx, f.account, f.event, lb.ID, LogbookPatch{Title: &stale.Title}); err != nil {
		t.Fatal(err)
	}
	current, err := r.GetByIDForEvent(ctx, f.account, f.event, lb.ID)
	if err != nil || !reflect.DeepEqual(current.StageSnapshot, lb.StageSnapshot) || !current.CapturedAt.Equal(*lb.CapturedAt) || current.TotalParticipants != 2 {
		t.Fatalf("metadata write overwrote canonical capture: %v", err)
	}
	before, _ := json.Marshal(current)
	for _, search := range []string{"Beta", "No matching participant"} {
		if _, err := r.CaptureSnapshot(ctx, f.account, f.event, lb.ID, &SnapshotFilter{TextSearch: search}); !errors.Is(err, ErrLogbookNotesOutsideSnapshot) {
			t.Fatalf("excluding annotated participant should conflict: %v", err)
		}
		after, err := r.GetByIDForEvent(ctx, f.account, f.event, lb.ID)
		encoded, _ := json.Marshal(after)
		if err != nil || string(before) != string(encoded) {
			t.Fatalf("conflicting recapture changed entries, notes, counts or capture timestamp: %v", err)
		}
	}
	lb = captureTestLogbook(t, r, f, lb, &SnapshotFilter{TextSearch: "Alpha"})
	if len(lb.Entries) != 1 || lb.TotalParticipants != 1 || lb.Entries[0].ID != alphaID || lb.Entries[0].Notes != "Nota\nconservada" {
		t.Fatal("excluding an unannotated participant did not retain exact selected snapshot")
	}
	if err := r.UpdateEntryNotes(ctx, f.account, f.event, lb.ID, alphaID, ""); err != nil {
		t.Fatal(err)
	}
	lb = captureTestLogbook(t, r, f, lb, &SnapshotFilter{TextSearch: "No matching participant"})
	if len(lb.Entries) != 0 || lb.TotalParticipants != 0 {
		t.Fatal("empty unannotated selection should capture empty canonical snapshot")
	}
}

func TestEventLogbookCaptureDatabaseFailureRollsBack(t *testing.T) {
	pool := eventLogbookPool(t)
	r := &LogbookRepository{db: pool}
	ctx := context.Background()
	f := eventLogbookFixture(t, pool)
	lb := captureTestLogbook(t, r, f, createTestLogbook(t, r, f, "2026-10-10"), nil)
	before, _ := json.Marshal(lb)
	logbookExec(t, pool, `UPDATE event_participants SET stage_id=$1 WHERE id=$2`, f.secondStage, f.alpha)
	// Reject the final logbook write, after both entry upserts have executed. The
	// named constraint is fixture-specific and removed before fixture cleanup.
	constraint := "logbook_capture_failure_" + uuid.New().String()[:8]
	logbookExec(t, pool, `ALTER TABLE event_logbooks ADD CONSTRAINT `+constraint+` CHECK (id <> '`+lb.ID.String()+`'::uuid OR total_participants <> 1)`)
	t.Cleanup(func() { logbookExec(t, pool, `ALTER TABLE event_logbooks DROP CONSTRAINT `+constraint) })
	if _, err := r.CaptureSnapshot(ctx, f.account, f.event, lb.ID, &SnapshotFilter{TextSearch: "Alpha"}); err == nil {
		t.Fatal("injected database failure should reject capture")
	}
	after, err := r.GetByIDForEvent(ctx, f.account, f.event, lb.ID)
	encoded, _ := json.Marshal(after)
	if err != nil || string(before) != string(encoded) {
		t.Fatalf("failed capture changed prior entries or snapshot: %v", err)
	}
}

func TestEventLogbookDatePersistenceAndCollisionRollback(t *testing.T) {
	pool := eventLogbookPool(t)
	r := &LogbookRepository{db: pool}
	ctx := context.Background()
	f := eventLogbookFixture(t, pool)
	lb := createTestLogbook(t, r, f, "2026-10-10")
	createTestLogbook(t, r, f, "2026-10-11")
	lb.Date = time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	lb.GeneralNotes = "Retained general note"
	if _, err := r.Update(ctx, f.account, f.event, lb.ID, LogbookPatch{Date: &lb.Date, GeneralNotes: &lb.GeneralNotes}); err != nil {
		t.Fatal(err)
	}
	got, err := r.GetByIDForEvent(ctx, f.account, f.event, lb.ID)
	if err != nil || got.Date.Format("2006-01-02") != "2026-10-12" || got.GeneralNotes != lb.GeneralNotes {
		t.Fatalf("date did not persist after canonical reload: %v", err)
	}
	lb.Date = time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)
	lb.GeneralNotes = "must not persist"
	var pgError *pgconn.PgError
	if _, err := r.Update(ctx, f.account, f.event, lb.ID, LogbookPatch{Date: &lb.Date, GeneralNotes: &lb.GeneralNotes}); !errors.As(err, &pgError) || pgError.Code != "23505" {
		t.Fatalf("duplicate date should produce typed conflict: %v", err)
	}
	after, err := r.GetByIDForEvent(ctx, f.account, f.event, lb.ID)
	if err != nil || after.Date.Format("2006-01-02") != "2026-10-12" || after.GeneralNotes != "Retained general note" {
		t.Fatalf("duplicate date changed prior canonical data: %v", err)
	}
	for _, invalid := range []domain.EventLogbook{{AccountID: f.account, EventID: f.event, Status: "active"}, {AccountID: f.account, EventID: f.event, Date: got.Date, Status: "invalid"}} {
		if err := r.Create(ctx, &invalid); !errors.Is(err, ErrLogbookInvalid) {
			t.Fatalf("invalid logbook accepted: %v", err)
		}
	}
}

func TestEventLogbookPatchKeepsConcurrentCaptureAndOtherEdits(t *testing.T) {
	pool := eventLogbookPool(t)
	r := &LogbookRepository{db: pool}
	ctx := context.Background()
	f := eventLogbookFixture(t, pool)
	pending := createTestLogbook(t, r, f, "2026-10-10")
	// Simulate two editors opening the pending logbook, then a snapshot landing
	// before either metadata save. A title-only save cannot restore pending.
	staleTitle := pending.Title + " changed"
	captured := captureTestLogbook(t, r, f, pending, nil)
	notes := "Latest note"
	filter := json.RawMessage(`{"text_search":"Alpha"}`)
	if _, err := r.Update(ctx, f.account, f.event, pending.ID, LogbookPatch{GeneralNotes: &notes, SavedFilterPresent: true, SavedFilter: filter}); err != nil {
		t.Fatal(err)
	}
	after, err := r.Update(ctx, f.account, f.event, pending.ID, LogbookPatch{Title: &staleTitle})
	if err != nil {
		t.Fatal(err)
	}
	var saved SnapshotFilter
	if err := json.Unmarshal(after.SavedFilter, &saved); err != nil {
		t.Fatal(err)
	}
	if after.Status != "completed" || after.GeneralNotes != notes || saved.TextSearch != "Alpha" || after.TotalParticipants != 2 || !reflect.DeepEqual(after.StageSnapshot, captured.StageSnapshot) || !after.CapturedAt.Equal(*captured.CapturedAt) {
		t.Fatalf("title-only edit overwrote concurrent notes, filter or capture: %v", err)
	}
	// Explicit null clears the filter while a later omitted filter keeps it clear.
	if _, err := r.Update(ctx, f.account, f.event, pending.ID, LogbookPatch{SavedFilterPresent: true}); err != nil {
		t.Fatal(err)
	}
	emptyNotes := ""
	after, err = r.Update(ctx, f.account, f.event, pending.ID, LogbookPatch{GeneralNotes: &emptyNotes})
	if err != nil || len(after.SavedFilter) != 0 || after.GeneralNotes != "" || after.Title != staleTitle || after.Status != "completed" {
		t.Fatalf("explicit clear and omitted fields lost patch semantics: %v", err)
	}
}

func TestEventLogbookClosedEventPreservesReadableHistory(t *testing.T) {
	pool := eventLogbookPool(t)
	r := &LogbookRepository{db: pool}
	ctx := context.Background()
	for _, status := range []string{domain.EventStatusCompleted, domain.EventStatusCancelled} {
		t.Run(status, func(t *testing.T) {
			f := eventLogbookFixture(t, pool)
			lb := captureTestLogbook(t, r, f, createTestLogbook(t, r, f, "2026-10-10"), nil)
			entryID := logbookEntry(t, lb, f.alpha).ID
			logbookExec(t, pool, `UPDATE events SET status=$1 WHERE id=$2`, status, f.event)
			before, _ := json.Marshal(lb)
			writes := []struct {
				name string
				run  func() error
			}{
				{"create", func() error {
					return r.Create(ctx, &domain.EventLogbook{AccountID: f.account, EventID: f.event, Date: lb.Date.AddDate(0, 0, 1), Status: "pending"})
				}},
				{"update", func() error {
					title := "must not persist"
					_, err := r.Update(ctx, f.account, f.event, lb.ID, LogbookPatch{Title: &title})
					return err
				}},
				{"delete", func() error { return r.Delete(ctx, f.account, f.event, lb.ID) }},
				{"capture", func() error { _, err := r.CaptureSnapshot(ctx, f.account, f.event, lb.ID, nil); return err }},
				{"entry notes", func() error { return r.UpdateEntryNotes(ctx, f.account, f.event, lb.ID, entryID, "must not persist") }},
				{"date range", func() error {
					_, err := r.AutoCreateFromDateRange(ctx, f.event, f.account, lb.Date.AddDate(0, 0, 1), lb.Date.AddDate(0, 0, 2), nil)
					return err
				}},
			}
			for _, write := range writes {
				if err := write.run(); !errors.Is(err, ErrEventMembershipFrozen) {
					t.Fatalf("%s allowed on %s event: %v", write.name, status, err)
				}
			}
			after, err := r.GetByIDForEvent(ctx, f.account, f.event, lb.ID)
			encoded, _ := json.Marshal(after)
			if err != nil || string(before) != string(encoded) {
				t.Fatalf("closed event history changed or became unreadable: %v", err)
			}
			list, err := r.GetByEventIDForAccount(ctx, f.account, f.event)
			if err != nil || len(list) != 1 {
				t.Fatalf("closed event logbook list unavailable: %v", err)
			}
			if _, err := r.PreviewParticipants(ctx, f.account, f.event, lb.ID); err != nil {
				t.Fatalf("closed event history preview unavailable: %v", err)
			}
		})
	}
}

func TestEventLogbookConcurrentClosureRevalidatesAfterLock(t *testing.T) {
	pool := eventLogbookPool(t)
	r := &LogbookRepository{db: pool}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	f := eventLogbookFixture(t, pool)
	lb := captureTestLogbook(t, r, f, createTestLogbook(t, r, f, "2026-10-10"), nil)
	entryID := logbookEntry(t, lb, f.alpha).ID
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	logbookExec(t, tx, `UPDATE events SET status='completed' WHERE id=$1`, f.event)
	result := make(chan error, 1)
	go func() { result <- r.UpdateEntryNotes(ctx, f.account, f.event, lb.ID, entryID, "must not persist") }()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='clarin-event-logbook-integrity-test' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%FROM events%FOR UPDATE%')`).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("expected event lifecycle row lock was not observed")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, ErrEventMembershipFrozen) {
		t.Fatalf("mutation bypassed closure after lock wait: %v", err)
	}
	after, err := r.GetByIDForEvent(ctx, f.account, f.event, lb.ID)
	if err != nil || logbookEntry(t, after, f.alpha).Notes != "" {
		t.Fatalf("blocked mutation changed notes: %v", err)
	}
}
