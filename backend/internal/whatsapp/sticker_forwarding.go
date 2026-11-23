package whatsapp

import (
	"encoding/binary"
	"fmt"
)

// stickerWebPAnimation reads the RIFF container, not a filename or MIME guess.
// https://developers.google.com/speed/webp/docs/riff_container
func stickerWebPAnimation(data []byte) (bool, error) {
	fail := func() (bool, error) {
		return false, fmt.Errorf("el sticker original no tiene un contenedor WebP verificable")
	}
	if len(data) < 20 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return fail()
	}
	declared := uint64(binary.LittleEndian.Uint32(data[4:8])) + 8
	if declared != uint64(len(data)) {
		return fail()
	}
	animated, hasAnimation, hasFrame, hasImage := false, false, false, false
	for offset := 12; offset < len(data); {
		if len(data)-offset < 8 {
			return fail()
		}
		tag := string(data[offset : offset+4])
		size := uint64(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		start := offset + 8
		padded := size + (size & 1)
		if padded > uint64(len(data)-start) {
			return fail()
		}
		chunk := data[start : start+int(size)]
		switch tag {
		case "VP8X":
			if len(chunk) != 10 {
				return fail()
			}
			animated = chunk[0]&0x02 != 0
		case "ANIM":
			if len(chunk) != 6 {
				return fail()
			}
			hasAnimation = true
		case "ANMF":
			if len(chunk) < 24 || !webPFrameHasImage(chunk[16:]) {
				return fail()
			}
			hasFrame = true
		case "VP8 ", "VP8L":
			if len(chunk) == 0 {
				return fail()
			}
			hasImage = true
		}
		offset = start + int(padded)
	}
	if animated {
		if !hasAnimation || !hasFrame {
			return fail()
		}
		return true, nil
	}
	if hasAnimation || hasFrame || !hasImage {
		return fail()
	}
	return false, nil
}
func webPFrameHasImage(data []byte) bool {
	image := false
	for offset := 0; offset < len(data); {
		if len(data)-offset < 8 {
			return false
		}
		tag := string(data[offset : offset+4])
		size := uint64(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		start := offset + 8
		padded := size + (size & 1)
		if padded > uint64(len(data)-start) {
			return false
		}
		if (tag == "VP8 " || tag == "VP8L") && size > 0 {
			image = true
		}
		offset = start + int(padded)
	}
	return image
}
