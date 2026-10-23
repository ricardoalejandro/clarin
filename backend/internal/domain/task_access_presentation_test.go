package domain

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestTaskAccessPresentationAliasesShareCanonicalCapabilities(t *testing.T) {
	t.Parallel()
	access := &TaskEffectiveAccess{
		Level:         TaskAccessEdit,
		CanView:       true,
		CanComment:    true,
		CanEdit:       true,
		InheritedFrom: "environment_grant",
	}
	environment := &TaskEnvironment{}
	environment.SetEffectiveAccess(access)
	list := &TaskList{}
	list.SetEffectiveAccess(access)
	folder := &TaskFolder{}
	folder.SetEffectiveAccess(access)
	task := &Task{}
	task.SetEffectiveAccess(access)

	for name, value := range map[string]any{
		"environment": environment,
		"list":        list,
		"folder":      folder,
		"task":        task,
	} {
		name, value := name, value
		t.Run(name, func(t *testing.T) {
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatalf("marshal actor-scoped DTO: %v", err)
			}
			var payload map[string]any
			if err := json.Unmarshal(encoded, &payload); err != nil {
				t.Fatalf("decode actor-scoped DTO: %v", err)
			}
			if payload["effective_access_level"] != TaskAccessEdit {
				t.Fatalf("effective access alias=%#v", payload["effective_access_level"])
			}
			canManage, exists := payload["can_manage_access"]
			if !exists || canManage != false {
				t.Fatalf("false governance capability must remain explicit: %#v", payload)
			}
			if !reflect.DeepEqual(payload["capabilities"], payload["permissions"]) {
				t.Fatalf("capabilities diverged from compatibility permissions: capabilities=%#v permissions=%#v",
					payload["capabilities"], payload["permissions"])
			}
		})
	}
}

func TestTaskContainerLifecycleCapabilitiesSeparateArchiveAndTrash(t *testing.T) {
	t.Parallel()
	full := func() *TaskEffectiveAccess { return &TaskEffectiveAccess{Level: TaskAccessFull, CanDelete: true} }

	closedList := &TaskList{TaskCount: 2, OpenTaskCount: 0}
	closedList.SetEffectiveAccess(full())
	closedList.SetLifecycle()
	if !closedList.Permissions.CanArchive || closedList.Permissions.CanTrash || closedList.Permissions.CanDelete {
		t.Fatalf("closed history should be archivable but not trashable: %#v", closedList.Permissions)
	}

	emptyList := &TaskList{}
	emptyList.SetEffectiveAccess(full())
	emptyList.SetLifecycle()
	if !emptyList.Permissions.CanArchive || !emptyList.Permissions.CanTrash || !emptyList.Permissions.CanDelete {
		t.Fatalf("empty active list should expose Archive and Trash with can_delete alias: %#v", emptyList.Permissions)
	}

	now := time.Now()
	archived := &TaskList{ArchivedAt: &now, TaskCount: 1}
	archived.SetEffectiveAccess(full())
	archived.SetLifecycle()
	if archived.Lifecycle != TaskLifecycleArchived || !archived.Permissions.CanRestore || archived.Permissions.CanTrash {
		t.Fatalf("retained historical list has incorrect lifecycle capabilities: %#v", archived)
	}
}

func TestTaskAccessPresentationOmitsAliasesWithoutActorScope(t *testing.T) {
	t.Parallel()
	task := &Task{}
	task.SetEffectiveAccess(nil)
	encoded, err := json.Marshal(task)
	if err != nil {
		t.Fatalf("marshal task without actor scope: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("decode task without actor scope: %v", err)
	}
	for _, key := range []string{"effective_access_level", "can_manage_access", "capabilities", "permissions"} {
		if _, exists := payload[key]; exists {
			t.Fatalf("unscoped DTO exposed %s: %#v", key, payload[key])
		}
	}
}

func TestTaskContainerLifecycleUsesPrivateFullTreeFactsWithoutLeakingCounts(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name       string
		facts      TaskContainerLifecycleConstraints
		canArchive bool
		canTrash   bool
	}{
		{"empty", TaskContainerLifecycleConstraints{}, true, true},
		{"hidden closed task", TaskContainerLifecycleConstraints{HasRetainedTasks: true}, true, false},
		{"hidden open subtask", TaskContainerLifecycleConstraints{HasRetainedTasks: true, HasOpenTasks: true}, false, false},
		{"past event", TaskContainerLifecycleConstraints{HasRetainedWorkEvents: true}, true, false},
		{"future event", TaskContainerLifecycleConstraints{HasRetainedWorkEvents: true, HasFutureWorkEvents: true}, false, false},
		{"restricted child list", TaskContainerLifecycleConstraints{RestrictedDescendants: true}, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			list := &TaskList{LifecycleConstraints: &test.facts}
			folder := &TaskFolder{LifecycleConstraints: &test.facts}
			environment := &TaskEnvironment{LifecycleConstraints: &test.facts}
			list.SetEffectiveAccess(&TaskEffectiveAccess{Level: TaskAccessFull})
			folder.SetEffectiveAccess(&TaskEffectiveAccess{Level: TaskAccessFull})
			environment.SetEffectiveAccess(&TaskEffectiveAccess{Level: TaskAccessFull})
			list.SetLifecycle()
			folder.SetLifecycle()
			environment.SetLifecycle()
			for kind, access := range map[string]*TaskEffectiveAccess{"list": list.Capabilities, "folder": folder.Capabilities, "environment": environment.Capabilities} {
				if access.CanArchive != test.canArchive || access.CanTrash != test.canTrash || access.CanDelete != test.canTrash {
					t.Fatalf("%s lifecycle capabilities = %#v, want archive=%t trash=%t", kind, access, test.canArchive, test.canTrash)
				}
			}
			for _, item := range []any{list, folder, environment} {
				encoded, err := json.Marshal(item)
				if err != nil {
					t.Fatal(err)
				}
				var payload map[string]any
				if err := json.Unmarshal(encoded, &payload); err != nil {
					t.Fatal(err)
				}
				if payload["task_count"] != float64(0) || payload["open_task_count"] != float64(0) {
					t.Fatalf("full-tree facts leaked through visible badges: %s", encoded)
				}
				for _, key := range []string{"LifecycleConstraints", "lifecycle_constraints", "HasRetainedTasks", "HasFutureWorkEvents"} {
					if _, ok := payload[key]; ok {
						t.Fatalf("internal lifecycle facts leaked as %s: %s", key, encoded)
					}
				}
			}
		})
	}
}
