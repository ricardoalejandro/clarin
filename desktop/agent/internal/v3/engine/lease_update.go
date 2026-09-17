package engine

import (
	"context"
	"crypto/ecdsa"
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
)

const proofTypeLease = "clarin-offline-lease-proof+jwt"

type LeaseProofInput struct {
	ChallengeID string `json:"challenge_id"`
	Nonce       string `json:"nonce"`
}

type LeaseProofResult struct {
	ChallengeID        string          `json:"challenge_id"`
	Nonce              string          `json:"nonce"`
	Counter            int64           `json:"counter"`
	InstallationProof  string          `json:"installation_signature"`
	GrantProof         string          `json:"grant_signature"`
	BrowserProofClaims json.RawMessage `json:"browser_proof_claims"`
}

func (e *Engine) BuildLeaseProof(ctx context.Context, access *session.Access, input LeaseProofInput) (*LeaseProofResult, error) {
	if access == nil || !canonicalUUID(input.ChallengeID) || len(input.Nonce) != 43 {
		return nil, ErrInvalid
	}
	grant, err := e.catalog.Grant(ctx, access.Tuple.GrantID)
	if err != nil || grant.State != "available" || !grant.Tuple.Equal(access.Tuple) {
		return nil, ErrGrantLocked
	}
	return e.buildLeaseProof(ctx, grant, access.Secrets.SigningKey, input)
}

func (e *Engine) buildLeaseProof(ctx context.Context, grant *catalog.Grant, signingKey *ecdsa.PrivateKey, input LeaseProofInput) (*LeaseProofResult, error) {
	if grant == nil || signingKey == nil || !canonicalUUID(input.ChallengeID) || len(input.Nonce) != 43 {
		return nil, ErrInvalid
	}
	counter, err := e.catalog.NextCounter(ctx)
	if err != nil {
		return nil, err
	}
	material := struct {
		ChallengeID string `json:"challenge_id"`
		Nonce       string `json:"nonce"`
		Counter     int64  `json:"counter"`
		GrantID     string `json:"grant_id"`
	}{input.ChallengeID, input.Nonce, counter, grant.Tuple.GrantID}
	rawMaterial, _ := json.Marshal(material)
	digest := sha256.Sum256(rawMaterial)
	requestHash := hex.EncodeToString(digest[:])
	makeClaims := func(purpose string) json.RawMessage {
		raw, _ := json.Marshal(struct {
			Version            int    `json:"version"`
			Purpose            string `json:"purpose"`
			ChallengeID        string `json:"challenge_id"`
			InstallationID     string `json:"installation_id"`
			WindowsPrincipalID string `json:"windows_principal_id"`
			BrowserProfileID   string `json:"browser_profile_id"`
			GrantID            string `json:"grant_id"`
			Nonce              string `json:"nonce"`
			Counter            int64  `json:"counter"`
			RequestHash        string `json:"request_hash"`
			IssuedAt           int64  `json:"iat"`
			JWTID              string `json:"jti"`
		}{model.ProtocolVersion, purpose, input.ChallengeID, grant.Tuple.InstallationID, grant.Tuple.WindowsPrincipalID,
			grant.Tuple.BrowserProfileID, grant.Tuple.GrantID, input.Nonce, counter, requestHash, e.now().UTC().Unix(), uuid.NewString()})
		return raw
	}
	installationClaims, grantClaims, browserClaims := makeClaims("installation"), makeClaims("grant"), makeClaims("browser")
	installationProof, err := cryptokit.SignCompact(installationClaims, e.installation.SigningKey, e.installation.SigningJWK.KeyID, proofTypeLease)
	if err != nil {
		return nil, err
	}
	var signingJWK struct {
		KeyID string `json:"kid"`
	}
	if json.Unmarshal(grant.GrantSigningJWK, &signingJWK) != nil || signingJWK.KeyID == "" {
		return nil, errors.New("grant signing metadata corrupt")
	}
	grantProof, err := cryptokit.SignCompact(grantClaims, signingKey, signingJWK.KeyID, proofTypeLease)
	if err != nil {
		return nil, err
	}
	return &LeaseProofResult{ChallengeID: input.ChallengeID, Nonce: input.Nonce, Counter: counter, InstallationProof: installationProof, GrantProof: grantProof, BrowserProofClaims: browserClaims}, nil
}

type PrepareLeaseInput struct {
	ChallengeID       string `json:"challenge_id"`
	CredentialJWE     string `json:"credential_jwe"`
	GrantBootstrap    string `json:"grant_bootstrap"`
	ServerChallengeID string `json:"server_challenge_id"`
	ServerNonce       string `json:"server_nonce"`
}

type PrepareLeaseResult struct {
	State      string           `json:"state"`
	LeaseProof LeaseProofResult `json:"lease_proof"`
}

// PrepareLease re-authenticates an existing grant without relying on a live
// local session or an unexpired old lease. This breaks the otherwise circular
// recovery path after a browser restart and lease expiry: a fresh, short-lived
// server bootstrap proves the unchanged grant tuple; the password unwraps the
// same local keys; only possession proofs leave the service.
func (e *Engine) PrepareLease(ctx context.Context, browserID, grantID string, input PrepareLeaseInput) (*PrepareLeaseResult, error) {
	entry, err := e.challenges.Consume(input.ChallengeID, "renew")
	if err != nil || entry.BrowserID != browserID || entry.GrantID != grantID {
		return nil, ErrInvalid
	}
	profile, err := e.catalog.BrowserProfile(ctx, browserID)
	if err != nil || profile.State != "active" {
		return nil, ErrDescriptor
	}
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil || grant.Tuple.BrowserProfileID != browserID {
		return nil, ErrNotFound
	}
	if grant.State == "revoked" {
		return nil, ErrGrantRevoked
	}
	if grant.State != "available" && grant.State != "expired" {
		return nil, ErrGrantLocked
	}
	ring, err := decodeRing(profile.SignerPublicKeys)
	if err != nil {
		return nil, ErrDescriptor
	}
	bootstrap, err := ring.VerifyGrantBootstrap(input.GrantBootstrap, e.now(), e.installation.ID, profile.PrincipalID, browserID, profile.DPoPThumbprint)
	if err != nil || bootstrap.GrantID != grantID || !bootstrap.Tuple.Equal(grant.Tuple) || !sameLoginBinding(bootstrap.LoginBindingSHA256, grant.LoginBindingSHA256) {
		return nil, errors.New("grant renewal bootstrap rejected")
	}
	if !canonicalUUID(input.ServerChallengeID) || len(input.ServerNonce) != 43 {
		return nil, errors.New("server lease challenge rejected")
	}
	if _, err := e.catalog.CheckUnlock(ctx, grantID, e.now()); err != nil {
		return nil, err
	}
	credential, err := e.decryptCredential(input.CredentialJWE, entry)
	if err != nil {
		_, _ = e.catalog.RecordUnlockFailure(ctx, grantID, e.now())
		return nil, ErrCredential
	}
	defer credential.Destroy()
	if !sameLoginBinding(grant.LoginBindingSHA256, credential.LoginBinding) {
		_, _ = e.catalog.RecordUnlockFailure(ctx, grantID, e.now())
		return nil, ErrCredential
	}
	secrets, err := e.unwrapGrantSecrets(credential.Password, grant.WrappedSecrets, grant.Tuple, grant.LoginBindingSHA256)
	if err != nil {
		if errors.Is(err, ErrCredentialBusy) {
			return nil, err
		}
		_, _ = e.catalog.RecordUnlockFailure(ctx, grantID, e.now())
		return nil, ErrCredential
	}
	defer secrets.Destroy()
	if err := verifyGrantSecrets(grant, secrets); err != nil {
		return nil, err
	}
	proof, err := e.buildLeaseProof(ctx, grant, secrets.SigningKey, LeaseProofInput{ChallengeID: input.ServerChallengeID, Nonce: input.ServerNonce})
	if err != nil {
		return nil, err
	}
	if err := e.catalog.RecordUnlockSuccess(ctx, grantID, e.now()); err != nil {
		return nil, err
	}
	return &PrepareLeaseResult{State: "authorizing", LeaseProof: *proof}, nil
}

type ActivateLeaseInput struct {
	Lease             string                      `json:"lease"`
	ServiceDescriptor string                      `json:"service_descriptor"`
	SignerPublicKeys  protocol.PublicKeysResponse `json:"signer_public_keys"`
	Selections        []catalog.Selection         `json:"selections"`
	ServerTime        time.Time                   `json:"server_time"`
	DisplayUser       string                      `json:"display_user"`
	DisplayAccount    string                      `json:"display_account"`
}

func (e *Engine) ActivateLease(ctx context.Context, browserID, grantID string, input ActivateLeaseInput) (int64, error) {
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil || (grant.State != "available" && grant.State != "expired") || grant.Tuple.BrowserProfileID != browserID {
		return 0, ErrGrantLocked
	}
	input.DisplayUser, input.DisplayAccount = strings.TrimSpace(input.DisplayUser), strings.TrimSpace(input.DisplayAccount)
	if input.DisplayUser == "" || input.DisplayAccount == "" || len([]rune(input.DisplayUser)) > 160 || len([]rune(input.DisplayAccount)) > 160 {
		return 0, ErrInvalid
	}
	profile, err := e.catalog.BrowserProfile(ctx, browserID)
	if err != nil || profile.State != "active" {
		return 0, ErrDescriptor
	}
	ring, rawRing, err := encodeAndValidateRing(input.SignerPublicKeys)
	if err != nil || !sameRing(grant.SignerPublicKeys, rawRing) || !sameRing(profile.SignerPublicKeys, rawRing) {
		return 0, errors.New("untrusted signer key rotation")
	}
	if _, err := ring.VerifyServiceDescriptor(input.ServiceDescriptor, e.now(), e.installation.ID, profile.PrincipalID, profile.ID, e.origin, e.installation.SigningJWK, e.installation.EncryptionJWK); err != nil {
		return 0, err
	}
	claims, err := ring.VerifyLease(input.Lease, e.now(), grant.Tuple, grant.LoginBindingSHA256, grant.BrowserThumbprint, grant.GrantSigningThumbprint, grant.GrantEncryptionThumbprint)
	if err != nil || claims.Selection < grant.SelectionRevision {
		return 0, errors.New("updated lease rejected")
	}
	for index := range input.Selections {
		input.Selections[index].GrantID = grant.Tuple.GrantID
		input.Selections[index].Readiness = "preparing"
	}
	selectionModels := make([]model.Selection, 0, len(input.Selections))
	for _, item := range input.Selections {
		selectionModels = append(selectionModels, model.Selection{SelectionID: item.SelectionID, Module: item.Module, ResourceType: item.ResourceType, ResourceID: item.ResourceID, HeadVersion: item.HeadVersion, ContentHash: item.ContentHash})
	}
	digest, err := model.SelectionDigest(selectionModels)
	if err != nil || digest != claims.SelectionDigest || !sameStringSet(claims.Actions, grant.Actions) || claims.MaxStorageBytes != grant.QuotaBytes {
		return 0, errors.New("updated lease policy rejected")
	}
	oldIDs := map[string]struct{}{}
	for _, module := range []string{"tasks", "contacts", "programs", "whiteboards"} {
		items, _, listErr := e.catalog.Selections(ctx, grant.Tuple.GrantID, module, "", 100)
		if listErr != nil {
			return 0, listErr
		}
		for _, item := range items {
			oldIDs[item.SelectionID] = struct{}{}
		}
	}
	for _, item := range input.Selections {
		delete(oldIDs, item.SelectionID)
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return 0, err
	}
	if err := e.catalog.ReplaceSelections(ctx, grant.Tuple.GrantID, claims.Selection, claims.SelectionDigest, input.Selections); err != nil {
		return 0, err
	}
	for selectionID := range oldIDs {
		if err := store.DeleteSelection(ctx, selectionID); err != nil {
			return 0, err
		}
	}
	grant.Lease, grant.ServiceDescriptor, grant.SignerPublicKeys = input.Lease, input.ServiceDescriptor, rawRing
	grant.DisplayUser, grant.DisplayAccount = input.DisplayUser, input.DisplayAccount
	grant.State = "available"
	grant.LeaseExpiresAt, grant.SelectionRevision, grant.SelectionDigest = time.Unix(claims.ExpiresAt, 0).UTC(), claims.Selection, claims.SelectionDigest
	if err := e.catalog.SaveGrant(ctx, *grant); err != nil {
		return 0, err
	}
	if !input.ServerTime.IsZero() {
		if err := e.catalog.AdvanceTrustedTime(ctx, input.ServerTime, e.now()); err != nil {
			return 0, err
		}
	}
	e.sessions.LockBrowser(browserID)
	return e.catalog.BumpBrowserEpoch(ctx, browserID)
}
