package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArtifactSHA256UsesSidecarWithoutExposingSigningMaterial(t *testing.T) {
	directory := t.TempDir()
	artifact := filepath.Join(directory, "Clarin-Offline-Setup.exe")
	digest := strings.Repeat("a", 64)
	if err := os.WriteFile(artifact+".sha256", []byte(digest+"  Clarin-Offline-Setup.exe\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TEST_OFFLINE_SHA", "")
	if got := artifactSHA256("TEST_OFFLINE_SHA", artifact); got != digest {
		t.Fatalf("sidecar digest=%q want %q", got, digest)
	}
	t.Setenv("TEST_OFFLINE_SHA", strings.Repeat("B", 64))
	if got := artifactSHA256("TEST_OFFLINE_SHA", artifact); got != strings.Repeat("b", 64) {
		t.Fatalf("explicit digest=%q", got)
	}
}
