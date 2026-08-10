package whiteboard

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/storage"
)

const (
	MaxAssetBytes      = int64(10 * 1024 * 1024)
	MaxAssetDimension  = 16_384
	MaxAssetPixelCount = int64(64_000_000)
)

var (
	ErrInvalidAsset    = errors.New("invalid whiteboard asset")
	whiteboardFileIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,255}$`)
)

type NormalizedAsset struct {
	ContentType string
	Extension   string
	Hash        string
	Size        int64
}

// NormalizeAsset accepts only raster formats that browsers can render without
// executing embedded markup. SVG is intentionally excluded from stored image
// assets; SVG export remains available as a generated download.
func NormalizeAsset(claimedType string, data []byte) (NormalizedAsset, error) {
	if len(data) == 0 || int64(len(data)) > MaxAssetBytes {
		return NormalizedAsset{}, ErrInvalidAsset
	}
	detected := strings.ToLower(strings.TrimSpace(strings.SplitN(http.DetectContentType(data), ";", 2)[0]))
	claimed := strings.ToLower(strings.TrimSpace(strings.SplitN(claimedType, ";", 2)[0]))
	extension := ""
	switch detected {
	case "image/png":
		extension = ".png"
	case "image/jpeg":
		extension = ".jpg"
	case "image/gif":
		extension = ".gif"
	case "image/webp":
		extension = ".webp"
	default:
		return NormalizedAsset{}, ErrInvalidAsset
	}
	if claimed != "" && claimed != "application/octet-stream" && claimed != detected {
		return NormalizedAsset{}, ErrInvalidAsset
	}
	width, height, err := rasterDimensions(detected, data)
	if err != nil || width <= 0 || height <= 0 || width > MaxAssetDimension || height > MaxAssetDimension || int64(width)*int64(height) > MaxAssetPixelCount {
		return NormalizedAsset{}, ErrInvalidAsset
	}
	digest := sha256.Sum256(data)
	return NormalizedAsset{
		ContentType: detected,
		Extension:   extension,
		Hash:        hex.EncodeToString(digest[:]),
		Size:        int64(len(data)),
	}, nil
}

func rasterDimensions(contentType string, data []byte) (int, int, error) {
	if contentType != "image/webp" {
		config, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			return 0, 0, err
		}
		expected := map[string]string{"image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif"}[contentType]
		if expected == "" || format != expected {
			return 0, 0, ErrInvalidAsset
		}
		return config.Width, config.Height, nil
	}
	return webPDimensions(data)
}

// webPDimensions validates the RIFF/chunk boundaries and extracts dimensions
// for all three WebP bitstream variants without decoding untrusted pixels.
func webPDimensions(data []byte) (int, int, error) {
	if len(data) < 20 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return 0, 0, ErrInvalidAsset
	}
	riffEnd := int64(binary.LittleEndian.Uint32(data[4:8])) + 8
	if riffEnd > int64(len(data)) || riffEnd < 20 {
		return 0, 0, ErrInvalidAsset
	}
	for offset := 12; int64(offset+8) <= riffEnd; {
		chunkType := string(data[offset : offset+4])
		chunkSize := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		start := offset + 8
		end := start + chunkSize
		if chunkSize < 0 || end < start || int64(end) > riffEnd || end > len(data) {
			return 0, 0, ErrInvalidAsset
		}
		chunk := data[start:end]
		switch chunkType {
		case "VP8X":
			if len(chunk) < 10 {
				return 0, 0, ErrInvalidAsset
			}
			width := 1 + int(chunk[4]) + int(chunk[5])<<8 + int(chunk[6])<<16
			height := 1 + int(chunk[7]) + int(chunk[8])<<8 + int(chunk[9])<<16
			return width, height, nil
		case "VP8L":
			if len(chunk) < 5 || chunk[0] != 0x2f {
				return 0, 0, ErrInvalidAsset
			}
			width := 1 + int(chunk[1]) + (int(chunk[2])&0x3f)<<8
			height := 1 + int(chunk[2]>>6) + int(chunk[3])<<2 + (int(chunk[4])&0x0f)<<10
			return width, height, nil
		case "VP8 ":
			if len(chunk) < 10 || !bytes.Equal(chunk[3:6], []byte{0x9d, 0x01, 0x2a}) {
				return 0, 0, ErrInvalidAsset
			}
			width := int(binary.LittleEndian.Uint16(chunk[6:8]) & 0x3fff)
			height := int(binary.LittleEndian.Uint16(chunk[8:10]) & 0x3fff)
			return width, height, nil
		}
		offset = end + chunkSize%2
	}
	return 0, 0, ErrInvalidAsset
}

func ValidAssetFileID(fileID string) bool {
	return whiteboardFileIDRE.MatchString(fileID)
}

func AssetObjectKey(accountID, boardID uuid.UUID, fileID string, asset NormalizedAsset) (string, error) {
	if accountID == uuid.Nil || boardID == uuid.Nil || !ValidAssetFileID(fileID) || len(asset.Hash) != sha256.Size*2 || asset.Extension == "" {
		return "", ErrInvalidAsset
	}
	return storage.PrivateObjectKey(accountID, "whiteboards", boardID.String(), fmt.Sprintf("%s-%s%s", asset.Hash, fileID, asset.Extension)), nil
}

// LibraryAssetObjectKey keeps library bytes in their own account-private
// namespace. The library ID is part of both the authorization relation and the
// physical key, so a valid asset identifier from another library is never a
// storage capability by itself.
func LibraryAssetObjectKey(accountID, libraryID uuid.UUID, fileID string, asset NormalizedAsset) (string, error) {
	if accountID == uuid.Nil || libraryID == uuid.Nil || !ValidAssetFileID(fileID) || len(asset.Hash) != sha256.Size*2 || asset.Extension == "" {
		return "", ErrInvalidAsset
	}
	return storage.PrivateObjectKey(accountID, "whiteboards", "libraries", libraryID.String(), fmt.Sprintf("%s-%s%s", asset.Hash, fileID, asset.Extension)), nil
}
