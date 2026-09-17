package securestore

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"os"
	"testing"
)

type testProtector struct{}

func (testProtector) Protect(plain, entropy []byte) ([]byte, error) {
	key := sha256.Sum256(entropy)
	out := make([]byte, len(plain))
	for index := range plain {
		out[index] = plain[index] ^ key[index%len(key)]
	}
	return out, nil
}
func (testProtector) Unprotect(ciphertext, entropy []byte) ([]byte, error) {
	return testProtector{}.Protect(ciphertext, entropy)
}

func TestStoreRoundTripIsProtectedAndAtomic(t *testing.T) {
	dir := t.TempDir()
	store, err := NewWithProtector(dir, "terminal", testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"counter": float64(8), "secret": "value"}
	if err := store.Save("profile", want); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(dir + "/profile.dpapi")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("secret")) {
		t.Fatal("plaintext leaked into the persisted file")
	}
	var got map[string]any
	if err := store.Load("profile", &got); err != nil {
		t.Fatal(err)
	}
	if got["secret"] != want["secret"] || got["counter"] != want["counter"] {
		t.Fatalf("round trip mismatch: %#v", got)
	}
	if _, err := os.Stat(dir + "/profile.dpapi.next"); !os.IsNotExist(err) {
		t.Fatal("atomic temporary file survived commit")
	}
}

func TestStoreRejectsTraversalNames(t *testing.T) {
	store, err := NewWithProtector(t.TempDir(), "terminal", testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save("../escape", map[string]string{}); err == nil {
		t.Fatal("path traversal name was accepted")
	}
}

func TestStoreSizeTracksProtectedItem(t *testing.T) {
	store, err := NewWithProtector(t.TempDir(), "terminal", testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	if size, err := store.Size("missing"); err != nil || size != 0 {
		t.Fatalf("missing item size = %d, %v", size, err)
	}
	if err := store.Save("state", map[string]string{"value": "protected"}); err != nil {
		t.Fatal(err)
	}
	if size, err := store.Size("state"); err != nil || size == 0 {
		t.Fatalf("saved item size = %d, %v", size, err)
	}
}

func TestStoreRecoversValidPreviousStateAfterInterruptedCommit(t *testing.T) {
	dir := t.TempDir()
	store, err := NewWithProtector(dir, "terminal", testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"state": "recoverable"}
	if err := store.Save("profile", want); err != nil {
		t.Fatal(err)
	}
	primary := dir + "/profile.dpapi"
	previous := primary + ".previous"
	protected, err := os.ReadFile(primary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(previous, protected, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(primary, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	if err := store.Load("profile", &got); err != nil {
		t.Fatalf("recover previous state: %v", err)
	}
	if got["state"] != want["state"] {
		t.Fatalf("recovered state mismatch: %#v", got)
	}
}

func TestStoreDeleteRemovesInterruptedCommitResidues(t *testing.T) {
	dir := t.TempDir()
	store, err := NewWithProtector(dir, "terminal", testProtector{})
	if err != nil {
		t.Fatal(err)
	}
	base := dir + "/account.dpapi"
	for _, path := range []string{base, base + ".previous", base + ".next"} {
		if err := os.WriteFile(path, []byte("protected"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Delete("account"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{base, base + ".previous", base + ".next"} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("secure-store residue survived deletion: %s", path)
		}
	}
}
