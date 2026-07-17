package contactavatar

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"math"
	"net/http"
)

const (
	OutputSize        = 512
	MaxInputBytes     = 8 * 1024 * 1024
	MaxInputPixels    = 40_000_000
	TargetOutputBytes = 250 * 1024
	MinimumQuality    = 70
)

var (
	ErrEmptyImage       = errors.New("avatar image is empty")
	ErrImageTooLarge    = errors.New("avatar image is too large")
	ErrUnsupportedImage = errors.New("avatar image must be JPEG or PNG")
)

// Normalize validates, center-crops and re-encodes an avatar. Re-encoding
// intentionally strips EXIF and all other metadata before the image reaches
// private storage.
func Normalize(input []byte) ([]byte, error) {
	if len(input) == 0 {
		return nil, ErrEmptyImage
	}
	if len(input) > MaxInputBytes {
		return nil, ErrImageTooLarge
	}
	contentType := http.DetectContentType(input)
	if contentType != "image/jpeg" && contentType != "image/png" {
		return nil, ErrUnsupportedImage
	}

	cfg, _, err := image.DecodeConfig(bytes.NewReader(input))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, ErrUnsupportedImage
	}
	if int64(cfg.Width)*int64(cfg.Height) > MaxInputPixels {
		return nil, ErrImageTooLarge
	}
	source, _, err := image.Decode(bytes.NewReader(input))
	if err != nil {
		return nil, ErrUnsupportedImage
	}

	bounds := source.Bounds()
	side := bounds.Dx()
	if bounds.Dy() < side {
		side = bounds.Dy()
	}
	startX := bounds.Min.X + (bounds.Dx()-side)/2
	startY := bounds.Min.Y + (bounds.Dy()-side)/2
	destination := image.NewRGBA(image.Rect(0, 0, OutputSize, OutputSize))
	resizeBilinear(destination, source, image.Rect(startX, startY, startX+side, startY+side))

	quality := 86
	var encoded []byte
	for {
		var output bytes.Buffer
		if err := jpeg.Encode(&output, destination, &jpeg.Options{Quality: quality}); err != nil {
			return nil, fmt.Errorf("encode avatar: %w", err)
		}
		encoded = output.Bytes()
		if len(encoded) <= TargetOutputBytes || quality <= MinimumQuality {
			break
		}
		quality -= 4
		if quality < MinimumQuality {
			quality = MinimumQuality
		}
	}
	return encoded, nil
}

func resizeBilinear(dst *image.RGBA, src image.Image, crop image.Rectangle) {
	if crop.Dx() <= 0 || crop.Dy() <= 0 {
		return
	}
	scaleX := float64(crop.Dx()) / float64(dst.Bounds().Dx())
	scaleY := float64(crop.Dy()) / float64(dst.Bounds().Dy())
	for y := 0; y < dst.Bounds().Dy(); y++ {
		sy := float64(crop.Min.Y) + (float64(y)+0.5)*scaleY - 0.5
		y0 := int(math.Floor(sy))
		y1 := y0 + 1
		fy := sy - float64(y0)
		if y0 < crop.Min.Y {
			y0, y1, fy = crop.Min.Y, crop.Min.Y, 0
		}
		if y1 >= crop.Max.Y {
			y1 = crop.Max.Y - 1
		}
		for x := 0; x < dst.Bounds().Dx(); x++ {
			sx := float64(crop.Min.X) + (float64(x)+0.5)*scaleX - 0.5
			x0 := int(math.Floor(sx))
			x1 := x0 + 1
			fx := sx - float64(x0)
			if x0 < crop.Min.X {
				x0, x1, fx = crop.Min.X, crop.Min.X, 0
			}
			if x1 >= crop.Max.X {
				x1 = crop.Max.X - 1
			}
			c00 := color.RGBAModel.Convert(src.At(x0, y0)).(color.RGBA)
			c10 := color.RGBAModel.Convert(src.At(x1, y0)).(color.RGBA)
			c01 := color.RGBAModel.Convert(src.At(x0, y1)).(color.RGBA)
			c11 := color.RGBAModel.Convert(src.At(x1, y1)).(color.RGBA)
			dst.SetRGBA(x, y, color.RGBA{
				R: interpolate(c00.R, c10.R, c01.R, c11.R, fx, fy),
				G: interpolate(c00.G, c10.G, c01.G, c11.G, fx, fy),
				B: interpolate(c00.B, c10.B, c01.B, c11.B, fx, fy),
				A: interpolate(c00.A, c10.A, c01.A, c11.A, fx, fy),
			})
		}
	}
}

func interpolate(c00, c10, c01, c11 uint8, fx, fy float64) uint8 {
	top := float64(c00)*(1-fx) + float64(c10)*fx
	bottom := float64(c01)*(1-fx) + float64(c11)*fx
	value := top*(1-fy) + bottom*fy
	if value < 0 {
		return 0
	}
	if value > 255 {
		return 255
	}
	return uint8(math.Round(value))
}
