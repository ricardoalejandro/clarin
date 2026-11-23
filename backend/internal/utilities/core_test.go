package utilities

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/google/uuid"
)

func TestEditsPreserveUnicodeAndUseUTF16Offsets(t *testing.T) {
	got, err := ApplyEdits("a😀中\r\nb", []Edit{{Offset: 3, DeleteCount: 1, Text: "ñ"}, {Offset: 6, DeleteCount: 1, Text: "fin"}})
	if err != nil || got != "a😀ñ\r\nfin" {
		t.Fatalf("unicode edit: %q %v", got, err)
	}
	for _, edits := range [][]Edit{{{Offset: 2, DeleteCount: 0, Text: "x"}}, {{Offset: 1, DeleteCount: 1, Text: "x"}}, {{Offset: 1, DeleteCount: 3, Text: "x"}, {Offset: 3, DeleteCount: 1, Text: "y"}}, {{Offset: -1, Text: "x"}}, {{Offset: 100, Text: "x"}}} {
		if _, err := ApplyEdits("a😀中", edits); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid edit accepted: %+v", edits)
		}
	}
	if UTF16Length("a😀中") != 4 {
		t.Fatal("wire offsets are not UTF16")
	}
}
func TestEditsRejectOversizedResultWithoutChangingSource(t *testing.T) {
	source := strings.Repeat("x", DocumentLimit)
	if got, err := ApplyEdits(source, []Edit{{Offset: 0, Text: "x"}}); !errors.Is(err, ErrInvalid) || got != "" {
		t.Fatal("oversized edit accepted")
	}
	got, err := ApplyEdits(source, []Edit{{Offset: 1, DeleteCount: 2, Text: "a"}})
	if err != nil || len(got) != DocumentLimit-1 {
		t.Fatal("bounded edit failed")
	}
}
func TestSearchChunksFindAcrossBoundaryAndEscapeLiteralPatterns(t *testing.T) {
	source := strings.Repeat("a", 8180) + strings.Repeat("ñ😀中", 70) + strings.Repeat("z", 9000)
	needle := strings.Repeat("ñ😀中", 40)
	found := false
	for _, chunk := range SearchChunks(source) {
		if !utf8.ValidString(chunk) || len(chunk) > 8192 {
			t.Fatal("unsafe chunk")
		}
		found = found || strings.Contains(chunk, needle)
	}
	if !found {
		t.Fatal("cross-boundary match lost")
	}
	if got := escapedPattern(`50%_\`); got != `%50\%\_\\%` {
		t.Fatalf("pattern: %q", got)
	}
}
func testCipher(t *testing.T, current string, keys map[string][]byte) *Cipher {
	t.Helper()
	encoded := map[string]string{}
	for id, key := range keys {
		encoded[id] = base64.StdEncoding.EncodeToString(key)
	}
	raw, _ := json.Marshal(encoded)
	c, err := NewCipher(current, string(raw))
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func TestVaultEnvelopeBindsAccountOwnerAndEntryAndRejectsTampering(t *testing.T) {
	c := testCipher(t, "one", map[string][]byte{"one": bytes.Repeat([]byte{1}, 32)})
	a, u, id := uuid.New(), uuid.New(), uuid.New()
	plain := []byte("fixture private material")
	kid, wrapped, body, err := c.Seal(a, u, id, plain)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(body, plain) || bytes.Contains(wrapped, plain) {
		t.Fatal("secret stored in plaintext")
	}
	got, err := c.Open(a, u, id, kid, wrapped, body)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatal("roundtrip failed")
	}
	for _, scope := range [][3]uuid.UUID{{uuid.New(), u, id}, {a, uuid.New(), id}, {a, u, uuid.New()}} {
		if _, err = c.Open(scope[0], scope[1], scope[2], kid, wrapped, body); err == nil {
			t.Fatal("cross-scope material decrypted")
		}
	}
	changed := append([]byte{}, body...)
	changed[len(changed)-1] ^= 1
	if _, err = c.Open(a, u, id, kid, wrapped, changed); err == nil {
		t.Fatal("tampered ciphertext accepted")
	}
	_, wrapped2, body2, err := c.Seal(a, u, id, plain)
	if err != nil || bytes.Equal(wrapped, wrapped2) || bytes.Equal(body, body2) {
		t.Fatal("nonce/data key reused")
	}
}
func TestVaultRotationRetainsCiphertextAndNeedsHistoricalKey(t *testing.T) {
	old := bytes.Repeat([]byte{1}, 32)
	next := bytes.Repeat([]byte{2}, 32)
	c := testCipher(t, "old", map[string][]byte{"old": old})
	a, u, id := uuid.New(), uuid.New(), uuid.New()
	kid, wrapped, body, err := c.Seal(a, u, id, []byte("private fixture"))
	if err != nil {
		t.Fatal(err)
	}
	rotated := testCipher(t, "next", map[string][]byte{"old": old, "next": next})
	newID, newWrapped, err := rotated.Rewrap(a, u, id, kid, wrapped)
	if err != nil || newID != "next" {
		t.Fatal("rewrap failed")
	}
	fresh := testCipher(t, "next", map[string][]byte{"next": next})
	plain, err := fresh.Open(a, u, id, newID, newWrapped, body)
	if err != nil || string(plain) != "private fixture" {
		t.Fatal("rotation corrupted material")
	}
	if _, err = fresh.Open(a, u, id, kid, wrapped, body); err == nil {
		t.Fatal("missing master key accepted")
	}
}
func TestVaultMissingInvalidKeysFailClosed(t *testing.T) {
	for _, pair := range [][2]string{{"", ""}, {"one", `{}`}, {"one", `{"one":"abc"}`}, {"one", `not json`}} {
		if _, err := NewCipher(pair[0], pair[1]); err == nil {
			t.Fatal("invalid key ring accepted")
		}
	}
	var c *Cipher
	if _, _, _, err := c.Seal(uuid.New(), uuid.New(), uuid.New(), []byte("x")); !errors.Is(err, ErrVaultUnavailable) {
		t.Fatal("nil vault accepted")
	}
}
func TestCryptoDocumentsExcludeSecretFields(t *testing.T) {
	for _, raw := range []string{`{"privateKey":"secret"}`, `{"source":"plaintext"}`, `{"password":"secret"}`, `{"key_id":{"privateKey":"secret"}}`, `{"active":"-----BEGIN PRIVATE KEY-----"}`, `{"hash_algorithm":"secret"}`, `{"key_id":"fixture"}`, `null`} {
		if validateConfig("criptografia", json.RawMessage(raw)) == nil {
			t.Fatal("secret field accepted")
		}
	}
	if validateConfig("criptografia", json.RawMessage(`{"active":"keys","key_id":"b9fb5b65-c090-40c1-b01b-70beddb70263","cipher_algorithm":"aes256"}`)) != nil {
		t.Fatal("public configuration rejected")
	}
}
func TestVaultPublicProjectionRejectsPrivateMaterial(t *testing.T) {
	valid := VaultInput{Name: "Prueba", Kind: "rsa", Algorithm: "RSA", Material: `{"privateKey":"fixture"}`, Metadata: json.RawMessage(`{"fingerprint":"abc"}`)}
	if err := validateVault(&valid); err != nil {
		t.Fatal(err)
	}
	for _, public := range []string{"-----BEGIN PRIVATE KEY-----", `{"kty":"RSA","d":"secret"}`, `{"kty":"oct","k":"secret"}`, "raw-secret", "-----BEGIN PUBLIC KEY-----\nZmFrZQ==\n-----END PUBLIC KEY-----"} {
		in := valid
		in.PublicData = public
		if validateVault(&in) == nil {
			t.Fatal("private public_data accepted")
		}
	}
	in := valid
	in.Metadata = json.RawMessage(`{"privateKey":"secret"}`)
	if validateVault(&in) == nil {
		t.Fatal("private metadata accepted")
	}
}

func TestPublicProjectionParsesRealPublicKeysAndRejectsDisguisedPrivateDER(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if !validPublicProjection(string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: public}))) {
		t.Fatal("real public key rejected")
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if validPublicProjection(string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: private}))) {
		t.Fatal("disguised private key accepted in public projection")
	}
}
func TestCursorAndSlotsRejectUntrustedShape(t *testing.T) {
	id := uuid.New()
	encoded := encodeCursor("2026-11-14T00:00:00Z", id)
	c, err := decodeCursor(encoded)
	if err != nil || c.ID != id {
		t.Fatal("cursor failed")
	}
	if _, err = decodeCursor("bad"); err == nil {
		t.Fatal("invalid cursor accepted")
	}
	for _, slot := range []string{"../secret", "x/y", "", "x\n"} {
		if validSlot(slot) {
			t.Fatal("path slot accepted")
		}
	}
	if !validSlot("panel-a") || !validSlot("original-b") {
		t.Fatal("valid slot rejected")
	}
}
