package api

import (
	"bytes"
	"encoding/binary"
	"github.com/google/uuid"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestDocumentRasterType(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 2, 3))
	for _, format := range []string{"png", "jpeg", "gif"} {
		var out bytes.Buffer
		var err error
		switch format {
		case "png":
			err = png.Encode(&out, img)
		case "jpeg":
			err = jpeg.Encode(&out, img, nil)
		case "gif":
			err = gif.Encode(&out, img, nil)
		}
		if err != nil {
			t.Fatal(err)
		}
		got, err := documentRasterType(out.Bytes())
		if err != nil || got != "image/"+format {
			t.Fatalf("%s: %s %v", format, got, err)
		}
	}
	for _, data := range [][]byte{nil, []byte(`<svg onload="alert(1)"/>`), []byte("not an image"), make([]byte, documentAssetMaxBytes+1)} {
		if _, err := documentRasterType(data); err == nil {
			t.Fatal("invalid image accepted")
		}
	}
}
func TestDocumentGIFBudget(t *testing.T) {
	frame := image.NewPaletted(image.Rect(0, 0, 1, 1), color.Palette{color.Black, color.White})
	var out bytes.Buffer
	if err := gif.EncodeAll(&out, &gif.GIF{Image: []*image.Paletted{frame, frame}, Delay: []int{1, 1}}); err != nil {
		t.Fatal(err)
	}
	data := out.Bytes()
	if _, err := documentRasterType(data); err != nil {
		t.Fatal(err)
	}
	huge := bytes.Clone(data)
	binary.LittleEndian.PutUint16(huge[6:8], 5000)
	binary.LittleEndian.PutUint16(huge[8:10], 5000)
	if _, err := documentRasterType(huge); err == nil {
		t.Fatal("aggregate animation allocation exceeds 40 MP")
	}
	binary.LittleEndian.PutUint16(huge[6:8], 7000)
	if _, err := documentRasterType(huge); err == nil {
		t.Fatal("oversized logical screen accepted")
	}
	if _, err := documentRasterType(data[:len(data)-1]); err == nil {
		t.Fatal("truncated GIF accepted")
	}
}

func TestDocumentIsolatedUploadHash(t *testing.T) {
	account, actor := uuid.New(), uuid.New()
	hash := "same-content"
	first := documentIsolatedContentHash(account, actor, hash)
	if first != documentIsolatedContentHash(account, actor, hash) || len(first) != 64 {
		t.Fatal("actor-local dedupe must be stable")
	}
	if first == documentIsolatedContentHash(uuid.New(), actor, hash) || first == documentIsolatedContentHash(account, uuid.New(), hash) || first == hash {
		t.Fatal("isolated upload crossed ownership")
	}
}
