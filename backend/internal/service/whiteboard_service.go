package service

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/storage"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

const (
	MaxWhiteboardSceneBytes   = 16 * 1024 * 1024
	MaxWhiteboardLibraryBytes = 8 * 1024 * 1024
)

var ErrWhiteboardPayloadInvalid = errors.New("invalid whiteboard payload")

type WhiteboardService struct {
	repos *repository.Repositories
}

func NewWhiteboardService(repos *repository.Repositories) *WhiteboardService {
	return &WhiteboardService{repos: repos}
}

func (s *WhiteboardService) Repository() *repository.WhiteboardRepository {
	return s.repos.Whiteboard
}

func NormalizeWhiteboardName(raw string, maxRunes int) (string, error) {
	value := strings.Join(strings.Fields(strings.TrimSpace(raw)), " ")
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return "", ErrWhiteboardPayloadInvalid
	}
	return value, nil
}

func ValidateWhiteboardScene(raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || len(trimmed) > MaxWhiteboardSceneBytes || !json.Valid(trimmed) {
		return nil, ErrWhiteboardPayloadInvalid
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &document); err != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	if rawType, ok := document["type"]; ok {
		var sceneType string
		if json.Unmarshal(rawType, &sceneType) != nil || sceneType != "excalidraw" {
			return nil, ErrWhiteboardPayloadInvalid
		}
	} else {
		document["type"] = json.RawMessage(`"excalidraw"`)
	}
	if rawVersion, ok := document["version"]; ok {
		var version json.Number
		decoder := json.NewDecoder(bytes.NewReader(rawVersion))
		decoder.UseNumber()
		if decoder.Decode(&version) != nil {
			return nil, ErrWhiteboardPayloadInvalid
		}
	} else {
		document["version"] = json.RawMessage(`2`)
	}

	elements := []json.RawMessage{}
	if rawElements, ok := document["elements"]; ok {
		if json.Unmarshal(rawElements, &elements) != nil || len(elements) > whiteboardcore.MaxCanonicalElements {
			return nil, ErrWhiteboardPayloadInvalid
		}
	}
	reconciledElements, err := whiteboardcore.NormalizeElementsForStorage(elements)
	if err != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	elements = reconciledElements
	for _, rawElement := range elements {
		var element map[string]json.RawMessage
		if json.Unmarshal(rawElement, &element) != nil {
			return nil, ErrWhiteboardPayloadInvalid
		}
		var elementID string
		if json.Unmarshal(element["id"], &elementID) != nil || strings.TrimSpace(elementID) == "" {
			return nil, ErrWhiteboardPayloadInvalid
		}
		var elementType string
		_ = json.Unmarshal(element["type"], &elementType)
		// Imported upstream embeddables remain as inert, forward-compatible
		// document data. Both Clarin editors supply a non-null empty renderer and
		// the whiteboard CSP forbids frames, so retaining the element never loads
		// its URL. The legacy iframe element type is executable surface and is
		// rejected outright.
		if elementType == "iframe" {
			return nil, ErrWhiteboardPayloadInvalid
		}
		if rawLink, exists := element["link"]; exists && !bytes.Equal(bytes.TrimSpace(rawLink), []byte("null")) {
			var link string
			if json.Unmarshal(rawLink, &link) != nil || !allowedWhiteboardLink(link) {
				return nil, ErrWhiteboardPayloadInvalid
			}
		}
		for _, forbiddenKey := range []string{"dataURL", "src", "iframe"} {
			if value, exists := element[forbiddenKey]; exists && !emptyWhiteboardJSONValue(value) {
				return nil, ErrWhiteboardPayloadInvalid
			}
		}
	}
	encodedElements, err := json.Marshal(elements)
	if err != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	document["elements"] = encodedElements

	cleanAppState, err := whiteboardcore.SanitizePersistedAppState(document["appState"])
	if err != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	document["appState"] = cleanAppState

	files := map[string]json.RawMessage{}
	if rawFiles, ok := document["files"]; ok {
		if json.Unmarshal(rawFiles, &files) != nil {
			return nil, ErrWhiteboardPayloadInvalid
		}
	}
	for fileID, rawFile := range files {
		if !whiteboardcore.ValidAssetFileID(fileID) {
			return nil, ErrWhiteboardPayloadInvalid
		}
		var file map[string]json.RawMessage
		if json.Unmarshal(rawFile, &file) != nil {
			return nil, ErrWhiteboardPayloadInvalid
		}
		if err := validateWhiteboardFileMetadata(rawFile, 0); err != nil {
			// Binary bytes and remote/storage locations live in private Clarin
			// assets, never inside canonical JSONB (including future metadata).
			return nil, ErrWhiteboardPayloadInvalid
		}
	}
	encodedFiles, err := json.Marshal(files)
	if err != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	document["files"] = encodedFiles
	document["source"] = json.RawMessage(`"clarin"`)

	validated, err := json.Marshal(document)
	if err != nil || len(validated) > MaxWhiteboardSceneBytes {
		return nil, ErrWhiteboardPayloadInvalid
	}
	return validated, nil
}

var whiteboardFileLocationOrBinaryKeys = map[string]struct{}{
	"arraybuffer": {}, "base64": {}, "binary": {}, "blob": {}, "bucket": {},
	"buffer": {}, "bytes": {}, "content": {}, "data": {}, "datauri": {},
	"dataurl": {}, "filepath": {}, "fileurl": {}, "href": {}, "location": {},
	"objectkey": {}, "path": {}, "payload": {}, "raw": {}, "src": {},
	"storagekey": {}, "uri": {}, "url": {},
}

var whiteboardFileLocationOrBinaryKeyParts = []string{
	"arraybuffer", "base64", "binary", "blob", "bucket", "buffer", "bytes",
	"dataurl", "filepath", "fileurl", "location", "objectkey", "payload", "storagekey",
}

func normalizedWhiteboardMetadataKey(key string) string {
	var result strings.Builder
	result.Grow(len(key))
	for _, char := range strings.ToLower(key) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			result.WriteRune(char)
		}
	}
	return result.String()
}

func forbiddenWhiteboardMetadataKey(key string) bool {
	normalized := normalizedWhiteboardMetadataKey(key)
	if normalized == "" {
		return true
	}
	if _, forbidden := whiteboardFileLocationOrBinaryKeys[normalized]; forbidden {
		return true
	}
	for _, part := range whiteboardFileLocationOrBinaryKeyParts {
		if strings.Contains(normalized, part) {
			return true
		}
	}
	return false
}

func validateWhiteboardFileMetadata(raw json.RawMessage, depth int) error {
	if depth > 12 || len(raw) == 0 {
		return ErrWhiteboardPayloadInvalid
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return ErrWhiteboardPayloadInvalid
	}
	return validateWhiteboardFileMetadataValue(value, depth)
}

func validateWhiteboardFileMetadataValue(value any, depth int) error {
	if depth > 12 {
		return ErrWhiteboardPayloadInvalid
	}
	switch typed := value.(type) {
	case nil, bool, json.Number:
		return nil
	case string:
		trimmed := strings.TrimSpace(typed)
		lower := strings.ToLower(trimmed)
		for _, prefix := range []string{"blob:", "data:", "file:", "http:", "https:"} {
			if strings.HasPrefix(lower, prefix) {
				return ErrWhiteboardPayloadInvalid
			}
		}
		return nil
	case []any:
		for _, item := range typed {
			if err := validateWhiteboardFileMetadataValue(item, depth+1); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		for key, item := range typed {
			if forbiddenWhiteboardMetadataKey(key) {
				return ErrWhiteboardPayloadInvalid
			}
			if err := validateWhiteboardFileMetadataValue(item, depth+1); err != nil {
				return err
			}
		}
		return nil
	default:
		return ErrWhiteboardPayloadInvalid
	}
}

func ValidateAndHashWhiteboardScene(raw json.RawMessage) (json.RawMessage, string, error) {
	validated, err := ValidateWhiteboardScene(raw)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(validated)
	return validated, hex.EncodeToString(digest[:]), nil
}

func HashWhiteboardOperationPayload(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || len(raw) > whiteboardcore.MaxRealtimeMessageBytes || !json.Valid(raw) {
		return "", ErrWhiteboardPayloadInvalid
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

// StableWhiteboardID makes a create operation safely retryable without
// inventing a second board after a lost HTTP response. Operation IDs remain
// scoped by account, so the same client UUID in two accounts cannot collide.
func StableWhiteboardID(accountID, operationID uuid.UUID) (uuid.UUID, error) {
	if accountID == uuid.Nil || operationID == uuid.Nil {
		return uuid.Nil, ErrWhiteboardPayloadInvalid
	}
	return uuid.NewSHA1(accountID, operationID[:]), nil
}

func allowedWhiteboardLink(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return true
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		return parsed.Host != ""
	case "mailto":
		return parsed.Opaque != "" || parsed.Path != ""
	default:
		return false
	}
}

func emptyWhiteboardJSONValue(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte(`""`)) {
		return true
	}
	return false
}

func ValidateWhiteboardLibrary(raw json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || len(trimmed) > MaxWhiteboardLibraryBytes || !json.Valid(trimmed) {
		return nil, ErrWhiteboardPayloadInvalid
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	if rawType, ok := envelope["type"]; ok {
		var libraryType string
		if json.Unmarshal(rawType, &libraryType) != nil || libraryType != "excalidrawlib" {
			return nil, ErrWhiteboardPayloadInvalid
		}
	} else {
		envelope["type"] = json.RawMessage(`"excalidrawlib"`)
	}
	var items []json.RawMessage
	if json.Unmarshal(envelope["libraryItems"], &items) != nil || len(items) > 5_000 {
		return nil, ErrWhiteboardPayloadInvalid
	}
	cleanItems := make([]json.RawMessage, 0, len(items))
	for _, rawItem := range items {
		trimmedItem := bytes.TrimSpace(rawItem)
		var elements json.RawMessage
		var itemEnvelope map[string]json.RawMessage
		legacy := len(trimmedItem) > 0 && trimmedItem[0] == '['
		if legacy {
			elements = trimmedItem
		} else if json.Unmarshal(trimmedItem, &itemEnvelope) != nil {
			return nil, ErrWhiteboardPayloadInvalid
		} else {
			elements = itemEnvelope["elements"]
		}
		if len(elements) == 0 {
			return nil, ErrWhiteboardPayloadInvalid
		}
		scene, err := json.Marshal(map[string]json.RawMessage{
			"type":     json.RawMessage(`"excalidraw"`),
			"version":  json.RawMessage(`2`),
			"elements": elements,
			"appState": json.RawMessage(`{}`),
			"files":    json.RawMessage(`{}`),
		})
		if err != nil {
			return nil, ErrWhiteboardPayloadInvalid
		}
		validatedScene, err := ValidateWhiteboardScene(scene)
		if err != nil {
			return nil, err
		}
		var cleanScene map[string]json.RawMessage
		if json.Unmarshal(validatedScene, &cleanScene) != nil {
			return nil, ErrWhiteboardPayloadInvalid
		}
		// Libraries are an authoring surface, not a compatibility archive. Do not
		// let an imported library reintroduce a hidden embed creation path even
		// though legacy scene embeds are retained inertly for round trips.
		var cleanElements []json.RawMessage
		if json.Unmarshal(cleanScene["elements"], &cleanElements) != nil {
			return nil, ErrWhiteboardPayloadInvalid
		}
		for _, cleanElement := range cleanElements {
			var elementTypeProbe struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(cleanElement, &elementTypeProbe) != nil || elementTypeProbe.Type == "embeddable" || elementTypeProbe.Type == "iframe" {
				return nil, ErrWhiteboardPayloadInvalid
			}
		}
		if legacy {
			cleanItems = append(cleanItems, cleanScene["elements"])
			continue
		}
		itemEnvelope["elements"] = cleanScene["elements"]
		cleanItem, err := json.Marshal(itemEnvelope)
		if err != nil {
			return nil, ErrWhiteboardPayloadInvalid
		}
		cleanItems = append(cleanItems, cleanItem)
	}
	encodedItems, err := json.Marshal(cleanItems)
	if err != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	envelope["libraryItems"] = encodedItems
	// Library binaries follow the same Clarin-private asset boundary as scene
	// binaries. Preserve harmless upstream/Clarin metadata, but reject embedded
	// data URLs and remote locations before the JSON reaches persistence.
	libraryFiles := envelope["files"]
	if len(libraryFiles) == 0 {
		libraryFiles = json.RawMessage(`{}`)
	}
	filesProbe, err := json.Marshal(map[string]json.RawMessage{
		"type":     json.RawMessage(`"excalidraw"`),
		"version":  json.RawMessage(`2`),
		"elements": json.RawMessage(`[]`),
		"appState": json.RawMessage(`{}`),
		"files":    libraryFiles,
	})
	if err != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	cleanFilesProbe, err := ValidateWhiteboardScene(filesProbe)
	if err != nil {
		return nil, err
	}
	var cleanFilesDocument map[string]json.RawMessage
	if json.Unmarshal(cleanFilesProbe, &cleanFilesDocument) != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	envelope["files"] = cleanFilesDocument["files"]
	envelope["source"] = json.RawMessage(`"clarin"`)
	validated, err := json.Marshal(envelope)
	if err != nil || len(validated) > MaxWhiteboardLibraryBytes {
		return nil, ErrWhiteboardPayloadInvalid
	}
	return validated, nil
}

type PreparedWhiteboardSnapshot struct {
	CompressedBytes   []byte
	ObjectKey         string
	SceneHash         string
	ContentHash       string
	SizeBytes         int64
	UploadedByRequest bool
}

func PrepareWhiteboardSnapshot(accountID, boardID, operationID uuid.UUID, scene json.RawMessage) (PreparedWhiteboardSnapshot, error) {
	validated, sceneHash, err := ValidateAndHashWhiteboardScene(scene)
	if err != nil || accountID == uuid.Nil || boardID == uuid.Nil || operationID == uuid.Nil {
		return PreparedWhiteboardSnapshot{}, ErrWhiteboardPayloadInvalid
	}
	var compressed bytes.Buffer
	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	if err != nil {
		return PreparedWhiteboardSnapshot{}, err
	}
	writer.Header.ModTime = time.Unix(0, 0).UTC()
	writer.Header.OS = 255
	if _, err := writer.Write(validated); err != nil {
		_ = writer.Close()
		return PreparedWhiteboardSnapshot{}, err
	}
	if err := writer.Close(); err != nil {
		return PreparedWhiteboardSnapshot{}, err
	}
	contentDigest := sha256.Sum256(compressed.Bytes())
	return PreparedWhiteboardSnapshot{
		CompressedBytes: append([]byte(nil), compressed.Bytes()...),
		ObjectKey:       storage.PrivateObjectKey(accountID, "whiteboards", boardID.String(), "revisions", operationID.String()+".json.gz"),
		SceneHash:       sceneHash,
		ContentHash:     hex.EncodeToString(contentDigest[:]),
		SizeBytes:       int64(compressed.Len()),
	}, nil
}

func DecodeWhiteboardSnapshot(compressed []byte, expectedHash string) (json.RawMessage, error) {
	if len(compressed) == 0 || len(compressed) > MaxWhiteboardSceneBytes {
		return nil, ErrWhiteboardPayloadInvalid
	}
	digest := sha256.Sum256(compressed)
	if expectedHash != "" && !strings.EqualFold(hex.EncodeToString(digest[:]), expectedHash) {
		return nil, ErrWhiteboardPayloadInvalid
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	defer reader.Close()
	var decoded bytes.Buffer
	if _, err := decoded.ReadFrom(&limitedReader{reader: reader, remaining: MaxWhiteboardSceneBytes + 1}); err != nil {
		return nil, ErrWhiteboardPayloadInvalid
	}
	if decoded.Len() > MaxWhiteboardSceneBytes {
		return nil, ErrWhiteboardPayloadInvalid
	}
	return ValidateWhiteboardScene(decoded.Bytes())
}

type limitedReader struct {
	reader    interface{ Read([]byte) (int, error) }
	remaining int
}

func (r *limitedReader) Read(target []byte) (int, error) {
	if r.remaining <= 0 {
		return 0, errors.New("whiteboard snapshot exceeds limit")
	}
	if len(target) > r.remaining {
		target = target[:r.remaining]
	}
	count, err := r.reader.Read(target)
	r.remaining -= count
	return count, err
}

type whiteboardBoardCursor struct {
	UpdatedAt time.Time `json:"u"`
	ID        uuid.UUID `json:"i"`
}

type whiteboardFolderCursor struct {
	SortOrder int64     `json:"s"`
	ID        uuid.UUID `json:"i"`
}

func EncodeWhiteboardBoardCursor(updatedAt time.Time, id uuid.UUID) string {
	raw, _ := json.Marshal(whiteboardBoardCursor{UpdatedAt: updatedAt.UTC(), ID: id})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func DecodeWhiteboardBoardCursor(raw string) (*time.Time, *uuid.UUID, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, nil, ErrWhiteboardPayloadInvalid
	}
	var cursor whiteboardBoardCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.ID == uuid.Nil || cursor.UpdatedAt.IsZero() {
		return nil, nil, ErrWhiteboardPayloadInvalid
	}
	return &cursor.UpdatedAt, &cursor.ID, nil
}

func EncodeWhiteboardFolderCursor(sortOrder int64, id uuid.UUID) string {
	raw, _ := json.Marshal(whiteboardFolderCursor{SortOrder: sortOrder, ID: id})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func DecodeWhiteboardFolderCursor(raw string) (*int64, *uuid.UUID, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, nil, ErrWhiteboardPayloadInvalid
	}
	var cursor whiteboardFolderCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.ID == uuid.Nil {
		return nil, nil, ErrWhiteboardPayloadInvalid
	}
	return &cursor.SortOrder, &cursor.ID, nil
}

func NewWhiteboardSecret() (plain, hash string, err error) {
	return whiteboardcore.NewSecret()
}

func HashWhiteboardSecret(secret string) string { return whiteboardcore.HashSecret(secret) }

func NormalizeWhiteboardGuestName(raw string) (string, error) {
	return whiteboardcore.NormalizeGuestDisplayName(raw)
}

func HashWhiteboardLinkPassword(raw string) (string, error) {
	return whiteboardcore.HashOptionalPassword(raw)
}

func VerifyWhiteboardLinkPassword(hash, candidate string) bool {
	return whiteboardcore.PasswordMatches(hash, candidate)
}

func WhiteboardGuestExpiry(now time.Time, linkExpiry *time.Time) time.Time {
	return whiteboardcore.GuestSessionExpiry(now, linkExpiry)
}

func WhiteboardSnapshotContentType() string { return "application/gzip" }

func ValidateWhiteboardVersion(raw string, fallback string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		value = fallback
	}
	if len(value) > 80 || strings.ContainsAny(value, "\r\n\x00") {
		return "", fmt.Errorf("%w: version", ErrWhiteboardPayloadInvalid)
	}
	return value, nil
}
