package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// Only explicit provider PN fields may use the historical c.us spelling.
// This helper never turns a LID, a requested number or a username into a PN.
func normalizePeerWireJID(jid types.JID) types.JID {
	jid = jid.ToNonAD()
	if jid.Server == types.LegacyUserServer {
		candidate := types.NewJID(jid.User, types.DefaultUserServer)
		if !phoneIdentityJID(candidate).IsEmpty() {
			return candidate
		}
	}
	return jid
}

func peerAliasObservation(pn, lid types.JID, source string, at time.Time) (domain.WhatsAppPeerObservation, bool) {
	pn, lid = phoneIdentityJID(normalizePeerWireJID(pn)), lid.ToNonAD()
	if pn.IsEmpty() || lid.Server != types.HiddenUserServer || len(lid.User) < 1 || len(lid.User) > 32 {
		return domain.WhatsAppPeerObservation{}, false
	}
	for _, r := range lid.User {
		if r < '0' || r > '9' {
			return domain.WhatsAppPeerObservation{}, false
		}
	}
	return peerObservation(lid, pn, source, &at, nil), true
}

func peerIsOnWhatsAppObservations(results []types.IsOnWhatsAppResponse) []domain.WhatsAppPeerObservation {
	out := make([]domain.WhatsAppPeerObservation, 0, len(results))
	at := time.Now().UTC()
	for _, result := range results {
		if !result.IsIn {
			continue
		}
		// Query and any previously cached mapping are deliberately not evidence.
		if row, ok := peerAliasObservation(result.PhoneNumber, result.JID, "usync_check", at); ok {
			out = append(out, row)
		}
	}
	return out
}

func peerUserInfoObservations(results map[types.JID]types.UserInfo) []domain.WhatsAppPeerObservation {
	out := make([]domain.WhatsAppPeerObservation, 0, len(results))
	at := time.Now().UTC()
	for returnedJID, info := range results {
		if row, ok := peerAliasObservation(returnedJID, info.LID, "user_info", at); ok {
			out = append(out, row)
		}
	}
	return out
}

func contactEventMayMutateCRM(evt *events.Contact) bool {
	return evt != nil && evt.Action != nil && !evt.FromFullSync
}

// DeviceIdentitySession exposes an opaque generation fence, not session material.
func (p *DevicePool) DeviceIdentitySession(ctx context.Context, accountID, deviceID uuid.UUID) (string, error) {
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return "", err
	}
	fingerprint := deviceSessionFingerprint(instance.Client.Store)
	if fingerprint == "" {
		return "", ErrDeviceDisconnected
	}
	return fingerprint, nil
}

func (p *DevicePool) requirePeerIdentitySession(instance *DeviceInstance, expected string) error {
	if p == nil || instance == nil || expected == "" || instance.Client == nil || instance.Client.Store == nil {
		return repository.ErrWhatsAppIdentitySessionChanged
	}
	current := p.GetDevice(instance.ID)
	if current != instance || current.AccountID != instance.AccountID || deviceSessionFingerprint(current.Client.Store) != expected {
		return repository.ErrWhatsAppIdentitySessionChanged
	}
	return nil
}

func (p *DevicePool) getUserInfoWithIdentity(ctx context.Context, instance *DeviceInstance, jids []types.JID, fingerprint string) (map[types.JID]types.UserInfo, error) {
	if err := p.requirePeerIdentitySession(instance, fingerprint); err != nil {
		return nil, err
	}
	operationCtx, release, err := p.retainDeviceOperation(ctx, instance.AccountID, instance.ID)
	if err != nil {
		return nil, err
	}
	defer release()
	results, err := instance.Client.GetUserInfo(operationCtx, jids)
	if err != nil {
		return nil, err
	}
	if err = p.requirePeerIdentitySession(instance, fingerprint); err != nil {
		return nil, err
	}
	if err = p.observePeerIdentitiesForSession(operationCtx, instance, fingerprint, peerUserInfoObservations(results)); err != nil {
		return nil, withIdentityRecoveryFailureCode("persistence_unavailable", err)
	}
	return results, nil
}

// RecoverDeviceIdentityPNs verifies existing PN candidates without creating CRM rows.
func (p *DevicePool) RecoverDeviceIdentityPNs(ctx context.Context, accountID, deviceID uuid.UUID, fingerprint string, phones []string) error {
	if len(phones) == 0 {
		return nil
	}
	if len(phones) > 50 {
		return fmt.Errorf("identity recovery batch exceeds 50")
	}
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return err
	}
	jids := make([]types.JID, 0, len(phones))
	for _, raw := range phones {
		jid, err := types.ParseJID(raw)
		if err != nil {
			return fmt.Errorf("invalid identity recovery candidate")
		}
		jid = phoneIdentityJID(normalizePeerWireJID(jid))
		if jid.IsEmpty() {
			return fmt.Errorf("invalid identity recovery candidate")
		}
		jids = append(jids, jid)
	}
	requestCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	_, err = p.getUserInfoWithIdentity(requestCtx, instance, jids, fingerprint)
	return err
}

// An SDK fetch succeeding is not an acknowledgement of Clarin persistence.
// Events dispatch synchronously in the pinned SDK; this epoch collects failures
// until FetchAppState has dispatched its final completion callback.
type peerIdentityRecoveryEpoch struct {
	mu             sync.Mutex
	complete       bool
	persistenceErr error
}

var peerIdentityRecoveryEpochs sync.Map // *DeviceInstance -> *peerIdentityRecoveryEpoch

func (e *peerIdentityRecoveryEpoch) record(err error) {
	if err == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.persistenceErr == nil {
		e.persistenceErr = err
	}
}
func (e *peerIdentityRecoveryEpoch) result() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.persistenceErr != nil {
		return withIdentityRecoveryFailureCode("persistence_unavailable", fmt.Errorf("identity recovery persistence: %w", e.persistenceErr))
	}
	if !e.complete {
		return errors.New("identity recovery completion not acknowledged")
	}
	return nil
}
func recordPeerIdentityPersistence(instance *DeviceInstance, err error) {
	if value, ok := peerIdentityRecoveryEpochs.Load(instance); ok {
		value.(*peerIdentityRecoveryEpoch).record(err)
	}
}
func recordPeerIdentitySyncError(instance *DeviceInstance, name appstate.WAPatchName, err error) {
	if name == appstate.WAPatchCriticalUnblockLow {
		recordPeerIdentityPersistence(instance, err)
	}
}

func recordPeerIdentitySyncComplete(instance *DeviceInstance, name appstate.WAPatchName) {
	if name != appstate.WAPatchCriticalUnblockLow {
		return
	}
	if value, ok := peerIdentityRecoveryEpochs.Load(instance); ok {
		epoch := value.(*peerIdentityRecoveryEpoch)
		epoch.mu.Lock()
		epoch.complete = true
		epoch.mu.Unlock()
	}
}

func (p *DevicePool) RecoverDeviceIdentityAppState(ctx context.Context, accountID, deviceID uuid.UUID, fingerprint string) error {
	operationCtx, release, err := p.retainDeviceOperation(ctx, accountID, deviceID)
	if err != nil {
		return err
	}
	defer release()
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return err
	}
	if err = p.requirePeerIdentitySession(instance, fingerprint); err != nil {
		return err
	}
	if !instance.Client.EmitAppStateEventsOnFullSync {
		return errors.New("identity recovery events disabled")
	}
	epoch := &peerIdentityRecoveryEpoch{}
	if _, loaded := peerIdentityRecoveryEpochs.LoadOrStore(instance, epoch); loaded {
		return errors.New("identity recovery already running")
	}
	defer peerIdentityRecoveryEpochs.Delete(instance)
	requestCtx, cancel := context.WithTimeout(operationCtx, 60*time.Second)
	defer cancel()
	if err = instance.Client.FetchAppState(requestCtx, appstate.WAPatchCriticalUnblockLow, true, false); err != nil {
		return err
	}
	if err = p.requirePeerIdentitySession(instance, fingerprint); err != nil {
		return err
	}
	return epoch.result()
}
