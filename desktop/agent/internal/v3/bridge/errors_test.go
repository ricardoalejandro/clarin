package bridge

import (
	"net/http"
	"testing"

	"github.com/naperu/clarin-offline-agent/internal/v3/engine"
	"github.com/naperu/clarin-offline-agent/internal/v3/vault"
)

func TestStableStorageAndOperationErrors(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{vault.ErrOperationIDReuse, http.StatusConflict, "operation_id_reuse"},
		{vault.ErrQuotaExceeded, http.StatusInsufficientStorage, "quota_exceeded"},
		{vault.ErrOutboxFull, http.StatusInsufficientStorage, "quota_exceeded"},
		{engine.ErrOperationEnvelopeTooLarge, http.StatusRequestEntityTooLarge, "operation_too_large"},
		{engine.ErrPendingOperations, http.StatusConflict, "pending_operations"},
		{engine.ErrCredentialBusy, http.StatusTooManyRequests, "credential_busy"},
	}
	for _, test := range tests {
		status, code := errorStatus(test.err)
		if status != test.status || code != test.code {
			t.Fatalf("error %v mapped to %d/%q, want %d/%q", test.err, status, code, test.status, test.code)
		}
	}
}
