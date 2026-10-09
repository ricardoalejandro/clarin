package whatsapp

import (
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

func TestMissingDeletionSessionRequiresSafeCheckpoint(t *testing.T) {
	for _, tc := range []struct {
		name, phase   string
		available     bool
		checkpointErr error
		wantCalls     []string
		wantErr       error
		wantPhase     string
	}{
		{"missing_store", "pending", false, nil, []string{"local_checkpoint", "finish"}, nil, "local_detached"},
		{"resumed_local_cleanup", "local_detached", false, nil, []string{"local_checkpoint", "finish"}, nil, "local_detached"},
		{"confirmed_remote_logout", "remote_unlinked", false, nil, []string{"finish"}, nil, "remote_unlinked"},
		{"keys_retained_by_client", "pending", true, nil, []string{}, repository.ErrDeviceSessionConflict, "pending"},
		{"client_blocks_remote_checkpoint_too", "remote_unlinked", true, nil, []string{}, repository.ErrDeviceSessionConflict, "remote_unlinked"},
		{"replacement_or_foreign_session", "pending", false, repository.ErrDeviceSessionConflict, []string{"local_checkpoint"}, repository.ErrDeviceSessionConflict, "pending"},
		{"expired_lease", "pending", false, repository.ErrDeviceDeletionLeaseLost, []string{"local_checkpoint"}, repository.ErrDeviceDeletionLeaseLost, "pending"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			job := &repository.DeviceDeletion{Phase: tc.phase}
			calls := []string{}
			result, err := finishMissingDeviceSession(job, tc.available, func() error {
				calls = append(calls, "local_checkpoint")
				return tc.checkpointErr
			}, func() (*domain.DeviceDeletionResult, error) {
				calls = append(calls, "finish")
				scope := "remote"
				if job.Phase == "local_detached" {
					scope = "local"
				}
				return &domain.DeviceDeletionResult{DeletionStatus: "completed", CleanupScope: scope}, nil
			})
			if !errors.Is(err, tc.wantErr) || !reflect.DeepEqual(calls, tc.wantCalls) || job.Phase != tc.wantPhase {
				t.Fatalf("err=%v calls=%v phase=%s", err, calls, job.Phase)
			}
			if tc.wantErr != nil && result != nil {
				t.Fatal("unsafe cleanup returned completion")
			}
			if tc.wantErr == nil && result.CleanupScope != map[bool]string{true: "local", false: "remote"}[job.Phase == "local_detached"] {
				t.Fatalf("cleanup scope mislabeled: %+v", result)
			}
		})
	}
}

func TestMissingStoreCleanupChecksEveryRetainedClientAndFullCompanion(t *testing.T) {
	store := deletionTestStore()
	j := store.ID.String()
	id, foreignID := uuid.New(), uuid.New()
	pool := &DevicePool{devices: map[uuid.UUID]*DeviceInstance{
		id:        {ID: id, AccountID: uuid.New()},
		foreignID: {ID: foreignID, AccountID: uuid.New(), Client: &whatsmeow.Client{Store: store}},
	}}
	if !pool.hasAvailableSession(j) {
		t.Fatal("foreign retained client was overlooked")
	}
	otherCompanion := types.NewADJID(store.ID.User, 0, uint8(store.ID.Device)+1)
	if pool.hasAvailableSession(otherCompanion.String()) {
		t.Fatal("full companion identity was discarded")
	}
	pool.devices[foreignID].Client = nil
	if pool.hasAvailableSession(j) {
		t.Fatal("client without session blocks unrelated cleanup")
	}
	pool.devices[id].Client = &whatsmeow.Client{Store: deletionTestStore()}
	if !pool.hasAvailableSession(j) {
		t.Fatal("replacement keys in a retained local client were overlooked")
	}
}
