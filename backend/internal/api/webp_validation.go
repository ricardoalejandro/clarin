package api

import (
	"encoding/binary"
	"errors"
)

// inspectWebP reads only container headers. It deliberately rejects malformed
// chunks and reports animation so static sticker routes cannot silently accept
// ANIM/ANMF content under an image/webp metadata label.
func inspectWebP(data []byte) (width, height int, animated bool, err error) {
	if len(data) < 20 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return 0, 0, false, errors.New("invalid WebP container")
	}
	declared := int(binary.LittleEndian.Uint32(data[4:8])) + 8
	if declared > len(data) || declared < 20 {
		return 0, 0, false, errors.New("truncated WebP container")
	}

	hasImageFrame := false
	for offset := 12; offset+8 <= declared; {
		chunkType := string(data[offset : offset+4])
		chunkSize := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		start := offset + 8
		end := start + chunkSize
		if chunkSize < 0 || end < start || end > declared {
			return 0, 0, false, errors.New("invalid WebP chunk")
		}
		chunk := data[start:end]
		switch chunkType {
		case "VP8X":
			if len(chunk) < 10 {
				return 0, 0, false, errors.New("invalid VP8X header")
			}
			animated = animated || chunk[0]&0x02 != 0
			width = 1 + int(chunk[4]) + int(chunk[5])<<8 + int(chunk[6])<<16
			height = 1 + int(chunk[7]) + int(chunk[8])<<8 + int(chunk[9])<<16
		case "VP8 ":
			if len(chunk) < 10 || chunk[3] != 0x9d || chunk[4] != 0x01 || chunk[5] != 0x2a {
				return 0, 0, false, errors.New("invalid VP8 frame")
			}
			if width == 0 {
				width = int(binary.LittleEndian.Uint16(chunk[6:8]) & 0x3fff)
				height = int(binary.LittleEndian.Uint16(chunk[8:10]) & 0x3fff)
			}
			hasImageFrame = true
		case "VP8L":
			if len(chunk) < 5 || chunk[0] != 0x2f {
				return 0, 0, false, errors.New("invalid VP8L frame")
			}
			if width == 0 {
				width = 1 + int(chunk[1]) + int(chunk[2]&0x3f)<<8
				height = 1 + int(chunk[2]>>6) + int(chunk[3])<<2 + int(chunk[4]&0x0f)<<10
			}
			hasImageFrame = true
		case "ANIM", "ANMF":
			animated = true
		}
		offset = end + chunkSize%2
	}
	if width <= 0 || height <= 0 {
		return 0, 0, animated, errors.New("missing WebP dimensions")
	}
	if !hasImageFrame {
		return 0, 0, animated, errors.New("missing WebP image frame")
	}
	return width, height, animated, nil
}
