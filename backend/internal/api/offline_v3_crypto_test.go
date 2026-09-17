package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestOfflineV3DependencyPendingHasStableRetryableError(t *testing.T) {
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		return offlineV3RepositoryError(c, repository.ErrOfflineV3DependencyPending)
	})
	response, err := app.Test(httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusConflict {
		t.Fatalf("dependency pending status=%d", response.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "offline_dependency_pending" {
		t.Fatalf("dependency pending error=%q", body["error"])
	}
}

func TestOfflineV3AuthorityClaimsBindCanonicalLogin(t *testing.T) {
	record := &repository.OfflineV3AuthRecord{CanonicalLogin: "Ricardo.CaseSensitive"}
	claims := offlineV3AuthorityClaims(record, []string{domain.OfflineV3ActionTasksRead}, "clarin-offline-local-service", 10*time.Minute)
	digest := sha256.Sum256([]byte(record.CanonicalLogin))
	if claims.LoginBindingSHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("canonical login binding=%q", claims.LoginBindingSHA256)
	}
	changed := sha256.Sum256([]byte("ricardo.casesensitive"))
	if claims.LoginBindingSHA256 == hex.EncodeToString(changed[:]) {
		t.Fatal("case-insensitive alias unexpectedly matched canonical online login")
	}
}

func TestOfflineV3ControlRedeliveryKeepsIdentityAndRefreshesExpiry(t *testing.T) {
	id, installationID, scopeID := uuid.New(), uuid.New(), uuid.New()
	reconnectedAt := time.Date(2026, time.September, 14, 12, 0, 0, 0, time.UTC)
	claims := offlineV3ControlClaimsAt(id, installationID, scopeID, "grant", "wipe", "admin_revoked", 9, reconnectedAt)
	if claims.ID != id.String() || claims.InstallationID != installationID.String() || claims.ScopeID != scopeID.String() || claims.Revision != 9 {
		t.Fatalf("redelivered control identity drifted: %+v", claims)
	}
	if time.Unix(claims.ExpiresAt, 0).Sub(reconnectedAt) != 72*time.Hour || !time.Unix(claims.IssuedAt, 0).Equal(reconnectedAt) {
		t.Fatalf("redelivered control is not fresh: iat=%d exp=%d", claims.IssuedAt, claims.ExpiresAt)
	}
}

func offlineV3TestSignedProof(t *testing.T, key *ecdsa.PrivateKey, kid, typ string, claims offlineV3ProofClaims) string {
	t.Helper()
	options := new(jose.SignerOptions).WithType(jose.ContentType(typ)).WithHeader("kid", kid)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, options)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	object, err := signer.Sign(raw)
	if err != nil {
		t.Fatal(err)
	}
	compact, err := object.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return compact
}

func TestOfflineV3EnrollmentProofBindsNonceAndAuthorization(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public := &jose.JSONWebKey{Key: &privateKey.PublicKey, KeyID: "enrollment-key", Use: "sig", Algorithm: string(jose.ES256)}
	expected := offlineV3ProofClaims{Version: 3, Purpose: "browser", ChallengeID: uuid.New(), InstallationID: uuid.New(),
		WindowsPrincipalID: uuid.New(), BrowserProfileID: uuid.New(), AuthorizationID: uuid.New(), Nonce: "nonce-bound-to-backend",
		RequestHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", IssuedAt: time.Now().UTC().Unix(), ID: uuid.New()}
	compact := offlineV3TestSignedProof(t, privateKey, public.KeyID, offlineV3ProofEnrollment, expected)
	if err := offlineV3VerifyProof(compact, offlineV3ProofEnrollment, public, expected); err != nil {
		t.Fatalf("valid tuple-bound proof rejected: %v", err)
	}
	changed := expected
	changed.AuthorizationID = uuid.New()
	if err := offlineV3VerifyProof(compact, offlineV3ProofEnrollment, public, changed); err == nil {
		t.Fatal("proof was transferable to another Clarin-user authorization")
	}
	changed = expected
	changed.Nonce = "another-nonce"
	if err := offlineV3VerifyProof(compact, offlineV3ProofEnrollment, public, changed); err == nil {
		t.Fatal("proof was replayable under another challenge nonce")
	}
}

func TestOfflineV3EnrollmentHashMatchesFlatMotorWireContract(t *testing.T) {
	jwk := json.RawMessage(`{"kty":"EC","crv":"P-256","x":"x","y":"y","use":"sig","alg":"ES256","kid":"k"}`)
	material := offlineV3EnrollmentMaterial{ChallengeID: uuid.New(), Nonce: "nonce", InstallationID: uuid.New(), WindowsPrincipalID: uuid.New(),
		BrowserProfileID: uuid.New(), AuthorizationID: uuid.New(), DisplayName: "PC", PrincipalDisplayName: "Windows user",
		BrowserName: "Chrome profile", ClientVersion: "3.0.0", SIDHash: "hash", InstallationSigningJWK: jwk,
		ServiceEncryptionJWK: jwk, BrowserDPoPJWK: jwk}
	motorWire := struct {
		ChallengeID            uuid.UUID       `json:"challenge_id"`
		Nonce                  string          `json:"nonce"`
		InstallationID         uuid.UUID       `json:"installation_id"`
		WindowsPrincipalID     uuid.UUID       `json:"windows_principal_id"`
		BrowserProfileID       uuid.UUID       `json:"browser_profile_id"`
		AuthorizationID        uuid.UUID       `json:"authorization_id"`
		DisplayName            string          `json:"display_name"`
		PrincipalDisplayName   string          `json:"principal_display_name"`
		BrowserName            string          `json:"browser_name"`
		ClientVersion          string          `json:"client_version"`
		SIDHash                string          `json:"sid_hash"`
		InstallationSigningJWK json.RawMessage `json:"installation_signing_jwk"`
		ServiceEncryptionJWK   json.RawMessage `json:"service_encryption_jwk"`
		BrowserDPoPJWK         json.RawMessage `json:"browser_dpop_jwk"`
	}{material.ChallengeID, material.Nonce, material.InstallationID, material.WindowsPrincipalID, material.BrowserProfileID,
		material.AuthorizationID, material.DisplayName, material.PrincipalDisplayName, material.BrowserName, material.ClientVersion,
		material.SIDHash, material.InstallationSigningJWK, material.ServiceEncryptionJWK, material.BrowserDPoPJWK}
	backendHash, err := offlineV3CanonicalHash(material)
	if err != nil {
		t.Fatal(err)
	}
	motorHash, err := offlineV3CanonicalHash(motorWire)
	if err != nil {
		t.Fatal(err)
	}
	if backendHash != motorHash {
		t.Fatalf("motor/backend enrollment digest drift: backend=%s motor=%s", backendHash, motorHash)
	}
}

func TestOfflineV3StrictJSONRejectsDuplicateSecurityFields(t *testing.T) {
	if err := offlineV3ValidateJSON([]byte(`{"grant_id":"one","grant_id":"two"}`)); err == nil {
		t.Fatal("duplicate grant_id was accepted")
	}
}

func TestOfflineV3SignerRouteAllowlistIsExact(t *testing.T) {
	allowed := []struct{ method, path string }{
		{http.MethodGet, "/v3/public-keys"},
		{http.MethodGet, "/v3/sync-public-keys"},
		{http.MethodPost, "/v3/sign-service-descriptor"},
		{http.MethodPost, "/v3/sign-grant-bootstrap"},
		{http.MethodPost, "/v3/sign-lease"},
		{http.MethodPost, "/v3/sign-control"},
		{http.MethodPost, "/v3/sign-snapshot"},
		{http.MethodPost, "/v3/sign-receipt"},
		{http.MethodPost, "/v3/decrypt-operation"},
	}
	for _, item := range allowed {
		if !offlineV3SignerRouteAllowed(item.method, item.path) {
			t.Fatalf("required signer route rejected: %s %s", item.method, item.path)
		}
	}
	for _, item := range []struct{ method, path string }{
		{http.MethodPost, "/v3/public-keys"},
		{http.MethodGet, "/v3/sign-lease"},
		{http.MethodPost, "/v3/../health"},
		{http.MethodPost, "/v3/sign-arbitrary"},
		{http.MethodPost, "/v3/sign-lease?admin=true"},
	} {
		if offlineV3SignerRouteAllowed(item.method, item.path) {
			t.Fatalf("unexpected signer route allowed: %s %s", item.method, item.path)
		}
	}
}

func TestOfflineV3SyncInventoryRequiresExactGrantSelections(t *testing.T) {
	first, second := uuid.New(), uuid.New()
	selections := []domain.OfflineV3Selection{{ID: first}, {ID: second}}
	hash := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	items := []offlineV3SyncInventory{{SelectionID: first, HeadVersion: 1, ContentHash: hash}, {SelectionID: second, HeadVersion: 2}}
	indexed, err := offlineV3SyncInventoryIndex(items, selections)
	if err != nil || len(indexed) != 2 {
		t.Fatalf("exact inventory rejected: entries=%d err=%v", len(indexed), err)
	}
	if err := offlineV3ValidateWantedSelections([]uuid.UUID{second}, indexed); err != nil {
		t.Fatalf("selected polling target rejected: %v", err)
	}
	if _, err := offlineV3SyncInventoryIndex([]offlineV3SyncInventory{items[0], items[0]}, selections); !errors.Is(err, repository.ErrOfflineV3Invalid) {
		t.Fatalf("duplicate inventory was not rejected: %v", err)
	}
	foreign := []offlineV3SyncInventory{items[0], {SelectionID: uuid.New(), HeadVersion: 1}}
	if _, err := offlineV3SyncInventoryIndex(foreign, selections); !errors.Is(err, repository.ErrOfflineV3Conflict) {
		t.Fatalf("cross-selection inventory was not isolated: %v", err)
	}
	badHash := append([]offlineV3SyncInventory(nil), items...)
	badHash[0].ContentHash = "ABC"
	if _, err := offlineV3SyncInventoryIndex(badHash, selections); !errors.Is(err, repository.ErrOfflineV3Invalid) {
		t.Fatalf("noncanonical inventory hash was accepted: %v", err)
	}
	if err := offlineV3ValidateWantedSelections([]uuid.UUID{uuid.New()}, indexed); !errors.Is(err, repository.ErrOfflineV3Conflict) {
		t.Fatalf("foreign snapshot target was not isolated: %v", err)
	}
}
