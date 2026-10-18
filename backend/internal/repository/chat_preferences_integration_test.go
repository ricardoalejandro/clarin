package repository

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
)

func TestChatPreferencesIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CHAT_PREFERENCES_INTEGRATION") != "1" {
		t.Skip("requires isolated PostgreSQL")
	}
	parsed, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || parsed.Host == "" {
		t.Fatal("DATABASE_URL required")
	}
	ctx := context.Background()
	adminURL := *parsed
	adminURL.Path = "/postgres"
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	name := "clarin_pins_qa_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") }()
	parsed.Path = "/" + name
	db, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for i := 0; i < 2; i++ {
		if err = database.Migrate(db); err != nil {
			t.Fatal(err)
		}
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	a, b, u, v, d := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Pins QA'),($2,'Other QA')`, a, b)
	exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$3,'pins-a','pins-a@test.invalid','not-a-login'),($2,$3,'pins-b','pins-b@test.invalid','not-a-login')`, u, v, a)
	exec(`INSERT INTO devices(id,account_id,name) VALUES($1,$2,'Pins QA')`, d, a)
	repos := NewRepositories(db)
	var chats []*domain.Chat
	for _, jid := range []string{"51999000111@s.whatsapp.net", "51999000112@s.whatsapp.net", "51999000113@s.whatsapp.net"} {
		chat, err := repos.Chat.GetOrCreate(ctx, a, d, jid, "Pins QA")
		if err != nil {
			t.Fatal(err)
		}
		chats = append(chats, chat)
	}
	base := time.Now().UTC().Truncate(time.Second)
	for i, c := range chats {
		exec(`UPDATE chats SET last_message_at=$1 WHERE account_id=$2 AND id=$3`, base.Add(time.Duration(i)*time.Minute), a, c.ID)
	}
	first, err := repos.Chat.SetUserPin(ctx, a, u, chats[0].ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if first.PinVersion != 1 || first.PinnedAt == nil {
		t.Fatal("missing canonical pin")
	}
	again, err := repos.Chat.SetUserPin(ctx, a, u, chats[0].ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if again.PinVersion != first.PinVersion || !again.PinnedAt.Equal(*first.PinnedAt) {
		t.Fatal("retry changed pin order/version")
	}
	list := func(actor uuid.UUID, cursor *domain.ChatListCursor) ([]*domain.Chat, int) {
		t.Helper()
		rows, total, err := repos.Chat.GetByAccountIDWithFilters(ctx, a, domain.ChatFilter{ActorID: actor, Limit: 2, UseCursor: true, ListCursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		return rows, total
	}
	page, total := list(u, nil)
	if total != 3 || len(page) != 2 || page[0].ID != chats[0].ID || page[1].ID != chats[2].ID {
		t.Fatal("actor's pin not before normal activity")
	}
	last := page[1]
	page2, total := list(u, &domain.ChatListCursor{ID: last.ID, SortAt: last.LastMessageAt})
	if total != 3 || len(page2) != 1 || page2[0].ID != chats[1].ID {
		t.Fatal("cursor omitted or duplicated chat")
	}
	other, _ := list(v, nil)
	if other[0].ID != chats[2].ID || other[0].IsPinned {
		t.Fatal("private pin leaked to another user")
	}
	if _, err := repos.Chat.SetUserPin(ctx, b, u, chats[0].ID, true); err != pgx.ErrNoRows {
		t.Fatal("cross-account pin accepted")
	}
	// Incoming activity and shared state must survive unpin and retries.
	exec(`UPDATE chats SET unread_count=7,last_message='concurrent',state_version=state_version+1 WHERE account_id=$1 AND id=$2`, a, chats[0].ID)
	unpin, err := repos.Chat.SetUserPin(ctx, a, u, chats[0].ID, false)
	if err != nil || unpin.PinVersion != 2 || unpin.PinnedAt != nil {
		t.Fatal("unpin/version failed", err)
	}
	chat, err := repos.Chat.GetByID(ctx, chats[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = repos.Chat.ApplyUserPins(ctx, a, u, []*domain.Chat{chat}); err != nil {
		t.Fatal(err)
	}
	if chat.IsPinned || chat.PinVersion != 2 || chat.UnreadCount != 7 || chat.LastMessage == nil || *chat.LastMessage != "concurrent" {
		t.Fatal("pin mutation changed shared message/read state")
	}
	// Multiple pins stay stable when activity changes, including equal pin
	// timestamps and the transition from the pinned to the normal partition.
	for _, item := range chats[:2] {
		if _, err = repos.Chat.SetUserPin(ctx, a, u, item.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	exec(`UPDATE chat_user_preferences SET pinned_at=$1 WHERE account_id=$2 AND user_id=$3 AND is_pinned`, base, a, u)
	exec(`UPDATE chats SET last_message_at=NULL WHERE account_id=$1 AND id=$2`, a, chats[2].ID)
	firstPage, _ := list(u, nil)
	if len(firstPage) != 2 || !firstPage[0].IsPinned || !firstPage[1].IsPinned || firstPage[0].ID.String() > firstPage[1].ID.String() {
		t.Fatal("pin tie ordering is unstable")
	}
	last = firstPage[1]
	normalPage, _ := list(u, &domain.ChatListCursor{ID: last.ID, Pinned: true, SortAt: last.PinnedAt})
	if len(normalPage) != 1 || normalPage[0].ID != chats[2].ID || normalPage[0].LastMessageAt != nil {
		t.Fatal("pinned cursor skipped null-activity normal chat")
	}
	emptyPage, _ := list(u, &domain.ChatListCursor{ID: chats[2].ID})
	if len(emptyPage) != 0 {
		t.Fatal("null-activity cursor repeated a chat")
	}
	// A PN/LID resolution must preserve preferences for each actor before the
	// source chat cascades away. The other user's canonical pin stays private.
	lid := "9000000000123@lid"
	source, err := repos.Chat.GetOrCreate(ctx, a, d, lid, "")
	if err != nil {
		t.Fatal(err)
	}
	sourcePin, err := repos.Chat.SetUserPin(ctx, a, u, source.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = repos.Chat.SetUserPin(ctx, a, v, chats[2].ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = repos.Chat.ReconcileLIDChat(ctx, a, d, chats[2].ID, lid, chats[2].JID); err != nil {
		t.Fatal(err)
	}
	canonical, err := repos.Chat.GetByID(ctx, chats[2].ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = repos.Chat.ApplyUserPins(ctx, a, u, []*domain.Chat{canonical}); err != nil {
		t.Fatal(err)
	}
	if !canonical.IsPinned || canonical.PinnedAt == nil || !canonical.PinnedAt.Equal(*sourcePin.PinnedAt) || canonical.PinVersion <= sourcePin.PinVersion {
		t.Fatal("identity merge lost source preference")
	}
	if err = repos.Chat.ApplyUserPins(ctx, a, v, []*domain.Chat{canonical}); err != nil || !canonical.IsPinned {
		t.Fatal("identity merge lost another actor's canonical preference")
	}
	exec(`DELETE FROM chats WHERE account_id=$1 AND id=$2`, a, chats[0].ID)
	var remaining int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM chat_user_preferences WHERE account_id=$1 AND chat_id=$2`, a, chats[0].ID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatal("deleted chat retained preferences")
	}
}
