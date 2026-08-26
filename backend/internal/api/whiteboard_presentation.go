package api

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

const whiteboardPresentationTTL = 45 * time.Second

var (
	errWhiteboardPresentationUnavailable = errors.New("whiteboard presentation unavailable")
	errWhiteboardPresentationOccupied    = errors.New("whiteboard presentation occupied")
	errWhiteboardPresentationNotOwned    = errors.New("whiteboard presentation not owned")
)

type whiteboardPresentation struct {
	ID        uuid.UUID                    `json:"presentation_id"`
	Actor     whiteboardcore.RealtimeActor `json:"actor"`
	StartedAt time.Time                    `json:"started_at"`
}

func runWhiteboardPresentationStartAtEpoch(
	authorize func() error,
	acquire func() (*whiteboardPresentation, bool, error),
	fanout func(*whiteboardPresentation) error,
	acknowledge func(*whiteboardPresentation, bool),
) (*whiteboardPresentation, bool, error) {
	if err := authorize(); err != nil {
		return nil, false, err
	}
	presentation, idempotent, err := acquire()
	if err != nil {
		return nil, false, err
	}
	if !idempotent {
		if err := fanout(presentation); err != nil {
			return presentation, false, err
		}
	}
	acknowledge(presentation, idempotent)
	return presentation, idempotent, nil
}

// startAuthorizedWhiteboardPresentation serializes the edit check, Redis
// lease, local/Redis started fanout and ACK under the canonical board epoch.
// An ACL downgrade can therefore win either before the lease exists (no lease
// and no ACK) or after the complete start is visible (normal stopped release),
// but never in the middle.
func (s *Server) startAuthorizedWhiteboardPresentation(
	ctx context.Context,
	principal *whiteboardRealtimePrincipal,
	client *whiteboardcore.RealtimeClient,
	operationID uuid.UUID,
) (*whiteboardPresentation, bool, error) {
	if principal == nil || client == nil || operationID == uuid.Nil {
		return nil, false, whiteboardRealtimeAuthorizationFailure(
			domain.WhiteboardAccessEdit, repository.ErrWhiteboardForbidden,
		)
	}
	var presentation *whiteboardPresentation
	var idempotent bool
	var presentationsToRelease []*whiteboardcore.RealtimeClient
	err := s.withWhiteboardFanoutEpoch(ctx, principal.AccountID, principal.BoardID, func(revision int64) error {
		var runErr error
		presentation, idempotent, runErr = runWhiteboardPresentationStartAtEpoch(
			func() error {
				access, accessErr := s.resolveWhiteboardRealtimeAccess(ctx, principal, domain.WhiteboardAccessEdit)
				if accessErr != nil {
					return accessErr
				}
				registered, updated := s.whiteboardRooms.UpdateClientAuthorization(
					principal.AccountID, principal.BoardID, client.ID, revision, access,
				)
				if !updated || registered != client || !client.IsActiveAtRevision(revision) ||
					!whiteboardRealtimeAccessCanEdit(client.ActorSnapshot().Access) {
					return whiteboardRealtimeAuthorizationFailure(
						domain.WhiteboardAccessEdit, repository.ErrWhiteboardForbidden,
					)
				}
				releases, reconcileErr := s.reconcileWhiteboardFanoutAuthorizationAtRevision(
					ctx, principal.AccountID, principal.BoardID, revision, false,
				)
				presentationsToRelease = append(presentationsToRelease, releases...)
				return reconcileErr
			},
			func() (*whiteboardPresentation, bool, error) {
				return s.startWhiteboardPresentation(ctx, client, operationID)
			},
			func(started *whiteboardPresentation) error {
				message := whiteboardRealtimeBroadcastMessage(whiteboardcore.OutgoingMessage{
					Event: whiteboardcore.EventPresentationChanged,
					Actor: client.ActorSnapshot(),
					Data:  map[string]any{"presentation": started, "status": "started"},
				})
				if !s.enqueueWhiteboardFanoutAtRevision(
					principal.AccountID, principal.BoardID, message, uuid.Nil, client, revision,
				) {
					return whiteboardRealtimeAuthorizationFailure(
						domain.WhiteboardAccessEdit, repository.ErrWhiteboardForbidden,
					)
				}
				s.publishWhiteboardFanout(principal.AccountID, principal.BoardID, message, false, revision)
				return nil
			},
			func(started *whiteboardPresentation, retry bool) {
				s.queueWhiteboardMessage(client, whiteboardcore.OutgoingMessage{
					Event: whiteboardcore.EventAck, OperationID: &operationID,
					Data: map[string]any{
						"presentation": started,
						"idempotent":   retry,
					},
				})
			},
		)
		return runErr
	})
	// These stopped broadcasts require their own epoch and must occur only after
	// the start epoch releases its board-row lock.
	if err != nil && presentation != nil && !idempotent {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.stopWhiteboardPresentation(cleanupCtx, client, presentation.ID, "start_cancelled")
		cleanupCancel()
	}
	for _, presenter := range presentationsToRelease {
		s.releaseWhiteboardPresentation(presenter, "permission_revoked")
	}
	return presentation, idempotent, err
}

func whiteboardPresentationIndexKey(accountID, boardID uuid.UUID) string {
	return "whiteboard:presentation:" + accountID.String() + ":" + boardID.String()
}

func whiteboardPresentationValuePrefix(accountID, boardID uuid.UUID) string {
	return whiteboardPresentationIndexKey(accountID, boardID) + ":lease:"
}

func whiteboardPresentationValueKey(accountID, boardID, presentationID uuid.UUID) string {
	return whiteboardPresentationValuePrefix(accountID, boardID) + presentationID.String()
}

func (s *Server) activeWhiteboardPresentation(ctx context.Context, accountID, boardID uuid.UUID) (*whiteboardPresentation, error) {
	if s.cache == nil {
		return nil, errWhiteboardPresentationUnavailable
	}
	payloads, err := s.cache.ListExpiringMembers(ctx,
		whiteboardPresentationIndexKey(accountID, boardID),
		whiteboardPresentationValuePrefix(accountID, boardID))
	if err != nil {
		return nil, errWhiteboardPresentationUnavailable
	}
	if len(payloads) == 0 {
		return nil, nil
	}
	var presentation whiteboardPresentation
	if json.Unmarshal(payloads[0], &presentation) != nil || presentation.ID == uuid.Nil || presentation.Actor.ID == uuid.Nil {
		return nil, errWhiteboardPresentationUnavailable
	}
	presence, err := s.whiteboardPresence(ctx, accountID, boardID)
	if err != nil {
		return nil, errWhiteboardPresentationUnavailable
	}
	for _, actor := range presence {
		if actor.ID == presentation.Actor.ID {
			return &presentation, nil
		}
	}
	if err := s.cache.RemoveExpiringMember(ctx,
		whiteboardPresentationIndexKey(accountID, boardID),
		whiteboardPresentationValueKey(accountID, boardID, presentation.ID), presentation.ID.String()); err != nil {
		return nil, errWhiteboardPresentationUnavailable
	}
	return nil, nil
}

func (s *Server) startWhiteboardPresentation(ctx context.Context, client *whiteboardcore.RealtimeClient, presentationID uuid.UUID) (*whiteboardPresentation, bool, error) {
	if s.cache == nil || client == nil || presentationID == uuid.Nil {
		return nil, false, errWhiteboardPresentationUnavailable
	}
	active, err := s.activeWhiteboardPresentation(ctx, client.AccountID, client.BoardID)
	if err != nil {
		return nil, false, err
	}
	if active != nil {
		if active.ID == presentationID && active.Actor.ID == client.ActorSnapshot().ID {
			client.SetPresentation(presentationID)
			return active, true, nil
		}
		return nil, false, errWhiteboardPresentationOccupied
	}
	presentation := &whiteboardPresentation{ID: presentationID, Actor: client.ActorSnapshot(), StartedAt: time.Now().UTC()}
	payload, err := json.Marshal(presentation)
	if err != nil {
		return nil, false, errWhiteboardPresentationUnavailable
	}
	registered, err := s.cache.RegisterExpiringMember(ctx,
		whiteboardPresentationIndexKey(client.AccountID, client.BoardID),
		whiteboardPresentationValueKey(client.AccountID, client.BoardID, presentationID),
		presentationID.String(), payload, 1, whiteboardPresentationTTL)
	if err != nil {
		return nil, false, errWhiteboardPresentationUnavailable
	}
	if !registered {
		return nil, false, errWhiteboardPresentationOccupied
	}
	client.SetPresentation(presentationID)
	return presentation, false, nil
}

func (s *Server) stopWhiteboardPresentation(ctx context.Context, client *whiteboardcore.RealtimeClient, presentationID uuid.UUID, reason string) error {
	if s.cache == nil || client == nil || presentationID == uuid.Nil {
		return errWhiteboardPresentationUnavailable
	}
	active, err := s.activeWhiteboardPresentation(ctx, client.AccountID, client.BoardID)
	if err != nil {
		return err
	}
	if active == nil {
		client.ClearPresentation(presentationID)
		return nil
	}
	if active.ID != presentationID || active.Actor.ID != client.ActorSnapshot().ID {
		return errWhiteboardPresentationNotOwned
	}
	if err := s.cache.RemoveExpiringMember(ctx,
		whiteboardPresentationIndexKey(client.AccountID, client.BoardID),
		whiteboardPresentationValueKey(client.AccountID, client.BoardID, presentationID), presentationID.String()); err != nil {
		return errWhiteboardPresentationUnavailable
	}
	client.ClearPresentation(presentationID)
	s.broadcastWhiteboardMessage(client.AccountID, client.BoardID, whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventPresentationChanged,
		Actor: client.ActorSnapshot(),
		Data:  map[string]any{"presentation_id": presentationID, "status": "stopped", "reason": reason},
	}, uuid.Nil)
	return nil
}

func (s *Server) releaseWhiteboardPresentation(client *whiteboardcore.RealtimeClient, reason string) {
	if client == nil {
		return
	}
	presentationID := client.Presentation()
	if presentationID == uuid.Nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.stopWhiteboardPresentation(ctx, client, presentationID, reason)
}

func (s *Server) refreshWhiteboardPresentation(ctx context.Context, client *whiteboardcore.RealtimeClient) error {
	if client == nil || client.Presentation() == uuid.Nil {
		return nil
	}
	if s.cache == nil {
		return errWhiteboardPresentationUnavailable
	}
	presentationID := client.Presentation()
	refreshed, err := s.cache.RefreshExpiringMember(ctx,
		whiteboardPresentationIndexKey(client.AccountID, client.BoardID),
		whiteboardPresentationValueKey(client.AccountID, client.BoardID, presentationID),
		presentationID.String(), whiteboardPresentationTTL)
	if err != nil {
		return errWhiteboardPresentationUnavailable
	}
	if refreshed {
		return nil
	}
	if client.ClearPresentation(presentationID) {
		s.broadcastWhiteboardMessage(client.AccountID, client.BoardID, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventPresentationChanged,
			Actor: client.ActorSnapshot(),
			Data:  map[string]any{"presentation_id": presentationID, "status": "stopped", "reason": "expired"},
		}, uuid.Nil)
	}
	return nil
}

func (s *Server) whiteboardPresentationSnapshotMessage(ctx context.Context, accountID, boardID uuid.UUID) (whiteboardcore.OutgoingMessage, error) {
	presentation, err := s.activeWhiteboardPresentation(ctx, accountID, boardID)
	if err != nil {
		return whiteboardcore.OutgoingMessage{}, err
	}
	return whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventPresentationSnapshot,
		Data:  map[string]any{"presentation": presentation},
	}, nil
}

func (s *Server) whiteboardActorIsPresent(ctx context.Context, accountID, boardID, actorID uuid.UUID) (bool, error) {
	presence, err := s.whiteboardPresence(ctx, accountID, boardID)
	if err != nil {
		return false, err
	}
	for _, actor := range presence {
		if actor.ID == actorID {
			return true, nil
		}
	}
	return false, nil
}
