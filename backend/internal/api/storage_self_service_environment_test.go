package api

import (
	"fmt"
	"os"
	"strconv"
	"testing"
)

// These ports name disposable services created by the QA runner. Keeping the
// historical defaults supports explicitly configured standalone fixture runs;
// the runner exports a separate range from the reusable local environment.
func storageQAPortValue(raw, fallback string) (string, error) {
	if raw == "" {
		raw = fallback
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1024 || port > 65535 || strconv.Itoa(port) != raw {
		return "", fmt.Errorf("QA port must be a canonical integer from 1024 to 65535")
	}
	return raw, nil
}

func storageQAPort(t *testing.T, variable, fallback string) string {
	t.Helper()
	port, err := storageQAPortValue(os.Getenv(variable), fallback)
	if err != nil {
		t.Fatalf("%s: %v", variable, err)
	}
	return port
}

func storageQAMinioEndpoint(t *testing.T) string {
	t.Helper()
	return "127.0.0.1:" + storageQAPort(t, "CLARIN_STORAGE_QA_MINIO_PORT", "19001")
}

func TestStorageSelfServiceQAPortValidation(t *testing.T) {
	for _, raw := range []string{"0", "80", "65536", "29001/remote", "localhost:29001", "029001", "+29001", " 29001"} {
		t.Run(raw, func(t *testing.T) {
			if _, err := storageQAPortValue(raw, "19001"); err == nil {
				t.Fatalf("unsafe or ambiguous QA port accepted: %q", raw)
			}
		})
	}
	for _, value := range []struct{ raw, want string }{{"", "19001"}, {"29001", "29001"}, {"65535", "65535"}} {
		got, err := storageQAPortValue(value.raw, "19001")
		if err != nil || got != value.want {
			t.Fatalf("port %q: got %q, error %v", value.raw, got, err)
		}
	}
}
