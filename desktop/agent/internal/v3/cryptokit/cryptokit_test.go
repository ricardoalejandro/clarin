package cryptokit

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"

	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

func cryptoTuple() model.Tuple {
	return model.Tuple{
		InstallationID:     "11111111-1111-4111-8111-111111111111",
		WindowsPrincipalID: "22222222-2222-4222-8222-222222222222",
		BrowserProfileID:   "33333333-3333-4333-8333-333333333333",
		AuthorizationID:    "44444444-4444-4444-8444-444444444444",
		GrantID:            "55555555-5555-4555-8555-555555555555",
		UserID:             "66666666-6666-4666-8666-666666666666",
		AccountID:          "77777777-7777-4777-8777-777777777777",
	}
}

func TestPasswordWrappedSecretsAndGrantBinding(t *testing.T) {
	loginBinding, err := model.LoginBinding("ricardo")
	if err != nil {
		t.Fatal(err)
	}
	secrets, err := GenerateGrantSecrets()
	if err != nil {
		t.Fatal(err)
	}
	defer secrets.Destroy()
	wrapper, err := WrapGrantSecrets([]byte("correct horse battery staple"), cryptoTuple(), loginBinding, secrets)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := UnwrapGrantSecrets([]byte("correct horse battery staple"), wrapper, cryptoTuple(), loginBinding)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Destroy()
	if !bytes.Equal(opened.DEK, secrets.DEK) || opened.SigningKey.D.Cmp(secrets.SigningKey.D) != 0 || opened.EncryptionKey.D.Cmp(secrets.EncryptionKey.D) != 0 {
		t.Fatal("unwrapped secrets differ")
	}
	other := cryptoTuple()
	other.GrantID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	if _, err := UnwrapGrantSecrets([]byte("correct horse battery staple"), wrapper, other, loginBinding); err == nil {
		t.Fatal("grant wrapper opened under another grant")
	}
	otherLogin, _ := model.LoginBinding("otro-usuario")
	if _, err := UnwrapGrantSecrets([]byte("correct horse battery staple"), wrapper, cryptoTuple(), otherLogin); err == nil {
		t.Fatal("grant wrapper opened for another login with the same password")
	}
}

func TestRecordEncryptionAuthenticatesAADAndCiphertext(t *testing.T) {
	key := bytes.Repeat([]byte{0x7a}, 32)
	aad := []byte("grant-a/resource-a/1")
	sealed, err := SealRecord(key, aad, []byte(`{"title":"privado"}`))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := OpenRecord(key, aad, sealed)
	if err != nil || string(plain) != `{"title":"privado"}` {
		t.Fatalf("record roundtrip failed: %q %v", plain, err)
	}
	if _, err := OpenRecord(key, []byte("grant-b/resource-a/1"), sealed); err == nil {
		t.Fatal("record opened with swapped AAD")
	}
	var envelope SealedRecord
	if err := json.Unmarshal(sealed, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Ciphertext = strings.Repeat("A", len(envelope.Ciphertext))
	tampered, _ := json.Marshal(envelope)
	if _, err := OpenRecord(key, aad, tampered); err == nil {
		t.Fatal("tampered record opened")
	}
}

func TestJOSEStrictAlgorithmsAndSeparateKeys(t *testing.T) {
	signingKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	encryptionKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	wrongKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)

	signed, err := SignCompact([]byte(`{"v":3}`), signingKey, "grant-sig-v1", "clarin-offline-operation+jws")
	if err != nil {
		t.Fatal(err)
	}
	verified, err := VerifyCompact(signed, &signingKey.PublicKey, "grant-sig-v1", "clarin-offline-operation+jws")
	if err != nil || string(verified) != `{"v":3}` {
		t.Fatalf("JWS roundtrip failed: %q %v", verified, err)
	}
	if _, err := VerifyCompact(signed, &wrongKey.PublicKey, "grant-sig-v1", "clarin-offline-operation+jws"); err == nil {
		t.Fatal("JWS verified with another key")
	}

	encrypted, err := EncryptCompact([]byte(signed), &encryptionKey.PublicKey, "grant-enc-v1", "clarin-offline-snapshot+jwe")
	if err != nil {
		t.Fatal(err)
	}
	opened, err := DecryptCompact(encrypted, encryptionKey, "grant-enc-v1", "clarin-offline-snapshot+jwe")
	if err != nil || string(opened) != signed {
		t.Fatalf("JWE roundtrip failed: %q %v", opened, err)
	}
	if _, err := DecryptCompact(encrypted, wrongKey, "grant-enc-v1", "clarin-offline-snapshot+jwe"); err == nil {
		t.Fatal("JWE opened with another grant key")
	}
	if _, err := DecryptCompact(encrypted, encryptionKey, "grant-enc-v1", "clarin-offline-receipt+jwe"); err == nil {
		t.Fatal("JWE type confusion accepted")
	}
}

func TestPublicJWKThumbprintsAreKeySpecific(t *testing.T) {
	a, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	b, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ajwk, err := PublicJWK(&a.PublicKey, "a", "sig", "ES256")
	if err != nil {
		t.Fatal(err)
	}
	bjwk, err := PublicJWK(&b.PublicKey, "b", "sig", "ES256")
	if err != nil {
		t.Fatal(err)
	}
	at, _ := Thumbprint(ajwk)
	bt, _ := Thumbprint(bjwk)
	if at == "" || at == bt {
		t.Fatal("JWK thumbprints are not key-specific")
	}
}
