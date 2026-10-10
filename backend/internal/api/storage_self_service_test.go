package api

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/ws"
)

func TestStorageSelfServiceClassifiesHumanMediaOnly(t *testing.T) {
	for _, tc := range []struct{ name, mime, want string }{
		{"presupuesto.pdf", "application/pdf", "document"}, {"foto.jpg", "image/jpeg", "image"}, {"voz.m4a", "audio/mp4", "audio"}, {"curso.mp4", "video/mp4", "video"}, {"nómina.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document"},
		{"postgres.sql", "application/pdf", ""}, {"server.log", "image/png", ""}, {"state.json", "application/json", ""}, {"dump.sqlite", "", ""}, {"snapshot.bin", "application/octet-stream", ""}, {"account/chats/server.log", "", ""},
	} {
		if got := storageSelfServiceMediaType(tc.name, tc.mime); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
}
func TestStorageSelfServiceSelectionRejectsForeignAndTraversal(t *testing.T) {
	account := uuid.New()
	key := account.String() + "/chats/photo.jpg"
	got, err := storageSelfServiceCleanSelection(account, []string{key, key})
	if err != nil || len(got) != 1 {
		t.Fatalf("unique selection %v %v", got, err)
	}
	for _, invalid := range []string{uuid.NewString() + "/chats/photo.jpg", account.String() + "/../photo.jpg", account.String() + "//chats/photo.jpg", account.String() + "/chats\\photo.jpg", account.String() + "/chats/photo.jpg\nheader"} {
		if _, err := storageSelfServiceCleanSelection(account, []string{invalid}); err == nil {
			t.Errorf("accepted %q", invalid)
		}
	}
	if _, err := storageSelfServiceCleanSelection(account, make([]string, 101)); err == nil {
		t.Fatal("selection cap missing")
	}
}
func TestStorageSelfServiceExtractsNestedReferencesExactly(t *testing.T) {
	account, foreign := uuid.New(), uuid.New()
	key := account.String() + "/uploads/imagen.png"
	payload, _ := json.Marshal(map[string]interface{}{"branding": map[string]string{"background": "https://site.invalid/api/media/file/" + key + "?token=ignored"}, "canvas": []string{"/api/media/file/" + key, foreign.String() + "/uploads/hidden.jpg"}, "key": key})
	if got := storageSelfServiceExtractKeys(account, string(payload)); !reflect.DeepEqual(got, []string{key}) {
		t.Fatalf("got %v", got)
	}
}
func TestStorageSelfServiceSettingsDoNotGrantChatAccess(t *testing.T) {
	refs := []storageSelfServiceReference{{Origin: "chats", ID: "one"}}
	claims := &service.JWTClaims{Role: "member", Permissions: []string{domain.PermSettings}}
	if storageSelfServiceCanRead(claims, refs) {
		t.Fatal("settings revealed chats")
	}
	claims.Permissions = append(claims.Permissions, domain.PermChats)
	if !storageSelfServiceCanRead(claims, refs) {
		t.Fatal("chat access rejected")
	}
	claims.Role = "admin"
	if storageSelfServiceCanRead(claims, []storageSelfServiceReference{{Origin: "private_work"}}) {
		t.Fatal("admin bypassed private Work ACL")
	}
}
func TestStorageSelfServiceFiltersStablePagesAndTrash(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	files := []storageSelfServiceFile{{ObjectKey: "b", Filename: "B.pdf", MediaType: "document", SizeBytes: 10, Status: "active", CanRemove: true, LastModified: now.Add(-8 * 24 * time.Hour), Origins: []storageSelfServiceReference{{Origin: "chats", Label: "Amigos"}}}, {ObjectKey: "a", Filename: "A.pdf", MediaType: "document", SizeBytes: 10, Status: "active", CanRemove: true, LastModified: now.Add(-8 * 24 * time.Hour)}, {ObjectKey: "trash", Filename: "C.pdf", MediaType: "document", SizeBytes: 99, Status: "trash", LastModified: now}}
	got := storageSelfServiceFilterFiles(files, "", "", "", "all", "size", "desc", 0, 0, now)
	if len(got) != 2 || got[0].ObjectKey != "a" || got[1].ObjectKey != "b" {
		t.Fatalf("unstable tie sort %v", got)
	}
	got = storageSelfServiceFilterFiles(files, "document", "amigos", "chats", "removable", "size", "desc", 10, 7, now)
	if len(got) != 1 || got[0].ObjectKey != "b" {
		t.Fatalf("filters %v", got)
	}
	got = storageSelfServiceFilterFiles(files, "", "", "", "trash", "size", "desc", 0, 0, now)
	if len(got) != 1 || got[0].ObjectKey != "trash" {
		t.Fatal("trash mixed into active files")
	}
}
func TestStorageSelfServiceFingerprintChangesWithEveryLiveReference(t *testing.T) {
	f := storageSelfServiceFile{ObjectKey: "file", SizeBytes: 10, Status: "active", LastModified: time.Now()}
	a := []storageSelfServiceReference{{Origin: "chats", ID: "a"}}
	original := storageSelfServiceFingerprint(f, a)
	if original == storageSelfServiceFingerprint(f, append(a, storageSelfServiceReference{Origin: "campaigns", ID: "b"})) {
		t.Fatal("new shared reference did not invalidate preview")
	}
	f.SizeBytes++
	if original == storageSelfServiceFingerprint(f, a) {
		t.Fatal("changed bytes did not invalidate preview")
	}
}

func TestStorageSelfServiceUnknownOriginOnlyProtectsNeverGrantsAccess(t *testing.T) {
	account := uuid.New()
	key := account.String() + "/uploads/informe anual.pdf"
	external := storageSelfServiceReferenceValues(account, "https://unrelated.invalid/custom-bucket/"+key)
	if read, found := external[key]; !found || read {
		t.Fatalf("external must protect without granting read: %v", external)
	}
	local := storageSelfServiceReferenceValues(account, "/api/media/file/"+key)
	if !local[key] {
		t.Fatalf("local filename with spaces lost: %v", local)
	}
	encoded := strings.ReplaceAll("/api/media/file/"+account.String()+"%2Fuploads%2Finforme%20anual.pdf", " ", "%20")
	if !storageSelfServiceReferenceValues(account, encoded)[key] {
		t.Fatal("encoded canonical path lost")
	}
}

func TestStorageSelfServiceRealtimeOnlyPublishesSameAccountCanonicalMessages(t *testing.T) {
	account, chat := uuid.New(), uuid.New()
	canonical := &domain.Message{ID: uuid.New(), AccountID: account, ChatID: chat, MediaDeleted: true}
	calls := 0
	storageSelfServicePublishMessages(account, []*domain.Message{nil, canonical, {ID: uuid.New(), AccountID: uuid.New(), ChatID: chat}, {ID: uuid.New(), AccountID: account}}, func(gotAccount uuid.UUID, permission, event string, payload interface{}) {
		calls++
		if gotAccount != account || permission != domain.PermChats || event != ws.EventMessageUpdated {
			t.Fatal("event scope changed")
		}
		data := payload.(map[string]interface{})
		if data["chat_id"] != chat.String() || data["message"] != canonical {
			t.Fatal("canonical payload lost")
		}
	})
	if calls != 1 {
		t.Fatalf("published %d events, want only the authorized message", calls)
	}
}
