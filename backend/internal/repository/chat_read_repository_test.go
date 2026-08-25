package repository

import (
	"strings"
	"testing"
)

func TestMarkAsReadUsesAccountScopedDisplayedWatermark(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "repository.go")
	start := strings.Index(source, "func (r *ChatRepository) MarkAsRead")
	if start < 0 {
		t.Fatal("MarkAsRead implementation not found")
	}
	end := strings.Index(source[start:], "func (r *ChatRepository) Delete")
	if end < 0 {
		t.Fatal("MarkAsRead implementation boundary not found")
	}
	method := source[start : start+end]
	for _, invariant := range []string{
		"SELECT id FROM chats WHERE account_id=$1 AND id=$2 FOR UPDATE",
		"AND (id::text=$3 OR message_id=$3)",
		"WHERE account_id=$1 AND chat_id=$2 AND is_from_me=FALSE",
		"timestamp < $3 OR (timestamp = $3 AND id <= $4)",
		"COALESCE(is_revoked, FALSE)=FALSE",
		"UPDATE chats SET unread_count=$3",
	} {
		if !strings.Contains(method, invariant) {
			t.Fatalf("read watermark lost invariant %q", invariant)
		}
	}
}

func TestLastMessageMaintainsInboundAndOutboundActivity(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "repository.go")
	for _, invariant := range []string{
		"WHERE account_id = $3 AND id = $4",
		"last_inbound_at = GREATEST",
		"last_outbound_at = GREATEST",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("chat activity timestamp lost invariant %q", invariant)
		}
	}
}
