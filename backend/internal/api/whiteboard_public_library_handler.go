package api

import (
	"context"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

const whiteboardLibraryImportLifetime = 15 * time.Minute
const whiteboardLibraryNavigationCookieLifetime = 2 * time.Minute
const whiteboardLibraryImportCallbackMaxBytes = 4 * 1024
const whiteboardLibraryStartHeader = "X-Clarin-Whiteboard-Library-Start"
const whiteboardLibraryHandoffCookieName = "clarin_whiteboard_library_handoff"

var whiteboardPublicLibraryHTTPClient = service.NewPublicWhiteboardLibraryHTTPClient()

func (s *Server) guardWhiteboardLibraryImportMutation(c *fiber.Ctx) error {
	if rejected, err := rejectWhiteboardEncodedRequest(c); rejected {
		return err
	}
	if !whiteboardRequestWithinLimit(c, whiteboardLibraryImportCallbackMaxBytes) {
		return whiteboardRequestTooLarge(c, "whiteboard_library_import_payload_too_large", whiteboardLibraryImportCallbackMaxBytes)
	}
	return c.Next()
}

func normalizedWhiteboardBrowserOrigin(raw string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") {
		return "", false
	}
	scheme := strings.ToLower(parsed.Scheme)
	hostname := strings.ToLower(parsed.Hostname())
	if (scheme != "https" && scheme != "http") || hostname == "" {
		return "", false
	}
	port := parsed.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	host := hostname
	if port != "" {
		host = net.JoinHostPort(hostname, port)
	} else if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	return scheme + "://" + host, true
}

func (s *Server) exactWhiteboardStartOriginAllowed(raw string) bool {
	origin, ok := normalizedWhiteboardBrowserOrigin(raw)
	if !ok || s.cfg == nil {
		return false
	}
	candidates := append([]string{strings.TrimSpace(s.cfg.PublicURL)}, s.cfg.CORSOrigins...)
	for _, candidate := range candidates {
		if allowed, valid := normalizedWhiteboardBrowserOrigin(candidate); valid && origin == allowed {
			return true
		}
	}
	return false
}

func (s *Server) guardWhiteboardPublicLibraryStart(c *fiber.Ctx) error {
	origin := strings.TrimSpace(c.Get(fiber.HeaderOrigin))
	if strings.TrimSpace(c.Get(whiteboardLibraryStartHeader)) != "1" || origin == "" || !s.exactWhiteboardStartOriginAllowed(origin) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"success": false,
			"error":   "Inicio de importación no permitido",
			"code":    "whiteboard_library_import_start_required",
		})
	}
	return c.Next()
}

func validWhiteboardPublicLibraryNavigationMetadata(c *fiber.Ctx) bool {
	// Fetch Metadata is defense in depth only. Some production proxy paths
	// normalize or omit these browser-owned headers, while the path-bound
	// SameSite=Strict HttpOnly capability remains the actual authorization.
	// Reject only an unequivocal cross-site signal; all other requests still
	// need the unguessable cookie, authenticated actor and transactional scope.
	return !strings.EqualFold(strings.TrimSpace(c.Get("Sec-Fetch-Site")), "cross-site")
}

func (s *Server) guardWhiteboardPublicLibraryNavigation(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	c.Set("Referrer-Policy", "no-referrer")
	if !validWhiteboardPublicLibraryNavigationMetadata(c) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"success": false,
			"error":   "Navegación no permitida",
			"code":    "whiteboard_library_import_navigation_required",
		})
	}
	return c.Next()
}

func whiteboardPublicLibraryDirectoryURL(callbackURL, token string) (string, error) {
	callback, err := url.Parse(callbackURL)
	if err != nil || callback.Host == "" || token == "" {
		return "", repository.ErrWhiteboardInvalid
	}
	directory, _ := url.Parse(service.WhiteboardPublicLibraryOrigin + "/")
	query := directory.Query()
	query.Set("target", "_self")
	query.Set("referrer", callbackURL)
	query.Set("useHash", "true")
	query.Set("token", token)
	query.Set("theme", "light")
	query.Set("version", "2")
	query.Set("sort", "default")
	directory.RawQuery = query.Encode()
	return directory.String(), nil
}

func whiteboardPublicLibraryNavigationPath(boardID, importID uuid.UUID) (string, error) {
	if boardID == uuid.Nil || importID == uuid.Nil {
		return "", repository.ErrWhiteboardInvalid
	}
	return "/api/whiteboards/" + boardID.String() + "/public-library-imports/" + importID.String() + "/navigate", nil
}

func whiteboardLibraryHandoffCookie(path, value string, importExpiresAt, now time.Time, secure bool) *fiber.Cookie {
	expiresAt := now.Add(whiteboardLibraryNavigationCookieLifetime)
	if importExpiresAt.Before(expiresAt) {
		expiresAt = importExpiresAt
	}
	maxAge := int(expiresAt.Sub(now) / time.Second)
	return &fiber.Cookie{
		Name:     whiteboardLibraryHandoffCookieName,
		Value:    value,
		Path:     path,
		Expires:  expiresAt,
		MaxAge:   maxAge,
		HTTPOnly: true,
		Secure:   secure,
		SameSite: fiber.CookieSameSiteStrictMode,
	}
}

func clearWhiteboardLibraryHandoffCookie(path string, secure bool) *fiber.Cookie {
	return &fiber.Cookie{
		Name:     whiteboardLibraryHandoffCookieName,
		Value:    "",
		Path:     path,
		Expires:  time.Unix(1, 0).UTC(),
		MaxAge:   -1,
		HTTPOnly: true,
		Secure:   secure,
		SameSite: fiber.CookieSameSiteStrictMode,
	}
}

func (s *Server) whiteboardLibraryCallbackURL() (string, error) {
	candidates := []string{strings.TrimSpace(s.cfg.PublicURL)}
	candidates = append(candidates, s.cfg.CORSOrigins...)
	for _, candidate := range candidates {
		parsed, err := url.Parse(strings.TrimSpace(candidate))
		if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
			continue
		}
		if s.cfg.IsProduction() && parsed.Scheme != "https" {
			continue
		}
		parsed.Path = "/whiteboards/library-import"
		parsed.RawPath = ""
		return parsed.String(), nil
	}
	return "", repository.ErrWhiteboardInvalid
}

func (s *Server) handleStartWhiteboardPublicLibraryImport(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	if err := s.checkAbuseLimits(c, "whiteboard_library_import_rate_limited", actorID.String(), []abuseLimit{
		{Key: "abuse:whiteboard-library-import:actor:minute:" + accountID.String() + ":" + actorID.String(), Max: 10, Window: time.Minute},
		{Key: "abuse:whiteboard-library-import:ip:minute:" + hashForLog(clientIP(c)), Max: 20, Window: time.Minute},
		{Key: "abuse:whiteboard-library-import:actor:hour:" + accountID.String() + ":" + actorID.String(), Max: 60, Window: time.Hour},
	}); err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	libraryID, err := uuid.Parse(strings.TrimSpace(c.Query("library_id")))
	if err != nil || libraryID == uuid.Nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	token, _, err := service.NewWhiteboardSecret()
	if err != nil {
		return whiteboardError(c, err)
	}
	// Fail before persisting a handoff when this deployment cannot construct
	// the generic callback that the catalog will receive.
	if _, err := s.whiteboardLibraryCallbackURL(); err != nil {
		return whiteboardError(c, err)
	}
	tokenHash := service.HashWhiteboardLibraryNavigationSecret(token)
	now := time.Now().UTC()
	item, err := s.repos.Whiteboard.StartWhiteboardLibraryImport(c.Context(), accountID, actorID, boardID, libraryID,
		repository.WhiteboardLibraryImportStartInput{TokenHash: tokenHash, ExpiresAt: now.Add(whiteboardLibraryImportLifetime)})
	if err != nil {
		return whiteboardError(c, err)
	}
	navigationPath, err := whiteboardPublicLibraryNavigationPath(boardID, item.ID)
	if err != nil {
		return whiteboardError(c, err)
	}
	c.Cookie(whiteboardLibraryHandoffCookie(navigationPath, token, item.ExpiresAt, now, s.cfg.IsProduction()))
	c.Set(fiber.HeaderCacheControl, "no-store")
	c.Set("Referrer-Policy", "no-referrer")
	return c.JSON(fiber.Map{"success": true, "navigation_path": navigationPath})
}

func (s *Server) handleNavigateWhiteboardPublicLibraryImport(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	importID, err := whiteboardPathID(c, "importId")
	if err != nil {
		return whiteboardError(c, err)
	}
	navigationPath, err := whiteboardPublicLibraryNavigationPath(boardID, importID)
	if err != nil {
		return whiteboardError(c, err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	c.Set("Referrer-Policy", "no-referrer")
	token := strings.TrimSpace(c.Cookies(whiteboardLibraryHandoffCookieName))
	c.Cookie(clearWhiteboardLibraryHandoffCookie(navigationPath, s.cfg.IsProduction()))
	if len(token) < 32 || len(token) > 128 {
		return whiteboardError(c, repository.ErrWhiteboardNotFound)
	}
	callbackToken, _, err := service.NewWhiteboardSecret()
	if err != nil {
		return whiteboardError(c, err)
	}
	if callbackToken == token {
		return whiteboardError(c, repository.ErrWhiteboardConflict)
	}
	callbackURL, err := s.whiteboardLibraryCallbackURL()
	if err != nil {
		return whiteboardError(c, err)
	}
	directoryURL, err := whiteboardPublicLibraryDirectoryURL(callbackURL, callbackToken)
	if err != nil {
		return whiteboardError(c, err)
	}
	if err := s.repos.Whiteboard.RotateWhiteboardLibraryImportNavigation(c.Context(), accountID, actorID,
		boardID, importID, service.HashWhiteboardLibraryNavigationSecret(token),
		service.HashWhiteboardLibraryCallbackSecret(callbackToken), time.Now().UTC()); err != nil {
		return whiteboardError(c, err)
	}
	return c.Redirect(directoryURL, fiber.StatusFound)
}

func (s *Server) handleWhiteboardPublicLibraryCallback(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	if err := s.checkAbuseLimits(c, "whiteboard_library_import_callback_rate_limited", actorID.String(), []abuseLimit{
		{Key: "abuse:whiteboard-library-callback:actor:minute:" + accountID.String() + ":" + actorID.String(), Max: 20, Window: time.Minute},
		{Key: "abuse:whiteboard-library-callback:ip:minute:" + hashForLog(clientIP(c)), Max: 40, Window: time.Minute},
	}); err != nil {
		return err
	}
	var request struct {
		Token      string `json:"token"`
		LibraryURL string `json:"library_url"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	request.Token = strings.TrimSpace(request.Token)
	request.LibraryURL = strings.TrimSpace(request.LibraryURL)
	if len(request.Token) < 32 || len(request.Token) > 128 {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	if _, err := service.ValidatePublicWhiteboardLibraryURL(request.LibraryURL); err != nil {
		return whiteboardError(c, err)
	}
	tokenHash := service.HashWhiteboardLibraryCallbackSecret(request.Token)
	callbackBoardID, err := s.repos.Whiteboard.WhiteboardLibraryImportCallbackBoard(c.Context(), accountID, actorID, tokenHash)
	if err != nil {
		return whiteboardError(c, err)
	}
	if _, err := s.repos.Whiteboard.RequireActiveAccess(c.Context(), accountID, actorID, callbackBoardID, domain.WhiteboardAccessView); err != nil {
		return whiteboardError(c, err)
	}
	if !s.workWhiteboardViewsEnabled() {
		contextual, originErr := s.repos.Whiteboard.IsWorkOrigin(c.Context(), accountID, callbackBoardID)
		if originErr != nil {
			return whiteboardError(c, originErr)
		}
		if contextual {
			return whiteboardError(c, repository.ErrWhiteboardNotFound)
		}
	}
	item, idempotent, err := s.repos.Whiteboard.ClaimWhiteboardLibraryImport(c.Context(), accountID, actorID,
		tokenHash, time.Now().UTC())
	if err != nil {
		return whiteboardError(c, err)
	}
	if item.AccountID != accountID {
		return whiteboardError(c, repository.ErrWhiteboardNotFound)
	}
	if !idempotent {
		fetchCtx, cancel := context.WithTimeout(c.Context(), 12*time.Second)
		libraryJSON, sourceURL, fetchErr := service.FetchPublicWhiteboardLibrary(fetchCtx, whiteboardPublicLibraryHTTPClient, request.LibraryURL)
		cancel()
		if fetchErr != nil {
			_ = s.repos.Whiteboard.MarkWhiteboardLibraryImportFailed(c.Context(), accountID, actorID, item.ID, "fetch_or_validation_failed")
			return whiteboardError(c, fetchErr)
		}
		libraryJSON, fetchErr = service.NamespacePublicWhiteboardLibraryItems(libraryJSON, item.ID)
		if fetchErr != nil {
			_ = s.repos.Whiteboard.MarkWhiteboardLibraryImportFailed(c.Context(), accountID, actorID, item.ID, "item_namespace_failed")
			return whiteboardError(c, fetchErr)
		}
		if !s.workWhiteboardViewsEnabled() {
			if _, accessErr := s.repos.Whiteboard.RequireActiveAccess(c.Context(), accountID, actorID, item.BoardID, domain.WhiteboardAccessView); accessErr != nil {
				return whiteboardError(c, accessErr)
			}
			contextual, originErr := s.repos.Whiteboard.IsWorkOrigin(c.Context(), accountID, item.BoardID)
			if originErr != nil {
				return whiteboardError(c, originErr)
			}
			if contextual {
				_ = s.repos.Whiteboard.MarkWhiteboardLibraryImportFailed(c.Context(), accountID, actorID, item.ID, "work_whiteboard_views_disabled")
				return whiteboardError(c, repository.ErrWhiteboardNotFound)
			}
		}
		item, err = s.repos.Whiteboard.MarkWhiteboardLibraryImportReady(c.Context(), accountID, actorID, item.ID, sourceURL, libraryJSON)
		if err != nil {
			return whiteboardError(c, err)
		}
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{"success": true, "import_id": item.ID, "board_id": item.BoardID})
}

func (s *Server) handleGetWhiteboardPublicLibraryImport(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	importID, err := whiteboardPathID(c, "importId")
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.GetWhiteboardLibraryImport(c.Context(), accountID, actorID, boardID, importID, time.Now().UTC())
	if err != nil {
		return whiteboardError(c, err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{"success": true, "import": item})
}

func (s *Server) handleCompleteWhiteboardPublicLibraryImport(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	importID, err := whiteboardPathID(c, "importId")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		OperationID    uuid.UUID `json:"operation_id"`
		LibraryVersion int64     `json:"library_version"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	item, err := s.repos.Whiteboard.CompleteWhiteboardLibraryImport(c.Context(), accountID, actorID, boardID, importID,
		request.OperationID, request.LibraryVersion, time.Now().UTC())
	if err != nil {
		return whiteboardError(c, err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{"success": true, "import": item})
}
