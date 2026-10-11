package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/database"
)

// Uses a new disposable database, never the database named in DATABASE_URL.
func TestChatExperienceIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CHAT_ATTENTION_INTEGRATION") != "1" {
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
	name := "clarin_chat_experience_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	repos := repository.NewRepositories(db)
	account, foreign, device := uuid.New(), uuid.New(), uuid.New()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Experience QA'),($2,'Other QA')`, account, foreign)
	exec(`INSERT INTO devices(id,account_id,name) VALUES($1,$2,'QA')`, device, account)
	chatFor := func(jid string) *domain.Chat {
		t.Helper()
		chat, err := repos.Chat.GetOrCreate(ctx, account, device, jid, "QA")
		if err != nil {
			t.Fatal(err)
		}
		return chat
	}
	base := time.Now().UTC().Truncate(time.Second)
	create := func(chat *domain.Chat, id string, own, read bool, at time.Time) *domain.Message {
		t.Helper()
		msg := &domain.Message{AccountID: account, DeviceID: &device, ChatID: chat.ID, MessageID: id, IsFromMe: own, IsRead: read, Timestamp: at, Status: strPtr("sent"), MessageType: strPtr("text"), Body: strPtr("QA")}
		if own {
			msg.Sender = &domain.MessageSender{Origin: "automation"}
		}
		if err := repos.Message.Create(ctx, msg); err != nil {
			t.Fatal(err)
		}
		return msg
	}

	t.Run("outgoing_display_boundary_and_snapshot_attention", func(t *testing.T) {
		chat := chatFor("51999000101@s.whatsapp.net")
		incoming := create(chat, "old-incoming", false, false, base)
		var last *domain.Message
		for i := 0; i < 52; i++ {
			last = create(chat, fmt.Sprintf("auto-%d", i), true, false, base.Add(time.Duration(i+1)*time.Second))
		}
		page, err := repos.Message.GetByChatID(ctx, chat.ID, 50, 0)
		if err != nil || len(page) != 50 {
			t.Fatalf("page %d %v", len(page), err)
		}
		for _, msg := range page {
			if !msg.IsFromMe {
				t.Fatal("test must have no incoming in visible page")
			}
		}
		snapshot, err := repos.Chat.State(ctx, account, chat.ID)
		if err != nil || snapshot.LastIncomingMessageID == nil || *snapshot.LastIncomingMessageID != incoming.ID || snapshot.LastIncomingAt == nil || !snapshot.LastIncomingAt.Equal(incoming.Timestamp) {
			t.Fatalf("missing full-history attention boundary: %+v %v", snapshot, err)
		}
		if _, _, err = repos.Chat.MarkAsRead(ctx, foreign, chat.ID, last.ID.String()); err == nil {
			t.Fatal("cross-account read accepted")
		}
		otherChat := chatFor("51999000102@s.whatsapp.net")
		otherMessage := create(otherChat, "other-message", true, false, base)
		if _, _, err = repos.Chat.MarkAsRead(ctx, account, chat.ID, otherMessage.ID.String()); err == nil {
			t.Fatal("cross-chat boundary accepted")
		}
		server := &Server{repos: repos, services: service.NewServices(repos, nil, nil)}
		app := fiber.New()
		app.Use(func(c *fiber.Ctx) error { c.Locals("account_id", account); return c.Next() })
		app.Post("/chats/:id/read", server.handleMarkAsRead)
		request := httptest.NewRequest("POST", "/chats/"+chat.ID.String()+"/read", strings.NewReader(fmt.Sprintf(`{"through_message_id":%q}`, last.ID.String())))
		request.Header.Set("Content-Type", "application/json")
		response, err := app.Test(request, 10000)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		var readResponse struct {
			Unread int               `json:"unread_count"`
			State  *domain.ChatState `json:"chat_state"`
		}
		if err = json.Unmarshal(body, &readResponse); err != nil || response.StatusCode != 200 || readResponse.Unread != 0 || readResponse.State == nil || readResponse.State.LastIncomingMessageID == nil || *readResponse.State.LastIncomingMessageID != incoming.ID {
			t.Fatalf("outgoing boundary HTTP snapshot: %d %s %v", response.StatusCode, body, err)
		}
		count := readResponse.Unread
		state, _ := repos.Chat.State(ctx, account, chat.ID)
		if !state.NeedsReply {
			t.Fatal("reading must not attend")
		}
		var originalXmin string
		if err = db.QueryRow(ctx, `SELECT xmin::text FROM messages WHERE id=$1`, incoming.ID).Scan(&originalXmin); err != nil {
			t.Fatal(err)
		}
		later := create(chat, "new-during-read", false, false, base.Add(time.Minute))
		if count, _, err = repos.Chat.MarkAsRead(ctx, account, chat.ID, last.ID.String()); err != nil || count != 1 {
			t.Fatalf("new incoming swallowed: %d %v", count, err)
		}
		var repeatedXmin string
		if err = db.QueryRow(ctx, `SELECT xmin::text FROM messages WHERE id=$1`, incoming.ID).Scan(&repeatedXmin); err != nil {
			t.Fatal(err)
		}
		if repeatedXmin != originalXmin {
			t.Fatal("already-read history was rewritten")
		}
		if err = repos.Chat.AcknowledgeAttention(ctx, account, chat.ID, snapshot.LastIncomingMessageID.String()); err != nil {
			t.Fatal(err)
		}
		state, _ = repos.Chat.State(ctx, account, chat.ID)
		if state.UnreadCount != 1 || !state.NeedsReply || !state.WaitingSince.Equal(later.Timestamp) {
			t.Fatalf("stale attention swallowed new inbound: %+v", state)
		}
		stored, _ := repos.Message.GetByMessageID(ctx, chat.ID, last.MessageID)
		if stored.IsRead {
			t.Fatal("read action modified outgoing message")
		}
	})

	t.Run("merge_preserves_reads_and_remaps_attention_frontier", func(t *testing.T) {
		canonical := chatFor("51999000103@s.whatsapp.net")
		source := chatFor("9999000103@lid")
		canonicalDuplicate := create(canonical, "duplicate", false, false, base)
		sourceDuplicate := create(source, "duplicate", false, false, base)
		later := create(canonical, "still-pending", false, false, base.Add(time.Second))
		// A reaction unique to the LID projection must not collide with its own
		// primary key while being copied to the canonical chat. Overlapping
		// semantic reactions keep the newest provider value.
		exec(`INSERT INTO message_reactions(account_id,chat_id,target_message_id,sender_jid,emoji,timestamp)
		 VALUES($1,$2,'duplicate',$3,'unique',$4),($1,$2,'still-pending','51999000999@s.whatsapp.net','new',$4),
		 ($1,$5,'still-pending','51999000999@s.whatsapp.net','old',$6)`, account, source.ID, source.JID, base.Add(time.Second), canonical.ID, base)
		if err := repos.Chat.AcknowledgeAttention(ctx, account, source.ID, sourceDuplicate.ID.String()); err != nil {
			t.Fatal(err)
		}
		canonicalBefore, _ := repos.Chat.State(ctx, account, canonical.ID)
		sourceBefore, _ := repos.Chat.State(ctx, account, source.ID)
		if _, err := repos.Chat.ReconcileLIDChat(ctx, foreign, device, canonical.ID, source.JID, canonical.JID); err == nil {
			t.Fatal("cross-account merge accepted")
		}
		if _, err := repos.Chat.ReconcileLIDChat(ctx, account, device, canonical.ID, source.JID, canonical.JID); err != nil {
			t.Fatal(err)
		}
		state, err := repos.Chat.State(ctx, account, canonical.ID)
		if err != nil || state.UnreadCount != 1 || !state.NeedsReply || !state.WaitingSince.Equal(later.Timestamp) || state.Version <= canonicalBefore.Version || state.Version <= sourceBefore.Version {
			t.Fatalf("bad merged state: %+v %v", state, err)
		}
		var frontier uuid.UUID
		if err = db.QueryRow(ctx, `SELECT attention_through_id FROM chats WHERE account_id=$1 AND id=$2`, account, canonical.ID).Scan(&frontier); err != nil {
			t.Fatal(err)
		}
		if frontier != canonicalDuplicate.ID {
			t.Fatalf("dangling/incorrect merged frontier %s", frontier)
		}
		stored, _ := repos.Message.GetByMessageID(ctx, canonical.ID, "duplicate")
		if !stored.IsRead {
			t.Fatal("source read was discarded")
		}
		var duplicates int
		if err = db.QueryRow(ctx, `SELECT count(*) FROM messages WHERE account_id=$1 AND chat_id=$2 AND message_id='duplicate'`, account, canonical.ID).Scan(&duplicates); err != nil || duplicates != 1 {
			t.Fatalf("duplicates %d %v", duplicates, err)
		}
		var reactions int
		if err = db.QueryRow(ctx, `SELECT count(*) FROM message_reactions WHERE account_id=$1 AND chat_id=$2`, account, canonical.ID).Scan(&reactions); err != nil || reactions != 2 {
			t.Fatalf("merged reactions %d %v", reactions, err)
		}
		var emoji, sender string
		if err = db.QueryRow(ctx, `SELECT emoji,sender_jid FROM message_reactions WHERE account_id=$1 AND chat_id=$2 AND target_message_id='duplicate'`, account, canonical.ID).Scan(&emoji, &sender); err != nil || emoji != "unique" || sender != canonical.JID {
			t.Fatalf("unique reaction identity was not preserved: %s %s %v", emoji, sender, err)
		}
		if err = db.QueryRow(ctx, `SELECT emoji FROM message_reactions WHERE account_id=$1 AND chat_id=$2 AND target_message_id='still-pending'`, account, canonical.ID).Scan(&emoji); err != nil || emoji != "new" {
			t.Fatalf("older reaction won: %s %v", emoji, err)
		}
		if _, err = repos.Chat.State(ctx, account, source.ID); err == nil {
			t.Fatal("source chat retained")
		}
		if _, err = repos.Chat.ReconcileLIDChat(ctx, account, device, canonical.ID, source.JID, canonical.JID); err != nil {
			t.Fatal("merge retry must be harmless")
		}
	})

	t.Run("legacy_media_inventory_projection_keeps_history_untouched", func(t *testing.T) {
		chat := chatFor("51999000104@s.whatsapp.net")
		message := create(chat, "legacy-media", false, true, base)
		key := account.String() + "/uploads/legacy video.mp4"
		raw := "/api/media/file/" + account.String() + "/uploads/legacy%20video.mp4"
		exec(`UPDATE messages SET media_url=$1,message_type='video',media_filename='legacy.mp4' WHERE id=$2`, raw, message.ID)
		exec(`INSERT INTO storage_objects(account_id,object_key,status) VALUES($1,$2,'deleted')`, account, key)
		stored, err := repos.Message.GetByMessageID(ctx, chat.ID, message.MessageID)
		if err != nil {
			t.Fatal(err)
		}
		s := &Server{repos: repos}
		cached, _ := json.Marshal(map[string]any{"success": true, "messages": []*domain.Message{stored}, "next_offset": 50})
		projected, err := s.projectCachedChatMedia(ctx, account, cached)
		if err != nil {
			t.Fatal(err)
		}
		var response struct {
			Messages []*domain.Message `json:"messages"`
			Next     int               `json:"next_offset"`
		}
		if err = json.Unmarshal(projected, &response); err != nil || len(response.Messages) != 1 || !response.Messages[0].MediaDeleted || response.Messages[0].MediaURL != nil || response.Next != 50 {
			t.Fatalf("projection failed: %s %v", projected, err)
		}
		stored, err = repos.Message.GetByMessageID(ctx, chat.ID, message.MessageID)
		if err != nil || stored.MediaDeleted || stored.MediaURL == nil || *stored.MediaURL != raw {
			t.Fatal("historical row was mutated")
		}
		deleted, err := repos.Message.DeletedMediaKeys(ctx, foreign, []string{key})
		if err != nil || len(deleted) != 0 {
			t.Fatal("inventory crossed account")
		}
	})
}
