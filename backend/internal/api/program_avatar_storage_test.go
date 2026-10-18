package api

import (
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"testing"
)

func TestProgramAvatarStorageReadRequiresProgramPermission(t *testing.T) {
	refs := []storageSelfServiceReference{{Origin: "programs", ID: uuid.NewString(), Label: "Synthetic group"}}
	for _, permission := range []string{domain.PermContacts, domain.PermChats, domain.PermSettings} {
		if storageSelfServiceCanRead(&service.JWTClaims{Permissions: []string{permission}}, refs) {
			t.Fatalf("%s granted Program image access", permission)
		}
	}
	if !storageSelfServiceCanRead(&service.JWTClaims{Permissions: []string{domain.PermPrograms}}, refs) {
		t.Fatal("Program image not visible to authorized reader")
	}
	account := uuid.New()
	key := storage.PrivateObjectKey(account, "program-avatars", uuid.NewString(), "photo.jpg")
	uses := []storageSelfServiceUse{{Type: "programs", Adapter: "protected", AccountID: account, ObjectKey: key}}
	if !storageSelfServiceHasAuthorizedPrivateUse(account, key, uses) {
		t.Fatal("authorized protected reference unavailable")
	}
	if storageSelfServiceHasAuthorizedPrivateUse(uuid.New(), key, uses) {
		t.Fatal("foreign private use accepted")
	}
}
