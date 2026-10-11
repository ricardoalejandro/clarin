package api

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func storageUseTestRow(values map[string]any) map[string]json.RawMessage {
	result := map[string]json.RawMessage{}
	for k, v := range values {
		storageJSONSet(result, k, v)
	}
	return result
}

func TestStorageOrdinaryRemovalPreservesQuickReplyOrderAndText(t *testing.T) {
	s := &Server{}
	account := uuid.New()
	key := account.String() + "/shared.pdf"
	url := "/api/media/file/" + key
	removed, retained := uuid.New(), uuid.New()
	before := storageOrdinaryState{Row: storageUseTestRow(map[string]any{"body": "Keep original text", "media_url": url, "media_type": "document", "items": []any{map[string]any{"type": "text", "text": "Before"}, map[string]any{"type": "attachment", "attachment_id": removed}, map[string]any{"type": "text", "text": "After"}, map[string]any{"type": "attachment", "attachment_id": retained}}}), Attachments: []map[string]json.RawMessage{storageUseTestRow(map[string]any{"id": removed, "media_url": url, "position": 0}), storageUseTestRow(map[string]any{"id": retained, "media_url": "/api/media/file/" + account.String() + "/other.pdf", "position": 1})}}
	fingerprint := storageUseFingerprint(before)
	after, err := s.storageOrdinaryRemovedState("quick_replies", key, before)
	if err != nil {
		t.Fatal(err)
	}
	if storageUseFingerprint(before) != fingerprint {
		t.Fatal("mutated snapshot input")
	}
	if len(after.Attachments) != 1 || storageJSONID(after.Attachments[0], "id") != retained || storageJSONText(after.Row, "body") != "Keep original text" || storageJSONText(after.Row, "media_url") != "/api/media/file/"+account.String()+"/other.pdf" {
		t.Fatalf("unexpected transformed reply: %s", mustStorageUseJSON(after))
	}
	var items []map[string]json.RawMessage
	_ = json.Unmarshal(after.Row["items"], &items)
	if len(items) != 3 || storageJSONText(items[0], "text") != "Before" || storageJSONText(items[1], "text") != "After" || storageJSONID(items[2], "attachment_id") != retained {
		t.Fatal("ordered send sequence changed")
	}
}
func mustStorageUseJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
func TestStorageOrdinaryProtectsEmptyReplyAndLiveCampaign(t *testing.T) {
	s := &Server{}
	key := uuid.NewString() + "/image.png"
	url := "/api/media/file/" + key
	for _, status := range []string{"running", "scheduled", "paused", "completed", "failed", "cancelled"} {
		state := storageOrdinaryState{Row: storageUseTestRow(map[string]any{"status": status, "media_url": url})}
		if _, err := s.storageOrdinaryRemovedState("campaigns", key, state); err == nil {
			t.Fatalf("unsafe campaign status %s", status)
		}
	}
	state := storageOrdinaryState{Row: storageUseTestRow(map[string]any{"body": "", "media_url": url, "items": []any{map[string]any{"media_url": url}}}), Attachments: []map[string]json.RawMessage{}}
	if _, err := s.storageOrdinaryRemovedState("quick_replies", key, state); err == nil {
		t.Fatal("removed final sendable content")
	}
	state.Row = storageUseTestRow(map[string]any{"status": "draft", "media_url": url, "settings": map[string]any{"nested": []any{url}}})
	if _, err := s.storageOrdinaryRemovedState("campaigns", key, state); err == nil {
		t.Fatal("unknown JSON setting was not protected")
	}
}
func TestStorageOrdinaryMutationRequiresManagementPermissions(t *testing.T) {
	actor := storageUseActor{Claims: &service.JWTClaims{Permissions: []string{domain.PermChats, domain.PermSettings}}}
	if !storageOrdinaryCanManage(actor, "chats") || storageOrdinaryCanManage(actor, "quick_replies") {
		t.Fatal("quick reply editing inherited chat read permission")
	}
	actor.Claims.Permissions = append(actor.Claims.Permissions, domain.PermQuickRepliesManage)
	if !storageOrdinaryCanManage(actor, "quick_replies") {
		t.Fatal("authorized quick reply edit denied")
	}
	actor.Claims.Permissions = []string{domain.PermChats, domain.PermQuickRepliesManage}
	if storageOrdinaryCanManage(actor, "quick_replies") {
		t.Fatal("storage permission missing")
	}
}
