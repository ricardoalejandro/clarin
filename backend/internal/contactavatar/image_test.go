package contactavatar

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestNormalizeCropsResizesAndStripsToJPEG(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 900, 600))
	for y := 0; y < 600; y++ {
		for x := 0; x < 900; x++ {
			source.Set(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 120, A: 255})
		}
	}
	var input bytes.Buffer
	if err := png.Encode(&input, source); err != nil {
		t.Fatal(err)
	}
	result, err := Normalize(input.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(result) > TargetOutputBytes {
		t.Fatalf("normalized avatar is %d bytes, target is %d", len(result), TargetOutputBytes)
	}
	decoded, err := jpeg.Decode(bytes.NewReader(result))
	if err != nil {
		t.Fatalf("result is not JPEG: %v", err)
	}
	if got := decoded.Bounds().Dx(); got != OutputSize {
		t.Fatalf("width=%d, want %d", got, OutputSize)
	}
	if got := decoded.Bounds().Dy(); got != OutputSize {
		t.Fatalf("height=%d, want %d", got, OutputSize)
	}
}

func TestNormalizeRejectsUnsupportedAndOversized(t *testing.T) {
	if _, err := Normalize([]byte("not an image")); err != ErrUnsupportedImage {
		t.Fatalf("error=%v, want ErrUnsupportedImage", err)
	}
	tooLarge := make([]byte, MaxInputBytes+1)
	if _, err := Normalize(tooLarge); err != ErrImageTooLarge {
		t.Fatalf("error=%v, want ErrImageTooLarge", err)
	}
}
