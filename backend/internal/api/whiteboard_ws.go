package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

const (
	whiteboardRealtimePrincipalLocal = "whiteboard_realtime_principal"
	whiteboardWriteWait              = 10 * time.Second
	whiteboardPongWait               = 60 * time.Second
	whiteboardPingInterval           = 30 * time.Second
	whiteboardAutomaticRevisionEvery = 5 * time.Minute
	whiteboardRealtimeDBTimeout      = 15 * time.Second
	whiteboardEditorVersion          = "0.18.1"
)

type whiteboardRealtimePrincipal struct {
	AccountID               uuid.UUID
	BoardID                 uuid.UUID
	UserID                  *uuid.UUID
	GuestSession            *uuid.UUID
	GuestTokenHash          string
	Claims                  *service.JWTClaims
	Actor                   whiteboardcore.RealtimeActor
	LastEphemeralValidation time.Time
	ExpiresAt               time.Time
}

type whiteboardRealtimePatchData struct {
	BaseSequence       int64             `json:"base_sequence"`
	ClientBaseSequence int64             `json:"client_base_sequence,omitempty"`
	Elements           []json.RawMessage `json:"elements"`
	AppState           json.RawMessage   `json:"app_state,omitempty"`
}

func whiteboardPatchRequestPayloadHash(clientBaseSequence int64, elements []json.RawMessage, appState json.RawMessage) (string, error) {
	payload, err := json.Marshal(struct {
		ClientBaseSequence int64             `json:"client_base_sequence"`
		Elements           []json.RawMessage `json:"elements"`
		AppState           json.RawMessage   `json:"app_state"`
	}{ClientBaseSequence: clientBaseSequence, Elements: elements, AppState: appState})
	if err != nil {
		return "", err
	}
	return service.HashWhiteboardOperationPayload(payload)
}

type whiteboardCheckpointEntry struct {
	timer     *time.Timer
	principal *whiteboardRealtimePrincipal
}

var errWhiteboardRealtimeRateLimited = errors.New("whiteboard realtime room rate limited")

func (s *Server) whiteboardWSUpgrade(c *fiber.Ctx) error {
	if !websocket.IsWebSocketUpgrade(c) {
		return fiber.ErrUpgradeRequired
	}
	if origin := strings.TrimSpace(c.Get(fiber.HeaderOrigin)); origin != "" && !s.isAllowedRequestOriginForRequest(c, origin) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "Origin not allowed"})
	}
	boardID, err := uuid.Parse(strings.TrimSpace(c.Params("id")))
	if err != nil || boardID == uuid.Nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Recurso no encontrado"})
	}
	principal, err := s.consumeWhiteboardCollabTicket(c, boardID)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "Collaboration ticket unavailable"})
	}
	if err := s.validateWhiteboardRealtimeAccess(c.Context(), principal, domain.WhiteboardAccessView); err != nil {
		return whiteboardError(c, err)
	}
	c.Locals(whiteboardRealtimePrincipalLocal, principal)
	return c.Next()
}

func (s *Server) whiteboardModuleAllowed(ctx context.Context, claims *service.JWTClaims) bool {
	if claims == nil {
		return false
	}
	if claims.IsSuperAdmin || claims.Role == domain.RoleSuperAdmin {
		return true
	}
	membership, err := s.repos.UserAccount.GetByUserAndAccount(ctx, claims.UserID, claims.AccountID)
	if err != nil || membership == nil {
		return false
	}
	if membership.Role == domain.RoleAdmin || membership.Role == domain.RoleSuperAdmin {
		return true
	}
	permissions, err := s.repos.UserAccount.GetUserPermissions(ctx, claims.UserID, claims.AccountID)
	if err != nil {
		return false
	}
	for _, permission := range permissions {
		if permission == domain.PermAll || permission == domain.PermWhiteboards {
			return true
		}
	}
	return false
}

func (s *Server) handleWhiteboardWebSocket(conn *websocket.Conn) {
	principal, ok := conn.Locals(whiteboardRealtimePrincipalLocal).(*whiteboardRealtimePrincipal)
	if !ok || principal == nil {
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "unauthorized"), time.Now().Add(whiteboardWriteWait))
		_ = conn.Close()
		return
	}
	if s.whiteboardRooms == nil {
		s.whiteboardRooms = whiteboardcore.NewRoomHub()
	}

	ctx, cancel := context.WithTimeout(context.Background(), whiteboardRealtimeDBTimeout)
	initialScene, err := s.whiteboardRealtimeScene(ctx, principal, domain.WhiteboardAccessView)
	cancel()
	if err != nil {
		_ = conn.WriteJSON(whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: "scene_unavailable", Error: "No se pudo cargar la pizarra"})
		_ = conn.Close()
		return
	}

	client := &whiteboardcore.RealtimeClient{
		ID:        uuid.New(),
		AccountID: principal.AccountID,
		BoardID:   principal.BoardID,
		Actor:     principal.Actor,
		Send:      make(chan []byte, 64),
	}
	presenceCtx, presenceCancel := context.WithTimeout(context.Background(), whiteboardRealtimeDBTimeout)
	err = s.registerWhiteboardPresence(presenceCtx, client)
	presenceCancel()
	if err != nil {
		code := "presence_unavailable"
		message := "No se pudo abrir la sala de colaboración"
		if errors.Is(err, whiteboardcore.ErrRoomCapacity) {
			code = "room_capacity"
			message = "La sala alcanzó su límite global de conexiones"
		}
		_ = conn.WriteJSON(whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: code, Error: message})
		_ = conn.Close()
		return
	}
	if err := s.whiteboardRooms.Register(client); err != nil {
		s.unregisterWhiteboardPresence(client)
		_ = conn.WriteJSON(whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: "room_capacity", Error: "La sala alcanzó su límite de conexiones"})
		_ = conn.Close()
		return
	}
	presenceCtx, presenceCancel = context.WithTimeout(context.Background(), whiteboardRealtimeDBTimeout)
	presence, err := s.whiteboardPresence(presenceCtx, principal.AccountID, principal.BoardID)
	presenceCancel()
	if err != nil {
		s.whiteboardRooms.Unregister(client.ID, principal.BoardID)
		s.unregisterWhiteboardPresence(client)
		_ = conn.WriteJSON(whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: "presence_unavailable", Error: "No se pudo sincronizar la presencia de la sala"})
		_ = conn.Close()
		return
	}

	writerDone := make(chan struct{})
	go s.writeWhiteboardSocket(conn, client, principal, writerDone)
	s.queueWhiteboardMessage(client, whiteboardSceneSnapshotMessage(initialScene))
	s.queueWhiteboardMessage(client, whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventPresenceSnapshot,
		Data:  presence,
	})
	s.broadcastWhiteboardMessage(principal.AccountID, principal.BoardID, whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventPresenceUpdate,
		Actor: principal.Actor,
		Data:  map[string]any{"status": "joined"},
	}, client.ID)

	defer func() {
		s.whiteboardRooms.Unregister(client.ID, principal.BoardID)
		s.unregisterWhiteboardPresence(client)
		s.broadcastWhiteboardMessage(principal.AccountID, principal.BoardID, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventPresenceUpdate,
			Actor: principal.Actor,
			Data:  map[string]any{"status": "left"},
		}, client.ID)
		<-writerDone
		_ = conn.Close()
		if s.whiteboardRooms.Count(principal.AccountID, principal.BoardID) == 0 {
			s.flushWhiteboardCheckpoint(principal.AccountID, principal.BoardID)
		}
	}()

	conn.SetReadLimit(whiteboardcore.MaxRealtimeMessageBytes)
	_ = conn.SetReadDeadline(time.Now().Add(whiteboardPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(whiteboardPongWait))
	})
	limiter := whiteboardcore.NewEventRateLimiter()
	violations := 0
	for {
		messageType, payload, readErr := conn.ReadMessage()
		if readErr != nil {
			break
		}
		if messageType != websocket.TextMessage {
			violations++
			s.queueWhiteboardError(client, "text_messages_only", "Solo se admiten mensajes JSON de texto")
			if violations >= 5 {
				break
			}
			continue
		}
		incoming, decodeErr := whiteboardcore.DecodeIncoming(payload)
		if decodeErr != nil {
			violations++
			s.queueWhiteboardError(client, "invalid_message", "Mensaje de colaboración inválido")
			if violations >= 5 {
				break
			}
			continue
		}
		if !limiter.Allow(incoming.Event, time.Now()) {
			violations++
			s.queueWhiteboardOperationError(client, incoming.OperationID, "rate_limited", "Demasiados eventos de colaboración")
			if violations >= 5 {
				break
			}
			continue
		}

		eventCtx, eventCancel := context.WithTimeout(context.Background(), whiteboardRealtimeDBTimeout)
		handleErr := s.handleWhiteboardRealtimeMessage(eventCtx, principal, client, incoming)
		eventCancel()
		if handleErr != nil {
			if errors.Is(handleErr, errWhiteboardRealtimeRateLimited) {
				s.queueWhiteboardOperationError(client, incoming.OperationID, "rate_limited", "La sala está recibiendo demasiados cambios")
				continue
			}
			if errors.Is(handleErr, repository.ErrWhiteboardNotFound) || errors.Is(handleErr, repository.ErrWhiteboardForbidden) || errors.Is(handleErr, repository.ErrWhiteboardSessionUnavailable) {
				s.queueWhiteboardMessage(client, whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "access_revoked", Error: "El acceso a la pizarra fue revocado"})
				break
			}
			var conflict *repository.WhiteboardConflictError
			if errors.As(handleErr, &conflict) {
				operationID := uuid.Nil
				if incoming.OperationID != nil {
					operationID = *incoming.OperationID
				}
				conflictKind := "retry_exhausted"
				if incoming.BaseSequence > conflict.CurrentSequence {
					conflictKind = "future_base"
				}
				logWhiteboardSceneConflict("websocket", principal.AccountID, principal.BoardID, operationID, conflictKind, incoming.BaseSequence, &conflict.CurrentSequence)
				snapshotCtx, snapshotCancel := context.WithTimeout(context.Background(), whiteboardRealtimeDBTimeout)
				scene, sceneErr := s.whiteboardRealtimeScene(snapshotCtx, principal, domain.WhiteboardAccessView)
				snapshotCancel()
				if sceneErr == nil {
					s.queueWhiteboardMessage(client, whiteboardSceneSnapshotMessage(scene))
				} else {
					s.queueWhiteboardError(client, "scene_conflict", "La escena cambió; vuelve a sincronizar")
				}
				s.queueWhiteboardOperationError(client, incoming.OperationID, "scene_conflict", "La escena cambió; Clarin reintentará por el canal persistente")
				continue
			}
			operationID := uuid.Nil
			if incoming.OperationID != nil {
				operationID = *incoming.OperationID
			}
			log.Printf("[WHITEBOARD WRITE] transport=websocket account=%s board=%s operation=%s code=%s err=%v",
				principal.AccountID, principal.BoardID, operationID, whiteboardWriteFailureCode(handleErr), handleErr)
			s.queueWhiteboardOperationError(client, incoming.OperationID, whiteboardWriteFailureCode(handleErr), "No se pudo aplicar el cambio en tiempo real")
			continue
		}
	}
}

func (s *Server) handleWhiteboardRealtimeMessage(ctx context.Context, principal *whiteboardRealtimePrincipal, client *whiteboardcore.RealtimeClient, incoming whiteboardcore.IncomingMessage) error {
	switch incoming.Event {
	case whiteboardcore.EventScenePatch:
		if !s.allowWhiteboardRoomPatch(ctx, principal.AccountID, principal.BoardID) {
			return errWhiteboardRealtimeRateLimited
		}
		if err := s.validateWhiteboardRealtimeAccess(ctx, principal, domain.WhiteboardAccessEdit); err != nil {
			return err
		}
		result, outgoing, err := s.applyWhiteboardRealtimePatch(ctx, principal, incoming)
		if err != nil {
			return err
		}
		for _, message := range whiteboardRealtimePatchAckMessages(result, outgoing, incoming.BaseSequence, incoming.OperationID) {
			s.queueWhiteboardMessage(client, message)
		}
		if !result.Idempotent {
			s.broadcastWhiteboardMessage(principal.AccountID, principal.BoardID, outgoing, client.ID)
			s.scheduleWhiteboardCheckpoint(principal)
		}
		return nil
	case whiteboardcore.EventSyncRequest:
		if !s.allowWhiteboardRoomSync(ctx, principal.AccountID, principal.BoardID) {
			return errWhiteboardRealtimeRateLimited
		}
		if err := s.validateWhiteboardRealtimeAccess(ctx, principal, domain.WhiteboardAccessView); err != nil {
			return err
		}
		return s.syncWhiteboardRealtimeClient(ctx, principal, client, incoming.BaseSequence)
	case whiteboardcore.EventCursorUpdate, whiteboardcore.EventPresenceUpdate:
		if err := s.validateWhiteboardRealtimeEphemeralAccess(ctx, principal); err != nil {
			return err
		}
		outgoing := whiteboardcore.OutgoingMessage{Event: incoming.Event, Actor: principal.Actor, Data: json.RawMessage(incoming.Data)}
		s.broadcastWhiteboardMessage(principal.AccountID, principal.BoardID, outgoing, client.ID)
		return nil
	default:
		return whiteboardcore.ErrInvalidRealtimeMessage
	}
}

// whiteboardRealtimePatchAckData returns a canonical scene only when the
// server had to apply the client delta on top of a newer sequence, or when a
// retry found the operation already committed. Without this resync, a client
// can advance directly from its stale base to the ACK sequence and then ignore
// the intervening patches as old, leaving it visually incomplete and allowing
// a later full snapshot to overwrite concurrent work.
func whiteboardRealtimePatchAckData(result *domain.WhiteboardSceneWriteResult, outgoing whiteboardcore.OutgoingMessage, clientBaseSequence int64) map[string]any {
	data := map[string]any{"idempotent": result != nil && result.Idempotent}
	if result == nil || result.Scene == nil {
		return data
	}
	serverBaseSequence := clientBaseSequence
	if patch, ok := outgoing.Data.(whiteboardRealtimePatchData); ok {
		serverBaseSequence = patch.BaseSequence
	}
	if !result.Idempotent && clientBaseSequence >= serverBaseSequence {
		return data
	}
	data["rebased"] = true
	if whiteboardSceneSnapshotMessage(result.Scene).Event == whiteboardcore.EventSyncRequired {
		// Keep the ACK bounded. The operation is durable, but the client must
		// reload the canonical scene over its authenticated REST surface before
		// continuing from the acknowledged sequence.
		data["sync_required"] = true
		return data
	}
	data["scene"] = result.Scene.Scene
	data["scene_schema_version"] = result.Scene.SceneSchemaVersion
	data["editor_version"] = result.Scene.EditorVersion
	data["updated_at"] = result.Scene.UpdatedAt
	return data
}

func whiteboardRealtimePatchAckMessages(result *domain.WhiteboardSceneWriteResult, outgoing whiteboardcore.OutgoingMessage, clientBaseSequence int64, operationID *uuid.UUID) []whiteboardcore.OutgoingMessage {
	sequence := int64(0)
	if result != nil {
		sequence = result.OperationSequence
	}
	data := whiteboardRealtimePatchAckData(result, outgoing, clientBaseSequence)
	messages := []whiteboardcore.OutgoingMessage{{
		Event: whiteboardcore.EventAck, OperationID: operationID, Sequence: sequence, Data: data,
	}}
	if syncRequired, _ := data["sync_required"].(bool); syncRequired {
		messages = append(messages, whiteboardSceneSyncRequiredMessage(sequence, "canonical_ack_too_large"))
	}
	return messages
}

func (s *Server) allowWhiteboardRoomPatch(ctx context.Context, accountID, boardID uuid.UUID) bool {
	roomCount, err := s.incrementAbuseCounter(ctx, "abuse:whiteboard-ws:room:"+accountID.String()+":"+boardID.String(), time.Second)
	if err != nil || roomCount > 40 {
		return false
	}
	accountCount, err := s.incrementAbuseCounter(ctx, "abuse:whiteboard-ws:account:"+accountID.String(), time.Second)
	return err == nil && accountCount <= 200
}

func (s *Server) allowWhiteboardRoomSync(ctx context.Context, accountID, boardID uuid.UUID) bool {
	roomCount, err := s.incrementAbuseCounter(ctx, "abuse:whiteboard-ws:sync:room:"+accountID.String()+":"+boardID.String(), time.Second)
	if err != nil || roomCount > 20 {
		return false
	}
	accountCount, err := s.incrementAbuseCounter(ctx, "abuse:whiteboard-ws:sync:account:"+accountID.String(), time.Second)
	return err == nil && accountCount <= 100
}

func (s *Server) applyWhiteboardRealtimePatch(ctx context.Context, principal *whiteboardRealtimePrincipal, incoming whiteboardcore.IncomingMessage) (*domain.WhiteboardSceneWriteResult, whiteboardcore.OutgoingMessage, error) {
	cleanAppState, err := whiteboardcore.SanitizePersistedAppState(incoming.AppState)
	if err != nil {
		return nil, whiteboardcore.OutgoingMessage{}, err
	}
	patchData := whiteboardRealtimePatchData{
		ClientBaseSequence: incoming.BaseSequence,
		Elements:           incoming.Elements,
		AppState:           cleanAppState,
	}
	requestHash, err := whiteboardPatchRequestPayloadHash(incoming.BaseSequence, incoming.Elements, cleanAppState)
	if err != nil {
		return nil, whiteboardcore.OutgoingMessage{}, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		current, err := s.whiteboardRealtimeScene(ctx, principal, domain.WhiteboardAccessView)
		if err != nil {
			return nil, whiteboardcore.OutgoingMessage{}, err
		}
		if incoming.BaseSequence > current.Sequence {
			return nil, whiteboardcore.OutgoingMessage{}, &repository.WhiteboardConflictError{CurrentSequence: current.Sequence}
		}
		materialized, _, err := whiteboardcore.MaterializeScenePatch(current.Scene, incoming.Elements, cleanAppState)
		if err != nil {
			return nil, whiteboardcore.OutgoingMessage{}, err
		}
		materialized, sceneHash, err := service.ValidateAndHashWhiteboardScene(materialized)
		if err != nil {
			return nil, whiteboardcore.OutgoingMessage{}, err
		}
		patchData.BaseSequence = current.Sequence
		patchJSON, err := json.Marshal(patchData)
		if err != nil {
			return nil, whiteboardcore.OutgoingMessage{}, err
		}
		editorVersion := current.EditorVersion
		if editorVersion == "" {
			editorVersion = whiteboardEditorVersion
		}
		input := repository.WhiteboardSceneWriteInput{
			ExpectedSequence:   current.Sequence,
			OperationID:        *incoming.OperationID,
			Scene:              materialized,
			Patch:              patchJSON,
			SceneSchemaVersion: current.SceneSchemaVersion,
			EditorVersion:      editorVersion,
			RequestPayloadHash: requestHash,
			ResultSceneHash:    sceneHash,
		}
		var result *domain.WhiteboardSceneWriteResult
		if principal.GuestSession != nil {
			result, err = s.repos.Whiteboard.ApplyScenePatchAsGuest(ctx, principal.GuestTokenHash, input, time.Now().UTC())
		} else {
			result, err = s.repos.Whiteboard.ApplyScenePatch(ctx, principal.AccountID, *principal.UserID, principal.BoardID, input)
		}
		if err != nil {
			var conflict *repository.WhiteboardConflictError
			if errors.As(err, &conflict) {
				continue
			}
			return nil, whiteboardcore.OutgoingMessage{}, err
		}
		outgoing := whiteboardcore.OutgoingMessage{
			Event:       whiteboardcore.EventScenePatch,
			OperationID: incoming.OperationID,
			Sequence:    result.OperationSequence,
			Actor:       principal.Actor,
			Data:        patchData,
		}
		return result, outgoing, nil
	}
	latest, err := s.whiteboardRealtimeScene(ctx, principal, domain.WhiteboardAccessView)
	if err != nil {
		return nil, whiteboardcore.OutgoingMessage{}, err
	}
	return nil, whiteboardcore.OutgoingMessage{}, &repository.WhiteboardConflictError{CurrentSequence: latest.Sequence}
}

func (s *Server) syncWhiteboardRealtimeClient(ctx context.Context, principal *whiteboardRealtimePrincipal, client *whiteboardcore.RealtimeClient, baseSequence int64) error {
	scene, err := s.whiteboardRealtimeScene(ctx, principal, domain.WhiteboardAccessView)
	if err != nil {
		return err
	}
	if baseSequence > scene.Sequence {
		s.queueWhiteboardMessage(client, whiteboardSceneSnapshotMessage(scene))
		return nil
	}
	if baseSequence == scene.Sequence {
		s.queueWhiteboardMessage(client, whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAck, Sequence: scene.Sequence})
		return nil
	}
	operations, err := s.whiteboardRealtimeOperations(ctx, principal, baseSequence, 500)
	if err != nil || len(operations) == 0 || operations[len(operations)-1].Sequence != scene.Sequence {
		s.queueWhiteboardMessage(client, whiteboardSceneSnapshotMessage(scene))
		return nil
	}
	for _, operation := range operations {
		if operation.OperationKind != "patch" || len(operation.Patch) == 0 {
			s.queueWhiteboardMessage(client, whiteboardSceneSnapshotMessage(scene))
			return nil
		}
	}
	for _, operation := range operations {
		operationID := operation.OperationID
		if !s.queueWhiteboardReplayOperation(client, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventScenePatch, OperationID: &operationID, Sequence: operation.Sequence, Data: json.RawMessage(operation.Patch),
		}, scene.Sequence) {
			return nil
		}
	}
	return nil
}

// queueWhiteboardReplayOperation returns true only when the caller may enqueue
// the following operation. An oversized message or a saturated queue is
// replaced by one sync.required at the latest canonical sequence, after which
// replay must stop.
func (s *Server) queueWhiteboardReplayOperation(client *whiteboardcore.RealtimeClient, message whiteboardcore.OutgoingMessage, canonicalSequence int64) bool {
	bounded := whiteboardRealtimeBroadcastMessage(message)
	if bounded.Event == whiteboardcore.EventScenePatch && s.queueWhiteboardMessage(client, bounded) {
		return true
	}
	syncRequired := whiteboardSceneSyncRequiredMessage(canonicalSequence, "operation_replay_requires_snapshot")
	if s.queueWhiteboardMessage(client, syncRequired) {
		return false
	}
	payload, err := json.Marshal(syncRequired)
	if err == nil {
		_ = client.ReplaceQueued(payload)
	}
	return false
}

func (s *Server) whiteboardRealtimeScene(ctx context.Context, principal *whiteboardRealtimePrincipal, requiredLevel string) (*domain.WhiteboardScene, error) {
	if principal.GuestSession != nil {
		scene, guest, err := s.repos.Whiteboard.GetSceneAsGuest(ctx, principal.GuestTokenHash, requiredLevel, time.Now().UTC())
		if err != nil {
			return nil, err
		}
		if guest.Session.BoardID != principal.BoardID || guest.Session.AccountID != principal.AccountID || guest.Session.ID != *principal.GuestSession {
			return nil, repository.ErrWhiteboardSessionUnavailable
		}
		return scene, nil
	}
	return s.repos.Whiteboard.GetScene(ctx, principal.AccountID, *principal.UserID, principal.BoardID, requiredLevel)
}

func (s *Server) whiteboardRealtimeOperations(ctx context.Context, principal *whiteboardRealtimePrincipal, afterSequence int64, limit int) ([]*domain.WhiteboardOperation, error) {
	if principal.GuestSession != nil {
		operations, guest, err := s.repos.Whiteboard.ListOperationsAfterAsGuest(ctx, principal.GuestTokenHash, afterSequence, limit, time.Now().UTC())
		if err != nil {
			return nil, err
		}
		if guest.Session.BoardID != principal.BoardID || guest.Session.AccountID != principal.AccountID || guest.Session.ID != *principal.GuestSession {
			return nil, repository.ErrWhiteboardSessionUnavailable
		}
		return operations, nil
	}
	return s.repos.Whiteboard.ListOperationsAfter(ctx, principal.AccountID, *principal.UserID, principal.BoardID, afterSequence, limit)
}

func (s *Server) validateWhiteboardRealtimeAccess(ctx context.Context, principal *whiteboardRealtimePrincipal, requiredLevel string) error {
	if principal.GuestSession != nil {
		guest, err := s.repos.Whiteboard.ResolveGuestSession(ctx, principal.GuestTokenHash, requiredLevel, time.Now().UTC())
		if err != nil {
			return err
		}
		if guest.Session.ID != *principal.GuestSession || guest.Session.AccountID != principal.AccountID || guest.Session.BoardID != principal.BoardID {
			return repository.ErrWhiteboardSessionUnavailable
		}
		return nil
	}
	if principal.Claims == nil || s.services.Auth.IsUserSessionInvalidated(principal.Claims) {
		return repository.ErrWhiteboardForbidden
	}
	if !principal.ExpiresAt.IsZero() && !principal.ExpiresAt.After(time.Now()) {
		return repository.ErrWhiteboardForbidden
	}
	if !s.whiteboardModuleAllowed(ctx, principal.Claims) {
		return repository.ErrWhiteboardForbidden
	}
	_, err := s.repos.Whiteboard.RequireAccess(ctx, principal.AccountID, *principal.UserID, principal.BoardID, requiredLevel)
	return err
}

func (s *Server) validateWhiteboardRealtimeEphemeralAccess(ctx context.Context, principal *whiteboardRealtimePrincipal) error {
	if time.Since(principal.LastEphemeralValidation) < 2*time.Second {
		return nil
	}
	if err := s.validateWhiteboardRealtimeAccess(ctx, principal, domain.WhiteboardAccessView); err != nil {
		return err
	}
	principal.LastEphemeralValidation = time.Now()
	return nil
}

func whiteboardSceneSnapshotMessage(scene *domain.WhiteboardScene) whiteboardcore.OutgoingMessage {
	if scene == nil {
		return whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: "scene_unavailable", Error: "No se pudo cargar la pizarra"}
	}
	message := whiteboardcore.OutgoingMessage{
		Event:    whiteboardcore.EventSceneSnapshot,
		Sequence: scene.Sequence,
		Data: map[string]any{
			"scene": scene.Scene, "scene_schema_version": scene.SceneSchemaVersion,
			"editor_version": scene.EditorVersion, "updated_at": scene.UpdatedAt,
		},
	}
	if payload, err := json.Marshal(message); err != nil || len(payload) > whiteboardcore.MaxRealtimeSnapshotMessageBytes {
		return whiteboardSceneSyncRequiredMessage(scene.Sequence, "scene_too_large")
	}
	return message
}

func whiteboardSceneSyncRequiredMessage(sequence int64, reason string) whiteboardcore.OutgoingMessage {
	return whiteboardcore.OutgoingMessage{
		Event:    whiteboardcore.EventSyncRequired,
		Sequence: sequence,
		Data: map[string]any{
			"reason": reason,
		},
	}
}

func (s *Server) queueWhiteboardMessage(client *whiteboardcore.RealtimeClient, message whiteboardcore.OutgoingMessage) bool {
	payload, err := json.Marshal(message)
	if err != nil || len(payload) == 0 || len(payload) > whiteboardcore.MaxRealtimeMessageBytes {
		return false
	}
	return client.Enqueue(payload)
}

func (s *Server) queueWhiteboardError(client *whiteboardcore.RealtimeClient, code, message string) {
	s.queueWhiteboardMessage(client, whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: code, Error: message})
}

func (s *Server) queueWhiteboardOperationError(client *whiteboardcore.RealtimeClient, operationID *uuid.UUID, code, message string) {
	s.queueWhiteboardMessage(client, whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventError, OperationID: operationID, Code: code, Error: message,
	})
}

func (s *Server) writeWhiteboardSocket(conn *websocket.Conn, client *whiteboardcore.RealtimeClient, principal *whiteboardRealtimePrincipal, done chan<- struct{}) {
	defer close(done)
	defer conn.Close()
	ticker := time.NewTicker(whiteboardPingInterval)
	defer ticker.Stop()
	authorizationTicker := time.NewTicker(15 * time.Second)
	defer authorizationTicker.Stop()
	for {
		select {
		case payload := <-client.Send:
			_ = conn.SetWriteDeadline(time.Now().Add(whiteboardWriteWait))
			if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				return
			}
		case <-client.Done():
			for {
				select {
				case payload := <-client.Send:
					_ = conn.SetWriteDeadline(time.Now().Add(whiteboardWriteWait))
					if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
						return
					}
				default:
					_ = conn.WriteMessage(websocket.CloseMessage, nil)
					return
				}
			}
		case <-ticker.C:
			presenceCtx, presenceCancel := context.WithTimeout(context.Background(), 5*time.Second)
			presenceErr := s.refreshWhiteboardPresence(presenceCtx, client)
			if presenceErr == nil {
				presenceErr = s.publishWhiteboardPresenceSnapshot(presenceCtx, client)
			}
			presenceCancel()
			if presenceErr != nil {
				payload, _ := json.Marshal(whiteboardcore.OutgoingMessage{
					Event: whiteboardcore.EventError, Code: "presence_unavailable", Error: "La presencia de la sala dejó de estar disponible",
				})
				_ = conn.SetWriteDeadline(time.Now().Add(whiteboardWriteWait))
				_ = conn.WriteMessage(websocket.TextMessage, payload)
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(whiteboardWriteWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-authorizationTicker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err := s.validateWhiteboardRealtimeAccess(ctx, principal, domain.WhiteboardAccessView)
			cancel()
			if err != nil {
				payload, _ := json.Marshal(whiteboardcore.OutgoingMessage{
					Event: whiteboardcore.EventAccessRevoked, Code: "access_revoked", Error: "El acceso a la pizarra finalizó",
				})
				_ = conn.SetWriteDeadline(time.Now().Add(whiteboardWriteWait))
				_ = conn.WriteMessage(websocket.TextMessage, payload)
				return
			}
		}
	}
}

func whiteboardCheckpointKey(accountID, boardID uuid.UUID) string {
	return accountID.String() + ":" + boardID.String()
}

func cloneWhiteboardRealtimePrincipal(principal *whiteboardRealtimePrincipal) *whiteboardRealtimePrincipal {
	if principal == nil {
		return nil
	}
	copyValue := *principal
	if principal.UserID != nil {
		value := *principal.UserID
		copyValue.UserID = &value
	}
	if principal.GuestSession != nil {
		value := *principal.GuestSession
		copyValue.GuestSession = &value
	}
	return &copyValue
}

func (s *Server) scheduleWhiteboardCheckpoint(principal *whiteboardRealtimePrincipal) {
	if principal == nil || principal.AccountID == uuid.Nil || principal.BoardID == uuid.Nil {
		return
	}
	key := whiteboardCheckpointKey(principal.AccountID, principal.BoardID)
	s.whiteboardCheckpointMu.Lock()
	defer s.whiteboardCheckpointMu.Unlock()
	if s.whiteboardCheckpoints == nil {
		s.whiteboardCheckpoints = make(map[string]*whiteboardCheckpointEntry)
	}
	if existing := s.whiteboardCheckpoints[key]; existing != nil {
		existing.principal = cloneWhiteboardRealtimePrincipal(principal)
		return
	}
	entry := &whiteboardCheckpointEntry{principal: cloneWhiteboardRealtimePrincipal(principal)}
	entry.timer = time.AfterFunc(whiteboardAutomaticRevisionEvery, func() {
		s.whiteboardCheckpointMu.Lock()
		current := s.whiteboardCheckpoints[key]
		if current != entry {
			s.whiteboardCheckpointMu.Unlock()
			return
		}
		delete(s.whiteboardCheckpoints, key)
		checkpointPrincipal := cloneWhiteboardRealtimePrincipal(entry.principal)
		s.whiteboardCheckpointMu.Unlock()
		s.runWhiteboardCheckpoint(checkpointPrincipal, "automatic")
	})
	s.whiteboardCheckpoints[key] = entry
}

func (s *Server) flushWhiteboardCheckpoint(accountID, boardID uuid.UUID) {
	key := whiteboardCheckpointKey(accountID, boardID)
	s.whiteboardCheckpointMu.Lock()
	entry := s.whiteboardCheckpoints[key]
	if entry == nil || !entry.timer.Stop() {
		s.whiteboardCheckpointMu.Unlock()
		return
	}
	delete(s.whiteboardCheckpoints, key)
	principal := cloneWhiteboardRealtimePrincipal(entry.principal)
	s.whiteboardCheckpointMu.Unlock()
	s.runWhiteboardCheckpoint(principal, "session_close")
}

func (s *Server) runWhiteboardCheckpoint(principal *whiteboardRealtimePrincipal, reason string) {
	if principal == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.checkpointWhiteboardRealtimeScene(ctx, principal); err != nil {
		log.Printf("[WHITEBOARD CHECKPOINT] account=%s board=%s phase=%s code=%s err=%v",
			principal.AccountID, principal.BoardID, reason, whiteboardWriteFailureCode(err), err)
	}
}

func (s *Server) stopWhiteboardCheckpoints() {
	s.whiteboardCheckpointMu.Lock()
	defer s.whiteboardCheckpointMu.Unlock()
	for key, entry := range s.whiteboardCheckpoints {
		if entry != nil && entry.timer != nil {
			entry.timer.Stop()
		}
		delete(s.whiteboardCheckpoints, key)
	}
}

func (s *Server) checkpointWhiteboardRealtimeScene(ctx context.Context, principal *whiteboardRealtimePrincipal) error {
	if principal.GuestSession != nil {
		if err := s.validateWhiteboardRealtimeAccess(ctx, principal, domain.WhiteboardAccessEdit); err != nil {
			return err
		}
	} else {
		if principal.UserID == nil {
			return repository.ErrWhiteboardForbidden
		}
		if principal.Claims != nil && !s.whiteboardModuleAllowed(ctx, principal.Claims) {
			return repository.ErrWhiteboardForbidden
		}
		if _, err := s.repos.Whiteboard.RequireAccess(ctx, principal.AccountID, *principal.UserID, principal.BoardID, domain.WhiteboardAccessEdit); err != nil {
			return err
		}
	}
	scene, err := s.whiteboardRealtimeScene(ctx, principal, domain.WhiteboardAccessView)
	if err != nil {
		return err
	}
	operationID := uuid.New()
	prepared, err := s.prepareAndUploadWhiteboardSnapshot(ctx, principal.AccountID, principal.BoardID, operationID, scene.Scene)
	if err != nil {
		return err
	}
	input := repository.WhiteboardSceneWriteInput{
		ExpectedSequence: scene.Sequence, OperationID: operationID, Scene: scene.Scene,
		SceneSchemaVersion: scene.SceneSchemaVersion, EditorVersion: scene.EditorVersion, WriteKind: "snapshot", RevisionKind: "automatic",
		ResultSceneHash: prepared.SceneHash, SnapshotObjectKey: prepared.ObjectKey,
		SnapshotContentHash: prepared.ContentHash, SnapshotSizeBytes: prepared.SizeBytes,
	}
	var result *domain.WhiteboardSceneWriteResult
	if principal.GuestSession != nil {
		result, err = s.repos.Whiteboard.UpdateSceneAsGuest(ctx, principal.GuestTokenHash, input, time.Now().UTC())
	} else {
		result, err = s.repos.Whiteboard.UpdateScene(ctx, principal.AccountID, *principal.UserID, principal.BoardID, input)
	}
	if err != nil {
		if prepared.UploadedByRequest {
			_ = s.repos.Whiteboard.MarkRevisionSnapshotFailed(ctx, principal.AccountID, prepared.ObjectKey, "automatic realtime snapshot failed")
		}
		return err
	}
	s.broadcastWhiteboardMessage(principal.AccountID, principal.BoardID, whiteboardSceneSnapshotMessage(result.Scene), uuid.Nil)
	return nil
}
