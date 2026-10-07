package whatsapp

import (
	"context"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow/store"
)

type deviceLifecycleContextKey struct{}

// Normal clients also erase their store on confirmed remote revocation. They
// must not bypass a pending deletion's durable checkpoint after it commits.
type activeDeviceContainer struct {
	store.DeviceContainer
	pool                *DevicePool
	accountID, deviceID uuid.UUID
}

type pairedSessionRepository interface {
	WithSessionReservation(context.Context, uuid.UUID, uuid.UUID, string, func(context.Context) error) error
	RememberPairedSession(context.Context, uuid.UUID, uuid.UUID, string) error
}

func savePairedDevice(ctx context.Context, repo pairedSessionRepository, container store.DeviceContainer, accountID, deviceID uuid.UUID, device *store.Device) error {
	return repo.WithSessionReservation(ctx, accountID, deviceID, device.ID.String(), func(ctx context.Context) error {
		if err := repo.RememberPairedSession(ctx, accountID, deviceID, device.ID.String()); err != nil {
			return err
		}
		return container.PutDevice(ctx, device)
	})
}

func (c *activeDeviceContainer) PutDevice(ctx context.Context, device *store.Device) error {
	if device == nil || device.ID == nil {
		return repository.ErrDeviceSessionConflict
	}
	release, err := c.pool.acquireDeviceOperation(ctx, c.accountID, c.deviceID)
	if err != nil {
		return err
	}
	defer release()
	return savePairedDevice(ctx, c.pool.repos.Device, c.DeviceContainer, c.accountID, c.deviceID, device)
}

func (c *activeDeviceContainer) DeleteDevice(ctx context.Context, device *store.Device) error {
	if held, _ := ctx.Value(deviceLifecycleContextKey{}).(uuid.UUID); held != c.deviceID {
		release, err := c.pool.acquireDeviceOperation(ctx, c.accountID, c.deviceID)
		if err != nil {
			return err
		}
		defer release()
	}
	if device == nil || device.ID == nil {
		return repository.ErrDeviceSessionConflict
	}
	return c.pool.repos.Device.WithSessionReservation(ctx, c.accountID, c.deviceID, device.ID.String(), func(ctx context.Context) error {
		// Library Delete is reached only after a logout ACK or confirmed remote
		// revocation. No caller force-deletes after a failed Logout.
		if err := c.pool.repos.Device.UpdateStatus(ctx, c.deviceID, domain.DeviceStatusLoggedOut); err != nil {
			return err
		}
		return c.DeviceContainer.DeleteDevice(ctx, device)
	})
}
