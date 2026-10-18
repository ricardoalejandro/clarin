package whatsapp

import (
	"context"
	"crypto/aes"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sync/atomic"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
)

const groupMediaMaxBytes int64 = 64 << 20

// WhatsApp encrypts with PKCS#7 (at most one AES block) and appends a 10-byte MAC.
const groupMediaCipherOverhead int64 = aes.BlockSize + 10

const groupMediaTooLargeReason = "group_media_too_large"

var (
	errGroupMediaTooLarge = errors.New("este archivo supera el límite de 64 MiB de Clarin; ábrelo en WhatsApp")
	errGroupMediaBusy     = errors.New("ya hay archivos recuperándose; vuelve a intentarlo")
)

type groupMediaDownloader interface {
	DownloadToFile(context.Context, whatsmeow.DownloadableMessage, whatsmeow.File) error
}

// No embedded *os.File: promoted ReadFrom/WriteTo methods could bypass the bound,
// and upstream must not preallocate an untrusted HTTP Content-Length.
type boundedGroupMediaFile struct {
	file     *os.File
	max      int64
	cancel   context.CancelFunc
	exceeded atomic.Bool
}

var _ whatsmeow.File = (*boundedGroupMediaFile)(nil)

func (f *boundedGroupMediaFile) limitError() error {
	f.exceeded.Store(true)
	f.cancel()
	// The upstream host fallback also stops on context.Canceled.
	return errors.Join(errGroupMediaTooLarge, context.Canceled)
}

func (f *boundedGroupMediaFile) writable(offset int64, length int) error {
	if offset < 0 {
		return os.ErrInvalid
	}
	if offset > f.max || int64(length) > f.max-offset {
		return f.limitError()
	}
	return nil
}

func (f *boundedGroupMediaFile) Write(data []byte) (int, error) {
	offset, err := f.file.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	if err = f.writable(offset, len(data)); err != nil {
		return 0, err
	}
	return f.file.Write(data)
}

func (f *boundedGroupMediaFile) WriteAt(data []byte, offset int64) (int, error) {
	if err := f.writable(offset, len(data)); err != nil {
		return 0, err
	}
	return f.file.WriteAt(data, offset)
}

func (f *boundedGroupMediaFile) Read(data []byte) (int, error) { return f.file.Read(data) }
func (f *boundedGroupMediaFile) ReadAt(data []byte, offset int64) (int, error) {
	return f.file.ReadAt(data, offset)
}
func (f *boundedGroupMediaFile) Stat() (os.FileInfo, error) { return f.file.Stat() }

func (f *boundedGroupMediaFile) Seek(offset int64, whence int) (int64, error) {
	var base int64
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		var err error
		base, err = f.file.Seek(0, io.SeekCurrent)
		if err != nil {
			return 0, err
		}
	case io.SeekEnd:
		info, err := f.file.Stat()
		if err != nil {
			return 0, err
		}
		base = info.Size()
	default:
		return 0, os.ErrInvalid
	}
	if offset < -base {
		return 0, os.ErrInvalid
	}
	if base > f.max || offset > f.max-base {
		return 0, f.limitError()
	}
	return f.file.Seek(base+offset, io.SeekStart)
}

func (f *boundedGroupMediaFile) Truncate(size int64) error {
	if size < 0 {
		return os.ErrInvalid
	}
	if size > f.max {
		return f.limitError()
	}
	return f.file.Truncate(size)
}

func groupDeclaredMediaSize(message whatsmeow.DownloadableMessage) uint64 {
	if sized, ok := message.(interface{ GetFileLength() uint64 }); ok {
		return sized.GetFileLength()
	}
	return 0
}

func acquireGroupMediaSlot(ctx context.Context, slots chan struct{}) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case slots <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-slots
			return nil, err
		}
		return func() { <-slots }, nil
	default:
		return nil, errGroupMediaBusy
	}
}

func downloadGroupMedia(ctx context.Context, client groupMediaDownloader, message whatsmeow.DownloadableMessage) ([]byte, error) {
	return downloadGroupMediaLimited(ctx, client, message, groupMediaMaxBytes, "")
}

func downloadGroupMediaLimited(ctx context.Context, client groupMediaDownloader, message whatsmeow.DownloadableMessage, maxPlaintext int64, tempDirectory string) ([]byte, error) {
	if maxPlaintext <= 0 || maxPlaintext > groupMediaMaxBytes {
		return nil, fmt.Errorf("invalid group media bound")
	}
	if groupDeclaredMediaSize(message) > uint64(maxPlaintext) {
		return nil, errGroupMediaTooLarge
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(tempDirectory, "clarin-group-media-*")
	if err != nil {
		return nil, fmt.Errorf("prepare group media: %w", err)
	}
	defer func() {
		_ = file.Close()
		_ = os.Remove(file.Name())
	}()
	downloadCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	bounded := &boundedGroupMediaFile{file: file, max: maxPlaintext + groupMediaCipherOverhead, cancel: cancel}
	err = client.DownloadToFile(downloadCtx, message, bounded)
	if bounded.exceeded.Load() {
		return nil, errGroupMediaTooLarge
	}
	if err != nil {
		return nil, err
	}
	if err = downloadCtx.Err(); err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	// DownloadToFile has already verified the provider hashes/MAC and decrypted.
	// Only this bounded, validated plaintext is loaded for existing storage APIs.
	if info.Size() > maxPlaintext {
		return nil, errGroupMediaTooLarge
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	data := make([]byte, int(info.Size()))
	if _, err = io.ReadFull(file, data); err != nil {
		return nil, err
	}
	return data, nil
}

func unwrapGroupMedia(message *waE2E.Message) (*waE2E.Message, bool) {
	viewOnce := false
	for depth := 0; message != nil && depth < 8; depth++ {
		switch {
		case message.EphemeralMessage != nil:
			message = message.EphemeralMessage.Message
		case message.DocumentWithCaptionMessage != nil:
			message = message.DocumentWithCaptionMessage.Message
		case message.ViewOnceMessage != nil:
			viewOnce, message = true, message.ViewOnceMessage.Message
		case message.ViewOnceMessageV2 != nil:
			viewOnce, message = true, message.ViewOnceMessageV2.Message
		case message.ViewOnceMessageV2Extension != nil:
			viewOnce, message = true, message.ViewOnceMessageV2Extension.Message
		default:
			return message, viewOnce
		}
	}
	return nil, viewOnce
}

// Group media errors never discard message text, captions, identity or metadata.
// The direct/status extractor and download behavior remain unchanged.
func (p *DevicePool) extractGroupMessageContent(ctx context.Context, instance *DeviceInstance, message *waE2E.Message, chatJID, messageID string, viewOnce bool) (messageContentResult, error) {
	message, wrappedViewOnce := unwrapGroupMedia(message)
	content := p.extractMessageContent(ctx, nil, message, chatJID, messageID)
	content.IsViewOnce = viewOnce || wrappedViewOnce
	var media whatsmeow.DownloadableMessage
	extension := ""
	switch {
	case message == nil:
		return content, nil
	case message.ImageMessage != nil:
		media, extension = message.ImageMessage, ".jpg"
	case message.VideoMessage != nil:
		media, extension = message.VideoMessage, ".mp4"
	case message.AudioMessage != nil:
		media, extension = message.AudioMessage, ".ogg"
	case message.DocumentMessage != nil:
		media, extension = message.DocumentMessage, filepath.Ext(message.DocumentMessage.GetFileName())
		if extension == "" {
			extension = ".bin"
		}
		if caption := message.DocumentMessage.GetCaption(); caption != "" {
			content.Body = caption
		}
	case message.StickerMessage != nil:
		media, extension = message.StickerMessage, ".webp"
	default:
		return content, nil
	}
	size := groupDeclaredMediaSize(media)
	if size <= math.MaxInt64 {
		value := int64(size)
		content.MediaSize = &value
	} else {
		content.MediaSize = nil
	}
	if content.IsViewOnce {
		return content, nil
	}
	if size > uint64(groupMediaMaxBytes) {
		content.MediaUnavailableReason = groupMediaTooLargeReason
		return content, errGroupMediaTooLarge
	}
	if instance == nil || p.storage == nil {
		return content, nil
	}
	mimetype := ""
	if content.MediaMimetype != nil {
		mimetype = *content.MediaMimetype
	}
	stored, err := p.downloadAndStoreMedia(ctx, instance, media, chatJID, messageID, mimetype, extension)
	return applyGroupMediaDownloadResult(content, stored, err)
}

func applyGroupMediaDownloadResult(content messageContentResult, stored *storedMediaResult, err error) (messageContentResult, error) {
	if err != nil {
		if errors.Is(err, errGroupMediaTooLarge) {
			content.MediaUnavailableReason = groupMediaTooLargeReason
		}
		return content, err
	}
	if stored == nil {
		return content, fmt.Errorf("archivo no disponible")
	}
	content.MediaURL, content.MediaAssetID, content.MediaSize = &stored.URL, stored.AssetID, &stored.SizeBytes
	return content, nil
}
