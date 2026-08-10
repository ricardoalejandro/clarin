package api

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

const whiteboardGuestCookiePrefix = "clarin-wb-guest-"

func whiteboardGuestCookieName(linkID uuid.UUID) string {
	return whiteboardGuestCookiePrefix + linkID.String()
}

func (s *Server) handleCreateWhiteboardShareLink(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		Label       string     `json:"label"`
		AccessLevel string     `json:"access_level"`
		Password    string     `json:"password"`
		AllowExport bool       `json:"allow_export"`
		ExpiresAt   *time.Time `json:"expires_at"`
		MaxSessions *int       `json:"max_sessions"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	request.Label = strings.TrimSpace(request.Label)
	if len(request.Label) > 160 {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	request.AccessLevel = strings.ToLower(strings.TrimSpace(request.AccessLevel))
	if request.AccessLevel == "" {
		request.AccessLevel = domain.WhiteboardAccessView
	}
	if request.ExpiresAt == nil {
		value := time.Now().UTC().Add(7 * 24 * time.Hour)
		request.ExpiresAt = &value
	} else if !request.ExpiresAt.After(time.Now().UTC()) || request.ExpiresAt.After(time.Now().UTC().Add(365*24*time.Hour)) {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	passwordHash, err := service.HashWhiteboardLinkPassword(request.Password)
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	plain, tokenHash, err := service.NewWhiteboardSecret()
	if err != nil {
		return whiteboardError(c, err)
	}
	link, err := s.repos.Whiteboard.CreateShareLink(c.Context(), accountID, actorID, boardID, repository.WhiteboardShareLinkInput{
		Label: request.Label, AccessLevel: request.AccessLevel, TokenHash: tokenHash,
		PasswordHash: passwordHash, AllowExport: request.AllowExport, ExpiresAt: request.ExpiresAt,
		MaxSessions: request.MaxSessions,
	})
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "share_link": link, "token": plain})
}

func (s *Server) handleListWhiteboardShareLinks(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	beforeCreatedAt, beforeID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListShareLinks(c.Context(), accountID, actorID, boardID,
		repository.WhiteboardTimeCursorOptions{BeforeCreatedAt: beforeCreatedAt, BeforeID: beforeID, Limit: whiteboardLimit(c)})
	if err != nil {
		return whiteboardError(c, err)
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardBoardCursor(last.CreatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "share_links": items, "next_cursor": nextCursor})
}

func (s *Server) handleRevokeWhiteboardShareLink(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	linkID, err := whiteboardPathID(c, "linkId")
	if err != nil {
		return whiteboardError(c, err)
	}
	if err := s.repos.Whiteboard.RevokeShareLink(c.Context(), accountID, actorID, boardID, linkID); err != nil {
		return whiteboardError(c, err)
	}
	var beforeCreatedAt *time.Time
	var beforeID *uuid.UUID
	for {
		sessions, hasMore, listErr := s.repos.Whiteboard.ListGuestSessions(c.Context(), accountID, actorID, boardID, linkID,
			repository.WhiteboardTimeCursorOptions{BeforeCreatedAt: beforeCreatedAt, BeforeID: beforeID, Limit: 200})
		if listErr != nil {
			return whiteboardError(c, listErr)
		}
		for _, session := range sessions {
			s.revokeWhiteboardGuestSockets(accountID, boardID, session.ID)
		}
		if !hasMore || len(sessions) == 0 {
			break
		}
		last := sessions[len(sessions)-1]
		createdAt, id := last.CreatedAt, last.ID
		beforeCreatedAt, beforeID = &createdAt, &id
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleListWhiteboardGuestSessions(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	linkID, err := whiteboardPathID(c, "linkId")
	if err != nil {
		return whiteboardError(c, err)
	}
	beforeCreatedAt, beforeID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListGuestSessions(c.Context(), accountID, actorID, boardID, linkID,
		repository.WhiteboardTimeCursorOptions{BeforeCreatedAt: beforeCreatedAt, BeforeID: beforeID, Limit: whiteboardLimit(c)})
	if err != nil {
		return whiteboardError(c, err)
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardBoardCursor(last.CreatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "sessions": items, "next_cursor": nextCursor})
}

func (s *Server) handleRevokeWhiteboardGuestSession(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	sessionID, err := whiteboardPathID(c, "sessionId")
	if err != nil {
		return whiteboardError(c, err)
	}
	if err := s.repos.Whiteboard.RevokeGuestSession(c.Context(), accountID, actorID, boardID, sessionID); err != nil {
		return whiteboardError(c, err)
	}
	s.revokeWhiteboardGuestSockets(accountID, boardID, sessionID)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleCreateWhiteboardGuestSession(c *fiber.Ctx) error {
	linkID, err := uuid.Parse(strings.TrimSpace(c.Params("id")))
	if err != nil || linkID == uuid.Nil {
		return whiteboardError(c, repository.ErrWhiteboardShareUnavailable)
	}
	var request struct {
		DisplayName string `json:"display_name"`
		Password    string `json:"password"`
		Secret      string `json:"secret"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	secret := strings.TrimSpace(request.Secret)
	if secret == "" || len(secret) > 256 || len(request.Password) > 200 {
		return whiteboardError(c, repository.ErrWhiteboardShareUnavailable)
	}
	name, err := service.NormalizeWhiteboardGuestName(request.DisplayName)
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	now := time.Now().UTC()
	link, err := s.repos.Whiteboard.GetActiveShareLinkByTokenHash(c.Context(), service.HashWhiteboardSecret(secret), now)
	if err != nil {
		return whiteboardError(c, err)
	}
	if link.Link.ID != linkID {
		return whiteboardError(c, repository.ErrWhiteboardShareUnavailable)
	}
	if !service.VerifyWhiteboardLinkPassword(link.PasswordHash, request.Password) {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "La contraseña no es válida", "code": "whiteboard_share_password_invalid"})
	}
	plainSession, sessionHash, err := service.NewWhiteboardSecret()
	if err != nil {
		return whiteboardError(c, err)
	}
	expiresAt := service.WhiteboardGuestExpiry(now, link.Link.ExpiresAt)
	session, err := s.repos.Whiteboard.CreateGuestSession(c.Context(), repository.WhiteboardGuestSessionInput{
		LinkID: link.Link.ID, TokenHash: sessionHash, DisplayName: name, ExpiresAt: expiresAt, Now: now,
	})
	if err != nil {
		return whiteboardError(c, err)
	}
	c.Cookie(&fiber.Cookie{
		Name:     whiteboardGuestCookieName(linkID),
		Value:    plainSession,
		Path:     "/api/whiteboard-guest",
		Expires:  session.ExpiresAt,
		HTTPOnly: true,
		Secure:   s.cfg.IsProduction(),
		SameSite: fiber.CookieSameSiteStrictMode,
	})
	scene, guest, err := s.repos.Whiteboard.GetSceneAsGuest(c.Context(), sessionHash, domain.WhiteboardAccessView, now)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"success": true,
		"session": fiber.Map{
			"id": session.ID, "display_name": session.DisplayName,
			"access_level": session.AccessLevel, "expires_at": session.ExpiresAt,
		},
		"scene": scene, "allow_export": guest.AllowExport,
	})
}

func whiteboardGuestSecret(c *fiber.Ctx, linkID uuid.UUID) (string, error) {
	secret := strings.TrimSpace(c.Cookies(whiteboardGuestCookieName(linkID)))
	if secret == "" || len(secret) > 256 {
		return "", repository.ErrWhiteboardSessionUnavailable
	}
	return secret, nil
}

func whiteboardGuestExpectedLinkID(c *fiber.Ctx) (uuid.UUID, error) {
	linkID, err := uuid.Parse(strings.TrimSpace(c.Query("link_id")))
	if err != nil || linkID == uuid.Nil {
		return uuid.Nil, repository.ErrWhiteboardSessionUnavailable
	}
	return linkID, nil
}

func (s *Server) handleGetWhiteboardGuestScene(c *fiber.Ctx) error {
	expectedLinkID, err := whiteboardGuestExpectedLinkID(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	secret, err := whiteboardGuestSecret(c, expectedLinkID)
	if err != nil {
		return whiteboardError(c, err)
	}
	scene, guest, err := s.repos.Whiteboard.GetSceneAsGuest(c.Context(), service.HashWhiteboardSecret(secret), domain.WhiteboardAccessView, time.Now().UTC())
	if err != nil {
		return whiteboardError(c, err)
	}
	if guest.Session.ShareLinkID != expectedLinkID {
		return whiteboardError(c, repository.ErrWhiteboardSessionUnavailable)
	}
	return c.JSON(fiber.Map{
		"success": true, "scene": scene, "allow_export": guest.AllowExport,
		"session": fiber.Map{
			"id": guest.Session.ID, "display_name": guest.Session.DisplayName,
			"access_level": guest.Session.AccessLevel, "expires_at": guest.Session.ExpiresAt,
		},
	})
}

func (s *Server) handlePutWhiteboardGuestScene(c *fiber.Ctx) error {
	expectedLinkID, err := whiteboardGuestExpectedLinkID(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	secret, err := whiteboardGuestSecret(c, expectedLinkID)
	if err != nil {
		return whiteboardError(c, err)
	}
	request, err := parseWhiteboardSceneWrite(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	tokenHash := service.HashWhiteboardSecret(secret)
	guest, err := s.repos.Whiteboard.ResolveGuestSession(c.Context(), tokenHash, domain.WhiteboardAccessEdit, time.Now().UTC())
	if err != nil {
		return whiteboardError(c, err)
	}
	if guest.Session.ShareLinkID != expectedLinkID {
		return whiteboardError(c, repository.ErrWhiteboardSessionUnavailable)
	}
	if err := s.checkWhiteboardGuestSnapshotPersistenceBudget(c, guest.Session.AccountID, guest.Session.BoardID); err != nil {
		return err
	}
	prepared, err := s.prepareAndUploadWhiteboardSnapshot(c.Context(), guest.Session.AccountID, guest.Session.BoardID, request.OperationID, request.Scene)
	if err != nil {
		return whiteboardError(c, err)
	}
	result, err := s.repos.Whiteboard.UpdateSceneAsGuest(c.Context(), tokenHash, repository.WhiteboardSceneWriteInput{
		ExpectedSequence: request.ExpectedSequence, OperationID: request.OperationID, Scene: request.Scene,
		SceneSchemaVersion: request.SceneSchemaVersion, EditorVersion: request.EditorVersion, WriteKind: "snapshot", RevisionKind: "automatic",
		ResultSceneHash: prepared.SceneHash, SnapshotObjectKey: prepared.ObjectKey,
		SnapshotContentHash: prepared.ContentHash, SnapshotSizeBytes: prepared.SizeBytes,
	}, time.Now().UTC())
	if err != nil {
		if prepared.UploadedByRequest {
			_ = s.repos.Whiteboard.MarkRevisionSnapshotFailed(c.Context(), guest.Session.AccountID, prepared.ObjectKey, "guest snapshot failed")
		}
		return whiteboardError(c, err)
	}
	s.broadcastWhiteboardMessage(guest.Session.AccountID, guest.Session.BoardID, whiteboardSceneSnapshotMessage(result.Scene), uuid.Nil)
	return c.JSON(fiber.Map{"success": true, "result": result})
}

func (s *Server) handlePatchWhiteboardGuestScene(c *fiber.Ctx) error {
	expectedLinkID, err := whiteboardGuestExpectedLinkID(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	secret, err := whiteboardGuestSecret(c, expectedLinkID)
	if err != nil {
		return whiteboardError(c, err)
	}
	request, err := parseWhiteboardSceneWrite(c)
	if err != nil || len(request.Patch) == 0 || !json.Valid(request.Patch) {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	tokenHash := service.HashWhiteboardSecret(secret)
	guest, err := s.repos.Whiteboard.ResolveGuestSession(c.Context(), tokenHash, domain.WhiteboardAccessEdit, time.Now().UTC())
	if err != nil {
		return whiteboardError(c, err)
	}
	if guest.Session.ShareLinkID != expectedLinkID {
		return whiteboardError(c, repository.ErrWhiteboardSessionUnavailable)
	}
	var patch whiteboardRealtimePatchData
	if err := json.Unmarshal(request.Patch, &patch); err != nil || len(patch.Elements) > whiteboardcore.MaxElementsPerPatch {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	patch.ClientBaseSequence = request.ExpectedSequence
	patch.AppState, err = whiteboardcore.SanitizePersistedAppState(patch.AppState)
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	var persistedAppState map[string]json.RawMessage
	if err := json.Unmarshal(patch.AppState, &persistedAppState); err != nil || (len(patch.Elements) == 0 && len(persistedAppState) == 0) {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	requestHash, err := whiteboardPatchRequestPayloadHash(request.ExpectedSequence, patch.Elements, patch.AppState)
	if err != nil {
		return whiteboardError(c, err)
	}
	if existing, existingGuest, found, findErr := s.repos.Whiteboard.FindSceneOperationAsGuest(c.Context(), tokenHash, request.OperationID, requestHash, time.Now().UTC()); findErr != nil {
		return whiteboardError(c, findErr)
	} else if found {
		if existingGuest.Session.ShareLinkID != expectedLinkID {
			return whiteboardError(c, repository.ErrWhiteboardSessionUnavailable)
		}
		return c.JSON(fiber.Map{"success": true, "result": existing})
	}
	current, _, err := s.repos.Whiteboard.GetSceneAsGuest(c.Context(), tokenHash, domain.WhiteboardAccessEdit, time.Now().UTC())
	if err != nil {
		return whiteboardError(c, err)
	}
	if request.ExpectedSequence != current.Sequence {
		return whiteboardError(c, &repository.WhiteboardConflictError{CurrentSequence: current.Sequence})
	}
	patch.BaseSequence = current.Sequence
	materialized, _, err := whiteboardcore.MaterializeScenePatch(current.Scene, patch.Elements, patch.AppState)
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	materialized, sceneHash, err := service.ValidateAndHashWhiteboardScene(materialized)
	if err != nil {
		return whiteboardError(c, err)
	}
	canonicalPatch, err := json.Marshal(patch)
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	result, err := s.repos.Whiteboard.ApplyScenePatchAsGuest(c.Context(), tokenHash, repository.WhiteboardSceneWriteInput{
		ExpectedSequence: current.Sequence, OperationID: request.OperationID, Scene: materialized,
		Patch: canonicalPatch, SceneSchemaVersion: current.SceneSchemaVersion,
		EditorVersion: whiteboardEditorVersion, RequestPayloadHash: requestHash, ResultSceneHash: sceneHash,
	}, time.Now().UTC())
	if err != nil {
		return whiteboardError(c, err)
	}
	if !result.Idempotent {
		operationID := request.OperationID
		actor := whiteboardcore.RealtimeActor{
			Kind: "guest", ID: uuid.New(), GuestID: &guest.Session.ID,
			DisplayName: guest.Session.DisplayName, Access: guest.Session.AccessLevel,
		}
		s.broadcastWhiteboardMessage(guest.Session.AccountID, guest.Session.BoardID, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventScenePatch, OperationID: &operationID,
			Sequence: result.Scene.Sequence, Actor: actor, Data: patch,
		}, uuid.Nil)
		s.scheduleWhiteboardCheckpoint(&whiteboardRealtimePrincipal{
			AccountID: guest.Session.AccountID, BoardID: guest.Session.BoardID,
			GuestSession: &guest.Session.ID, GuestTokenHash: tokenHash, Actor: actor,
		})
	}
	return c.JSON(fiber.Map{"success": true, "result": result})
}
