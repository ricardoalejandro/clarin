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
