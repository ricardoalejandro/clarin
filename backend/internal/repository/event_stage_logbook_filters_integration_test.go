package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestEventStageLayoutRemapsSavedFiltersAndPreservesCapturedHistory(t *testing.T) {
	pool := eventLogbookPool(t)
	ctx := context.Background()
	f := eventLogbookFixture(t, pool)
	foreign := eventLogbookFixture(t, pool)
	actor := selectionActor(t, pool, f.account)
	books := &LogbookRepository{db: pool}
	stages := &EventPipelineRepository{db: pool}
	makeBook := func(fixture logbookFixture, date, stageIDs string) *domain.EventLogbook {
		lb := createTestLogbook(t, books, fixture, date)
		if stageIDs != "" {
			raw, _ := json.Marshal(SnapshotFilter{StageIDs: stageIDs, TagMode: "OR"})
			var err error
			lb, err = books.Update(ctx, fixture.account, fixture.event, lb.ID, LogbookPatch{ExpectedVersion: lb.Version, SavedFilterPresent: true, SavedFilter: raw})
			if err != nil {
				t.Fatal(err)
			}
		}
		return lb
	}
	pending := makeBook(f, "2026-10-10", f.firstStage.String()+",unassigned,"+strings.ToUpper(f.firstStage.String()))
	active := captureTestLogbook(t, books, f, makeBook(f, "2026-10-11", f.firstStage.String()), nil)
	note := "Nota histórica conservada"
	if err := books.UpdateEntryNotes(ctx, f.account, f.event, active.ID, active.Entries[0].ID, note); err != nil {
		t.Fatal(err)
	}
	var err error
	active, err = books.GetByIDForEvent(ctx, f.account, f.event, active.ID)
	if err != nil {
		t.Fatal(err)
	}
	completed := captureTestLogbook(t, books, f, makeBook(f, "2026-10-12", f.firstStage.String()), nil)
	completed, err = books.Transition(ctx, f.account, f.event, completed.ID, "complete", LogbookWriteOptions{ExpectedVersion: completed.Version, ActorID: &actor})
	if err != nil {
		t.Fatal(err)
	}
	unfiltered := makeBook(f, "2026-10-13", "")
	unknownStage := uuid.NewString()
	unmatched := makeBook(f, "2026-10-14", unknownStage)
	other := f
	other.event = uuid.New()
	logbookExec(t, pool, `INSERT INTO events(id,account_id,name,status,pipeline_id) VALUES($1,$2,'Other event','active',$3)`, other.event, f.account, f.pipeline)
	otherBook := makeBook(other, "2026-10-10", f.firstStage.String())
	foreignBook := makeBook(foreign, "2026-10-10", f.firstStage.String())
	history := func(lb *domain.EventLogbook) string {
		raw, _ := json.Marshal([]any{lb.CapturedFilter, lb.StageSnapshot, lb.Entries, lb.Status, lb.CapturedAt, lb.TotalParticipants})
		return string(raw)
	}
	historical := map[uuid.UUID]string{active.ID: history(active), completed.ID: history(completed)}
	input := fixtureStageLayout(f)
	missingActor := uuid.New()
	input.ActorID = &missingActor
	if _, err = stages.SaveEventStageLayout(ctx, f.account, f.event, input); err == nil {
		t.Fatal("missing audit author must roll back the stage transaction")
	}
	unchanged, err := books.Summary(ctx, f.account, f.event, pending.ID)
	if err != nil || unchanged.Version != pending.Version || string(unchanged.SavedFilter) != string(pending.SavedFilter) {
		t.Fatalf("failed audit changed saved filter: %v", err)
	}
	var pipeline uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT pipeline_id FROM events WHERE id=$1`, f.event).Scan(&pipeline); err != nil || pipeline != f.pipeline {
		t.Fatalf("failed audit changed pipeline: %v", err)
	}
	input.ActorID = &actor
	saved, err := stages.SaveEventStageLayout(ctx, f.account, f.event, input)
	if err != nil {
		t.Fatal(err)
	}
	if saved.LogbooksRemapped != 3 {
		t.Fatalf("remapped=%d", saved.LogbooksRemapped)
	}
	first := saved.StageIDMap[f.firstStage.String()]
	second := saved.StageIDMap[f.secondStage.String()]
	if first == "" || second == "" {
		t.Fatal("expected copy-on-write stage mapping")
	}
	for _, original := range []*domain.EventLogbook{pending, active, completed} {
		got, err := books.GetByIDForEvent(ctx, f.account, f.event, original.ID)
		if err != nil {
			t.Fatal(err)
		}
		filter, err := savedSnapshotFilter(got.SavedFilter)
		expected := first
		if original.ID == pending.ID {
			expected += ",unassigned"
		}
		if err != nil || filter.StageIDs != expected || filter.TagMode != "OR" || got.Version != original.Version+1 {
			t.Fatalf("incorrect operational remap: %#v %v", filter, err)
		}
		if previous, ok := historical[original.ID]; ok && history(got) != previous {
			t.Fatalf("captured history changed for %s", original.ID)
		}
		var audited int
		err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM event_logbook_actions WHERE account_id=$1 AND event_id=$2 AND logbook_id=$3 AND action='stage_filters_remapped' AND actor_id=$4 AND version=$5`, f.account, f.event, original.ID, actor, got.Version).Scan(&audited)
		if err != nil || audited != 1 {
			t.Fatalf("missing versioned audit: %d %v", audited, err)
		}
	}
	for _, item := range []struct {
		f  logbookFixture
		lb *domain.EventLogbook
	}{{f, unfiltered}, {f, unmatched}, {other, otherBook}, {foreign, foreignBook}} {
		got, err := books.Summary(ctx, item.f.account, item.f.event, item.lb.ID)
		if err != nil || got.Version != item.lb.Version || string(got.SavedFilter) != string(item.lb.SavedFilter) {
			t.Fatalf("unrelated or unmapped filter changed: %v", err)
		}
	}
	title := "Stale edit"
	if _, err = books.Update(ctx, f.account, f.event, pending.ID, LogbookPatch{ExpectedVersion: pending.Version, Title: &title}); !errors.Is(err, ErrLogbookVersion) {
		t.Fatalf("stale editor should conflict: %v", err)
	}
	preview, err := books.PreviewPage(ctx, f.account, f.event, pending.ID, LogbookPageOptions{})
	if err != nil || preview.Total != 2 {
		t.Fatalf("copy-on-write lost audience: %#v %v", preview, err)
	}
	// Deleting an operational stage maps its saved audience to the actual target.
	input = EventStageLayoutInput{ExpectedRevision: &saved.Revision, ActorID: &actor, Stages: []EventStageDraftInput{{ID: second, Name: "Asistieron", Color: "#654321"}}, Deletions: []EventStageDeletionInput{{ID: first, MoveTo: EventStageDestination{Kind: "stage", ID: second}}}}
	saved, err = stages.SaveEventStageLayout(ctx, f.account, f.event, input)
	if err != nil || saved.LogbooksRemapped != 3 {
		t.Fatalf("deletion remap: %#v %v", saved, err)
	}
	got, err := books.GetByIDForEvent(ctx, f.account, f.event, active.ID)
	if err != nil || history(got) != historical[active.ID] {
		t.Fatalf("stage deletion rewrote historical capture: %v", err)
	}
	filter, err := savedSnapshotFilter(got.SavedFilter)
	if err != nil || filter.StageIDs != second {
		t.Fatalf("deleted audience not transferred: %#v %v", filter, err)
	}
	preview, err = books.PreviewPage(ctx, f.account, f.event, pending.ID, LogbookPageOptions{})
	if err != nil || preview.Total != 2 {
		t.Fatalf("stage transfer lost audience: %#v %v", preview, err)
	}
}
