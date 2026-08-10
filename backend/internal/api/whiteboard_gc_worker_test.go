package api

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/storage"
)

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
