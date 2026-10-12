package repository

import (
	"context"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestEventListExcludesCancelledBeforeCountAndPagination(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	other := integrityProgram(t, pool)
	integrityExec(t, pool, `INSERT INTO events(account_id,name,status,created_at) SELECT $1,'Cancelled fixture','cancelled',NOW() FROM generate_series(1,55)`, f.account)
	integrityExec(t, pool, `INSERT INTO events(account_id,name,status,created_at) VALUES($1,'Active fixture','active',NOW()-INTERVAL '1 day'),($1,'Draft fixture','draft',NOW()-INTERVAL '2 days'),($1,'Completed fixture','completed',NOW()-INTERVAL '3 days'),($2,'Foreign fixture','active',NOW())`, f.account, other.account)
	repo := &EventRepository{db: pool}
	ctx := context.Background()
	filter := domain.EventFilter{ExcludeCancelled: true, FolderFilter: "root", Limit: 2}
	first, total, err := repo.GetByAccountID(ctx, f.account, filter)
	if err != nil || total != 3 || len(first) != 2 {
		t.Fatalf("first page: rows=%d total=%d err=%v", len(first), total, err)
	}
	for _, event := range first {
		if event.AccountID != f.account || event.Status == "cancelled" {
			t.Fatalf("ineligible row: %v", event.ID)
		}
	}
	filter.Offset = 2
	last, total, err := repo.GetByAccountID(ctx, f.account, filter)
	if err != nil || total != 3 || len(last) != 1 || last[0].ID == first[0].ID || last[0].ID == first[1].ID {
		t.Fatalf("last page: rows=%d total=%d err=%v", len(last), total, err)
	}
	filter.Status, filter.Offset = "cancelled", 0
	cancelled, total, err := repo.GetByAccountID(ctx, f.account, filter)
	if err != nil || total != 55 || len(cancelled) != 2 {
		t.Fatalf("explicit cancellation status: rows=%d total=%d err=%v", len(cancelled), total, err)
	}
	filter.Status, filter.ExcludeCancelled = "", false
	_, total, err = repo.GetByAccountID(ctx, f.account, filter)
	if err != nil || total != 58 {
		t.Fatalf("inclusive total=%d err=%v", total, err)
	}
}
