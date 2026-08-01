package api

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http/httptest"
	"testing"
)

func surveyBrandingFileHeader(t *testing.T, filename string, data []byte) *multipart.FileHeader {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("image", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	if err := request.ParseMultipartForm(8 * 1024 * 1024); err != nil {
		t.Fatal(err)
	}
	return request.MultipartForm.File["image"][0]
}

func pngOfSize(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewNRGBA(image.Rect(0, 0, width, height))
	canvas.Set(0, 0, color.White)
	var data bytes.Buffer
	if err := png.Encode(&data, canvas); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestReadSurveyBrandImageValidatesDetectedTypeAndDimensions(t *testing.T) {
	valid := surveyBrandingFileHeader(t, "fondo.txt", pngOfSize(t, 800, 450))
	image, err := readSurveyBrandImage(valid, "background")
	if err != nil {
		t.Fatalf("valid detected PNG was rejected: %v", err)
	}
	if image.contentType != "image/png" || image.width != 800 || image.height != 450 {
		t.Fatalf("unexpected validated image: %#v", image)
	}

	tooSmall := surveyBrandingFileHeader(t, "small.png", pngOfSize(t, 799, 449))
	if _, err := readSurveyBrandImage(tooSmall, "background"); err == nil {
		t.Fatal("undersized background must be rejected")
	}

	notImage := surveyBrandingFileHeader(t, "logo.png", []byte("<svg onload=alert(1)></svg>"))
	if _, err := readSurveyBrandImage(notImage, "logo"); err == nil {
		t.Fatal("extension-only image claims must be rejected")
	}
}

func TestReadSurveyBrandImageEnforcesLogoBounds(t *testing.T) {
	oversized := surveyBrandingFileHeader(t, "logo.png", pngOfSize(t, 4097, 1))
	if _, err := readSurveyBrandImage(oversized, "logo"); err == nil {
		t.Fatal("oversized logo must be rejected")
	}
}
