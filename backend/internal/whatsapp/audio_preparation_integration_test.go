package whatsapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// Generate only synthetic tones; no real WhatsApp, user file or storage write.
func TestAudioPreparationFFprobeIntegration(t *testing.T) {
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skip(binary + " is not installed")
		}
	}
	for _, item := range []struct {
		filename, codec, mime, errorCode string
		voice                            bool
	}{
		{"tone.ogg", "libopus", "audio/ogg; codecs=opus", "", true},
		{"tone.mp3", "libmp3lame", "audio/mpeg", "", false},
		{"tone.m4a", "aac", "audio/mp4", "", false},
		{"tone.aac", "aac", "audio/aac", "", false},
		{"tone.wav", "pcm_s16le", "", "audio_codec_unsupported", false},
		{"vorbis.ogg", "libvorbis", "", "audio_codec_unsupported", false},
	} {
		t.Run(item.filename, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), item.filename)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.25", "-ac", "1", "-c:a", item.codec, "-y", path)
			if err := command.Run(); err != nil {
				t.Fatal("synthetic audio fixture generation failed", err)
			}
			source, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			before := sha256.Sum256(source)
			info, err := prepareAudioForUpload(context.Background(), source)
			if item.errorCode != "" {
				requireAudioCode(t, err, item.errorCode)
				return
			}
			if err != nil || info.Mimetype != item.mime || info.VoiceCompatible != item.voice || info.Seconds < 1 {
				t.Fatalf("real probe mismatch: %+v %v", info, err)
			}
			if sha256.Sum256(source) != before {
				t.Fatal("probing changed source bytes")
			}
			// The uploaded bytes and MIME stay identical whether the source was a file
			// or a known voice note; only the explicitly preserved PTT flag differs.
			media := &PreUploadedMedia{Audio: info, FileLength: uint64(len(source))}
			packet, err := preparedAudioMessage(media, false, nil)
			if err != nil || packet.GetPTT() || packet.GetFileLength() != uint64(len(source)) || packet.GetMimetype() != item.mime {
				t.Fatal("attached file envelope mismatch", err)
			}
			if _, err = preparedAudioMessage(media, true, nil); item.voice && err != nil {
				t.Fatal("known Opus voice rejected", err)
			} else if !item.voice {
				requireAudioCode(t, err, "audio_voice_codec_unsupported")
			}
		})
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	defer server.Close()
	_, err := prepareAudioForUpload(context.Background(), []byte("#EXTM3U\n"+server.URL+"/private\n"))
	requireAudioCode(t, err, "audio_invalid")
	if requests.Load() != 0 {
		t.Fatal("probe followed an embedded network reference")
	}
	_, err = prepareAudioForUpload(context.Background(), bytes.Repeat([]byte("invalid"), 10))
	requireAudioCode(t, err, "audio_invalid")
}
