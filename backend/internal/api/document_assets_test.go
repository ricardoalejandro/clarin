package api

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/naperu/clarin/pkg/config"
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

func TestDocumentCanonicalAssetsPreserveTextAndMetadata(t *testing.T) {
	key := uuid.NewString() + "/documents/image.png"
	absolute := "https://clarin.test.invalid" + mediaProxyURLFromObjectKey(key)
	external := "https://foreign.invalid" + mediaProxyURLFromObjectKey(key)
	canvas := map[string]any{"version": 3, "background": map[string]any{"imageUrl": absolute}, "fabricJson": map[string]any{"objects": []any{
		map[string]any{"type": "Image", "src": absolute},
		map[string]any{"type": "IText", "text": absolute, "fieldValue": absolute, "metadata": map[string]any{"url": absolute}},
		map[string]any{"type": "Rect", "fill": map[string]any{"type": "pattern", "source": absolute}},
		map[string]any{"type": "Image", "src": external},
	}}}
	encoded, _ := json.Marshal(canvas)
	body := documentWriteBody{CanvasJSON: encoded, ThumbnailURL: absolute}
	s := &Server{cfg: &config.Config{PublicURL: "https://clarin.test.invalid"}}
	s.canonicalizeDocumentAssets(&body)
	var got map[string]any
	if err := json.Unmarshal(body.CanvasJSON, &got); err != nil {
		t.Fatal(err)
	}
	objects := got["fabricJson"].(map[string]any)["objects"].([]any)
	text := objects[1].(map[string]any)
	if text["text"] != absolute || text["fieldValue"] != absolute || text["metadata"].(map[string]any)["url"] != absolute {
		t.Fatal("canonicalization modified authored text or metadata")
	}
	if objects[0].(map[string]any)["src"] != mediaProxyURLFromObjectKey(key) || body.ThumbnailURL != mediaProxyURLFromObjectKey(key) || got["background"].(map[string]any)["imageUrl"] != mediaProxyURLFromObjectKey(key) {
		t.Fatal("local image slots were not canonical")
	}
	if objects[2].(map[string]any)["fill"].(map[string]any)["source"] != mediaProxyURLFromObjectKey(key) {
		t.Fatal("pattern was not canonical")
	}
	if objects[3].(map[string]any)["src"] != external {
		t.Fatal("foreign origin became trusted")
	}
}
