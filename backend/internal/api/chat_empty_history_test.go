package api

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

func TestCachedEmptyChatHistoryUsesArray(t *testing.T) {
	server := &Server{repos: repository.NewRepositories(nil)}
	for _, messages := range []string{"null", "[]"} {
		t.Run(messages, func(t *testing.T) {
			cached := []byte(`{"success":true,"messages":` + messages + `,"next_offset":50}`)
			projected, err := server.projectCachedChatMedia(context.Background(), uuid.New(), cached)
			if err != nil {
				t.Fatal(err)
			}
			var response map[string]json.RawMessage
			if err := json.Unmarshal(projected, &response); err != nil {
				t.Fatal(err)
			}
			if string(response["messages"]) != "[]" {
				t.Fatalf("empty cached messages = %s, want []", response["messages"])
			}
			if string(response["success"]) != "true" || string(response["next_offset"]) != "50" {
				t.Fatal("empty normalization altered envelope metadata")
			}
		})
	}
}
