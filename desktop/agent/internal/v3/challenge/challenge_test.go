package challenge

import (
	"errors"
	"testing"
	"time"
)

func TestChallengeIsPurposeBoundSingleUse(t *testing.T) {
	now := time.Now().UTC()
	m := NewManager()
	m.now = func() time.Time { return now }
	entry, err := m.Create("unlock", "browser", "grant", time.Minute)
	if err != nil || len(entry.Nonce) != 43 {
		t.Fatalf("create: %#v %v", entry, err)
	}
	if _, err := m.Consume(entry.ID, "provision"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-purpose challenge accepted: %v", err)
	}
	if _, err := m.Consume(entry.ID, "unlock"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Consume(entry.ID, "unlock"); !errors.Is(err, ErrConsumed) {
		t.Fatalf("replay accepted: %v", err)
	}
}

func TestPrincipalCompletionCannotBeRebound(t *testing.T) {
	m := NewManager()
	entry, _ := m.Create("principal", "", "", time.Minute)
	if _, err := m.CompletePrincipal(entry.ID, "principal-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.CompletePrincipal(entry.ID, "principal-b"); !errors.Is(err, ErrConsumed) {
		t.Fatalf("principal rebound: %v", err)
	}
}
