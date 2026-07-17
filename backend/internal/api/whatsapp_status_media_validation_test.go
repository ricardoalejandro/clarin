package api

import (
	"encoding/binary"
	"testing"
)

func statusMP4TestBox(kind string, payload []byte) []byte {
	box := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(box[:4], uint32(len(box)))
	copy(box[4:8], kind)
	copy(box[8:], payload)
	return box
}

func statusMP4Fixture(majorBrand string, compatibleBrands ...string) []byte {
	ftypPayload := make([]byte, 8, 8+4*len(compatibleBrands))
	copy(ftypPayload[:4], majorBrand)
	for _, brand := range compatibleBrands {
		ftypPayload = append(ftypPayload, []byte(brand)...)
	}
	result := statusMP4TestBox("ftyp", ftypPayload)
	result = append(result, statusMP4TestBox("mdat", []byte{1, 2, 3, 4})...)
	result = append(result, statusMP4TestBox("moov", []byte{5, 6, 7, 8})...)
	return result
}

func TestIsValidStatusMP4(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want bool
	}{
		{name: "standard MP4", data: statusMP4Fixture("isom", "mp42"), want: true},
		{name: "compatible MP4 brand", data: statusMP4Fixture("qt  ", "isom"), want: true},
		{name: "QuickTime only", data: statusMP4Fixture("qt  "), want: false},
		{name: "MIME spoof without boxes", data: []byte("video/mp4 but not an ISO media file"), want: false},
		{name: "missing movie metadata", data: append(statusMP4TestBox("ftyp", append([]byte("isom"), make([]byte, 4)...)), statusMP4TestBox("mdat", []byte{1})...), want: false},
		{name: "truncated box", data: append(statusMP4Fixture("isom"), []byte{0, 0, 0, 32, 'm', 'd', 'a', 't'}...), want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isValidStatusMP4(tt.data); got != tt.want {
				t.Fatalf("isValidStatusMP4() = %v, want %v", got, tt.want)
			}
		})
	}
}
