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
	"github.com/jackc/pgx/v5"
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
	whiteboardEditorVersion          = "0.18.1-clarin.5"
)

type whiteboardRealtimePrincipal struct {
	AccountID               uuid.UUID                    `json:"account_id"`
	BoardID                 uuid.UUID                    `json:"board_id"`
	UserID                  *uuid.UUID                   `json:"user_id,omitempty"`
	SessionID               string                       `json:"session_id,omitempty"`
	GuestSession            *uuid.UUID                   `json:"guest_session_id,omitempty"`
	GuestTokenHash          string                       `json:"guest_token_hash,omitempty"`
	GuestExpiresAt          *time.Time                   `json:"guest_expires_at,omitempty"`
	Actor                   whiteboardcore.RealtimeActor `json:"actor"`
	AccessRevision          int64                        `json:"-"`
	LastEphemeralValidation time.Time                    `json:"-"`
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

type whiteboardRealtimeAuthorizationError struct {
	RequiredLevel string
	Err           error
}

func (e *whiteboardRealtimeAuthorizationError) Error() string {
	if e == nil || e.Err == nil {
		return "whiteboard realtime authorization failed"
	}
	return e.Err.Error()
}

func (e *whiteboardRealtimeAuthorizationError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func whiteboardRealtimeAuthorizationFailure(requiredLevel string, err error) error {
	if err == nil {
		return nil
	}
	return &whiteboardRealtimeAuthorizationError{RequiredLevel: requiredLevel, Err: err}
}

const (
	whiteboardAuthorizationAccessRevoked  = "access_revoked"
	whiteboardAuthorizationSessionExpired = "session_expired"
	whiteboardAuthorizationUnavailable    = "authorization_unavailable"
)

type whiteboardSocketTermination struct {
	Message     whiteboardcore.OutgoingMessage
	CloseCode   int
	CloseReason string
}

func classifyWhiteboardRealtimeAuthorization(err error) string {
	switch {
	case errors.Is(err, service.ErrAuthSessionExpired):
		return whiteboardAuthorizationSessionExpired
	case errors.Is(err, repository.ErrWhiteboardNotFound),
		errors.Is(err, repository.ErrWhiteboardForbidden),
		errors.Is(err, repository.ErrWhiteboardSessionUnavailable):
		return whiteboardAuthorizationAccessRevoked
	default:
		return whiteboardAuthorizationUnavailable
	}
}

func whiteboardRealtimeAuthorizationRequiredLevel(err error, fallback string) string {
	var authorizationErr *whiteboardRealtimeAuthorizationError
	if errors.As(err, &authorizationErr) && authorizationErr.RequiredLevel != "" {
		return authorizationErr.RequiredLevel
	}
	return fallback
}

func whiteboardRealtimeRequiredLevelForEvent(event string) string {
	switch event {
	case whiteboardcore.EventScenePatch, whiteboardcore.EventPresentationStart:
		return domain.WhiteboardAccessEdit
	default:
		return domain.WhiteboardAccessView
	}
}

func whiteboardSocketTerminationForAuthorization(err error) whiteboardSocketTermination {
	switch classifyWhiteboardRealtimeAuthorization(err) {
	case whiteboardAuthorizationSessionExpired:
		return whiteboardSocketTermination{
			Message:   whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: "session_expired", Error: "Tu sesión de Clarin finalizó"},
			CloseCode: websocket.ClosePolicyViolation, CloseReason: "session expired",
		}
	case whiteboardAuthorizationAccessRevoked:
		return whiteboardSocketTermination{
			Message:   whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "access_revoked", Error: "El acceso a la pizarra fue revocado"},
			CloseCode: websocket.ClosePolicyViolation, CloseReason: "access revoked",
		}
	default:
		return whiteboardSocketTermination{
			Message:   whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: "authorization_unavailable", Error: "No se pudo verificar el acceso temporalmente"},
			CloseCode: websocket.CloseTryAgainLater, CloseReason: "authorization unavailable",
		}
	}
}

func writeWhiteboardSocketTermination(conn *websocket.Conn, termination whiteboardSocketTermination) {
	payload, err := json.Marshal(termination.Message)
	if err == nil {
		_ = conn.SetWriteDeadline(time.Now().Add(whiteboardWriteWait))
		_ = conn.WriteMessage(websocket.TextMessage, payload)
	}
	_ = conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(termination.CloseCode, termination.CloseReason),
		time.Now().Add(whiteboardWriteWait))
}

func writeClosedWhiteboardClient(conn *websocket.Conn, client *whiteboardcore.RealtimeClient) {
	payload := client.TakeTerminal()
	closeCode, closeReason := websocket.CloseNormalClosure, "connection closed"
	if len(payload) > 0 {
		_ = conn.SetWriteDeadline(time.Now().Add(whiteboardWriteWait))
		_ = conn.WriteMessage(websocket.TextMessage, payload)
		var message whiteboardcore.OutgoingMessage
		if json.Unmarshal(payload, &message) == nil {
			if message.Code == "authorization_unavailable" {
				closeCode, closeReason = websocket.CloseTryAgainLater, "authorization unavailable"
			} else if message.Code == "session_expired" {
				closeCode, closeReason = websocket.ClosePolicyViolation, "session expired"
			} else if message.Event == whiteboardcore.EventAccessRevoked {
				closeCode, closeReason = websocket.ClosePolicyViolation, "access revoked"
			}
		}
	}
	_ = conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(closeCode, closeReason), time.Now().Add(whiteboardWriteWait))
}

func deliverWhiteboardSocketPayload(conn *websocket.Conn, client *whiteboardcore.RealtimeClient, payload []byte) (bool, error) {
	return client.DeliverIfActive(payload, func(candidate []byte) error {
		_ = conn.SetWriteDeadline(time.Now().Add(whiteboardWriteWait))
		return conn.WriteMessage(websocket.TextMessage, candidate)
	})
}

func logWhiteboardRealtimeAuthorizationFailure(principal *whiteboardRealtimePrincipal, origin, requiredLevel string, connectedAt time.Time, err error) {
	if principal == nil {
		return
	}
	age := time.Since(connectedAt)
	if age < 0 {
		age = 0
	}
	log.Printf("[WHITEBOARD AUTH] origin=%s outcome=%s required=%s account=%s board=%s connection_age_ms=%d",
		origin, classifyWhiteboardRealtimeAuthorization(err), requiredLevel,
		principal.AccountID, principal.BoardID, age.Milliseconds())
}

func isWhiteboardRealtimeAuthorizationFailure(err error) bool {
	var authorizationErr *whiteboardRealtimeAuthorizationError
	return errors.As(err, &authorizationErr) ||
		errors.Is(err, service.ErrAuthSessionExpired) ||
		errors.Is(err, service.ErrAuthSessionUnavailable) ||
		errors.Is(err, repository.ErrWhiteboardNotFound) ||
		errors.Is(err, repository.ErrWhiteboardForbidden) ||
		errors.Is(err, repository.ErrWhiteboardSessionUnavailable)
}

func (s *Server) whiteboardRealtimeAuthorizationTermination(
	principal *whiteboardRealtimePrincipal,
	client *whiteboardcore.RealtimeClient,
	incoming whiteboardcore.IncomingMessage,
	connectedAt time.Time,
	err error,
) *whiteboardSocketTermination {
	requiredLevel := whiteboardRealtimeAuthorizationRequiredLevel(err, whiteboardRealtimeRequiredLevelForEvent(incoming.Event))
	if classifyWhiteboardRealtimeAuthorization(err) == whiteboardAuthorizationAccessRevoked && requiredLevel == domain.WhiteboardAccessEdit {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		viewErr := s.revalidateRegisteredWhiteboardClient(ctx, principal, client)
		accessLevel := client.AuthorizationSnapshot().Access
		cancel()
		if viewErr == nil {
			if client.Presentation() != uuid.Nil {
				s.releaseWhiteboardPresentation(client, "permission_revoked")
			}
			presenceCtx, presenceCancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = s.registerWhiteboardPresence(presenceCtx, client)
			presenceCancel()
			s.queuePriorityWhiteboardMessage(client, whiteboardcore.OutgoingMessage{
				Event: whiteboardcore.EventError, OperationID: incoming.OperationID,
				Code: "permission_changed", Error: "Tus permisos de la pizarra cambiaron",
				Data: map[string]any{"access": accessLevel},
			})
			age := time.Since(connectedAt)
			if age < 0 {
				age = 0
			}
			log.Printf("[WHITEBOARD AUTH] origin=message outcome=permission_changed required=%s account=%s board=%s connection_age_ms=%d",
				requiredLevel, principal.AccountID, principal.BoardID, age.Milliseconds())
			return nil
		}
		err = viewErr
		requiredLevel = domain.WhiteboardAccessView
	}
	logWhiteboardRealtimeAuthorizationFailure(principal, "message", requiredLevel, connectedAt, err)
	termination := whiteboardSocketTerminationForAuthorization(err)
	return &termination
}

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
		if errors.Is(err, service.ErrAuthSessionUnavailable) {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
				"success": false, "error": "La colaboración no está disponible temporalmente", "code": "authorization_unavailable",
			})
		}
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "Collaboration ticket unavailable"})
	}
	if err := s.requireWhiteboardAccountAccess(c.Context(), principal.AccountID); err != nil {
		switch classifyWhiteboardRealtimeAuthorization(err) {
		case whiteboardAuthorizationAccessRevoked:
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "El acceso a la cuenta no está disponible", "code": "access_revoked"})
		default:
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
				"success": false, "error": "No se pudo verificar el acceso temporalmente", "code": "authorization_unavailable",
			})
		}
	}
	if err := s.validateWhiteboardRealtimeAccess(c.Context(), principal, domain.WhiteboardAccessView); err != nil {
		switch classifyWhiteboardRealtimeAuthorization(err) {
		case whiteboardAuthorizationSessionExpired:
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "La sesión finalizó", "code": "session_expired"})
		case whiteboardAuthorizationUnavailable:
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "No se pudo verificar el acceso temporalmente", "code": "authorization_unavailable"})
		default:
			return whiteboardError(c, err)
		}
	}
	accessRevision, err := s.repos.Whiteboard.AccessRevision(c.Context(), principal.AccountID, boardID)
	if err != nil {
		return whiteboardError(c, err)
	}
	principal.AccessRevision = accessRevision
	c.Locals(whiteboardRealtimePrincipalLocal, principal)
	return c.Next()
}

func (s *Server) requireWhiteboardAccountAccess(ctx context.Context, accountID uuid.UUID) error {
	if accountID == uuid.Nil || s.services == nil || s.services.Subscription == nil {
		return service.ErrAuthSessionUnavailable
	}
	decision, err := s.services.Subscription.CheckAccess(ctx, accountID)
	if err != nil {
		return err
	}
	if decision == nil || !decision.Allowed {
		return repository.ErrWhiteboardForbidden
	}
	return nil
}

func (s *Server) revalidateRegisteredWhiteboardClient(
	ctx context.Context,
	principal *whiteboardRealtimePrincipal,
	client *whiteboardcore.RealtimeClient,
) error {
	if principal == nil || client == nil || s.whiteboardRooms == nil {
		return whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessView, repository.ErrWhiteboardForbidden)
	}
	err := s.withWhiteboardFanoutEpoch(ctx, principal.AccountID, principal.BoardID, func(revision int64) error {
		access, err := s.resolveWhiteboardRealtimeAccess(ctx, principal, domain.WhiteboardAccessView)
		if err != nil {
			return err
		}
		registered, updated := s.whiteboardRooms.UpdateClientAuthorization(
			principal.AccountID, principal.BoardID, client.ID, revision, access,
		)
		if !updated {
			// A newer canonical revalidation may have won immediately before this
			// callback in a test/delayed path. Never roll it backward or convert
			// the monotonic win into a terminal revocation.
			if registered != nil && registered.AuthorizationSnapshot().AccessRevision > revision {
				return nil
			}
			return whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessView, repository.ErrWhiteboardForbidden)
		}
		return nil
	})
	if err == nil {
		return nil
	}
	var authorizationErr *whiteboardRealtimeAuthorizationError
	if errors.As(err, &authorizationErr) {
		return err
	}
	return whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessView, err)
}

func (s *Server) whiteboardModuleAllowed(ctx context.Context, userID, accountID uuid.UUID) (bool, error) {
	if userID == uuid.Nil || accountID == uuid.Nil {
		return false, nil
	}
	user, err := s.repos.User.GetByID(ctx, userID)
	if err != nil {
		return false, err
	}
	if user == nil || !user.IsActive {
		return false, nil
	}
	membership, err := s.repos.UserAccount.GetByUserAndAccount(ctx, userID, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if membership == nil {
		return false, nil
	}
	return whiteboardMembershipAllowsModule(user, membership), nil
}

func whiteboardMembershipAllowsModule(user *domain.User, membership *domain.UserAccount) bool {
	if user == nil || membership == nil || !user.IsActive {
		return false
	}
	if domain.HasAccountAdminAuthority(membership.Role, user.IsSuperAdmin) {
		return true
	}
	for _, permission := range membership.Permissions {
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

	client := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: principal.AccountID, BoardID: principal.BoardID,
		AccessRevision: principal.AccessRevision, GuestExpiresAt: principal.GuestExpiresAt,
		AuthorizationCheckedAt: time.Now().UTC(), Actor: principal.Actor, Send: make(chan []byte, 64),
		HoldUntilActivated: true,
	}
	if err := s.whiteboardRooms.Register(client); err != nil {
		_ = conn.WriteJSON(whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: "room_capacity", Error: "La sala alcanzó su límite de conexiones"})
		_ = conn.Close()
		return
	}
	// Close the ticket/scene/register TOCTOU window before any snapshot becomes
	// deliverable. A stable revision is read on both sides of the current access
	// check; an ACL signal can also close this registered client concurrently.
	finalCtx, finalCancel := context.WithTimeout(context.Background(), whiteboardRealtimeDBTimeout)
	err := s.revalidateRegisteredWhiteboardClient(finalCtx, principal, client)
	finalCancel()
	if err != nil || client.IsClosed() {
		termination := whiteboardSocketTerminationForAuthorization(err)
		if err == nil {
			termination = whiteboardSocketTermination{
				Message:   whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "access_revoked", Error: "El acceso a la pizarra fue revocado"},
				CloseCode: websocket.ClosePolicyViolation, CloseReason: "access revoked",
			}
		}
		s.whiteboardRooms.Disconnect(principal.AccountID, principal.BoardID, []uuid.UUID{client.ID}, &termination.Message)
		writeClosedWhiteboardClient(conn, client)
		_ = conn.Close()
		return
	}
	// The client is already registered but remains behind its activation
	// barrier. Room broadcasts are now retained for it while this canonical
	// scene is read; none can become deliverable ahead of the snapshot.
	sceneCtx, sceneCancel := context.WithTimeout(context.Background(), whiteboardRealtimeDBTimeout)
	initialScene, err := s.whiteboardRealtimeScene(sceneCtx, principal, domain.WhiteboardAccessView)
	sceneCancel()
	if err != nil || client.IsClosed() {
		message := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: "scene_unavailable", Error: "No se pudo cargar la pizarra"}
		if isWhiteboardRealtimeAuthorizationFailure(err) {
			message = whiteboardSocketTerminationForAuthorization(err).Message
		}
		s.whiteboardRooms.Disconnect(principal.AccountID, principal.BoardID, []uuid.UUID{client.ID}, &message)
		writeClosedWhiteboardClient(conn, client)
		_ = conn.Close()
		return
	}
	presenceCtx, presenceCancel := context.WithTimeout(context.Background(), whiteboardRealtimeDBTimeout)
	err = s.registerWhiteboardPresence(presenceCtx, client)
	presenceCancel()
	if err != nil {
		s.whiteboardRooms.Unregister(client.ID, principal.BoardID)
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
	if client.IsClosed() {
		s.unregisterWhiteboardPresence(client)
		writeClosedWhiteboardClient(conn, client)
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
	if client.IsClosed() {
		s.unregisterWhiteboardPresence(client)
		writeClosedWhiteboardClient(conn, client)
		_ = conn.Close()
		return
	}

	actor := client.ActorSnapshot()
	initialMessages := []whiteboardcore.OutgoingMessage{
		whiteboardSceneSnapshotMessage(initialScene), {
			Event: whiteboardcore.EventRoomReady,
			Actor: actor,
			Data:  map[string]any{"actor_id": actor.ID},
		}, {
			Event: whiteboardcore.EventPresenceSnapshot,
			Data:  presence,
		}}
	presentationCtx, presentationCancel := context.WithTimeout(context.Background(), whiteboardRealtimeDBTimeout)
	presentationSnapshot, presentationErr := s.whiteboardPresentationSnapshotMessage(presentationCtx, principal.AccountID, principal.BoardID)
	presentationCancel()
	if presentationErr != nil {
		initialMessages = append(initialMessages, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventError, Code: "presentation_unavailable", Error: "La presentación no está disponible temporalmente",
		})
	} else {
		initialMessages = append(initialMessages, presentationSnapshot)
	}
	initialPayloads := make([][]byte, 0, len(initialMessages))
	for _, message := range initialMessages {
		payload, ok := encodeWhiteboardMessage(message)
		if !ok {
			failure := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError,
				Code: "initial_sync_unavailable", Error: "No se pudo iniciar la sincronización de la pizarra"}
			s.whiteboardRooms.Disconnect(principal.AccountID, principal.BoardID, []uuid.UUID{client.ID}, &failure)
			s.unregisterWhiteboardPresence(client)
			writeClosedWhiteboardClient(conn, client)
			_ = conn.Close()
			return
		}
		initialPayloads = append(initialPayloads, payload)
	}
	if !client.ActivateWithInitial(initialPayloads...) {
		failure := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError,
			Code: "initial_sync_unavailable", Error: "No se pudo iniciar la sincronización de la pizarra"}
		s.whiteboardRooms.Disconnect(principal.AccountID, principal.BoardID, []uuid.UUID{client.ID}, &failure)
		s.unregisterWhiteboardPresence(client)
		writeClosedWhiteboardClient(conn, client)
		_ = conn.Close()
		return
	}
	connectedAt := time.Now().UTC()
	writerDone := make(chan struct{})
	go s.writeWhiteboardSocket(conn, client, principal, connectedAt, writerDone)
	if !client.IsClosed() {
		s.broadcastWhiteboardMessage(principal.AccountID, principal.BoardID, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventPresenceUpdate,
			Actor: client.ActorSnapshot(),
			Data:  map[string]any{"status": "joined"},
		}, client.ID)
	}

	defer func() {
		s.releaseWhiteboardPresentation(client, "presenter_left")
		s.whiteboardRooms.Unregister(client.ID, principal.BoardID)
		s.unregisterWhiteboardPresence(client)
		s.broadcastWhiteboardMessage(principal.AccountID, principal.BoardID, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventPresenceUpdate,
			Actor: client.ActorSnapshot(),
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
			if isWhiteboardRealtimeAuthorizationFailure(handleErr) {
				termination := s.whiteboardRealtimeAuthorizationTermination(principal, client, incoming, connectedAt, handleErr)
				if termination == nil {
					continue
				}
				s.whiteboardRooms.Disconnect(principal.AccountID, principal.BoardID, []uuid.UUID{client.ID}, &termination.Message)
				break
			}
			if errors.Is(handleErr, errWhiteboardPresentationOccupied) {
				s.queueWhiteboardOperationError(client, incoming.OperationID, "presentation_occupied", "Otra persona ya está presentando")
				continue
			}
			if errors.Is(handleErr, errWhiteboardPresentationNotOwned) {
				s.queueWhiteboardOperationError(client, incoming.OperationID, "presentation_not_owned", "La presentación activa pertenece a otra persona")
				continue
			}
			if errors.Is(handleErr, errWhiteboardPresentationUnavailable) {
				s.queueWhiteboardOperationError(client, incoming.OperationID, "presentation_unavailable", "La presentación no está disponible temporalmente")
				continue
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
		outgoing.Actor = client.ActorSnapshot()
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
		if err := s.validateWhiteboardRealtimeEphemeralAccess(ctx, principal, client); err != nil {
			return err
		}
		outgoing := whiteboardcore.OutgoingMessage{Event: incoming.Event, Actor: client.ActorSnapshot(), Data: json.RawMessage(incoming.Data)}
		s.broadcastWhiteboardMessageFromClient(principal.AccountID, principal.BoardID, outgoing, client.ID, client)
		return nil
	case whiteboardcore.EventPresentationStart:
		_, _, err := s.startAuthorizedWhiteboardPresentation(ctx, principal, client, *incoming.OperationID)
		return err
	case whiteboardcore.EventPresentationStop:
		if err := s.validateWhiteboardRealtimeEphemeralAccess(ctx, principal, client); err != nil {
			return err
		}
		var data whiteboardcore.PresentationStopData
		if err := json.Unmarshal(incoming.Data, &data); err != nil {
			return whiteboardcore.ErrInvalidRealtimeMessage
		}
		if err := s.stopWhiteboardPresentation(ctx, client, data.PresentationID, "presenter_stopped"); err != nil {
			return err
		}
		s.queueWhiteboardMessage(client, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventAck, OperationID: incoming.OperationID,
			Data: map[string]any{"presentation_id": data.PresentationID, "stopped": true},
		})
		return nil
	case whiteboardcore.EventFollowChange:
		if err := s.validateWhiteboardRealtimeEphemeralAccess(ctx, principal, client); err != nil {
			return err
		}
		var data whiteboardcore.FollowChangeData
		if err := json.Unmarshal(incoming.Data, &data); err != nil {
			return whiteboardcore.ErrInvalidRealtimeMessage
		}
		actor := client.ActorSnapshot()
		if data.TargetActorID == actor.ID {
			return nil
		}
		present, err := s.whiteboardActorIsPresent(ctx, principal.AccountID, principal.BoardID, data.TargetActorID)
		if err != nil {
			return errWhiteboardPresentationUnavailable
		}
		if !present {
			s.queueWhiteboardError(client, "follow_target_unavailable", "La persona ya no está en la sala")
			return nil
		}
		s.broadcastWhiteboardMessageFromClient(principal.AccountID, principal.BoardID, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventFollowChange, Actor: actor, Data: data,
		}, client.ID, client)
		return nil
	case whiteboardcore.EventViewportUpdate:
		if !s.allowWhiteboardRoomViewport(ctx, principal.AccountID, principal.BoardID) {
			return errWhiteboardRealtimeRateLimited
		}
		if err := s.validateWhiteboardRealtimeEphemeralAccess(ctx, principal, client); err != nil {
			return err
		}
		var data whiteboardcore.ViewportUpdateData
		if err := json.Unmarshal(incoming.Data, &data); err != nil {
			return whiteboardcore.ErrInvalidRealtimeMessage
		}
		s.broadcastWhiteboardMessageFromClient(principal.AccountID, principal.BoardID, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventViewportUpdate, Actor: client.ActorSnapshot(), Data: data,
		}, client.ID, client)
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

func (s *Server) allowWhiteboardRoomViewport(ctx context.Context, accountID, boardID uuid.UUID) bool {
	roomCount, err := s.incrementAbuseCounter(ctx, "abuse:whiteboard-ws:viewport:room:"+accountID.String()+":"+boardID.String(), time.Second)
	if err != nil || roomCount > 300 {
		return false
	}
	accountCount, err := s.incrementAbuseCounter(ctx, "abuse:whiteboard-ws:viewport:account:"+accountID.String(), time.Second)
	return err == nil && accountCount <= 1_500
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
		input := repository.WhiteboardSceneWriteInput{
			ExpectedSequence:   current.Sequence,
			OperationID:        *incoming.OperationID,
			Scene:              materialized,
			Patch:              patchJSON,
			SceneSchemaVersion: current.SceneSchemaVersion,
			EditorVersion:      whiteboardEditorVersion,
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
	if err != nil || !whiteboardOperationReplayComplete(baseSequence, scene.Sequence, operations) {
		s.queueWhiteboardMessage(client, whiteboardSceneSnapshotMessage(scene))
		return nil
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

func whiteboardOperationReplayComplete(baseSequence, canonicalSequence int64, operations []*domain.WhiteboardOperation) bool {
	if baseSequence >= canonicalSequence || len(operations) == 0 {
		return false
	}
	expectedBase := baseSequence
	for _, operation := range operations {
		if operation == nil || operation.OperationKind != "patch" || len(operation.Patch) == 0 ||
			operation.BaseSequence != expectedBase || operation.Sequence <= operation.BaseSequence {
			return false
		}
		expectedBase = operation.Sequence
	}
	return expectedBase == canonicalSequence
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

func (s *Server) resolveWhiteboardRealtimeAccess(ctx context.Context, principal *whiteboardRealtimePrincipal, requiredLevel string) (string, error) {
	if principal == nil {
		return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, repository.ErrWhiteboardForbidden)
	}
	if err := s.requireWhiteboardAccountAccess(ctx, principal.AccountID); err != nil {
		return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, err)
	}
	if principal.GuestSession != nil {
		guest, err := s.repos.Whiteboard.ResolveGuestSession(ctx, principal.GuestTokenHash, requiredLevel, time.Now().UTC())
		if err != nil {
			return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, err)
		}
		if guest.Session.ID != *principal.GuestSession || guest.Session.AccountID != principal.AccountID || guest.Session.BoardID != principal.BoardID {
			return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, repository.ErrWhiteboardSessionUnavailable)
		}
		return guest.Session.AccessLevel, nil
	}
	if principal.UserID == nil || strings.TrimSpace(principal.SessionID) == "" || s.services == nil || s.services.Auth == nil {
		return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, service.ErrAuthSessionExpired)
	}
	if err := s.services.Auth.ValidateSessionReadOnly(ctx, principal.SessionID, *principal.UserID); err != nil {
		return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, err)
	}
	allowed, err := s.whiteboardModuleAllowed(ctx, *principal.UserID, principal.AccountID)
	if err != nil {
		return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, err)
	}
	if !allowed {
		return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, repository.ErrWhiteboardForbidden)
	}
	access, err := s.repos.Whiteboard.RequireActiveAccess(ctx, principal.AccountID, *principal.UserID, principal.BoardID, requiredLevel)
	if err != nil {
		return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, err)
	}
	// Ticket possession is not durable authority. Resolve the live member
	// session, module and board/Work ACL first; only then inspect origin for the
	// rollout kill switch. Hidden or revoked principals therefore never learn
	// whether their board UUID has a contextual binding.
	if !s.workWhiteboardViewsEnabled() {
		contextual, err := s.repos.Whiteboard.IsWorkOrigin(ctx, principal.AccountID, principal.BoardID)
		if err != nil {
			return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, err)
		}
		if contextual {
			return "", whiteboardRealtimeAuthorizationFailure(requiredLevel, repository.ErrWhiteboardNotFound)
		}
	}
	return access.Level, nil
}

func (s *Server) validateWhiteboardRealtimeAccess(ctx context.Context, principal *whiteboardRealtimePrincipal, requiredLevel string) error {
	_, err := s.resolveWhiteboardRealtimeAccess(ctx, principal, requiredLevel)
	return err
}

func whiteboardRealtimeEphemeralCacheValid(
	client *whiteboardcore.RealtimeClient,
	canonicalRevision int64,
	validatedAt, now time.Time,
) bool {
	if client == nil || canonicalRevision <= 0 || validatedAt.IsZero() || now.Before(validatedAt) ||
		now.Sub(validatedAt) >= 2*time.Second {
		return false
	}
	return client.IsActiveAtRevision(canonicalRevision)
}

func (s *Server) validateWhiteboardRealtimeEphemeralAccess(
	ctx context.Context,
	principal *whiteboardRealtimePrincipal,
	client *whiteboardcore.RealtimeClient,
) error {
	if principal == nil || client == nil || client.IsClosed() {
		return whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessView, repository.ErrWhiteboardForbidden)
	}
	if s.repos == nil || s.repos.Whiteboard == nil {
		// In-memory protocol tests intentionally omit repositories. They may use
		// only an already fresh cache; production servers always take the
		// canonical revision path below.
		now := time.Now()
		if !principal.LastEphemeralValidation.IsZero() && !now.Before(principal.LastEphemeralValidation) &&
			now.Sub(principal.LastEphemeralValidation) < 2*time.Second {
			return nil
		}
		return whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessView, service.ErrAuthSessionUnavailable)
	}
	// The two-second cache may skip full session/module resolution, but never
	// the canonical board epoch. A stale client is reauthorized (or closed)
	// before its cursor/presence/viewport can enter fanout.
	canonicalRevision, err := s.repos.Whiteboard.AccessRevision(ctx, principal.AccountID, principal.BoardID)
	if err != nil {
		return whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessView, err)
	}
	if !whiteboardRealtimeEphemeralCacheValid(client, canonicalRevision, principal.LastEphemeralValidation, time.Now()) {
		if err := s.revalidateRegisteredWhiteboardClient(ctx, principal, client); err != nil {
			return err
		}
		principal.LastEphemeralValidation = time.Now()
	}
	if client.IsClosed() {
		return whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessView, repository.ErrWhiteboardForbidden)
	}
	return nil
}

// validateWhiteboardCheckpointAccess protects a deferred revision with current
// user, module and board authorization. It intentionally does not require the
// initiating HTTP session to remain alive: the checkpoint is recovery work for
// a scene mutation that was already durably authorized and committed.
func (s *Server) validateWhiteboardCheckpointAccess(ctx context.Context, principal *whiteboardRealtimePrincipal) error {
	if principal == nil {
		return repository.ErrWhiteboardForbidden
	}
	if err := s.requireWhiteboardAccountAccess(ctx, principal.AccountID); err != nil {
		return err
	}
	if principal.GuestSession != nil {
		return s.validateWhiteboardRealtimeAccess(ctx, principal, domain.WhiteboardAccessEdit)
	}
	if principal.UserID == nil {
		return repository.ErrWhiteboardForbidden
	}
	allowed, err := s.whiteboardModuleAllowed(ctx, *principal.UserID, principal.AccountID)
	if err != nil {
		return err
	}
	if !allowed {
		return repository.ErrWhiteboardForbidden
	}
	_, err = s.repos.Whiteboard.RequireActiveAccess(ctx, principal.AccountID, *principal.UserID, principal.BoardID, domain.WhiteboardAccessEdit)
	return err
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

func encodeWhiteboardMessage(message whiteboardcore.OutgoingMessage) ([]byte, bool) {
	payload, err := json.Marshal(message)
	if err != nil || len(payload) == 0 || len(payload) > whiteboardcore.MaxRealtimeMessageBytes {
		return nil, false
	}
	return payload, true
}

func (s *Server) queueWhiteboardMessage(client *whiteboardcore.RealtimeClient, message whiteboardcore.OutgoingMessage) bool {
	payload, ok := encodeWhiteboardMessage(message)
	return ok && client != nil && client.Enqueue(payload)
}

func (s *Server) queueWhiteboardError(client *whiteboardcore.RealtimeClient, code, message string) {
	s.queueWhiteboardMessage(client, whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError, Code: code, Error: message})
}

func (s *Server) queueWhiteboardOperationError(client *whiteboardcore.RealtimeClient, operationID *uuid.UUID, code, message string) {
	s.queueWhiteboardMessage(client, whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventError, OperationID: operationID, Code: code, Error: message,
	})
}

func (s *Server) writeWhiteboardSocket(
	conn *websocket.Conn,
	client *whiteboardcore.RealtimeClient,
	principal *whiteboardRealtimePrincipal,
	connectedAt time.Time,
	done chan<- struct{},
) {
	defer close(done)
	defer conn.Close()
	ticker := time.NewTicker(whiteboardPingInterval)
	defer ticker.Stop()
	authorizationTicker := time.NewTicker(15 * time.Second)
	defer authorizationTicker.Stop()
	for {
		if payload, ok := client.TakeBootstrap(); ok {
			delivered, err := deliverWhiteboardSocketPayload(conn, client, payload)
			if err != nil {
				return
			}
			if !delivered {
				writeClosedWhiteboardClient(conn, client)
				return
			}
			continue
		}
		// Give canonical permission controls a dedicated fast lane. A second
		// select still observes Done and ordinary data without busy waiting.
		select {
		case payload := <-client.Control():
			delivered, err := deliverWhiteboardSocketPayload(conn, client, payload)
			if err != nil {
				return
			}
			if !delivered {
				writeClosedWhiteboardClient(conn, client)
				return
			}
			continue
		default:
		}
		select {
		case payload := <-client.Control():
			delivered, err := deliverWhiteboardSocketPayload(conn, client, payload)
			if err != nil {
				return
			}
			if !delivered {
				writeClosedWhiteboardClient(conn, client)
				return
			}
		case payload := <-client.Send:
			delivered, err := deliverWhiteboardSocketPayload(conn, client, payload)
			if err != nil {
				return
			}
			if !delivered {
				writeClosedWhiteboardClient(conn, client)
				return
			}
		case <-client.Done():
			writeClosedWhiteboardClient(conn, client)
			return
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
				_, _ = deliverWhiteboardSocketPayload(conn, client, payload)
				return
			}
			delivered, pingErr := client.DeliverIfActive([]byte{1}, func([]byte) error {
				_ = conn.SetWriteDeadline(time.Now().Add(whiteboardWriteWait))
				return conn.WriteMessage(websocket.PingMessage, nil)
			})
			if pingErr != nil {
				return
			}
			if !delivered {
				writeClosedWhiteboardClient(conn, client)
				return
			}
		case <-authorizationTicker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			before := client.AuthorizationSnapshot()
			err := s.revalidateRegisteredWhiteboardClient(ctx, principal, client)
			if err != nil {
				cancel()
				logWhiteboardRealtimeAuthorizationFailure(principal, "periodic", domain.WhiteboardAccessView, connectedAt, err)
				if client.IsClosed() {
					writeClosedWhiteboardClient(conn, client)
					return
				}
				writeWhiteboardSocketTermination(conn, whiteboardSocketTerminationForAuthorization(err))
				return
			}
			after := client.AuthorizationSnapshot()
			viewAccess := after.Access
			if before.AccessRevision != after.AccessRevision || before.Access != viewAccess {
				presenceCtx, presenceCancel := context.WithTimeout(ctx, 2*time.Second)
				_ = s.registerWhiteboardPresence(presenceCtx, client)
				presenceCancel()
				payload, _ := json.Marshal(whiteboardcore.OutgoingMessage{
					Event: whiteboardcore.EventError, Code: "permission_changed", Error: "Tus permisos de la pizarra cambiaron",
					Data: map[string]any{"access": viewAccess},
				})
				if delivered, writeErr := deliverWhiteboardSocketPayload(conn, client, payload); writeErr != nil || !delivered {
					cancel()
					if !delivered {
						writeClosedWhiteboardClient(conn, client)
					}
					return
				}
			}
			if client.Presentation() != uuid.Nil {
				if editErr := s.validateWhiteboardRealtimeAccess(ctx, principal, domain.WhiteboardAccessEdit); editErr != nil {
					cancel()
					if classifyWhiteboardRealtimeAuthorization(editErr) == whiteboardAuthorizationAccessRevoked {
						s.releaseWhiteboardPresentation(client, "permission_revoked")
						payload, _ := json.Marshal(whiteboardcore.OutgoingMessage{
							Event: whiteboardcore.EventError, Code: "permission_changed", Error: "Tus permisos de la pizarra cambiaron",
							Data: map[string]any{"access": viewAccess},
						})
						_, _ = deliverWhiteboardSocketPayload(conn, client, payload)
						continue
					}
					logWhiteboardRealtimeAuthorizationFailure(principal, "periodic_edit", domain.WhiteboardAccessEdit, connectedAt, editErr)
					writeWhiteboardSocketTermination(conn, whiteboardSocketTerminationForAuthorization(editErr))
					return
				}
				if refreshErr := s.refreshWhiteboardPresentation(ctx, client); refreshErr != nil {
					payload, _ := json.Marshal(whiteboardcore.OutgoingMessage{
						Event: whiteboardcore.EventError, Code: "presentation_unavailable", Error: "La presentación no se pudo renovar",
					})
					_, _ = deliverWhiteboardSocketPayload(conn, client, payload)
				}
			}
			cancel()
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
	if principal.GuestExpiresAt != nil {
		value := *principal.GuestExpiresAt
		copyValue.GuestExpiresAt = &value
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
	if err := s.validateWhiteboardCheckpointAccess(ctx, principal); err != nil {
		return err
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
