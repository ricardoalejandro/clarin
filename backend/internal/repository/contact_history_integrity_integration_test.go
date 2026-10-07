package repository

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestContactHistoryIntegrityPaginationAndOldMutation(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	repo := NewRepositories(pool).ContactProfile
	ctx := context.Background()
	page, err := repo.ListObservationPage(ctx, f.account, f.contact, f.user, false, 50, 0, "", "chat:synthetic")
	if err != nil || len(page.Observations) != 0 || page.HasMore {
		t.Fatalf("empty history: %+v %v", page, err)
	}
	for _, amount := range []int{50, 51, 205} {
		integrityExec(t, pool, `DELETE FROM interactions WHERE account_id=$1`, f.account)
		integrityExec(t, pool, `INSERT INTO interactions(account_id,contact_id,type,notes,created_by,created_at,updated_at)
		 SELECT $1,$2,'note','Synthetic history note '||n,$3,'2026-10-01'::timestamptz+n*interval '1 second','2026-10-01'::timestamptz+n*interval '1 second' FROM generate_series(1,$4::int) n`, f.account, f.contact, f.user, amount)
		seen := map[uuid.UUID]bool{}
		cursor := ""
		for {
			page, err = repo.ListObservationPage(ctx, f.account, f.contact, f.user, false, 50, 0, cursor, "chat:synthetic")
			if err != nil {
				t.Fatal(err)
			}
			for _, note := range page.Observations {
				if seen[note.ID] {
					t.Fatal("duplicated history item across pages")
				}
				seen[note.ID] = true
				if !note.CanPin || !note.CanEdit || !note.CanDelete {
					t.Fatal("author capabilities missing")
				}
			}
			if !page.HasMore {
				if page.NextCursor != "" {
					t.Fatal("final page cursor retained")
				}
				break
			}
			if len(page.Observations) != 50 || page.NextCursor == "" {
				t.Fatal("page contract invalid")
			}
			cursor = page.NextCursor
		}
		if len(seen) != amount {
			t.Fatalf("history cardinality=%d want%d", len(seen), amount)
		}
	}
	var oldID uuid.UUID
	var expected time.Time
	if err = pool.QueryRow(ctx, `SELECT id,updated_at FROM interactions WHERE account_id=$1 ORDER BY created_at ASC LIMIT 1`, f.account).Scan(&oldID, &expected); err != nil {
		t.Fatal(err)
	}
	updated, err := repo.UpdateObservation(ctx, f.account, f.contact, oldID, f.user, false, "Updated oldest note", expected)
	if err != nil || updated == nil || updated.ID != oldID || updated.Notes == nil || *updated.Notes != "Updated oldest note" {
		t.Fatalf("oldest note update falsely missing: %v", err)
	}
	pinned, err := repo.PinObservation(ctx, f.account, f.contact, oldID, f.user, false, true)
	if err != nil || pinned.PinnedAt == nil {
		t.Fatalf("pin oldest note: %v", err)
	}
	again, err := repo.PinObservation(ctx, f.account, f.contact, oldID, f.user, false, true)
	if err != nil || again.PinnedAt == nil || !again.PinnedAt.Equal(*pinned.PinnedAt) {
		t.Fatal("repeated pin changes canonical position")
	}
	if total, err := repo.CountPinnedObservations(ctx, f.account, f.contact); err != nil || total != 1 {
		t.Fatal("repeated pin changed count")
	}
	if _, err = repo.PinObservation(ctx, f.account, f.contact, oldID, f.user, false, false); err != nil {
		t.Fatal(err)
	}
	if total, err := repo.CountPinnedObservations(ctx, f.account, f.contact); err != nil || total != 0 {
		t.Fatal("zero pinned count missing")
	}
	if _, err = repo.UpdateObservation(ctx, uuid.New(), f.contact, oldID, f.user, true, "Wrong account", updated.UpdatedAt); err != ErrContactProfileObservationMissing {
		t.Fatal("cross-account update accepted")
	}
	if _, err = repo.PinObservation(ctx, f.account, f.contact, oldID, uuid.New(), false, true); err != ErrContactProfileObservationForbidden {
		t.Fatal("non-author pin accepted")
	}
	if rows, err := repo.ListObservations(ctx, f.account, f.contact, f.user, false, 200, 200); err != nil || len(rows) != 5 {
		t.Fatal("legacy offset compatibility lost")
	}
}
