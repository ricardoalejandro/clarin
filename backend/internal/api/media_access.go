package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
)

const mediaGrantLifetime = 30 * time.Minute

// Capabilities are emitted only by already-authorized upload or public-resource
// handlers. They never authorize another object, account, or protected namespace.
type mediaAccessGrant struct {
	Purpose    string    `json:"p"`
	AccountID  uuid.UUID `json:"a"`
	ObjectKey  string    `json:"k"`
	Expires    int64     `json:"e"`
	UserID     uuid.UUID `json:"u,omitempty"`
	SessionID  string    `json:"s,omitempty"`
	ResourceID uuid.UUID `json:"r,omitempty"`
	LinkID     uuid.UUID `json:"l,omitempty"`
}

func ordinaryMediaKeyAccount(key string) (uuid.UUID, bool) {
	if key == "" || strings.TrimSpace(key) != key || strings.ContainsAny(key, "\\\x00\r\n") || storage.IsProtectedMediaObjectKey(key) {
		return uuid.Nil, false
	}
	parts := strings.Split(key, "/")
	if len(parts) < 2 {
		return uuid.Nil, false
	}
	accountID, err := uuid.Parse(parts[0])
	if err != nil || accountID == uuid.Nil || parts[0] != accountID.String() {
		return uuid.Nil, false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return uuid.Nil, false
		}
	}
	return accountID, true
}

func signMediaAccessGrant(secret string, grant mediaAccessGrant) string {
	if secret == "" {
		return ""
	}
	data, _ := json.Marshal(grant)
	payload := base64.RawURLEncoding.EncodeToString(data)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("clarin-media-v1." + payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func verifyMediaAccessGrant(secret, token, objectKey string, now time.Time) (*mediaAccessGrant, error) {
	denied := errors.New("invalid media capability")
	if secret == "" || len(token) > 8192 {
		return nil, denied
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil, denied
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, denied
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("clarin-media-v1." + parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, denied
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, denied
	}
	var grant mediaAccessGrant
	if json.Unmarshal(data, &grant) != nil {
		return nil, denied
	}
	accountID, valid := ordinaryMediaKeyAccount(objectKey)
	if !valid || grant.AccountID != accountID || grant.ObjectKey != objectKey || grant.Expires <= now.Unix() || grant.Expires > now.Add(mediaGrantLifetime).Unix() {
		return nil, denied
	}
	switch grant.Purpose {
	case "upload-preview":
		if grant.UserID == uuid.Nil || grant.SessionID == "" {
			return nil, denied
		}
	case "survey-branding", "dynamic-public":
		if grant.ResourceID == uuid.Nil {
			return nil, denied
		}
	default:
		return nil, denied
	}
	return &grant, nil
}

func privateMediaPreviewAllowed(grant *mediaAccessGrant, claims *service.JWTClaims) bool {
	return grant != nil && claims != nil && grant.Purpose == "upload-preview" && grant.AccountID == claims.AccountID && grant.UserID == claims.UserID && grant.SessionID == claims.SessionID
}

func (s *Server) uploadPreviewURL(c *fiber.Ctx, objectKey string) string {
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	accountID, valid := ordinaryMediaKeyAccount(objectKey)
	if !ok || !valid || claims.AccountID != accountID || claims.SessionID == "" {
		return mediaProxyURLFromObjectKey(objectKey)
	}
	grant := mediaAccessGrant{Purpose: "upload-preview", AccountID: accountID, ObjectKey: objectKey, Expires: time.Now().Add(mediaGrantLifetime).Unix(), UserID: claims.UserID, SessionID: claims.SessionID}
	return mediaProxyURLFromObjectKey(objectKey) + "?media_preview=" + signMediaAccessGrant(s.cfg.JWTSecret, grant)
}

// publicResourceMediaURL accepts only exact account-owned ordinary object URLs.
// External content is preserved; a cross-account or private Clarin URL is omitted.
func (s *Server) publicResourceMediaURL(raw string, grant mediaAccessGrant) string {
	key, stored := s.ordinaryObjectKeyFromURL(raw)
	if !stored {
		return raw
	}
	accountID, valid := ordinaryMediaKeyAccount(key)
	if !valid || accountID != grant.AccountID {
		return ""
	}
	grant.ObjectKey = key
	grant.Expires = time.Now().Add(mediaGrantLifetime).Unix()
	return mediaProxyURLFromObjectKey(key) + "?media_access=" + signMediaAccessGrant(s.cfg.JWTSecret, grant)
}

func (s *Server) ordinaryObjectKeyFromURL(raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	// Existing proxy URLs (including persisted expired preview capabilities) have
	// one canonical object identity; never accept a raw unscoped key from a URL.
	if s.isLocalMediaProxyURL(parsed) && strings.HasPrefix(parsed.Path, "/api/media/file/") {
		return strings.TrimPrefix(parsed.Path, "/api/media/file/"), true
	}
	if s.storage != nil {
		return s.storage.OrdinaryObjectKeyFromURL(raw)
	}
	return "", false
}

func (s *Server) sameOrdinaryMediaKey(raw, key string) bool {
	candidate, stored := s.ordinaryObjectKeyFromURL(raw)
	return stored && candidate == key
}

// Revalidate the publication on every GET. Closing/deleting a public resource
// or replacing its image immediately revokes old capabilities, before expiry.
func (s *Server) publicMediaGrantCurrent(ctx context.Context, grant *mediaAccessGrant) bool {
	if s.repos == nil {
		return false
	}
	switch grant.Purpose {
	case "survey-branding":
		survey, err := s.repos.Survey.GetByID(ctx, grant.ResourceID, grant.AccountID)
		if err != nil || survey == nil || survey.Status != "active" || survey.ArchivedAt != nil || survey.IsTemplate {
			return false
		}
		now := time.Now()
		if survey.OpensAt != nil && now.Before(*survey.OpensAt) || survey.ClosesAt != nil && !now.Before(*survey.ClosesAt) {
			return false
		}
		return s.sameOrdinaryMediaKey(survey.Branding.LogoURL, grant.ObjectKey) || s.sameOrdinaryMediaKey(survey.Branding.BgImageURL, grant.ObjectKey)
	case "dynamic-public":
		dynamic, err := s.repos.Dynamic.GetByID(ctx, grant.ResourceID, grant.AccountID)
		if err != nil || dynamic == nil || !dynamic.IsActive {
			return false
		}
		if grant.LinkID != uuid.Nil {
			link, parent, err := s.repos.Dynamic.GetLinkByID(ctx, grant.LinkID)
			if err != nil || link == nil || parent == nil || parent.AccountID != grant.AccountID || parent.ID != grant.ResourceID || !link.IsActive {
				return false
			}
			now := time.Now()
			if link.StartsAt != nil && now.Before(*link.StartsAt) || link.EndsAt != nil && !now.Before(*link.EndsAt) {
				return false
			}
			if s.sameOrdinaryMediaKey(link.ExtraMessageMediaURL, grant.ObjectKey) {
				return true
			}
			for _, media := range link.ExtraMedia {
				if s.sameOrdinaryMediaKey(media.URL, grant.ObjectKey) {
					return true
				}
			}
		}
		if s.sameOrdinaryMediaKey(dynamic.Config.OverlayImageURL, grant.ObjectKey) {
			return true
		}
		items, err := s.repos.Dynamic.ListActiveItems(ctx, dynamic.ID)
		if err != nil {
			return false
		}
		for _, item := range items {
			if s.sameOrdinaryMediaKey(item.ImageURL, grant.ObjectKey) {
				return true
			}
		}
	}
	return false
}

func (s *Server) authorizeOrdinaryMedia(c *fiber.Ctx, objectKey string) bool {
	accountID, valid := ordinaryMediaKeyAccount(objectKey)
	if !valid || s.cfg == nil {
		return false
	}
	if grant, err := verifyMediaAccessGrant(s.cfg.JWTSecret, c.Query("media_access"), objectKey, time.Now()); err == nil && grant.Purpose != "upload-preview" && s.publicMediaGrantCurrent(c.Context(), grant) {
		return true
	}
	token := authTokenFromRequest(c)
	if token == "" || s.services == nil || s.services.Auth == nil {
		return false
	}
	claims, err := s.services.Auth.ValidateTokenReadOnly(c.Context(), token, s.cfg.JWTSecret)
	if err != nil || claims.AccountID != accountID {
		return false
	}
	if s.hydrateAccountScopedClaims(c.Context(), claims) != nil {
		return false
	}
	refs, err := storageSelfServiceObjectReferences(c.Context(), s.repos.DB(), accountID, objectKey, s.storage)
	if err != nil {
		return false
	}
	if len(refs) > 0 && storageSelfServiceCanRead(claims, refs) {
		return true
	}
	if grant, err := verifyMediaAccessGrant(s.cfg.JWTSecret, c.Query("media_preview"), objectKey, time.Now()); err == nil && privateMediaPreviewAllowed(grant, claims) {
		// A persisted draft URL must not keep a removed attachment accessible.
		// Restoration/retention previews have their own actor-authorized endpoint.
		var removed bool
		if err := s.repos.DB().QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state IN ('trash','purging','purged'))`, accountID, objectKey).Scan(&removed); err != nil {
			return false
		}
		return !removed
	}
	return false
}

func (s *Server) publishSurveyBranding(survey *domain.Survey) domain.SurveyBranding {
	branding := survey.Branding
	grant := mediaAccessGrant{Purpose: "survey-branding", AccountID: survey.AccountID, ResourceID: survey.ID}
	branding.LogoURL = s.publicResourceMediaURL(branding.LogoURL, grant)
	branding.BgImageURL = s.publicResourceMediaURL(branding.BgImageURL, grant)
	return branding
}
