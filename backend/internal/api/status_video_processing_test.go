package api

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestParseStatusVideoEditManifest(t *testing.T) {
	manifest, err := parseStatusVideoEditManifest(`{"trim_start":1.5,"trim_end":12.25,"mute":true}`)
	if err != nil {
		t.Fatalf("parse valid manifest: %v", err)
	}
	if manifest.TrimStart != 1.5 || manifest.TrimEnd != 12.25 || !manifest.Mute {
		t.Fatalf("unexpected manifest: %#v", manifest)
	}
	for _, raw := range []string{
		`{"trim_start":-1,"trim_end":3}`,
		`{"trim_start":4,"trim_end":4}`,
		`{"trim_start":0,"trim_end":61}`,
		`{"trim_start":0,"trim_end":2,"command":"-i"}`,
	} {
		if _, err := parseStatusVideoEditManifest(raw); err == nil {
			t.Fatalf("expected invalid manifest for %s", raw)
		}
	}
}

func TestValidateStatusOverlay(t *testing.T) {
	imageValue := image.NewNRGBA(image.Rect(0, 0, 1080, 1920))
	imageValue.Set(5, 5, color.NRGBA{R: 255, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, imageValue); err != nil {
		t.Fatal(err)
	}
	if err := validateStatusOverlay(buffer.Bytes()); err != nil {
		t.Fatalf("valid overlay rejected: %v", err)
	}
	if err := validateStatusOverlay([]byte("not an image")); err == nil {
		t.Fatal("invalid overlay accepted")
	}
}

func TestRenderStatusVideo(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	tempDir := t.TempDir()
	inputPath := filepath.Join(tempDir, "input.mp4")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", inputPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v: %s", err, output)
	}
	input, err := os.ReadFile(inputPath)
	if err != nil {
		t.Fatal(err)
	}
	result, err := renderStatusVideo(context.Background(), input, nil, &statusVideoEditManifest{TrimStart: 0, TrimEnd: 0.8, Mute: true})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if len(result) == 0 || !isValidStatusMP4(result) {
		t.Fatal("rendered result is not a valid MP4")
	}
}
