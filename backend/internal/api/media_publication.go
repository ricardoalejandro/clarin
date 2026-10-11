package api

import (
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func (s *Server) isLocalMediaProxyURL(candidate *url.URL) bool {
	if candidate == nil || candidate.User != nil || candidate.Opaque != "" {
		return false
	}
	if candidate.Scheme == "" && candidate.Host == "" {
		return true
	}
	if s.cfg == nil {
		return false
	}
	origins := append([]string{s.cfg.PublicURL}, s.cfg.CORSOrigins...)
	for _, raw := range origins {
		base, err := url.Parse(raw)
		if err != nil || !base.IsAbs() {
			continue
		}
		if strings.EqualFold(candidate.Scheme, base.Scheme) && strings.EqualFold(candidate.Host, base.Host) {
			return true
		}
	}
	return false
}

func mediaReferenceAssignmentAllowed(claims *service.JWTClaims, key string, grant *mediaAccessGrant, refs []storageSelfServiceReference) bool {
	accountID, valid := ordinaryMediaKeyAccount(key)
	return valid && claims != nil && claims.AccountID == accountID && (storageSelfServiceCanRead(claims, refs) || privateMediaPreviewAllowed(grant, claims))
}

// Publication is a write boundary as well as a read boundary. Adding a URL to a
// public resource cannot turn a known but unreadable chat attachment into a
// public capability. New uploads prove possession through their session grant.
func (s *Server) authorizeMediaPublication(c *fiber.Ctx, raw string) error {
	key, stored := s.ordinaryObjectKeyFromURL(raw)
	if !stored {
		return nil
	}
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	accountID, valid := ordinaryMediaKeyAccount(key)
	denied := errors.New("No tienes acceso a este archivo. Selecciona un archivo autorizado o vuelve a subirlo.")
	if !ok || !valid || claims.AccountID != accountID || s.repos == nil {
		return denied
	}
	refs, err := storageSelfServiceObjectReferences(c.Context(), s.repos.DB(), accountID, key, s.storage)
	if err != nil {
		return denied
	}
	var grant *mediaAccessGrant
	if parsed, err := url.Parse(raw); err == nil && s.cfg != nil {
		grant, _ = verifyMediaAccessGrant(s.cfg.JWTSecret, parsed.Query().Get("media_preview"), key, time.Now())
	}
	if !mediaReferenceAssignmentAllowed(claims, key, grant, refs) {
		return denied
	}
	// A draft token must not republish an object currently in recovery/retention.
	var removed bool
	if err := s.repos.DB().QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state IN ('trash','purging','purged'))`, accountID, key).Scan(&removed); err != nil || removed {
		return denied
	}
	return nil
}

func (s *Server) authorizeBrandingPublication(c *fiber.Ctx, branding domain.SurveyBranding) error {
	for _, raw := range []string{branding.LogoURL, branding.BgImageURL} {
		if err := s.authorizeMediaPublication(c, raw); err != nil {
			return err
		}
	}
	// Preserve the slot's upload grant while resolving its canonical asset ID.
	for _, slot := range []struct {
		id  *uuid.UUID
		raw string
	}{
		{branding.LogoMediaAssetID, branding.LogoURL},
		{branding.BgImageMediaAssetID, branding.BgImageURL},
	} {
		if err := s.authorizeMediaAssetAssignment(c, slot.id, slot.raw); err != nil {
			return err
		}
	}
	return nil
}

func mediaPublicationDenied(c *fiber.Ctx, err error) error {
	return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "code": "media_access_denied", "error": err.Error()})
}
