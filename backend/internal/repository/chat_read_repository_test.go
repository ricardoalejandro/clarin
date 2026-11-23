package repository

import (
	"strings"
	"testing"
)

func TestMarkAsReadUsesAccountScopedDisplayedWatermark(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "conversation_action_repository.go")
	for _, invariant := range []string{
		"WHERE account_id=$1 AND (id=$2 OR canonical_chat_id=$2) ORDER BY id FOR UPDATE",
		"AND (source.id::text=$3 OR source.message_id=$3)",
		"m.account_id=$1 AND m.chat_id=ANY($2::uuid[]) AND m.is_from_me=FALSE AND m.is_read=FALSE",
		"AND source.is_from_me=FALSE ORDER BY visible.timestamp DESC,visible.id DESC LIMIT 1",
		"(m.timestamp,m.id)<=($3::timestamptz,$4::uuid)",
		"COALESCE(m.is_revoked,FALSE)=FALSE",
		"UPDATE chats c SET unread_count=",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("read watermark lost invariant %q", invariant)
		}
	}

}

func TestLegacyLastMessageDoesNotIncrementUnread(t *testing.T) {
	source := readRepositorySource(t, "repository.go")
	start := strings.Index(source, "func (r *ChatRepository) UpdateLastMessage")
	end := strings.Index(source[start:], "func (r *ChatRepository) MarkAsRead")
	if strings.Contains(source[start:start+end], "SET unread_count") {
		t.Fatal("projection must be updated exactly once by insertion")
	}
}
