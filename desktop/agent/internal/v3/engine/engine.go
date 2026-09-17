package engine

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"

	"github.com/naperu/clarin-offline-agent/internal/v3/catalog"
	"github.com/naperu/clarin-offline-agent/internal/v3/challenge"
	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
	"github.com/naperu/clarin-offline-agent/internal/v3/protocol"
	"github.com/naperu/clarin-offline-agent/internal/v3/serviceprotect"
	"github.com/naperu/clarin-offline-agent/internal/v3/session"
	"github.com/naperu/clarin-offline-agent/internal/v3/vault"
)

const (
	UnlockCredentialJWEType    = "clarin-local-unlock+jwe"
	ProvisionCredentialJWEType = "clarin-local-provision+jwe"
	RenewCredentialJWEType     = "clarin-local-renew+jwe"
	OperationJWSType           = "clarin-offline-operation+jws"
	proofTypeEnroll            = "clarin-offline-enrollment-proof+jwt"
	proofTypeKeys              = "clarin-offline-grant-keys-proof+jwt"
)

var (
	ErrInvalid           = errors.New("invalid_request")
	ErrNotFound          = errors.New("resource_not_available")
	ErrGrantLocked       = errors.New("grant_locked")
	ErrGrantRevoked      = errors.New("grant_revoked")
	ErrLeaseExpired      = errors.New("lease_expired")
	ErrDescriptor        = errors.New("descriptor_unavailable")
	ErrAlreadyAvailable  = errors.New("grant_already_available")
	ErrActionDenied      = errors.New("action_denied")
	ErrCredential        = errors.New("offline_credential_rejected")
	ErrCredentialBusy    = errors.New("credential_work_busy")
	ErrPendingOperations = errors.New("pending_operations")
)

type Engine struct {
	root         string
	origin       string
	version      string
	catalog      *catalog.Store
	installation *catalog.Installation
	challenges   *challenge.Manager
	sessions     *session.Manager
	now          func() time.Time

	mu     sync.Mutex
	vaults map[string]*vault.Store

	// Authority changes and durable offline writes for one grant share a
	// striped lock. This gives suspend/revoke a linearization point without an
	// unbounded attacker-controlled map of mutexes.
	grantLocks [64]sync.Mutex

	// Argon2id intentionally consumes 64 MiB per credential operation. A
	// non-blocking process-wide ceiling prevents many authorized local profiles
	// from multiplying that memory cost into a service-wide denial of service.
	credentialSlots chan struct{}
}

func Open(root, origin, version string, protector serviceprotect.Protector) (*Engine, error) {
	version = strings.TrimSpace(version)
	if version == "" || len(version) > 40 {
		return nil, errors.New("service version is required")
	}
	store, err := catalog.Open(root, origin, protector)
	if err != nil {
		return nil, err
	}
	installation, err := store.EnsureInstallation(context.Background())
	if err != nil {
		store.Close()
		return nil, err
	}
	return &Engine{root: root, origin: origin, version: version, catalog: store, installation: installation, challenges: challenge.NewManager(), sessions: session.NewManager(), now: time.Now, vaults: make(map[string]*vault.Store), credentialSlots: make(chan struct{}, 2)}, nil
}

func (e *Engine) Close() error {
	if e == nil {
		return nil
	}
	e.sessions.Close()
	e.mu.Lock()
	for id, store := range e.vaults {
		_ = store.Close()
		delete(e.vaults, id)
	}
	e.mu.Unlock()
	if e.installation != nil {
		e.installation.Destroy()
	}
	return e.catalog.Close()
}

func (e *Engine) Origin() string         { return e.origin }
func (e *Engine) Version() string        { return e.version }
func (e *Engine) InstallationID() string { return e.installation.ID }

// RunSessionReaper is a service-lifetime loop. It does not perform network
// work, so a blocked synchronization request cannot delay destruction of an
// expired in-memory DEK or private grant key.
func (e *Engine) RunSessionReaper(ctx context.Context) {
	e.sessions.RunReaper(ctx)
}

type PrincipalChallenge struct {
	ChallengeID string    `json:"challenge_id"`
	LaunchURI   string    `json:"launch_uri"`
	ExpiresAt   time.Time `json:"expires_at"`
	State       string    `json:"state"`
}

func (e *Engine) CreatePrincipalChallenge() (PrincipalChallenge, error) {
	entry, err := e.challenges.Create("principal", "", "", 5*time.Minute)
	if err != nil {
		return PrincipalChallenge{}, err
	}
	return PrincipalChallenge{ChallengeID: entry.ID, LaunchURI: "clarin-offline-v3://principal?challenge=" + entry.ID, ExpiresAt: entry.ExpiresAt, State: "waiting"}, nil
}

func (e *Engine) CompletePrincipalChallenge(ctx context.Context, challengeID, windowsSID, displayName string) error {
	principal, err := e.catalog.EnsurePrincipal(ctx, windowsSID, displayName)
	if err != nil {
		return err
	}
	_, err = e.challenges.CompletePrincipal(challengeID, principal.ID)
	return err
}

func (e *Engine) PrincipalChallengeStatus(challengeID string) (PrincipalChallenge, error) {
	entry, err := e.challenges.Get(challengeID, "principal")
	if err != nil {
		if errors.Is(err, challenge.ErrExpired) || errors.Is(err, challenge.ErrNotFound) {
			return PrincipalChallenge{ChallengeID: challengeID, State: "expired"}, nil
		}
		return PrincipalChallenge{}, err
	}
	state := "waiting"
	if entry.Completed {
		state = "completed"
	}
	return PrincipalChallenge{ChallengeID: entry.ID, ExpiresAt: entry.ExpiresAt, State: state}, nil
}

type BrowserChallenge struct {
	ChallengeID         string          `json:"challenge_id"`
	Challenge           string          `json:"challenge"`
	Nonce               string          `json:"nonce"`
	ExpiresAt           time.Time       `json:"expires_at"`
	UnlockEncryptionJWK jose.JSONWebKey `json:"unlock_encryption_jwk"`
}

func (e *Engine) CreateBrowserChallenge() (BrowserChallenge, error) {
	entry, err := e.challenges.Create("browser-enroll", "", "", 2*time.Minute)
	if err != nil {
		return BrowserChallenge{}, err
	}
	separateChallenge, err := protocol.NewChallenge()
	if err != nil {
		return BrowserChallenge{}, err
	}
	return BrowserChallenge{ChallengeID: entry.ID, Challenge: separateChallenge, Nonce: entry.Nonce, ExpiresAt: entry.ExpiresAt, UnlockEncryptionJWK: e.installation.EncryptionJWK.Public()}, nil
}

type BrowserEnrollment struct {
	BrowserProfileID string `json:"browser_profile_id"`
	State            string `json:"state"`
	ProfileEpoch     int64  `json:"profile_epoch"`
}

func (e *Engine) EnrollBrowser(ctx context.Context, principalChallengeID, browserChallengeID, label string, browserJWK jose.JSONWebKey) (*BrowserEnrollment, error) {
	browserChallenge, err := e.challenges.Consume(browserChallengeID, "browser-enroll")
	if err != nil || browserChallenge.Nonce == "" {
		return nil, ErrInvalid
	}
	principalChallenge, err := e.challenges.Consume(principalChallengeID, "principal")
	if err != nil || !principalChallenge.Completed || principalChallenge.PrincipalID == "" {
		return nil, ErrInvalid
	}
	browserJWK.Use, browserJWK.Algorithm, browserJWK.KeyID = "sig", "ES256", ""
	profile, err := e.catalog.CreateBrowserProfile(ctx, principalChallenge.PrincipalID, browserJWK, label)
	if err != nil {
		return nil, err
	}
	return &BrowserEnrollment{BrowserProfileID: profile.ID, State: profile.State, ProfileEpoch: profile.Epoch}, nil
}

func (e *Engine) BrowserProfile(ctx context.Context, browserID string) (*catalog.BrowserProfile, error) {
	return e.catalog.BrowserProfile(ctx, browserID)
}

type EnrollmentMaterialInput struct {
	ChallengeID     string `json:"challenge_id"`
	Nonce           string `json:"nonce"`
	AuthorizationID string `json:"authorization_id"`
	DisplayName     string `json:"display_name"`
	// ClientVersion is accepted only for wire compatibility with older CSR
	// builds. Enrollment authority always reports the compiled service version.
	ClientVersion string `json:"client_version"`
}

type EnrollmentMaterial struct {
	ChallengeID            string          `json:"challenge_id"`
	Nonce                  string          `json:"nonce"`
	InstallationID         string          `json:"installation_id"`
	WindowsPrincipalID     string          `json:"windows_principal_id"`
	BrowserProfileID       string          `json:"browser_profile_id"`
	AuthorizationID        string          `json:"authorization_id"`
	DisplayName            string          `json:"display_name"`
	PrincipalDisplayName   string          `json:"principal_display_name"`
	BrowserName            string          `json:"browser_name"`
	ClientVersion          string          `json:"client_version"`
	SIDHash                string          `json:"sid_hash"`
	InstallationSigningJWK jose.JSONWebKey `json:"installation_signing_jwk"`
	ServiceEncryptionJWK   jose.JSONWebKey `json:"service_encryption_jwk"`
	BrowserDPoPJWK         jose.JSONWebKey `json:"browser_dpop_jwk"`
	InstallationSignature  string          `json:"installation_signature"`
	PrincipalSignature     string          `json:"principal_signature"`
	BrowserProofClaims     json.RawMessage `json:"browser_proof_claims"`
}

func (e *Engine) EnrollmentMaterial(ctx context.Context, browserID string, input EnrollmentMaterialInput) (*EnrollmentMaterial, error) {
	if !canonicalUUID(input.ChallengeID) || !canonicalUUID(input.AuthorizationID) || len(input.Nonce) != 43 || strings.TrimSpace(input.DisplayName) == "" || len([]rune(strings.TrimSpace(input.DisplayName))) > 160 {
		return nil, ErrInvalid
	}
	profile, err := e.catalog.BrowserProfile(ctx, browserID)
	if err != nil || profile.State == "revoked" {
		return nil, ErrNotFound
	}
	principal, err := e.catalog.Principal(ctx, profile.PrincipalID)
	if err != nil {
		return nil, err
	}
	// This field order and shape intentionally mirrors backend
	// offlineV3EnrollmentMaterial. It is the exact object whose SHA-256 binds
	// all three enrollment proofs; neither the browser nor JavaScript supplies
	// the Windows principal or installation identity.
	base := struct {
		ChallengeID            string          `json:"challenge_id"`
		Nonce                  string          `json:"nonce"`
		InstallationID         string          `json:"installation_id"`
		WindowsPrincipalID     string          `json:"windows_principal_id"`
		BrowserProfileID       string          `json:"browser_profile_id"`
		AuthorizationID        string          `json:"authorization_id"`
		DisplayName            string          `json:"display_name"`
		PrincipalDisplayName   string          `json:"principal_display_name"`
		BrowserName            string          `json:"browser_name"`
		ClientVersion          string          `json:"client_version"`
		SIDHash                string          `json:"sid_hash"`
		InstallationSigningJWK jose.JSONWebKey `json:"installation_signing_jwk"`
		ServiceEncryptionJWK   jose.JSONWebKey `json:"service_encryption_jwk"`
		BrowserDPoPJWK         jose.JSONWebKey `json:"browser_dpop_jwk"`
	}{input.ChallengeID, input.Nonce, e.installation.ID, principal.ID, profile.ID, input.AuthorizationID,
		strings.TrimSpace(input.DisplayName), strings.TrimSpace(principal.DisplayName), strings.TrimSpace(profile.Label), e.version, principal.SIDHash,
		e.installation.SigningJWK.Public(), e.installation.EncryptionJWK.Public(), profile.DPoPJWK.Public()}
	if len([]rune(base.PrincipalDisplayName)) > 160 || len([]rune(base.BrowserName)) > 80 {
		return nil, ErrInvalid
	}
	baseRaw, err := json.Marshal(base)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(baseRaw)
	requestHash := hex.EncodeToString(digest[:])
	makeClaims := func(purpose string) json.RawMessage {
		raw, _ := json.Marshal(struct {
			Version            int    `json:"version"`
			Purpose            string `json:"purpose"`
			ChallengeID        string `json:"challenge_id"`
			Nonce              string `json:"nonce"`
			InstallationID     string `json:"installation_id"`
			WindowsPrincipalID string `json:"windows_principal_id"`
			BrowserProfileID   string `json:"browser_profile_id"`
			AuthorizationID    string `json:"authorization_id"`
			RequestHash        string `json:"request_hash"`
			IssuedAt           int64  `json:"iat"`
			JWTID              string `json:"jti"`
		}{model.ProtocolVersion, purpose, input.ChallengeID, input.Nonce, e.installation.ID, principal.ID, profile.ID, input.AuthorizationID, requestHash, e.now().UTC().Unix(), uuid.NewString()})
		return raw
	}
	installationClaims := makeClaims("installation")
	principalClaims := makeClaims("native-principal")
	browserClaims := makeClaims("browser")
	installationProof, err := cryptokit.SignCompact(installationClaims, e.installation.SigningKey, e.installation.SigningJWK.KeyID, proofTypeEnroll)
	if err != nil {
		return nil, err
	}
	principalProof, err := cryptokit.SignCompact(principalClaims, e.installation.SigningKey, e.installation.SigningJWK.KeyID, proofTypeEnroll)
	if err != nil {
		return nil, err
	}
	return &EnrollmentMaterial{
		ChallengeID: base.ChallengeID, Nonce: base.Nonce, InstallationID: base.InstallationID, WindowsPrincipalID: base.WindowsPrincipalID,
		BrowserProfileID: base.BrowserProfileID, AuthorizationID: base.AuthorizationID, DisplayName: base.DisplayName,
		PrincipalDisplayName: base.PrincipalDisplayName, BrowserName: base.BrowserName, ClientVersion: base.ClientVersion, SIDHash: base.SIDHash,
		InstallationSigningJWK: base.InstallationSigningJWK, ServiceEncryptionJWK: base.ServiceEncryptionJWK, BrowserDPoPJWK: base.BrowserDPoPJWK,
		InstallationSignature: installationProof, PrincipalSignature: principalProof, BrowserProofClaims: browserClaims,
	}, nil
}

func (e *Engine) ActivateBrowserProfile(ctx context.Context, browserID, descriptor string, ring protocol.PublicKeysResponse) error {
	profile, err := e.catalog.BrowserProfile(ctx, browserID)
	if err != nil {
		return err
	}
	keys, rawRing, err := encodeAndValidateRing(ring)
	if err != nil {
		return err
	}
	if _, err := keys.VerifyServiceDescriptor(descriptor, e.now(), e.installation.ID, profile.PrincipalID, profile.ID, e.origin, e.installation.SigningJWK, e.installation.EncryptionJWK); err != nil {
		return err
	}
	return e.catalog.ActivateBrowserProfile(ctx, browserID, descriptor, rawRing)
}

type ServiceDescriptor struct {
	ServiceDescriptor string                      `json:"service_descriptor"`
	SignerPublicKeys  protocol.PublicKeysResponse `json:"signer_public_keys"`
	Possession        string                      `json:"possession"`
}

func (e *Engine) ServiceDescriptor(ctx context.Context, browserID, callerChallenge string) (*ServiceDescriptor, error) {
	profile, err := e.catalog.BrowserProfile(ctx, browserID)
	if err != nil || profile.State != "active" || profile.ServiceDescriptor == "" || len(profile.SignerPublicKeys) == 0 {
		return nil, ErrDescriptor
	}
	var ring protocol.PublicKeysResponse
	if json.Unmarshal(profile.SignerPublicKeys, &ring) != nil {
		return nil, ErrDescriptor
	}
	possession, err := protocol.SignServicePossession(e.installation.SigningKey, e.installation.SigningJWK.KeyID, callerChallenge, e.installation.ID, profile.PrincipalID, profile.ID, e.origin, e.now())
	if err != nil {
		return nil, err
	}
	return &ServiceDescriptor{ServiceDescriptor: profile.ServiceDescriptor, SignerPublicKeys: ring, Possession: possession}, nil
}

type CredentialChallenge struct {
	ChallengeID             string          `json:"challenge_id"`
	Nonce                   string          `json:"nonce"`
	ExpiresAt               time.Time       `json:"expires_at"`
	CredentialEncryptionJWK jose.JSONWebKey `json:"credential_encryption_jwk"`
	ServiceDescriptor       string          `json:"service_descriptor"`
	PasswordKDF             PasswordKDF     `json:"password_kdf"`
}

type PasswordKDF struct {
	Name        string `json:"name"`
	MemoryKiB   uint32 `json:"memory_kib"`
	Iterations  uint32 `json:"iterations"`
	Parallelism uint8  `json:"parallelism"`
}

func (e *Engine) CredentialChallenge(ctx context.Context, purpose, browserID, grantID string) (*CredentialChallenge, error) {
	if purpose != "unlock" && purpose != "provision" && purpose != "renew" {
		return nil, ErrInvalid
	}
	profile, err := e.catalog.BrowserProfile(ctx, browserID)
	if err != nil || profile.State != "active" || profile.ServiceDescriptor == "" {
		return nil, ErrDescriptor
	}
	if purpose == "unlock" || purpose == "renew" {
		grant, err := e.catalog.Grant(ctx, grantID)
		if err != nil || grant.Tuple.BrowserProfileID != browserID {
			return nil, ErrNotFound
		}
		if grant.State == "revoked" {
			return nil, ErrGrantRevoked
		}
		if grant.State != "available" && !(purpose == "renew" && grant.State == "expired") {
			return nil, ErrGrantLocked
		}
	}
	entry, err := e.challenges.Create(purpose, browserID, grantID, 2*time.Minute)
	if err != nil {
		return nil, err
	}
	return &CredentialChallenge{
		ChallengeID: entry.ID, Nonce: entry.Nonce, ExpiresAt: entry.ExpiresAt,
		CredentialEncryptionJWK: e.installation.EncryptionJWK.Public(), ServiceDescriptor: profile.ServiceDescriptor,
		PasswordKDF: PasswordKDF{Name: "argon2id", MemoryKiB: cryptokit.PasswordMemoryKiB, Iterations: cryptokit.PasswordIterations, Parallelism: cryptokit.PasswordParallelism},
	}, nil
}

type credentialPayload struct {
	Version          int    `json:"v"`
	Purpose          string `json:"purpose"`
	ChallengeID      string `json:"challenge_id"`
	GrantID          string `json:"grant_id"`
	BrowserProfileID string `json:"browser_profile_id"`
	Login            string `json:"login"`
	Password         string `json:"password"`
}

type decryptedCredential struct {
	Password     []byte
	Login        string
	LoginBinding string
}

func (credential *decryptedCredential) Destroy() {
	if credential == nil {
		return
	}
	zero(credential.Password)
	credential.Password = nil
	credential.Login = ""
	credential.LoginBinding = ""
}

func (e *Engine) decryptCredential(token string, entry challenge.Entry) (*decryptedCredential, error) {
	expectedType := UnlockCredentialJWEType
	if entry.Purpose == "provision" {
		expectedType = ProvisionCredentialJWEType
	} else if entry.Purpose == "renew" {
		expectedType = RenewCredentialJWEType
	}
	plain, err := cryptokit.DecryptLocalCredential(token, e.installation.EncryptionKey, e.installation.EncryptionJWK.KeyID, expectedType, e.origin)
	if err != nil {
		return nil, err
	}
	defer zero(plain)
	var payload credentialPayload
	decoder := json.NewDecoder(bytes.NewReader(plain))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || ensureEOF(decoder) != nil || payload.Version != model.ProtocolVersion || payload.Purpose != entry.Purpose || payload.ChallengeID != entry.ID || payload.GrantID != entry.GrantID || payload.BrowserProfileID != entry.BrowserID || payload.Password == "" || len(payload.Password) > 1024 {
		return nil, errors.New("credential payload rejected")
	}
	login, err := model.CanonicalLogin(payload.Login)
	if err != nil {
		return nil, errors.New("credential login rejected")
	}
	loginBinding, _ := model.LoginBinding(login)
	password := []byte(payload.Password)
	payload.Login, payload.Password = "", ""
	return &decryptedCredential{Password: password, Login: login, LoginBinding: loginBinding}, nil
}

func sameLoginBinding(expected, actual string) bool {
	return len(expected) == sha256.Size*2 && len(actual) == sha256.Size*2 && subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}

type PrepareGrantInput struct {
	ChallengeID       string `json:"challenge_id"`
	CredentialJWE     string `json:"credential_jwe"`
	GrantBootstrap    string `json:"grant_bootstrap"`
	ServerChallengeID string `json:"server_challenge_id"`
	ServerNonce       string `json:"server_nonce"`
}

type KeyRegistration struct {
	ChallengeID        string          `json:"challenge_id"`
	Nonce              string          `json:"nonce"`
	Counter            int64           `json:"counter"`
	SigningJWK         jose.JSONWebKey `json:"signing_jwk"`
	EncryptionJWK      jose.JSONWebKey `json:"encryption_jwk"`
	InstallationProof  string          `json:"installation_signature"`
	GrantProof         string          `json:"grant_signature"`
	BrowserProofClaims json.RawMessage `json:"browser_proof_claims"`
}

type PrepareGrantResult struct {
	State           string          `json:"state"`
	KeyRegistration KeyRegistration `json:"key_registration"`
}

func (e *Engine) PrepareGrant(ctx context.Context, browserID, grantID string, input PrepareGrantInput) (*PrepareGrantResult, error) {
	entry, err := e.challenges.Consume(input.ChallengeID, "provision")
	if err != nil || entry.BrowserID != browserID || entry.GrantID != grantID {
		return nil, ErrInvalid
	}
	credential, err := e.decryptCredential(input.CredentialJWE, entry)
	if err != nil {
		return nil, ErrCredential
	}
	defer credential.Destroy()
	profile, err := e.catalog.BrowserProfile(ctx, browserID)
	if err != nil || profile.State != "active" {
		return nil, ErrDescriptor
	}
	keys, err := decodeRing(profile.SignerPublicKeys)
	if err != nil {
		return nil, ErrDescriptor
	}
	bootstrap, err := keys.VerifyGrantBootstrap(input.GrantBootstrap, e.now(), e.installation.ID, profile.PrincipalID, browserID, profile.DPoPThumbprint)
	if err != nil || bootstrap.GrantID != grantID {
		return nil, errors.New("grant bootstrap rejected")
	}
	if !sameLoginBinding(bootstrap.LoginBindingSHA256, credential.LoginBinding) {
		return nil, ErrCredential
	}
	if _, err := uuid.Parse(input.ServerChallengeID); err != nil || len(input.ServerNonce) != 43 {
		return nil, errors.New("server key challenge rejected")
	}
	var secrets *cryptokit.GrantSecrets
	stored, storedErr := e.catalog.Grant(ctx, grantID)
	switch {
	case storedErr == nil:
		if !stored.Tuple.Equal(bootstrap.Tuple) {
			return nil, catalog.ErrTupleMismatch
		}
		if stored.State == "available" {
			return nil, ErrAlreadyAvailable
		}
		if stored.State != "preparing" {
			return nil, ErrGrantLocked
		}
		if _, throttleErr := e.catalog.CheckUnlock(ctx, grantID, e.now()); throttleErr != nil {
			return nil, throttleErr
		}
		if !sameLoginBinding(stored.LoginBindingSHA256, credential.LoginBinding) || !sameLoginBinding(stored.LoginBindingSHA256, bootstrap.LoginBindingSHA256) {
			_, _ = e.catalog.RecordUnlockFailure(ctx, grantID, e.now())
			return nil, ErrCredential
		}
		secrets, err = e.unwrapGrantSecrets(credential.Password, stored.WrappedSecrets, stored.Tuple, stored.LoginBindingSHA256)
		if err != nil {
			if errors.Is(err, ErrCredentialBusy) {
				return nil, err
			}
			_, _ = e.catalog.RecordUnlockFailure(ctx, grantID, e.now())
			return nil, ErrCredential
		}
		defer secrets.Destroy()
		_ = e.catalog.RecordUnlockSuccess(ctx, grantID, e.now())
	case errors.Is(storedErr, catalog.ErrNotFound):
		secrets, err = cryptokit.GenerateGrantSecrets()
		if err != nil {
			return nil, err
		}
		defer secrets.Destroy()
		wrapped, err := e.wrapGrantSecrets(credential.Password, bootstrap.Tuple, bootstrap.LoginBindingSHA256, secrets)
		if err != nil {
			return nil, err
		}
		signingJWK, _ := cryptokit.PublicJWK(&secrets.SigningKey.PublicKey, "clarin-offline-grant-signing-"+grantID, "sig", "ES256")
		encryptionJWK, _ := cryptokit.PublicJWK(&secrets.EncryptionKey.PublicKey, "clarin-offline-grant-encryption-"+grantID, "enc", "ECDH-ES+A256KW")
		signingRaw, _ := json.Marshal(signingJWK)
		encryptionRaw, _ := json.Marshal(encryptionJWK)
		signingThumbprint, _ := cryptokit.Thumbprint(signingJWK)
		encryptionThumbprint, _ := cryptokit.Thumbprint(encryptionJWK)
		grant := catalog.Grant{Tuple: bootstrap.Tuple, State: "preparing", Actions: append([]string(nil), bootstrap.Actions...), QuotaBytes: bootstrap.MaxStorageBytes,
			DisplayUser: "", DisplayAccount: "", WrappedSecrets: wrapped,
			SignerPublicKeys: append([]byte(nil), profile.SignerPublicKeys...), ServiceDescriptor: profile.ServiceDescriptor,
			GrantSigningJWK: signingRaw, GrantEncryptionJWK: encryptionRaw, BrowserThumbprint: bootstrap.BrowserKeyThumbprint,
			GrantSigningThumbprint: signingThumbprint, GrantEncryptionThumbprint: encryptionThumbprint,
			SelectionRevision: bootstrap.Selection, SelectionDigest: bootstrap.SelectionDigest, LoginBindingSHA256: bootstrap.LoginBindingSHA256, BootstrapJTI: bootstrap.JWTID}
		if err := e.catalog.SaveGrant(ctx, grant); err != nil {
			return nil, err
		}
		stored = &grant
	default:
		return nil, storedErr
	}
	return e.keyRegistration(ctx, input.ServerChallengeID, input.ServerNonce, stored, secrets)
}

func (e *Engine) keyRegistration(ctx context.Context, challengeID, nonce string, grant *catalog.Grant, secrets *cryptokit.GrantSecrets) (*PrepareGrantResult, error) {
	var signingJWK, encryptionJWK jose.JSONWebKey
	if json.Unmarshal(grant.GrantSigningJWK, &signingJWK) != nil || json.Unmarshal(grant.GrantEncryptionJWK, &encryptionJWK) != nil {
		return nil, errors.New("stored grant public keys corrupt")
	}
	counter, err := e.catalog.NextCounter(ctx)
	if err != nil {
		return nil, err
	}
	// Exact backend offlineV3GrantProofMaterial. The counter is durable and
	// monotonically allocated before signing so replayed server challenges
	// cannot reuse an installation proof.
	base := struct {
		ChallengeID   string          `json:"challenge_id"`
		Nonce         string          `json:"nonce"`
		Counter       int64           `json:"counter"`
		GrantID       string          `json:"grant_id"`
		SigningJWK    jose.JSONWebKey `json:"signing_jwk,omitempty"`
		EncryptionJWK jose.JSONWebKey `json:"encryption_jwk,omitempty"`
	}{challengeID, nonce, counter, grant.Tuple.GrantID, signingJWK, encryptionJWK}
	baseRaw, _ := json.Marshal(base)
	digest := sha256.Sum256(baseRaw)
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
		}{model.ProtocolVersion, purpose, challengeID, grant.Tuple.InstallationID, grant.Tuple.WindowsPrincipalID, grant.Tuple.BrowserProfileID,
			grant.Tuple.GrantID, nonce, counter, requestHash, e.now().UTC().Unix(), uuid.NewString()})
		return raw
	}
	installationClaims := makeClaims("installation")
	grantClaims := makeClaims("grant")
	browserClaims := makeClaims("browser")
	installationProof, err := cryptokit.SignCompact(installationClaims, e.installation.SigningKey, e.installation.SigningJWK.KeyID, proofTypeKeys)
	if err != nil {
		return nil, err
	}
	grantProof, err := cryptokit.SignCompact(grantClaims, secrets.SigningKey, signingJWK.KeyID, proofTypeKeys)
	if err != nil {
		return nil, err
	}
	return &PrepareGrantResult{State: "registering", KeyRegistration: KeyRegistration{
		ChallengeID: challengeID, Nonce: nonce, Counter: counter, SigningJWK: signingJWK, EncryptionJWK: encryptionJWK,
		InstallationProof: installationProof, GrantProof: grantProof, BrowserProofClaims: browserClaims,
	}}, nil
}

type ActivateGrantInput struct {
	Lease               string                      `json:"lease"`
	ServiceDescriptor   string                      `json:"service_descriptor"`
	SignerPublicKeys    protocol.PublicKeysResponse `json:"signer_public_keys"`
	TransportCapability string                      `json:"transport_capability"`
	ServerIntakeJWK     jose.JSONWebKey             `json:"server_intake_jwk"`
	Selections          []catalog.Selection         `json:"selections"`
	ServerTime          time.Time                   `json:"server_time"`
	DisplayUser         string                      `json:"display_user"`
	DisplayAccount      string                      `json:"display_account"`
}

func (e *Engine) ActivateGrant(ctx context.Context, browserID, grantID string, input ActivateGrantInput) error {
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil || grant.Tuple.BrowserProfileID != browserID {
		return ErrNotFound
	}
	if grant.State == "available" {
		return ErrAlreadyAvailable
	}
	if grant.State != "preparing" || input.TransportCapability == "" || len(input.TransportCapability) > 4096 {
		return ErrGrantLocked
	}
	input.DisplayUser, input.DisplayAccount = strings.TrimSpace(input.DisplayUser), strings.TrimSpace(input.DisplayAccount)
	if input.DisplayUser == "" || input.DisplayAccount == "" || len([]rune(input.DisplayUser)) > 160 || len([]rune(input.DisplayAccount)) > 160 {
		return ErrInvalid
	}
	profile, err := e.catalog.BrowserProfile(ctx, browserID)
	if err != nil || profile.State != "active" {
		return ErrDescriptor
	}
	keys, rawRing, err := encodeAndValidateRing(input.SignerPublicKeys)
	if err != nil || !sameRing(profile.SignerPublicKeys, rawRing) {
		return errors.New("untrusted signer key rotation")
	}
	if _, err := keys.VerifyServiceDescriptor(input.ServiceDescriptor, e.now(), e.installation.ID, profile.PrincipalID, browserID, e.origin, e.installation.SigningJWK, e.installation.EncryptionJWK); err != nil {
		return err
	}
	claims, err := keys.VerifyLease(input.Lease, e.now(), grant.Tuple, grant.LoginBindingSHA256, grant.BrowserThumbprint, grant.GrantSigningThumbprint, grant.GrantEncryptionThumbprint)
	if err != nil {
		return err
	}
	if !sameStringSet(claims.Actions, grant.Actions) || claims.MaxStorageBytes != grant.QuotaBytes || claims.Selection != grant.SelectionRevision || claims.SelectionDigest != grant.SelectionDigest {
		return errors.New("activation policy differs from prepared grant")
	}
	intakeRaw, err := json.Marshal(input.ServerIntakeJWK.Public())
	if err != nil {
		return err
	}
	intake, err := cryptokit.ParsePublicJWK(intakeRaw, "enc")
	if err != nil || intake.Algorithm != "ECDH-ES+A256KW" {
		return errors.New("server intake key rejected")
	}
	for index := range input.Selections {
		input.Selections[index].GrantID = grantID
		if input.Selections[index].Readiness == "" {
			input.Selections[index].Readiness = "preparing"
		}
	}
	selectionModels := make([]model.Selection, 0, len(input.Selections))
	for _, item := range input.Selections {
		selectionModels = append(selectionModels, model.Selection{SelectionID: item.SelectionID, Module: item.Module, ResourceType: item.ResourceType, ResourceID: item.ResourceID, HeadVersion: item.HeadVersion, ContentHash: item.ContentHash})
	}
	digest, err := model.SelectionDigest(selectionModels)
	if err != nil || digest != claims.SelectionDigest {
		return errors.New("activation selection manifest rejected")
	}
	grant.State, grant.Lease, grant.ServiceDescriptor = "available", input.Lease, input.ServiceDescriptor
	grant.DisplayUser, grant.DisplayAccount = input.DisplayUser, input.DisplayAccount
	grant.SignerPublicKeys, grant.TransportCapability, grant.ServerIntakeJWK = rawRing, []byte(input.TransportCapability), intakeRaw
	grant.LeaseExpiresAt = time.Unix(claims.ExpiresAt, 0).UTC()
	grant.SelectionRevision, grant.SelectionDigest = claims.Selection, claims.SelectionDigest
	// Install the manifest while the grant is still fail-closed as preparing.
	// Only after that durable transaction succeeds do we publish the lease and
	// transport capability by switching the grant to available.
	if err := e.catalog.ReplaceSelections(ctx, grantID, claims.Selection, claims.SelectionDigest, input.Selections); err != nil {
		return err
	}
	if err := e.catalog.SaveGrant(ctx, *grant); err != nil {
		return err
	}
	if !input.ServerTime.IsZero() {
		if err := e.catalog.AdvanceTrustedTime(ctx, input.ServerTime, e.now()); err != nil {
			return err
		}
	}
	_, err = e.vaultFor(grant)
	return err
}

type UnlockResult struct {
	Session session.Issued    `json:"session"`
	Grant   *catalog.Grant    `json:"-"`
	Lease   model.LeaseClaims `json:"-"`
	Login   string            `json:"-"`
}

func (e *Engine) Unlock(ctx context.Context, browserID, grantID, challengeID, credentialJWE string) (*UnlockResult, error) {
	entry, err := e.challenges.Consume(challengeID, "unlock")
	if err != nil || entry.BrowserID != browserID || entry.GrantID != grantID {
		return nil, ErrInvalid
	}
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil || grant.Tuple.BrowserProfileID != browserID {
		return nil, ErrNotFound
	}
	if grant.State == "revoked" {
		return nil, ErrGrantRevoked
	}
	if grant.State != "available" {
		return nil, ErrGrantLocked
	}
	if _, err := e.catalog.CheckUnlock(ctx, grantID, e.now()); err != nil {
		return nil, err
	}
	credential, err := e.decryptCredential(credentialJWE, entry)
	if err != nil {
		_, _ = e.catalog.RecordUnlockFailure(ctx, grantID, e.now())
		return nil, ErrCredential
	}
	defer credential.Destroy()
	if !sameLoginBinding(grant.LoginBindingSHA256, credential.LoginBinding) {
		_, _ = e.catalog.RecordUnlockFailure(ctx, grantID, e.now())
		return nil, ErrCredential
	}
	keys, err := decodeRing(grant.SignerPublicKeys)
	if err != nil {
		return nil, ErrDescriptor
	}
	claims, err := keys.VerifyLease(grant.Lease, e.now(), grant.Tuple, grant.LoginBindingSHA256, grant.BrowserThumbprint, grant.GrantSigningThumbprint, grant.GrantEncryptionThumbprint)
	if err != nil {
		if !grant.LeaseExpiresAt.After(e.now()) {
			return nil, ErrLeaseExpired
		}
		return nil, err
	}
	if !sameStringSet(claims.Actions, grant.Actions) || claims.MaxStorageBytes != grant.QuotaBytes || claims.Selection != grant.SelectionRevision || claims.SelectionDigest != grant.SelectionDigest {
		return nil, errors.New("stored lease no longer matches local grant policy")
	}
	if err := e.catalog.CheckClock(ctx, e.now()); err != nil {
		return nil, err
	}
	secrets, err := e.unwrapGrantSecrets(credential.Password, grant.WrappedSecrets, grant.Tuple, grant.LoginBindingSHA256)
	if err != nil {
		if errors.Is(err, ErrCredentialBusy) {
			return nil, err
		}
		_, _ = e.catalog.RecordUnlockFailure(ctx, grantID, e.now())
		return nil, ErrCredential
	}
	if err := verifyGrantSecrets(grant, secrets); err != nil {
		secrets.Destroy()
		return nil, err
	}
	if err := e.processUnlockedInbox(ctx, grant, secrets); err != nil {
		secrets.Destroy()
		return nil, err
	}
	if err := e.catalog.RecordUnlockSuccess(ctx, grantID, e.now()); err != nil {
		secrets.Destroy()
		return nil, err
	}
	epoch, err := e.catalog.BumpBrowserEpoch(ctx, browserID)
	if err != nil {
		secrets.Destroy()
		return nil, err
	}
	issued, err := e.sessions.Open(browserID, grant.Tuple, grant.Actions, *claims, epoch, secrets)
	if err != nil {
		secrets.Destroy()
		return nil, err
	}
	return &UnlockResult{Session: issued, Grant: grant, Lease: *claims, Login: credential.Login}, nil
}

func (e *Engine) AcquireSession(capability, browserID string, profileEpoch int64) (*session.Access, error) {
	return e.sessions.Acquire(capability, browserID, profileEpoch)
}

func (e *Engine) Heartbeat(capability, browserID string, profileEpoch int64, sessionID, clientID string, activitySequence ...uint64) (time.Time, error) {
	return e.sessions.Heartbeat(capability, browserID, profileEpoch, sessionID, clientID, activitySequence...)
}

func (e *Engine) LockBrowser(ctx context.Context, browserID string) (int64, error) {
	e.sessions.LockBrowser(browserID)
	return e.catalog.BumpBrowserEpoch(ctx, browserID)
}

func (e *Engine) Grants(ctx context.Context, browserID, cursor string, limit int) ([]catalog.Grant, string, error) {
	return e.catalog.GrantsForBrowser(ctx, browserID, cursor, limit)
}

type GrantReadiness struct {
	Total  int
	Ready  int
	Errors int
	Usable bool
}

func (e *Engine) GrantReadiness(ctx context.Context, grant *catalog.Grant) (GrantReadiness, error) {
	if grant == nil {
		return GrantReadiness{}, ErrInvalid
	}
	result := GrantReadiness{}
	for _, module := range []string{"tasks", "contacts", "programs", "whiteboards"} {
		items, _, err := e.catalog.Selections(ctx, grant.Tuple.GrantID, module, "", 100)
		if err != nil {
			return GrantReadiness{}, err
		}
		for _, item := range items {
			result.Total++
			switch item.Readiness {
			case "available":
				result.Ready++
			case "error":
				result.Errors++
			}
		}
	}
	if grant.State != "available" || result.Total == 0 || result.Ready != result.Total || result.Errors != 0 {
		return result, nil
	}
	ring, err := decodeRing(grant.SignerPublicKeys)
	if err != nil {
		return result, nil
	}
	claims, err := ring.VerifyLease(grant.Lease, e.now(), grant.Tuple, grant.LoginBindingSHA256, grant.BrowserThumbprint, grant.GrantSigningThumbprint, grant.GrantEncryptionThumbprint)
	if err != nil || !sameStringSet(claims.Actions, grant.Actions) || claims.MaxStorageBytes != grant.QuotaBytes || claims.Selection != grant.SelectionRevision || claims.SelectionDigest != grant.SelectionDigest {
		return result, nil
	}
	if err := e.catalog.CheckClock(ctx, e.now()); err != nil {
		return result, nil
	}
	result.Usable = true
	return result, nil
}

func (e *Engine) Selections(ctx context.Context, access *session.Access, module, cursor string, limit int) ([]catalog.Selection, string, error) {
	if access == nil || !moduleAllowed(access.Actions, module) {
		return nil, "", ErrNotFound
	}
	return e.catalog.Selections(ctx, access.Tuple.GrantID, module, cursor, limit)
}

func (e *Engine) ListResources(ctx context.Context, access *session.Access, module, cursor string, limit int) ([]vault.Resource, string, error) {
	if access == nil || !moduleAllowed(access.Actions, module) {
		return nil, "", ErrNotFound
	}
	grant, err := e.catalog.Grant(ctx, access.Tuple.GrantID)
	if err != nil {
		return nil, "", err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return nil, "", err
	}
	return store.ListResources(ctx, access.Secrets.DEK, module, cursor, limit)
}

func (e *Engine) ListResourcesForSelection(ctx context.Context, access *session.Access, module, selectionID, cursor string, limit int) ([]vault.Resource, string, error) {
	if access == nil || !moduleAllowed(access.Actions, module) {
		return nil, "", ErrNotFound
	}
	selection, err := e.catalog.Selection(ctx, access.Tuple.GrantID, selectionID)
	if err != nil || selection.Module != module || selection.Readiness != "available" {
		return nil, "", ErrNotFound
	}
	grant, err := e.catalog.Grant(ctx, access.Tuple.GrantID)
	if err != nil {
		return nil, "", err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return nil, "", err
	}
	return store.ListResourcesForSelection(ctx, access.Secrets.DEK, module, selectionID, cursor, limit)
}

func (e *Engine) Resource(ctx context.Context, access *session.Access, module, resourceType, resourceID string) (*vault.Resource, error) {
	if access == nil || !moduleAllowed(access.Actions, module) {
		return nil, ErrNotFound
	}
	grant, err := e.catalog.Grant(ctx, access.Tuple.GrantID)
	if err != nil {
		return nil, err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return nil, err
	}
	resource, err := store.Resource(ctx, access.Secrets.DEK, module, resourceType, resourceID)
	if err != nil {
		return nil, err
	}
	selection, err := e.catalog.Selection(ctx, access.Tuple.GrantID, resource.SelectionID)
	if err != nil || selection.Module != module || selection.Readiness != "available" {
		return nil, ErrNotFound
	}
	return resource, nil
}

type TaskCreateInput struct {
	OperationID      string                  `json:"operation_id"`
	SelectionID      string                  `json:"selection_id"`
	TaskID           string                  `json:"task_id"`
	ClientOccurredAt time.Time               `json:"client_occurred_at"`
	Patch            model.TaskCreatePayload `json:"patch"`
}

type TaskCompleteInput struct {
	OperationID      string    `json:"operation_id"`
	SelectionID      string    `json:"selection_id"`
	BaseVersion      int64     `json:"base_version"`
	ClientOccurredAt time.Time `json:"client_occurred_at"`
}

type QueuedTask struct {
	OperationID  string          `json:"operation_id"`
	State        string          `json:"state"`
	LocalTask    json.RawMessage `json:"local_task"`
	PendingCount int             `json:"pending_count"`
}

func (e *Engine) CreateTask(ctx context.Context, access *session.Access, input TaskCreateInput) (*QueuedTask, error) {
	patch, err := json.Marshal(input.Patch)
	if err != nil {
		return nil, err
	}
	operation := e.operation(access, input.OperationID, model.ActionTasksCreate, input.SelectionID, input.TaskID, 0, input.ClientOccurredAt, patch)
	if err := operation.Validate(access.Tuple, access.Actions); err != nil {
		return nil, err
	}
	selection, err := e.requireTaskSelection(ctx, access, input.SelectionID)
	if err != nil {
		return nil, err
	}
	if allowed, err := e.taskListAllowsCreate(ctx, access, input.SelectionID); err != nil || !allowed {
		if err != nil {
			return nil, err
		}
		return nil, ErrActionDenied
	}
	now := e.now().UTC()
	task := map[string]any{"id": input.TaskID, "version": int64(0), "title": input.Patch.Title, "description": input.Patch.Description, "priority": input.Patch.Priority, "status": "pending", "status_category": "not_started", "list_id": selection.ResourceID, "start_at": input.Patch.StartAt, "due_at": input.Patch.DueAt, "due_end_at": input.Patch.DueEndAt, "is_all_day": input.Patch.IsAllDay, "created_at": now, "updated_at": now, "local_confirmation": "pending", "local_create_operation_id": input.OperationID, "can_complete": model.HasAction(access.Actions, model.ActionTasksComplete)}
	localRaw, _ := json.Marshal(task)
	return e.enqueueTask(ctx, access, operation, vault.Resource{SelectionID: input.SelectionID, Module: "tasks", ResourceType: "task", ResourceID: input.TaskID, Revision: 0, Payload: localRaw, UpdatedAt: now})
}

func (e *Engine) CompleteTask(ctx context.Context, access *session.Access, taskID string, input TaskCompleteInput) (*QueuedTask, error) {
	if access == nil {
		return nil, ErrInvalid
	}
	if _, err := e.requireTaskSelection(ctx, access, input.SelectionID); err != nil {
		return nil, err
	}
	grant, err := e.catalog.Grant(ctx, access.Tuple.GrantID)
	if err != nil {
		return nil, err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return nil, err
	}
	current, err := e.taskResource(ctx, access, input.SelectionID, taskID)
	if err != nil || current.SelectionID != input.SelectionID {
		return nil, ErrNotFound
	}
	if !taskAllowsComplete(current.Payload) {
		return nil, ErrActionDenied
	}
	var task map[string]any
	if json.Unmarshal(current.Payload, &task) != nil {
		return nil, errors.New("local task is corrupt")
	}
	if priorComplete, _ := task["local_complete_operation_id"].(string); (task["status"] == "completed" || task["status_category"] == "done") && task["local_confirmation"] == "pending" && canonicalUUID(priorComplete) {
		_, pending, _, _ := store.Counts(ctx)
		return &QueuedTask{OperationID: priorComplete, State: "queued", LocalTask: publicTaskPayload(current.Payload), PendingCount: pending}, nil
	}
	if (task["status"] == "completed" || task["status_category"] == "done") && task["local_confirmation"] != "pending" {
		_, pending, _, _ := store.Counts(ctx)
		return &QueuedTask{OperationID: input.OperationID, State: "noop", LocalTask: publicTaskPayload(current.Payload), PendingCount: pending}, nil
	}
	dependsOn := ""
	if current.Revision == 0 {
		if input.BaseVersion != 0 {
			return nil, ErrInvalid
		}
		dependsOn, _ = task["local_create_operation_id"].(string)
		pendingDependency, dependencyErr := store.HasPendingOperation(ctx, dependsOn)
		if dependencyErr != nil || !pendingDependency {
			return nil, errors.New("pending create dependency unavailable")
		}
	} else if input.BaseVersion != current.Revision {
		return nil, ErrInvalid
	}
	payload := json.RawMessage(`{}`)
	operation := e.operation(access, input.OperationID, model.ActionTasksComplete, input.SelectionID, taskID, input.BaseVersion, input.ClientOccurredAt, payload)
	operation.DependsOnOperationID = dependsOn
	if err := operation.Validate(access.Tuple, access.Actions); err != nil {
		return nil, err
	}
	task["status"], task["status_category"], task["completed_at"], task["updated_at"], task["local_confirmation"] = "completed", "done", e.now().UTC(), e.now().UTC(), "pending"
	task["local_complete_operation_id"] = input.OperationID
	localRaw, _ := json.Marshal(task)
	return e.enqueueTask(ctx, access, operation, vault.Resource{SelectionID: input.SelectionID, Module: "tasks", ResourceType: "task", ResourceID: taskID, Revision: current.Revision, Payload: localRaw, UpdatedAt: e.now().UTC()})
}

func (e *Engine) operation(access *session.Access, operationID, action, selectionID, resourceID string, baseVersion int64, occurredAt time.Time, payload json.RawMessage) model.OfflineOperation {
	if access == nil {
		return model.OfflineOperation{}
	}
	return model.OfflineOperation{ProtocolVersion: model.ProtocolVersion, GrantID: access.Tuple.GrantID, UserID: access.Tuple.UserID, AccountID: access.Tuple.AccountID, BrowserProfileID: access.Tuple.BrowserProfileID,
		OperationID: operationID, Action: action, SelectionID: selectionID, ResourceID: resourceID, SelectionRevision: access.Lease.Selection, CredentialEpoch: access.Lease.Credential, AuthorityEpoch: access.Lease.Authority,
		BaseVersion: baseVersion, Payload: payload, OccurredAt: occurredAt.UTC()}
}

func (e *Engine) enqueueTask(ctx context.Context, access *session.Access, operation model.OfflineOperation, resource vault.Resource) (*QueuedTask, error) {
	unlockGrant := e.lockGrant(operation.GrantID)
	defer unlockGrant()
	grant, err := e.catalog.Grant(ctx, access.Tuple.GrantID)
	if err != nil {
		return nil, err
	}
	if grant.State != "available" || !grant.Tuple.Equal(access.Tuple) {
		return nil, ErrGrantLocked
	}
	var signingJWK, intakeJWK jose.JSONWebKey
	if json.Unmarshal(grant.GrantSigningJWK, &signingJWK) != nil || json.Unmarshal(grant.ServerIntakeJWK, &intakeJWK) != nil {
		return nil, errors.New("operation keys unavailable")
	}
	intakeKey, ok := intakeJWK.Key.(*ecdsa.PublicKey)
	if !ok {
		return nil, errors.New("server intake key corrupt")
	}
	raw, _ := json.Marshal(operation)
	intentHash, err := cryptokit.IntentHash(access.Secrets.DEK, raw)
	if err != nil {
		return nil, err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return nil, err
	}
	existingState, err := store.ExistingOperation(ctx, operation.OperationID, intentHash)
	if err != nil {
		return nil, err
	}
	if existingState != "" {
		stored, loadErr := store.Resource(ctx, access.Secrets.DEK, resource.Module, resource.ResourceType, resource.ResourceID)
		if loadErr != nil {
			return nil, loadErr
		}
		_, pending, _, countErr := store.Counts(ctx)
		if countErr != nil {
			return nil, countErr
		}
		state := "queued"
		if existingState == "received" {
			state = "noop"
		}
		return &QueuedTask{OperationID: operation.OperationID, State: state, LocalTask: publicTaskPayload(stored.Payload), PendingCount: pending}, nil
	}
	inner, err := cryptokit.SignCompact(raw, access.Secrets.SigningKey, signingJWK.KeyID, OperationJWSType)
	if err != nil {
		return nil, err
	}
	outer, err := cryptokit.EncryptOperationCompact([]byte(inner), intakeKey, intakeJWK.KeyID)
	if err != nil {
		return nil, err
	}
	sequence, err := e.catalog.AllocateSequence(ctx, grant.Tuple.GrantID)
	if err != nil {
		return nil, err
	}
	duplicate, err := store.EnqueueSealedAndPutResource(ctx, operation.OperationID, sequence, outer, intentHash, access.Secrets.DEK, resource)
	if err != nil {
		return nil, err
	}
	_, pending, _, err := store.Counts(ctx)
	if err != nil {
		return nil, err
	}
	state := "queued"
	if duplicate {
		stored, loadErr := store.Resource(ctx, access.Secrets.DEK, resource.Module, resource.ResourceType, resource.ResourceID)
		if loadErr != nil {
			return nil, loadErr
		}
		resource.Payload = stored.Payload
	}
	return &QueuedTask{OperationID: operation.OperationID, State: state, LocalTask: publicTaskPayload(resource.Payload), PendingCount: pending}, nil
}

func (e *Engine) lockGrant(grantID string) func() {
	digest := sha256.Sum256([]byte(grantID))
	lock := &e.grantLocks[int(digest[0])%len(e.grantLocks)]
	lock.Lock()
	return lock.Unlock
}

func (e *Engine) credentialSlot() (func(), error) {
	if e == nil || e.credentialSlots == nil {
		return nil, ErrCredentialBusy
	}
	select {
	case e.credentialSlots <- struct{}{}:
		return func() { <-e.credentialSlots }, nil
	default:
		return nil, ErrCredentialBusy
	}
}

func (e *Engine) wrapGrantSecrets(password []byte, tuple model.Tuple, loginBinding string, secrets *cryptokit.GrantSecrets) ([]byte, error) {
	release, err := e.credentialSlot()
	if err != nil {
		return nil, err
	}
	defer release()
	return cryptokit.WrapGrantSecrets(password, tuple, loginBinding, secrets)
}

func (e *Engine) unwrapGrantSecrets(password, wrapped []byte, tuple model.Tuple, loginBinding string) (*cryptokit.GrantSecrets, error) {
	release, err := e.credentialSlot()
	if err != nil {
		return nil, err
	}
	defer release()
	return cryptokit.UnwrapGrantSecrets(password, wrapped, tuple, loginBinding)
}

func (e *Engine) requireTaskSelection(ctx context.Context, access *session.Access, selectionID string) (*catalog.Selection, error) {
	selection, err := e.catalog.Selection(ctx, access.Tuple.GrantID, selectionID)
	if err != nil || selection.Module != "tasks" || selection.ResourceType != "task_list" || selection.Readiness != "available" {
		return nil, ErrNotFound
	}
	return selection, nil
}

func (e *Engine) Counts(ctx context.Context, grantID string) (resources, pending, inbox int, err error) {
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil {
		return 0, 0, 0, err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return 0, 0, 0, err
	}
	return store.Counts(ctx)
}

func (e *Engine) ConflictCount(ctx context.Context, grantID string) (int, error) {
	grant, err := e.catalog.Grant(ctx, grantID)
	if err != nil {
		return 0, err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return 0, err
	}
	return store.ConflictCount(ctx)
}

func (e *Engine) Conflicts(ctx context.Context, access *session.Access, cursor string, limit int) ([]vault.ConflictRecord, string, error) {
	if access == nil || !model.HasAction(access.Actions, model.ActionTasksRead) {
		return nil, "", ErrNotFound
	}
	grant, err := e.catalog.Grant(ctx, access.Tuple.GrantID)
	if err != nil {
		return nil, "", err
	}
	store, err := e.vaultFor(grant)
	if err != nil {
		return nil, "", err
	}
	return store.Conflicts(ctx, access.Secrets.DEK, cursor, limit)
}

func (e *Engine) vaultFor(grant *catalog.Grant) (*vault.Store, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if existing := e.vaults[grant.Tuple.GrantID]; existing != nil {
		if !existing.Tuple().Equal(grant.Tuple) {
			return nil, vault.ErrGrantMismatch
		}
		return existing, nil
	}
	store, err := vault.Open(e.root, grant.Tuple, grant.QuotaBytes)
	if err != nil {
		return nil, err
	}
	e.vaults[grant.Tuple.GrantID] = store
	return store, nil
}

func verifyGrantSecrets(grant *catalog.Grant, secrets *cryptokit.GrantSecrets) error {
	signingJWK, _ := cryptokit.PublicJWK(&secrets.SigningKey.PublicKey, "key", "sig", "ES256")
	encryptionJWK, _ := cryptokit.PublicJWK(&secrets.EncryptionKey.PublicKey, "key", "enc", "ECDH-ES+A256KW")
	signingThumbprint, _ := cryptokit.Thumbprint(signingJWK)
	encryptionThumbprint, _ := cryptokit.Thumbprint(encryptionJWK)
	if signingThumbprint != grant.GrantSigningThumbprint || encryptionThumbprint != grant.GrantEncryptionThumbprint {
		return errors.New("grant secret key binding rejected")
	}
	return nil
}

func moduleAllowed(actions []string, module string) bool {
	wanted := map[string]string{"tasks": model.ActionTasksRead, "contacts": model.ActionContactsRead, "programs": model.ActionProgramsRead, "whiteboards": model.ActionWhiteboardsRead}[module]
	return wanted != "" && model.HasAction(actions, wanted)
}

func encodeAndValidateRing(ring protocol.PublicKeysResponse) (*protocol.SigningKeys, []byte, error) {
	keys, err := protocol.NewSigningKeys(ring)
	if err != nil {
		return nil, nil, err
	}
	raw, err := json.Marshal(ring)
	return keys, raw, err
}

func decodeRing(raw []byte) (*protocol.SigningKeys, error) {
	var ring protocol.PublicKeysResponse
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&ring); err != nil || ensureEOF(decoder) != nil {
		return nil, errors.New("stored signer key ring rejected")
	}
	return protocol.NewSigningKeys(ring)
}

func sameRing(left, right []byte) bool {
	var a, b protocol.PublicKeysResponse
	return json.Unmarshal(left, &a) == nil && json.Unmarshal(right, &b) == nil && a.KeyVersion == b.KeyVersion && publicKeyThumbprints(a.Keys) == publicKeyThumbprints(b.Keys)
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	a, b := append([]string(nil), left...), append([]string(nil), right...)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}

func publicKeyThumbprints(keys []jose.JSONWebKey) string {
	values := make([]string, 0, len(keys))
	for _, key := range keys {
		thumbprint, err := cryptokit.Thumbprint(key)
		if err != nil {
			return ""
		}
		values = append(values, key.KeyID+":"+thumbprint)
	}
	slices.Sort(values)
	return strings.Join(values, "|")
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON rejected")
	}
	return nil
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func canonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == strings.ToLower(value)
}

func randomCapability() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

var _ = fmt.Sprintf
var _ = randomCapability
