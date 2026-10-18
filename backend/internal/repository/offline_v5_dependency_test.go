package repository

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestOfflineV5WhiteboardDependencyRebasesDispatchWithoutChangingReceiptIntent(t *testing.T) {
	operation := domain.OfflineV5Operation{Action: domain.OfflineV5ActionBoardsScene, BaseVersion: 2,
		Payload: json.RawMessage(`{"expected_sequence":2,"scene":{"elements":[]},"patch":{"client_base_sequence":2,"elements":[]}}`)}
	before, _ := offlineV5OperationIntentHash(operation)
	dispatch, err := offlineV5DispatchAfterDependency(operation, 3)
	if err != nil || dispatch.BaseVersion != 3 {
		t.Fatalf("dispatch rebase failed: %+v %v", dispatch, err)
	}
	var payload struct {
		Expected int64 `json:"expected_sequence"`
		Patch    struct {
			Base int64 `json:"client_base_sequence"`
		} `json:"patch"`
	}
	if json.Unmarshal(dispatch.Payload, &payload) != nil || payload.Expected != 3 || payload.Patch.Base != 3 {
		t.Fatalf("whiteboard wire preconditions did not follow predecessor: %s", dispatch.Payload)
	}
	after, _ := offlineV5OperationIntentHash(operation)
	if before != after || operation.BaseVersion != 2 {
		t.Fatal("rebasing changed the immutable receipt identity")
	}
	operation.Payload = json.RawMessage(`{"expected_sequence":99,"scene":{}}`)
	if _, err := offlineV5DispatchAfterDependency(operation, 3); err == nil {
		t.Fatal("invalid original sequence was accepted during rebase")
	}
}

func TestOfflineV5DependencyVersionUsesOnlySameCanonicalEntity(t *testing.T) {
	selection, resource := uuid.New(), uuid.New()
	operation := domain.OfflineV5Operation{SelectionID: selection, ResourceID: resource, Action: domain.OfflineV5ActionTasksUpdate, BaseVersion: 2}
	predecessor := offlineV5StoredReceipt{SelectionID: selection, ResourceID: resource, Action: domain.OfflineV5ActionTasksCreate, Status: "applied", ServerVersion: 5}
	if got := offlineV5DependencyBaseVersion(operation, predecessor); got != 5 {
		t.Fatalf("repeated task edit did not continue its predecessor: %d", got)
	}
	if operation.BaseVersion != 2 {
		t.Fatal("immutable wire command was changed")
	}
	for _, change := range []func(*offlineV5StoredReceipt){
		func(r *offlineV5StoredReceipt) { r.ResourceID = uuid.New() },
		func(r *offlineV5StoredReceipt) { r.SelectionID = uuid.New() },
		func(r *offlineV5StoredReceipt) { r.Status = "conflict" },
		func(r *offlineV5StoredReceipt) { r.Action = domain.OfflineV5ActionTasksComment },
		func(r *offlineV5StoredReceipt) { r.ServerVersion = 0 },
	} {
		other := predecessor
		change(&other)
		if got := offlineV5DependencyBaseVersion(operation, other); got != 2 {
			t.Fatalf("foreign/rejected/other entity version accepted: %+v", other)
		}
	}
}

func TestOfflineV5DependentMergeStillDetectsConcurrentServerChanges(t *testing.T) {
	base := offlineV5TaskCurrent(&domain.Task{Title: "First local edit"})
	local := offlineV5TaskCurrent(&domain.Task{Title: "Second local edit"})
	server := offlineV5TaskCurrent(&domain.Task{Title: "Remote edit after first receipt"})
	if _, conflict := offlineV5MergePatch(5, 6, base, local, server); conflict == nil {
		t.Fatal("a new server edit was silently overwritten after dependency rebasing")
	}
}

func TestOfflineV5DependencyAttendanceRequiresExactSessionIncludingClearedMark(t *testing.T) {
	selection, resource, session := uuid.New(), uuid.New(), uuid.New()
	payload, _ := json.Marshal(map[string]any{"session_id": session})
	operation := domain.OfflineV5Operation{SelectionID: selection, ResourceID: resource, Action: domain.OfflineV5ActionProgramsAttendance, BaseVersion: 2, Payload: payload}
	predecessor := offlineV5StoredReceipt{SelectionID: selection, ResourceID: resource, Action: operation.Action, Status: "applied", ServerVersion: 5}
	for _, version := range []int64{5, 0} {
		for _, sameSession := range []bool{true, false} {
			previousSession := session
			if !sameSession {
				previousSession = uuid.New()
			}
			result, _ := json.Marshal(map[string]any{"session_id": previousSession})
			predecessor.Result, _ = json.Marshal(domain.OfflineV5OperationResult{Result: result})
			predecessor.ServerVersion = version
			want := operation.BaseVersion
			if sameSession {
				want = version
			}
			if got := offlineV5DependencyBaseVersion(operation, predecessor); got != want {
				t.Fatalf("attendance sameSession=%v version=%d: got %d want %d", sameSession, version, got, want)
			}
		}
	}
}

func TestOfflineV5DependencyProgramVersionsRemainInTheirCanonicalFamily(t *testing.T) {
	selection, resource := uuid.New(), uuid.New()
	for _, actions := range [][2]string{
		{domain.OfflineV5ActionProgramsParticipantLifecycle, domain.OfflineV5ActionProgramsParticipantAdd},
		{domain.OfflineV5ActionProgramsParticipantLifecycle, domain.OfflineV5ActionProgramsParticipantLifecycle},
		{domain.OfflineV5ActionProgramsGoals, domain.OfflineV5ActionProgramsGoals},
	} {
		operation := domain.OfflineV5Operation{SelectionID: selection, ResourceID: resource, Action: actions[0], BaseVersion: 2}
		predecessor := offlineV5StoredReceipt{SelectionID: selection, ResourceID: resource, Action: actions[1], Status: "applied", ServerVersion: 5}
		if got := offlineV5DependencyBaseVersion(operation, predecessor); got != 5 {
			t.Fatalf("same family %v: %d", actions, got)
		}
		predecessor.Action = domain.OfflineV5ActionProgramsUpdate
		if got := offlineV5DependencyBaseVersion(operation, predecessor); got != 2 {
			t.Fatal("program metadata version leaked to dependent row")
		}
	}
}
