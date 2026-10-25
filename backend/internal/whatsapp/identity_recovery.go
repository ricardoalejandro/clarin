package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

var identityRecoveryWorkers sync.Map

func recoveryAgendaCandidates(contacts map[types.JID]types.ContactInfo) ([]string, []domain.WhatsAppPeerObservation) {
	candidates := []string{}
	facts := []domain.WhatsAppPeerObservation{}
	for jid, info := range contacts {
		pn := phoneIdentityJID(jid.ToNonAD())
		if pn.IsEmpty() {
			continue
		}
		// The cache's LID push-name may have been copied by upstream globally. Only
		// this device's actual PN address-book names seed retrospective recovery.
		if strings.TrimSpace(info.FullName) == "" && strings.TrimSpace(info.FirstName) == "" {
			continue
		}
		candidates = append(candidates, pn.String())
		fields := map[string]string{}
		for field, value := range map[string]string{"full_name": info.FullName, "first_name": info.FirstName} {
			if strings.TrimSpace(value) != "" {
				fields[field] = value
			}
		}
		facts = append(facts, peerObservation(pn, types.EmptyJID, "provider_cache", nil, fields))
	}
	return candidates, facts
}

var errIdentityRecoveryGroupsDisabled = errors.New("identity recovery groups disabled")
var errIdentityRecoveryReceiveDisabled = errors.New("identity recovery receive disabled")

func (p *DevicePool) identityRecoveryAllowed(accountID, deviceID uuid.UUID) error {
	if p == nil || !p.GroupsEnabledForAccount(accountID) {
		return errIdentityRecoveryGroupsDisabled
	}
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return err
	}
	instance.mu.RLock()
	receiving := instance.ReceiveMessages
	instance.mu.RUnlock()
	if !receiving {
		return errIdentityRecoveryReceiveDisabled
	}
	return nil
}

// Enqueue is deliberately small enough for connection/sync callbacks. Inventory
// and every provider read belong to the leased cancellable worker.
func (p *DevicePool) EnqueueIdentityRecovery(ctx context.Context, accountID, deviceID uuid.UUID, trigger string) error {
	if p == nil || p.repos == nil || p.repos.Chat == nil {
		return ErrDeviceDisconnected
	}
	if err := p.identityRecoveryAllowed(accountID, deviceID); err != nil {
		return err
	}
	fingerprint, err := p.DeviceIdentitySession(ctx, accountID, deviceID)
	if err != nil {
		return err
	}
	if _, err = p.repos.Chat.EnqueueWhatsAppIdentityRecovery(ctx, accountID, deviceID, fingerprint, trigger, nil); err != nil {
		return err
	}
	p.broadcastIdentityRevision(ctx, accountID, deviceID)
	return nil
}
func (p *DevicePool) inventoryIdentityRecovery(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun) error {
	if err := p.identityRecoveryAllowed(run.AccountID, run.DeviceID); err != nil {
		return err
	}
	instance, err := p.reportDevice(run.AccountID, run.DeviceID)
	if err != nil {
		return err
	}
	if err = p.requirePeerIdentitySession(instance, run.SessionFingerprint); err != nil {
		return err
	}
	contacts, err := instance.Client.Store.Contacts.GetAllContacts(ctx)
	if err != nil {
		return err
	}
	candidates, facts := recoveryAgendaCandidates(contacts)
	for start := 0; start < len(facts); start += 500 {
		end := start + 500
		if end > len(facts) {
			end = len(facts)
		}
		if err = p.observePeerIdentitiesForSession(ctx, instance, run.SessionFingerprint, facts[start:end]); err != nil {
			return err
		}
	}
	cursor := ""
	for {
		private, readErr := p.repos.Chat.IdentityRecoveryPrivatePNCandidates(ctx, run.AccountID, run.DeviceID, cursor, 500)
		if readErr != nil {
			return readErr
		}
		candidates = append(candidates, private...)
		if len(private) < 500 {
			break
		}
		cursor = private[len(private)-1]
	}
	if err = p.requirePeerIdentitySession(instance, run.SessionFingerprint); err != nil {
		return err
	}
	_, err = p.repos.Chat.EnqueueWhatsAppIdentityRecovery(ctx, run.AccountID, run.DeviceID, run.SessionFingerprint, run.Phase, candidates)
	return err
}

// RunIdentityRecovery shares the authenticated connected clients. Two durable
// leases globally, one run per device, and DB pacing prevent bursts/restarts.
func (p *DevicePool) RunIdentityRecovery(ctx context.Context) {
	if p == nil || p.repos == nil || p.repos.Chat == nil {
		return
	}
	if _, loaded := identityRecoveryWorkers.LoadOrStore(p, true); loaded {
		return
	}
	defer identityRecoveryWorkers.Delete(p)
	var workers sync.WaitGroup
	for i := 0; i < 2; i++ {
		workers.Add(1)
		go func() { defer workers.Done(); p.identityRecoveryLoop(ctx) }()
	}
	bootstrap := func() {
		type scope struct{ account, device uuid.UUID }
		scopes := []scope{}
		p.mu.RLock()
		for _, device := range p.devices {
			if device != nil {
				scopes = append(scopes, scope{device.AccountID, device.ID})
			}
		}
		p.mu.RUnlock()
		for _, scope := range scopes {
			if ctx.Err() != nil {
				return
			}
			status, err := p.repos.Chat.IdentityRecoveryStatus(ctx, scope.account, scope.device)
			if !p.GroupsEnabledForAccount(scope.account) || p.identityRecoveryAllowed(scope.account, scope.device) != nil || err != nil || (status != nil && status.Phase != "paused") {
				continue
			}
			requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			_ = p.EnqueueIdentityRecovery(requestCtx, scope.account, scope.device, "bootstrap")
			cancel()
		}
	}
	bootstrap()
	crmRevisions := map[uuid.UUID]int64{}
	p.broadcastCRMIdentityRevisions(ctx, crmRevisions)
	crmTicker := time.NewTicker(5 * time.Second)
	defer crmTicker.Stop()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			workers.Wait()
			return
		case <-crmTicker.C:
			p.broadcastCRMIdentityRevisions(ctx, crmRevisions)
		case <-ticker.C:
			bootstrap()
		}
	}
}
func (p *DevicePool) identityRecoveryLoop(ctx context.Context) {
	for ctx.Err() == nil {
		run, err := p.repos.Chat.ClaimIdentityRecoveryRun(ctx)
		if err == nil {
			p.processIdentityRecovery(ctx, run)
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) && ctx.Err() == nil {
			log.Printf("[IdentityRecovery] queue temporarily unavailable")
		}
		if !identityRecoveryWait(ctx, time.Second) {
			return
		}
	}
}
func identityRecoveryWait(ctx context.Context, delay time.Duration) bool {
	if delay <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
func (p *DevicePool) processIdentityRecovery(parent context.Context, run *domain.WhatsAppIdentityRecoveryRun) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if p.repos.Chat.RenewIdentityRecoveryLease(ctx, run) != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-heartbeatDone }()
	finish := func(state, phase, code string, delay time.Duration) {
		finishCtx, release := context.WithTimeout(context.Background(), 10*time.Second)
		defer release()
		if err := p.repos.Chat.FinishIdentityRecoveryCycle(finishCtx, run, state, phase, code, delay); err != nil && !errors.Is(err, repository.ErrWhatsAppIdentitySessionChanged) {
			log.Printf("[IdentityRecovery] checkpoint unavailable account=%s device=%s", run.AccountID, run.DeviceID)
		}
		p.broadcastIdentityRevision(finishCtx, run.AccountID, run.DeviceID)
	}
	failure := func(err error, phase, originCode string) {
		code := identityRecoveryFailureCode(err, originCode)
		switch code {
		case "session_changed":
			finish("cancelled", phase, "session_changed", 0)
		case "groups_disabled":
			finish("partial", "paused", "groups_disabled", 0)
		case "receive_disabled":
			finish("partial", "paused", "receive_disabled", 0)
		default:
			if availabilityErr := p.identityRecoveryAllowed(run.AccountID, run.DeviceID); availabilityErr != nil {
				guardCode := identityRecoveryFailureCode(availabilityErr, "device_disconnected")
				if guardCode == "groups_disabled" || guardCode == "receive_disabled" {
					finish("partial", "paused", guardCode, 0)
				} else {
					finish("waiting_connection", phase, "device_disconnected", 30*time.Second)
				}
			} else {
				finish("pending", phase, code, 30*time.Second)
			}
		}
	}
	lastAppStateFailureCode := ""
	for ctx.Err() == nil {
		if err := p.identityRecoveryAllowed(run.AccountID, run.DeviceID); err != nil {
			failure(err, run.Phase, "provider_unavailable")
			return
		}
		live, err := p.DeviceIdentitySession(ctx, run.AccountID, run.DeviceID)
		if err != nil {
			failure(err, run.Phase, "provider_unavailable")
			return
		}
		if live != run.SessionFingerprint {
			failure(repository.ErrWhatsAppIdentitySessionChanged, run.Phase, "session_changed")
			return
		}
		switch run.Phase {
		case "inventory", "inventory_after_appstate":
			if err = p.inventoryIdentityRecovery(ctx, run); err != nil {
				failure(err, run.Phase, "persistence_unavailable")
				return
			}
			phase := identityRecoveryInventoryNextPhase(run.Phase)
			if err = p.repos.Chat.CheckpointIdentityRecovery(ctx, run, phase, false); err != nil {
				failure(err, run.Phase, "persistence_unavailable")
				return
			}
		case "lookup", "lookup_after_appstate":
			waiting, delay, lookupErr := p.lookupIdentityRecovery(ctx, run)
			if lookupErr != nil {
				failure(lookupErr, run.Phase, "persistence_unavailable")
				return
			}
			phase := identityRecoveryLookupNextPhase(run.Phase, run.AppStateAcknowledged, waiting)
			if phase == "" {
				if err = p.checkpointPartialIdentityRecovery(ctx, run); err != nil {
					failure(err, run.Phase, "projection_unavailable")
					return
				}
				finish("pending", run.Phase, "", delay)
				return
			}
			if err = p.repos.Chat.CheckpointIdentityRecovery(ctx, run, phase, false); err != nil {
				failure(err, run.Phase, "persistence_unavailable")
				return
			}
		case "appstate":
			if run.AppStateAcknowledged {
				if err = p.repos.Chat.CheckpointIdentityRecovery(ctx, run, "projection", false); err != nil {
					failure(err, run.Phase, "persistence_unavailable")
					return
				}
				continue
			}
			err = p.RecoverDeviceIdentityAppState(ctx, run.AccountID, run.DeviceID, run.SessionFingerprint)
			if errors.Is(err, repository.ErrWhatsAppIdentitySessionChanged) {
				failure(err, run.Phase, "persistence_unavailable")
				return
			}
			if err != nil {
				lastAppStateFailureCode = identityRecoveryFailureCode(err, "appstate_unavailable")
				// Already recovered PN identities remain usable even while AppState waits.
				if _, projectionErr := p.projectIdentityRecovery(ctx, run); projectionErr != nil {
					failure(projectionErr, run.Phase, "persistence_unavailable")
					return
				}
				if run.Attempts < 3 {
					finish("pending", "appstate", lastAppStateFailureCode, domain.WhatsAppIdentityRecoveryRetryDelay(run.Attempts+1))
					return
				}
				if err = p.repos.Chat.CheckpointIdentityRecovery(ctx, run, "projection", false); err != nil {
					failure(err, run.Phase, "persistence_unavailable")
					return
				}
			} else if err = p.repos.Chat.CheckpointIdentityRecovery(ctx, run, "inventory_after_appstate", true); err != nil {
				failure(err, run.Phase, "persistence_unavailable")
				return
			}
		case "projection":
			unresolved, projectionErr := p.projectIdentityRecovery(ctx, run)
			if projectionErr != nil {
				failure(projectionErr, run.Phase, "persistence_unavailable")
				return
			}
			if err = p.repos.Chat.SetIdentityRecoveryUnresolved(ctx, run, unresolved); err != nil {
				failure(err, run.Phase, "persistence_unavailable")
				return
			}
			_, unavailable, _, readErr := p.repos.Chat.IdentityRecoveryRemaining(ctx, run)
			if readErr != nil {
				failure(readErr, run.Phase, "persistence_unavailable")
				return
			}
			state, code := "completed", ""
			if unavailable > 0 || unresolved > 0 || !run.AppStateAcknowledged {
				state = "partial"
				if !run.AppStateAcknowledged {
					code = lastAppStateFailureCode
					if code == "" {
						code = "appstate_unavailable"
					}
				}
			}
			finish(state, "done", code, 0)
			return
		default:
			if err = p.repos.Chat.CheckpointIdentityRecovery(ctx, run, "inventory", false); err != nil {
				failure(err, run.Phase, "persistence_unavailable")
				return
			}
		}
		p.broadcastIdentityRevision(ctx, run.AccountID, run.DeviceID)
	}
	finish("pending", run.Phase, "cancelled", 30*time.Second)
}

func (p *DevicePool) lookupIdentityRecovery(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun) (bool, time.Duration, error) {
	for ctx.Err() == nil {
		if err := p.identityRecoveryAllowed(run.AccountID, run.DeviceID); err != nil {
			return false, 0, err
		}
		phones, err := p.repos.Chat.PendingIdentityRecoveryBatch(ctx, run)
		if err != nil {
			return false, 0, err
		}
		if len(phones) == 0 {
			break
		}
		known, err := p.repos.Chat.WhatsAppPeerAliases(ctx, run.AccountID, run.DeviceID, phones)
		if err != nil {
			return false, 0, err
		}
		existing, pending := []string{}, []string{}
		for _, pn := range phones {
			if known.LIDForPN[pn] != "" {
				existing = append(existing, pn)
			} else {
				pending = append(pending, pn)
			}
		}
		if len(existing) > 0 {
			if err = p.repos.Chat.CompleteIdentityRecoveryBatch(ctx, run, existing, true); err != nil {
				return false, 0, err
			}
		}
		if len(pending) > 0 {
			delay, err := p.repos.Chat.ReserveIdentityRecoveryLookup(ctx, run)
			if err != nil {
				return false, 0, err
			}
			if !identityRecoveryWait(ctx, delay) {
				return false, 0, ctx.Err()
			}
			if err = p.identityRecoveryAllowed(run.AccountID, run.DeviceID); err != nil {
				return false, 0, err
			}
			lookupStarted := time.Now()
			lookupErr := p.RecoverDeviceIdentityPNs(ctx, run.AccountID, run.DeviceID, run.SessionFingerprint, pending)
			if lookupErr != nil {
				logIdentityRecoveryLookupFailure(run.AccountID, run.DeviceID, len(pending), time.Since(lookupStarted), lookupErr)
			}
			if ctx.Err() != nil {
				return false, 0, ctx.Err()
			}
			if lookupErr != nil {
				if guardErr := p.identityRecoveryAllowed(run.AccountID, run.DeviceID); guardErr != nil {
					return false, 0, guardErr
				}
			}
			succeeded, outcomeErr := identityRecoveryLookupOutcome(lookupErr)
			if outcomeErr != nil {
				return false, 0, outcomeErr
			}
			if err = p.repos.Chat.CompleteIdentityRecoveryBatch(ctx, run, pending, succeeded); err != nil {
				return false, 0, err
			}
		}
		p.broadcastIdentityRevision(ctx, run.AccountID, run.DeviceID)
	}
	pending, _, next, err := p.repos.Chat.IdentityRecoveryRemaining(ctx, run)
	if err != nil {
		return false, 0, err
	}
	if ctx.Err() != nil {
		return false, 0, ctx.Err()
	}
	if pending > 0 {
		delay := 30 * time.Second
		if next != nil {
			delay = time.Until(*next)
			if delay < 0 {
				delay = 0
			}
		}
		return true, delay, nil
	}
	return false, 0, nil
}

// Publish already recovered identities before waiting on unrelated candidates.
func (p *DevicePool) checkpointPartialIdentityRecovery(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun) error {
	unresolved, err := p.projectIdentityRecovery(ctx, run)
	if err != nil {
		return withIdentityRecoveryFailureCode("projection_unavailable", err)
	}
	if err = p.repos.Chat.SetIdentityRecoveryUnresolved(ctx, run, unresolved); err != nil {
		return withIdentityRecoveryFailureCode("persistence_unavailable", err)
	}
	return nil
}

func (p *DevicePool) projectIdentityRecovery(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun) (int, error) {
	cursor := uuid.Nil
	incomplete := map[string]bool{}
	identities := p.GroupParticipantIdentities(ctx, run.AccountID, run.DeviceID)
	for {
		groups, err := p.repos.Chat.IdentityRecoveryGroups(ctx, run.AccountID, run.DeviceID, cursor)
		if err != nil {
			return len(incomplete), err
		}
		for _, group := range groups {
			members, err := identities.Resolve(ctx, group.Members)
			if err != nil {
				return len(incomplete), err
			}
			for _, member := range members {
				if member.NameSource == "unavailable" || member.Phone == "" {
					key := member.LID
					if key == "" {
						key = member.JID
					}
					incomplete[key] = true
				}
			}
			changed, err := p.repos.Chat.ProjectIdentityRecoveryGroup(ctx, run, group, members)
			if err != nil {
				return len(incomplete), err
			}
			if changed && p.hub != nil {
				p.hub.BroadcastToAccountWithPermission(run.AccountID, domain.PermChats, "chat_group_updated", map[string]interface{}{"chat_id": group.ChatID, "device_id": run.DeviceID})
			}
			cursor = group.ChatID
		}
		if len(groups) < 50 {
			break
		}
	}
	return len(incomplete), nil
}

func identityRecoveryInventoryNextPhase(phase string) string {
	if phase == "inventory_after_appstate" {
		return "lookup_after_appstate"
	}
	return "lookup"
}

// A deferred/failed initial PN batch must not postpone the independent AppState
// fallback until its entire retry budget is exhausted.
func identityRecoveryLookupNextPhase(phase string, acknowledged, waiting bool) string {
	if phase == "lookup" && !acknowledged {
		return "appstate"
	}
	if waiting {
		return ""
	}
	return "projection"
}

// A safe diagnostic has no error message, response node, identity or request data.
// IQError.Error() may serialize raw XML, so callers must log these fields only.
type identityRecoveryLookupDiagnostic struct {
	ErrorType        string `json:"error_type"`
	BatchSize        int    `json:"batch_size"`
	IQCode           int    `json:"iq_code"`
	ContextDeadline  bool   `json:"context_deadline"`
	ContextCancelled bool   `json:"context_cancelled"`
	IQTimeout        bool   `json:"iq_timeout"`
	Disconnected     bool   `json:"disconnected"`
	NetworkTimeout   bool   `json:"network_timeout"`
}

func identityRecoveryLookupDiagnosticFor(err error, batchSize int) identityRecoveryLookupDiagnostic {
	out := identityRecoveryLookupDiagnostic{ErrorType: fmt.Sprintf("%T", err), BatchSize: batchSize,
		ContextDeadline: errors.Is(err, context.DeadlineExceeded), ContextCancelled: errors.Is(err, context.Canceled),
		IQTimeout:    errors.Is(err, whatsmeow.ErrIQTimedOut),
		Disconnected: errors.Is(err, whatsmeow.ErrNotConnected) || errors.Is(err, whatsmeow.ErrIQDisconnected) || errors.Is(err, whatsmeow.ErrNotLoggedIn) || errors.Is(err, ErrDeviceDisconnected) || errors.Is(err, ErrGroupReportDeviceNotConnected)}
	var iq *whatsmeow.IQError
	if errors.As(err, &iq) {
		out.IQCode = iq.Code
	}
	var network net.Error
	if errors.As(err, &network) {
		out.NetworkTimeout = network.Timeout()
	}
	return out
}
func logIdentityRecoveryLookupFailure(accountID, deviceID uuid.UUID, batchSize int, elapsed time.Duration, err error) {
	diagnostic := identityRecoveryLookupDiagnosticFor(err, batchSize)
	log.Printf("[IdentityRecovery] lookup failed account=%s device=%s batch_size=%d elapsed_ms=%d error_type=%s iq_code=%d context_deadline=%t context_cancelled=%t iq_timeout=%t disconnected=%t network_timeout=%t",
		accountID, deviceID, diagnostic.BatchSize, elapsed.Milliseconds(), diagnostic.ErrorType, diagnostic.IQCode, diagnostic.ContextDeadline, diagnostic.ContextCancelled, diagnostic.IQTimeout, diagnostic.Disconnected, diagnostic.NetworkTimeout)
}

// Only an actual provider failure consumes a PN item's provider retry budget.
// Persistence, lifecycle and policy errors leave all candidate items untouched.
func identityRecoveryLookupOutcome(err error) (succeeded bool, fatal error) {
	if err == nil {
		return true, nil
	}
	if identityRecoveryFailureCode(err, "provider_unavailable") == "provider_unavailable" {
		return false, nil
	}
	return false, err
}

// Error provenance is explicit at the nearest boundary; a storage/checkpoint
// failure must never be presented as a WhatsApp/provider outage.
type identityRecoveryCodedFailure struct {
	code string
	err  error
}

func (e *identityRecoveryCodedFailure) Error() string { return e.err.Error() }
func (e *identityRecoveryCodedFailure) Unwrap() error { return e.err }
func withIdentityRecoveryFailureCode(code string, err error) error {
	if err == nil {
		return nil
	}
	return &identityRecoveryCodedFailure{code: code, err: err}
}
func identityRecoveryFailureCode(err error, fallback string) string {
	switch {
	case errors.Is(err, repository.ErrWhatsAppIdentitySessionChanged):
		return "session_changed"
	case errors.Is(err, errIdentityRecoveryGroupsDisabled):
		return "groups_disabled"
	case errors.Is(err, errIdentityRecoveryReceiveDisabled):
		return "receive_disabled"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, ErrGroupReportDeviceNotConnected), errors.Is(err, ErrDeviceDisconnected), errors.Is(err, whatsmeow.ErrNotConnected), errors.Is(err, whatsmeow.ErrIQDisconnected), errors.Is(err, whatsmeow.ErrNotLoggedIn):
		return "device_disconnected"
	}
	var coded *identityRecoveryCodedFailure
	if errors.As(err, &coded) {
		return coded.code
	}
	var queryError *pgconn.PgError
	var connectionError *pgconn.ConnectError
	if errors.As(err, &queryError) || errors.As(err, &connectionError) || errors.Is(err, pgx.ErrTxClosed) || errors.Is(err, pgx.ErrTxCommitRollback) {
		return "persistence_unavailable"
	}
	if fallback == "" {
		return "provider_unavailable"
	}
	return fallback
}
