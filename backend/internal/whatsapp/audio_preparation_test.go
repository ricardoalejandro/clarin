package whatsapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"google.golang.org/protobuf/proto"
)

func audioProbeFixture(format, codec, duration string) []byte {
	return []byte(fmt.Sprintf(`{"streams":[{"codec_type":"audio","codec_name":%q,"channels":1,"duration":%q}],"format":{"format_name":%q,"duration":%q}}`, codec, duration, format, duration))
}
func requireAudioCode(t *testing.T, err error, want string) {
	t.Helper()
	var typed *AudioPreparationError
	if !errors.As(err, &typed) || typed.Code != want {
		t.Fatalf("audio error=%v, want %s", err, want)
	}
}
func TestAudioProbeMetadataUsesCodecAndContainer(t *testing.T) {
	for _, item := range []struct {
		format, codec, mime string
		voice               bool
	}{
		{"ogg", "opus", "audio/ogg; codecs=opus", true}, {"mp3", "mp3", "audio/mpeg", false},
		{"aac", "aac", "audio/aac", false}, {"mov,mp4,m4a,3gp,3g2,mj2", "aac", "audio/mp4", false},
	} {
		info, err := preparedAudioFromProbe(audioProbeFixture(item.format, item.codec, "1.02"))
		if err != nil || info.Mimetype != item.mime || info.VoiceCompatible != item.voice || info.Seconds != 2 {
			t.Fatalf("%s/%s: %+v %v", item.format, item.codec, info, err)
		}
	}
	for _, item := range []struct{ format, codec string }{{"ogg", "vorbis"}, {"wav", "pcm_s16le"}, {"ogg", "aac"}, {"mp3", "opus"}, {"matroska,webm", "opus"}, {"mov,mp4,m4a", "alac"}} {
		_, err := preparedAudioFromProbe(audioProbeFixture(item.format, item.codec, "1"))
		requireAudioCode(t, err, "audio_codec_unsupported")
	}
	for _, duration := range []string{"", "0", "-1", "NaN", "+Inf", "4294967296", "not-duration"} {
		_, err := preparedAudioFromProbe(audioProbeFixture("ogg", "opus", duration))
		requireAudioCode(t, err, "audio_invalid")
	}
	for _, raw := range [][]byte{nil, []byte("bad-json"), []byte(`{"streams":[],"format":{"format_name":"ogg"}}`), []byte(strings.Repeat("x", maxAudioProbeOutput+1))} {
		_, err := preparedAudioFromProbe(raw)
		requireAudioCode(t, err, "audio_invalid")
	}
	// A real cover image is valid album art, not a second user video stream.
	cover := []byte(`{"streams":[{"codec_type":"audio","codec_name":"mp3","channels":2},{"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}}],"format":{"format_name":"mp3","duration":"3.1"}}`)
	if info, err := preparedAudioFromProbe(cover); err != nil || info.Seconds != 4 {
		t.Fatal("cover art rejected", err)
	}
	_, err := preparedAudioFromProbe(bytes.Replace(cover, []byte(`"attached_pic":1`), []byte(`"attached_pic":0`), 1))
	requireAudioCode(t, err, "audio_invalid")
	two := bytes.Replace(audioProbeFixture("ogg", "opus", "1"), []byte(`"streams":[`), []byte(`"streams":[{"codec_type":"audio","codec_name":"opus","channels":1},`), 1)
	_, err = preparedAudioFromProbe(two)
	requireAudioCode(t, err, "audio_invalid")
}

func TestAudioProbeOwnsTemporaryFileAndBoundsPreparation(t *testing.T) {
	data := []byte("synthetic unchanged bytes")
	before := sha256.Sum256(data)
	var input string
	info, err := prepareAudioWithProbe(context.Background(), data, func(ctx context.Context, path string) ([]byte, error) {
		input = path
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > audioProbeTimeout {
			t.Fatal("probe lacks deadline")
		}
		actual, readErr := os.ReadFile(path)
		if readErr != nil || !bytes.Equal(actual, data) {
			t.Fatal("source bytes changed", readErr)
		}
		stat, statErr := os.Stat(path)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if runtime.GOOS != "windows" && stat.Mode().Perm() != 0o600 {
			t.Fatal("temporary audio is not private")
		}
		return audioProbeFixture("ogg", "opus", "1"), nil
	})
	if err != nil || info.Mimetype != "audio/ogg; codecs=opus" || sha256.Sum256(data) != before {
		t.Fatal("preparation mutated source", err)
	}
	if _, err = os.Stat(input); !os.IsNotExist(err) {
		t.Fatal("temporary file survived", err)
	}
	if _, err = os.Stat(filepath.Dir(input)); !os.IsNotExist(err) {
		t.Fatal("temporary directory survived", err)
	}
	for _, item := range []struct {
		failure error
		code    string
	}{{errors.New("private process details"), "audio_invalid"}, {exec.ErrNotFound, "audio_processor_unavailable"}} {
		_, err = prepareAudioWithProbe(context.Background(), data, func(_ context.Context, path string) ([]byte, error) { input = path; return nil, item.failure })
		requireAudioCode(t, err, item.code)
		if strings.Contains(err.Error(), "private process details") {
			t.Fatal("process output leaked")
		}
		if _, statErr := os.Stat(input); !os.IsNotExist(statErr) {
			t.Fatal("failure leaked temporary audio")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err = prepareAudioWithProbe(ctx, data, func(ctx context.Context, _ string) ([]byte, error) { <-ctx.Done(); return nil, ctx.Err() })
	requireAudioCode(t, err, "audio_preparation_timeout")
	// The same deadline bounds waiting for one of the two process slots.
	audioProbeSlots <- struct{}{}
	audioProbeSlots <- struct{}{}
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Millisecond)
	_, err = prepareAudioWithProbe(ctx, data, func(context.Context, string) ([]byte, error) { t.Fatal("runner bypassed slot limit"); return nil, nil })
	cancel()
	<-audioProbeSlots
	<-audioProbeSlots
	requireAudioCode(t, err, "audio_preparation_timeout")
	var output boundedAudioProbeOutput
	if _, bypass := any(&output).(io.ReaderFrom); bypass {
		t.Fatal("io.Copy can bypass the output bound")
	}
	if n, err := output.Write(make([]byte, maxAudioProbeOutput)); err != nil || n != maxAudioProbeOutput {
		t.Fatal("exact output bound rejected")
	}
	if _, err := output.Write([]byte("x")); err == nil || output.Len() != maxAudioProbeOutput {
		t.Fatal("unbounded probe output")
	}
}

func TestAudioEnvelopeAttachmentAndSharingPreserveTruth(t *testing.T) {
	media := &PreUploadedMedia{URL: "https://test.invalid/upload", DirectPath: "/fresh", MediaKey: []byte{1}, FileSHA256: []byte{2}, FileEncSHA256: []byte{3}, FileLength: 42, Audio: &preparedAudio{Mimetype: "audio/ogg; codecs=opus", Seconds: 3, VoiceCompatible: true}}
	normal, err := preparedAudioMessage(media, false, nil)
	if err != nil || normal.GetPTT() || normal.PTT == nil || normal.GetMimetype() != media.Audio.Mimetype || normal.GetSeconds() != 3 || normal.GetFileLength() != 42 {
		t.Fatal("normal attachment became a voice note", err)
	}
	source := &domain.Message{ID: uuid.New(), ChatID: uuid.New(), DeviceID: protoUUID(uuid.New()), MessageType: proto.String(domain.MessageTypeAudio), MediaMimetype: proto.String("audio/ogg"), Forwarding: originalForwarding()}
	for _, ptt := range []bool{false, true} {
		for _, mode := range []string{domain.MessageSharingCopy, domain.MessageSharingNative} {
			source.AudioPTT = proto.Bool(ptt)
			fingerprint := domain.MessageForwardFingerprint(source)
			raw, forwarding, err := buildSharedMessage(source, media, mode, domain.MessageContentOriginal)
			if err != nil || raw.GetAudioMessage().GetPTT() != ptt || raw.GetAudioMessage().GetMimetype() != media.Audio.Mimetype || raw.GetAudioMessage().GetSeconds() != 3 || raw.Conversation != nil || raw.ExtendedTextMessage != nil {
				t.Fatal("sharing changed audio semantics", ptt, mode, err)
			}
			limits := sharedOutputLimits(source, forwarding)
			output := sharedMessageForPersistence(&DeviceInstance{ID: uuid.New(), AccountID: uuid.New()}, &domain.Chat{ID: uuid.New()}, source, media, "reserved", time.Now(), forwarding, domain.MessageContentOriginal, limits)
			if output.AudioPTT == nil || *output.AudioPTT != ptt || *output.MediaMimetype != media.Audio.Mimetype || domain.MessageForwardFingerprint(source) != fingerprint || *source.MediaMimetype != "audio/ogg" {
				t.Fatal("output rewrote history or contradicted envelope")
			}
		}
	}
	media.Audio = &preparedAudio{Mimetype: "audio/mpeg", Seconds: 3}
	source.AudioPTT = proto.Bool(true)
	_, _, err = buildSharedMessage(source, media, domain.MessageSharingCopy, domain.MessageContentOriginal)
	requireAudioCode(t, err, "audio_voice_codec_unsupported")
	if raw, _, err := buildSharedMessage(source, media, domain.MessageSharingCopy, domain.MessageContentAudioDocument); err != nil || raw.GetDocumentMessage() == nil {
		t.Fatal("explicit document fallback blocked", err)
	}
	source.Body = proto.String("Retained legacy caption")
	for _, mode := range []string{domain.MessageSharingCopy, domain.MessageSharingNative} {
		_, _, err = buildSharedMessage(source, media, mode, domain.MessageContentOriginal)
		requireAudioCode(t, err, "audio_caption_unsupported")
	}
	raw, _, err := buildSharedMessage(source, media, domain.MessageSharingCopy, domain.MessageContentAudioDocument)
	if err != nil || raw.GetDocumentMessage().GetCaption() != *source.Body {
		t.Fatal("explicit document lost caption", err)
	}
}
func protoUUID(id uuid.UUID) *uuid.UUID { return &id }

func TestPrepareAndSendMediaDoesNotClaimFailedUploadsOrRPCs(t *testing.T) {
	uploadCalls, sendCalls := 0, 0
	uploadErr, rpcErr := errors.New("synthetic upload failure"), errors.New("synthetic RPC failure")
	upload := func() (*PreUploadedMedia, error) {
		uploadCalls++
		return &PreUploadedMedia{MediaType: domain.MessageTypeAudio}, nil
	}
	send := func(*PreUploadedMedia) (*domain.Message, error) {
		sendCalls++
		return &domain.Message{Status: proto.String("sent")}, nil
	}
	if message, err := prepareAndSendMedia("audio", "Retain text", "qa.ogg", "/private", upload, send); err == nil || message != nil || uploadCalls != 0 || sendCalls != 0 {
		t.Fatal("caption reached upload/transport")
	}
	message, err := prepareAndSendMedia("audio", "", "qa.ogg", "/private", func() (*PreUploadedMedia, error) { uploadCalls++; return nil, uploadErr }, send)
	if !errors.Is(err, uploadErr) || message != nil || sendCalls != 0 {
		t.Fatal("upload failure became successful or text-only send")
	}
	message, err = prepareAndSendMedia("audio", "", "qa.ogg", "/private", upload, func(*PreUploadedMedia) (*domain.Message, error) {
		sendCalls++
		return &domain.Message{Status: proto.String("sent")}, rpcErr
	})
	if !errors.Is(err, rpcErr) || message != nil || sendCalls != 1 {
		t.Fatal("RPC failure returned a successful message")
	}
	for _, kind := range []string{"image", "video", "gif", "document", "sticker"} {
		caption, filename := "Caption preserved", "visible-name.bin"
		message, err = prepareAndSendMedia(kind, caption, filename, "/private", func() (*PreUploadedMedia, error) { return &PreUploadedMedia{MediaType: kind}, nil }, func(media *PreUploadedMedia) (*domain.Message, error) {
			if media.MediaType != kind || media.OriginalFilename != filename {
				t.Fatal("another media type changed")
			}
			return &domain.Message{Body: &caption, MessageType: &kind}, nil
		})
		if err != nil || *message.Body != caption || *message.MessageType != kind {
			t.Fatal("other media behavior regressed", kind, err)
		}
	}
}

func TestOutboundMediaBuilderPreservesOtherAttachmentKinds(t *testing.T) {
	for _, kind := range []string{domain.MessageTypeImage, domain.MessageTypeVideo, domain.MessageTypeGIF, domain.MessageTypeDocument, domain.MessageTypeSticker} {
		media := &PreUploadedMedia{MediaType: kind, URL: "https://test.invalid/upload", DirectPath: "/encrypted", MediaKey: []byte{1}, FileSHA256: []byte{2}, FileEncSHA256: []byte{3}, FileLength: 42, Mimetype: "synthetic/mime", OriginalFilename: "original visible.pdf", OriginalURL: "/api/media/file/source", StickerAnimated: true}
		raw, err := buildOutboundMediaMessage("Visible caption", media)
		if err != nil || raw.GetAudioMessage() != nil || raw.Conversation != nil || raw.ExtendedTextMessage != nil {
			t.Fatal("wrong payload kind", kind, err)
		}
		switch kind {
		case domain.MessageTypeImage:
			m := raw.GetImageMessage()
			if m == nil || m.GetCaption() != "Visible caption" || m.GetMimetype() != media.Mimetype || m.GetURL() != media.URL || m.GetDirectPath() != media.DirectPath || m.GetFileLength() != 42 || !bytes.Equal(m.MediaKey, media.MediaKey) {
				t.Fatal("image envelope changed")
			}
		case domain.MessageTypeVideo, domain.MessageTypeGIF:
			m := raw.GetVideoMessage()
			if m == nil || m.GetCaption() != "Visible caption" || m.GetGifPlayback() != (kind == domain.MessageTypeGIF) || m.GetMimetype() != media.Mimetype || m.GetFileLength() != 42 || !bytes.Equal(m.FileSHA256, media.FileSHA256) {
				t.Fatal("video/GIF envelope changed")
			}
		case domain.MessageTypeDocument:
			m := raw.GetDocumentMessage()
			if m == nil || m.GetCaption() != "Visible caption" || m.GetFileName() != media.OriginalFilename || m.GetMimetype() != media.Mimetype || m.GetFileLength() != 42 || !bytes.Equal(m.FileEncSHA256, media.FileEncSHA256) {
				t.Fatal("document envelope changed")
			}
		case domain.MessageTypeSticker:
			m := raw.GetStickerMessage()
			if m == nil || m.GetMimetype() != "image/webp" || !m.GetIsAnimated() || m.GetFileLength() != 42 {
				t.Fatal("sticker envelope changed")
			}
		}
	}
	media := &PreUploadedMedia{MediaType: domain.MessageTypeAudio, Audio: &preparedAudio{Mimetype: "audio/ogg; codecs=opus", Seconds: 2, VoiceCompatible: true}}
	raw, err := buildOutboundMediaMessage("", media)
	if err != nil || raw.GetAudioMessage() == nil || raw.GetAudioMessage().GetPTT() || raw.GetAudioMessage().GetSeconds() != 2 || raw.GetAudioMessage().GetMimetype() != "audio/ogg; codecs=opus" {
		t.Fatal("normal attachment is not a verified file", err)
	}
	if _, err = buildOutboundMediaMessage("Local-only caption", media); err == nil {
		t.Fatal("normal audio silently dropped caption")
	}
	if _, err = buildOutboundMediaMessage("", &PreUploadedMedia{MediaType: "unknown"}); err == nil {
		t.Fatal("unknown media became text")
	}
}
