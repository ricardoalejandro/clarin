package whatsapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

const (
	audioProbeTimeout   = 5 * time.Second
	maxAudioProbeOutput = 16 * 1024
)

var audioProbeSlots = make(chan struct{}, 2)

// AudioPreparationError is safe to return to the caller. It never includes
// file contents, paths, tags, process output or a remote storage URL.
type AudioPreparationError struct{ Code, Message string }

func (e *AudioPreparationError) Error() string { return e.Message }
func audioPreparationError(code, message string) error {
	return &AudioPreparationError{Code: code, Message: message}
}

// AudioMessage has no caption field. Do not claim that local-only text was sent
// or silently create a second WhatsApp message under one operation ID.
func ValidateAudioCaption(kind, caption string) error {
	if kind == domain.MessageTypeAudio && strings.TrimSpace(caption) != "" {
		return audioPreparationError("audio_caption_unsupported", "El audio no admite un pie de texto. Conserva el texto y envíalo por separado, o envía el audio como archivo adjunto.")
	}
	return nil
}

type preparedAudio struct {
	Mimetype        string
	Seconds         uint32
	VoiceCompatible bool
}
type audioProbeResult struct {
	Streams []struct {
		CodecType   string `json:"codec_type"`
		CodecName   string `json:"codec_name"`
		Channels    int    `json:"channels"`
		Duration    string `json:"duration"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
	} `json:"streams"`
	Format struct {
		Name     string `json:"format_name"`
		Duration string `json:"duration"`
	} `json:"format"`
}

// Parse only actual stream/container metadata. An extension or client-supplied
// Content-Type can never turn arbitrary bytes into an Opus voice note.
func preparedAudioFromProbe(raw []byte) (*preparedAudio, error) {
	invalid := func() (*preparedAudio, error) {
		return nil, audioPreparationError("audio_invalid", "El archivo no contiene un audio válido. Puedes enviarlo como archivo adjunto.")
	}
	if len(raw) == 0 || len(raw) > maxAudioProbeOutput {
		return invalid()
	}
	var probe audioProbeResult
	if json.Unmarshal(raw, &probe) != nil {
		return invalid()
	}
	codec, duration, channels, count := "", "", 0, 0
	for _, stream := range probe.Streams {
		if stream.CodecType == "audio" {
			count++
			codec, duration, channels = stream.CodecName, stream.Duration, stream.Channels
		} else if stream.CodecType != "video" || stream.Disposition.AttachedPic != 1 {
			return invalid()
		}
	}
	if count != 1 || channels < 1 || channels > 2 {
		return invalid()
	}
	if duration == "" || duration == "N/A" {
		duration = probe.Format.Duration
	}
	seconds, err := strconv.ParseFloat(duration, 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0 || math.Ceil(seconds) > math.MaxUint32 {
		return invalid()
	}
	formats := strings.Split(probe.Format.Name, ",")
	has := func(name string) bool {
		for _, value := range formats {
			if value == name {
				return true
			}
		}
		return false
	}
	result := &preparedAudio{Seconds: uint32(math.Ceil(seconds))}
	switch {
	case has("ogg") && codec == "opus":
		result.Mimetype, result.VoiceCompatible = "audio/ogg; codecs=opus", true
	case has("mp3") && codec == "mp3":
		result.Mimetype = "audio/mpeg"
	case has("aac") && codec == "aac":
		result.Mimetype = "audio/aac"
	case (has("mov") || has("mp4") || has("m4a")) && codec == "aac":
		result.Mimetype = "audio/mp4"
	default:
		return nil, audioPreparationError("audio_codec_unsupported", "Este formato de audio no se puede enviar como audio sin convertirlo. Elige enviarlo como archivo adjunto.")
	}
	return result, nil
}

type boundedAudioProbeOutput struct{ buffer bytes.Buffer }

func (w *boundedAudioProbeOutput) Len() int      { return w.buffer.Len() }
func (w *boundedAudioProbeOutput) Bytes() []byte { return w.buffer.Bytes() }

func (w *boundedAudioProbeOutput) Write(data []byte) (int, error) {
	if len(data) > maxAudioProbeOutput-w.Len() {
		return 0, fmt.Errorf("audio probe output exceeded limit")
	}
	return w.buffer.Write(data)
}

type audioProbeRunner func(context.Context, string) ([]byte, error)

func runAudioProbe(ctx context.Context, input string) ([]byte, error) {
	command := exec.CommandContext(ctx, "ffprobe", "-v", "error",
		"-protocol_whitelist", "file", "-format_whitelist", "ogg,mp3,aac,mov,wav",
		"-probesize", "1048576", "-analyzeduration", "2000000", "-max_alloc", "16777216",
		"-show_entries", "stream=codec_type,codec_name,channels,duration:stream_disposition=attached_pic:format=format_name,duration",
		"-of", "json", input)
	var output boundedAudioProbeOutput
	command.Stdout, command.Stderr = &output, io.Discard
	if err := command.Run(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func prepareAudioForUpload(ctx context.Context, data []byte) (*preparedAudio, error) {
	return prepareAudioWithProbe(ctx, data, runAudioProbe)
}
func prepareAudioWithProbe(parent context.Context, data []byte, runner audioProbeRunner) (*preparedAudio, error) {
	if len(data) == 0 || int64(len(data)) > maxMediaDownloadSize {
		return nil, audioPreparationError("audio_invalid", "El archivo de audio está vacío o supera el tamaño permitido.")
	}
	ctx, cancel := context.WithTimeout(parent, audioProbeTimeout)
	defer cancel()
	if ctx.Err() != nil {
		return nil, audioPreparationError("audio_preparation_timeout", "No se pudo comprobar el audio a tiempo. Vuelve a intentarlo.")
	}
	select {
	case audioProbeSlots <- struct{}{}:
		defer func() { <-audioProbeSlots }()
	case <-ctx.Done():
		return nil, audioPreparationError("audio_preparation_timeout", "No se pudo comprobar el audio a tiempo. Vuelve a intentarlo.")
	}
	temporary, err := os.MkdirTemp("", "clarin-audio-probe-*")
	if err != nil {
		return nil, audioPreparationError("audio_processor_unavailable", "No se pudo preparar la comprobación del audio. Vuelve a intentarlo.")
	}
	defer os.RemoveAll(temporary)
	input := filepath.Join(temporary, "input.bin")
	if err = os.WriteFile(input, data, 0o600); err != nil {
		return nil, audioPreparationError("audio_processor_unavailable", "No se pudo preparar la comprobación del audio. Vuelve a intentarlo.")
	}
	raw, err := runner(ctx, input)
	if ctx.Err() != nil {
		return nil, audioPreparationError("audio_preparation_timeout", "No se pudo comprobar el audio a tiempo. Vuelve a intentarlo.")
	}
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, audioPreparationError("audio_processor_unavailable", "El comprobador de audio no está disponible. Vuelve a intentarlo.")
		}
		return nil, audioPreparationError("audio_invalid", "No se pudo validar el archivo de audio. Puedes enviarlo como archivo adjunto.")
	}
	return preparedAudioFromProbe(raw)
}

func validatePreparedAudio(media *PreUploadedMedia, ptt bool) error {
	if media == nil || media.Audio == nil || media.Audio.Mimetype == "" || media.Audio.Seconds == 0 {
		return audioPreparationError("audio_invalid", "El audio todavía no se ha comprobado. Vuelve a prepararlo.")
	}
	if ptt && !media.Audio.VoiceCompatible {
		return audioPreparationError("audio_voice_codec_unsupported", "Esta nota de voz no tiene un formato Opus compatible. Elige enviar una copia como archivo adjunto.")
	}
	return nil
}

func preparedAudioMessage(media *PreUploadedMedia, ptt bool, info *waE2E.ContextInfo) (*waE2E.AudioMessage, error) {
	if err := validatePreparedAudio(media, ptt); err != nil {
		return nil, err
	}
	return &waE2E.AudioMessage{URL: proto.String(media.URL), DirectPath: proto.String(media.DirectPath), MediaKey: media.MediaKey,
		Mimetype: proto.String(media.Audio.Mimetype), FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256,
		FileLength: proto.Uint64(media.FileLength), Seconds: proto.Uint32(media.Audio.Seconds), PTT: proto.Bool(ptt), ContextInfo: info}, nil
}
