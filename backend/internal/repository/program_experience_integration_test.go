package repository

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
)

func TestProgramExperienceMigrationIsRepeatable(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	if err := database.Migrate(pool); err != nil {
		t.Fatalf("second startup migration: %v", err)
	}
}

func TestProgramLifecycleRoundtripPreservesOriginAndParticipation(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	participant := integrityParticipant(t, pool, f)
	r := &ProgramRepository{db: pool}
	ctx := context.Background()
	p, err := r.GetByID(ctx, f.account, f.program)
	if err != nil {
		t.Fatal(err)
	}
	initial := p.UpdatedAt
	p.Status = "completed"
	if err = r.Update(ctx, p); !errors.Is(err, ErrProgramLifecycleVersionRequired) {
		t.Fatalf("unversioned conclusion: %v", err)
	}
	p.ExpectedUpdatedAt = &initial
	if err = r.Update(ctx, p); err != nil {
		t.Fatal(err)
	}
	p.Status = "archived"
	version := p.UpdatedAt
	p.ExpectedUpdatedAt = &version
	if err = r.Update(ctx, p); err != nil || p.ArchivedFromStatus == nil || *p.ArchivedFromStatus != "completed" {
		t.Fatalf("archive: %#v %v", p, err)
	}
	p.Status = "active"
	version = p.UpdatedAt
	if err = r.Update(ctx, p); err != nil || p.Status != "completed" || p.ArchivedFromStatus != nil {
		t.Fatalf("restore silently reopened: %#v %v", p, err)
	}
	p.Status = "active"
	version = p.UpdatedAt
	if err = r.Update(ctx, p); err != nil || p.Status != "active" {
		t.Fatalf("explicit reopen: %v", err)
	}
	p.Status = "completed"
	p.ExpectedUpdatedAt = &initial
	if err = r.Update(ctx, p); !errors.Is(err, ErrProgramConflict) {
		t.Fatalf("stale status accepted: %v", err)
	}
	var state string
	if err = pool.QueryRow(ctx, `SELECT status FROM program_participants WHERE id=$1`, participant).Scan(&state); err != nil || state != "active" {
		t.Fatalf("program lifecycle changed participant: %s %v", state, err)
	}
	foreign := integrityProgram(t, pool)
	p.AccountID = foreign.account
	if err = r.Update(ctx, p); !errors.Is(err, ErrProgramConflict) {
		t.Fatalf("foreign program mutation: %v", err)
	}
}

func TestProgramClosureRejectsNewWorkButAllowsAttendanceCorrections(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	participant := integrityParticipant(t, pool, f)
	r := &ProgramRepository{db: pool}
	ctx := context.Background()
	session := &domain.ProgramSession{ProgramID: f.program, Date: time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC), Title: "Existing"}
	if err := r.CreateSession(ctx, f.account, session); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"completed", "archived"} {
		integrityExec(t, pool, `UPDATE programs SET status=$2 WHERE id=$1`, f.program, status)
		if err := r.AddParticipant(ctx, f.account, &domain.ProgramParticipant{ProgramID: f.program, ContactID: f.contact, Status: "active"}); !errors.Is(err, ErrProgramInactive) {
			t.Fatalf("%s single enrollment: %v", status, err)
		}
		if _, err := r.AddParticipantsByContactIDs(ctx, f.account, f.program, []uuid.UUID{f.contact}); !errors.Is(err, ErrProgramInactive) {
			t.Fatalf("%s bulk: %v", status, err)
		}
		for _, kind := range []string{"regular", "recovery"} {
			if err := r.CreateSession(ctx, f.account, &domain.ProgramSession{ProgramID: f.program, Date: session.Date, SessionType: kind}); !errors.Is(err, ErrProgramInactive) {
				t.Fatalf("%s %s session: %v", status, kind, err)
			}
		}
		if _, _, err := r.GenerateSessions(ctx, f.account, f.program, []*domain.ProgramSession{{ProgramID: f.program, Date: session.Date}}, false); !errors.Is(err, ErrProgramInactive) {
			t.Fatalf("%s generate: %v", status, err)
		}
	}
	integrityExec(t, pool, `UPDATE programs SET status='completed' WHERE id=$1`, f.program)
	if err := r.BatchMarkAttendance(ctx, f.account, f.user, f.program, session.ID, []*domain.ProgramAttendance{{ParticipantID: participant, Status: "present"}}); err != nil {
		t.Fatalf("completed attendance correction: %v", err)
	}
	if _, err := r.CreateAttendanceObservation(ctx, f.account, f.user, f.program, session.ID, participant, "Synthetic correction context"); err != nil {
		t.Fatalf("completed observation: %v", err)
	}
}

func TestProgramCreationWaitsForConclusionAndRechecksStatus(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	r := &ProgramRepository{db: pool}
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	integrityExec(t, tx, `UPDATE programs SET status='completed' WHERE account_id=$1 AND id=$2`, f.account, f.program)
	done := make(chan error, 1)
	go func() {
		done <- r.CreateSession(ctx, f.account, &domain.ProgramSession{ProgramID: f.program, Date: time.Now(), Title: "Must reject"})
	}()
	select {
	case err := <-done:
		t.Fatalf("writer bypassed parent lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, ErrProgramInactive) {
			t.Fatalf("writer accepted after conclusion: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("writer did not resume")
	}
}

func TestProgramAvatarRevisionIsolationQuotaAndSharedGC(t *testing.T) {
	pool, store, f, _, data := avatarIntegrityFixture(t)
	ctx := context.Background()
	r := &ProgramRepository{db: pool}
	second := uuid.New()
	integrityExec(t, pool, `INSERT INTO programs(id,account_id,type,name,status)VALUES($1,$2,'course','Other','active')`, second, f.account)
	t.Cleanup(func() {
		integrityExec(t, pool, `UPDATE programs SET avatar_media_asset_id=NULL WHERE account_id=$1`, f.account)
	})
	p, err := r.SaveAvatar(ctx, store, f.account, f.program, 0, data)
	if err != nil || p.AvatarURL == nil || p.AvatarRevision != 1 {
		t.Fatalf("save: %#v %v", p, err)
	}
	key, _, err := r.AvatarContent(ctx, f.account, f.program)
	if err != nil || !strings.HasPrefix(key, f.account.String()+"/_private/program-avatars/") {
		t.Fatalf("private key: %q %v", key, err)
	}
	if raw, err := store.GetFile(ctx, key); err != nil || !bytes.Equal(raw, data) {
		t.Fatal("unreadable image")
	}
	if _, err = r.SaveAvatar(ctx, store, f.account, f.program, 0, nil); !errors.Is(err, ErrProgramAvatarConflict) {
		t.Fatalf("stale delete: %v", err)
	}
	foreign := integrityProgram(t, pool)
	if _, err = r.SaveAvatar(ctx, store, foreign.account, f.program, 1, nil); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("foreign mutation: %v", err)
	}
	if _, _, err = r.AvatarContent(ctx, foreign.account, f.program); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("foreign read: %v", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE programs SET avatar_media_asset_id=$1 WHERE id=$2`, p.AvatarMediaAssetID, foreign.program); err == nil {
		t.Fatal("foreign asset FK accepted")
	}
	shared, err := r.SaveAvatar(ctx, store, f.account, second, 0, data)
	if err != nil || shared.AvatarMediaAssetID == nil || *shared.AvatarMediaAssetID != *p.AvatarMediaAssetID {
		t.Fatalf("dedup: %v", err)
	}
	if _, err = r.SaveAvatar(ctx, store, f.account, f.program, 1, nil); err != nil {
		t.Fatal(err)
	}
	assets := NewContactAvatarRepository(pool)
	if err = assets.ScheduleAssetGC(ctx, f.account, *p.AvatarMediaAssetID); err != nil {
		t.Fatal(err)
	}
	if removed, err := assets.deleteUnreferencedAvatar(ctx, store, f.account, *p.AvatarMediaAssetID, key); err != nil || removed {
		t.Fatalf("deleted shared avatar: %v", err)
	}
	if _, err = r.SaveAvatar(ctx, store, f.account, second, 1, nil); err != nil {
		t.Fatal(err)
	}
	var state string
	_ = pool.QueryRow(ctx, `SELECT status FROM media_assets WHERE id=$1`, p.AvatarMediaAssetID).Scan(&state)
	if state != "avatar_gc_pending" {
		t.Fatalf("last detach not durably scheduled: %s", state)
	}
	if removed, err := assets.deleteUnreferencedAvatar(ctx, store, f.account, *p.AvatarMediaAssetID, key); err != nil || !removed {
		t.Fatalf("unreferenced cleanup: %v", err)
	}
	integrityExec(t, pool, `UPDATE accounts SET storage_limit_bytes=1 WHERE id=$1`, f.account)
	if _, err = r.SaveAvatar(ctx, store, f.account, f.program, 2, data); !errors.Is(err, ErrAvatarStorageLimit) {
		t.Fatalf("quota: %v", err)
	}
	current, err := r.GetByID(ctx, f.account, f.program)
	if err != nil || current.AvatarMediaAssetID != nil || current.AvatarRevision != 2 {
		t.Fatalf("quota changed canonical attachment: %v", err)
	}
}

func TestProgramAvatarFailedAttachmentRetainsPreviousPhotoAndTracksUpload(t *testing.T) {
	pool, store, f, _, data := avatarIntegrityFixture(t)
	ctx := context.Background()
	r := &ProgramRepository{db: pool}
	t.Cleanup(func() {
		integrityExec(t, pool, `UPDATE programs SET avatar_media_asset_id=NULL WHERE account_id=$1`, f.account)
	})
	p, err := r.SaveAvatar(ctx, store, f.account, f.program, 0, data)
	if err != nil {
		t.Fatal(err)
	}
	function := "qa_reject_program_avatar_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	integrityExec(t, pool, `CREATE FUNCTION `+function+`() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic attachment failure'; END $$`)
	integrityExec(t, pool, `CREATE TRIGGER `+function+` BEFORE UPDATE OF avatar_media_asset_id ON programs FOR EACH ROW WHEN (NEW.id='`+f.program.String()+`'::uuid) EXECUTE FUNCTION `+function+`() `)
	t.Cleanup(func() {
		integrityExec(t, pool, `DROP TRIGGER IF EXISTS `+function+` ON programs`)
		integrityExec(t, pool, `DROP FUNCTION IF EXISTS `+function+`()`)
	})
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	img.Set(0, 0, color.RGBA{200, 20, 10, 255})
	var buffer bytes.Buffer
	if err = jpeg.Encode(&buffer, img, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = r.SaveAvatar(ctx, store, f.account, f.program, 1, buffer.Bytes()); err == nil {
		t.Fatal("injected attachment failure was ignored")
	}
	current, err := r.GetByID(ctx, f.account, f.program)
	if err != nil || current.AvatarRevision != 1 || current.AvatarMediaAssetID == nil || *current.AvatarMediaAssetID != *p.AvatarMediaAssetID {
		t.Fatalf("failed attachment replaced previous photo: %#v %v", current, err)
	}
	var key string
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*),COALESCE(min(ma.object_key),'') FROM media_assets ma JOIN storage_objects so ON so.account_id=ma.account_id AND so.object_key=ma.object_key WHERE ma.account_id=$1 AND ma.status='avatar_gc_pending' AND so.status='avatar_gc_pending'`, f.account).Scan(&count, &key); err != nil || count != 1 {
		t.Fatalf("failed upload lacks durable GC: %d %v", count, err)
	}
	if _, err = store.GetFile(ctx, key); err != nil {
		t.Fatal("test did not reach physical upload")
	}
}

func TestProgramAvatarConcurrentWritersCannotOverwriteSameRevision(t *testing.T) {
	pool, store, f, _, data := avatarIntegrityFixture(t)
	r := &ProgramRepository{db: pool}
	ctx := context.Background()
	t.Cleanup(func() {
		integrityExec(t, pool, `UPDATE programs SET avatar_media_asset_id=NULL WHERE account_id=$1`, f.account)
	})
	start := make(chan struct{})
	done := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { <-start; _, err := r.SaveAvatar(ctx, store, f.account, f.program, 0, data); done <- err }()
	}
	close(start)
	success, conflicts := 0, 0
	for i := 0; i < 2; i++ {
		select {
		case err := <-done:
			if err == nil {
				success++
			} else if errors.Is(err, ErrProgramAvatarConflict) {
				conflicts++
			} else {
				t.Fatal(err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("concurrent avatar writes stalled")
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("expected one save and one conflict, got %d/%d", success, conflicts)
	}
	p, err := r.GetByID(ctx, f.account, f.program)
	if err != nil || p.AvatarRevision != 1 {
		t.Fatalf("concurrent revision changed twice: %#v %v", p, err)
	}
}
