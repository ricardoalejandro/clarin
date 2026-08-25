package api

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestWhiteboardPresentationKeysAreAccountAndBoardScoped(t *testing.T) {
	accountA := uuid.New()
	accountB := uuid.New()
	board := uuid.New()
	presentation := uuid.New()
	if whiteboardPresentationIndexKey(accountA, board) == whiteboardPresentationIndexKey(accountB, board) {
		t.Fatal("presentation lease crossed the account boundary")
	}
	if got := whiteboardPresentationValueKey(accountA, board, presentation); got != whiteboardPresentationValuePrefix(accountA, board)+presentation.String() {
		t.Fatalf("unexpected presentation value key: %s", got)
	}
}

func TestWhiteboardPresentationLeaseOutlivesRenewalInterval(t *testing.T) {
	if whiteboardPresentationTTL != 45*time.Second {
		t.Fatalf("unexpected presentation TTL: %s", whiteboardPresentationTTL)
	}
	if whiteboardPresentationTTL <= 15*time.Second*2 {
		t.Fatal("presentation TTL must tolerate a delayed server-side renewal")
	}
}
