package api

import (
	"encoding/binary"
	"testing"
)

func vp8XFixture(width, height int, animated bool) []byte {
	chunk := make([]byte, 10)
	if animated {
		chunk[0] = 0x02
	}
	w := width - 1
	h := height - 1
	chunk[4], chunk[5], chunk[6] = byte(w), byte(w>>8), byte(w>>16)
	chunk[7], chunk[8], chunk[9] = byte(h), byte(h>>8), byte(h>>16)
	// A VP8X header only describes the canvas. Include a minimal lossless frame
	// so the fixture is a complete static WebP container for validation tests.
	frame := []byte{0x2f, 0, 0, 0, 0}
	data := make([]byte, 20+len(chunk)+8+len(frame)+1)
	copy(data[:4], "RIFF")
	binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
	copy(data[8:12], "WEBP")
	copy(data[12:16], "VP8X")
	binary.LittleEndian.PutUint32(data[16:20], uint32(len(chunk)))
	copy(data[20:], chunk)
	frameOffset := 20 + len(chunk)
	copy(data[frameOffset:frameOffset+4], "VP8L")
	binary.LittleEndian.PutUint32(data[frameOffset+4:frameOffset+8], uint32(len(frame)))
	copy(data[frameOffset+8:], frame)
	return data
}

func vp8XOnlyFixture(width, height int) []byte {
	data := vp8XFixture(width, height, false)
	data = data[:30]
	binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
	return data
}

func TestInspectWebPStaticAndAnimated(t *testing.T) {
	width, height, animated, err := inspectWebP(vp8XFixture(512, 320, false))
	if err != nil || width != 512 || height != 320 || animated {
		t.Fatalf("unexpected static inspection: %dx%d animated=%v err=%v", width, height, animated, err)
	}
	_, _, animated, err = inspectWebP(vp8XFixture(512, 512, true))
	if err != nil || !animated {
		t.Fatalf("expected animated WebP, animated=%v err=%v", animated, err)
	}
}

func TestInspectWebPRejectsMalformedContainer(t *testing.T) {
	if _, _, _, err := inspectWebP([]byte("not a webp")); err == nil {
		t.Fatal("expected malformed WebP to be rejected")
	}
	if _, _, _, err := inspectWebP(vp8XOnlyFixture(512, 512)); err == nil {
		t.Fatal("expected VP8X without an image frame to be rejected")
	}
}

func TestValidWhatsAppPhone(t *testing.T) {
	for _, value := range []string{"+51 999 888 777", "+1 (415) 555-2671", "59170000000"} {
		if !validWhatsAppPhone(value) {
			t.Fatalf("expected %q to be valid", value)
		}
	}
	for _, value := range []string{"", "123456", "1234567890123456", "abcdefg", "1234abc567"} {
		if validWhatsAppPhone(value) {
			t.Fatalf("expected %q to be invalid", value)
		}
	}
}

func TestCanonicalWhatsAppUserJID(t *testing.T) {
	canonical, err := canonicalWhatsAppUserJID("51999888777:4@s.whatsapp.net")
	if err != nil || canonical != "51999888777@s.whatsapp.net" {
		t.Fatalf("unexpected canonical JID %q: %v", canonical, err)
	}
	for _, value := range []string{"", "51999888777@g.us", "abcdefg@s.whatsapp.net", "51999888777@lid"} {
		if _, err := canonicalWhatsAppUserJID(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}
