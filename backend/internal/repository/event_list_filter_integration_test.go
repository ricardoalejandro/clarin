package repository

import (
	"context"
	"github.com/google/uuid"
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

func TestEventListStageIdentityAndGlobalSort(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	pipeline := uuid.New()
	first := uuid.New()
	second := uuid.New()
	event := uuid.New()
	integrityExec(t, pool, `INSERT INTO event_pipelines(id,account_id,name) VALUES($1,$2,'Summary fixture')`, pipeline, f.account)
	integrityExec(t, pool, `INSERT INTO event_pipeline_stages(id,pipeline_id,name,color,position) VALUES($1,$3,'Igual','#334455',0),($2,$3,'Igual','#556677',1)`, first, second, pipeline)
	integrityExec(t, pool, `INSERT INTO events(id,account_id,pipeline_id,name,status) VALUES($1,$2,$3,'Zulu','active')`, event, f.account, pipeline)
	integrityExec(t, pool, `INSERT INTO events(account_id,name,status) SELECT $1,'Alpha '||n,'active' FROM generate_series(1,55)n`, f.account)
	integrityExec(t, pool, `INSERT INTO event_participants(event_id,name,stage_id,membership_state) VALUES($1,'One',$2,'active'),($1,'Two',$3,'active'),($1,'Three',NULL,'active'),($1,'Inactive',$2,'inactive')`, event, first, second)
	repo := &EventRepository{db: pool}
	list, total, err := repo.GetByAccountID(context.Background(), f.account, domain.EventFilter{Limit: 1, SortBy: "participants", SortDirection: "desc"})
	if err != nil || total != 56 || len(list) != 1 {
		t.Fatalf("list summary: total=%d err=%v", total, err)
	}
	got := list[0]
	if got.ID != event || got.TotalParticipants != 3 || len(got.StageSummary) != 3 {
		t.Fatalf("global participant order or summary failed: %+v", got)
	}
	if got.StageSummary[0].ID == nil || *got.StageSummary[0].ID != first || got.StageSummary[1].ID == nil || *got.StageSummary[1].ID != second || got.StageSummary[2].ID != nil {
		t.Fatal("stage identities/name collision/unassigned lost")
	}
	for _, stage := range got.StageSummary {
		if stage.Count != 1 {
			t.Fatal("inactive participant counted")
		}
	}
	list, _, err = repo.GetByAccountID(context.Background(), f.account, domain.EventFilter{Limit: 1, Offset: 55, SortBy: "name", SortDirection: "asc"})
	if err != nil || len(list) != 1 || list[0].ID != event {
		t.Fatal("sort not applied to full data before paging", err)
	}
}
