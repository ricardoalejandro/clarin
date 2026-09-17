package database

import (
	"strings"
	"testing"
)

func TestProgramAttendanceStatusConstraintMigrationIsIdempotentAndCanonical(t *testing.T) {
	required := []string{
		"program_attendance_status_v2_check",
		"DROP CONSTRAINT IF EXISTS program_attendance_status_check",
		"ADD CONSTRAINT program_attendance_status_v2_check",
		"status IS NULL",
		"'confirmed'",
		"'present'",
		"'absent'",
		"'late'",
	}
	for _, fragment := range required {
		if !strings.Contains(programAttendanceStatusConstraintMigration, fragment) {
			t.Fatalf("attendance status migration missing %q", fragment)
		}
	}
	if strings.Contains(programAttendanceStatusConstraintMigration, "'excused'") {
		t.Fatal("attendance status constraint must not restore the removed excused state")
	}
	if strings.Count(programAttendanceStatusConstraintMigration, "ADD CONSTRAINT program_attendance_status_v2_check") != 1 {
		t.Fatal("attendance status migration must create one versioned canonical constraint")
	}
}
