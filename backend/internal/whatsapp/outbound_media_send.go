package whatsapp

import (
	"fmt"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

// Keep preparation failures before upload and transport failures before any
// caller can publish a successful message. This does not retry either step.
func prepareAndSendMedia(kind, caption, filename, mediaURL string,
	upload func() (*PreUploadedMedia, error),
	send func(*PreUploadedMedia) (*domain.Message, error),
) (*domain.Message, error) {
	if err := ValidateAudioCaption(kind, caption); err != nil {
		return nil, err
	}
	media, err := upload()
	if err != nil {
		return nil, err
	}
	if media == nil {
		return nil, fmt.Errorf("el archivo no está disponible")
	}
	media.OriginalFilename = mediaDisplayFilename(filename, mediaURL)
	message, err := send(media)
	if err != nil {
		return nil, err
	}
	return message, nil
}

// The normal media entry point sends attachments. Native copies use their
// separate builder, which preserves the source audio's verified PTT value.
func buildOutboundMediaMessage(caption string, media *PreUploadedMedia) (*waE2E.Message, error) {
	if media == nil {
		return nil, fmt.Errorf("el archivo no está disponible")
	}
	if err := ValidateAudioCaption(media.MediaType, caption); err != nil {
		return nil, err
	}
	var msg *waE2E.Message
	documentFilename := mediaDisplayFilename(media.OriginalFilename, media.OriginalURL)
	switch media.MediaType {
	case domain.MessageTypeImage:
		msg = &waE2E.Message{
			ImageMessage: &waE2E.ImageMessage{
				URL:           proto.String(media.URL),
				DirectPath:    proto.String(media.DirectPath),
				MediaKey:      media.MediaKey,
				Mimetype:      proto.String(media.Mimetype),
				FileEncSHA256: media.FileEncSHA256,
				FileSHA256:    media.FileSHA256,
				FileLength:    proto.Uint64(media.FileLength),
				Caption:       proto.String(caption),
			},
		}
	case domain.MessageTypeVideo, domain.MessageTypeGIF:
		msg = &waE2E.Message{
			VideoMessage: &waE2E.VideoMessage{
				URL:           proto.String(media.URL),
				DirectPath:    proto.String(media.DirectPath),
				MediaKey:      media.MediaKey,
				Mimetype:      proto.String(media.Mimetype),
				FileEncSHA256: media.FileEncSHA256,
				FileSHA256:    media.FileSHA256,
				FileLength:    proto.Uint64(media.FileLength),
				Caption:       proto.String(caption),
				GifPlayback:   proto.Bool(media.MediaType == domain.MessageTypeGIF),
			},
		}
	case domain.MessageTypeAudio:
		// This entry point sends an attached file, not a microphone recording.
		audio, err := preparedAudioMessage(media, false, nil)
		if err != nil {
			return nil, err
		}
		msg = &waE2E.Message{AudioMessage: audio}
	case domain.MessageTypeDocument:
		msg = &waE2E.Message{
			DocumentMessage: &waE2E.DocumentMessage{
				URL:           proto.String(media.URL),
				DirectPath:    proto.String(media.DirectPath),
				MediaKey:      media.MediaKey,
				Mimetype:      proto.String(media.Mimetype),
				FileEncSHA256: media.FileEncSHA256,
				FileSHA256:    media.FileSHA256,
				FileLength:    proto.Uint64(media.FileLength),
				FileName:      proto.String(documentFilename),
				Caption:       proto.String(caption),
			},
		}
	case domain.MessageTypeSticker:
		msg = &waE2E.Message{
			StickerMessage: &waE2E.StickerMessage{
				URL:           proto.String(media.URL),
				DirectPath:    proto.String(media.DirectPath),
				MediaKey:      media.MediaKey,
				Mimetype:      proto.String("image/webp"),
				IsAnimated:    proto.Bool(media.StickerAnimated),
				FileEncSHA256: media.FileEncSHA256,
				FileSHA256:    media.FileSHA256,
				FileLength:    proto.Uint64(media.FileLength),
			},
		}
	}
	if msg == nil {
		return nil, fmt.Errorf("unsupported media type: %s", media.MediaType)
	}
	return msg, nil
}
