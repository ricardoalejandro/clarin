package api

import (
	"strings"
	"testing"
)

func TestWhiteboardAssetCacheRequiresPrivateRevalidation(t *testing.T) {
	required := []string{"private", "no-cache", "max-age=0", "must-revalidate"}
	for _, directive := range required {
		if !strings.Contains(whiteboardAssetCacheControl, directive) {
			t.Fatalf("whiteboard cache policy must contain %q: %q", directive, whiteboardAssetCacheControl)
		}
	}
	if strings.Contains(whiteboardAssetCacheControl, "no-store") || strings.Contains(whiteboardAssetCacheControl, "public") {
		t.Fatalf("whiteboard cache policy must be privately storable but never public: %q", whiteboardAssetCacheControl)
	}
}

func TestStorageResponseNotModifiedHonorsRevalidationBoundaries(t *testing.T) {
	etag := `"asset-version"`
	tests := []struct {
		name         string
		cacheControl string
		rangeHeader  string
		validator    string
		want         bool
	}{
		{name: "authorized private revalidation", cacheControl: whiteboardAssetCacheControl, validator: etag, want: true},
		{name: "validator list", cacheControl: whiteboardAssetCacheControl, validator: `"older", "asset-version"`, want: true},
		{name: "changed object", cacheControl: whiteboardAssetCacheControl, validator: `"older"`, want: false},
		{name: "no-store remains uncacheable", cacheControl: "private, no-store", validator: etag, want: false},
		{name: "range requires body", cacheControl: whiteboardAssetCacheControl, rangeHeader: "bytes=0-99", validator: etag, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := storageResponseNotModified(test.cacheControl, test.rangeHeader, test.validator, etag); got != test.want {
				t.Fatalf("storageResponseNotModified()=%v, want %v", got, test.want)
			}
		})
	}
}
