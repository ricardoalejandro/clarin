package api

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/config"
)

func TestOfflineInventoryDiffFetchesMissingStaleAndHashMismatch(t *testing.T) {
	currentID, staleID, hashID := uuid.New(), uuid.New(), uuid.New()
	server := []domain.OfflineInventoryItem{
		{SelectionID: currentID, HeadVersion: 3, ContentHash: "aa"},
		{SelectionID: staleID, HeadVersion: 4, ContentHash: "bb"},
		{SelectionID: hashID, HeadVersion: 5, ContentHash: "cc"},
	}
	client := []domain.OfflineClientInventoryItem{
		{SelectionID: currentID, HeadVersion: 3, ContentHash: "AA"},
		{SelectionID: staleID, HeadVersion: 3, ContentHash: "bb"},
		{SelectionID: hashID, HeadVersion: 5, ContentHash: "different"},
	}
	diff := offlineInventoryDiff(server, client)
	if len(diff) != 2 || diff[0] != staleID || diff[1] != hashID {
		t.Fatalf("unexpected inventory diff: %#v", diff)
	}
}

func TestEffectiveOfflineActionsFollowRuntimeKillSwitches(t *testing.T) {
	server := &Server{cfg: &config.Config{OfflineWriteTasks: true}}
	var actions map[string]map[string]bool
	if err := json.Unmarshal(server.effectiveOfflineActions([]string{domain.OfflineModuleTasks, domain.OfflineModuleWhiteboards}), &actions); err != nil {
		t.Fatal(err)
	}
	if !actions[domain.OfflineModuleTasks]["create"] || !actions[domain.OfflineModuleTasks]["complete"] || actions[domain.OfflineModuleTasks]["edit_simple"] || actions[domain.OfflineModuleWhiteboards]["edit_scene"] || actions[domain.OfflineModuleWhiteboards]["upload_asset"] {
		t.Fatalf("unexpected effective actions: %#v", actions)
	}
}

func TestOfflineSemverAtLeastIsStrictAndNumeric(t *testing.T) {
	cases := []struct {
		current, minimum string
		want             bool
	}{
		{"0.1.0", "0.1.0", true},
		{"v0.2.0", "0.1.9", true},
		{"1.0.0-beta.1", "1.0.0", true},
		{"0.0.9", "0.1.0", false},
		{"1.2", "1.1.0", false},
		{"garbage", "0.1.0", false},
	}
	for _, tc := range cases {
		if got := offlineSemverAtLeast(tc.current, tc.minimum); got != tc.want {
			t.Fatalf("offlineSemverAtLeast(%q,%q)=%v want %v", tc.current, tc.minimum, got, tc.want)
		}
	}
}

func TestOfflineSignerClientIsConfinedToPrivateDockerAddress(t *testing.T) {
	accepted := &Server{cfg: &config.Config{OfflineSignerAddress: "http://clarin-offline-signer:8200"}}
	if _, err := accepted.offlineSignerHTTPClient(); err != nil {
		t.Fatalf("private Docker signer address was rejected: %v", err)
	}

	for _, address := range []string{
		"https://clarin-offline-signer:8200",
		"http://127.0.0.1:8200",
		"http://clarin-offline-signer:8200/v1",
		"http://clarin-offline-signer:8200?target=external",
		"http://user:secret@clarin-offline-signer:8200",
	} {
		server := &Server{cfg: &config.Config{OfflineSignerAddress: address}}
		if _, err := server.offlineSignerHTTPClient(); err == nil {
			t.Fatalf("unsafe signer address was accepted: %s", address)
		}
	}
}

func TestOfflineDependenciesRequireEarlierAppliedOrNoopReceipt(t *testing.T) {
	applied, noop, rejected, missing := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	statuses := map[uuid.UUID]string{
		applied:  domain.OfflineOperationApplied,
		noop:     domain.OfflineOperationNoop,
		rejected: domain.OfflineOperationRejected,
	}
	if dependencyFailed([]uuid.UUID{applied, noop}, statuses) {
		t.Fatal("applied/noop dependencies were rejected")
	}
	if !dependencyFailed([]uuid.UUID{rejected}, statuses) || !dependencyFailed([]uuid.UUID{missing}, statuses) {
		t.Fatal("failed or missing dependency was accepted")
	}
}

func TestOfflineOperationContractContainsOnlyApprovedPilotActions(t *testing.T) {
	wantCounts := map[string]int{
		domain.OfflineModuleWhiteboards: 2,
		domain.OfflineModuleTasks:       3,
		domain.OfflineModuleContacts:    3,
		domain.OfflineModulePrograms:    2,
	}
	for module, want := range wantCounts {
		if got := len(offlineOperationContract[module]); got != want {
			t.Fatalf("module %s has %d actions, want %d", module, got, want)
		}
	}
	if offlineOperationContract[domain.OfflineModuleTasks]["task.reopen"] || offlineOperationContract[domain.OfflineModuleContacts]["contact.delete"] {
		t.Fatal("a forbidden pilot action became available")
	}
}

func TestOfflineOperationBatchRequiresUniqueTopologicalOrder(t *testing.T) {
	first, second := uuid.New(), uuid.New()
	if !validOfflineOperationBatch([]domain.OfflineOperation{{OperationID: first}, {OperationID: second, DependsOn: []uuid.UUID{first}}}) {
		t.Fatal("valid ordered dependency was rejected")
	}
	if validOfflineOperationBatch([]domain.OfflineOperation{{OperationID: second, DependsOn: []uuid.UUID{first}}, {OperationID: first}}) {
		t.Fatal("forward dependency was accepted")
	}
	if validOfflineOperationBatch([]domain.OfflineOperation{{OperationID: first}, {OperationID: first}}) {
		t.Fatal("duplicate operation id was accepted")
	}
	if !validOfflineOperationBatch([]domain.OfflineOperation{{OperationID: second, DependsOn: []uuid.UUID{uuid.New()}}}) {
		t.Fatal("a dependency with a durable receipt from an earlier batch was rejected structurally")
	}
	if validOfflineOperationBatch([]domain.OfflineOperation{{OperationID: first, DependsOn: []uuid.UUID{first}}}) {
		t.Fatal("self dependency was accepted")
	}
}
