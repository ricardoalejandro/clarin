package whatsapp

import (
	"encoding/binary"
	"testing"
)

func TestStickerForwardingContainerBounds(t *testing.T) {
	chunk := func(tag string, payload []byte) []byte {
		out := make([]byte, 8+len(payload)+(len(payload)&1))
		copy(out, tag)
		binary.LittleEndian.PutUint32(out[4:8], uint32(len(payload)))
		copy(out[8:], payload)
		return out
	}
	container := func(payload []byte) []byte {
		out := append([]byte("RIFF0000WEBP"), payload...)
		binary.LittleEndian.PutUint32(out[4:8], uint32(len(out)-8))
		return out
	}
	still := container(chunk("VP8L", []byte{0x2f}))
	if animated, err := stickerWebPAnimation(still); err != nil || animated {
		t.Fatal("valid still container rejected", err)
	}
	truncatedChunk := append([]byte{}, still...)
	binary.LittleEndian.PutUint32(truncatedChunk[16:20], 0xffffffff)
	trailing := append(append([]byte{}, still...), 0)
	flaggedHeader := make([]byte, 10)
	flaggedHeader[0] = 2
	animationWithoutFrames := container(chunk("VP8X", flaggedHeader))
	animationWithoutBit := container(append(chunk("VP8X", make([]byte, 10)), chunk("ANIM", make([]byte, 6))...))
	for _, raw := range [][]byte{truncatedChunk, trailing, animationWithoutFrames, animationWithoutBit} {
		if _, err := stickerWebPAnimation(raw); err == nil {
			t.Fatal("invalid container silently became a still sticker")
		}
	}
}
