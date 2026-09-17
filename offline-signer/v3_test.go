package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

const testV3ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

func newTestV3Signer(t *testing.T) *v3Signer {
	t.Helper()
	s, err := loadV3Signer(t.TempDir(), "3")
	if err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return time.Unix(1800000000, 0) }
	return s
}

func validTestV3Lease(s *v3Signer) v3Lease {
	thumb := func(value string) string {
		hash := sha256.Sum256([]byte(value))
		return base64.RawURLEncoding.EncodeToString(hash[:])
	}
	return v3Lease{
		Issuer: v3Issuer, Audience: "clarin-offline-unlock", IssuedAt: s.now().Unix(), NotBefore: s.now().Unix(), ExpiresAt: s.now().Unix() + v3MaxLeaseSeconds,
		ID: testV3ID, Version: 3, InstallationID: testV3ID, WindowsPrincipalID: testV3ID, BrowserProfileID: testV3ID, AuthorizationID: testV3ID, GrantID: testV3ID, UserID: testV3ID, AccountID: testV3ID,
		LoginBindingSHA256: strings.Repeat("b", 64),
		CredentialEpoch:    1, AuthorityEpoch: 1, InstallationRevision: 1, PrincipalRevision: 1, BrowserRevision: 1, AuthorizationRevision: 1, GrantRevision: 1, SelectionRevision: 1,
		SelectionDigest: strings.Repeat("a", 64), Actions: []string{"tasks.read", "tasks.create", "tasks.complete", "contacts.read", "programs.read", "whiteboards.read"}, MaxStorageBytes: v3MaxStorageBytes,
		BrowserKeyThumbprint: thumb("browser"), GrantSigningKeyThumbprint: thumb("signing"), GrantEncryptionKeyThumbprint: thumb("encryption"),
	}
}

func TestV3LeaseTypedSigningAndLegacyKeySeparation(t *testing.T) {
	s := newTestV3Signer(t)
	lease := validTestV3Lease(s)
	body, _ := json.Marshal(lease)
	w := httptest.NewRecorder()
	s.signLease(w, httptest.NewRequest(http.MethodPost, "/v3/sign-lease", bytes.NewReader(body)))
	if w.Code != 200 {
		t.Fatalf("sign lease: %d %s", w.Code, w.Body.String())
	}
	var response struct {
		Token      string `json:"token"`
		KeyID      string `json:"key_id"`
		KeyVersion int    `json:"key_version"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	object, err := jose.ParseSignedCompact(response.Token, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := object.Verify(&s.key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, body) || response.KeyVersion != 3 || response.KeyID != v3KeyID(3) {
		t.Fatal("signed claims or key identity changed")
	}
	if len(object.Signatures) != 1 || object.Signatures[0].Protected.ExtraHeaders["typ"] != "clarin-offline-lease+jwt" {
		t.Fatal("missing typed protected header")
	}
	legacy, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if _, err := object.Verify(&legacy.PublicKey); err == nil {
		t.Fatal("accepted legacy/unrelated key")
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("signing response cacheable")
	}
}

func TestV3LeaseRejectsWeakenedAuthorityAndUnsupportedActions(t *testing.T) {
	s := newTestV3Signer(t)
	tests := map[string]func(*v3Lease){
		"wrong issuer":            func(l *v3Lease) { l.Issuer = "online" },
		"online audience":         func(l *v3Lease) { l.Audience = "clarin-online" },
		"legacy version":          func(l *v3Lease) { l.Version = 2 },
		"missing user":            func(l *v3Lease) { l.UserID = "" },
		"nil grant":               func(l *v3Lease) { l.GrantID = "00000000-0000-0000-0000-000000000000" },
		"missing account":         func(l *v3Lease) { l.AccountID = "" },
		"missing browser":         func(l *v3Lease) { l.BrowserProfileID = "" },
		"zero epoch":              func(l *v3Lease) { l.CredentialEpoch = 0 },
		"zero authority":          func(l *v3Lease) { l.AuthorityEpoch = 0 },
		"zero selection revision": func(l *v3Lease) { l.SelectionRevision = 0 },
		"over 72 hours":           func(l *v3Lease) { l.ExpiresAt++ },
		"expired":                 func(l *v3Lease) { l.ExpiresAt = l.IssuedAt },
		"future issued":           func(l *v3Lease) { l.IssuedAt += 31; l.NotBefore = l.IssuedAt },
		"stale issue":             func(l *v3Lease) { l.IssuedAt -= 301; l.NotBefore = l.IssuedAt; l.ExpiresAt -= 301 },
		"over budget":             func(l *v3Lease) { l.MaxStorageBytes++ },
		"zero budget":             func(l *v3Lease) { l.MaxStorageBytes = 0 },
		"wrong digest":            func(l *v3Lease) { l.SelectionDigest = "bad" },
		"missing login binding":   func(l *v3Lease) { l.LoginBindingSHA256 = "" },
		"short login binding":     func(l *v3Lease) { l.LoginBindingSHA256 = strings.Repeat("b", 62) },
		"upper login binding":     func(l *v3Lease) { l.LoginBindingSHA256 = strings.Repeat("B", 64) },
		"nonhex login binding":    func(l *v3Lease) { l.LoginBindingSHA256 = strings.Repeat("z", 64) },
		"duplicate actions":       func(l *v3Lease) { l.Actions = []string{"tasks.read", "tasks.read"} },
		"simple edit":             func(l *v3Lease) { l.Actions = []string{"tasks.read", "task.update_simple"} },
		"program write":           func(l *v3Lease) { l.Actions = []string{"programs.read", "programs.write"} },
		"create without read":     func(l *v3Lease) { l.Actions = []string{"tasks.create"} },
		"none actions":            func(l *v3Lease) { l.Actions = nil },
		"arbitrary thumbprint":    func(l *v3Lease) { l.BrowserKeyThumbprint = "abc" },
		"reused purpose key":      func(l *v3Lease) { l.GrantEncryptionKeyThumbprint = l.GrantSigningKeyThumbprint },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			lease := validTestV3Lease(s)
			mutate(&lease)
			if s.validateLease(lease) {
				t.Fatal("weakened lease accepted")
			}
		})
	}
}

func TestV3StrictRequestRejectsAmbiguousJSON(t *testing.T) {
	s := newTestV3Signer(t)
	raw, _ := json.Marshal(validTestV3Lease(s))
	base := string(raw)
	for name, body := range map[string]string{
		"duplicate":       strings.Replace(base, `"version":3`, `"version":2,"version":3`, 1),
		"case fold":       strings.Replace(base, `"version":3`, `"VERSION":3`, 1),
		"raw digest":      `{"digest":"abc"}`,
		"second document": base + ` {}`,
		"unknown":         strings.TrimSuffix(base, "}") + `,"scope":"all"}`,
		"oversized":       strings.Repeat(" ", 17000) + base,
		"array":           `[]`,
		"null":            `null`,
	} {
		t.Run(name, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.signLease(w, httptest.NewRequest("POST", "/v3/sign-lease", strings.NewReader(body)))
			if w.Code != 400 {
				t.Fatalf("accepted invalid JSON: %d", w.Code)
			}
		})
	}
}

func TestV3KeysRotateWithoutDiscardingPublicHistoryAndRejectDowngrade(t *testing.T) {
	directory := t.TempDir()
	first, err := loadV3Signer(directory, "3")
	if err != nil {
		t.Fatal(err)
	}
	second, err := loadV3Signer(directory, "4")
	if err != nil {
		t.Fatal(err)
	}
	if len(second.keys) != 2 || len(second.intakeKeys) != 2 || first.key.Equal(second.key) {
		t.Fatal("rotation lost history or reused private key")
	}
	if _, err := loadV3Signer(directory, "3"); err == nil {
		t.Fatal("key downgrade accepted")
	}
	for _, key := range second.keys {
		if !key.IsPublic() {
			t.Fatal("private material exposed")
		}
	}
	if first.key.Equal(first.intakeKeys[v3IntakeKeyID(3)]) {
		t.Fatal("lease and intake key reused")
	}
	w := httptest.NewRecorder()
	second.publicKeys(w, httptest.NewRequest("GET", "/v3/public-keys", nil))
	if strings.Contains(w.Body.String(), `"d":`) {
		t.Fatal("private field in public key response")
	}
}

func TestV3EverySigningPlaneRequiresBackendAuthentication(t *testing.T) {
	v3 := newTestV3Signer(t)
	s := &signer{v3: v3, tokenHash: sha256.Sum256([]byte("not-a-production-token"))}
	for name, handler := range map[string]http.HandlerFunc{"lease": v3.signLease, "control": v3.signControl, "intake": v3.decryptOperation, "public": v3.publicKeys, "sync public": v3.syncPublicKeys, "descriptor": v3.signServiceDescriptor} {
		t.Run(name, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.authorized(handler)(w, httptest.NewRequest("POST", "/", strings.NewReader(`{}`)))
			if w.Code != 401 {
				t.Fatal("missing backend authentication accepted")
			}
		})
	}
}

func TestV3ControlEnforcesTypedScopeAndReasons(t *testing.T) {
	s := newTestV3Signer(t)
	valid := v3Control{Issuer: v3Issuer, Audience: "clarin-offline-control", IssuedAt: s.now().Unix(), NotBefore: s.now().Unix(), ExpiresAt: s.now().Unix() + 3600, ID: testV3ID, Version: 3, InstallationID: testV3ID, Scope: "installation", ScopeID: testV3ID, Revision: 2, Action: "lock", Reason: "admin_revoked"}
	for name, mutate := range map[string]func(*v3Control){
		"valid": func(c *v3Control) {}, "scope": func(c *v3Control) { c.Scope = "all" }, "target": func(c *v3Control) { c.ScopeID = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, "action": func(c *v3Control) { c.Action = "execute" }, "reason": func(c *v3Control) { c.Reason = "arbitrary private message" }, "revision": func(c *v3Control) { c.Revision = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			input := valid
			mutate(&input)
			body, _ := json.Marshal(input)
			w := httptest.NewRecorder()
			s.signControl(w, httptest.NewRequest("POST", "/v3/sign-control", bytes.NewReader(body)))
			want := 400
			if name == "valid" {
				want = 200
			}
			if w.Code != want {
				t.Fatalf("got %d want %d", w.Code, want)
			}
		})
	}
}

func makeV3OperationEnvelope(t *testing.T, s *v3Signer, typ string) string {
	t.Helper()
	operationKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: operationKey}, new(jose.SignerOptions).WithType("clarin-offline-operation+jws"))
	if err != nil {
		t.Fatal(err)
	}
	signed, err := signer.Sign([]byte(`{"grant_id":"` + testV3ID + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	inner, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	keyID := v3IntakeKeyID(3)
	options := new(jose.EncrypterOptions).WithType(jose.ContentType(typ)).WithContentType("clarin-offline-operation+jws").WithHeader("kid", keyID)
	encrypter, err := jose.NewEncrypter(jose.A256GCM, jose.Recipient{Algorithm: jose.ECDH_ES_A256KW, Key: &s.intakeKeys[keyID].PublicKey}, options)
	if err != nil {
		t.Fatal(err)
	}
	object, err := encrypter.Encrypt([]byte(inner))
	if err != nil {
		t.Fatal(err)
	}
	compact, err := object.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return compact
}

func TestV3IntakeOpensOnlyBoundedPurposeSpecificJOSE(t *testing.T) {
	s := newTestV3Signer(t)
	good := makeV3OperationEnvelope(t, s, "clarin-offline-operation+jwe")
	if payload, key, err := s.openOperation(good); err != nil || payload == "" || key != v3IntakeKeyID(3) {
		t.Fatalf("valid envelope rejected: %v", err)
	}
	parts := strings.Split(good, ".")
	tag, _ := base64.RawURLEncoding.DecodeString(parts[4])
	tag[0] ^= 1
	parts[4] = base64.RawURLEncoding.EncodeToString(tag)
	other := newTestV3Signer(t)
	if _, _, err := other.openOperation(good); err == nil {
		t.Fatal("other private key accepted")
	}
	for name, input := range map[string]string{"bad type": makeV3OperationEnvelope(t, s, "general-purpose"), "tampered": strings.Join(parts, "."), "whitespace": " " + good, "oversized": strings.Repeat("x", v3MaxOperationEnvelope+1), "json serialization": `{"ciphertext":"x"}`} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := s.openOperation(input); err == nil {
				t.Fatal("invalid envelope accepted")
			}
		})
	}
	body, _ := json.Marshal(map[string]string{"compact_jwe": good})
	w := httptest.NewRecorder()
	s.decryptOperation(w, httptest.NewRequest("POST", "/v3/decrypt-operation", bytes.NewReader(body)))
	if w.Code != 200 {
		t.Fatalf("intake HTTP: %d", w.Code)
	}
}
