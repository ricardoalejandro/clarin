package api

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/storage"
)

func TestWhiteboardTechnicalHistoryRetentionIsThirtyDaysAndBounded(t *testing.T) {
	t.Parallel()
	if whiteboardTechnicalHistoryRetention != 30*24*time.Hour {
		t.Fatalf("technical history retention=%s", whiteboardTechnicalHistoryRetention)
	}
	if whiteboardTechnicalHistoryBatch <= 0 || whiteboardTechnicalHistoryBatch > 500 {
		t.Fatalf("unsafe technical history batch=%d", whiteboardTechnicalHistoryBatch)
	}
}

func TestWhiteboardGCObjectKeyRequiresExactAccountPrivateNamespace(t *testing.T) {
	t.Parallel()
	accountID := uuid.New()
	boardID := uuid.New()
	valid := storage.PrivateObjectKey(accountID, "whiteboards", boardID.String(), "assets", "one.png")
	if !validWhiteboardGCObjectKey(accountID, valid) {
		t.Fatalf("valid key rejected: %q", valid)
	}
	for _, candidate := range []string{
		"/" + valid,
		uuid.NewString() + "/_private/whiteboards/" + boardID.String() + "/assets/one.png",
		accountID.String() + "/_private/whiteboards/../avatars/one.png",
		accountID.String() + "/whiteboards/" + boardID.String() + "/assets/one.png",
	} {
		if validWhiteboardGCObjectKey(accountID, candidate) {
			t.Fatalf("unsafe key accepted: %q", candidate)
		}
	}
}
