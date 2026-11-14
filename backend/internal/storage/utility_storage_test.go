package storage

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestUtilityDeletionKeyRejectsTraversalAndOtherModules(t *testing.T) {
	key := PrivateObjectKey(uuid.New(), "utilities", uuid.NewString(), uuid.NewString(), uuid.NewString())
	if !IsUtilityObjectKey(key) {
		t.Fatal("generated utility key rejected")
	}
	for _, bad := range []string{"/" + key, key + "/extra", strings.Replace(key, "/utilities/", "/whiteboards/", 1), key + "/../else", strings.Replace(key, "/", "\\", 1), strings.Replace(key, "/utilities/", "/utilities/../", 1)} {
		if IsUtilityObjectKey(bad) {
			t.Fatal("unsafe storage deletion scope accepted")
		}
	}
}
