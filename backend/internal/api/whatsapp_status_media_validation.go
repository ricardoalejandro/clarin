package api

import "encoding/binary"

var statusMP4CompatibleBrands = map[string]struct{}{
	"isom": {}, "iso2": {}, "iso3": {}, "iso4": {}, "iso5": {}, "iso6": {},
	"mp41": {}, "mp42": {}, "avc1": {}, "M4V ": {}, "MSNV": {},
}

// isValidStatusMP4 performs a bounded structural check of an ISO base media
// file. It is intentionally small, but rejects extension/MIME spoofing,
// truncated boxes, QuickTime-only files, and files without movie/media boxes.
// Codec compatibility is still validated by WhatsApp during upload.
func isValidStatusMP4(data []byte) bool {
	if len(data) < 24 {
		return false
	}

	var foundFTYP, compatibleBrand, foundMOOV, foundMDAT bool
	offset := 0
	for offset < len(data) {
		if offset+8 > len(data) {
			return false
		}
		size := uint64(binary.BigEndian.Uint32(data[offset : offset+4]))
		boxType := string(data[offset+4 : offset+8])
		headerSize := uint64(8)
		if size == 1 {
			if offset+16 > len(data) {
				return false
			}
			size = binary.BigEndian.Uint64(data[offset+8 : offset+16])
			headerSize = 16
		} else if size == 0 {
			size = uint64(len(data) - offset)
		}
		if size < headerSize || size > uint64(len(data)-offset) {
			return false
		}

		payloadStart := offset + int(headerSize)
		payloadEnd := offset + int(size)
		switch boxType {
		case "ftyp":
			// The file type box must be first and contain a major brand plus
			// its minor version. Compatible brands follow in four-byte units.
			if offset != 0 || foundFTYP || payloadEnd-payloadStart < 8 || (payloadEnd-payloadStart-8)%4 != 0 {
				return false
			}
			foundFTYP = true
			if _, ok := statusMP4CompatibleBrands[string(data[payloadStart:payloadStart+4])]; ok {
				compatibleBrand = true
			}
			for brandOffset := payloadStart + 8; brandOffset+4 <= payloadEnd; brandOffset += 4 {
				if _, ok := statusMP4CompatibleBrands[string(data[brandOffset:brandOffset+4])]; ok {
					compatibleBrand = true
				}
			}
		case "moov":
			foundMOOV = true
		case "mdat":
			foundMDAT = true
		}

		offset += int(size)
	}
	return foundFTYP && compatibleBrand && foundMOOV && foundMDAT
}
