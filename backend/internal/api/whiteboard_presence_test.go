package api

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestWhiteboardPresenceKeysAreAccountAndBoardScoped(t *testing.T) {
	accountA := uuid.New()
	accountB := uuid.New()
	board := uuid.New()
	client := uuid.New()

	indexA := whiteboardPresenceIndexKey(accountA, board)
	indexB := whiteboardPresenceIndexKey(accountB, board)
	if indexA == indexB {
		t.Fatal("presence index must be account scoped")
	}
	if !strings.Contains(indexA, accountA.String()) || !strings.Contains(indexA, board.String()) {
		t.Fatalf("presence index is missing its account/board boundary: %s", indexA)
	}
	if got := whiteboardPresenceValueKey(accountA, board, client); got != whiteboardPresenceValuePrefix(accountA, board)+client.String() {
		t.Fatalf("unexpected presence value key: %s", got)
	}
}

func TestWhiteboardPresenceLeaseOutlivesHeartbeat(t *testing.T) {
	if whiteboardPresenceTTL <= whiteboardPingInterval*2 {
		t.Fatalf("presence TTL %s must tolerate at least two heartbeat intervals", whiteboardPresenceTTL)
	}
}
