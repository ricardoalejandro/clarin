package repository

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestObservationCursorKeepsStableOrderAndIdentity(t *testing.T) {
	a, c := uuid.New(), uuid.New()
	now := time.Now().UTC().Truncate(time.Microsecond)
	item := &domain.Interaction{ID: uuid.New(), Type: domain.InteractionTypeNote, IsPinned: true, PinnedAt: &now, CreatedAt: now.Add(-time.Hour)}
	encoded := encodeObservationCursor(a, c, "chat:one", item)
	decoded, err := decodeObservationCursor(encoded, a, c, "chat:one")
	if err != nil || decoded.ID != item.ID || !decoded.Pinned || decoded.PinnedAt == nil || !decoded.PinnedAt.Equal(now) || !decoded.CreatedAt.Equal(item.CreatedAt) {
		t.Fatalf("cursor did not round trip: %+v %v", decoded, err)
	}
	for _, scope := range []struct {
		a, c    uuid.UUID
		context string
	}{{uuid.New(), c, "chat:one"}, {a, uuid.New(), "chat:one"}, {a, c, "lead:one"}} {
		if _, err := decodeObservationCursor(encoded, scope.a, scope.c, scope.context); err != ErrContactObservationCursor {
			t.Fatal("cross-identity cursor accepted")
		}
	}
}

func TestObservationCursorRejectsMalformedAndSupportsUnpinned(t *testing.T) {
	a, c := uuid.New(), uuid.New()
	for _, value := range []string{"!invalid", "e30"} {
		if _, err := decodeObservationCursor(value, a, c, ""); err != ErrContactObservationCursor {
			t.Fatal("invalid cursor accepted")
		}
	}
	item := &domain.Interaction{ID: uuid.New(), Type: domain.InteractionTypeNote, CreatedAt: time.Now().UTC()}
	decoded, err := decodeObservationCursor(encodeObservationCursor(a, c, "", item), a, c, "")
	if err != nil || decoded.Pinned || decoded.PinnedAt != nil {
		t.Fatal("unpinned ordering changed")
	}
}
