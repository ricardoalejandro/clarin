package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func TestGroupProjectionPostgresIdentitySessionFence(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	f := integrityProgram(t, db)
	repo := NewRepositories(db).Chat
	device, otherDevice := uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{device, otherDevice} {
		integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic session fence','connected')`, id, f.account)
		if _, err := repo.EnsureWhatsAppIdentitySession(ctx, f.account, id, "synthetic-group-a"); err != nil {
			t.Fatal(err)
		}
	}
	chat, err := repo.GetOrCreateGroup(ctx, f.account, device, "120099900000042@g.us", "Synthetic fence")
	if err != nil {
		t.Fatal(err)
	}
	otherChat, err := repo.GetOrCreateGroup(ctx, f.account, otherDevice, chat.JID, "Synthetic other device")
	if err != nil {
		t.Fatal(err)
	}
	group := &domain.ChatGroup{Subject: "Synthetic fence", MembershipStatus: "member", Kind: "group"}
	members := []domain.GroupParticipant{{JID: "700042@lid", Name: "Synthetic participant", NameSource: "push_name", Role: "member"}}
	for _, target := range []struct{ device, chat uuid.UUID }{{device, chat.ID}, {otherDevice, otherChat.ID}} {
		if err = repo.SaveGroupForIdentitySession(ctx, f.account, target.device, target.chat, group, members, "synthetic-group-a"); err != nil {
			t.Fatal("current session save", err)
		}
	}
	assertProjection := func(chatID uuid.UUID, status string, count int) {
		t.Helper()
		var actual string
		var participants int
		if queryErr := db.QueryRow(ctx, `SELECT membership_status,jsonb_array_length(participants) FROM chat_groups WHERE account_id=$1 AND chat_id=$2`, f.account, chatID).Scan(&actual, &participants); queryErr != nil || actual != status || participants != count {
			t.Fatalf("projection changed unexpectedly: status=%s count=%d err=%v", actual, participants, queryErr)
		}
	}
	if err = repo.SaveGroupForIdentitySession(ctx, f.account, otherDevice, chat.ID, group, members, "synthetic-group-a"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("another device's chat accepted", err)
	}
	if err = repo.SaveGroupForIdentitySession(ctx, uuid.New(), device, chat.ID, group, members, "synthetic-group-a"); !errors.Is(err, ErrWhatsAppIdentitySessionChanged) {
		t.Fatal("foreign account accepted", err)
	}
	if err = repo.ReconcileJoinedGroupsForIdentitySession(ctx, f.account, device, []string{}, ""); !errors.Is(err, ErrWhatsAppIdentitySessionChanged) {
		t.Fatal("missing session accepted", err)
	}
	// Both late operations block behind the same barrier as session replacement.
	// Complete the replacement's protected writes before releasing that barrier;
	// the stale responses must then recheck the committed fingerprint.
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = lockWhatsAppIdentityScope(ctx, tx, f.account, device); err != nil {
		t.Fatal(err)
	}
	lateSave := make(chan error, 1)
	go func() {
		lateSave <- repo.SaveGroupForIdentitySession(ctx, f.account, device, chat.ID, group, members, "synthetic-group-a")
	}()
	waitIntegrityLock(t, db, "pg_advisory_xact_lock")
	lateReconcile := make(chan error, 1)
	go func() {
		lateReconcile <- repo.ReconcileJoinedGroupsForIdentitySession(ctx, f.account, device, []string{}, "synthetic-group-a")
	}()
	integrityExec(t, tx, `UPDATE whatsapp_identity_scopes SET session_fingerprint='synthetic-group-b',session_generation=session_generation+1,session_started_at=NOW() WHERE account_id=$1 AND device_id=$2`, f.account, device)
	integrityExec(t, tx, `UPDATE chat_groups SET participants='[]'::jsonb,membership_status='unknown' WHERE account_id=$1 AND chat_id=$2`, f.account, chat.ID)
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for _, outcome := range []<-chan error{lateSave, lateReconcile} {
		if err = <-outcome; !errors.Is(err, ErrWhatsAppIdentitySessionChanged) {
			t.Fatal("late response crossed replacement barrier", err)
		}
	}
	assertProjection(chat.ID, "unknown", 0)
	assertProjection(otherChat.ID, "member", 1)
	if err = repo.SaveGroupForIdentitySession(ctx, f.account, device, chat.ID, group, members, "synthetic-group-b"); err != nil {
		t.Fatal("replacement session could not save", err)
	}
	if err = repo.ReconcileJoinedGroupsForIdentitySession(ctx, f.account, device, []string{chat.JID}, "synthetic-group-b"); err != nil {
		t.Fatal("joined group reconciliation failed", err)
	}
	assertProjection(chat.ID, "member", 1)
	if err = repo.ReconcileJoinedGroupsForIdentitySession(ctx, f.account, device, []string{}, "synthetic-group-b"); err != nil {
		t.Fatal("current session reconciliation failed", err)
	}
	assertProjection(chat.ID, "left", 1)
	assertProjection(otherChat.ID, "member", 1)
}
