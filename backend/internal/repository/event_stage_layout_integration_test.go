package repository

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func fixtureStageLayout(f logbookFixture) EventStageLayoutInput {
	return EventStageLayoutInput{ExpectedRevision: stageRevision(0), Stages: []EventStageDraftInput{{ID: f.firstStage.String(), Name: "Invitados", Color: "#123456"}, {ID: f.secondStage.String(), Name: "Asistieron", Color: "#654321"}}}
}
func TestEventStageLayoutTransactionIsolationAndConflict(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := eventLogbookFixture(t, pool)
	r := &EventPipelineRepository{db: pool}
	original := fixtureStageLayout(f)
	if _, err := r.GetEventStageLayout(context.Background(), uuid.New(), f.event); err == nil {
		t.Fatal("other account read permitted")
	}
	if _, err := r.SaveEventStageLayout(context.Background(), uuid.New(), f.event, original); err == nil {
		t.Fatal("other account write permitted")
	}
	original.Stages[0].Color = "#abcdef"
	saved, err := r.SaveEventStageLayout(context.Background(), f.account, f.event, original)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 1 || saved.Stages[0].Color != "#ABCDEF" || saved.Stages[0].ParticipantCount != 2 {
		t.Fatalf("unexpected canonical result: %#v", saved)
	}
	if _, err = r.SaveEventStageLayout(context.Background(), f.account, f.event, original); !errors.Is(err, ErrEventStageLayoutConflict) {
		t.Fatalf("expected revision conflict: %v", err)
	}
	logbookExec(t, pool, `UPDATE events SET status='completed' WHERE id=$1`, f.event)
	original.ExpectedRevision = stageRevision(1)
	if _, err = r.SaveEventStageLayout(context.Background(), f.account, f.event, original); !errors.Is(err, ErrEventMembershipFrozen) {
		t.Fatalf("closed event write: %v", err)
	}
}
func TestEventStageLayoutCopyOnWriteIsAtomic(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := eventLogbookFixture(t, pool)
	r := &EventPipelineRepository{db: pool}
	other := uuid.New()
	logbookExec(t, pool, `INSERT INTO events(id,account_id,name,status,pipeline_id) VALUES($1,$2,'Other event','active',$3)`, other, f.account, f.pipeline)
	input := fixtureStageLayout(f)
	input.Stages = input.Stages[1:] // Omission must not allocate a local pipeline.
	if _, err := r.SaveEventStageLayout(context.Background(), f.account, f.event, input); !errors.Is(err, ErrEventStageLayoutConflict) {
		t.Fatalf("incomplete draft: %v", err)
	}
	var pipeline uuid.UUID
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT pipeline_id FROM events WHERE id=$1`, f.event).Scan(&pipeline); err != nil {
		t.Fatal(err)
	}
	if pipeline != f.pipeline {
		t.Fatal("invalid draft changed pipeline")
	}
	if err := pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM event_pipelines WHERE account_id=$1`, f.account).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("invalid draft leaked a pipeline")
	}
	input = fixtureStageLayout(f)
	input.Stages = []EventStageDraftInput{input.Stages[1], {ClientID: "draft-new", Name: "Seguimiento", Color: "#ABCDEF"}}
	input.Deletions = []EventStageDeletionInput{{ID: f.firstStage.String(), MoveTo: EventStageDestination{Kind: "client", ID: "draft-new"}}}
	saved, err := r.SaveEventStageLayout(context.Background(), f.account, f.event, input)
	if err != nil {
		t.Fatal(err)
	}
	if *saved.PipelineID == f.pipeline || saved.StageIDMap["draft-new"] == "" {
		t.Fatal("missing dedicated pipeline/client resolution")
	}
	var target uuid.UUID
	if err = pool.QueryRow(context.Background(), `SELECT stage_id FROM event_participants WHERE id=$1`, f.alpha).Scan(&target); err != nil {
		t.Fatal(err)
	}
	if target.String() != saved.StageIDMap["draft-new"] || saved.StageIDMap[f.firstStage.String()] != target.String() {
		t.Fatal("participants not reassigned to new stage")
	}
	if err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM event_pipeline_stages WHERE pipeline_id=$1`, f.pipeline).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatal("shared event stages changed")
	}
}
func TestEventStageLayoutConcurrentEditorsOnlyOneWins(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := eventLogbookFixture(t, pool)
	r := &EventPipelineRepository{db: pool}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := r.SaveEventStageLayout(context.Background(), f.account, f.event, fixtureStageLayout(f))
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	success, conflict := 0, 0
	for err := range errs {
		if err == nil {
			success++
		} else if errors.Is(err, ErrEventStageLayoutConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
}

func TestEventStageLayoutReferencedTemplateCannotBeReplaced(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := eventLogbookFixture(t, pool)
	r := &EventPipelineRepository{db: pool}
	stages := []*domain.EventPipelineStage{{Name: "New stage", Color: "#ABCDEF"}}
	if err := r.ReplaceUnusedStageTemplate(context.Background(), f.account, f.pipeline, stages); !errors.Is(err, ErrEventStageTemplateInUse) {
		t.Fatalf("referenced template: %v", err)
	}
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM event_pipeline_stages WHERE pipeline_id=$1`, f.pipeline).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatal("referenced stages changed")
	}
	unused := uuid.New()
	logbookExec(t, pool, `INSERT INTO event_pipelines(id,account_id,name) VALUES($1,$2,'Unused template')`, unused, f.account)
	if err := r.ReplaceUnusedStageTemplate(context.Background(), uuid.New(), unused, stages); err == nil {
		t.Fatal("cross-account template mutation")
	}
	if err := r.ReplaceUnusedStageTemplate(context.Background(), f.account, unused, stages); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM event_pipeline_stages WHERE pipeline_id=$1`, unused).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("unused template not configured")
	}
}

func TestEventStageLayoutPreservesProgramSharedTemplate(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := eventLogbookFixture(t, pool)
	r := &EventPipelineRepository{db: pool}
	program := uuid.New()
	logbookExec(t, pool, "INSERT INTO programs(id,account_id,type,name,status,pipeline_id) VALUES($1,$2,'course','Synthetic shared program','active',$3)", program, f.account, f.pipeline)
	input := fixtureStageLayout(f)
	input.Stages[0].Name = "Changed only in event"
	saved, err := r.SaveEventStageLayout(context.Background(), f.account, f.event, input)
	if err != nil {
		t.Fatal(err)
	}
	if *saved.PipelineID == f.pipeline {
		t.Fatal("event changed program shared template")
	}
	var name string
	if err := pool.QueryRow(context.Background(), "SELECT name FROM event_pipeline_stages WHERE id=$1", f.firstStage).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name == input.Stages[0].Name {
		t.Fatal("program stage was renamed")
	}
}
