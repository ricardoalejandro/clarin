package repository

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestChatCursorPartitionsNullAndPinnedActivity(t *testing.T) {
	if sql, args := chatListCursorSQL(nil, 4); sql != "" || len(args) != 0 {
		t.Fatal("first page must have no anchor")
	}
	id := uuid.New()
	at := time.Now()
	for _, pinned := range []bool{false, true} {
		for _, date := range []*time.Time{nil, &at} {
			sql, args := chatListCursorSQL(&domain.ChatListCursor{ID: id, Pinned: pinned, SortAt: date}, 4)
			if !strings.Contains(sql, "cp.pinned_at ELSE c.last_message_at") || !strings.Contains(sql, "IS NULL") || !strings.Contains(sql, "$4::boolean") {
				t.Fatal("cursor lost its sort partition")
			}
			want := 2
			if date != nil {
				want = 3
			}
			if len(args) != want || args[0] != pinned || args[len(args)-1] != id {
				t.Fatalf("cursor args: %v", args)
			}
		}
	}
}
