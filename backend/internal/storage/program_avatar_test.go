package storage

import (
	"github.com/google/uuid"
	"testing"
)

func TestProgramAvatarsRemainPrivateAndAccountScoped(t *testing.T) {
	account := uuid.New()
	key := PrivateObjectKey(account, "program-avatars", uuid.NewString(), "photo.jpg")
	if !IsProtectedMediaObjectKey(key) || !IsAccountPrivateProgramAvatarObjectKey(account, key) {
		t.Fatalf("program avatar is not private: %s", key)
	}
	for _, invalid := range []string{uuid.NewString() + key[len(account.String()):], account.String() + "/_private/avatars/photo.jpg", account.String() + "/_private/program-avatars/../photo.jpg", "/" + key, key + "\n"} {
		if IsAccountPrivateProgramAvatarObjectKey(account, invalid) {
			t.Fatalf("invalid program namespace accepted: %q", invalid)
		}
	}
}
