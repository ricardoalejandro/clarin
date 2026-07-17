package whatsapp

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/gif"
	"os/exec"
	"testing"
)

func TestConvertGIFToWhatsAppVideo(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	palette := color.Palette{color.Black, color.White}
	first := image.NewPaletted(image.Rect(0, 0, 4, 4), palette)
	second := image.NewPaletted(image.Rect(0, 0, 4, 4), palette)
	for index := range second.Pix {
		second.Pix[index] = 1
	}
	var source bytes.Buffer
	if err := gif.EncodeAll(&source, &gif.GIF{Image: []*image.Paletted{first, second}, Delay: []int{5, 5}, LoopCount: 0}); err != nil {
		t.Fatal(err)
	}
	result, err := convertGIFToWhatsAppVideo(context.Background(), source.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(result) < 12 || string(result[4:8]) != "ftyp" {
		t.Fatalf("expected MP4 output, got %d bytes", len(result))
	}
}

func TestConvertGIFRejectsInvalidData(t *testing.T) {
	if _, err := convertGIFToWhatsAppVideo(context.Background(), []byte("not-a-gif")); err == nil {
		t.Fatal("expected invalid GIF to be rejected")
	}
}
