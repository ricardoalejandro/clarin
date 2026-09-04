package repository

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestNormalizeRoleWriteErrorRecognizesExactNameConstraints(t *testing.T) {
	t.Parallel()
	for _, constraint := range []string{"roles_name_key", "uq_roles_name_normalized"} {
		err := normalizeRoleWriteError(&pgconn.PgError{Code: "23505", ConstraintName: constraint})
		if !errors.Is(err, ErrRoleNameTaken) {
			t.Fatalf("constraint %q error = %v, want ErrRoleNameTaken", constraint, err)
		}
	}
	other := &pgconn.PgError{Code: "23505", ConstraintName: "roles_pkey"}
	if got := normalizeRoleWriteError(other); got != other {
		t.Fatalf("unrelated constraint was rewritten: %v", got)
	}
}
