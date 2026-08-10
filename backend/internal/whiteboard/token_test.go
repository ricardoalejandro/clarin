package whiteboard

import (
	"testing"
	"time"
)

func TestSecretRoundTripAndMismatch(t *testing.T) {
	plain, hash, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	if plain == "" || len(hash) != 64 || !SecretMatches(hash, plain) {
		t.Fatalf("secret did not round trip")
	}
	if SecretMatches(hash, plain+"x") {
		t.Fatal("mismatched secret was accepted")
	}
}

func TestNormalizeGuestDisplayName(t *testing.T) {
	name, err := NormalizeGuestDisplayName("  Ana   Pérez  ")
	if err != nil || name != "Ana Pérez" {
		t.Fatalf("unexpected normalized name %q: %v", name, err)
	}
	if _, err := NormalizeGuestDisplayName("   "); err == nil {
		t.Fatal("empty name was accepted")
	}
}

func TestPasswordAndGuestExpiry(t *testing.T) {
	hash, err := HashOptionalPassword("segura-123")
	if err != nil {
		t.Fatal(err)
	}
	if !PasswordMatches(hash, "segura-123") || PasswordMatches(hash, "incorrecta") {
		t.Fatal("password verification failed")
	}
	now := time.Date(2026, 8, 9, 10, 0, 0, 0, time.UTC)
	linkExpiry := now.Add(time.Hour)
	if got := GuestSessionExpiry(now, &linkExpiry); !got.Equal(linkExpiry) {
		t.Fatalf("session exceeded link expiry: %s", got)
	}
}
