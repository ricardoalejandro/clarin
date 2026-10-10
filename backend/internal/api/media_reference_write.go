package api

import (
	"encoding/json"
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/service"
)

// Validate the same JSON references recognized by inventory before the writer
// can introduce them. This prevents a caption/settings/canvas field from being
// used to fabricate an authorized origin for an otherwise unreadable object.
func (s *Server) authorizeMediaReferencePayload(c *fiber.Ctx, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var decoded any
	if err = json.Unmarshal(encoded, &decoded); err != nil {
		return err
	}
	claims, _ := c.Locals("claims").(*service.JWTClaims)
	seen := map[string]bool{}
	var visit func(any) error
	visit = func(value any) error {
		switch value := value.(type) {
		case []any:
			for _, child := range value {
				if err := visit(child); err != nil {
					return err
				}
			}
		case map[string]any:
			for _, child := range value {
				if err := visit(child); err != nil {
					return err
				}
			}
		case string:
			if seen[value] {
				return nil
			}
			seen[value] = true
			if err := s.authorizeMediaPublication(c, value); err != nil {
				return err
			}
			if claims == nil {
				return nil
			}
			directKey, direct := s.ordinaryObjectKeyFromURL(value)
			for key, authoritative := range storageSelfServiceReferenceValues(claims.AccountID, value, s.storage) {
				if !authoritative {
					continue
				}
				if direct && key == directKey {
					continue
				}
				if err := s.authorizeMediaPublication(c, mediaProxyURLFromObjectKey(key)); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return visit(decoded)
}

func (s *Server) authorizeMediaAssetAssignment(c *fiber.Ctx, assetID *uuid.UUID, sourceURL string) error {
	if assetID == nil {
		return nil
	}
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	if !ok || s.repos == nil {
		return errors.New("Archivo no autorizado")
	}
	var key string
	if err := s.repos.DB().QueryRow(c.Context(), `SELECT object_key FROM media_assets WHERE account_id=$1 AND id=$2`, claims.AccountID, *assetID).Scan(&key); err != nil {
		return errors.New("Archivo no autorizado")
	}
	sourceKey, stored := s.ordinaryObjectKeyFromURL(sourceURL)
	if stored && sourceKey != key {
		return errors.New("El archivo y la imagen seleccionada no coinciden")
	}
	if !stored {
		sourceURL = mediaProxyURLFromObjectKey(key)
	}
	return s.authorizeMediaPublication(c, sourceURL)
}
