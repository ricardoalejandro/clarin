package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"sync"
	"testing"
	"time"
)

func selectionActor(t *testing.T, pool *pgxpool.Pool, account uuid.UUID) uuid.UUID {
	t.Helper()
	id := uuid.New()
	logbookExec(t, pool, `INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'synthetic')`, id, account, id.String(), id.String()+"@example.invalid")
	return id
}
func TestEventSelectionFrozenTwentyThousandAndReceipt(t *testing.T) {
	pool := eventLogbookPool(t)
	f := eventLogbookFixture(t, pool)
	actor := selectionActor(t, pool, f.account)
	t.Cleanup(func() {
		logbookExec(t, pool, `DELETE FROM crm_audit_events WHERE account_id=$1`, f.account)
		logbookExec(t, pool, `DELETE FROM event_participant_selections WHERE account_id=$1`, f.account)
		logbookExec(t, pool, `DELETE FROM event_participants WHERE event_id=$1`, f.event)
	})
	repo := NewEventParticipantSelectionRepository(pool)
	ctx := context.Background()
	logbookExec(t, pool, `INSERT INTO contacts(account_id,jid,name) SELECT $1,'bulk-'||n||'@test.invalid','Bulk '||LPAD(n::text,5,'0') FROM generate_series(1,20000) n`, f.account)
	preview, err := repo.Prepare(ctx, f.account, actor, f.event, PrepareEventSelection{Mode: "filtered", Filter: EventSelectionFilter{Search: "Bulk", Membership: "available"}})
	if err != nil || preview.Selected != 20000 {
		t.Fatalf("prepare: %+v %v", preview, err)
	}
	logbookExec(t, pool, `INSERT INTO contacts(account_id,jid,name) VALUES($1,'later@test.invalid','Bulk Later')`, f.account)
	if _, err = repo.Get(ctx, f.account, uuid.New(), f.event, preview.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("actor isolation %v", err)
	}
	if _, err = repo.Get(ctx, uuid.New(), actor, f.event, preview.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("account isolation %v", err)
	}
	operation := uuid.New()
	started := time.Now()
	result, replayed, err := repo.Confirm(ctx, f.account, actor, f.event, preview.ID, operation)
	if err != nil || replayed || result.Created != 20000 || result.TotalActive != 20002 {
		t.Fatalf("confirm: %+v replay=%v err=%v", result, replayed, err)
	}
	t.Logf("20,000 contacts + audit in %s", time.Since(started))
	if time.Since(started) >= EventParticipantSelectionTimeout {
		t.Fatal("set-based write exceeded budget")
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM crm_audit_events WHERE account_id=$1 AND correlation_id=$2`, f.account, operation).Scan(&count); err != nil || count != 20000 {
		t.Fatalf("audit=%d err=%v", count, err)
	}
	logbookExec(t, pool, `UPDATE event_participant_selections SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1`, preview.ID)
	retry, replayed, err := repo.Confirm(ctx, f.account, actor, f.event, preview.ID, operation)
	if err != nil || !replayed || retry.Created != result.Created {
		t.Fatalf("lost response recovery %+v %v %v", retry, replayed, err)
	}
	if _, _, err = repo.Confirm(ctx, f.account, actor, f.event, preview.ID, uuid.New()); !errors.Is(err, ErrEventSelectionConsumed) {
		t.Fatalf("different operation consumed: %v", err)
	}
	// Reconciliation must stay bounded even before statistics catch up with
	// the just-created audience. A stale nested-loop plan took minutes here.
	candidateCtx, candidateCancel := context.WithTimeout(ctx, 15*time.Second)
	defer candidateCancel()
	started = time.Now()
	page, err := (&EventRepository{db: pool}).ListParticipantCandidates(candidateCtx, f.account, f.event, EventParticipantCandidateFilter{Search: "Bulk", Membership: "available", Limit: 50})
	if err != nil || page.Total != 1 {
		t.Fatalf("post freeze newcomer should remain available: %+v %v", page, err)
	}
	t.Logf("candidate reconciliation after 20,000 insertions in %s", time.Since(started))
}
func TestEventSelectionReactivationExclusionAndConcurrentConfirm(t *testing.T) {
	pool := eventLogbookPool(t)
	f := eventLogbookFixture(t, pool)
	actor := selectionActor(t, pool, f.account)
	t.Cleanup(func() {
		logbookExec(t, pool, `DELETE FROM crm_audit_events WHERE account_id=$1`, f.account)
		logbookExec(t, pool, `DELETE FROM event_participant_selections WHERE account_id=$1`, f.account)
		logbookExec(t, pool, `DELETE FROM event_participants WHERE event_id=$1`, f.event)
	})
	repo := NewEventParticipantSelectionRepository(pool)
	ctx := context.Background()
	var inactiveContact uuid.UUID
	logbookExec(t, pool, `UPDATE event_participants SET membership_state='inactive',membership_reason='manual_removed',notes='keep history',stage_id=$2 WHERE id=$1`, f.alpha, f.secondStage)
	if err := pool.QueryRow(ctx, `SELECT contact_id FROM event_participants WHERE id=$1`, f.alpha).Scan(&inactiveContact); err != nil {
		t.Fatal(err)
	}
	excluded := uuid.New()
	included := uuid.New()
	for _, id := range []uuid.UUID{excluded, included} {
		logbookExec(t, pool, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'New contact')`, id, f.account, id.String()+"@test.invalid")
	}
	preview, err := repo.Prepare(ctx, f.account, actor, f.event, PrepareEventSelection{Mode: "filtered", ExcludedIDs: []uuid.UUID{excluded}})
	if err != nil || preview.Selected != 2 || preview.Reactivations != 1 {
		t.Fatalf("prepare %+v %v", preview, err)
	}
	op := uuid.New()
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	created := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, _, e := repo.Confirm(ctx, f.account, actor, f.event, preview.ID, op)
			errs <- e
			if result != nil {
				created <- result.Created
			}
		}()
	}
	wg.Wait()
	close(errs)
	close(created)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	for count := range created {
		if count != 1 {
			t.Fatalf("created=%d", count)
		}
	}
	var stage uuid.UUID
	var notes string
	if err = pool.QueryRow(ctx, `SELECT stage_id,notes FROM event_participants WHERE id=$1 AND contact_id=$2`, f.alpha, inactiveContact).Scan(&stage, &notes); err != nil || stage != f.secondStage || notes != "keep history" {
		t.Fatalf("lost reactivation history stage=%v notes=%q err=%v", stage, notes, err)
	}
	var count int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM event_participants WHERE event_id=$1 AND contact_id=$2`, f.event, excluded).Scan(&count)
	if count != 0 {
		t.Fatal("excluded contact added")
	}
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM crm_audit_events WHERE account_id=$1 AND correlation_id=$2`, f.account, op).Scan(&count)
	if count != 2 {
		t.Fatalf("audit duplicated=%d", count)
	}
}
func TestEventSelectionStaleExpiryAndRollback(t *testing.T) {
	pool := eventLogbookPool(t)
	f := eventLogbookFixture(t, pool)
	actor := selectionActor(t, pool, f.account)
	t.Cleanup(func() {
		logbookExec(t, pool, `DELETE FROM crm_audit_events WHERE account_id=$1`, f.account)
		logbookExec(t, pool, `DELETE FROM event_participant_selections WHERE account_id=$1`, f.account)
		logbookExec(t, pool, `DELETE FROM event_participants WHERE event_id=$1`, f.event)
	})
	repo := NewEventParticipantSelectionRepository(pool)
	ctx := context.Background()
	contact := uuid.New()
	logbookExec(t, pool, `INSERT INTO contacts(id,account_id,jid,name,custom_name,short_name) VALUES($1,$2,'search@test.invalid','Search name','','Shortalias')`, contact, f.account)
	for _, term := range []string{"Search name", "Shortalias"} {
		page, err := (&EventRepository{db: pool}).ListParticipantCandidates(ctx, f.account, f.event, EventParticipantCandidateFilter{Search: term, Limit: 50})
		if err != nil || len(page.Candidates) != 1 {
			t.Fatalf("canonical search %q rows=%d err=%v", term, len(page.Candidates), err)
		}
	}
	req := PrepareEventSelection{Mode: "ids", ContactIDs: []uuid.UUID{contact}}
	stale, err := repo.Prepare(ctx, f.account, actor, f.event, req)
	if err != nil {
		t.Fatal(err)
	}
	logbookExec(t, pool, `UPDATE events SET rule_revision=rule_revision+1 WHERE id=$1`, f.event)
	if _, _, err = repo.Confirm(ctx, f.account, actor, f.event, stale.ID, uuid.New()); !errors.Is(err, ErrEventSelectionStale) {
		t.Fatalf("rule race: %v", err)
	}
	expiry, err := repo.Prepare(ctx, f.account, actor, f.event, req)
	if err != nil {
		t.Fatal(err)
	}
	logbookExec(t, pool, `UPDATE event_participant_selections SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1`, expiry.ID)
	if _, _, err = repo.Confirm(ctx, f.account, actor, f.event, expiry.ID, uuid.New()); !errors.Is(err, ErrEventSelectionExpired) {
		t.Fatalf("expiry: %v", err)
	}
	// A missing audit author forces a failure after the membership CTE has run.
	missingActor := uuid.New()
	broken, err := repo.Prepare(ctx, f.account, missingActor, f.event, req)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = repo.Confirm(ctx, f.account, missingActor, f.event, broken.ID, uuid.New()); err == nil {
		t.Fatal("expected audit FK error")
	}
	var count int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM event_participants WHERE event_id=$1 AND contact_id=$2`, f.event, contact).Scan(&count)
	if count != 0 {
		t.Fatal("membership survived failed audit")
	}
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM event_participant_selections WHERE id=$1 AND result IS NOT NULL`, broken.ID).Scan(&count)
	if count != 0 {
		t.Fatal("receipt survived rollback")
	}
}
