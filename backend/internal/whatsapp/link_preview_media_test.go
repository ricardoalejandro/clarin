package whatsapp

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
	"time"
)

func TestNormalizeReceivedLinkPreviewThumbnail(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 1200, 800))
	for y := 0; y < 800; y++ {
		for x := 0; x < 1200; x++ {
			source.SetRGBA(x, y, color.RGBA{uint8(x), uint8(y), uint8(x * y), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, source, &jpeg.Options{Quality: 75}); err != nil {
		t.Fatal(err)
	}
	// Inject an EXIF-like comment; canonical encoding must not preserve it.
	metadata := []byte("private thumbnail metadata")
	marker := []byte{0xff, 0xfe, 0, 0}
	binary.BigEndian.PutUint16(marker[2:], uint16(len(metadata)+2))
	raw := append([]byte{}, buf.Bytes()[:2]...)
	raw = append(raw, marker...)
	raw = append(raw, metadata...)
	raw = append(raw, buf.Bytes()[2:]...)
	got, err := normalizeReceivedLinkPreviewThumbnail(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(got))
	if err != nil {
		t.Fatal(err)
	}
	if config.Width != 512 || config.Height != 341 || len(got) > linkPreviewMaxOutput || bytes.Contains(got, metadata) {
		t.Fatalf("invalid canonical thumbnail: %dx%d/%d", config.Width, config.Height, len(got))
	}
	second, err := normalizeReceivedLinkPreviewThumbnail(context.Background(), raw)
	if err != nil || !bytes.Equal(got, second) {
		t.Fatal("normalization must be deterministic for deduplication")
	}
}

func TestNormalizeReceivedLinkPreviewThumbnailDoesNotQueueWhenBusy(t *testing.T) {
	linkPreviewNormalizationSlots <- struct{}{}
	linkPreviewNormalizationSlots <- struct{}{}
	defer func() { <-linkPreviewNormalizationSlots; <-linkPreviewNormalizationSlots }()
	done := make(chan error, 1)
	go func() {
		_, err := normalizeReceivedLinkPreviewThumbnail(context.Background(), []byte{0xff, 0xd8})
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("busy normalization accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("optional thumbnail queued behind other images")
	}
}

func TestNormalizeReceivedLinkPreviewThumbnailRejectsInvalidAndOversize(t *testing.T) {
	for _, raw := range [][]byte{nil, []byte("not JPEG"), {137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, linkPreviewMaxInput+1)} {
		if _, err := normalizeReceivedLinkPreviewThumbnail(context.Background(), raw); err == nil {
			t.Fatal("invalid thumbnail accepted")
		}
	}
	var buf bytes.Buffer
	jpeg.Encode(&buf, image.NewGray(image.Rect(0, 0, 2001, 2000)), nil)
	if _, err := normalizeReceivedLinkPreviewThumbnail(context.Background(), buf.Bytes()); err == nil {
		t.Fatal("pixel bound bypassed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := normalizeReceivedLinkPreviewThumbnail(ctx, []byte{0xff, 0xd8}); err == nil {
		t.Fatal("cancelled thumbnail accepted")
	}
}
