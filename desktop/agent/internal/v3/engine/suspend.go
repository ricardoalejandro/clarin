package engine

import (
	"context"
	"errors"

	"github.com/naperu/clarin-offline-agent/internal/v3/catalog"
)

// SuspendGrant fails a local grant closed while the browser and backend agree
// a replacement selection/lease. It intentionally preserves encrypted data,
// keys and durable operations; ActivateLease is the only path back to
// available. Repeated suspension is idempotent and does not churn epochs.
func (e *Engine) SuspendGrant(ctx context.Context, browserID, grantID, reason string) (int64, error) {
	return e.suspendGrant(ctx, browserID, grantID, reason, true)
}

func (e *Engine) suspendGrant(ctx context.Context, browserID, grantID, reason string, rejectPending bool) (int64, error) {
	if reason != "selection_changed" {
		return 0, ErrInvalid
	}
	unlockGrant := e.lockGrant(grantID)
	defer unlockGrant()
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil || grant.Tuple.BrowserProfileID != browserID {
		return 0, ErrNotFound
	}
	if grant.State == "revoked" {
		return 0, ErrGrantRevoked
	}
	profile, err := e.catalog.BrowserProfile(ctx, browserID)
	if err != nil || profile.State != "active" {
		return 0, ErrDescriptor
	}
	if grant.State == "expired" {
		return profile.Epoch, nil
	}
	if grant.State != "available" {
		return 0, ErrGrantLocked
	}

	// Revoke capabilities first so an already-open tab cannot enqueue another
	// operation under the stale selection while the durable state is updated.
	e.sessions.LockBrowser(browserID)
	if rejectPending {
		store, storeErr := e.vaultFor(grant)
		if storeErr != nil {
			return 0, storeErr
		}
		_, pending, _, countErr := store.Counts(ctx)
		if countErr != nil {
			return 0, countErr
		}
		if pending > 0 {
			return 0, ErrPendingOperations
		}
	}
	if err := e.catalog.SetGrantState(ctx, grantID, "expired"); err != nil {
		return 0, err
	}
	return e.catalog.BumpBrowserEpoch(ctx, browserID)
}

func (e *Engine) suspendGrantFromSync(ctx context.Context, grant *catalog.Grant) error {
	if grant == nil {
		return errors.New("sync grant is unavailable")
	}
	// The server has already established that the old authority is stale. It
	// must fail closed even when a durable outbox still needs a rejection or
	// conflict receipt under the transport-only channel.
	_, err := e.suspendGrant(ctx, grant.Tuple.BrowserProfileID, grant.Tuple.GrantID, "selection_changed", false)
	return err
}
