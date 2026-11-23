package programtransfer

import (
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestProgramTransferCausalMerge(t *testing.T) {
	base := Extend()
	left := Extend(base)
	right := Extend(base)
	if value, _, conflict := MergeField("present", "late", left, base); value != "present" || conflict {
		t.Fatalf("old package would revert a local attendance: %v, conflicted=%v", value, conflict)
	}
	if value, rev, conflict := MergeField("late", "absent", base, right); value != "absent" || rev.ID != right.ID || conflict {
		t.Fatalf("unilateral attendance change did not travel: %v, conflicted=%v", value, conflict)
	}
	if value, _, conflict := MergeField("present", "absent", left, right); value != "present" || !conflict {
		t.Fatalf("independent edits need review: %v, conflicted=%v", value, conflict)
	}
	resolved := Extend(left, right)
	if value, _, conflict := MergeField("absent", "present", right, resolved); value != "present" || conflict {
		t.Fatalf("reviewed choice should travel without reopening the conflict: %v, conflicted=%v", value, conflict)
	}
	if _, _, conflict := MergeField("present", "absent", right, right); !conflict {
		t.Fatal("identical version IDs must not mask different values")
	}
}

func TestProgramTransferValidationRejectsUnscopedReferencesAndAuthority(t *testing.T) {
	program := Record{Kind: "program", ID: uuid.NewString(), Fields: map[string]any{
		"name": "Clase", "description": nil, "status": "active", "archived_from_status": nil, "color": "#10b981",
		"schedule_start_date": nil, "schedule_end_date": nil, "schedule_days": []any{}, "schedule_start_time": nil, "schedule_end_time": nil, "health_view_columns": nil,
	}}
	withRevisions := func(r Record) Record {
		r.Revisions = map[string]Revision{}
		for key := range r.Fields {
			r.Revisions[key] = Extend()
		}
		return r
	}
	program = withRevisions(program)
	file := File{Version: Version, Records: []Record{program}}
	if err := ValidateFile(file); err != nil {
		t.Fatal(err)
	}
	file.Records = append(file.Records, withRevisions(Record{Kind: "participant", ID: uuid.NewString(), Fields: map[string]any{
		"contact_id": uuid.NewString(), "status": "active", "enrolled_at": "2026-10-01", "dropped_at": nil,
		"drop_reason": "", "drop_notes": "", "completed_at": nil, "transferred_to_level": "", "transferred_at": nil,
	}}))
	if !errors.Is(ValidateFile(file), ErrInvalid) {
		t.Fatal("accepted a foreign contact reference")
	}
	file.Records = file.Records[:1]
	program.Fields["account_id"] = uuid.NewString()
	program.Revisions["account_id"] = Extend()
	if !errors.Is(ValidateFile(file), ErrInvalid) {
		t.Fatal("accepted unportable server authority")
	}
}
