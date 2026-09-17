package repository

import (
	"os"
	"strings"
	"testing"
)

func readProgramRepositorySource(t *testing.T) string {
	t.Helper()
	contents, err := os.ReadFile("program_repository.go")
	if err != nil {
		t.Fatalf("read program repository source: %v", err)
	}
	return string(contents)
}

func TestProgramFolderQueriesRequireAccountBoundary(t *testing.T) {
	t.Parallel()

	queries := map[string]string{
		"create": createProgramFolderQuery,
		"get":    getProgramFolderByIDQuery,
		"update": updateProgramFolderQuery,
		"move":   moveProgramToFolderQuery,
	}
	for name, query := range queries {
		query := query
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if !strings.Contains(query, "account_id = $1") && !strings.Contains(query, "account_id=$1") && !strings.Contains(query, "account_id = $2") {
				t.Fatalf("%s query lost its account boundary: %s", name, query)
			}
		})
	}

	for _, fragment := range []string{
		"program.account_id = $1",
		"folder.account_id = $1",
		"program.id = $2",
		"folder.id = $3::uuid",
	} {
		if !strings.Contains(moveProgramToFolderQuery, fragment) {
			t.Fatalf("program move query is missing %q", fragment)
		}
	}
	if strings.Contains(moveProgramToFolderQuery, "WHERE program.id = $2\n") {
		t.Fatal("program move must not authorize by program UUID alone")
	}
}

func TestProgramFolderDeleteStatementsStayAccountScoped(t *testing.T) {
	t.Parallel()

	source := readProgramRepositorySource(t)
	start := strings.Index(source, "func (r *ProgramFolderRepository) Delete")
	end := strings.Index(source[start:], "func (r *ProgramFolderRepository) MoveProgram")
	if start < 0 || end < 0 {
		t.Fatal("could not locate ProgramFolderRepository.Delete")
	}
	body := source[start : start+end]
	for _, fragment := range []string{
		"WHERE account_id = $1 AND id = $2",
		"WHERE account_id = $2 AND folder_id = $3",
		"WHERE account_id = $2 AND parent_id = $3",
		"DELETE FROM program_folders WHERE account_id = $1 AND id = $2",
		"tx.Commit(ctx)",
	} {
		if !strings.Contains(body, fragment) {
			t.Fatalf("account-scoped transactional delete is missing %q", fragment)
		}
	}
}
