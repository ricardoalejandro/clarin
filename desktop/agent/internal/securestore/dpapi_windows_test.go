//go:build windows

package securestore

import (
	"bytes"
	"testing"
)

func TestDPAPIProtectorRoundTrip(t *testing.T) {
	t.Parallel()
	protector, err := platformProtector()
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte("Clarin offline DPAPI round trip")
	entropy := []byte("clarin-offline-v2:test-terminal")
	protected, err := protector.Protect(plain, entropy)
	if err != nil {
		t.Fatalf("CryptProtectData: %v", err)
	}
	if bytes.Equal(protected, plain) {
		t.Fatal("CryptProtectData returned plaintext")
	}
	recovered, err := protector.Unprotect(protected, entropy)
	if err != nil {
		t.Fatalf("CryptUnprotectData: %v", err)
	}
	if !bytes.Equal(recovered, plain) {
		t.Fatalf("DPAPI round trip recovered %q, want %q", recovered, plain)
	}
}
