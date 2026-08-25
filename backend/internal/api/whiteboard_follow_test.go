package api

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

func TestWhiteboardFollowChangeToSameSessionIsNoOp(t *testing.T) {
	accountID := uuid.New()
	boardID := uuid.New()
	actorID := uuid.New()
	principal := &whiteboardRealtimePrincipal{
		AccountID: accountID,
		BoardID:   boardID,
		Actor: whiteboardcore.RealtimeActor{
			Kind: "user", ID: actorID, DisplayName: "Luis", Access: "edit",
		},
		LastEphemeralValidation: time.Now(),
	}
	source := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID, Actor: principal.Actor, Send: make(chan []byte, 1),
	}
	observer := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		Actor: whiteboardcore.RealtimeActor{Kind: "guest", ID: uuid.New(), DisplayName: "Ana", Access: "view"},
		Send:  make(chan []byte, 1),
	}
	server := &Server{whiteboardRooms: whiteboardcore.NewRoomHub()}
	if err := server.whiteboardRooms.Register(source); err != nil {
		t.Fatalf("register source: %v", err)
	}
	if err := server.whiteboardRooms.Register(observer); err != nil {
		t.Fatalf("register observer: %v", err)
	}
	data, err := json.Marshal(whiteboardcore.FollowChangeData{TargetActorID: actorID, Action: "FOLLOW"})
	if err != nil {
		t.Fatalf("marshal follow change: %v", err)
	}

	err = server.handleWhiteboardRealtimeMessage(context.Background(), principal, source, whiteboardcore.IncomingMessage{
		Event: whiteboardcore.EventFollowChange,
		Data:  data,
	})
	if err != nil {
		t.Fatalf("self-follow must be an idempotent no-op: %v", err)
	}
	select {
	case payload := <-source.Send:
		t.Fatalf("self-follow unexpectedly replied to its source: %s", payload)
	default:
	}
	select {
	case payload := <-observer.Send:
		t.Fatalf("self-follow unexpectedly fanned out: %s", payload)
	default:
	}
}

func TestWhiteboardFollowChangeRejectsUnavailableAndForeignTargets(t *testing.T) {
	for _, testCase := range []struct {
		name            string
		registerForeign bool
	}{
		{name: "absent"},
		{name: "foreign account", registerForeign: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			accountID := uuid.New()
			boardID := uuid.New()
			targetActorID := uuid.New()
			principal := &whiteboardRealtimePrincipal{
				AccountID: accountID,
				BoardID:   boardID,
				Actor: whiteboardcore.RealtimeActor{
					Kind: "user", ID: uuid.New(), DisplayName: "Luis", Access: "edit",
				},
				LastEphemeralValidation: time.Now(),
			}
			source := &whiteboardcore.RealtimeClient{
				ID: uuid.New(), AccountID: accountID, BoardID: boardID, Actor: principal.Actor, Send: make(chan []byte, 1),
			}
			server := &Server{whiteboardRooms: whiteboardcore.NewRoomHub()}
			if err := server.whiteboardRooms.Register(source); err != nil {
				t.Fatalf("register source: %v", err)
			}
			if testCase.registerForeign {
				foreign := &whiteboardcore.RealtimeClient{
					ID: uuid.New(), AccountID: uuid.New(), BoardID: boardID,
					Actor: whiteboardcore.RealtimeActor{Kind: "user", ID: targetActorID, DisplayName: "Ajeno", Access: "edit"},
					Send:  make(chan []byte, 1),
				}
				if err := server.whiteboardRooms.Register(foreign); err != nil {
					t.Fatalf("register foreign target: %v", err)
				}
			}
			data, err := json.Marshal(whiteboardcore.FollowChangeData{TargetActorID: targetActorID, Action: "FOLLOW"})
			if err != nil {
				t.Fatalf("marshal follow change: %v", err)
			}

			err = server.handleWhiteboardRealtimeMessage(context.Background(), principal, source, whiteboardcore.IncomingMessage{
				Event: whiteboardcore.EventFollowChange,
				Data:  data,
			})
			if err != nil {
				t.Fatalf("unavailable target should produce a typed client error: %v", err)
			}
			select {
			case payload := <-source.Send:
				var message whiteboardcore.OutgoingMessage
				if err := json.Unmarshal(payload, &message); err != nil {
					t.Fatalf("decode client error: %v", err)
				}
				if message.Event != whiteboardcore.EventError || message.Code != "follow_target_unavailable" {
					t.Fatalf("unexpected unavailable-target response: %+v", message)
				}
			default:
				t.Fatal("unavailable target was not rejected")
			}
		})
	}
}
