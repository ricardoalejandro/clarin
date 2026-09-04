package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestUserJSONNeverExposesCredentialSecrets(t *testing.T) {
	t.Parallel()
	user := User{
		Username:     "safe-user",
		PasswordHash: "password-hash-must-stay-private",
		GroqAPIKey:   "provider-key-must-stay-private",
	}

	encoded, err := json.Marshal(user)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(encoded)
	if strings.Contains(serialized, user.PasswordHash) || strings.Contains(serialized, user.GroqAPIKey) {
		t.Fatal("serialized user exposed a credential secret")
	}

	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"password_hash", "PasswordHash", "groq_api_key", "GroqAPIKey"} {
		if _, exists := fields[forbidden]; exists {
			t.Fatalf("serialized user contains forbidden field %q", forbidden)
		}
	}
}
