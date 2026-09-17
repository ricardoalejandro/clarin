package repository

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

func TestOfflineV5ActionRegistryIsClosed(t *testing.T) {
	writes := []string{
		domain.OfflineV5ActionTasksCreate, domain.OfflineV5ActionTasksUpdate, domain.OfflineV5ActionTasksComplete,
		domain.OfflineV5ActionTasksReopen, domain.OfflineV5ActionTasksComment,
		domain.OfflineV5ActionContactsUpdate, domain.OfflineV5ActionContactsObserve,
		domain.OfflineV5ActionProgramsUpdate, domain.OfflineV5ActionProgramsParticipantAdd,
		domain.OfflineV5ActionProgramsParticipantLifecycle, domain.OfflineV5ActionProgramsSessionUpsert,
		domain.OfflineV5ActionProgramsAttendance, domain.OfflineV5ActionProgramsObservation, domain.OfflineV5ActionProgramsGoals,
		domain.OfflineV5ActionBoardsScene,
	}
	for _, action := range writes {
		if _, ok := OfflineV5ActionModule(action); !ok || !offlineV5MutationAction(action) {
			t.Fatalf("registered v5 write rejected: %s", action)
		}
	}
	for _, action := range []string{"", "tasks.delete", "contacts.http.replay", "programs.*", "whiteboards.asset.upload"} {
		if _, ok := OfflineV5ActionModule(action); ok || offlineV5MutationAction(action) {
			t.Fatalf("unregistered action accepted: %q", action)
		}
	}
	for _, action := range []string{domain.OfflineV5ActionTasksRead, domain.OfflineV5ActionContactsRead,
		domain.OfflineV5ActionProgramsRead, domain.OfflineV5ActionBoardsRead} {
		if _, ok := OfflineV5ActionModule(action); !ok || offlineV5MutationAction(action) {
			t.Fatalf("read capability treated as write: %s", action)
		}
	}
}

func TestOfflineV5KeyRegistrationDecisionIsRetryableBeforeFirstManifest(t *testing.T) {
	tests := []struct {
		name             string
		current, next    string
		manifestCount    int
		want             offlineV5KeyRegistrationMode
		wantKeyExistsErr bool
	}{
		{name: "initial registration", next: "key-a", want: offlineV5KeyRegister},
		{name: "same key retry", current: "key-a", next: "key-a", manifestCount: 2, want: offlineV5KeyReuse},
		{name: "recover stranded key", current: "key-old", next: "key-new", want: offlineV5KeyRecover},
		{name: "protect issued manifests", current: "key-old", next: "key-new", manifestCount: 1, wantKeyExistsErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := offlineV5KeyRegistrationDecision(test.current, test.next, test.manifestCount)
			if test.wantKeyExistsErr {
				if !errors.Is(err, ErrOfflineV3KeyExists) {
					t.Fatalf("expected key protection conflict, got mode=%q err=%v", got, err)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("decision=%q err=%v, want %q", got, err, test.want)
			}
		})
	}
}

func TestOfflineV5WhiteboardDescriptorsKeepLargeBinaryClosureOutOfJSON(t *testing.T) {
	accountID, boardID := uuid.New(), uuid.New()
	largeAsset := offlineV5WhiteboardStoredAsset{
		offlineV5WhiteboardAssetDescriptor: offlineV5WhiteboardAssetDescriptor{
			ID: uuid.New(), FileID: "large-file", ContentHash: strings.Repeat("c", 64), ContentType: "image/webp", SizeBytes: 26 << 20,
		},
		ObjectKey: storage.PrivateObjectKey(accountID, "whiteboards", boardID.String(), "assets", "large.webp"),
	}
	if _, err := offlineV5WhiteboardDescriptor(accountID, boardID, largeAsset); err != nil {
		t.Fatalf("a valid asset above the legacy 10 MB cap was rejected: %v", err)
	}
	var total int64
	for index := 0; index < 12; index++ {
		stored := offlineV5WhiteboardStoredAsset{
			offlineV5WhiteboardAssetDescriptor: offlineV5WhiteboardAssetDescriptor{
				ID: uuid.New(), FileID: "file-" + uuid.NewString(), ContentHash: domain.MediaAssetHashWhiteboardPrefix + strings.Repeat("a", 64),
				ContentType: "image/png", SizeBytes: 2_100_000,
			},
			ObjectKey: storage.PrivateObjectKey(accountID, "whiteboards", boardID.String(), "assets", uuid.NewString()+".png"),
		}
		descriptor, err := offlineV5WhiteboardDescriptor(accountID, boardID, stored)
		if err != nil {
			t.Fatalf("descriptor %d rejected: %v", index, err)
		}
		if descriptor.RootResourceID != boardID || strings.Contains(string(mustJSON(t, descriptor)), "data_base64") {
			t.Fatalf("descriptor %d leaked binary data or lost its root: %+v", index, descriptor)
		}
		total += descriptor.SizeBytes
	}
	if total <= 25_000_000 {
		t.Fatalf("test closure is not larger than 25 MB: %d", total)
	}

	base := offlineV5WhiteboardStoredAsset{
		offlineV5WhiteboardAssetDescriptor: offlineV5WhiteboardAssetDescriptor{ID: uuid.New(), FileID: "file", ContentHash: strings.Repeat("b", 64), ContentType: "image/png", SizeBytes: 10},
		ObjectKey:                          storage.PrivateObjectKey(accountID, "whiteboards", boardID.String(), "assets", "file.png"),
	}
	for name, mutate := range map[string]func(*offlineV5WhiteboardStoredAsset){
		"foreign account object": func(value *offlineV5WhiteboardStoredAsset) {
			value.ObjectKey = storage.PrivateObjectKey(uuid.New(), "whiteboards", boardID.String(), "assets", "file.png")
		},
		"executable mime": func(value *offlineV5WhiteboardStoredAsset) { value.ContentType = "image/svg+xml" },
		"invalid hash":    func(value *offlineV5WhiteboardStoredAsset) { value.ContentHash = "not-a-hash" },
		"invalid size":    func(value *offlineV5WhiteboardStoredAsset) { value.SizeBytes = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := base
			mutate(&candidate)
			if _, err := offlineV5WhiteboardDescriptor(accountID, boardID, candidate); err == nil {
				t.Fatal("manipulated descriptor was accepted")
			}
		})
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestOfflineV5TargetMustBeActiveIncludingSuperadmin(t *testing.T) {
	if !offlineV5EligibleTarget(true, false) {
		t.Fatal("active delegated user was rejected")
	}
	if !offlineV5EligibleTarget(true, true) {
		t.Fatal("active superadmin was rejected even though v5 grants are account and capability scoped")
	}
	for _, state := range []struct{ active, superadmin bool }{{false, false}, {false, true}} {
		if offlineV5EligibleTarget(state.active, state.superadmin) {
			t.Fatalf("inactive target accepted: %#v", state)
		}
	}
	source, err := os.ReadFile("offline_v5_repository.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if strings.Contains(text, "is_super_admin=FALSE") {
		t.Fatal("a live v5 grant path still excludes superadmin targets")
	}
	for _, liveBarrier := range []string{"target.is_active=TRUE", "u.is_active=TRUE", "offlineV5EligibleTarget(targetActive, targetSuperadmin)", "r.LockActiveGrantTx(ctx, tx, grantID)"} {
		if !strings.Contains(text, liveBarrier) {
			t.Fatalf("live active-target barrier missing: %s", liveBarrier)
		}
	}
	for _, capability := range offlineV5PotentialCapabilities([]string{
		domain.OfflineModuleTasks, domain.OfflineModuleContacts, domain.OfflineModulePrograms, domain.OfflineModuleWhiteboards,
	}, true) {
		if strings.HasPrefix(capability, "admin.") || strings.HasPrefix(capability, "superadmin.") {
			t.Fatalf("offline grant leaked global administration capability: %s", capability)
		}
	}
}

func TestOfflineV5SelectionsForModulesPreservesOnlyAuthorizedResources(t *testing.T) {
	contactID, taskListID, boardID := uuid.New(), uuid.New(), uuid.New()
	items := []domain.OfflineV3Selection{
		{ID: uuid.New(), Module: domain.OfflineModuleContacts, ResourceType: domain.OfflineResourceContact, ResourceID: contactID},
		{ID: uuid.New(), Module: domain.OfflineModuleTasks, ResourceType: domain.OfflineResourceTaskList, ResourceID: taskListID},
		{ID: uuid.New(), Module: domain.OfflineModuleWhiteboards, ResourceType: domain.OfflineResourceWhiteboard, ResourceID: boardID},
	}
	retained := offlineV5SelectionsForModules(items, []string{domain.OfflineModuleContacts, domain.OfflineModuleTasks})
	if len(retained) != 2 || retained[0].ResourceID != contactID || retained[1].ResourceID != taskListID {
		t.Fatalf("authorized selections were not preserved in stable order: %#v", retained)
	}
	if len(items) != 3 {
		t.Fatal("selection filtering mutated the caller's slice")
	}
}

func TestOfflineV5OperationBindingRejectsEveryForeignTupleDimension(t *testing.T) {
	now := time.Now().UTC()
	record := &OfflineV5AuthRecord{OfflineV4AuthRecord: &OfflineV4AuthRecord{OfflineV4Grant: domain.OfflineV4Grant{
		OfflineV4Tuple:    domain.OfflineV4Tuple{BrowserProfileID: uuid.New(), UserID: uuid.New(), AccountID: uuid.New(), GrantID: uuid.New()},
		SelectionRevision: 7, CredentialEpoch: 8, AuthorityEpoch: 9}}}
	manifest := &domain.OfflineV5Manifest{ID: uuid.New(), Revision: 4}
	operation := domain.OfflineV5Operation{ProtocolVersion: 5, BrowserProfileID: record.BrowserProfileID, GrantID: record.GrantID,
		UserID: record.UserID, AccountID: record.AccountID, ManifestID: manifest.ID, ManifestRevision: manifest.Revision,
		SelectionRevision: 7, CredentialEpoch: 8, AuthorityEpoch: 9, OperationID: uuid.New(), SelectionID: uuid.New(),
		Action: domain.OfflineV5ActionTasksUpdate, ResourceID: uuid.New(), BaseVersion: 1, Payload: json.RawMessage(`{"title":"x"}`), OccurredAt: now}
	if !offlineV5OperationBinding(record, manifest, operation, now) {
		t.Fatal("valid v5 tuple rejected")
	}
	cases := map[string]func(*domain.OfflineV5Operation){
		"browser":            func(value *domain.OfflineV5Operation) { value.BrowserProfileID = uuid.New() },
		"grant":              func(value *domain.OfflineV5Operation) { value.GrantID = uuid.New() },
		"user":               func(value *domain.OfflineV5Operation) { value.UserID = uuid.New() },
		"account":            func(value *domain.OfflineV5Operation) { value.AccountID = uuid.New() },
		"manifest":           func(value *domain.OfflineV5Operation) { value.ManifestID = uuid.New() },
		"manifest revision":  func(value *domain.OfflineV5Operation) { value.ManifestRevision++ },
		"selection revision": func(value *domain.OfflineV5Operation) { value.SelectionRevision++ },
		"credential epoch":   func(value *domain.OfflineV5Operation) { value.CredentialEpoch++ },
		"authority epoch":    func(value *domain.OfflineV5Operation) { value.AuthorityEpoch++ },
		"protocol":           func(value *domain.OfflineV5Operation) { value.ProtocolVersion = 4 },
		"unknown action":     func(value *domain.OfflineV5Operation) { value.Action = "tasks.delete" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			foreign := operation
			mutate(&foreign)
			if offlineV5OperationBinding(record, manifest, foreign, now) {
				t.Fatal("foreign/stale tuple accepted")
			}
		})
	}
}

func TestOfflineV5SupersededRetryCanOnlyRecoverExactReceipt(t *testing.T) {
	now := time.Now().UTC()
	manifestID, operationID, selectionID, resourceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	operation := domain.OfflineV5Operation{ProtocolVersion: domain.OfflineV5ProtocolVersion, BrowserProfileID: uuid.New(),
		GrantID: uuid.New(), UserID: uuid.New(), AccountID: uuid.New(), ManifestID: manifestID, ManifestRevision: 4,
		SelectionID: selectionID, SelectionRevision: 7, CredentialEpoch: 8, AuthorityEpoch: 9,
		OperationID: operationID, Action: domain.OfflineV5ActionTasksUpdate, ResourceID: resourceID, BaseVersion: 3,
		Base: json.RawMessage(`{"title":"before"}`), Payload: json.RawMessage(`{"title":"after"}`), OccurredAt: now}
	requestHash, err := offlineV5OperationRequestHash(operation)
	if err != nil {
		t.Fatal(err)
	}
	canonical := domain.OfflineV5OperationResult{OperationID: operationID, Status: "applied", ResourceID: resourceID, ServerVersion: 4,
		Result: json.RawMessage(`{"task":{"id":"` + resourceID.String() + `","title":"after","version":4}}`)}
	encoded, err := json.Marshal(canonical)
	if err != nil {
		t.Fatal(err)
	}
	stored := offlineV5StoredReceipt{ManifestID: manifestID, RequestHash: requestHash, Action: operation.Action,
		SelectionID: selectionID, ResourceID: resourceID, Status: canonical.Status, ServerVersion: canonical.ServerVersion, Result: encoded}
	recovered, err := offlineV5RecoveredReceipt(operation, requestHash, stored)
	if err != nil || recovered.OperationID != operationID || recovered.ServerVersion != 4 || recovered.Status != "applied" {
		t.Fatalf("exact committed receipt was not recoverable: result=%+v err=%v", recovered, err)
	}

	changed := operation
	changed.Payload = json.RawMessage(`{"title":"different retry"}`)
	changedHash, err := offlineV5OperationRequestHash(changed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = offlineV5RecoveredReceipt(changed, changedHash, stored); !errors.Is(err, ErrOfflineV3ReceiptReuse) {
		t.Fatalf("changed command reused a committed operation id: %v", err)
	}

	for name, mutate := range map[string]func(*offlineV5StoredReceipt){
		"manifest":  func(value *offlineV5StoredReceipt) { value.ManifestID = uuid.New() },
		"action":    func(value *offlineV5StoredReceipt) { value.Action = domain.OfflineV5ActionTasksComplete },
		"selection": func(value *offlineV5StoredReceipt) { value.SelectionID = uuid.New() },
		"resource":  func(value *offlineV5StoredReceipt) { value.ResourceID = uuid.New() },
	} {
		t.Run(name, func(t *testing.T) {
			foreign := stored
			mutate(&foreign)
			if _, err := offlineV5RecoveredReceipt(operation, requestHash, foreign); !errors.Is(err, ErrOfflineV3AccessDenied) {
				t.Fatalf("foreign receipt metadata accepted: %v", err)
			}
		})
	}
}

func TestOfflineV5SupersededEmptySyncCanRecoverRefreshOnly(t *testing.T) {
	now := time.Now().UTC()
	record := &OfflineV5AuthRecord{OfflineV4AuthRecord: &OfflineV4AuthRecord{OfflineV4Grant: domain.OfflineV4Grant{
		OfflineV4Tuple:    domain.OfflineV4Tuple{BrowserProfileID: uuid.New(), UserID: uuid.New(), AccountID: uuid.New(), GrantID: uuid.New()},
		SelectionRevision: 2, CredentialEpoch: 3, AuthorityEpoch: 4}}}
	manifest := &domain.OfflineV5Manifest{ID: uuid.New(), Revision: 5}
	if !offlineV5ReceiptRecoveryBindingsValid(record, manifest, nil, now) {
		t.Fatal("empty signed sync could not recover a manifest refresh")
	}
	operation := domain.OfflineV5Operation{ProtocolVersion: domain.OfflineV5ProtocolVersion, BrowserProfileID: record.BrowserProfileID,
		GrantID: record.GrantID, UserID: record.UserID, AccountID: record.AccountID, ManifestID: manifest.ID,
		ManifestRevision: manifest.Revision, SelectionID: uuid.New(), SelectionRevision: record.SelectionRevision,
		CredentialEpoch: record.CredentialEpoch, AuthorityEpoch: record.AuthorityEpoch, OperationID: uuid.New(),
		Action: domain.OfflineV5ActionTasksUpdate, ResourceID: uuid.New(), BaseVersion: 1,
		Payload: json.RawMessage(`{"title":"after"}`), OccurredAt: now}
	if !offlineV5ReceiptRecoveryBindingsValid(record, manifest, []domain.OfflineV5Operation{operation}, now) {
		t.Fatal("exact receipt recovery binding rejected")
	}
	if offlineV5ReceiptRecoveryBindingsValid(record, manifest, []domain.OfflineV5Operation{operation, operation}, now) {
		t.Fatal("duplicate operation id accepted during receipt recovery")
	}
	foreign := operation
	foreign.AccountID = uuid.New()
	if offlineV5ReceiptRecoveryBindingsValid(record, manifest, []domain.OfflineV5Operation{foreign}, now) {
		t.Fatal("cross-account receipt recovery binding accepted")
	}
}

func TestOfflineV5WritesGateAllowsOnlyDeliveryRecoveryWhenDisabled(t *testing.T) {
	for name, test := range map[string]struct {
		recovery, global, grant bool
		operations              int
		wantError               bool
	}{
		"normal write enabled":      {global: true, grant: true, operations: 1},
		"normal globally disabled":  {global: false, grant: true, operations: 1, wantError: true},
		"normal grant disabled":     {global: true, grant: false, operations: 1, wantError: true},
		"receipt recovery disabled": {recovery: true, global: false, grant: false, operations: 1},
		"empty refresh disabled":    {global: false, grant: false, operations: 0},
		"empty recovery disabled":   {recovery: true, global: false, grant: false, operations: 0},
	} {
		t.Run(name, func(t *testing.T) {
			err := offlineV5SyncWritesGate(test.recovery, test.operations, test.global, test.grant)
			if test.wantError && !errors.Is(err, ErrOfflineV5WritesDisabled) {
				t.Fatalf("normal write was not blocked: %v", err)
			}
			if !test.wantError && err != nil {
				t.Fatalf("safe sync path was blocked: %v", err)
			}
		})
	}
}

func TestOfflineV5PendingReceiptRebindKeepsLogicalIntentExact(t *testing.T) {
	dependencyID := uuid.New()
	operation := domain.OfflineV5Operation{ProtocolVersion: domain.OfflineV5ProtocolVersion, BrowserProfileID: uuid.New(),
		GrantID: uuid.New(), UserID: uuid.New(), AccountID: uuid.New(), ManifestID: uuid.New(), ManifestRevision: 2,
		SelectionID: uuid.New(), SelectionRevision: 3, CredentialEpoch: 4, AuthorityEpoch: 5,
		OperationID: uuid.New(), DependsOnOperationID: &dependencyID, Action: domain.OfflineV5ActionTasksUpdate,
		ResourceID: uuid.New(), BaseVersion: 7, Base: json.RawMessage(`{"title":"before"}`),
		Payload: json.RawMessage(`{"title":"after"}`), OccurredAt: time.Now().UTC()}
	intentHash, err := offlineV5OperationIntentHash(operation)
	if err != nil {
		t.Fatal(err)
	}
	pending := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID,
		Status: "pending", ErrorCode: "operation_dependency_pending"}
	encoded, err := json.Marshal(pending)
	if err != nil {
		t.Fatal(err)
	}
	stored := offlineV5StoredReceipt{ManifestID: operation.ManifestID, IntentHash: intentHash, Action: operation.Action,
		SelectionID: operation.SelectionID, ResourceID: operation.ResourceID, Status: pending.Status, Result: encoded}

	rebound := operation
	rebound.ManifestID, rebound.ManifestRevision = uuid.New(), operation.ManifestRevision+1
	rebound.SelectionRevision, rebound.CredentialEpoch, rebound.AuthorityEpoch = 4, 6, 7
	reboundHash, err := offlineV5OperationIntentHash(rebound)
	if err != nil || reboundHash != intentHash {
		t.Fatalf("authority-only rebind changed logical intent: hash=%s err=%v", reboundHash, err)
	}
	if err := offlineV5PendingReceiptCanRebind(rebound, reboundHash, stored); err != nil {
		t.Fatalf("exact pending intent could not rebind: %v", err)
	}

	changed := rebound
	changed.Payload = json.RawMessage(`{"title":"attacker changed payload"}`)
	changedHash, err := offlineV5OperationIntentHash(changed)
	if err != nil {
		t.Fatal(err)
	}
	if changedHash == intentHash {
		t.Fatal("payload was omitted from pending intent hash")
	}
	if err := offlineV5PendingReceiptCanRebind(changed, changedHash, stored); !errors.Is(err, ErrOfflineV3ReceiptReuse) {
		t.Fatalf("changed pending intent was accepted: %v", err)
	}
	foreign := stored
	foreign.SelectionID = uuid.New()
	if err := offlineV5PendingReceiptCanRebind(rebound, reboundHash, foreign); !errors.Is(err, ErrOfflineV3AccessDenied) {
		t.Fatalf("cross-selection pending receipt was accepted: %v", err)
	}
}

func TestOfflineV5TerminalReceiptCanFollowAuthenticatedManifestRebind(t *testing.T) {
	operation := domain.OfflineV5Operation{ProtocolVersion: domain.OfflineV5ProtocolVersion, BrowserProfileID: uuid.New(),
		GrantID: uuid.New(), UserID: uuid.New(), AccountID: uuid.New(), ManifestID: uuid.New(), ManifestRevision: 3,
		SelectionID: uuid.New(), SelectionRevision: 4, CredentialEpoch: 5, AuthorityEpoch: 6,
		OperationID: uuid.New(), Action: domain.OfflineV5ActionTasksUpdate, ResourceID: uuid.New(), BaseVersion: 7,
		Base: json.RawMessage(`{"title":"before"}`), Payload: json.RawMessage(`{"title":"after"}`), OccurredAt: time.Now().UTC()}
	intentHash, err := offlineV5OperationIntentHash(operation)
	if err != nil {
		t.Fatal(err)
	}
	terminal := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID,
		Status: "applied", ServerVersion: 8, Result: json.RawMessage(`{"task":{"version":8}}`)}
	encoded, err := json.Marshal(terminal)
	if err != nil {
		t.Fatal(err)
	}
	stored := offlineV5StoredReceipt{ManifestID: operation.ManifestID, IntentHash: intentHash, Action: operation.Action,
		SelectionID: operation.SelectionID, ResourceID: operation.ResourceID, Status: terminal.Status,
		ServerVersion: terminal.ServerVersion, Result: encoded}
	rebound := operation
	rebound.ManifestID, rebound.ManifestRevision = uuid.New(), operation.ManifestRevision+1
	rebound.SelectionRevision, rebound.CredentialEpoch, rebound.AuthorityEpoch = 9, 10, 11
	reboundHash, err := offlineV5OperationIntentHash(rebound)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := offlineV5ReboundTerminalReceipt(rebound, reboundHash, stored)
	if err != nil || recovered.Status != "applied" || recovered.ServerVersion != terminal.ServerVersion {
		t.Fatalf("terminal result was lost across authority-only rebind: result=%+v err=%v", recovered, err)
	}
	rebound.Payload = json.RawMessage(`{"title":"changed"}`)
	changedHash, err := offlineV5OperationIntentHash(rebound)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := offlineV5ReboundTerminalReceipt(rebound, changedHash, stored); !errors.Is(err, ErrOfflineV3ReceiptReuse) {
		t.Fatalf("changed terminal intent was accepted after rebind: %v", err)
	}
}

func TestOfflineV5MergeOnlyAcceptsDisjointOrAlreadyCanonicalFields(t *testing.T) {
	base := map[string]json.RawMessage{"title": json.RawMessage(`"before"`), "notes": json.RawMessage(`"old"`)}
	local := map[string]json.RawMessage{"title": json.RawMessage(`"mine"`)}
	current := map[string]json.RawMessage{"title": json.RawMessage(`"before"`), "notes": json.RawMessage(`"server"`)}
	merged, conflict := offlineV5MergePatch(1, 2, base, local, current)
	if !merged || conflict != nil {
		t.Fatal("disjoint server update did not merge")
	}
	current["title"] = json.RawMessage(`"theirs"`)
	merged, conflict = offlineV5MergePatch(1, 2, base, local, current)
	if merged || conflict == nil || len(conflict.Fields) != 1 || conflict.Fields[0] != "title" {
		t.Fatalf("same-field divergence not exposed: %#v", conflict)
	}
	current["title"] = json.RawMessage(`"mine"`)
	merged, conflict = offlineV5MergePatch(1, 2, base, local, current)
	if !merged || conflict != nil {
		t.Fatal("already-canonical retry conflicted")
	}
}

func TestOfflineV5StrictObjectRejectsDuplicateAndTrailingJSON(t *testing.T) {
	for _, raw := range []string{`{"a":1,"a":2}`, `{"a":1} {}`, `[]`, `{"":1}`} {
		if _, err := decodeOfflineV5Object(json.RawMessage(raw), 1024); err == nil {
			t.Fatalf("unsafe JSON accepted: %s", raw)
		}
	}
	if object, err := decodeOfflineV5Object(json.RawMessage(`{"a":1,"b":{"x":2}}`), 1024); err != nil || len(object) != 2 {
		t.Fatalf("valid strict object rejected: %v", err)
	}
}

func TestOfflineV5ManifestCanonicalOmitsTransportFieldsAndBindsChunkToSelection(t *testing.T) {
	selectionID := uuid.New()
	manifest := domain.OfflineV5Manifest{ProtocolVersion: 5, ID: uuid.New(), Revision: 1, BrowserProfileID: uuid.New(),
		GrantID: uuid.New(), UserID: uuid.New(), AccountID: uuid.New(), SelectionRevision: 1,
		SelectionDigest: strings.Repeat("a", 64), CredentialEpoch: 1, AuthorityEpoch: 1, GrantRevision: 1,
		Roots: []domain.OfflineV5ManifestRoot{}, Dependencies: []domain.OfflineV5ManifestDependency{},
		Capabilities: []domain.OfflineV5Capability{}, EntityVersions: []domain.OfflineV5EntityVersion{},
		ChunkHashes: []domain.OfflineV5ChunkHash{{SelectionID: selectionID, HeadVersion: 3, ContentHash: strings.Repeat("b", 64)}},
		Digest:      "must-not-be-signed", CanonicalJSON: "must-not-be-signed", IssuedAt: time.Unix(1900000000, 0).UTC(),
		ExpiresAt: time.Unix(1900003600, 0).UTC(), MaxStorageBytes: 1024}
	raw, digest, err := offlineV5ManifestCanonical(manifest)
	if err != nil {
		t.Fatal(err)
	}
	var signed map[string]json.RawMessage
	if err := json.Unmarshal(raw, &signed); err != nil {
		t.Fatal(err)
	}
	if _, exists := signed["digest"]; exists {
		t.Fatal("digest recursively included in signed view")
	}
	if _, exists := signed["canonical_json"]; exists {
		t.Fatal("canonical transport bytes recursively included in signed view")
	}
	var chunks []map[string]json.RawMessage
	if err := json.Unmarshal(signed["chunk_hashes"], &chunks); err != nil || len(chunks) != 1 || chunks[0]["selection_id"] == nil || chunks[0]["head_version"] == nil || chunks[0]["content_hash"] == nil {
		t.Fatalf("chunk hash lost signed selection binding: %s", signed["chunk_hashes"])
	}
	if len(digest) != 64 || base64.RawURLEncoding.EncodeToString(raw) == "" {
		t.Fatal("canonical digest/transport encoding invalid")
	}
	manifest.Digest, manifest.CanonicalJSON = digest, base64.RawURLEncoding.EncodeToString(raw)
	rawAgain, digestAgain, err := offlineV5ManifestCanonical(manifest)
	if err != nil || string(rawAgain) != string(raw) || digestAgain != digest {
		t.Fatal("transport fields changed signed bytes")
	}
}

func TestOfflineV5TaskCreateAllowsOneLevelParentIdentifier(t *testing.T) {
	parent := uuid.New()
	parsed, err := parseOfflineV3TaskCreate(json.RawMessage(`{"title":"Subtarea","description":"","parent_task_id":"` + parent.String() + `","start_at":null,"due_at":null,"due_end_at":null,"is_all_day":false,"priority":"medium"}`))
	if err != nil || parsed.ParentTaskID == nil || *parsed.ParentTaskID != parent {
		t.Fatalf("parent task create contract rejected: %#v %v", parsed.ParentTaskID, err)
	}
}

func TestOfflineV5RequestedSnapshotsCannotEscapeSignedManifest(t *testing.T) {
	insideA, insideB, outside := uuid.New(), uuid.New(), uuid.New()
	manifest := &domain.OfflineV5Manifest{Roots: []domain.OfflineV5ManifestRoot{{SelectionID: insideA}, {SelectionID: insideB}}}
	if !offlineV5RequestedSnapshotsAllowed(manifest, nil) || !offlineV5RequestedSnapshotsAllowed(manifest, []uuid.UUID{insideB, insideA}) {
		t.Fatal("manifest-owned snapshot request rejected")
	}
	for _, requested := range [][]uuid.UUID{{outside}, {insideA, outside}, {insideA, insideA}, {uuid.Nil}} {
		if offlineV5RequestedSnapshotsAllowed(manifest, requested) {
			t.Fatalf("snapshot request escaped manifest: %v", requested)
		}
	}
}

func TestOfflineV5ProgramEntityVersionsUseCommandIdentities(t *testing.T) {
	participantID, sessionID := uuid.New(), uuid.New()
	payload := json.RawMessage(`{"active_roster":[{"id":"` + participantID.String() + `","version":1700000000000000}],` +
		`"sessions":[{"id":"` + sessionID.String() + `","version":1700000000000001}],` +
		`"eligible_attendance":[{"id":"` + uuid.NewString() + `","session_id":"` + sessionID.String() + `","participant_id":"` + participantID.String() + `","version":1700000000000002}]}`)
	versions := offlineV5EntityVersions(payload, domain.OfflineModulePrograms)
	want := map[string]int64{
		"program_participant:" + participantID.String():                           1700000000000000,
		"program_session:" + sessionID.String():                                   1700000000000001,
		"program_attendance:" + sessionID.String() + ":" + participantID.String(): 1700000000000002,
	}
	for _, item := range versions {
		key := item.EntityType + ":" + item.EntityID
		if expected, exists := want[key]; exists {
			if item.Version != expected {
				t.Fatalf("wrong version for %s: got %d want %d", key, item.Version, expected)
			}
			delete(want, key)
		}
	}
	if len(want) != 0 {
		t.Fatalf("semantic program versions missing: %#v (all=%#v)", want, versions)
	}
}
