package repository

import (
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskEnvironmentUpdateSQLUsesOnePostgreSQLTypePerReusedParameter(t *testing.T) {
	t.Parallel()
	for _, fragment := range []string{
		"visibility=$8::varchar",
		"default_access_level=$9::varchar",
		"visibility IS DISTINCT FROM $8::varchar",
		"default_access_level IS DISTINCT FROM $9::varchar",
	} {
		if !strings.Contains(taskEnvironmentUpdateSQL, fragment) {
			t.Fatalf("environment update SQL is missing stable parameter cast %q:\n%s", fragment, taskEnvironmentUpdateSQL)
		}
	}
	if strings.Contains(taskEnvironmentUpdateSQL, "$8::text") || strings.Contains(taskEnvironmentUpdateSQL, "$9::text") {
		t.Fatalf("environment update SQL mixes varchar and text inference:\n%s", taskEnvironmentUpdateSQL)
	}
}

func TestTaskEnvironmentWriteErrorMapsOnlyActiveNameConflict(t *testing.T) {
	t.Parallel()
	conflict := &pgconn.PgError{Code: "23505", ConstraintName: "uq_task_environments_active_name"}
	if !errors.Is(taskEnvironmentWriteError(conflict), ErrTaskEnvironmentNameConflict) {
		t.Fatal("active environment name collision was not mapped to its domain conflict")
	}
	other := &pgconn.PgError{Code: "23505", ConstraintName: "another_constraint"}
	if taskEnvironmentWriteError(other) != other {
		t.Fatal("unrelated PostgreSQL error was unexpectedly rewritten")
	}
}
