package main

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestLocalDatabaseConfigRejectsEffectiveQueryOverridesAndFallbacks(t *testing.T) {
	t.Setenv("PGSERVICE", "")
	t.Setenv("PGSSLMODE", "disable")
	base := "postgres://qa:test-only@127.0.0.1:15439/clarin_cloud_dev"
	for _, tc := range []struct {
		name, query string
		allowed     bool
	}{
		{"dedicated local database", "?sslmode=disable", true},
		{"local TLS fallback", "?sslmode=prefer", true},
		{"matching explicit overrides", "?host=127.0.0.1&port=15439&dbname=clarin_cloud_dev&sslmode=disable", true},
		{"foreign host override", "?host=203.0.113.5&sslmode=disable", false},
		{"wrong port override", "?port=5432&sslmode=disable", false},
		{"wrong database override", "?dbname=production&sslmode=disable", false},
		{"foreign fallback host", "?host=127.0.0.1,203.0.113.5&port=15439,15439&sslmode=disable", false},
		{"wrong fallback port", "?host=127.0.0.1,127.0.0.1&port=15439,5432&sslmode=disable", false},
		{"unix socket override", "?host=%2Ftmp&sslmode=disable", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := localDatabaseConfig(base + tc.query)
			if (err == nil) != tc.allowed {
				t.Fatalf("allowed=%v, want %v", err == nil, tc.allowed)
			}
			if tc.allowed && (cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 15439 || cfg.ConnConfig.Database != "clarin_cloud_dev") {
				t.Fatal("incorrect effective database target")
			}
		})
	}
}

func TestPrivateFixtureReplacementPreservesPreviousRecoveryFileUntilRename(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixture.private.json")
	if err := writePrivateJSON(path, map[string]string{"state": "seeded"}); err != nil {
		t.Fatal(err)
	}
	previous, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer previous.Close()
	if err := writePrivateJSON(path, map[string]string{"state": "ready"}); err != nil {
		t.Fatal(err)
	}
	oldBytes, err := io.ReadAll(previous)
	if err != nil || !bytes.Contains(oldBytes, []byte(`"seeded"`)) {
		t.Fatal("replacement truncated the previous recovery file")
	}
	newBytes, err := os.ReadFile(path)
	if err != nil || !bytes.Contains(newBytes, []byte(`"ready"`)) {
		t.Fatal("replacement manifest not available")
	}
	if err := writePrivateJSON(path, make(chan int)); err == nil {
		t.Fatal("invalid JSON payload unexpectedly succeeded")
	}
	afterFailure, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(newBytes, afterFailure) {
		t.Fatal("failed replacement changed the valid recovery manifest")
	}
	leftover, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".storage-ui-qa-*.tmp"))
	if err != nil || len(leftover) != 0 {
		t.Fatal("private temporary output was not cleaned up")
	}
}

func TestFixtureManifestRemainsPrivateAndRejectsForeignObjectScope(t *testing.T) {
	m, err := newManifest()
	if err != nil {
		t.Fatal(err)
	}
	m.Files = []mediaFile{{Label: "restore", AccountID: m.Accounts["a"].ID, ObjectKey: m.Accounts["a"].ID.String() + "/qa-browser/" + m.RunID.String() + "/restore.pdf"}}
	path := filepath.Join(t.TempDir(), "fixture.private.json")
	if err := writePrivateJSON(path, m); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("generated credentials must only be readable by their owner")
	}
	if _, err := readManifest(path); err != nil {
		t.Fatal(err)
	}
	m.Files[0].ObjectKey = uuid.NewString() + "/qa-browser/" + m.RunID.String() + "/restore.pdf"
	if err := writePrivateJSON(path, m); err != nil {
		t.Fatal(err)
	}
	if _, err := readManifest(path); err == nil {
		t.Fatal("foreign account object was accepted into destructive QA scope")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readManifest(path); err == nil {
		t.Fatal("world-readable credential manifest was accepted")
	}
}

func TestPrivateFixtureOutputCannotFollowSymlink(t *testing.T) {
	dir := t.TempDir()
	target, link := filepath.Join(dir, "unrelated"), filepath.Join(dir, "fixture.private.json")
	if err := os.WriteFile(target, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := writePrivateJSON(link, map[string]string{"password": "test-only"}); err == nil {
		t.Fatal("private output followed symlink")
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "preserve" {
		t.Fatal("unrelated file changed")
	}
}

func TestSyntheticPreviewAssetsAreValidAndIndependent(t *testing.T) {
	first, err := syntheticPNG(0)
	if err != nil {
		t.Fatal(err)
	}
	second, err := syntheticPNG(1)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first, second) {
		t.Fatal("separate scenario images would deduplicate")
	}
	for _, encoded := range [][]byte{first, second} {
		picture, err := png.Decode(bytes.NewReader(encoded))
		if err != nil || picture.Bounds().Dx() != 640 || picture.Bounds().Dy() != 360 {
			t.Fatal("preview PNG is not valid")
		}
	}
	wav := syntheticWAV(12 * 1024 * 1024)
	if len(wav) <= 10*1024*1024 || string(wav[:4]) != "RIFF" || string(wav[8:16]) != "WAVEfmt " || string(wav[36:40]) != "data" || int(binary.LittleEndian.Uint32(wav[4:8])) != len(wav)-8 || int(binary.LittleEndian.Uint32(wav[40:44])) != len(wav)-44 {
		t.Fatal("large audio fixture is not a complete PCM WAV above 10 MiB")
	}
}
