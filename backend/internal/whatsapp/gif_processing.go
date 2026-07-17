package whatsapp

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxChatGIFSourceBytes = 15 * 1024 * 1024
	maxChatGIFOutputBytes = 15 * 1024 * 1024
	chatGIFRenderTimeout  = 45 * time.Second
)

var chatGIFRenderSlots = make(chan struct{}, 2)

func isGIF(data []byte) bool {
	return len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a")))
}

func convertGIFToWhatsAppVideo(parent context.Context, data []byte) ([]byte, error) {
	if !isGIF(data) {
		return nil, fmt.Errorf("el archivo no es un GIF válido")
	}
	if len(data) > maxChatGIFSourceBytes {
		return nil, fmt.Errorf("el GIF supera 15 MB")
	}
	select {
	case chatGIFRenderSlots <- struct{}{}:
		defer func() { <-chatGIFRenderSlots }()
	case <-parent.Done():
		return nil, parent.Err()
	}

	ctx, cancel := context.WithTimeout(parent, chatGIFRenderTimeout)
	defer cancel()
	tempDir, err := os.MkdirTemp("", "clarin-chat-gif-*")
	if err != nil {
		return nil, fmt.Errorf("no se pudo preparar el GIF")
	}
	defer os.RemoveAll(tempDir)
	inputPath := filepath.Join(tempDir, "input.gif")
	outputPath := filepath.Join(tempDir, "output.mp4")
	if err := os.WriteFile(inputPath, data, 0o600); err != nil {
		return nil, fmt.Errorf("no se pudo preparar el GIF")
	}

	command := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-i", inputPath,
		"-vf", "scale=trunc(min(720\\,iw)/2)*2:-2:flags=lanczos,format=yuv420p",
		"-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
		"-movflags", "+faststart", outputPath,
	)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("la conversión del GIF agotó el tiempo permitido")
		}
		message := strings.TrimSpace(stderr.String())
		if len(message) > 300 {
			message = message[:300]
		}
		if message == "" {
			message = "FFmpeg no pudo procesar el GIF"
		}
		return nil, fmt.Errorf("no se pudo convertir el GIF: %s", message)
	}

	file, err := os.Open(outputPath)
	if err != nil {
		return nil, fmt.Errorf("no se pudo leer el GIF convertido")
	}
	defer file.Close()
	result, err := io.ReadAll(io.LimitReader(file, maxChatGIFOutputBytes+1))
	if err != nil || len(result) == 0 || len(result) > maxChatGIFOutputBytes {
		return nil, fmt.Errorf("el GIF convertido supera 15 MB")
	}
	if len(result) < 12 || !bytes.Equal(result[4:8], []byte("ftyp")) {
		return nil, fmt.Errorf("la conversión del GIF no produjo un MP4 válido")
	}
	return result, nil
}
