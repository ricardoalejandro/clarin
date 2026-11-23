package repository

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/programtransfer"
)

func TestProgramTransferDecodeCanonicalizesInstantsButPreservesDates(t *testing.T) {
	id := uuid.New()
	fields := []byte(`{"date":"2026-11-22","created_at":"2026-11-21T19:00:00.12-05:00","pinned_at":null}`)
	record, err := decodeProgramTransferRecord("session_observation", id, fields, uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	if record.ID != id.String() || record.Fields["date"] != "2026-11-22" || record.Fields["created_at"] != "2026-11-22T00:00:00.12Z" || record.Fields["pinned_at"] != nil {
		t.Fatalf("unexpected canonical record: %#v", record)
	}
	if _, err := decodeProgramTransferRecord("session_observation", id, []byte(`{"created_at":"invalid"}`), uuid.New()); err == nil {
		t.Fatal("malformed instant accepted")
	}
}

func TestProgramTransferAssociationIdentityIsStableAndScoped(t *testing.T) {
	program, contact := uuid.New(), uuid.New()
	first := ProgramTransferAssociationID(program, "instructor", contact)
	if first != ProgramTransferAssociationID(program, "instructor", contact) || first == ProgramTransferAssociationID(uuid.New(), "instructor", contact) || first == ProgramTransferAssociationID(program, "program_course", contact) || first == contact.String() {
		t.Fatal("association identity is not stable and scoped by kind and program")
	}
}

func TestProgramTransferDecodeUsesCanonicalContactPhones(t *testing.T) {
	raw := []byte(`{"name":"Participant","phone":"999 111 222","email":null,"additional_phones":[{"phone":"999 333 444","label":" work "},{"phone":"+51(999)111222","label":"duplicate main"},{"phone":"+51 999333444","label":"work"}]}`)
	record, err := decodeProgramTransferRecord("contact", uuid.New(), raw, uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	wantExtras := []any{map[string]any{"phone": "51999333444", "label": "work"}}
	if record.Fields["phone"] != "51999111222" || !reflect.DeepEqual(record.Fields["additional_phones"], wantExtras) {
		t.Fatalf("noncanonical phones in file: %#v", record.Fields)
	}
}

type oversizedTransferRows struct {
	pgx.Rows
	remaining int
	fields    []byte
	closed    bool
}

func (r *oversizedTransferRows) Next() bool { r.remaining--; return r.remaining >= 0 }
func (r *oversizedTransferRows) Err() error { return nil }
func (r *oversizedTransferRows) Close()     { r.closed = true }
func (r *oversizedTransferRows) Scan(dst ...any) error {
	*dst[0].(*string) = "program"
	*dst[1].(*uuid.UUID) = uuid.New()
	*dst[2].(*[]byte) = r.fields
	return nil
}

func TestProgramTransferReadRejectsOversizedSnapshotWithoutReturningPartialData(t *testing.T) {
	for _, rows := range []*oversizedTransferRows{
		{remaining: 1, fields: make([]byte, programtransfer.MaxFileBytes+1)},
		{remaining: programtransfer.MaxRecords + 1, fields: []byte(`{}`)},
	} {
		records, err := collectProgramTransferRecords(rows, uuid.New())
		if !errors.Is(err, programtransfer.ErrTooLarge) || len(records) != 0 || !rows.closed {
			t.Fatalf("oversized result was not rejected/closed: records=%d, err=%v, closed=%v", len(records), err, rows.closed)
		}
	}
}

func TestProgramTransferReadAccountScopedCompleteSnapshot(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	a := integrityProgram(t, pool)
	b := integrityProgram(t, pool)
	participant := integrityParticipant(t, pool, a)
	session, course, topic, legacy := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	otherProgram, otherSession := uuid.New(), uuid.New()
	ctx := context.Background()
	integrityExec(t, pool, `UPDATE users SET display_name='Docente de prueba' WHERE id=$1`, a.user)
	integrityExec(t, pool, `UPDATE contacts SET phone='999 111 222',email='Case@Test.invalid' WHERE id=$1`, a.contact)
	integrityExec(t, pool, `UPDATE contacts SET phone='999 111 222',email='Case@Test.invalid' WHERE id=$1`, b.contact)
	integrityExec(t, pool, `INSERT INTO contact_phones(contact_id,phone,label) VALUES($1,'+51 999 333 444','secondary')`, a.contact)
	integrityExec(t, pool, `INSERT INTO contact_aliases(account_id,contact_id,alias_type,alias_value,normalized_value) VALUES ($1,$2,'phone','51999555666','51999555666') ON CONFLICT DO NOTHING`, a.account, a.contact)
	integrityExec(t, pool, `INSERT INTO programs(id,account_id,type,name,status) VALUES($1,$2,'event','Legacy event','active')`, legacy, a.account)
	integrityExec(t, pool, `INSERT INTO programs(id,account_id,type,name,status) VALUES($1,$2,'course','Shared catalog borrower','active')`, otherProgram, a.account)
	integrityExec(t, pool, `INSERT INTO program_goals(account_id,program_id) VALUES ($1,NULL),($2,$3)`, a.account, b.account, b.program)
	integrityExec(t, pool, `INSERT INTO courses(id,account_id,name) VALUES($1,$2,'Course')`, course, a.account)
	integrityExec(t, pool, `INSERT INTO course_topics(id,account_id,course_id,title) VALUES($1,$2,$3,'Topic')`, topic, a.account, course)
	integrityExec(t, pool, `INSERT INTO program_courses(account_id,program_id,course_id) VALUES($1,$2,$3)`, a.account, a.program, course)
	integrityExec(t, pool, `INSERT INTO program_instructors(account_id,program_id,contact_id) VALUES($1,$2,$3)`, a.account, a.program, a.contact)
	integrityExec(t, pool, `INSERT INTO program_sessions(id,account_id,program_id,date,title,course_topic_id) VALUES($1,$2,$3,'2026-09-30','Older class',$4)`, session, a.account, a.program, topic)
	integrityExec(t, pool, `INSERT INTO program_sessions(id,account_id,program_id,date,title,course_topic_id) VALUES($1,$2,$3,'2026-09-29','Class from another program',$4)`, otherSession, a.account, otherProgram, topic)
	integrityExec(t, pool, `INSERT INTO program_session_topics(account_id,session_id,kind,course_id,course_topic_id,course_name_snapshot,topic_title_snapshot) VALUES($1,$2,'course',$3,$4,'Historic course','Historic topic')`, a.account, session, course, topic)
	integrityExec(t, pool, `INSERT INTO program_attendance(session_id,participant_id,status) VALUES($1,$2,'present')`, session, participant)
	integrityExec(t, pool, `INSERT INTO program_session_observations(account_id,session_id,notes,created_by,created_at) VALUES($1,$2,'Class note',$3,'2026-11-22 00:00:00Z')`, a.account, session, a.user)
	integrityExec(t, pool, `INSERT INTO program_participant_notes(account_id,program_id,participant_id,contact_id,session_id,note) VALUES($1,$2,$3,$4,$5,'Follow-up')`, a.account, a.program, participant, a.contact, session)
	integrityExec(t, pool, `INSERT INTO interactions(account_id,program_id,program_participant_id,contact_id,type,notes) VALUES ($1,$2,$3,$4,'note','Scoped note'),($1,NULL,NULL,$4,'note','General contact note')`, a.account, a.program, participant, a.contact)

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := ReadProgramTransfer(ctx, tx, b.account, a.program); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("wrong account mismatch = %v", err)
	}
	if _, err := ReadProgramTransfer(ctx, tx, a.account, legacy); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("legacy event was not rejected: %v", err)
	}
	records, err := ReadProgramTransfer(ctx, tx, a.account, a.program)
	if err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, record := range records {
		kinds = append(kinds, record.Kind)
		switch record.Kind {
		case "contact":
			if len(record.Fields) != 4 || record.Fields["additional_phones"] == nil {
				t.Fatalf("non-portable or omitted contact fields: %#v", record.Fields)
			}
		case "session_observation":
			if record.Fields["author_name"] != "Docente de prueba" || record.Fields["created_at"] != "2026-11-22T00:00:00Z" {
				t.Fatalf("missing provenance: %#v", record.Fields)
			}
		case "interaction":
			if record.Fields["notes"] != "Scoped note" || record.Fields["session_id"] != nil {
				t.Fatalf("general contact note leaked or scoped note missing: %#v", record.Fields)
			}
		}
	}
	want := strings.Fields("attendance contact course course_topic instructor interaction participant participant_note program program_course session session_observation session_topic")
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("snapshot kinds %v, want %v", kinds, want)
	}
	shared, err := ReadProgramTransferSharedCourses(ctx, tx, a.account, a.program)
	if err != nil || !reflect.DeepEqual(shared, []string{course.String()}) {
		t.Fatalf("historic class usage in another program was not protected: %v, %v", shared, err)
	}
	shared, err = ReadProgramTransferSharedCourses(ctx, tx, b.account, a.program)
	if err != nil || len(shared) != 0 {
		t.Fatalf("foreign program usage was visible: %v, %v", shared, err)
	}
	for _, lookup := range []struct {
		phones, emails []string
		ids            []uuid.UUID
		alias          string
	}{
		{phones: []string{"51999111222"}},
		{phones: []string{"51999333444"}},
		{phones: []string{"51999555666"}, alias: "51999555666"},
		{emails: []string{"case@test.invalid"}},
		{ids: []uuid.UUID{a.contact, b.contact}},
	} {
		matches, err := ReadProgramTransferContacts(ctx, tx, a.account, lookup.phones, lookup.emails, lookup.ids)
		if err != nil || len(matches) != 1 || matches[0].ID != a.contact.String() {
			t.Fatalf("scoped contact lookup got %d matches: %v", len(matches), err)
		}
		if lookup.alias != "" && !reflect.DeepEqual(matches[0].Fields["match_phone_aliases"], []any{lookup.alias}) {
			t.Fatal("historical phone alias evidence not found")
		}
	}
}

func TestProgramTransferAuthorAttributionRespectsMembershipAndContactHistory(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	program, secondary, unrelated := integrityProgram(t, pool), integrityProgram(t, pool), integrityProgram(t, pool)
	// Adding a secondary membership also creates account-owned Work defaults
	// attributed to that user. Remove the receiving account before deleting
	// the secondary user's primary account so those legitimate references are
	// released before the shared fixture's user cascade runs.
	t.Cleanup(func() { integrityExec(t, pool, `DELETE FROM accounts WHERE id=$1`, program.account) })
	participant := integrityParticipant(t, pool, program)
	session, imported := uuid.New(), uuid.New()
	ctx := context.Background()
	const displayName, importedName = "Secondary account author", "Imported observation author"
	integrityExec(t, pool, `INSERT INTO user_accounts(user_id,account_id) VALUES($1,$2)`, secondary.user, program.account)
	integrityExec(t, pool, `UPDATE users SET display_name=$2 WHERE id=$1`, secondary.user, displayName)
	integrityExec(t, pool, `UPDATE users SET display_name='Unrelated account author' WHERE id=$1`, unrelated.user)
	integrityExec(t, pool, `INSERT INTO program_sessions(id,account_id,program_id,date,title) VALUES($1,$2,$3,'2026-11-01','Synthetic class')`, session, program.account, program.program)
	integrityExec(t, pool, `INSERT INTO program_session_observations(account_id,session_id,notes,created_by) VALUES($1,$2,'Secondary class note',$3)`, program.account, session, secondary.user)
	integrityExec(t, pool, `INSERT INTO program_participant_notes(account_id,program_id,participant_id,contact_id,session_id,note,created_by)
		VALUES($1,$2,$3,$4,$5,'Secondary participant note',$6)`, program.account, program.program, participant, program.contact, session, secondary.user)
	integrityExec(t, pool, `INSERT INTO interactions(account_id,program_id,program_participant_id,contact_id,type,notes,created_by)
		VALUES($1,$2,$3,$4,'note','Secondary scoped note',$5),($1,$2,$3,$4,'note','Unrelated creator fixture',$6)`, program.account, program.program, participant, program.contact, secondary.user, unrelated.user)
	integrityExec(t, pool, `INSERT INTO interactions(id,account_id,program_id,program_participant_id,contact_id,type,notes,transfer_author_name)
		VALUES($1,$2,$3,$4,$5,'note','Imported scoped note',$6)`, imported, program.account, program.program, participant, program.contact, importedName)

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	records, err := ReadProgramTransfer(ctx, tx, program.account, program.program)
	if err != nil {
		t.Fatal(err)
	}
	byNote := make(map[string]any)
	for _, row := range records {
		if row.Kind == "session_observation" || row.Kind == "participant_note" || row.Kind == "interaction" {
			noteKey := "notes"
			if row.Kind == "participant_note" {
				noteKey = "note"
			}
			note := programtransfer.String(row.Fields, noteKey)
			for _, forbidden := range []string{"created_by", "user_id", "username", "email"} {
				if _, exists := row.Fields[forbidden]; exists {
					t.Fatalf("portable author projection contains %q", forbidden)
				}
			}
			byNote[note] = row.Fields["author_name"]
		}
	}
	for _, note := range []string{"Secondary class note", "Secondary participant note", "Secondary scoped note"} {
		if byNote[note] != displayName {
			t.Fatalf("secondary membership attribution missing for %q: %#v", note, byNote[note])
		}
	}
	if foreign, exists := byNote["Unrelated creator fixture"]; !exists || foreign != nil {
		t.Fatalf("unrelated creator attribution must not be exported: %#v", foreign)
	}
	if byNote["Imported scoped note"] != importedName {
		t.Fatalf("stored import attribution missing: %#v", byNote["Imported scoped note"])
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	repo := NewContactProfileRepository(pool)
	page, err := repo.ListObservationPage(ctx, program.account, program.contact, program.user, false, 50, 0, "", "program:"+program.program.String())
	if err != nil {
		t.Fatal(err)
	}
	for _, note := range page.Observations {
		if note.ID != imported {
			continue
		}
		if note.CreatedByName == nil || *note.CreatedByName != importedName || note.CreatedBy != nil || note.CanEdit || note.CanDelete || note.CanPin {
			t.Fatal("paged contact history lost attribution or treated imported provenance as ownership")
		}
		return
	}
	t.Fatal("imported program note missing from paged contact history")
}
