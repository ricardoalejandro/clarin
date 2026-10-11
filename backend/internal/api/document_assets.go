package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"path/filepath"
	"strings"
)

const documentIsolatedHashLocal = "document-asset-isolated-hash"

func documentIsolatedContentHash(account, actor uuid.UUID, hash string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte("document-upload:"+account.String()+":"+actor.String()+":"+hash)))
}

const documentAssetMaxBytes = 10 * 1024 * 1024
const documentAssetMaxPixels = int64(40_000_000)

// Inspect compressed headers and GIF frame budgets without allocating decoded pixels.
func documentRasterType(data []byte) (string, error) {
	if len(data) == 0 || len(data) > documentAssetMaxBytes {
		return "", fmt.Errorf("La imagen admite hasta 10 MiB.")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		w, h, animated, e := inspectWebP(data)
		if e != nil || animated {
			return "", fmt.Errorf("El archivo WebP debe ser una imagen estática válida.")
		}
		config.Width = w
		config.Height = h
		format = "webp"
		err = nil
	}
	if err != nil || (format != "png" && format != "jpeg" && format != "gif" && format != "webp") {
		return "", fmt.Errorf("Selecciona una imagen PNG, JPEG, GIF o WebP válida.")
	}
	if config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > documentAssetMaxPixels {
		return "", fmt.Errorf("La imagen admite hasta 40 megapíxeles.")
	}
	if format == "gif" {
		if err := documentGIFBudget(data); err != nil {
			return "", err
		}
	}
	return "image/" + format, nil
}
func documentGIFBudget(data []byte) error {
	invalid := fmt.Errorf("El GIF no es válido o supera 40 megapíxeles entre sus cuadros.")
	if len(data) < 13 {
		return invalid
	}
	offset := 13
	if data[10]&128 != 0 {
		offset += 3 * (1 << ((data[10] & 7) + 1))
	}
	pixels := int64(0)
	canvasPixels := int64(binary.LittleEndian.Uint16(data[6:8])) * int64(binary.LittleEndian.Uint16(data[8:10]))
	frames := 0
	skipBlocks := func() bool {
		for offset < len(data) {
			length := int(data[offset])
			offset++
			if length == 0 {
				return true
			}
			offset += length
			if offset > len(data) {
				return false
			}
		}
		return false
	}
	for offset < len(data) {
		marker := data[offset]
		offset++
		switch marker {
		case 0x3b:
			if pixels == 0 {
				return invalid
			}
			return nil
		case 0x21:
			if offset >= len(data) {
				return invalid
			}
			offset++
			if !skipBlocks() {
				return invalid
			}
		case 0x2c:
			if offset+9 > len(data) {
				return invalid
			}
			w := int64(binary.LittleEndian.Uint16(data[offset+4 : offset+6]))
			h := int64(binary.LittleEndian.Uint16(data[offset+6 : offset+8]))
			frames++
			if w*h > canvasPixels {
				pixels += w * h
			} else {
				pixels += canvasPixels
			}
			if w < 1 || h < 1 || frames > 200 || pixels > documentAssetMaxPixels {
				return invalid
			}
			packed := data[offset+8]
			offset += 9
			if packed&128 != 0 {
				offset += 3 * (1 << ((packed & 7) + 1))
			}
			if offset >= len(data) {
				return invalid
			}
			offset++
			if !skipBlocks() {
				return invalid
			}
		default:
			return invalid
		}
	}
	return invalid
}
func (s *Server) handleDocumentAssetUpload(c *fiber.Ctx) error {
	if s.storage == nil {
		return documentError(c, 503, "document_storage_unavailable", "El almacenamiento no está disponible.")
	}
	file, err := c.FormFile("file")
	if err != nil {
		return documentError(c, 422, "document_image_invalid", "Selecciona una imagen.")
	}
	if file.Size > documentAssetMaxBytes {
		return documentError(c, 413, "document_image_too_large", "La imagen admite hasta 10 MiB.")
	}
	stream, err := file.Open()
	if err != nil {
		return documentError(c, 422, "document_image_invalid", "No se pudo leer la imagen.")
	}
	defer stream.Close()
	data, err := io.ReadAll(io.LimitReader(stream, documentAssetMaxBytes+1))
	if err != nil {
		return documentError(c, 422, "document_image_invalid", "No se pudo leer la imagen.")
	}
	mime, err := documentRasterType(data)
	if err != nil {
		return documentError(c, 422, "document_image_invalid", err.Error())
	}
	file.Header.Set("Content-Type", mime)
	ext := strings.TrimPrefix(mime, "image/")
	if ext == "jpeg" {
		ext = "jpg"
	}
	name := filepath.Base(file.Filename)
	file.Filename = strings.TrimSuffix(name, filepath.Ext(name)) + "." + ext
	form, err := c.MultipartForm()
	if err != nil {
		return documentError(c, 422, "document_image_invalid", "Carga no válida.")
	}
	form.Value["folder"] = []string{"documents"}
	// Byte possession permits a new upload, but it must not grant the user
	// another resource's location or historical ownership. If ordinary dedupe
	// points at an unreadable object, dedupe within this actor's document upload
	// namespace instead; a newly created object starts verified provenance.
	account, actor := c.Locals("account_id").(uuid.UUID), c.Locals("user_id").(uuid.UUID)
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	existing, _, err := s.findNonStatusMediaAsset(c.Context(), account, hash)
	if err != nil {
		return documentError(c, 503, "document_upload_unavailable", "No se pudo comprobar la imagen. Inténtalo de nuevo.")
	}
	if existing != nil && s.authorizeDocumentMediaPublication(c, mediaProxyURLFromObjectKey(existing.ObjectKey)) != nil {
		c.Locals(documentIsolatedHashLocal, documentIsolatedContentHash(account, actor, hash))
	}
	// This path retains canonical quota, deduplication, upload ownership, inventory
	// and draft grants; an image decoder is never a substitute for those controls.
	if err := s.handleDirectUpload(c); err != nil {
		return err
	}
	if c.Response().StatusCode() >= 400 {
		return nil
	}
	var response map[string]any
	if err := json.Unmarshal(c.Response().Body(), &response); err != nil {
		return documentError(c, 503, "document_upload_unavailable", "No se pudo preparar la imagen.")
	}
	raw, _ := response["proxy_url"].(string)
	key, stored := s.ordinaryObjectKeyFromURL(raw)
	if !stored {
		return documentError(c, 503, "document_upload_unavailable", "No se pudo preparar la imagen.")
	}
	// Cookie authorization and durable upload ownership replace expiring URL
	// capabilities. The exact same resource remains usable after long editing.
	canonical := mediaProxyURLFromObjectKey(key)
	if err := s.authorizeDocumentMediaPublication(c, canonical); err != nil {
		return mediaPublicationDenied(c, err)
	}
	response["proxy_url"], response["public_url"] = canonical, canonical
	return c.JSON(response)
}
func documentAssetSlot(key string, object map[string]any) bool {
	return key == "src" || key == "imageUrl" || (key == "source" && object["type"] == "pattern")
}

func documentAssetStrings(canvas json.RawMessage, thumbnail string) []string {
	values := []string{}
	if thumbnail != "" {
		values = append(values, thumbnail)
	}
	var parsed any
	if json.Unmarshal(canvas, &parsed) != nil {
		return values
	}
	var visit func(any)
	visit = func(node any) {
		switch value := node.(type) {
		case []any:
			for _, child := range value {
				visit(child)
			}
		case map[string]any:
			for key, child := range value {
				if documentAssetSlot(key, value) {
					if raw, ok := child.(string); ok && raw != "" {
						values = append(values, raw)
					}
				}
				visit(child)
			}
		}
	}
	visit(parsed)
	return values
}

type documentAssetValidationError struct{ error }

func invalidDocumentAsset(message string) error {
	return &documentAssetValidationError{fmt.Errorf("%s", message)}
}
func (s *Server) validateDocumentAssets(c *fiber.Ctx, body documentWriteBody, update bool) error {
	existing := map[string]bool{}
	if update || body.SourceTemplateID != nil {
		var id uuid.UUID
		var err error
		if update {
			id, err = uuid.Parse(c.Params("id"))
		} else {
			id = *body.SourceTemplateID
		}
		if err != nil {
			return pgx.ErrNoRows
		}
		t, err := s.services.DocumentTemplate.GetByID(c.Context(), id, c.Locals("account_id").(uuid.UUID))
		if err != nil {
			return err
		}
		for _, raw := range documentAssetStrings(t.CanvasJSON, t.ThumbnailURL) {
			existing[raw] = true
		}
	}
	for _, raw := range documentAssetStrings(body.CanvasJSON, body.ThumbnailURL) {
		if strings.HasPrefix(strings.ToLower(raw), "data:") {
			parts := strings.SplitN(raw, ",", 2)
			if len(parts) != 2 {
				return invalidDocumentAsset("Imagen incrustada no válida.")
			}
			data, err := base64.StdEncoding.DecodeString(parts[1])
			if err != nil {
				return invalidDocumentAsset("Imagen incrustada no válida.")
			}
			mime, err := documentRasterType(data)
			if err != nil {
				return &documentAssetValidationError{err}
			}
			if !strings.EqualFold(parts[0], "data:"+mime+";base64") {
				return invalidDocumentAsset("El tipo de imagen incrustada no coincide con su contenido.")
			}
			continue
		}
		if _, stored := s.ordinaryObjectKeyFromURL(raw); stored {
			continue
		}
		if existing[raw] {
			continue
		}
		return invalidDocumentAsset("Sube la imagen a Clarin antes de incorporarla. Las direcciones externas nuevas no están permitidas.")
	}
	return nil
}

// Documents may publish a still-unattached upload only while the same actor's
// verified durable ownership is current. Other modules retain their own guard.
func (s *Server) authorizeDocumentMediaPublication(c *fiber.Ctx, raw string) error {
	denied := s.authorizeMediaPublication(c, raw)
	if denied == nil {
		return nil
	}
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	key, stored := s.ordinaryObjectKeyFromURL(raw)
	if !ok || !stored || s.repos == nil {
		return denied
	}
	_, allowed, err := s.storageOwnUploadReadAllowed(c.Context(), s.repos.DB(), claims.AccountID, claims.UserID, key)
	if err != nil {
		return denied
	}
	if allowed {
		return nil
	}
	// Fabric historically persisted the browser's absolute same-origin src.
	// The general inventory intentionally treats arbitrary absolute URLs as
	// retention-only evidence. Recover only an exact image slot in a currently
	// account-authorized document whose host matches the configured Clarin/S3
	// origin; a private_external row or a key mentioned in text grants nothing.
	if s.documentHasAuthorizedAssetReference(c.Context(), claims, key) {
		return nil
	}
	return denied
}

func (s *Server) documentHasAuthorizedAssetReference(ctx context.Context, claims *service.JWTClaims, key string) bool {
	if claims == nil || s.repos == nil || !storageSelfServiceValidKey(claims.AccountID, key) || storage.IsProtectedMediaObjectKey(key) || !storageSelfServiceHasPermission(claims, domain.PermDocuments) {
		return false
	}
	var retained bool
	if err := s.repos.DB().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state IN ('trash','purging','purged'))`, claims.AccountID, key).Scan(&retained); err != nil || retained {
		return false
	}
	rows, err := s.repos.DB().Query(ctx, storageReferenceSelectedKeysSQL+`SELECT r.payload FROM (
 SELECT jsonb_build_array(thumbnail_url,canvas_json)::text AS payload FROM document_templates WHERE account_id=$1
 ) r WHERE `+storageReferenceSelectedKeyPredicateSQL, claims.AccountID, []string{key})
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var payload string
		if rows.Scan(&payload) != nil {
			return false
		}
		var values []json.RawMessage
		if json.Unmarshal([]byte(payload), &values) != nil || len(values) != 2 {
			continue
		}
		var thumbnail string
		_ = json.Unmarshal(values[0], &thumbnail)
		for _, raw := range documentAssetStrings(values[1], thumbnail) {
			if candidate, local := s.ordinaryObjectKeyFromURL(raw); local && candidate == key {
				return true
			}
		}
	}
	return false
}

// Run only after publication authorization. Persist stable local resource
// identities rather than Fabric's browser-expanded absolute URLs or tickets.
func (s *Server) canonicalizeDocumentAssets(body *documentWriteBody) {
	canonical := func(raw string) string {
		if key, local := s.ordinaryObjectKeyFromURL(raw); local {
			return mediaProxyURLFromObjectKey(key)
		}
		return raw
	}
	body.ThumbnailURL = canonical(body.ThumbnailURL)
	var parsed any
	if json.Unmarshal(body.CanvasJSON, &parsed) != nil {
		return
	}
	var visit func(any) any
	visit = func(node any) any {
		switch v := node.(type) {
		case []any:
			for i := range v {
				v[i] = visit(v[i])
			}
		case map[string]any:
			for key, child := range v {
				if raw, stringValue := child.(string); stringValue && documentAssetSlot(key, v) {
					v[key] = canonical(raw)
				} else {
					v[key] = visit(child)
				}
			}
		}
		return node
	}
	if encoded, err := json.Marshal(visit(parsed)); err == nil {
		body.CanvasJSON = encoded
	}
}

func (s *Server) authorizeDocumentMediaPayload(c *fiber.Ctx, body documentWriteBody) error {
	approved := map[string]bool{}
	return s.authorizeMediaReferencePayloadUsing(c, body, func(c *fiber.Ctx, raw string) error {
		key, stored := s.ordinaryObjectKeyFromURL(raw)
		if !stored {
			return nil
		}
		if approved[key] {
			return nil
		}
		if len(approved) >= 1024 {
			return fmt.Errorf("El diseño contiene demasiados recursos distintos.")
		}
		if err := s.authorizeDocumentMediaPublication(c, raw); err != nil {
			return err
		}
		approved[key] = true
		return nil
	})
}
