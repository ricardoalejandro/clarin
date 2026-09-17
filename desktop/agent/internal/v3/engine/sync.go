package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/naperu/clarin-offline-agent/internal/v3/catalog"
	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
	"github.com/naperu/clarin-offline-agent/internal/v3/protocol"
	"github.com/naperu/clarin-offline-agent/internal/v3/session"
	"github.com/naperu/clarin-offline-agent/internal/v3/vault"
)

const SyncProofType = "clarin-offline-sync-proof+jwt"

const maxSyncRequestBytes = 2 << 20

var ErrOperationEnvelopeTooLarge = errors.New("operation_envelope_too_large")

type SyncChallenge struct {
	ChallengeID string    `json:"challenge_id"`
	Nonce       string    `json:"nonce"`
	ExpiresAt   time.Time `json:"expires_at"`
	ServerTime  time.Time `json:"server_time"`
}

type SyncInventoryItem struct {
	SelectionID string `json:"selection_id"`
	HeadVersion int64  `json:"head_version"`
	ContentHash string `json:"content_hash"`
}

type SyncRequest struct {
	GrantID                 string              `json:"grant_id"`
	ChallengeID             string              `json:"challenge_id"`
	Nonce                   string              `json:"nonce"`
	Counter                 int64               `json:"counter"`
	InstallationID          string              `json:"installation_id"`
	WindowsPrincipalID      string              `json:"windows_principal_id"`
	BrowserProfileID        string              `json:"browser_profile_id"`
	TransportEnvelopes      []string            `json:"transport_envelopes"`
	Inventory               []SyncInventoryItem `json:"inventory"`
	WantSnapshots           []string            `json:"want_snapshots"`
	ControlAcknowledgements []string            `json:"control_acknowledgements,omitempty"`
	UsedStorageBytes        int64               `json:"used_storage_bytes"`
}

type PreparedSync struct {
	Request                 SyncRequest
	ServiceProof            string
	TransportCapability     string
	OperationIDs            []string
	ControlAcknowledgements []string
}

type SealedServerEnvelope struct {
	EnvelopeID  string `json:"envelope_id"`
	Kind        string `json:"kind"`
	CompactJWE  string `json:"compact_jwe"`
	ContentHash string `json:"content_hash"`
}

type SyncResponse struct {
	State          string                 `json:"state"`
	Controls       []string               `json:"controls"`
	Receipts       []SealedServerEnvelope `json:"receipts"`
	Snapshots      []SealedServerEnvelope `json:"snapshots"`
	Inventory      []SyncInventoryItem    `json:"inventory"`
	ServerTime     time.Time              `json:"server_time"`
	Lease          string                 `json:"lease,omitempty"`
	LeaseExpiresAt time.Time              `json:"lease_expires_at,omitempty"`
}

func (e *Engine) TransportGrantIDs(ctx context.Context) ([]string, error) {
	grants, err := e.catalog.TransportGrants(ctx, 100)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(grants))
	for _, grant := range grants {
		ids = append(ids, grant.Tuple.GrantID)
	}
	return ids, nil
}

func (e *Engine) TransportChallengeBinding(ctx context.Context, grantID string) (installationID, capability string, err error) {
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil || len(grant.TransportCapability) == 0 || grant.Tuple.InstallationID != e.installation.ID {
		return "", "", ErrNotFound
	}
	return grant.Tuple.InstallationID, string(grant.TransportCapability), nil
}

func (e *Engine) BuildSync(ctx context.Context, grantID string, challenge SyncChallenge) (*PreparedSync, error) {
	if !canonicalUUID(challenge.ChallengeID) || len(challenge.Nonce) != 43 || !challenge.ExpiresAt.After(e.now()) {
		return nil, ErrInvalid
	}
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil || len(grant.TransportCapability) == 0 {
		return nil, ErrNotFound
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return nil, err
	}
	pending, err := store.PendingEnvelopes(ctx, e.now(), 100)
	if err != nil {
		return nil, err
	}
	counter, err := e.catalog.NextCounter(ctx)
	if err != nil {
		return nil, err
	}
	acknowledgements, err := store.PendingControlAcknowledgements(ctx, 100)
	if err != nil {
		return nil, err
	}
	request := SyncRequest{GrantID: grantID, ChallengeID: challenge.ChallengeID, Nonce: challenge.Nonce, Counter: counter,
		InstallationID: grant.Tuple.InstallationID, WindowsPrincipalID: grant.Tuple.WindowsPrincipalID, BrowserProfileID: grant.Tuple.BrowserProfileID,
		TransportEnvelopes: make([]string, 0, len(pending)), Inventory: []SyncInventoryItem{}, WantSnapshots: []string{}, ControlAcknowledgements: acknowledgements}
	operationIDs := make([]string, 0, len(pending))
	for _, module := range []string{"tasks", "contacts", "programs", "whiteboards"} {
		items, _, err := e.catalog.Selections(ctx, grantID, module, "", 100)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			request.Inventory = append(request.Inventory, SyncInventoryItem{SelectionID: item.SelectionID, HeadVersion: item.HeadVersion, ContentHash: item.ContentHash})
		}
	}
	request.WantSnapshots, err = e.catalog.NextSnapshotBatch(ctx, grantID, 4)
	if err != nil {
		return nil, err
	}
	request.UsedStorageBytes, err = store.Size(ctx)
	if err != nil {
		return nil, err
	}
	// Backend limits the complete JSON body to 2 MiB. Build an exact bounded
	// prefix instead of taking 100 potentially 2 MiB envelopes and producing a
	// request that can never be accepted. The first oversized item is surfaced
	// as a durable blocking error and is never skipped/reordered silently.
	for _, item := range pending {
		request.TransportEnvelopes = append(request.TransportEnvelopes, item.Envelope)
		rawCandidate, marshalErr := json.Marshal(request)
		if marshalErr != nil {
			return nil, marshalErr
		}
		if len(rawCandidate) > maxSyncRequestBytes {
			request.TransportEnvelopes = request.TransportEnvelopes[:len(request.TransportEnvelopes)-1]
			if len(operationIDs) == 0 {
				return nil, ErrOperationEnvelopeTooLarge
			}
			break
		}
		operationIDs = append(operationIDs, item.OperationID)
	}
	rawRequest, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(rawRequest)
	proofClaims := struct {
		Version            int    `json:"version"`
		Purpose            string `json:"purpose"`
		ChallengeID        string `json:"challenge_id"`
		Nonce              string `json:"nonce"`
		Counter            int64  `json:"counter"`
		GrantID            string `json:"grant_id"`
		InstallationID     string `json:"installation_id"`
		WindowsPrincipalID string `json:"windows_principal_id"`
		BrowserProfileID   string `json:"browser_profile_id"`
		RequestHash        string `json:"request_hash"`
		IssuedAt           int64  `json:"iat"`
		JWTID              string `json:"jti"`
	}{model.ProtocolVersion, "sync", challenge.ChallengeID, challenge.Nonce, counter, grantID, grant.Tuple.InstallationID, grant.Tuple.WindowsPrincipalID, grant.Tuple.BrowserProfileID, hex.EncodeToString(digest[:]), e.now().UTC().Unix(), uuid.NewString()}
	rawProof, _ := json.Marshal(proofClaims)
	proof, err := cryptokit.SignCompact(rawProof, e.installation.SigningKey, e.installation.SigningJWK.KeyID, SyncProofType)
	if err != nil {
		return nil, err
	}
	return &PreparedSync{Request: request, ServiceProof: proof, TransportCapability: string(grant.TransportCapability), OperationIDs: operationIDs, ControlAcknowledgements: acknowledgements}, nil
}

func (e *Engine) StoreSyncResponse(ctx context.Context, grantID string, response SyncResponse) error {
	switch response.State {
	case "synchronized", "controls_only", "selection_changed", "quota_exceeded", "writes_disabled":
	default:
		return errors.New("sync response state rejected")
	}
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil {
		return err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return err
	}
	for _, group := range [][]SealedServerEnvelope{response.Receipts, response.Snapshots} {
		for _, item := range group {
			if item.Kind != "receipt" && item.Kind != "snapshot" {
				return errors.New("server envelope kind rejected")
			}
			if len(item.ContentHash) != sha256.Size*2 {
				return errors.New("server envelope claimed hash rejected")
			}
			if _, err := hex.DecodeString(item.ContentHash); err != nil || item.ContentHash != strings.ToLower(item.ContentHash) {
				return errors.New("server envelope claimed hash rejected")
			}
			// Server content_hash authenticates snapshot payload or the original
			// operation, not the outer JWE. The vault always computes a separate
			// transport hash and retains this claim for nested-JWS verification.
			if _, err := store.StoreInbox(ctx, vault.InboxEnvelope{EnvelopeID: item.EnvelopeID, Kind: item.Kind, Envelope: item.CompactJWE, ClaimedHash: item.ContentHash, ReceivedAt: e.now().UTC()}); err != nil {
				return err
			}
		}
	}
	for _, control := range response.Controls {
		if err := e.applyControl(ctx, grant, store, control); err != nil {
			return err
		}
	}
	if response.State == "selection_changed" {
		if len(response.Snapshots) != 0 || response.Lease != "" || !response.LeaseExpiresAt.IsZero() {
			return errors.New("selection changed response carried stale authority")
		}
		if err := e.suspendGrantFromSync(ctx, grant); err != nil && !errors.Is(err, ErrGrantRevoked) {
			return err
		}
	}
	freshGrant, err := e.catalog.Grant(ctx, grantID)
	if err != nil {
		return err
	}
	if response.Lease != "" {
		if response.State != "synchronized" && response.State != "controls_only" {
			return errors.New("background lease arrived with blocked sync state")
		}
		if err := e.applyBackgroundLease(ctx, freshGrant, response.Lease, response.LeaseExpiresAt); err != nil {
			return err
		}
		freshGrant, err = e.catalog.Grant(ctx, grantID)
		if err != nil {
			return err
		}
	} else if !response.LeaseExpiresAt.IsZero() {
		return errors.New("background lease expiry missing token")
	}
	if access, acquireErr := e.sessions.AcquireGrant(grantID); acquireErr == nil {
		loadErr := e.processUnlockedInbox(ctx, freshGrant, access.Secrets)
		access.Release()
		if loadErr != nil {
			return loadErr
		}
	} else if !errors.Is(acquireErr, session.ErrExpired) {
		return acquireErr
	}
	if !response.ServerTime.IsZero() {
		if err := e.catalog.AdvanceTrustedTime(ctx, response.ServerTime, e.now()); err != nil {
			return err
		}
	}
	if response.State == "synchronized" {
		return e.catalog.UpdateLastSync(ctx, grantID, e.now().UTC())
	}
	return nil
}

func (e *Engine) applyBackgroundLease(ctx context.Context, grant *catalog.Grant, token string, declaredExpiry time.Time) error {
	if grant == nil || grant.State != "available" || token == "" {
		return errors.New("background lease grant rejected")
	}
	ring, err := decodeRing(grant.SignerPublicKeys)
	if err != nil {
		return err
	}
	previous, err := ring.VerifyStoredLease(grant.Lease, grant.Tuple, grant.LoginBindingSHA256, grant.BrowserThumbprint, grant.GrantSigningThumbprint, grant.GrantEncryptionThumbprint)
	if err != nil {
		return err
	}
	next, err := ring.VerifyLease(token, e.now(), grant.Tuple, grant.LoginBindingSHA256, grant.BrowserThumbprint, grant.GrantSigningThumbprint, grant.GrantEncryptionThumbprint)
	if err != nil {
		return err
	}
	if next.IssuedAt < previous.IssuedAt || next.ExpiresAt < previous.ExpiresAt || !epochsMonotonic(previous.Epochs, next.Epochs) || !sameStringSet(next.Actions, grant.Actions) || next.MaxStorageBytes != grant.QuotaBytes || next.Selection != grant.SelectionRevision || next.SelectionDigest != grant.SelectionDigest {
		return errors.New("background lease authority downgrade rejected")
	}
	if !declaredExpiry.IsZero() && declaredExpiry.UTC().Unix() != next.ExpiresAt {
		return errors.New("background lease expiry binding rejected")
	}
	grant.Lease = token
	grant.LeaseExpiresAt = time.Unix(next.ExpiresAt, 0).UTC()
	if err := e.catalog.SaveGrant(ctx, *grant); err != nil {
		return err
	}
	return e.sessions.RenewGrantLease(grant.Tuple.GrantID, *next)
}

func epochsMonotonic(previous, next model.Epochs) bool {
	return next.Credential >= previous.Credential && next.Authority >= previous.Authority && next.Installation >= previous.Installation &&
		next.Principal >= previous.Principal && next.Browser >= previous.Browser && next.Authorization >= previous.Authorization &&
		next.Grant >= previous.Grant && next.Selection >= previous.Selection
}

func (e *Engine) ConfirmSyncRequest(ctx context.Context, grantID string, acknowledgements []string) error {
	if len(acknowledgements) == 0 {
		return nil
	}
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil {
		return err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return err
	}
	if err := store.ConfirmControlAcknowledgements(ctx, acknowledgements); err != nil {
		return err
	}
	remaining, err := store.PendingControlAcknowledgements(ctx, 1)
	if err != nil {
		return err
	}
	fresh, err := e.catalog.Grant(ctx, grantID)
	if err != nil {
		return err
	}
	if fresh.State == "revoked" && len(remaining) == 0 {
		return e.catalog.FinalizeRevokedGrant(ctx, grantID)
	}
	return nil
}

func (e *Engine) MarkSyncAttempt(ctx context.Context, grantID string, operationIDs []string, retryAt time.Time) error {
	if len(operationIDs) == 0 {
		return nil
	}
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil {
		return err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return err
	}
	return store.MarkAttempt(ctx, operationIDs, retryAt)
}

func (e *Engine) applyControl(ctx context.Context, sourceGrant *catalog.Grant, store *vault.Store, token string) error {
	keys, err := decodeRing(sourceGrant.SignerPublicKeys)
	if err != nil {
		return err
	}
	claims, err := keys.VerifyControl(token, e.now(), e.installation.ID)
	if err != nil {
		return err
	}
	if _, err := store.StoreInbox(ctx, vault.InboxEnvelope{EnvelopeID: claims.JWTID, Kind: "control", Envelope: token, ReceivedAt: e.now().UTC()}); err != nil {
		return err
	}
	// Apply first and advance the durable high-water afterwards. A crash can
	// therefore only cause an idempotent re-application, never record a control
	// as consumed before its lock/revocation effect reached local state.
	grants, err := e.catalog.TransportGrants(ctx, 100)
	if err != nil {
		return err
	}
	bumpedBrowsers := map[string]struct{}{}
	for index := range grants {
		grant := &grants[index]
		matched := controlMatches(claims.Scope, claims.ScopeID, grant)
		if claims.Scope == "selection" {
			_, selectionErr := e.catalog.Selection(ctx, sourceGrant.Tuple.GrantID, claims.ScopeID)
			matched = selectionErr == nil && grant.Tuple.GrantID == sourceGrant.Tuple.GrantID
		}
		if !matched {
			continue
		}
		if err := e.applyControlToGrant(ctx, store, sourceGrant, grant, claims, bumpedBrowsers); err != nil {
			return err
		}
	}
	fresh, err := e.catalog.AdvanceControlHighWater(ctx, claims.Scope, claims.ScopeID, claims.Revision)
	if err != nil {
		return err
	}
	if !fresh {
		// The effects were already committed by an earlier delivery; this copy
		// still needs a durable ACK so the server can stop redelivery.
	}
	return store.MarkInboxProcessed(ctx, claims.JWTID, e.now().UTC())
}

func (e *Engine) applyControlToGrant(ctx context.Context, sourceStore *vault.Store, sourceGrant, grant *catalog.Grant, claims *protocol.ControlClaims, bumpedBrowsers map[string]struct{}) error {
	unlockGrant := e.lockGrant(grant.Tuple.GrantID)
	defer unlockGrant()

	e.sessions.LockBrowser(grant.Tuple.BrowserProfileID)
	if _, already := bumpedBrowsers[grant.Tuple.BrowserProfileID]; !already {
		if _, err := e.catalog.BumpBrowserEpoch(ctx, grant.Tuple.BrowserProfileID); err != nil {
			return err
		}
		bumpedBrowsers[grant.Tuple.BrowserProfileID] = struct{}{}
	}
	if claims.Scope == "selection" {
		if err := sourceStore.DeleteSelection(ctx, claims.ScopeID); err != nil {
			return err
		}
		if err := e.catalog.DeleteSelection(ctx, grant.Tuple.GrantID, claims.ScopeID); err != nil {
			return err
		}
		return e.catalog.SetGrantState(ctx, grant.Tuple.GrantID, "expired")
	}
	wipe := claims.Action == "wipe" || claims.Reason == "admin_revoked" || claims.Reason == "user_disabled" || claims.Reason == "account_disabled"
	if !wipe {
		return e.catalog.SetGrantState(ctx, grant.Tuple.GrantID, "expired")
	}
	targetStore, err := e.vaultFor(grant)
	if err != nil {
		return err
	}
	preserveControlID := ""
	if grant.Tuple.GrantID == sourceGrant.Tuple.GrantID {
		preserveControlID = claims.JWTID
	}
	if err := e.catalog.RevokeGrantAndEraseSecrets(ctx, grant.Tuple.GrantID); err != nil {
		return err
	}
	if err := targetStore.WipeGrantData(ctx, preserveControlID); err != nil {
		return err
	}
	if preserveControlID == "" {
		return e.catalog.FinalizeRevokedGrant(ctx, grant.Tuple.GrantID)
	}
	return nil
}

func controlMatches(scope, id string, grant *catalog.Grant) bool {
	switch scope {
	case "installation":
		return grant.Tuple.InstallationID == id
	case "windows_principal":
		return grant.Tuple.WindowsPrincipalID == id
	case "browser_profile":
		return grant.Tuple.BrowserProfileID == id
	case "authorization":
		return grant.Tuple.AuthorizationID == id
	case "grant":
		return grant.Tuple.GrantID == id
	case "selection":
		return false
	default:
		return false
	}
}
