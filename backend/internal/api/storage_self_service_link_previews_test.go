package api

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestStorageLinkPreviewDetachPreservesCardAndIndependentSlot(t *testing.T) {
	account, id := uuid.New(), uuid.New()
	key := account.String() + "/link-previews/test.jpg"
	before := storageLinkPreviewState{AssetID: &id, Key: key, Body: "Read https://example.org", EditedAt: "true", Preview: json.RawMessage(`{"url":"https://example.org","title":"Título","description":"Descripción","thumbnail_url":"/api/media/file/` + key + `"}`)}
	after, err := (&Server{}).storageRemoveLinkPreview(key, before)
	if err != nil {
		t.Fatal(err)
	}
	var card map[string]any
	json.Unmarshal(after.Preview, &card)
	if card["url"] != "https://example.org" || card["title"] != "Título" || card["description"] != "Descripción" || card["thumbnail_url"] != nil || after.AssetID != nil || after.Key != "" || after.Body != before.Body || after.EditedAt != before.EditedAt {
		t.Fatal("detach changed card or lifecycle")
	}
	if before.AssetID == nil || !json.Valid(before.Preview) {
		t.Fatal("mutated original recovery snapshot")
	}
	for _, state := range []storageLinkPreviewState{{Key: "another/key", Preview: before.Preview}, {Key: key, Preview: before.Preview, Revoked: true}, {Key: key, Preview: json.RawMessage(`{"thumbnail_url":"https://external.invalid/x"}`)}} {
		if _, err := (&Server{}).storageRemoveLinkPreview(key, state); err == nil {
			t.Fatal("unsafe or revoked slot accepted")
		}
	}
}

func TestStorageLinkPreviewReferenceIdentity(t *testing.T) {
	id := uuid.New()
	for _, slot := range []string{"message", "group_edit"} {
		ref := storageSelfServiceReference{Origin: "chats", ID: storagePreviewReferenceID(slot, id)}
		got, source, ok := storagePreviewReference(ref)
		if !ok || got != slot || source != id {
			t.Fatal("lost independent thumbnail use")
		}
		kind := "messages"
		if slot == "group_edit" {
			kind = "chat_group_message_state"
		}
		if storagePreviewReferenceSourceID(kind, ref.ID) != id.String() {
			t.Fatal("inventory source no longer matches physical row")
		}
	}
	if _, _, ok := storagePreviewReference(storageSelfServiceReference{Origin: "chats", ID: id.String()}); ok {
		t.Fatal("main attachment classified as thumbnail")
	}
	if storagePreviewReferenceSourceID("campaigns", "preview:"+id.String()) != "preview:"+id.String() {
		t.Fatal("unrelated source identity modified")
	}
}
