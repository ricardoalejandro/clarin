package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/programtransfer"
)

func transferPlanRecord(kind string, fields map[string]any) programtransfer.Record {
	r := programtransfer.Record{ID: uuid.NewString(), Kind: kind, Fields: fields, Revisions: map[string]programtransfer.Revision{}}
	for f, v := range programtransfer.Current(r, nil) {
		r.Revisions[f] = v.Revision
	}
	return r
}

func TestProgramTransferPlanPreservesParallelNotesAndRequiresAttendanceChoice(t *testing.T) {
	program := transferPlanRecord("program", map[string]any{"name": "Historia", "status": "active"})
	contact := transferPlanRecord("contact", map[string]any{"name": "Rosa", "phone": "51999999999", "email": nil, "additional_phones": []any{}})
	participant := transferPlanRecord("participant", map[string]any{"contact_id": contact.ID, "status": "active"})
	session := transferPlanRecord("session", map[string]any{"date": "2026-10-01", "title": "Una clase"})
	attendance := transferPlanRecord("attendance", map[string]any{"session_id": session.ID, "participant_id": participant.ID, "status": "late"})
	localNote := transferPlanRecord("session_observation", map[string]any{"session_id": session.ID, "notes": "Estoy en A"})
	incomingNote := transferPlanRecord("session_observation", map[string]any{"session_id": session.ID, "notes": "Estoy en B"})
	snap := transferSnapshot{Target: program.ID, Rows: []programtransfer.Record{program, contact, participant, session, attendance, localNote}}
	for _, r := range snap.Rows {
		snap.Links = append(snap.Links, transferLink{Kind: r.Kind, PortableID: r.ID, LocalID: r.ID, Baseline: programtransfer.BaselineOf(r)})
	}
	local := attendance
	local.Fields = copyTransferFields(attendance.Fields)
	local.Fields["status"] = "present"
	snap.Rows[4] = local
	incoming := attendance
	incoming.Fields = copyTransferFields(attendance.Fields)
	incoming.Fields["status"] = "absent"
	incoming.Revisions = map[string]programtransfer.Revision{}
	for f, r := range attendance.Revisions {
		incoming.Revisions[f] = r
	}
	incoming.Revisions["status"] = programtransfer.Extend(attendance.Revisions["status"])
	req := programtransfer.Request{File: programtransfer.File{Records: []programtransfer.Record{program, contact, participant, session, incoming, incomingNote}}}
	preview, err := planProgramTransfer(snap, req, nil)
	if err != nil || len(preview.Preview.Conflicts) != 1 || preview.Preview.Summary.Create != 1 {
		t.Fatalf("preview: %+v, %v", preview.Preview, err)
	}
	conflict := preview.Preview.Conflicts[0]
	if conflict.Local != "present" || conflict.Incoming != "absent" || conflict.Kind != "attendance" {
		t.Fatalf("bad conflict: %+v", conflict)
	}
	confirmed, err := planProgramTransfer(snap, req, map[string]string{conflict.Key: "incoming"})
	if err != nil || confirmed.Preview.Summary.Update != 1 || confirmed.Preview.Summary.Create != 1 || len(confirmed.Preview.Conflicts) > 0 {
		t.Fatalf("apply: %+v, %v", confirmed.Preview, err)
	}
}

func TestProgramTransferPlanEqualDatesDoNotImplySameSession(t *testing.T) {
	program := transferPlanRecord("program", map[string]any{"name": "Historia", "status": "active"})
	local := transferPlanRecord("session", map[string]any{"date": "2026-10-01", "title": "Una clase", "start_time": "08:00"})
	incoming := transferPlanRecord("session", map[string]any{"date": "2026-10-01", "title": "Otra clase", "start_time": "20:00"})
	snap := transferSnapshot{Target: program.ID, Rows: []programtransfer.Record{program, local}}
	req := programtransfer.Request{File: programtransfer.File{Records: []programtransfer.Record{program, incoming}}}
	preview, err := planProgramTransfer(snap, req, nil)
	if err != nil || len(preview.Preview.Conflicts) != 1 || preview.Preview.Conflicts[0].MappingKey != incoming.ID {
		t.Fatalf("review should require session identity choice: %+v, %v", preview.Preview, err)
	}
	req.Mappings = map[string]string{incoming.ID: "create"}
	preview, err = planProgramTransfer(snap, req, nil)
	if err != nil || len(preview.Preview.Conflicts) != 0 || preview.Preview.Summary.Create != 1 {
		t.Fatalf("review did not preserve distinct sessions: %+v, %v", preview.Preview, err)
	}
}

func TestProgramTransferPlanReplaysConfirmedIdentityMappings(t *testing.T) {
	for _, create := range []bool{false, true} {
		t.Run(map[bool]string{false: "explicit existing session", true: "previous create choice"}[create], func(t *testing.T) {
			program := transferPlanRecord("program", map[string]any{"name": "Historia", "status": "active"})
			local := transferPlanRecord("session", map[string]any{"date": "2026-10-01", "title": "Clase"})
			incoming := transferPlanRecord("session", map[string]any{"date": "2026-10-01", "title": "Clase"})
			snap := transferSnapshot{Target: program.ID, Rows: []programtransfer.Record{program, local}}
			req := programtransfer.Request{File: programtransfer.File{Records: []programtransfer.Record{program, incoming}}, Mappings: map[string]string{incoming.ID: local.ID}}
			if create {
				req.Mappings[incoming.ID] = "create"
			}
			first, err := planProgramTransfer(snap, req, nil)
			if err != nil || len(first.Preview.Conflicts) != 0 {
				t.Fatalf("initial review failed: %+v, %v", first.Preview, err)
			}
			for _, change := range first.Changes {
				if change.Local.Kind == "session" {
					if create {
						snap.Rows = append(snap.Rows, change.Local)
					}
					snap.Links = append(snap.Links,
						transferLink{Kind: "session", PortableID: incoming.ID, LocalID: change.Local.ID},
						transferLink{Kind: "session", PortableID: change.Local.ID, LocalID: change.Local.ID, Baseline: programtransfer.BaselineOf(change.Local)})
				}
			}
			replay, err := planProgramTransfer(snap, req, nil)
			if err != nil || len(replay.Preview.Conflicts) != 0 || replay.Preview.Summary.Create != 0 || replay.Preview.Summary.Update != 0 {
				t.Fatalf("the same confirmed mapping must be an unchanged replay: %+v, %v", replay.Preview, err)
			}
			req.Mappings[incoming.ID] = uuid.NewString()
			if _, err := planProgramTransfer(snap, req, nil); !errors.Is(err, programtransfer.ErrInvalid) {
				t.Fatalf("a replay must not relink an established origin to another identity: %v", err)
			}
		})
	}
}

func TestProgramTransferPlanDoesNotPromiseUnsupportedNoteReparenting(t *testing.T) {
	for _, tc := range []struct {
		kind, field string
	}{
		{kind: "participant_note", field: "session_id"},
		{kind: "interaction", field: "session_id"},
		{kind: "interaction", field: "type"},
	} {
		t.Run(tc.kind+"_"+tc.field, func(t *testing.T) {
			program := transferPlanRecord("program", map[string]any{"name": "Historia", "status": "active"})
			contact := transferPlanRecord("contact", map[string]any{"name": "Rosa", "phone": nil, "email": nil, "additional_phones": []any{}})
			participant := transferPlanRecord("participant", map[string]any{"contact_id": contact.ID, "status": "active"})
			first := transferPlanRecord("session", map[string]any{"date": "2026-10-01", "title": "Primera"})
			second := transferPlanRecord("session", map[string]any{"date": "2026-10-02", "title": "Segunda"})
			note := transferPlanRecord(tc.kind, map[string]any{"participant_id": participant.ID, "session_id": first.ID, "type": "note", "notes": "Seguimiento"})
			snap := transferSnapshot{Target: program.ID, Rows: []programtransfer.Record{program, contact, participant, first, second, note}}
			for _, row := range snap.Rows {
				snap.Links = append(snap.Links, transferLink{Kind: row.Kind, PortableID: row.ID, LocalID: row.ID, Baseline: programtransfer.BaselineOf(row)})
			}
			incoming := note
			incoming.Fields = copyTransferFields(note.Fields)
			incoming.Revisions = make(map[string]programtransfer.Revision, len(note.Revisions))
			for field, rev := range note.Revisions {
				incoming.Revisions[field] = rev
			}
			incoming.Fields[tc.field] = second.ID
			if tc.field == "type" {
				incoming.Fields[tc.field] = "call"
			}
			incoming.Revisions[tc.field] = programtransfer.Extend(note.Revisions[tc.field])
			req := programtransfer.Request{File: programtransfer.File{Records: []programtransfer.Record{program, contact, participant, first, second, incoming}}}
			preview, err := planProgramTransfer(snap, req, nil)
			if err != nil || len(preview.Preview.Conflicts) != 1 || preview.Preview.Summary.Update != 0 {
				t.Fatalf("unsupported contextual mutation was not surfaced before confirmation: %+v, %v", preview.Preview, err)
			}
			conflict := preview.Preview.Conflicts[0]
			if conflict.Field != tc.field || len(conflict.Choices) != 1 || conflict.Choices[0].Value != "local" {
				t.Fatalf("review offered an unsupported write: %+v", conflict)
			}
			key := incoming.ID + ":" + tc.field
			if _, err := planProgramTransfer(snap, req, map[string]string{key: "incoming"}); !errors.Is(err, programtransfer.ErrInvalid) {
				t.Fatalf("unsupported choice must not reach the writer: %v", err)
			}
			kept, err := planProgramTransfer(snap, req, map[string]string{key: "local"})
			if err != nil || len(kept.Preview.Conflicts) != 0 || kept.Preview.Summary.Update != 0 {
				t.Fatalf("keeping local context should finish without a false write: %+v, %v", kept.Preview, err)
			}
		})
	}
}

func TestProgramTransferPlanReviewsTopicCollectionWithoutMixingHistory(t *testing.T) {
	for _, tc := range []struct {
		name, local, incoming string
		wantConflict          bool
		wantTopicCreates      int
		wantTopicUpdates      int
	}{
		{name: "free to course", local: "free", incoming: "first", wantConflict: true},
		{name: "course to free", local: "first", incoming: "free", wantConflict: true},
		{name: "remove a course", local: "both", incoming: "first", wantConflict: true},
		{name: "add a course", local: "first", incoming: "both", wantTopicCreates: 1},
		{name: "edit same slot", local: "first", incoming: "changed", wantTopicUpdates: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			program := transferPlanRecord("program", map[string]any{"name": "Historia", "status": "active"})
			course := transferPlanRecord("course", map[string]any{"name": "Historia"})
			otherCourse := transferPlanRecord("course", map[string]any{"name": "Filosofía"})
			topic := transferPlanRecord("course_topic", map[string]any{"course_id": course.ID, "title": "Grecia"})
			otherTopic := transferPlanRecord("course_topic", map[string]any{"course_id": otherCourse.ID, "title": "Ética"})
			session := transferPlanRecord("session", map[string]any{"date": "2026-10-01", "title": "Clase", "topic": "Grecia", "course_topic_id": topic.ID})
			free := transferPlanRecord("session_topic", map[string]any{"session_id": session.ID, "kind": "free", "course_id": nil, "course_topic_id": nil, "topic_title_snapshot": "Tema libre"})
			first := transferPlanRecord("session_topic", map[string]any{"session_id": session.ID, "kind": "course", "course_id": course.ID, "course_topic_id": topic.ID, "course_name_snapshot": "Historia", "topic_title_snapshot": "Grecia"})
			second := transferPlanRecord("session_topic", map[string]any{"session_id": session.ID, "kind": "course", "course_id": otherCourse.ID, "course_topic_id": otherTopic.ID, "course_name_snapshot": "Filosofía", "topic_title_snapshot": "Ética"})
			changed := first
			changed.Fields = copyTransferFields(first.Fields)
			changed.Revisions = make(map[string]programtransfer.Revision, len(first.Revisions))
			for field, rev := range first.Revisions {
				changed.Revisions[field] = rev
			}
			changed.Fields["topic_title_snapshot"] = "Historia de Grecia"
			changed.Revisions["topic_title_snapshot"] = programtransfer.Extend(first.Revisions["topic_title_snapshot"])
			collections := map[string][]programtransfer.Record{
				"free": {free}, "first": {first}, "both": {first, second}, "changed": {changed},
			}
			if tc.local == "free" {
				session.Fields["topic"], session.Fields["course_topic_id"] = "Tema libre", nil
			}
			parents := []programtransfer.Record{program, course, otherCourse, topic, otherTopic, session}
			snap := transferSnapshot{Target: program.ID, Rows: append(append([]programtransfer.Record{}, parents...), collections[tc.local]...)}
			for _, row := range snap.Rows {
				snap.Links = append(snap.Links, transferLink{Kind: row.Kind, PortableID: row.ID, LocalID: row.ID, Baseline: programtransfer.BaselineOf(row)})
			}
			incomingSession := session
			incomingSession.Fields = copyTransferFields(session.Fields)
			incomingSession.Revisions = make(map[string]programtransfer.Revision, len(session.Revisions))
			for field, rev := range session.Revisions {
				incomingSession.Revisions[field] = rev
			}
			incomingSession.Fields["topic"], incomingSession.Fields["course_topic_id"] = "Grecia", topic.ID
			if tc.incoming == "free" {
				incomingSession.Fields["topic"], incomingSession.Fields["course_topic_id"] = "Tema libre", nil
			}
			for _, field := range []string{"topic", "course_topic_id"} {
				if programtransfer.Fingerprint(incomingSession.Fields[field]) != programtransfer.Fingerprint(session.Fields[field]) {
					incomingSession.Revisions[field] = programtransfer.Extend(session.Revisions[field])
				}
			}
			incomingParents := append([]programtransfer.Record{}, parents...)
			incomingParents[len(incomingParents)-1] = incomingSession
			req := programtransfer.Request{File: programtransfer.File{Records: append(incomingParents, collections[tc.incoming]...)}}
			preview, err := planProgramTransfer(snap, req, nil)
			if err != nil || (len(preview.Preview.Conflicts) > 0) != tc.wantConflict {
				t.Fatalf("unexpected topic collection review: %+v, %v", preview.Preview, err)
			}
			if tc.wantConflict {
				conflict := preview.Preview.Conflicts[0]
				if len(preview.Preview.Conflicts) != 1 || conflict.Field != "topics" || len(conflict.Choices) != 1 || conflict.Choices[0].Value != "local" {
					t.Fatalf("topic replacement must explicitly preserve the current collection: %+v", preview.Preview)
				}
				if _, err := planProgramTransfer(snap, req, map[string]string{conflict.Key: "incoming"}); !errors.Is(err, programtransfer.ErrInvalid) {
					t.Fatalf("unsupported collection replacement was accepted: %v", err)
				}
				preview, err = planProgramTransfer(snap, req, map[string]string{conflict.Key: "local"})
				if err != nil || len(preview.Preview.Conflicts) != 0 || preview.Preview.Summary.Create != 0 || preview.Preview.Summary.Update != 0 {
					t.Fatalf("local review must preserve the whole topic collection: %+v, %v", preview.Preview, err)
				}
			}
			creates, updates := 0, 0
			for _, change := range preview.Changes {
				if change.Local.Kind != "session_topic" || !change.Write {
					continue
				}
				if change.Existing {
					updates++
				} else {
					creates++
				}
			}
			if creates != tc.wantTopicCreates || updates != tc.wantTopicUpdates {
				t.Fatalf("topic writes create=%d update=%d, expected create=%d update=%d", creates, updates, tc.wantTopicCreates, tc.wantTopicUpdates)
			}
		})
	}
}

func TestProgramTransferPlanReusesAccountContactOriginWithoutBorrowingProgramBaseline(t *testing.T) {
	program := transferPlanRecord("program", map[string]any{"name": "Segundo programa", "status": "active"})
	incoming := transferPlanRecord("contact", map[string]any{"name": nil, "phone": nil, "email": nil, "additional_phones": []any{}})
	local := incoming
	local.ID = uuid.NewString()
	participant := transferPlanRecord("participant", map[string]any{"contact_id": incoming.ID, "status": "active"})
	link := transferLink{Kind: "contact", PortableID: incoming.ID, LocalID: local.ID}
	snap := transferSnapshot{Contacts: []programtransfer.Record{local}, ContactLinks: []transferLink{link}}
	req := programtransfer.Request{File: programtransfer.File{Records: []programtransfer.Record{program, incoming, participant}}}
	plan, err := planProgramTransfer(snap, req, nil)
	if err != nil || len(plan.Preview.Conflicts) != 0 || plan.Preview.Summary.Create != 2 || plan.Preview.Summary.Update != 0 {
		t.Fatalf("second Program duplicated a previously identified Contact: %+v, %v", plan.Preview, err)
	}
	for _, change := range plan.Changes {
		if change.Local.Kind == "contact" && (change.Local.ID != local.ID || !change.Existing || change.Write) {
			t.Fatal("account-global identity was not reused as a local Contact")
		}
		if change.Local.Kind == "participant" && programtransfer.String(change.Local.Fields, "contact_id") != local.ID {
			t.Fatal("second Program participation did not point to the canonical account Contact")
		}
	}
	if len(plan.Links) != 0 {
		t.Fatal("a link from another Program must not suppress saving the new Program's identity/baseline")
	}
	other := snap
	other.ContactLinks = nil
	if transferDigest(snap, req) == transferDigest(other, req) {
		t.Fatal("global contact identity changes must invalidate an existing preview")
	}
}

func TestProgramTransferPlanFusesIncomingPrimaryPhoneAndReplaysWithoutChange(t *testing.T) {
	const primary, incomingPhone = "51912345678", "51987654321"
	program := transferPlanRecord("program", map[string]any{"name": "Historia", "status": "active"})
	contact := transferPlanRecord("contact", map[string]any{"name": "Rosa", "phone": primary, "email": nil, "additional_phones": []any{}})
	incoming := contact
	incoming.Fields = copyTransferFields(contact.Fields)
	incoming.Fields["phone"] = "+51 987 654 321"
	incoming.Revisions = make(map[string]programtransfer.Revision, len(contact.Revisions))
	for field, rev := range contact.Revisions {
		incoming.Revisions[field] = rev
	}
	incoming.Revisions["phone"] = programtransfer.Extend(contact.Revisions["phone"])
	for _, foreignOwner := range []bool{false, true} {
		t.Run(map[bool]string{false: "compatible new phone", true: "phone owned by another Contact"}[foreignOwner], func(t *testing.T) {
			snap := transferSnapshot{Target: program.ID, Rows: []programtransfer.Record{program, contact}}
			for _, row := range snap.Rows {
				snap.Links = append(snap.Links, transferLink{Kind: row.Kind, PortableID: row.ID, LocalID: row.ID, Baseline: programtransfer.BaselineOf(row)})
			}
			if foreignOwner {
				snap.Contacts = []programtransfer.Record{transferPlanRecord("contact", map[string]any{"name": "Otra persona", "phone": incomingPhone, "email": nil, "additional_phones": []any{}})}
			}
			req := programtransfer.Request{File: programtransfer.File{Records: []programtransfer.Record{program, incoming}}}
			plan, err := planProgramTransfer(snap, req, nil)
			if err != nil {
				t.Fatal(err)
			}
			if foreignOwner {
				if len(plan.Preview.Conflicts) != 1 || plan.Preview.Conflicts[0].Field != "phone" || plan.Preview.Summary.Update != 0 {
					t.Fatalf("a phone already owned by another Contact must stay a review conflict: %+v", plan.Preview)
				}
				return
			}
			if len(plan.Preview.Conflicts) != 0 || plan.Preview.Summary.Update != 1 {
				t.Fatalf("compatible incoming primary must be fused, not discarded: %+v", plan.Preview)
			}
			var merged programtransfer.Record
			for _, change := range plan.Changes {
				if change.Local.Kind == "contact" {
					merged = change.Local
				}
			}
			phones, _ := merged.Fields["additional_phones"].([]any)
			if programtransfer.String(merged.Fields, "phone") != primary || len(phones) != 1 || programtransfer.String(phones[0].(map[string]any), "phone") != incomingPhone {
				t.Fatal("fusion did not preserve the receiving primary plus the new normalized extra phone")
			}
			if merged.Revisions["additional_phones"].ID == contact.Revisions["additional_phones"].ID || !programtransfer.Descends(merged.Revisions["phone"], incoming.Revisions["phone"]) {
				t.Fatal("changed phone collection needs a fresh revision and acknowledgment of the incoming phone")
			}
			snap.Rows[1] = merged
			snap.Links[1].Baseline = programtransfer.BaselineOf(merged)
			replay, err := planProgramTransfer(snap, req, nil)
			if err != nil || len(replay.Preview.Conflicts) != 0 || replay.Preview.Summary.Update != 0 || replay.Preview.Summary.Create != 0 {
				t.Fatalf("replay should neither add another phone nor reopen its decision: %+v, %v", replay.Preview, err)
			}
		})
	}
}

type programTransferQuotaTestQuery func(string, []any) pgx.Row

func (q programTransferQuotaTestQuery) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	return q(sql, args)
}

type programTransferTargetTestRow struct {
	id  uuid.UUID
	err error
}

func (r programTransferTargetTestRow) Scan(dest ...any) error {
	if r.err == nil {
		*dest[0].(*uuid.UUID) = r.id
	}
	return r.err
}

func TestProgramTransferTargetLockUsesScopedParentWithoutReopeningClosedPrograms(t *testing.T) {
	account, program := uuid.New(), uuid.New()
	if err := lockProgramTransferTarget(context.Background(), nil, account, ""); err != nil {
		t.Fatalf("new Program imports have no existing parent to lock: %v", err)
	}
	for _, missing := range []bool{false, true} {
		calls := 0
		query := programTransferQuotaTestQuery(func(sql string, args []any) pgx.Row {
			calls++
			if sql != `SELECT id FROM programs WHERE account_id=$1 AND id=$2 AND type='course' FOR UPDATE` || len(args) != 2 || args[0] != account || args[1] != program {
				t.Fatal("target locking must use the receiving account and concrete class Program")
			}
			if missing {
				return programTransferTargetTestRow{err: pgx.ErrNoRows}
			}
			return programTransferTargetTestRow{id: program}
		})
		err := lockProgramTransferTarget(context.Background(), query, account, program.String())
		if calls != 1 || (err != nil) != missing || (missing && !errors.Is(err, pgx.ErrNoRows)) {
			t.Fatalf("parent lock result=%v, queries=%d", err, calls)
		}
	}
}

type programTransferQuotaTestRow func(*int64) error

func (r programTransferQuotaTestRow) Scan(dest ...any) error {
	return r(dest[0].(*int64))
}

func TestProgramTransferContactQuotaCountsDestinationAndFailsClosed(t *testing.T) {
	account := uuid.New()
	for _, tc := range []struct {
		name                     string
		incoming, maximum        int
		existing                 int64
		lookupErr, countErr      error
		wantCount, wantRejection bool
	}{
		{name: "no new contacts", lookupErr: errors.New("unavailable")},
		{name: "unlimited", incoming: 2},
		{name: "unknown plan", incoming: 1, lookupErr: errors.New("unavailable"), wantRejection: true},
		{name: "batch exceeds cap", incoming: 2, maximum: 1, wantRejection: true},
		{name: "exact cap", incoming: 2, maximum: 4, existing: 2, wantCount: true},
		{name: "over cap", incoming: 2, maximum: 4, existing: 3, wantCount: true, wantRejection: true},
		{name: "unavailable count", incoming: 1, maximum: 4, countErr: errors.New("unavailable"), wantCount: true, wantRejection: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			counter := programTransferQuotaTestQuery(func(sql string, args []any) pgx.Row {
				calls++
				if sql != `SELECT COUNT(*) FROM contacts WHERE account_id=$1` || len(args) != 1 || args[0] != account {
					t.Fatal("quota count must be scoped to the receiving account")
				}
				return programTransferQuotaTestRow(func(dest *int64) error {
					*dest = tc.existing
					return tc.countErr
				})
			})
			err := enforceProgramTransferContactQuota(context.Background(), counter, account, ProgramTransferContactQuota{Maximum: tc.maximum, LookupErr: tc.lookupErr}, tc.incoming)
			if (err != nil && !errors.Is(err, programtransfer.ErrContactLimit)) || (err != nil) != tc.wantRejection || calls > 1 || (calls == 1) != tc.wantCount {
				t.Fatalf("quota result=%v, counts=%d", err, calls)
			}
		})
	}
}
