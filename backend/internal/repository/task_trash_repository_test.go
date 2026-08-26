package repository

import (
	"strings"
	"testing"
	"time"
)

func TestTaskTrashEligibilityUsesArchiveTimestampOnly(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	days := 30
	archived := now.Add(-30 * 24 * time.Hour)
	next, eligible := trashEligibility(archived, &days, now)
	if next == nil || !next.Equal(now) || !eligible {
		t.Fatalf("boundary eligibility = next %v eligible %v, want exact and eligible", next, eligible)
	}
	archived = archived.Add(time.Second)
	next, eligible = trashEligibility(archived, &days, now)
	if next == nil || eligible {
		t.Fatalf("early eligibility = next %v eligible %v, want not eligible", next, eligible)
	}
}

func TestTaskTrashEligibilityNever(t *testing.T) {
	next, eligible := trashEligibility(time.Now().Add(-10*365*24*time.Hour), nil, time.Now())
	if next != nil || eligible {
		t.Fatalf("never policy = next %v eligible %v", next, eligible)
	}
}

func TestTaskTrashProjectionUsesEffectiveHierarchyAndRedactsHiddenParents(t *testing.T) {
	t.Parallel()
	locationSQL := taskTrashLocationViewCanViewSQL("location_view", "$2")
	for _, invariant := range []string{
		"task_environment_grants",
		"task_folder_access_grants",
		"task_list_access_grants",
		"trash_location_folder",
		"trash_location_list",
		"user_id=$2",
	} {
		if !strings.Contains(locationSQL, invariant) {
			t.Fatalf("contextual Trash count lost actor hierarchy invariant %q:\n%s", invariant, locationSQL)
		}
	}
	membershipSQL := taskActorAccountMembershipSQL("list_item", "$2")
	if !strings.Contains(membershipSQL, "trash_membership.account_id=list_item.account_id") ||
		!strings.Contains(membershipSQL, "trash_membership.user_id=$2") {
		t.Fatalf("Trash projection lost account membership boundary: %s", membershipSQL)
	}

	source := readRepositorySource(t, "task_trash_repository.go")
	start := strings.Index(source, "func (r *TaskWorkRepository) ListTrashContainers(")
	end := strings.Index(source, "func (r *TaskWorkRepository) TrashListConfirmed(")
	if start < 0 || end <= start {
		t.Fatal("ListTrashContainers source bounds changed")
	}
	body := source[start:end]
	for _, invariant := range []string{
		"actor_access.folder_rank>=4",
		"actor_access.list_rank>=4",
		"COUNT(DISTINCT list_item.id) FILTER",
		"taskActorCanViewIncludingArchivedSQL",
		"CASE WHEN actor_access.folder_rank>=1 THEN folder.id END",
		"CASE WHEN actor_access.folder_rank>=1 THEN COALESCE(folder.name,'') ELSE '' END",
		"folder.id IS NOT NULL,folder.deleted_at",
	} {
		if !strings.Contains(body, invariant) {
			t.Fatalf("Trash projection lost invariant %q", invariant)
		}
	}
	if strings.Contains(body, "environmentActorAccessRankSQL(\"environment\", \"$2\")") {
		t.Fatal("Trash containers regressed to Entorno-only authorization")
	}
}

func TestWorkAndWhiteboardPurgeUseCanonicalAccountThenActorLockOrder(t *testing.T) {
	t.Parallel()
	taskTrashSource := readRepositorySource(t, "task_trash_repository.go")
	accountGate := sourceFunctionBody(t, taskTrashSource,
		"func lockTaskPurgeAccountTx(", "func lockWhiteboardTrashPolicy(")
	if !strings.Contains(accountGate, "SELECT id FROM accounts WHERE id=$1 FOR UPDATE") ||
		!strings.Contains(accountGate, "return ErrTaskWorkNotFound") {
		t.Fatal("Work purge account gate must lock the account row and preserve a generic 404")
	}
	for _, policyColumn := range []string{"task_trash_retention_days", "whiteboard_trash_retention_days"} {
		if strings.Contains(accountGate, policyColumn) {
			t.Fatalf("pre-authorization account gate exposed retention policy %q", policyColumn)
		}
	}

	for _, test := range []struct {
		name, start, end, resource string
		needsWhiteboardPolicy      bool
	}{
		{"task", "func (r *TaskWorkRepository) PurgeTask(", "func (r *TaskWorkRepository) PurgeList(", "lockAndRequireDeletedTaskAccessTx(", false},
		{"list", "func (r *TaskWorkRepository) PurgeList(", "func (r *TaskWorkRepository) PurgeFolder(", "SELECT name,deleted_at,is_default,environment_id FROM task_lists", true},
		{"folder", "func (r *TaskWorkRepository) PurgeFolder(", "func (r *TaskWorkRepository) PurgeEnvironment(", "SELECT name,deleted_at,environment_id FROM task_folders", true},
		{"environment", "func (r *TaskWorkRepository) PurgeEnvironment(", "func (r *TaskWorkRepository) ClaimTaskMediaGCJob(", "SELECT name,deleted_at,is_default FROM task_environments", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := sourceFunctionBody(t, taskTrashSource, test.start, test.end)
			account := strings.Index(body, "lockTaskPurgeAccountTx(")
			actor := strings.Index(body, "lockAndRequireTaskAccountAdminTx(")
			taskPolicy := strings.Index(body, "lockTrashPolicy(")
			resource := strings.Index(body, test.resource)
			if account < 0 || actor <= account || taskPolicy <= actor || resource <= taskPolicy {
				t.Fatalf("%s purge lost account -> actor -> policy -> resource order", test.name)
			}
			whiteboardPolicy := strings.Index(body, "lockWhiteboardTrashPolicy(")
			if test.needsWhiteboardPolicy {
				if whiteboardPolicy <= taskPolicy || resource <= whiteboardPolicy {
					t.Fatalf("%s purge lost account -> actor -> task policy -> whiteboard policy -> resource order", test.name)
				}
			} else if whiteboardPolicy >= 0 {
				t.Fatalf("%s purge unexpectedly reads the whiteboard policy", test.name)
			}
		})
	}

	for _, test := range []struct{ file, start, end string }{
		{"task_location_view_repository.go", "func (r *TaskLocationViewRepository) Create(", "func (r *TaskLocationViewRepository) Update("},
		{"task_location_view_duplicate_repository.go", "func (r *TaskLocationViewRepository) Duplicate(", ""},
	} {
		body := whiteboardActorMutationBody(t, test.file, test.start, test.end)
		account := strings.Index(body, "lockActiveWhiteboardTenantTx(")
		actor := strings.Index(body, "lockTaskLocationViewActorMembershipTx(")
		if account < 0 || actor <= account {
			t.Fatalf("%s lost account -> actor lock order", test.start)
		}
	}

	boardPurge := whiteboardActorMutationBody(t, "whiteboard_trash_repository.go",
		"func (r *WhiteboardRepository) PurgeBoard(", "")
	account := strings.Index(boardPurge, "FROM accounts")
	actor := strings.Index(boardPurge, "lockWhiteboardActorMembershipsTx(")
	if account < 0 || actor <= account {
		t.Fatal("whiteboard purge lost account -> actor lock order")
	}
}
