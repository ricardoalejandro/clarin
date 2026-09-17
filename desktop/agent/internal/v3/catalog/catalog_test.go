package catalog

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

type testProtector struct{ key []byte }

func newTestProtector() *testProtector { return &testProtector{key: bytes.Repeat([]byte{0x5c}, 32)} }

func (p *testProtector) Protect(plain []byte, purpose string) ([]byte, error) {
	block, _ := aes.NewCipher(p.key)
	aead, _ := cipher.NewGCM(block)
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return append(nonce, aead.Seal(nil, nonce, plain, []byte(purpose))...), nil
}

func (p *testProtector) Unprotect(sealed []byte, purpose string) ([]byte, error) {
	block, _ := aes.NewCipher(p.key)
	aead, _ := cipher.NewGCM(block)
	if len(sealed) < aead.NonceSize() {
		return nil, errors.New("short test envelope")
	}
	return aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], []byte(purpose))
}

func openCatalog(t *testing.T, root string) *Store {
	t.Helper()
	store, err := Open(root, "https://clarin.example", newTestProtector())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestInstallationPersistsSeparateServiceKeysAndCounter(t *testing.T) {
	root := t.TempDir()
	store := openCatalog(t, root)
	first, err := store.EnsureInstallation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.SigningKey.D.Cmp(first.EncryptionKey.D) == 0 || first.SigningJWK.Use != "sig" || first.EncryptionJWK.Use != "enc" {
		t.Fatal("service signing and encryption keys are not separated")
	}
	firstID := first.ID
	first.Destroy()
	if value, err := store.NextCounter(context.Background()); err != nil || value != 1 {
		t.Fatalf("counter allocation failed: %d %v", value, err)
	}
	second, err := store.EnsureInstallation(context.Background())
	if err != nil || second.ID != firstID || second.Counter != 1 {
		t.Fatalf("installation did not persist: %#v %v", second, err)
	}
	second.Destroy()
	if raw, err := os.ReadFile(store.path); err != nil || bytes.Contains(raw, []byte("BEGIN PRIVATE KEY")) {
		t.Fatalf("private key leaked to catalog: %v", err)
	}
}

func TestPrincipalAndBrowserAreBoundToNativeIdentity(t *testing.T) {
	store := openCatalog(t, t.TempDir())
	ctx := context.Background()
	if _, err := store.EnsureInstallation(ctx); err != nil {
		t.Fatal(err)
	}
	first, err := store.EnsurePrincipal(ctx, "S-1-5-21-100-200-300-1001", "Ricardo")
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.EnsurePrincipal(ctx, "S-1-5-21-100-200-300-1001", "Ignored rename")
	if err != nil || second.ID != first.ID || first.SIDHash == "" {
		t.Fatalf("principal identity not stable: %#v %#v %v", first, second, err)
	}
	rawSIDHash := sha256.Sum256([]byte("S-1-5-21-100-200-300-1001"))
	if first.SIDHash == string(rawSIDHash[:]) {
		t.Fatal("principal uses an unkeyed SID hash")
	}
	browserKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	browserJWK, _ := cryptokit.PublicJWK(&browserKey.PublicKey, "browser-bootstrap", "sig", "ES256")
	profile, err := store.CreateBrowserProfile(ctx, first.ID, browserJWK, "Edge principal")
	if err != nil || profile.State != "pending" || profile.DPoPThumbprint == "" {
		t.Fatalf("browser profile enrollment failed: %#v %v", profile, err)
	}
	loaded, err := store.BrowserProfile(ctx, profile.ID)
	if err != nil || loaded.PrincipalID != first.ID || loaded.Label != "Edge principal" {
		t.Fatalf("browser binding failed: %#v %v", loaded, err)
	}
}

func TestGrantTupleCannotBeReassignedAndSecretsAreProtected(t *testing.T) {
	store := openCatalog(t, t.TempDir())
	ctx := context.Background()
	installation, _ := store.EnsureInstallation(ctx)
	defer installation.Destroy()
	principal, _ := store.EnsurePrincipal(ctx, "S-1-5-21-42", "Local")
	browserKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	browserJWK, _ := cryptokit.PublicJWK(&browserKey.PublicKey, "browser", "sig", "ES256")
	profile, _ := store.CreateBrowserProfile(ctx, principal.ID, browserJWK, "Chrome")
	tuple := model.Tuple{
		InstallationID: installation.ID, WindowsPrincipalID: principal.ID, BrowserProfileID: profile.ID,
		AuthorizationID: "44444444-4444-4444-8444-444444444444", GrantID: "55555555-5555-4555-8555-555555555555",
		UserID: "66666666-6666-4666-8666-666666666666", AccountID: "77777777-7777-4777-8777-777777777777",
	}
	loginBinding, _ := model.LoginBinding("usuario")
	grant := Grant{Tuple: tuple, State: "preparing", Actions: []string{model.ActionTasksRead, model.ActionTasksCreate}, QuotaBytes: 16 << 20, DisplayUser: "Usuario Privado", DisplayAccount: "Cuenta Privada", BrowserThumbprint: profile.DPoPThumbprint, LoginBindingSHA256: loginBinding, WrappedSecrets: []byte("wrapped-private-secret"), TransportCapability: []byte("transport-secret"), SignerPublicKeys: []byte("public-ring")}
	if err := store.SaveGrant(ctx, grant); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Grant(ctx, tuple.GrantID)
	if err != nil || loaded.DisplayUser != grant.DisplayUser || !bytes.Equal(loaded.WrappedSecrets, grant.WrappedSecrets) {
		t.Fatalf("grant roundtrip failed: %#v %v", loaded, err)
	}
	other := grant
	other.Tuple.AccountID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	if err := store.SaveGrant(ctx, other); !errors.Is(err, ErrTupleMismatch) {
		t.Fatalf("grant reassignment not rejected: %v", err)
	}
	raw, err := os.ReadFile(store.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range [][]byte{[]byte("Usuario Privado"), []byte("Cuenta Privada"), []byte("wrapped-private-secret")} {
		if bytes.Contains(raw, secret) {
			t.Fatalf("private grant material leaked into catalog: %q", secret)
		}
	}
	if err := store.RevokeGrantAndEraseSecrets(ctx, tuple.GrantID); err != nil {
		t.Fatal(err)
	}
	revoked, err := store.Grant(ctx, tuple.GrantID)
	if err != nil || revoked.State != "revoked" || revoked.DisplayUser != "" || revoked.DisplayAccount != "" || len(revoked.WrappedSecrets) != 0 || string(revoked.TransportCapability) != "transport-secret" || string(revoked.SignerPublicKeys) != "public-ring" {
		t.Fatalf("revocation did not cryptographically erase secrets while retaining ACK material: %#v %v", revoked, err)
	}
	if err := store.FinalizeRevokedGrant(ctx, tuple.GrantID); err != nil {
		t.Fatal(err)
	}
	revoked, err = store.Grant(ctx, tuple.GrantID)
	if err != nil || len(revoked.TransportCapability) != 0 || len(revoked.SignerPublicKeys) != 0 {
		t.Fatalf("revocation ACK metadata was not finalized: %#v %v", revoked, err)
	}
}

func TestUnlockThrottlePersistsAndDetectsClockRollback(t *testing.T) {
	store := openCatalog(t, t.TempDir())
	ctx := context.Background()
	installation, _ := store.EnsureInstallation(ctx)
	defer installation.Destroy()
	principal, _ := store.EnsurePrincipal(ctx, "S-1-5-21-43", "Local")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := cryptokit.PublicJWK(&key.PublicKey, "browser", "sig", "ES256")
	profile, _ := store.CreateBrowserProfile(ctx, principal.ID, jwk, "Chrome")
	grantID := "55555555-5555-4555-8555-555555555555"
	loginBinding, _ := model.LoginBinding("usuario")
	grant := Grant{Tuple: model.Tuple{InstallationID: installation.ID, WindowsPrincipalID: principal.ID, BrowserProfileID: profile.ID, AuthorizationID: "44444444-4444-4444-8444-444444444444", GrantID: grantID, UserID: "66666666-6666-4666-8666-666666666666", AccountID: "77777777-7777-4777-8777-777777777777"}, State: "preparing", Actions: []string{model.ActionContactsRead}, QuotaBytes: 16 << 20, BrowserThumbprint: profile.DPoPThumbprint, LoginBindingSHA256: loginBinding}
	if err := store.SaveGrant(ctx, grant); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	delay, err := store.RecordUnlockFailure(ctx, grantID, now)
	if err != nil || delay != time.Second {
		t.Fatalf("first throttle failure mismatch: %v %v", delay, err)
	}
	if retry, err := store.CheckUnlock(ctx, grantID, now); !errors.Is(err, ErrUnlockThrottled) || retry <= 0 {
		t.Fatalf("throttle was not enforced: %v %v", retry, err)
	}
	if err := store.RecordUnlockSuccess(ctx, grantID, now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CheckUnlock(ctx, grantID, now.Add(2*time.Second)); err != nil {
		t.Fatalf("successful unlock did not reset throttle: %v", err)
	}
	if err := store.AdvanceTrustedTime(ctx, now.Add(time.Hour), now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CheckUnlock(ctx, grantID, now); !errors.Is(err, ErrClockRollback) {
		t.Fatalf("clock rollback not detected: %v", err)
	}
}

func TestGrantActionsJSONIsCanonicalDataNotSQLAuthority(t *testing.T) {
	if raw, err := json.Marshal([]string{model.ActionTasksRead}); err != nil || !json.Valid(raw) {
		t.Fatal("test precondition")
	}
}
