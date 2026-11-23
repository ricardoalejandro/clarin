package whatsapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"time"

	"github.com/google/uuid"
)

const linkPreviewMaxInput = 1 << 20
const linkPreviewMaxPixels = 4_000_000
const linkPreviewMaxOutput = 128 << 10

var linkPreviewNormalizationSlots = make(chan struct{}, 2)

// Accept only the JPEG bytes embedded in the received WhatsApp message. This
// path has no URL downloader and re-encodes pixels to discard source metadata.
func normalizeReceivedLinkPreviewThumbnail(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) == 0 || len(raw) > linkPreviewMaxInput {
		return nil, fmt.Errorf("invalid preview JPEG size")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case linkPreviewNormalizationSlots <- struct{}{}:
		defer func() { <-linkPreviewNormalizationSlots }()
	default:
		return nil, fmt.Errorf("preview normalization busy")
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("invalid preview JPEG")
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > linkPreviewMaxPixels {
		return nil, fmt.Errorf("preview pixel limit exceeded")
	}
	decoded, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("invalid preview JPEG")
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	w, h := config.Width, config.Height
	if w > 512 || h > 512 {
		if w >= h {
			h = max(1, h*512/w)
			w = 512
		} else {
			w = max(1, w*512/h)
			h = 512
		}
	}
	// Area sampling gives small previews clean edges without retaining the
	// untrusted image's original dimensions or adding a decoder dependency.
	thumb := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		for x := 0; x < w; x++ {
			x0, x1 := x*config.Width/w, max(x*config.Width/w+1, (x+1)*config.Width/w)
			y0, y1 := y*config.Height/h, max(y*config.Height/h+1, (y+1)*config.Height/h)
			var r, g, b, n uint64
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					rr, gg, bb, _ := decoded.At(sx, sy).RGBA()
					r += uint64(rr)
					g += uint64(gg)
					b += uint64(bb)
					n++
				}
			}
			thumb.SetRGBA(x, y, color.RGBA{uint8(r / n >> 8), uint8(g / n >> 8), uint8(b / n >> 8), 255})
		}
	}
	for _, quality := range []int{82, 70, 55, 40, 25} {
		var out bytes.Buffer
		if err = jpeg.Encode(&out, thumb, &jpeg.Options{Quality: quality}); err != nil {
			return nil, err
		}
		if out.Len() <= linkPreviewMaxOutput {
			return out.Bytes(), nil
		}
	}
	return nil, fmt.Errorf("preview output limit exceeded")
}

func (p *DevicePool) storeReceivedLinkPreviewThumbnail(ctx context.Context, accountID uuid.UUID, raw []byte) (string, *uuid.UUID, error) {
	ctx, cancelStorage := context.WithTimeout(ctx, 3*time.Second)
	defer cancelStorage()
	if p.storage == nil || p.repos == nil {
		return "", nil, fmt.Errorf("preview storage unavailable")
	}
	jpegBytes, err := normalizeReceivedLinkPreviewThumbnail(ctx, raw)
	if err != nil {
		return "", nil, err
	}
	hash := fmt.Sprintf("link_preview:%x", sha256.Sum256(jpegBytes))
	id, key, reused, err := p.repos.MediaAsset.ReserveLinkPreviewMedia(ctx, accountID, hash, int64(len(jpegBytes)))
	if err != nil {
		return "", nil, err
	}
	if !reused {
		_, uploadErr := p.storage.UploadObject(ctx, key, jpegBytes, "image/jpeg")
		// A cancelled provider callback must not discard its durable orphan record.
		finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		err = p.repos.MediaAsset.CompleteLinkPreviewMedia(finishCtx, accountID, id, key, uploadErr == nil)
		cancel()
		if uploadErr != nil {
			return "", nil, uploadErr
		}
		if err != nil {
			return "", nil, err
		}
	}
	return "/api/media/file/" + key, &id, nil
}
