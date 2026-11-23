package whatsapp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math"
	"os"
	"sync"
	"testing"

	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/util/cbcutil"
	"google.golang.org/protobuf/proto"
)

type groupMediaDownloadFunc func(context.Context, whatsmeow.DownloadableMessage, whatsmeow.File) error

func (f groupMediaDownloadFunc) DownloadToFile(ctx context.Context, msg whatsmeow.DownloadableMessage, file whatsmeow.File) error {
	return f(ctx, msg, file)
}

func TestBoundedGroupMediaFileRejectsEveryExpansionPath(t *testing.T) {
	for name, expand := range map[string]func(*boundedGroupMediaFile) error{
		"write":        func(f *boundedGroupMediaFile) error { _, err := f.Write(make([]byte, 9)); return err },
		"write_at":     func(f *boundedGroupMediaFile) error { _, err := f.WriteAt([]byte{1}, 8); return err },
		"sparse_write": func(f *boundedGroupMediaFile) error { _, err := f.WriteAt([]byte{1}, math.MaxInt64); return err },
		"truncate":     func(f *boundedGroupMediaFile) error { return f.Truncate(9) },
		"seek":         func(f *boundedGroupMediaFile) error { _, err := f.Seek(math.MaxInt64, io.SeekStart); return err },
	} {
		t.Run(name, func(t *testing.T) {
			file, err := os.CreateTemp(t.TempDir(), "bound-*")
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			bounded := &boundedGroupMediaFile{file: file, max: 8, cancel: cancel}
			err = expand(bounded)
			if !errors.Is(err, errGroupMediaTooLarge) || !errors.Is(err, context.Canceled) || ctx.Err() == nil || !bounded.exceeded.Load() {
				t.Fatalf("limit must abort provider host retries: %v", err)
			}
			info, _ := file.Stat()
			if info.Size() > 8 {
				t.Fatal("file exceeded hard byte limit")
			}
			if _, ok := any(bounded).(io.ReaderFrom); ok {
				t.Fatal("ReadFrom bypasses Write bound")
			}
			if _, ok := any(bounded).(io.WriterTo); ok {
				t.Fatal("unexpected promoted file fast path")
			}
		})
	}
}

func TestBoundedGroupMediaFileSupportsInPlaceDecryption(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "decrypt-*")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	bounded := &boundedGroupMediaFile{file: file, max: 16, cancel: cancel}
	if _, err = bounded.Write([]byte("0123456789abcdef")); err != nil {
		t.Fatal(err)
	}
	if _, err = bounded.WriteAt([]byte("ABC"), 0); err != nil {
		t.Fatal(err)
	}
	if err = bounded.Truncate(10); err != nil {
		t.Fatal(err)
	}
	if _, err = bounded.Seek(-10, io.SeekEnd); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(bounded)
	if err != nil || string(data) != "ABC3456789" {
		t.Fatal("in-place plaintext changed", err)
	}
	if _, err = bounded.WriteAt([]byte{1}, -1); !errors.Is(err, os.ErrInvalid) {
		t.Fatal("negative offset accepted")
	}
	if _, err = bounded.Seek(math.MaxInt64, io.SeekCurrent); !errors.Is(err, errGroupMediaTooLarge) {
		t.Fatal("seek overflow accepted")
	}
}

func TestGroupMediaDownloadBoundsDeclaredAndActualBytes(t *testing.T) {
	const limit int64 = 16
	tests := []struct {
		name      string
		declared  uint64
		actual    int
		decryptTo int64
		wantLarge bool
		wantCalls int
	}{
		{"declared_oversized_no_download", 17, 0, -1, true, 0},
		{"declared_uint_overflow", math.MaxUint64, 0, -1, true, 0},
		{"known_size", 16, 16, -1, false, 1},
		{"unknown_size", 0, 16, -1, false, 1},
		{"unknown_plaintext_over_limit", 0, 17, -1, true, 1},
		{"lying_declared_over_stream_bound", 1, 43, -1, true, 1},
		{"unknown_over_stream_bound", 0, 43, -1, true, 1},
		{"bounded_cipher_padding_and_mac", 16, 42, 16, false, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			directory := t.TempDir()
			calls := 0
			client := groupMediaDownloadFunc(func(ctx context.Context, msg whatsmeow.DownloadableMessage, file whatsmeow.File) error {
				calls++
				_, err := file.Write(bytes.Repeat([]byte{'x'}, tc.actual))
				if err != nil {
					if ctx.Err() == nil {
						t.Error("oversize did not cancel the HTTP context")
					}
					return err
				}
				if tc.decryptTo >= 0 {
					return file.Truncate(tc.decryptTo)
				}
				return nil
			})
			message := &waE2E.DocumentMessage{FileLength: proto.Uint64(tc.declared)}
			data, err := downloadGroupMediaLimited(context.Background(), client, message, limit, directory)
			if errors.Is(err, errGroupMediaTooLarge) != tc.wantLarge || (err != nil && !tc.wantLarge) || calls != tc.wantCalls {
				t.Fatalf("data=%d calls=%d err=%v", len(data), calls, err)
			}
			if !tc.wantLarge && len(data) != int(limit) {
				t.Fatal("valid plaintext was truncated")
			}
			files, readErr := os.ReadDir(directory)
			if readErr != nil || len(files) != 0 {
				t.Fatal("temporary download survived", readErr)
			}
		})
	}
}

func TestGroupMediaFileSupportsCurrentWhatsmeowCBC(t *testing.T) {
	plaintext := []byte("0123456789abcdef") // Full block requires 16 padding bytes.
	key, iv := make([]byte, 32), make([]byte, 16)
	ciphertext, err := cbcutil.Encrypt(key, iv, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	file, err := os.CreateTemp(t.TempDir(), "real-cbc-*")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	bounded := &boundedGroupMediaFile{file: file, max: int64(len(plaintext)) + groupMediaCipherOverhead, cancel: cancel}
	if _, err = bounded.Write(append(ciphertext, make([]byte, 10)...)); err != nil {
		t.Fatal(err)
	}
	mac := make([]byte, 10)
	if _, err = bounded.ReadAt(mac, int64(len(ciphertext))); err != nil {
		t.Fatal(err)
	}
	if err = bounded.Truncate(int64(len(ciphertext))); err != nil {
		t.Fatal(err)
	}
	if _, err = bounded.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if err = cbcutil.DecryptFile(key, iv, bounded); err != nil {
		t.Fatal("current upstream CBC cannot use bounded file", err)
	}
	if _, err = bounded.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	actual, err := io.ReadAll(bounded)
	if err != nil || !bytes.Equal(actual, plaintext) || bounded.exceeded.Load() {
		t.Fatal("full-block plaintext failed at exact ciphertext bound", err)
	}
}

func TestGroupMediaDownloadCancellationAndFailureCleanTemporary(t *testing.T) {
	for _, alreadyCanceled := range []bool{false, true} {
		directory := t.TempDir()
		ctx, cancel := context.WithCancel(context.Background())
		if alreadyCanceled {
			cancel()
		}
		calls := 0
		client := groupMediaDownloadFunc(func(ctx context.Context, msg whatsmeow.DownloadableMessage, file whatsmeow.File) error {
			calls++
			_, _ = file.Write([]byte("partial"))
			cancel()
			return ctx.Err()
		})
		_, err := downloadGroupMediaLimited(ctx, client, &waE2E.ImageMessage{}, 16, directory)
		cancel()
		if !errors.Is(err, context.Canceled) || (alreadyCanceled && calls != 0) {
			t.Fatal("cancellation ignored", err)
		}
		files, _ := os.ReadDir(directory)
		if len(files) != 0 {
			t.Fatal("canceled download leaked a temporary")
		}
	}
}

func TestGroupMediaSlotsBoundConcurrentDevicesWithoutQueue(t *testing.T) {
	slots := make(chan struct{}, 2)
	start, finish := make(chan struct{}), make(chan struct{})
	attempts := make(chan bool, 8)
	var workers sync.WaitGroup
	for range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			release, err := acquireGroupMediaSlot(context.Background(), slots)
			attempts <- err == nil
			if err == nil {
				<-finish
				release()
			} else if !errors.Is(err, errGroupMediaBusy) {
				t.Error(err)
			}
		}()
	}
	close(start)
	accepted := 0
	for range 8 {
		if <-attempts {
			accepted++
		}
	}
	if accepted != 2 || len(slots) != 2 {
		t.Fatal("global capacity was exceeded or queued")
	}
	close(finish)
	workers.Wait()
	if len(slots) != 0 {
		t.Fatal("slot leaked")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := acquireGroupMediaSlot(ctx, slots); !errors.Is(err, context.Canceled) || len(slots) != 0 {
		t.Fatal("canceled work acquired a slot")
	}
}

func TestGroupMediaLimitRetainsCaptionAndMetadata(t *testing.T) {
	pool := &DevicePool{}
	document := &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{FileName: proto.String("large.pdf"), Caption: proto.String("Original caption"), Mimetype: proto.String("application/pdf"), FileLength: proto.Uint64(uint64(groupMediaMaxBytes) + 1)}}
	wrapped := &waE2E.Message{DocumentWithCaptionMessage: &waE2E.FutureProofMessage{Message: document}}
	content, err := pool.extractGroupMessageContent(context.Background(), nil, wrapped, "123@g.us", "large", false)
	if !errors.Is(err, errGroupMediaTooLarge) || content.MediaUnavailableReason != groupMediaTooLargeReason || content.Body != "Original caption" || content.MediaFilename == nil || *content.MediaFilename != "large.pdf" || content.MessageType != domain.MessageTypeDocument || content.MediaSize == nil || *content.MediaSize != groupMediaMaxBytes+1 || content.MediaURL != nil {
		t.Fatal("oversized document lost metadata or was made downloadable")
	}
	document.DocumentMessage.FileLength = proto.Uint64(0)
	metadata, err := pool.extractGroupMessageContent(context.Background(), nil, wrapped, "123@g.us", "unknown", false)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := applyGroupMediaDownloadResult(metadata, nil, errGroupMediaTooLarge)
	if !errors.Is(err, errGroupMediaTooLarge) || actual.MediaUnavailableReason != groupMediaTooLargeReason || actual.Body != metadata.Body || actual.MediaFilename != metadata.MediaFilename || actual.MediaURL != nil {
		t.Fatal("actual-byte limit lost metadata or failed to become permanent")
	}
	busy, err := applyGroupMediaDownloadResult(metadata, nil, errGroupMediaBusy)
	if !errors.Is(err, errGroupMediaBusy) || busy.MediaUnavailableReason != "" || busy.Body != metadata.Body {
		t.Fatal("capacity deferral became a permanent rejection")
	}
	viewOnce := &waE2E.Message{ViewOnceMessageV2Extension: &waE2E.FutureProofMessage{Message: document}}
	private, err := pool.extractGroupMessageContent(context.Background(), nil, viewOnce, "123@g.us", "private", false)
	if err != nil || !private.IsViewOnce || private.MediaURL != nil || private.Body != "Original caption" {
		t.Fatal("view-once media was lost or reopened")
	}
}
