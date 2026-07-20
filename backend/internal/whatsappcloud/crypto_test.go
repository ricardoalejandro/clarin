package whatsappcloud

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestTokenCipherRoundTripAndBinding(t *testing.T) {
	key := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	cipher, err := NewTokenCipher(key)
	if err != nil {
		t.Fatalf("NewTokenCipher: %v", err)
	}
	sealed, err := cipher.Seal("business-token", []byte("account/device"))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	if strings.Contains(string(sealed), "business-token") {
		t.Fatal("ciphertext exposes the token")
	}
	plain, err := cipher.Open(sealed, []byte("account/device"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if plain != "business-token" {
		t.Fatalf("unexpected plaintext %q", plain)
	}
	if _, err := cipher.Open(sealed, []byte("other/device")); err == nil {
		t.Fatal("expected additional-data authentication failure")
	}
}

func TestTokenCipherRejectsInvalidKey(t *testing.T) {
	if _, err := NewTokenCipher("short"); err == nil {
		t.Fatal("expected invalid key error")
	}
}
