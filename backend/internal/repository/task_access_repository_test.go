package repository

import (
	"errors"
	"strings"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestTaskAccessRankAndValidation(t *testing.T) {
	t.Parallel()
	tests := []struct {
		level string
		rank  int
		valid bool
	}{
		{level: "none", rank: 0, valid: true},
		{level: " VIEW ", rank: 1, valid: true},
		{level: "comment", rank: 2, valid: true},
		{level: "edit", rank: 3, valid: true},
		{level: "full", rank: 4, valid: true},
		{level: "owner", rank: 0, valid: false},
		{level: "", rank: 0, valid: false},
	}
	for _, test := range tests {
		test := test
		t.Run(strings.TrimSpace(test.level), func(t *testing.T) {
			t.Parallel()
			if got := taskAccessRank(test.level); got != test.rank {
				t.Fatalf("taskAccessRank(%q)=%d, want %d", test.level, got, test.rank)
			}
			if got := validTaskAccessLevel(test.level); got != test.valid {
				t.Fatalf("validTaskAccessLevel(%q)=%v, want %v", test.level, got, test.valid)
			}
		})
	}
}

func TestBuildTaskEffectiveAccessCapabilities(t *testing.T) {
	t.Parallel()
	tests := []struct {
		level                            string
		manage                           bool
		view, comment, edit, delete, acl bool
	}{
		{level: domain.TaskAccessNone},
		{level: domain.TaskAccessView, view: true},
		{level: domain.TaskAccessComment, view: true, comment: true},
		{level: domain.TaskAccessEdit, view: true, comment: true, edit: true},
		{level: domain.TaskAccessFull, view: true, comment: true, edit: true, delete: true},
		{level: domain.TaskAccessFull, manage: true, view: true, comment: true, edit: true, delete: true, acl: true},
		// Manage-access is never meaningful below Full.
		{level: domain.TaskAccessEdit, manage: true, view: true, comment: true, edit: true},
	}
	for _, test := range tests {
		access := buildTaskEffectiveAccess(test.level, test.manage, "test")
		if access.CanView != test.view || access.CanComment != test.comment || access.CanEdit != test.edit ||
			access.CanDelete != test.delete || access.CanManageAccess != test.acl {
			t.Fatalf("level=%s manage=%v produced %#v", test.level, test.manage, access)
		}
	}
	invalid := buildTaskEffectiveAccess("owner", true, "test")
	if invalid.Level != domain.TaskAccessNone || invalid.CanView || invalid.CanManageAccess {
		t.Fatalf("invalid access was not reduced to none: %#v", invalid)
	}
}

func TestTaskAccessAllowsUsesOrderedCapabilities(t *testing.T) {
	t.Parallel()
	edit := buildTaskEffectiveAccess(domain.TaskAccessEdit, false, "test")
	if !TaskAccessAllows(edit, domain.TaskAccessView) || !TaskAccessAllows(edit, domain.TaskAccessComment) || !TaskAccessAllows(edit, domain.TaskAccessEdit) {
		t.Fatal("edit access did not satisfy lower capabilities")
	}
	if TaskAccessAllows(edit, domain.TaskAccessFull) || TaskAccessAllows(nil, domain.TaskAccessView) {
		t.Fatal("access ordering allowed a stronger or nil capability")
	}
}

func TestTaskActorAccessSQLHonorsRootGrantAndPrivateMode(t *testing.T) {
	t.Parallel()
	sql := taskActorAccessRankSQL("task", "list_item", "$3")
	for _, invariant := range []string{
		"task_access_grants",
		"COALESCE(task.parent_task_id,task.id)",
		"root.access_mode",
		"='private' THEN 'none'",
		"task_environment_grants",
		"task_folder_access_grants",
		"task_list_access_grants",
		"environment.default_access_level",
	} {
		if !strings.Contains(sql, invariant) {
			t.Fatalf("actor access SQL lost invariant %q:\n%s", invariant, sql)
		}
	}
}

func TestContainerAccessSQLIsFullyFormatted(t *testing.T) {
	t.Parallel()
	for name, sql := range map[string]string{
		"folder_rank":   taskActorFolderAccessRankSQL("folder", "$2"),
		"folder_manage": taskActorFolderCanManageSQL("folder", "$2"),
		"list_rank":     taskActorListAccessRankSQL("list_item", "$2"),
		"list_manage":   taskActorListCanManageSQL("list_item", "$2"),
	} {
		if strings.Contains(sql, "%!") {
			t.Fatalf("%s SQL has an unresolved format argument:\n%s", name, sql)
		}
		if !strings.Contains(sql, "task_environment_grants") || !strings.Contains(sql, "user_id=$2") {
			t.Fatalf("%s SQL lost actor-scoped Entorno inheritance:\n%s", name, sql)
		}
	}
}

func stringPointer(value string) *string { return &value }
func boolPointer(value bool) *bool       { return &value }

func TestResolveTaskHierarchyAccessRequiresEnvironmentView(t *testing.T) {
	t.Parallel()
	access, folderVisible, listVisible := resolveTaskHierarchyAccess(taskHierarchyAccessState{
		EnvironmentLevel:  domain.TaskAccessNone,
		EnvironmentSource: "environment_private",
		TaskMode:          "private",
		TaskLevel:         stringPointer(domain.TaskAccessFull),
		TaskManage:        boolPointer(true),
	})
	if access.CanView || folderVisible || listVisible || access.InheritedFrom != "environment_required" {
		t.Fatalf("a child grant bypassed the Entorno boundary: %#v folder=%v list=%v", access, folderVisible, listVisible)
	}
}

func TestResolveTaskHierarchyAccessUsesMostSpecificGrant(t *testing.T) {
	t.Parallel()
	access, folderVisible, listVisible := resolveTaskHierarchyAccess(taskHierarchyAccessState{
		EnvironmentLevel:  domain.TaskAccessView,
		EnvironmentSource: "environment_grant",
		FolderMode:        "inherit",
		FolderLevel:       stringPointer(domain.TaskAccessNone),
		ListMode:          "private",
		TaskMode:          "inherit",
		TaskLevel:         stringPointer(domain.TaskAccessEdit),
	})
	if access.Level != domain.TaskAccessEdit || access.InheritedFrom != "task_grant" {
		t.Fatalf("task grant did not override a denied parent: %#v", access)
	}
	if folderVisible || listVisible {
		t.Fatalf("hidden parents unexpectedly became visible: folder=%v list=%v", folderVisible, listVisible)
	}
}

func TestResolveTaskHierarchyAccessListCanOverrideFolderDeny(t *testing.T) {
	t.Parallel()
	access, folderVisible, listVisible := resolveTaskHierarchyAccess(taskHierarchyAccessState{
		EnvironmentLevel:  domain.TaskAccessView,
		EnvironmentSource: "environment_default",
		FolderMode:        "inherit",
		FolderLevel:       stringPointer(domain.TaskAccessNone),
		ListMode:          "inherit",
		ListLevel:         stringPointer(domain.TaskAccessComment),
		TaskMode:          "inherit",
	})
	if access.Level != domain.TaskAccessComment || access.InheritedFrom != "list_grant" || folderVisible || !listVisible {
		t.Fatalf("list override resolved incorrectly: %#v folder=%v list=%v", access, folderVisible, listVisible)
	}
}

func TestOrdinaryTaskVisibilityRequiresActiveEnvironment(t *testing.T) {
	t.Parallel()
	sql := taskActorCanViewSQL("task", "list_item", "$3")
	for _, invariant := range []string{"task_environments active_environment", "active_environment.archived_at IS NULL", "list_item.environment_id"} {
		if !strings.Contains(sql, invariant) {
			t.Fatalf("ordinary visibility SQL lost invariant %q:\n%s", invariant, sql)
		}
	}
	archiveSQL := taskActorCanViewIncludingArchivedSQL("task", "list_item", "$3")
	if strings.Contains(archiveSQL, "archived_at") {
		t.Fatalf("explicit archive visibility unexpectedly rejected archived environments:\n%s", archiveSQL)
	}
}

func TestOrdinaryTaskResolverHidesTrash(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_access_repository.go")
	for _, invariant := range []string{
		"resolveTaskAccessWithState(ctx, q, accountID, userID, taskID, false)",
		"task.deleted_at IS NULL AND root.deleted_at IS NULL",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("ordinary task resolver no longer hides Trash invariant %q", invariant)
		}
	}
	edgeSource := readRepositorySource(t, "task_acl_edge_repository.go")
	if !strings.Contains(edgeSource, "resolveTaskAccessWithState(ctx, tx, accountID, actorID, taskID, includeDeleted)") {
		t.Fatal("explicit Trash resolver no longer opts into deleted task ACLs")
	}
}

func TestTaskAccessBatchSQLResolvesOneWholePage(t *testing.T) {
	t.Parallel()
	sql := taskAccessBatchSQL()
	for _, invariant := range []string{
		"task.id=ANY($2::uuid[])",
		"task_environment_grants",
		"task_access_grants",
		"task_folder_access_grants",
		"task_list_access_grants",
		"environment.archived_at IS NULL",
	} {
		if !strings.Contains(sql, invariant) {
			t.Fatalf("batch task access SQL lost invariant %q:\n%s", invariant, sql)
		}
	}
	if strings.Contains(sql, "task.id=$2") || strings.Contains(sql, "task.id=$3") {
		t.Fatalf("batch task access SQL regressed to one task per query:\n%s", sql)
	}
}

func TestParticipantGrantConfirmationCannotBypassEnvironment(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_participant_access_repository.go")
	for _, invariant := range []string{
		"JOIN task_lists list_item",
		"environmentActorAccessRankSQL(\"environment\", \"membership.user_id\")",
		"environmentViewerCount != len(affected)",
		"return ErrTaskAccessInvalid",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("participant grant confirmation lost Entorno boundary %q", invariant)
		}
	}
}

func TestArchivedEnvironmentIsHiddenFromOrdinaryWork(t *testing.T) {
	t.Parallel()
	if err := requireTaskEnvironmentActive(true); err != nil {
		t.Fatalf("active environment was rejected: %v", err)
	}
	if err := requireTaskEnvironmentActive(false); !errors.Is(err, ErrTaskWorkNotFound) {
		t.Fatalf("archived environment error=%v, want ErrTaskWorkNotFound", err)
	}
}

func TestNormalizeTaskEnvironmentPage(t *testing.T) {
	t.Parallel()
	for input, want := range map[int]int{-1: 50, 0: 50, 1: 1, 50: 50, 200: 200, 201: 50} {
		if got := normalizeTaskEnvironmentPage(input); got != want {
			t.Fatalf("normalizeTaskEnvironmentPage(%d)=%d, want %d", input, got, want)
		}
	}
}
