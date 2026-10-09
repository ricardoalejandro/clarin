package whatsapp

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

var (
	ErrDeviceDisconnected     = errors.New("dispositivo desconectado")
	errDeletionSessionMissing = errors.New("deletion session missing")
)

func (p *DevicePool) deviceLifecycleLock(id uuid.UUID) *sync.RWMutex {
	value, _ := p.lifecycleLocks.LoadOrStore(id, &sync.RWMutex{})
	return value.(*sync.RWMutex)
}

func (p *DevicePool) acquireDeviceOperation(ctx context.Context, accountID, deviceID uuid.UUID) (func(), error) {
	if held, ok := ctx.Value(deviceLifecycleContextKey{}).(uuid.UUID); ok && held == deviceID {
		return func() {}, nil // The outer operation owns this same resource lock.
	}
	lock := p.deviceLifecycleLock(deviceID)
	lock.RLock()
	if err := p.repos.Device.Active(ctx, accountID, deviceID); err != nil {
		lock.RUnlock()
		return nil, err
	}
	return lock.RUnlock, nil
}

func (p *DevicePool) retainDeviceOperation(ctx context.Context, accountID, deviceID uuid.UUID) (context.Context, func(), error) {
	release, err := p.acquireDeviceOperation(ctx, accountID, deviceID)
	if err != nil {
		return ctx, nil, err
	}
	return context.WithValue(ctx, deviceLifecycleContextKey{}, deviceID), release, nil
}

func deviceSessionFingerprint(device *store.Device) string {
	if device == nil || device.ID == nil || device.IdentityKey == nil || device.NoiseKey == nil {
		return ""
	}
	data := []byte(device.ID.String()) // Full companion identity, never ToNonAD().
	data = append(data, device.IdentityKey.Pub[:]...)
	data = append(data, device.NoiseKey.Pub[:]...)
	data = binary.BigEndian.AppendUint32(data, device.RegistrationID)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func requireDeletionSessionIdentity(jid string, liveStore *store.Device) error {
	if liveStore != nil && liveStore.ID != nil && liveStore.ID.String() != jid {
		return repository.ErrDeviceSessionConflict
	}
	return nil
}

func deletionRetryDelay(attempt int, jitter float64) time.Duration {
	delays := []time.Duration{5 * time.Second, 30 * time.Second, 2 * time.Minute, 5 * time.Minute, 15 * time.Minute}
	if attempt < 1 {
		attempt = 1
	}
	if attempt > len(delays) {
		attempt = len(delays)
	}
	if jitter < 0 {
		jitter = 0
	}
	if jitter > 1 {
		jitter = 1
	}
	return time.Duration(float64(delays[attempt-1]) * (0.8 + 0.4*jitter))
}

func (p *DevicePool) DeleteDevice(ctx context.Context, accountID, deviceID uuid.UUID) (*domain.DeviceDeletionResult, error) {
	// Repeated requests for an already committed operation do not wait for
	// resource locks or restart any provider work during finalization.
	if pending, err := p.repos.Device.PendingDeletion(ctx, accountID, deviceID); err != nil || pending != nil {
		return pending, err
	}
	lock := p.deviceLifecycleLock(deviceID)
	lock.Lock()
	defer lock.Unlock()
	device, err := p.repos.Device.GetByID(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	if device == nil || device.AccountID != accountID {
		return nil, repository.ErrDeviceNotFound
	}
	if device.Provider != nil && *device.Provider == domain.DeviceProviderWhatsAppCloudAPI {
		return nil, repository.ErrDeviceDeletionUnsupported
	}
	jid := ""
	if device.JID != nil {
		jid = *device.JID
	}
	// A pairing callback assigns Store.ID just before its guarded Save. Never
	// classify that handoff window as an unpaired device eligible for deletion.
	if device.Deletion == nil {
		p.mu.RLock()
		instance := p.devices[deviceID]
		p.mu.RUnlock()
		if instance != nil && instance.Client != nil {
			if identityErr := requireDeletionSessionIdentity(jid, instance.Client.Store); identityErr != nil {
				return nil, identityErr
			}
		}
	}
	fingerprint := ""
	if device.Deletion == nil && jid != "" {
		parsed, parseErr := types.ParseJID(jid)
		if parseErr != nil {
			return nil, repository.ErrDeviceSessionConflict
		}
		waDevice, readErr := p.store.GetDevice(ctx, parsed)
		if readErr != nil {
			return nil, readErr
		}
		if waDevice == nil && p.hasAvailableSession(jid) {
			return nil, repository.ErrDeviceSessionConflict
		}
		fingerprint = deviceSessionFingerprint(waDevice)
	}
	result, err := p.repos.Device.BeginDeletion(ctx, accountID, deviceID, jid, fingerprint)
	if err != nil {
		return nil, err
	} // No provider or pool changes before durable commit.
	p.suspendDeletedDevice(deviceID)
	p.broadcastDeviceDeletion(accountID, result)
	p.startDeletionWorkers()
	return result, nil
}

// A database store can be missing while a client still retains session keys.
// Local-only cleanup must never discard or take ownership of that session.
func (p *DevicePool) hasAvailableSession(jid string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for _, instance := range p.devices {
		instance.mu.RLock()
		client := instance.Client
		available := client != nil && client.Store != nil && client.Store.ID != nil && client.Store.ID.String() == jid
		instance.mu.RUnlock()
		if available {
			return true
		}
	}
	return false
}

func finishMissingDeviceSession(job *repository.DeviceDeletion, available bool, checkpoint func() error, finish func() (*domain.DeviceDeletionResult, error)) (*domain.DeviceDeletionResult, error) {
	if available {
		return nil, repository.ErrDeviceSessionConflict
	}
	if job.Phase != "remote_unlinked" {
		if err := checkpoint(); err != nil {
			return nil, err
		}
		job.Phase = "local_detached"
	}
	return finish()
}

func (p *DevicePool) suspendDeletedDevice(deviceID uuid.UUID) {
	p.mu.Lock()
	instance := p.devices[deviceID]
	delete(p.devices, deviceID)
	target := p.onDemandSyncTargets[deviceID]
	delete(p.onDemandSyncTargets, deviceID)
	p.mu.Unlock()
	if instance != nil {
		instance.mu.Lock()
		instance.Status = domain.DeviceStatusDeleting
		instance.ReceiveMessages = false
		if instance.stopReconnect != nil {
			close(instance.stopReconnect)
			instance.stopReconnect = nil
		}
		instance.reconnecting = false
		instance.mu.Unlock()
		if instance.Client != nil {
			instance.Client.EnableAutoReconnect = false
			instance.Client.Disconnect()
		}
	}
	if target != nil && p.hub != nil {
		p.hub.BroadcastToAccountWithPermission(target.AccountID, domain.PermChats, "history_sync_complete", map[string]interface{}{"device_id": deviceID.String(), "chat_id": target.ChatID.String(), "request_id": target.RequestID.String(), "finished": true, "error": "El dispositivo se está eliminando."})
	}
}

func (p *DevicePool) broadcastDeviceDeletion(accountID uuid.UUID, result *domain.DeviceDeletionResult) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if p.cache != nil {
		_ = p.cache.DelPattern(ctx, "chats:"+accountID.String()+":*")
		_ = p.cache.DelPattern(ctx, "contacts:"+accountID.String()+":*")
	}
	if p.hub != nil {
		p.hub.BroadcastToAccount(accountID, "device_deletion", result)
	}
}

func (p *DevicePool) startDeletionWorkers() {
	p.deletionOnce.Do(func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.shuttingDown {
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		p.deletionCancel = cancel
		for i := 0; i < 2; i++ {
			p.deletionWG.Add(1)
			go func() { defer p.deletionWG.Done(); p.deletionWorker(ctx) }()
		}
	})
}

func (p *DevicePool) deletionWorker(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		job, err := p.repos.Device.ClaimDeletion(ctx)
		if err != nil || job == nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			continue
		}
		lock := p.deviceLifecycleLock(job.DeviceID)
		lock.Lock()
		p.suspendDeletedDevice(job.DeviceID)
		lock.Unlock()
		attemptCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
		result, cleanupErr := p.cleanupDeletedDevice(attemptCtx, job)
		cancel()
		if cleanupErr == nil {
			p.broadcastDeviceDeletion(job.AccountID, result)
			continue
		}
		code := "whatsapp_cleanup_retry"
		if errors.Is(cleanupErr, errDeletionSessionMissing) {
			code = "whatsapp_session_missing"
		}
		if errors.Is(cleanupErr, repository.ErrDeviceSessionConflict) {
			code = "whatsapp_session_identity_conflict"
		}
		retryCtx, retryCancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = p.repos.Device.RetryDeletion(retryCtx, job, time.Now().Add(deletionRetryDelay(job.Attempts, rand.Float64())), code)
		retryCancel()
	}
}

// Checkpoint before DeleteDevice is essential: Logout calls this public
// Container interface only after the remote ACK. A restart can consequently
// distinguish an already removed store from an unverified missing session.
type deletionCheckpointContainer struct {
	store.DeviceContainer
	repo deletionCheckpointRepository
	job  *repository.DeviceDeletion
	ctx  context.Context
	mu   sync.Mutex
}

type deletionCheckpointRepository interface {
	VerifyDeletion(context.Context, *repository.DeviceDeletion) error
	CheckpointUnlinked(context.Context, *repository.DeviceDeletion) error
}

// Reconnection also saves push-name/account state through this interface.
// A late callback must not overwrite a replacement session after its lease
// or bounded cleanup attempt expires.
func (c *deletionCheckpointContainer) PutDevice(ctx context.Context, device *store.Device) error {
	if c.ctx != nil {
		ctx = c.ctx
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if deviceSessionFingerprint(device) != c.job.Fingerprint {
		return repository.ErrDeviceSessionConflict
	}
	if err := c.repo.VerifyDeletion(ctx, c.job); err != nil {
		return err
	}
	return c.DeviceContainer.PutDevice(ctx, device)
}

func (c *deletionCheckpointContainer) DeleteDevice(ctx context.Context, device *store.Device) error {
	if c.ctx != nil {
		ctx = c.ctx
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if deviceSessionFingerprint(device) != c.job.Fingerprint {
		return repository.ErrDeviceSessionConflict
	}
	if err := c.repo.VerifyDeletion(ctx, c.job); err != nil {
		return err
	}
	if err := c.repo.CheckpointUnlinked(ctx, c.job); err != nil {
		return err
	}
	return c.DeviceContainer.DeleteDevice(ctx, device)
}

func (p *DevicePool) cleanupDeletedDevice(ctx context.Context, job *repository.DeviceDeletion) (*domain.DeviceDeletionResult, error) {
	// Session-level reservation also fences a late worker whose lease expired.
	conn, err := p.repos.DB().Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	if job.JID != "" {
		var locked bool
		if err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1::text,71127))`, job.JID).Scan(&locked); err != nil {
			return nil, err
		}
		if !locked {
			return nil, repository.ErrDeviceSessionConflict
		}
		defer func() {
			unlockCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if _, unlockErr := conn.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1::text,71127))`, job.JID); unlockErr != nil {
				_ = conn.Conn().Close(context.Background())
			}
		}()
	}
	if err = p.repos.Device.VerifyDeletion(ctx, job); err != nil {
		return nil, err
	}
	if job.JID == "" {
		return p.repos.Device.FinishLocalDeletion(ctx, job, conn)
	}
	jid, err := types.ParseJID(job.JID)
	if err != nil {
		return nil, repository.ErrDeviceSessionConflict
	}
	waDevice, err := p.store.GetDevice(ctx, jid)
	if err != nil {
		return nil, err
	}
	if waDevice == nil {
		return finishMissingDeviceSession(job, p.hasAvailableSession(job.JID), func() error {
			return p.repos.Device.CheckpointLocalDetachment(ctx, job, conn)
		}, func() (*domain.DeviceDeletionResult, error) {
			if job.Phase == "local_detached" {
				return p.repos.Device.FinishLocalDeletion(ctx, job, conn)
			}
			return p.repos.Device.FinishDeletion(ctx, job)
		})
	}
	if job.Phase == "local_detached" {
		return nil, repository.ErrDeviceSessionConflict
	}
	if job.Fingerprint == "" || deviceSessionFingerprint(waDevice) != job.Fingerprint {
		return nil, repository.ErrDeviceSessionConflict
	}
	waDevice.Container = &deletionCheckpointContainer{DeviceContainer: waDevice.Container, repo: p.repos.Device, job: job, ctx: ctx}
	if job.Phase == "remote_unlinked" {
		if err = waDevice.Delete(ctx); err != nil {
			return nil, err
		}
		return p.repos.Device.FinishDeletion(ctx, job)
	}
	client := whatsmeow.NewClient(waDevice, nil)
	client.EnableAutoReconnect = false
	defer client.Disconnect()
	ready := make(chan bool, 1)
	client.AddEventHandler(func(evt interface{}) {
		switch evt.(type) {
		case *events.Connected:
			select {
			case ready <- true:
			default:
			}
		case *events.LoggedOut:
			select {
			case ready <- false:
			default:
			}
		}
	})
	if err = client.ConnectContext(ctx); err != nil {
		return nil, err
	}
	select {
	case connected := <-ready:
		if connected {
			if err = p.repos.Device.VerifyDeletion(ctx, job); err != nil {
				return nil, err
			}
			if err = client.Logout(ctx); err != nil {
				return nil, err
			}
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	// Library-confirmed revocation also traverses the checkpoint wrapper. No
	// session is erased on a transport/auth error merely to make progress.
	if err = p.repos.Device.Unlinked(ctx, job); err != nil {
		return nil, err
	}
	remaining, err := p.store.GetDevice(ctx, jid)
	if err != nil {
		return nil, err
	}
	if remaining != nil {
		return nil, errDeletionSessionMissing
	}
	return p.repos.Device.FinishDeletion(ctx, job)
}
