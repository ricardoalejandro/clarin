package whatsapp

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/util/keys"
)

type checkpointRepositoryFake struct {
	calls                    *[]string
	verifyErr, checkpointErr error
}

func (f checkpointRepositoryFake) VerifyDeletion(context.Context, *repository.DeviceDeletion) error {
	*f.calls = append(*f.calls, "verify")
	return f.verifyErr
}
func (f checkpointRepositoryFake) CheckpointUnlinked(context.Context, *repository.DeviceDeletion) error {
	*f.calls = append(*f.calls, "checkpoint")
	return f.checkpointErr
}

type checkpointStoreFake struct {
	calls *[]string
	err   error
}

func (f checkpointStoreFake) PutDevice(context.Context, *store.Device) error {
	*f.calls = append(*f.calls, "local_put")
	return f.err
}
func (f checkpointStoreFake) DeleteDevice(context.Context, *store.Device) error {
	*f.calls = append(*f.calls, "local_delete")
	return f.err
}
func deletionTestStore() *store.Device {
	jid := types.NewADJID("51999000111", 0, 7)
	return &store.Device{ID: &jid, IdentityKey: keys.NewKeyPair(), NoiseKey: keys.NewKeyPair(), RegistrationID: 27}
}

func TestDeletionCheckpointPrecedesLocalStoreRemoval(t *testing.T) {
	for _, tc := range []struct {
		name                               string
		verifyErr, checkpointErr, localErr error
		want                               []string
	}{
		{"success", nil, nil, nil, []string{"verify", "checkpoint", "local_delete"}},
		{"database_checkpoint_failed", nil, errors.New("database failed"), nil, []string{"verify", "checkpoint"}},
		{"lease_lost", repository.ErrDeviceDeletionLeaseLost, nil, nil, []string{"verify"}},
		{"local_delete_failed", nil, nil, errors.New("local failed"), []string{"verify", "checkpoint", "local_delete"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := []string{}
			device := deletionTestStore()
			job := &repository.DeviceDeletion{Fingerprint: deviceSessionFingerprint(device)}
			container := &deletionCheckpointContainer{DeviceContainer: checkpointStoreFake{&calls, tc.localErr}, repo: checkpointRepositoryFake{&calls, tc.verifyErr, tc.checkpointErr}, job: job}
			err := container.DeleteDevice(context.Background(), device)
			if !reflect.DeepEqual(calls, tc.want) {
				t.Fatalf("calls=%v want %v", calls, tc.want)
			}
			wantErr := tc.verifyErr != nil || tc.checkpointErr != nil || tc.localErr != nil
			if (err != nil) != wantErr {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestDeletionNeverTouchesReplacedSession(t *testing.T) {
	calls := []string{}
	old := deletionTestStore()
	replacement := deletionTestStore()
	container := &deletionCheckpointContainer{DeviceContainer: checkpointStoreFake{calls: &calls}, repo: checkpointRepositoryFake{calls: &calls}, job: &repository.DeviceDeletion{Fingerprint: deviceSessionFingerprint(old)}}
	if err := container.DeleteDevice(context.Background(), replacement); !errors.Is(err, repository.ErrDeviceSessionConflict) {
		t.Fatalf("error=%v", err)
	}
	if len(calls) != 0 {
		t.Fatalf("replacement session was touched: %v", calls)
	}
	changedCompanion := *old
	jid := types.NewADJID(old.ID.User, 0, 8)
	changedCompanion.ID = &jid
	if deviceSessionFingerprint(&changedCompanion) == deviceSessionFingerprint(old) {
		t.Fatal("fingerprint discarded companion identity")
	}
}

func TestCleanupStoreSaveIsFencedByExactSessionAndLease(t *testing.T) {
	for _, tc := range []struct {
		name      string
		verifyErr error
		replaced  bool
		want      []string
	}{
		{"valid", nil, false, []string{"verify", "local_put"}},
		{"lease_lost", repository.ErrDeviceDeletionLeaseLost, false, []string{"verify"}},
		{"replaced_key", nil, true, []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := []string{}
			original := deletionTestStore()
			device := original
			if tc.replaced {
				device = deletionTestStore()
			}
			container := &deletionCheckpointContainer{DeviceContainer: checkpointStoreFake{calls: &calls}, repo: checkpointRepositoryFake{calls: &calls, verifyErr: tc.verifyErr}, job: &repository.DeviceDeletion{Fingerprint: deviceSessionFingerprint(original)}}
			err := container.PutDevice(context.Background(), device)
			if !reflect.DeepEqual(calls, tc.want) {
				t.Fatalf("calls=%v want %v", calls, tc.want)
			}
			if (err != nil) != (tc.verifyErr != nil || tc.replaced) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestDeletionBackoffIsBoundedAndDurableAttemptBased(t *testing.T) {
	for i, want := range []time.Duration{5 * time.Second, 30 * time.Second, 2 * time.Minute, 5 * time.Minute, 15 * time.Minute, 15 * time.Minute} {
		if got := deletionRetryDelay(i+1, 0.5); got != want {
			t.Fatalf("attempt %d=%s want %s", i+1, got, want)
		}
		if got := deletionRetryDelay(i+1, 0); got != time.Duration(float64(want)*0.8) {
			t.Fatalf("lower jitter=%s", got)
		}
		if got := deletionRetryDelay(i+1, 1); got != time.Duration(float64(want)*1.2) {
			t.Fatalf("upper jitter=%s", got)
		}
	}
}

func TestNestedDeviceOperationDoesNotReleaseOuterLock(t *testing.T) {
	p := &DevicePool{}
	id := uuid.New()
	lock := p.deviceLifecycleLock(id)
	lock.RLock()
	ctx := context.WithValue(context.Background(), deviceLifecycleContextKey{}, id)
	writerDone := make(chan struct{})
	go func() { lock.Lock(); defer lock.Unlock(); close(writerDone) }()
	// Nested helper calls made during a send/event retain the outer operation,
	// even when DELETE is waiting for the write lock. They never query again or
	// recursively RLock behind that writer.
	_, release, err := p.retainDeviceOperation(ctx, uuid.Nil, id)
	if err != nil {
		lock.RUnlock()
		t.Fatal(err)
	}
	release()
	select {
	case <-writerDone:
		t.Fatal("nested release ended the outer operation")
	default:
	}
	lock.RUnlock()
	select {
	case <-writerDone:
	case <-time.After(time.Second):
		t.Fatal("DELETE did not proceed after persistence released the outer lock")
	}
}

type pairedSessionRepositoryFake struct {
	calls                   *[]string
	reservationErr, bindErr error
	jid                     string
}

func (f *pairedSessionRepositoryFake) WithSessionReservation(ctx context.Context, accountID, deviceID uuid.UUID, jid string, action func(context.Context) error) error {
	*f.calls = append(*f.calls, "reserve")
	f.jid = jid
	if f.reservationErr != nil {
		return f.reservationErr
	}
	return action(ctx)
}

func (f *pairedSessionRepositoryFake) RememberPairedSession(context.Context, uuid.UUID, uuid.UUID, string) error {
	*f.calls = append(*f.calls, "bind")
	return f.bindErr
}

func TestPairingBindsIdentityBeforeStoreSaveAndRemoteAck(t *testing.T) {
	for _, tc := range []struct {
		name                              string
		reservationErr, bindErr, storeErr error
		want                              []string
	}{
		{"paired", nil, nil, nil, []string{"reserve", "bind", "local_put"}},
		{"persistence_failed", nil, errors.New("database unavailable"), nil, []string{"reserve", "bind"}},
		{"deleting", repository.ErrDeviceDeleting, nil, nil, []string{"reserve"}},
		{"store_failed", nil, nil, errors.New("store unavailable"), []string{"reserve", "bind", "local_put"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := []string{}
			repo := &pairedSessionRepositoryFake{calls: &calls, reservationErr: tc.reservationErr, bindErr: tc.bindErr}
			device := deletionTestStore()
			err := savePairedDevice(context.Background(), repo, checkpointStoreFake{&calls, tc.storeErr}, uuid.New(), uuid.New(), device)
			if !reflect.DeepEqual(calls, tc.want) {
				t.Fatalf("calls=%v want %v", calls, tc.want)
			}
			if (err != nil) != (tc.reservationErr != nil || tc.bindErr != nil || tc.storeErr != nil) {
				t.Fatalf("error=%v", err)
			}
			if repo.jid != device.ID.String() {
				t.Fatal("pairing reservation discarded companion identity")
			}
		})
	}
}

func TestDeletionDoesNotMistakePairingHandoffForEmptySession(t *testing.T) {
	paired := deletionTestStore()
	if err := requireDeletionSessionIdentity("", paired); !errors.Is(err, repository.ErrDeviceSessionConflict) {
		t.Fatalf("blank DB snapshot accepted paired store: %v", err)
	}
	if err := requireDeletionSessionIdentity(paired.ID.ToNonAD().String(), paired); !errors.Is(err, repository.ErrDeviceSessionConflict) {
		t.Fatal("companion identity was ignored")
	}
	if err := requireDeletionSessionIdentity(paired.ID.String(), paired); err != nil {
		t.Fatal(err)
	}
	if err := requireDeletionSessionIdentity("", &store.Device{}); err != nil {
		t.Fatal("truly unpaired device rejected")
	}
}
