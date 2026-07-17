package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	maxStatusOverlaySize        = 10 * 1024 * 1024
	statusRenderTimeout         = 2 * time.Minute
	maxStatusVideoSourceSeconds = 6 * 60 * 60
)

var statusVideoRenderSlots = make(chan struct{}, 2)
var errStatusVideoProcessorBusy = errors.New("status video processor busy")

type statusVideoEditManifest struct {
	TrimStart float64 `json:"trim_start"`
	TrimEnd   float64 `json:"trim_end"`
	Mute      bool    `json:"mute"`
}

func parseStatusVideoEditManifest(raw string) (*statusVideoEditManifest, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var manifest statusVideoEditManifest
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return nil, fmt.Errorf("edición de video inválida")
	}
	if manifest.TrimStart < 0 || manifest.TrimStart > maxStatusVideoSourceSeconds {
		return nil, fmt.Errorf("el inicio del video no es válido")
	}
	if manifest.TrimEnd <= 0 {
		manifest.TrimEnd = manifest.TrimStart + 60
	}
	if manifest.TrimEnd > maxStatusVideoSourceSeconds+60 || manifest.TrimEnd <= manifest.TrimStart || manifest.TrimEnd-manifest.TrimStart > 60.001 {
		return nil, fmt.Errorf("el recorte debe durar entre 0 y 60 segundos")
	}
	return &manifest, nil
}

func validateStatusOverlay(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	if len(data) > maxStatusOverlaySize {
		return fmt.Errorf("el diseño supera 10 MB")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != "png" {
		return fmt.Errorf("el diseño del video debe ser PNG")
	}
	if config.Width < 1 || config.Height < 1 || config.Width > 2160 || config.Height > 3840 || int64(config.Width)*int64(config.Height) > 8_500_000 {
		return fmt.Errorf("el diseño supera las dimensiones permitidas")
	}
	return nil
}

func renderStatusVideo(parent context.Context, input, overlay []byte, manifest *statusVideoEditManifest) ([]byte, error) {
	if manifest == nil && len(overlay) == 0 {
		return input, nil
	}
	if err := validateStatusOverlay(overlay); err != nil {
		return nil, err
	}
	select {
	case statusVideoRenderSlots <- struct{}{}:
		defer func() { <-statusVideoRenderSlots }()
	case <-parent.Done():
		return nil, parent.Err()
	default:
		return nil, errStatusVideoProcessorBusy
	}

	ctx, cancel := context.WithTimeout(parent, statusRenderTimeout)
	defer cancel()
	tempDir, err := os.MkdirTemp("", "clarin-status-render-*")
	if err != nil {
		return nil, fmt.Errorf("no se pudo preparar el procesamiento")
	}
	defer os.RemoveAll(tempDir)
	inputPath := filepath.Join(tempDir, "input.mp4")
	outputPath := filepath.Join(tempDir, "output.mp4")
	if err := os.WriteFile(inputPath, input, 0o600); err != nil {
		return nil, fmt.Errorf("no se pudo preparar el video")
	}

	trimStart := 0.0
	trimDuration := 60.0
	mute := false
	if manifest != nil {
		trimStart = manifest.TrimStart
		trimDuration = manifest.TrimEnd - manifest.TrimStart
		mute = manifest.Mute
	}
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-ss", strconv.FormatFloat(trimStart, 'f', 3, 64), "-i", inputPath,
	}
	videoMap := "0:v:0"
	filter := "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
	if len(overlay) > 0 {
		overlayPath := filepath.Join(tempDir, "overlay.png")
		if err := os.WriteFile(overlayPath, overlay, 0o600); err != nil {
			return nil, fmt.Errorf("no se pudo preparar el diseño")
		}
		args = append(args, "-loop", "1", "-i", overlayPath)
		args = append(args, "-filter_complex", "[0:v]"+filter+"[base];[1:v]scale=1080:1920,format=rgba[overlay];[base][overlay]overlay=0:0:format=auto[v]")
		videoMap = "[v]"
	} else {
		args = append(args, "-vf", filter)
	}
	args = append(args,
		"-map", videoMap,
		"-t", strconv.FormatFloat(trimDuration, 'f', 3, 64),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
	)
	if mute {
		args = append(args, "-an")
	} else {
		args = append(args, "-map", "0:a?", "-c:a", "aac", "-b:a", "128k")
	}
	args = append(args, "-movflags", "+faststart", "-shortest", outputPath)

	command := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("el procesamiento del video agotó el tiempo permitido")
		}
		message := strings.TrimSpace(stderr.String())
		if len(message) > 300 {
			message = message[:300]
		}
		if message == "" {
			message = "FFmpeg no pudo procesar el archivo"
		}
		return nil, fmt.Errorf("no se pudo procesar el video: %s", message)
	}
	file, err := os.Open(outputPath)
	if err != nil {
		return nil, fmt.Errorf("no se pudo leer el video procesado")
	}
	defer file.Close()
	result, err := io.ReadAll(io.LimitReader(file, int64(maxStatusVideoSize)+1))
	if err != nil || len(result) == 0 || len(result) > maxStatusVideoSize {
		return nil, fmt.Errorf("el video procesado supera 30 MB")
	}
	if !isValidStatusMP4(result) {
		return nil, fmt.Errorf("el resultado del video no es un MP4 válido")
	}
	return result, nil
}
