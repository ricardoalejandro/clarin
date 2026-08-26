package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

func (s *Server) broadcastWhiteboardMessage(accountID, boardID uuid.UUID, message whiteboardcore.OutgoingMessage, exceptClient uuid.UUID) {
	s.broadcastWhiteboardMessageFromClient(accountID, boardID, message, exceptClient, nil)
}

// broadcastWhiteboardMessageFromClient additionally guards ephemeral sender
// traffic. The source client must remain open and reauthorized at the exact
// PostgreSQL epoch used to enqueue recipients.
func (s *Server) broadcastWhiteboardMessageFromClient(
	accountID, boardID uuid.UUID,
	message whiteboardcore.OutgoingMessage,
	exceptClient uuid.UUID,
	sourceClient *whiteboardcore.RealtimeClient,
) {
	if message.Event == whiteboardcore.EventCommentChanged {
		s.broadcastWhiteboardMemberMessage(accountID, boardID, message, exceptClient)
		return
	}
	if s.whiteboardRooms == nil {
		return
	}
	message = whiteboardRealtimeBroadcastMessage(message)
	var sourceAccessRevision int64
	if !s.revalidateWhiteboardFanoutAuthorizationWithDelivery(accountID, boardID, false, func(revision int64) bool {
		if !s.enqueueWhiteboardFanoutAtRevision(accountID, boardID, message, exceptClient, sourceClient, revision) {
			return false
		}
		if sourceClient != nil {
			sourceAccessRevision = revision
		}
		return true
	}) {
		return
	}
	s.publishWhiteboardFanout(accountID, boardID, message, false, sourceAccessRevision)
}

func (s *Server) enqueueWhiteboardFanoutAtRevision(
	accountID, boardID uuid.UUID,
	message whiteboardcore.OutgoingMessage,
	exceptClient uuid.UUID,
	sourceClient *whiteboardcore.RealtimeClient,
	revision int64,
) bool {
	if s.whiteboardRooms == nil || (sourceClient != nil && !sourceClient.IsActiveAtRevision(revision)) {
		return false
	}
	slowClients := s.whiteboardRooms.BroadcastAtRevision(accountID, boardID, message, exceptClient, revision)
	if len(slowClients) > 0 {
		s.whiteboardRooms.Disconnect(accountID, boardID, slowClients, nil)
	}
	return true
}

func (s *Server) publishWhiteboardFanout(
	accountID, boardID uuid.UUID,
	message whiteboardcore.OutgoingMessage,
	membersOnly bool,
	sourceAccessRevision int64,
) {
	if s.cache == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	payload, err := (whiteboardcore.FanoutEnvelope{
		InstanceID:           s.whiteboardInstanceID,
		AccountID:            accountID,
		BoardID:              boardID,
		MembersOnly:          membersOnly,
		SourceAccessRevision: sourceAccessRevision,
		Message:              message,
	}).Encode()
	if err != nil {
		log.Printf("[WHITEBOARD WS] fanout encode failed: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.cache.Publish(ctx, whiteboardcore.RedisFanoutChannel, payload); err != nil {
		// PostgreSQL is canonical. A Redis outage may reduce cross-instance live
		// fan-out, but never rolls back an already committed scene operation.
		log.Printf("[WHITEBOARD WS] fanout publish failed: %v", err)
	}
}

func (s *Server) broadcastWhiteboardMemberMessage(accountID, boardID uuid.UUID, message whiteboardcore.OutgoingMessage, exceptClient uuid.UUID) {
	if s.whiteboardRooms == nil || message.Event != whiteboardcore.EventCommentChanged {
		return
	}
	message = whiteboardRealtimeBroadcastMessage(message)
	if !s.revalidateWhiteboardFanoutAuthorizationWithDelivery(accountID, boardID, false, func(revision int64) bool {
		slowClients := s.whiteboardRooms.BroadcastMembersAtRevision(accountID, boardID, message, exceptClient, revision)
		if len(slowClients) > 0 {
			s.whiteboardRooms.Disconnect(accountID, boardID, slowClients, nil)
		}
		return true
	}) {
		return
	}
	s.publishWhiteboardFanout(accountID, boardID, message, true, 0)
}

type whiteboardFanoutAccessResolver func(context.Context, whiteboardcore.RealtimeAuthorization) (string, error)

type whiteboardFanoutAccessResult struct {
	access string
	err    error
}

func whiteboardFanoutAuthorizationKey(authorization whiteboardcore.RealtimeAuthorization) string {
	switch {
	case authorization.UserID != nil:
		return "user:" + authorization.UserID.String()
	case authorization.GuestID != nil:
		return "guest:" + authorization.GuestID.String()
	default:
		return "client:" + authorization.ClientID.String()
	}
}

func whiteboardRealtimeAccessCanEdit(access string) bool {
	return access == domain.WhiteboardAccessEdit || access == domain.WhiteboardAccessManage
}

func whiteboardFanoutSourceRevisionMatches(envelope whiteboardcore.FanoutEnvelope, canonicalRevision int64) bool {
	return envelope.SourceAccessRevision <= 0 || envelope.SourceAccessRevision == canonicalRevision
}

// resolveWhiteboardFanoutAccess is intentionally account/board explicit. The
// room snapshot carries no bearer credential; member access is derived from
// current module + board/Work ACL state and guests are revalidated by their
// exact account-scoped session UUID.
func (s *Server) resolveWhiteboardFanoutAccess(
	ctx context.Context,
	accountID, boardID uuid.UUID,
	authorization whiteboardcore.RealtimeAuthorization,
) (string, error) {
	if authorization.UserID != nil {
		allowed, err := s.whiteboardModuleAllowed(ctx, *authorization.UserID, accountID)
		if err != nil {
			return "", err
		}
		if !allowed {
			return "", repository.ErrWhiteboardForbidden
		}
		access, err := s.repos.Whiteboard.RequireActiveAccess(ctx, accountID, *authorization.UserID, boardID, domain.WhiteboardAccessView)
		if err != nil {
			return "", err
		}
		return access.Level, nil
	}
	if authorization.GuestID != nil {
		return s.repos.Whiteboard.ResolveActiveGuestSessionAccessByID(
			ctx, accountID, boardID, *authorization.GuestID, time.Now().UTC(),
		)
	}
	return "", repository.ErrWhiteboardForbidden
}

func (s *Server) queuePriorityWhiteboardMessage(client *whiteboardcore.RealtimeClient, message whiteboardcore.OutgoingMessage) {
	if client == nil {
		return
	}
	payload, err := json.Marshal(message)
	if err == nil && len(payload) > 0 && len(payload) <= whiteboardcore.MaxRealtimeMessageBytes {
		// Permission/control notices have their own replace-latest lane. They may
		// supersede an older notice, but never a durable scene or comment event.
		_ = client.EnqueueControlLatest(payload)
	}
}

func (s *Server) reconcileWhiteboardFanoutClients(
	ctx context.Context,
	accountID, boardID uuid.UUID,
	canonicalRevision int64,
	workOrigin bool,
	clients []whiteboardcore.RealtimeAuthorization,
	resolve whiteboardFanoutAccessResolver,
) []*whiteboardcore.RealtimeClient {
	if s.whiteboardRooms == nil || len(clients) == 0 || resolve == nil {
		return nil
	}
	resolved := make(map[string]whiteboardFanoutAccessResult, len(clients))
	presentationsToRelease := make([]*whiteboardcore.RealtimeClient, 0)
	now := time.Now().UTC()
	for _, authorization := range clients {
		key := whiteboardFanoutAuthorizationKey(authorization)
		result, known := resolved[key]
		if !known {
			if authorization.GuestID != nil &&
				(authorization.GuestExpiresAt == nil || !authorization.GuestExpiresAt.After(now)) {
				// The effective session deadline is already part of the one-use
				// ticket principal; expiration is canonical and needs no per-guest
				// round trip before closing.
				result.err = repository.ErrWhiteboardSessionUnavailable
			} else if workOrigin && !s.workWhiteboardViewsEnabled() {
				result.err = repository.ErrWhiteboardNotFound
			} else {
				result.access, result.err = resolve(ctx, authorization)
			}
			resolved[key] = result
		}

		if result.err != nil {
			message := whiteboardcore.OutgoingMessage{
				Event: whiteboardcore.EventError, Code: "authorization_unavailable",
				Error: "No se pudo verificar el acceso a la pizarra",
			}
			if errors.Is(result.err, repository.ErrWhiteboardNotFound) ||
				errors.Is(result.err, repository.ErrWhiteboardForbidden) ||
				errors.Is(result.err, repository.ErrWhiteboardSessionUnavailable) {
				if workOrigin {
					message = workWhiteboardInvalidationMessage()
				} else {
					message = whiteboardcore.OutgoingMessage{
						Event: whiteboardcore.EventAccessRevoked, Code: "access_revoked",
						Error: "El acceso a la pizarra fue revocado",
					}
				}
			}
			s.whiteboardRooms.Disconnect(accountID, boardID, []uuid.UUID{authorization.ClientID}, &message)
			continue
		}

		authorizationChanged := authorization.AccessRevision != canonicalRevision || authorization.Access != result.access
		client, updated := s.whiteboardRooms.UpdateClientAuthorization(
			accountID, boardID, authorization.ClientID, canonicalRevision, result.access,
		)
		if !updated {
			continue
		}
		if client.Presentation() != uuid.Nil && !whiteboardRealtimeAccessCanEdit(result.access) {
			presentationsToRelease = append(presentationsToRelease, client)
		}
		// Keep distributed presence aligned with the same canonical actor access.
		// A Redis outage must not undo the authorization decision or its revision.
		_ = s.registerWhiteboardPresence(ctx, client)
		if !authorizationChanged {
			continue
		}
		message := whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventError, Code: "permission_changed",
			Error: "Tus permisos de la pizarra cambiaron", Data: map[string]any{"access": result.access},
		}
		s.queuePriorityWhiteboardMessage(client, message)
	}
	return presentationsToRelease
}

type whiteboardFanoutEpochRunner func(context.Context, uuid.UUID, uuid.UUID, func(int64) error) error

func (s *Server) withWhiteboardFanoutEpoch(
	ctx context.Context,
	accountID, boardID uuid.UUID,
	callback func(int64) error,
) error {
	if s.whiteboardFanoutEpochRunner != nil {
		return s.whiteboardFanoutEpochRunner(ctx, accountID, boardID, callback)
	}
	if s.repos == nil || s.repos.Whiteboard == nil {
		// Bounded hub tests have no repository. Production always takes the
		// PostgreSQL board-row share lock below.
		return callback(0)
	}
	return s.repos.Whiteboard.WithAccessEpoch(ctx, accountID, boardID, callback)
}

// revalidateWhiteboardFanoutRevision serializes principal resolution and any
// optional enqueue under one shared lock on the canonical whiteboards row.
// ACL/lifecycle/global authority mutations update that row and therefore
// commit wholly before or wholly after this epoch.
func (s *Server) revalidateWhiteboardFanoutRevision(accountID, boardID uuid.UUID) bool {
	return s.revalidateWhiteboardFanoutAuthorization(accountID, boardID, false)
}

func (s *Server) revalidateWhiteboardFanoutAuthorization(accountID, boardID uuid.UUID, force bool) bool {
	return s.revalidateWhiteboardFanoutAuthorizationWithDelivery(accountID, boardID, force, nil)
}

func (s *Server) revalidateWhiteboardFanoutAuthorizationWithDelivery(
	accountID, boardID uuid.UUID,
	force bool,
	deliver func(int64) bool,
) bool {
	if s.whiteboardRooms == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	delivered := false
	presentationsToRelease := make([]*whiteboardcore.RealtimeClient, 0)
	err := s.withWhiteboardFanoutEpoch(ctx, accountID, boardID, func(revision int64) error {
		if s.repos == nil || s.repos.Whiteboard == nil {
			if deliver == nil {
				delivered = true
			} else {
				delivered = deliver(revision)
			}
			return nil
		}
		releases, reconcileErr := s.reconcileWhiteboardFanoutAuthorizationAtRevision(
			ctx, accountID, boardID, revision, force,
		)
		if reconcileErr != nil {
			return reconcileErr
		}
		presentationsToRelease = append(presentationsToRelease, releases...)
		if deliver == nil {
			delivered = true
		} else {
			delivered = deliver(revision)
		}
		return nil
	})
	if err != nil {
		clientIDs := s.whiteboardRooms.ClientIDs(accountID, boardID)
		message := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventError,
			Code: "authorization_unavailable", Error: "No se pudo verificar el acceso a la pizarra"}
		if errors.Is(err, repository.ErrWhiteboardNotFound) ||
			classifyWhiteboardRealtimeAuthorization(err) == whiteboardAuthorizationAccessRevoked {
			message = whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked,
				Code: "access_revoked", Error: "La pizarra ya no está disponible"}
		}
		s.whiteboardRooms.Disconnect(accountID, boardID, clientIDs, &message)
		return false
	}
	// Presentation release broadcasts a canonical stopped event and therefore
	// opens its own fanout epoch. Run it only after the current board-row lock is
	// released; nested acquisition could deadlock behind a queued ACL writer.
	for _, client := range presentationsToRelease {
		s.releaseWhiteboardPresentation(client, "permission_revoked")
	}
	return delivered
}

func (s *Server) reconcileWhiteboardFanoutAuthorizationAtRevision(
	ctx context.Context,
	accountID, boardID uuid.UUID,
	revision int64,
	force bool,
) ([]*whiteboardcore.RealtimeClient, error) {
	clients := s.whiteboardRooms.FanoutAuthorizationClients(accountID, boardID, revision, time.Now().UTC(), force)
	if len(clients) == 0 {
		return nil, nil
	}
	if accountErr := s.requireWhiteboardAccountAccess(ctx, accountID); accountErr != nil {
		return nil, accountErr
	}
	workOrigin, originErr := s.repos.Whiteboard.IsWorkOrigin(ctx, accountID, boardID)
	if originErr != nil {
		return nil, originErr
	}
	return s.reconcileWhiteboardFanoutClients(ctx, accountID, boardID, revision, workOrigin, clients,
		func(resolveCtx context.Context, authorization whiteboardcore.RealtimeAuthorization) (string, error) {
			return s.resolveWhiteboardFanoutAccess(resolveCtx, accountID, boardID, authorization)
		}), nil
}

// notifyWhiteboardAccessChanged advances local sockets immediately and sends a
// payload-free Redis control signal so every backend instance performs the
// same canonical per-principal revalidation. No ACL or board data is trusted
// from Redis; each receiver reads PostgreSQL before touching its room.
func (s *Server) notifyWhiteboardAccessChanged(accountID, boardID uuid.UUID) {
	if s.whiteboardRooms != nil {
		_ = s.revalidateWhiteboardFanoutAuthorization(accountID, boardID, true)
	}
	if s.cache == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	payload, err := (whiteboardcore.FanoutEnvelope{
		InstanceID: s.whiteboardInstanceID, AccountID: accountID, BoardID: boardID, AccessChanged: true,
	}).Encode()
	if err != nil {
		log.Printf("[WHITEBOARD WS] access-change encode failed: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.cache.Publish(ctx, whiteboardcore.RedisFanoutChannel, payload); err != nil {
		log.Printf("[WHITEBOARD WS] access-change publish failed: %v", err)
	}
}

// notifyWhiteboardAccountAccessChanged revalidates only account rooms active
// on this process and publishes one payload-free account signal. Receivers do
// the same local-room snapshot; global ACL/subscription mutations never need
// to enumerate all persisted whiteboards or trust board IDs from another
// process.
func (s *Server) notifyWhiteboardAccountAccessChanged(accountID uuid.UUID) {
	if accountID == uuid.Nil {
		return
	}
	if s.whiteboardRooms != nil {
		for _, boardID := range s.whiteboardRooms.BoardIDsForAccount(accountID) {
			_ = s.revalidateWhiteboardFanoutAuthorization(accountID, boardID, true)
		}
	}
	if s.cache == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	payload, err := (whiteboardcore.FanoutEnvelope{
		InstanceID: s.whiteboardInstanceID, AccountID: accountID, AccountAccessChanged: true,
	}).Encode()
	if err != nil {
		log.Printf("[WHITEBOARD WS] account access-change encode failed: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.cache.Publish(ctx, whiteboardcore.RedisFanoutChannel, payload); err != nil {
		log.Printf("[WHITEBOARD WS] account access-change publish failed: %v", err)
	}
}

// publishGeneralRealtimeUserAuthorityChanged emits a payload-free account
// control for the general /ws transport. User IDs never cross Redis; receiving
// instances conservatively disconnect only this account and force current
// membership/module authority to be hydrated on reconnect.
func (s *Server) publishGeneralRealtimeUserAuthorityChanged(accountID uuid.UUID) {
	if accountID == uuid.Nil || s.cache == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	payload, err := (whiteboardcore.FanoutEnvelope{
		InstanceID: s.whiteboardInstanceID, AccountID: accountID, UserAuthorityChanged: true,
	}).Encode()
	if err != nil {
		log.Printf("[WS AUTHORITY] account signal encode failed: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.cache.Publish(ctx, whiteboardcore.RedisFanoutChannel, payload); err != nil {
		log.Printf("[WS AUTHORITY] account signal publish failed: %v", err)
	}
}

func (s *Server) applyGeneralRealtimeUserAuthorityChanged(accountID uuid.UUID) {
	if s.hub != nil {
		s.hub.DisconnectAccountForAuthority(accountID)
	}
}

// notifyAccountAuthorityChanged handles changes that affect every principal in
// an account, such as suspension or tenant activation. Local sockets close
// immediately; remote instances receive the ID-free conservative signal.
func (s *Server) notifyAccountAuthorityChanged(accountID uuid.UUID) {
	if accountID == uuid.Nil {
		return
	}
	s.applyGeneralRealtimeUserAuthorityChanged(accountID)
	s.publishGeneralRealtimeUserAuthorityChanged(accountID)
	s.notifyWhiteboardAccountAccessChanged(accountID)
}

// whiteboardRealtimeBroadcastMessage ensures that durable writes whose scene
// or patch is larger than the realtime transport budget still notify every
// instance. Receivers fetch the canonical account-scoped scene over REST; the
// oversized JSON is never copied into room queues or Redis Pub/Sub.
func whiteboardRealtimeBroadcastMessage(message whiteboardcore.OutgoingMessage) whiteboardcore.OutgoingMessage {
	payload, err := json.Marshal(message)
	if err == nil && len(payload) <= whiteboardcore.MaxRealtimeSnapshotMessageBytes {
		return message
	}
	if message.Event == whiteboardcore.EventSceneSnapshot || message.Event == whiteboardcore.EventScenePatch {
		return whiteboardSceneSyncRequiredMessage(message.Sequence, "realtime_payload_too_large")
	}
	if message.Event == whiteboardcore.EventCommentChanged {
		return whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventCommentChanged,
			Data: map[string]any{"action": "refresh", "reason": "realtime_payload_too_large"}}
	}
	return whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventError,
		Code:  "realtime_payload_too_large",
		Error: "El evento supera el límite de colaboración",
	}
}

func (s *Server) startWhiteboardFanout() {
	if s.cache == nil || s.whiteboardRooms == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.whiteboardFanoutCancel = cancel
	go func() {
		backoff := time.Second
		for ctx.Err() == nil {
			subscription, err := s.cache.Subscribe(ctx, whiteboardcore.RedisFanoutChannel)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("[WHITEBOARD WS] fanout subscription failed; retrying: %v", err)
				}
			} else {
				backoff = time.Second
				channel := subscription.Channel()
				active := true
				for active {
					select {
					case <-ctx.Done():
						active = false
					case message, ok := <-channel:
						if !ok {
							active = false
							continue
						}
						envelope, decodeErr := whiteboardcore.DecodeFanout([]byte(message.Payload))
						if decodeErr != nil {
							log.Printf("[WHITEBOARD WS] ignored invalid fanout envelope: %v", decodeErr)
							continue
						}
						if envelope.InstanceID == s.whiteboardInstanceID {
							continue
						}
						if envelope.WhiteboardHubChanged {
							s.broadcastWhiteboardHubControlLocal(envelope.AccountID, whiteboardHubChangedAction)
							continue
						}
						if envelope.WorkHubRevoked {
							s.broadcastWhiteboardHubControlLocal(envelope.AccountID, whiteboardWorkHubRevokedAction)
							continue
						}
						if envelope.UserAuthorityChanged {
							s.applyGeneralRealtimeUserAuthorityChanged(envelope.AccountID)
							continue
						}
						if envelope.AccountAccessChanged {
							for _, boardID := range s.whiteboardRooms.BoardIDsForAccount(envelope.AccountID) {
								_ = s.revalidateWhiteboardFanoutAuthorization(envelope.AccountID, boardID, true)
							}
							continue
						}
						if envelope.AccessChanged {
							_ = s.revalidateWhiteboardFanoutAuthorization(envelope.AccountID, envelope.BoardID, true)
							continue
						}
						if envelope.Message.Event == whiteboardcore.EventAccessRevoked {
							var clientIDs []uuid.UUID
							if envelope.TargetGuestID != nil {
								clientIDs = s.whiteboardRooms.RevokeGuestSession(envelope.AccountID, envelope.BoardID, *envelope.TargetGuestID)
							} else if envelope.TargetUserID != nil {
								clientIDs = s.whiteboardRooms.RevokeUserAccess(envelope.AccountID, envelope.BoardID, *envelope.TargetUserID)
							} else {
								clientIDs = s.whiteboardRooms.ClientIDs(envelope.AccountID, envelope.BoardID)
							}
							if len(clientIDs) > 0 {
								s.whiteboardRooms.Disconnect(envelope.AccountID, envelope.BoardID, clientIDs, &envelope.Message)
							}
							continue
						}
						_ = s.revalidateWhiteboardFanoutAuthorizationWithDelivery(
							envelope.AccountID, envelope.BoardID, false, func(revision int64) bool {
								if !whiteboardFanoutSourceRevisionMatches(envelope, revision) {
									return false
								}
								var slowClients []uuid.UUID
								if envelope.MembersOnly {
									slowClients = s.whiteboardRooms.BroadcastMembersAtRevision(
										envelope.AccountID, envelope.BoardID, envelope.Message, uuid.Nil, revision,
									)
								} else {
									slowClients = s.whiteboardRooms.BroadcastAtRevision(
										envelope.AccountID, envelope.BoardID, envelope.Message, uuid.Nil, revision,
									)
								}
								if len(slowClients) > 0 {
									s.whiteboardRooms.Disconnect(envelope.AccountID, envelope.BoardID, slowClients, nil)
								}
								return true
							},
						)
					}
				}
				_ = subscription.Close()
			}
			if ctx.Err() != nil {
				return
			}
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			if backoff < 30*time.Second {
				backoff *= 2
				if backoff > 30*time.Second {
					backoff = 30 * time.Second
				}
			}
		}
	}()
}

func (s *Server) revokeWhiteboardGuestSockets(accountID, boardID, guestID uuid.UUID) {
	message := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "access_revoked", Error: "La sesión compartida fue revocada"}
	if s.whiteboardRooms != nil {
		clientIDs := s.whiteboardRooms.RevokeGuestSession(accountID, boardID, guestID)
		s.whiteboardRooms.Disconnect(accountID, boardID, clientIDs, &message)
	}
	s.publishWhiteboardRevocation(accountID, boardID, nil, &guestID, message)
}

func (s *Server) revokeWhiteboardUserSockets(accountID, boardID, userID uuid.UUID) {
	message := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "access_revoked", Error: "El acceso a la pizarra fue revocado"}
	if s.whiteboardRooms != nil {
		clientIDs := s.whiteboardRooms.RevokeUserAccess(accountID, boardID, userID)
		s.whiteboardRooms.Disconnect(accountID, boardID, clientIDs, &message)
	}
	s.publishWhiteboardRevocation(accountID, boardID, &userID, nil, message)
}

func whiteboardBoardDeletedMessage() whiteboardcore.OutgoingMessage {
	return whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "board_deleted", Error: "La pizarra fue eliminada permanentemente"}
}

func workWhiteboardInvalidationMessage() whiteboardcore.OutgoingMessage {
	return whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "work_access_changed", Error: "El acceso o el estado de esta pizarra cambió en Clarin Work"}
}

func whiteboardArchivedMessage() whiteboardcore.OutgoingMessage {
	return whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "board_archived", Error: "La pizarra fue movida a la Papelera"}
}

func (s *Server) disconnectWhiteboardBoardSockets(accountID, boardID uuid.UUID, message whiteboardcore.OutgoingMessage) {
	if s.whiteboardRooms != nil {
		clientIDs := s.whiteboardRooms.ClientIDs(accountID, boardID)
		s.whiteboardRooms.Disconnect(accountID, boardID, clientIDs, &message)
	}
	s.publishWhiteboardRevocation(accountID, boardID, nil, nil, message)
}

func (s *Server) revokeWhiteboardBoardSockets(accountID, boardID uuid.UUID) {
	s.disconnectWhiteboardBoardSockets(accountID, boardID, whiteboardBoardDeletedMessage())
}

func (s *Server) invalidateWorkWhiteboardSockets(accountID, boardID uuid.UUID) {
	s.disconnectWhiteboardBoardSockets(accountID, boardID, workWhiteboardInvalidationMessage())

}

func (s *Server) invalidateArchivedWhiteboardSockets(accountID, boardID uuid.UUID) {
	s.disconnectWhiteboardBoardSockets(accountID, boardID, whiteboardArchivedMessage())
}

func (s *Server) publishWhiteboardRevocation(accountID, boardID uuid.UUID, userID, guestID *uuid.UUID, message whiteboardcore.OutgoingMessage) {
	if s.cache == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	payload, err := (whiteboardcore.FanoutEnvelope{
		InstanceID: s.whiteboardInstanceID, AccountID: accountID, BoardID: boardID,
		TargetUserID: userID, TargetGuestID: guestID, Message: message,
	}).Encode()
	if err != nil {
		log.Printf("[WHITEBOARD WS] revocation encode failed: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.cache.Publish(ctx, whiteboardcore.RedisFanoutChannel, payload); err != nil {
		log.Printf("[WHITEBOARD WS] revocation publish failed: %v", err)
	}
}
