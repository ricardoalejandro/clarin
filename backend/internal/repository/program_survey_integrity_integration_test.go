package repository

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
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

var integrityMigrationOnce sync.Once
var integrityMigrationError error

func programSurveyIntegrityPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("INTEGRITY_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("INTEGRITY_TEST_DATABASE_URL required for dedicated synthetic DB")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Path != "/program_survey_integrity_test" {
		t.Fatal("integrity tests require exact disposable database program_survey_integrity_test")
	}
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal("invalid integration database configuration")
	}
	cfg.ConnConfig.RuntimeParams["application_name"] = "clarin-program-survey-integrity-test"
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal("could not connect to disposable integration database")
	}
	t.Cleanup(pool.Close)
	integrityMigrationOnce.Do(func() { integrityMigrationError = database.Migrate(pool) })
	if integrityMigrationError != nil {
		t.Fatalf("integrity startup migration: %v", integrityMigrationError)
	}
	return pool
}

type integrityProgramFixture struct{ account, program, contact, user uuid.UUID }

func integrityExec(t *testing.T, q interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, sql string, args ...any) {
	t.Helper()
	if _, err := q.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("synthetic fixture statement: %v", err)
	}
}

func integrityProgram(t *testing.T, pool *pgxpool.Pool) integrityProgramFixture {
	t.Helper()
	f := integrityProgramFixture{uuid.New(), uuid.New(), uuid.New(), uuid.New()}
	integrityExec(t, pool, `INSERT INTO accounts(id,name) VALUES($1,'Synthetic integrity account')`, f.account)
	integrityExec(t, pool, `INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'test-only-hash')`, f.user, f.account, "integrity-"+f.user.String(), f.user.String()+"@test.invalid")
	integrityExec(t, pool, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Synthetic participant')`, f.contact, f.account, f.contact.String()+"@test.invalid")
	integrityExec(t, pool, `INSERT INTO programs(id,account_id,type,name,status) VALUES($1,$2,'course','Synthetic class group','active')`, f.program, f.account)
	t.Cleanup(func() { integrityExec(t, pool, `DELETE FROM accounts WHERE id=$1`, f.account) })
	return f
}

func integrityParticipant(t *testing.T, pool *pgxpool.Pool, f integrityProgramFixture) uuid.UUID {
	t.Helper()
	id := uuid.New()
	integrityExec(t, pool, `INSERT INTO program_participants(id,program_id,contact_id,status,enrolled_at) VALUES($1,$2,$3,'active','2026-10-01')`, id, f.program, f.contact)
	return id
}

func integritySurvey(t *testing.T, pool *pgxpool.Pool, f integrityProgramFixture) uuid.UUID {
	t.Helper()
	id := uuid.New()
	integrityExec(t, pool, `INSERT INTO surveys(id,account_id,name,slug,status,program_id,origin_type,origin_label,audience_mode,legacy_instance) VALUES($1,$2,'Synthetic survey',$3,'closed',$4,'program','Synthetic class group','program_participants',TRUE)`, id, f.account, id.String(), f.program)
	return id
}

func waitIntegrityLock(t *testing.T, pool *pgxpool.Pool, statement string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='clarin-program-survey-integrity-test' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE $1)`, "%"+statement+"%").Scan(&blocked)
		if err != nil {
			t.Fatalf("waiting for PostgreSQL lock: %v", err)
		}
		if blocked {
			return
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("expected PostgreSQL lock was not observed")
		}
	}
}

func TestProgramDeleteIntegrityEmptyAndAccountIsolation(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	r := &ProgramRepository{db: pool}
	ctx := context.Background()
	if err := r.Delete(ctx, uuid.New(), f.program); err != nil {
		t.Fatal(err)
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM programs WHERE account_id=$1 AND id=$2)`, f.account, f.program).Scan(&exists); err != nil || !exists {
		t.Fatalf("foreign account changed program: %v", err)
	}
	if err := r.Delete(ctx, f.account, f.program); err != nil {
		t.Fatal(err)
	}
	if err := r.Delete(ctx, f.account, f.program); err != nil {
		t.Fatalf("idempotent delete: %v", err)
	}
}

func TestProgramDeleteIntegrityEveryRetainedDependency(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	for _, name := range []string{"participants", "sessions", "participant_notes", "courses", "instructors", "goals", "retirement", "surveys", "recipients", "responses", "tasks", "interactions"} {
		t.Run(name, func(t *testing.T) {
			f := integrityProgram(t, pool)
			switch name {
			case "participants":
				p := integrityParticipant(t, pool, f)
				integrityExec(t, pool, `UPDATE program_participants SET status='dropped',dropped_at='2026-10-04' WHERE id=$1`, p)
			case "sessions":
				integrityExec(t, pool, `INSERT INTO program_sessions(account_id,program_id,date,title) VALUES($1,$2,'2026-10-02','Planned class')`, f.account, f.program)
			case "participant_notes":
				p := integrityParticipant(t, pool, f)
				integrityExec(t, pool, `INSERT INTO program_participant_notes(account_id,program_id,participant_id,contact_id,note) VALUES($1,$2,$3,$4,'Retained note')`, f.account, f.program, p, f.contact)
			case "courses":
				c := uuid.New()
				integrityExec(t, pool, `INSERT INTO courses(id,account_id,name) VALUES($1,$2,'Retained course')`, c, f.account)
				integrityExec(t, pool, `INSERT INTO program_courses(account_id,program_id,course_id) VALUES($1,$2,$3)`, f.account, f.program, c)
			case "instructors":
				integrityExec(t, pool, `INSERT INTO program_instructors(account_id,program_id,contact_id) VALUES($1,$2,$3)`, f.account, f.program, f.contact)
			case "goals":
				integrityExec(t, pool, `INSERT INTO program_goals(account_id,program_id) VALUES($1,$2)`, f.account, f.program)
			case "retirement":
				integrityExec(t, pool, `INSERT INTO program_event_retirements(account_id,program_id,status) VALUES($1,$2,'blocked')`, f.account, f.program)
			case "surveys":
				integritySurvey(t, pool, f)
			case "recipients":
				p := integrityParticipant(t, pool, f)
				s := integritySurvey(t, pool, f)
				integrityExec(t, pool, `INSERT INTO survey_instance_recipients(account_id,survey_id,program_id,program_participant_id,contact_id,status) VALUES($1,$2,$3,$4,$5,'pending')`, f.account, s, f.program, p, f.contact)
			case "responses":
				s := integritySurvey(t, pool, f)
				integrityExec(t, pool, `INSERT INTO survey_responses(account_id,survey_id,program_id,completed_at) VALUES($1,$2,$3,NOW())`, f.account, s, f.program)
			case "tasks":
				integrityExec(t, pool, `INSERT INTO tasks(account_id,program_id,created_by,assigned_to,title,due_at,deleted_at) VALUES($1,$2,$3,$3,'Task in Trash',NOW(),NOW())`, f.account, f.program, f.user)
			case "interactions":
				integrityExec(t, pool, `INSERT INTO interactions(account_id,program_id,contact_id,type,notes) VALUES($1,$2,$3,'note','Retained context')`, f.account, f.program, f.contact)
			}
			r := &ProgramRepository{db: pool}
			if err := r.Delete(context.Background(), f.account, f.program); !errors.Is(err, ErrProgramHasDependencies) {
				t.Fatalf("%s did not prevent delete: %v", name, err)
			}
			var exists bool
			if err := pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM programs WHERE account_id=$1 AND id=$2)`, f.account, f.program).Scan(&exists); err != nil || !exists {
				t.Fatalf("protected parent lost: %v", err)
			}
		})
	}
}

func TestProgramDeleteIntegrityProtectsEmptyLegacyEvent(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	integrityExec(t, pool, `UPDATE programs SET type='event' WHERE account_id=$1 AND id=$2`, f.account, f.program)
	if err := (&ProgramRepository{db: pool}).Delete(context.Background(), f.account, f.program); !errors.Is(err, ErrProgramLegacyProtected) {
		t.Fatalf("empty legacy event was not protected: %v", err)
	}
	var exists bool
	if err := pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM programs WHERE account_id=$1 AND id=$2)`, f.account, f.program).Scan(&exists); err != nil || !exists {
		t.Fatalf("legacy event lost: %v", err)
	}
}

func TestProgramDeleteIntegrityPreservesAttendanceAndSurveyIdentity(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	p := integrityParticipant(t, pool, f)
	s := integritySurvey(t, pool, f)
	session, recipient, response := uuid.New(), uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO program_sessions(id,account_id,program_id,date,title) VALUES($1,$2,$3,'2026-10-02','Historical class')`, session, f.account, f.program)
	integrityExec(t, pool, `INSERT INTO program_attendance(session_id,participant_id,status,notes) VALUES($1,$2,NULL,'Pending with note')`, session, p)
	integrityExec(t, pool, `INSERT INTO survey_instance_recipients(id,account_id,survey_id,program_id,program_participant_id,contact_id,status,opened_at) VALUES($1,$2,$3,$4,$5,$6,'opened',NOW())`, recipient, f.account, s, f.program, p, f.contact)
	integrityExec(t, pool, `INSERT INTO survey_responses(id,account_id,survey_id,program_id,program_participant_id,contact_id,recipient_id,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,NOW())`, response, f.account, s, f.program, p, f.contact, recipient)
	r := &ProgramRepository{db: pool}
	if err := r.Delete(context.Background(), f.account, f.program); !errors.Is(err, ErrProgramHasDependencies) {
		t.Fatal(err)
	}
	var intact bool
	err := pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM survey_responses sr JOIN survey_instance_recipients recipient ON recipient.id=sr.recipient_id JOIN program_attendance attendance ON attendance.participant_id=sr.program_participant_id WHERE sr.id=$1 AND sr.program_id=$2 AND sr.program_participant_id=$3 AND sr.contact_id=$4 AND attendance.session_id=$5 AND attendance.status IS NULL)`, response, f.program, p, f.contact, session).Scan(&intact)
	if err != nil || !intact {
		t.Fatalf("historical identity or pending attendance changed: %v", err)
	}
}

func TestProgramDeleteIntegritySerializesNewReferences(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	for _, kind := range []string{"participant", "session", "survey", "interaction"} {
		t.Run(kind+"_writer_first", func(t *testing.T) {
			f := integrityProgram(t, pool)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			writer, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Rollback(ctx)
			query, args := integrityConcurrentInsert(kind, f)
			integrityExec(t, writer, query, args...)
			done := make(chan error, 1)
			go func() { done <- (&ProgramRepository{db: pool}).Delete(ctx, f.account, f.program) }()
			waitIntegrityLock(t, pool, "SELECT type FROM programs")
			if err := writer.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-done; !errors.Is(err, ErrProgramHasDependencies) {
				t.Fatalf("committed writer was missed: %v", err)
			}
		})
		t.Run(kind+"_delete_first", func(t *testing.T) {
			f := integrityProgram(t, pool)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			deletion, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
			if err != nil {
				t.Fatal(err)
			}
			defer deletion.Rollback(ctx)
			if err := deleteEmptyProgramTx(ctx, deletion, f.account, f.program); err != nil {
				t.Fatal(err)
			}
			query, args := integrityConcurrentInsert(kind, f)
			done := make(chan error, 1)
			go func() { _, err := pool.Exec(ctx, query, args...); done <- err }()
			waitIntegrityLock(t, pool, query[:min(len(query), 35)])
			if err := deletion.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var pgerr *pgconn.PgError
			if err := <-done; !errors.As(err, &pgerr) || pgerr.Code != "23503" {
				t.Fatalf("reference to deleted program survived: %v", err)
			}
		})
	}
}

func integrityConcurrentInsert(kind string, f integrityProgramFixture) (string, []any) {
	switch kind {
	case "participant":
		return `INSERT INTO program_participants(program_id,contact_id,status) VALUES($1,$2,'active')`, []any{f.program, f.contact}
	case "session":
		return `INSERT INTO program_sessions(account_id,program_id,date,title) VALUES($1,$2,'2026-10-02','Concurrent class')`, []any{f.account, f.program}
	case "survey":
		return `INSERT INTO surveys(account_id,name,slug,program_id,origin_type,origin_label,audience_mode,legacy_instance) VALUES($1,'Concurrent survey',$2,$3,'program','Synthetic group','program_participants',TRUE)`, []any{f.account, uuid.NewString(), f.program}
	default:
		return `INSERT INTO interactions(account_id,program_id,contact_id,type) VALUES($1,$2,$3,'note')`, []any{f.account, f.program, f.contact}
	}
}

func TestSurveyTemplateSnapshotIntegrityLockRejectsMixedRevision(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	template, question := uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO survey_templates(id,account_id,name,measurement_config) VALUES($1,$2,'Measured template','{"dimensions":[{"key":"old","name":"Old"}]}')`, template, f.account)
	integrityExec(t, pool, `INSERT INTO survey_template_questions(id,account_id,template_id,type,title,config) VALUES($1,$2,$3,'rating','Rating','{"max_rating":5,"measurement":{"dimension_key":"old","weight":1}}')`, question, f.account, template)
	repo := &SurveyTemplateRepository{db: pool}
	source, err := repo.Get(ctx, f.account, template)
	if err != nil {
		t.Fatal(err)
	}
	input := domain.CreateSurveyInstanceInput{TemplateID: template, AccountID: f.account, Name: "Measured application", Slug: uuid.NewString(), Status: "active", AudienceMode: "public", ExpectedTemplateRevision: source.Revision, MeasurementConfig: source.MeasurementConfig, MeasurementSignature: "old-instrument"}
	edit, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer edit.Rollback(ctx)
	var locked uuid.UUID
	if err := edit.QueryRow(ctx, `SELECT id FROM survey_templates WHERE account_id=$1 AND id=$2 FOR UPDATE`, f.account, template).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	integrityExec(t, edit, `UPDATE survey_template_questions SET config='{"max_rating":5,"measurement":{"dimension_key":"new","weight":1}}' WHERE id=$1`, question)
	integrityExec(t, edit, `UPDATE survey_templates SET revision=revision+1,measurement_config='{"dimensions":[{"key":"new","name":"New"}]}' WHERE id=$1`, template)
	done := make(chan error, 1)
	go func() { _, err := repo.CreateInstance(ctx, input); done <- err }()
	waitIntegrityLock(t, pool, "FROM survey_templates WHERE account_id=$1 AND id=$2 FOR UPDATE")
	if err := edit.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, ErrSurveyTemplateRevisionConflict) {
		t.Fatalf("stale snapshot accepted: %v", err)
	}
	var allocated bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM surveys WHERE account_id=$1) OR EXISTS(SELECT 1 FROM survey_public_slug_reservations WHERE slug=$2)`, f.account, input.Slug).Scan(&allocated); err != nil || allocated {
		t.Fatalf("conflict allocated application/slug: %v", err)
	}
	source, err = repo.Get(ctx, f.account, template)
	if err != nil {
		t.Fatal(err)
	}
	input.ExpectedTemplateRevision = source.Revision
	input.MeasurementConfig = source.MeasurementConfig
	input.MeasurementSignature = "new-instrument"
	instance, err := repo.CreateInstance(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	var config, questionConfig []byte
	var revision int
	var signature string
	if err := pool.QueryRow(ctx, `SELECT s.template_revision,s.measurement_config,s.measurement_signature,q.config FROM surveys s JOIN survey_questions q ON q.survey_id=s.id WHERE s.account_id=$1 AND s.id=$2`, f.account, instance.ID).Scan(&revision, &config, &signature, &questionConfig); err != nil {
		t.Fatal(err)
	}
	var measurement domain.SurveyMeasurementConfig
	var qcfg domain.SurveyQuestionConfig
	if err := json.Unmarshal(config, &measurement); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(questionConfig, &qcfg); err != nil {
		t.Fatal(err)
	}
	if revision != 2 || signature != "new-instrument" || measurement.Dimensions[0].Key != "new" || qcfg.Measurement.DimensionKey != "new" {
		t.Fatal("application mixed template revisions")
	}
	_, err = repo.UpdateMeasurement(ctx, f.account, template, domain.SurveyMeasurementConfig{Dimensions: []domain.SurveyMeasurementDimension{{Key: "later", Name: "Later"}}}, map[uuid.UUID]*domain.SurveyQuestionMeasurement{question: {DimensionKey: "later", Weight: 1}})
	if err != nil {
		t.Fatal(err)
	}
	var preserved bool
	if err := pool.QueryRow(ctx, `SELECT template_revision=2 AND measurement_signature='new-instrument' AND measurement_config->'dimensions'->0->>'key'='new' FROM surveys WHERE account_id=$1 AND id=$2`, f.account, instance.ID).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("template edit changed frozen application: %v", err)
	}
}

func TestSurveyTemplateSnapshotIntegrityFreezesExactProgramParticipation(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	ctx := context.Background()
	p := integrityParticipant(t, pool, f)
	template := uuid.New()
	integrityExec(t, pool, `INSERT INTO survey_templates(id,account_id,name) VALUES($1,$2,'Audience template')`, template, f.account)
	integrityExec(t, pool, `INSERT INTO survey_template_questions(account_id,template_id,type,title) VALUES($1,$2,'short_text','Answer')`, f.account, template)
	repo := &SurveyTemplateRepository{db: pool}
	input := domain.CreateSurveyInstanceInput{TemplateID: template, AccountID: f.account, Slug: uuid.NewString(), Status: "active", ProgramID: &f.program, AudienceMode: "program_participants", ExpectedTemplateRevision: 1}
	first, err := repo.CreateInstance(ctx, input)
	if err != nil || first.RecipientCount != 1 {
		t.Fatalf("initial program audience: instance=%v err=%v", first, err)
	}
	// A later enrollment and a withdrawal must not rewrite the launched audience.
	laterContact, laterParticipant := uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Later synthetic participant')`, laterContact, f.account, laterContact.String()+"@test.invalid")
	integrityExec(t, pool, `INSERT INTO program_participants(id,program_id,contact_id,status,enrolled_at) VALUES($1,$2,$3,'active','2026-10-06')`, laterParticipant, f.program, laterContact)
	integrityExec(t, pool, `UPDATE program_participants SET status='dropped',dropped_at='2026-10-05' WHERE id=$1`, p)
	// The same Contact belongs independently to another Program.
	secondProgram, secondParticipant := uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO programs(id,account_id,type,name,status) VALUES($1,$2,'course','Second synthetic group','active')`, secondProgram, f.account)
	integrityExec(t, pool, `INSERT INTO program_participants(id,program_id,contact_id,status) VALUES($1,$2,$3,'active')`, secondParticipant, secondProgram, f.contact)
	input.ProgramID, input.Slug = &secondProgram, uuid.NewString()
	second, err := repo.CreateInstance(ctx, input)
	if err != nil || second.RecipientCount != 1 {
		t.Fatalf("second program audience: instance=%v err=%v", second, err)
	}
	var firstIdentity, secondIdentity bool
	var count int
	err = pool.QueryRow(ctx, `SELECT count(*),bool_and(program_id=$3 AND program_participant_id=$4 AND contact_id=$5) FROM survey_instance_recipients WHERE account_id=$1 AND survey_id=$2`, f.account, first.ID, f.program, p, f.contact).Scan(&count, &firstIdentity)
	if err != nil || count != 1 || !firstIdentity {
		t.Fatalf("frozen first audience changed: count=%d identity=%v err=%v", count, firstIdentity, err)
	}
	err = pool.QueryRow(ctx, `SELECT bool_and(program_id=$3 AND program_participant_id=$4 AND contact_id=$5) FROM survey_instance_recipients WHERE account_id=$1 AND survey_id=$2`, f.account, second.ID, secondProgram, secondParticipant, f.contact).Scan(&secondIdentity)
	if err != nil || !secondIdentity {
		t.Fatalf("second participation identity mixed: %v", err)
	}
}
