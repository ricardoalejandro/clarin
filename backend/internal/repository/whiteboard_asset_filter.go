package repository

import (
	"encoding/json"

	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

// whiteboardReferencedAssetFileIDs derives the filter exclusively from the
// canonical account-scoped document loaded by the repository. API callers are
// never allowed to supply arbitrary file IDs as an authorization shortcut.
func whiteboardReferencedAssetFileIDs(document json.RawMessage, referencedOnly, library bool) ([]string, error) {
	if !referencedOnly {
		return nil, nil
	}
	var (
		ids []string
		err error
	)
	if library {
		ids, err = whiteboardcore.ReferencedLibraryFileIDs(document)
	} else {
		ids, err = whiteboardcore.ReferencedFileIDs(document)
	}
	if err != nil {
		return nil, ErrWhiteboardInvalid
	}
	return ids, nil
}
