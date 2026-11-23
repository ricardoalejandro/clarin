package repository

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
)

func TestChatGroupPlaceholderIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CHAT_GROUP_INTEGRATION") != "1" {
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
	name := "clarin_placeholder_qa_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	a, b, device, otherDevice := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Placeholder QA'),($2,'Other QA')`, a, b)
	exec(`INSERT INTO devices(id,account_id,name,status) VALUES($1,$3,'First','connected'),($2,$3,'Second','connected')`, device, otherDevice, a)
	repos := NewRepositories(db)
	newGroup := func() *domain.Chat {
		t.Helper()
		c, err := repos.Chat.GetOrCreateGroup(ctx, a, device, uuid.NewString()+"@g.us", "Synthetic group")
		if err != nil {
			t.Fatal(err)
		}
		if err = repos.Chat.SaveGroup(ctx, a, c.ID, &domain.ChatGroup{Subject: "Synthetic group", MembershipStatus: "member", Kind: "group"}, []domain.GroupParticipant{{JID: "51999000111@s.whatsapp.net", LID: "7001@lid", Name: "Synthetic author", Role: "member"}}); err != nil {
			t.Fatal(err)
		}
		return c
	}
	baseTime := time.Date(2026, 10, 18, 8, 0, 0, 0, time.UTC)
	newPlaceholder := func(chat *domain.Chat) *domain.Message {
		t.Helper()
		m := &domain.Message{AccountID: a, DeviceID: &device, ChatID: chat.ID, MessageID: uuid.NewString(), FromJID: placeholderTestPointer("51999000111@s.whatsapp.net"), Body: placeholderTestPointer(""), MessageType: placeholderTestPointer("text"), Status: placeholderTestPointer("received"), Provider: placeholderTestPointer("whatsapp_web"), Timestamp: baseTime}
		if err := repos.Message.Create(ctx, m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	candidate := func(old *domain.Message) *domain.Message {
		m := *old
		m.ID = uuid.Nil
		m.Body = placeholderTestPointer("Actual provider payload")
		m.Timestamp = old.Timestamp.Add(time.Hour)
		return &m
	}
	repair := func(m *domain.Message) (bool, error) {
		tx, err := db.Begin(ctx)
		if err != nil {
			return false, err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `SELECT id FROM chats WHERE account_id=$1 AND id=$2 FOR UPDATE`, m.AccountID, m.ChatID); err != nil {
			return false, err
		}
		ok, err := repairGroupPlaceholderTx(ctx, tx, m)
		if err != nil {
			return false, err
		}
		return ok, tx.Commit(ctx)
	}
	snapshot := func(q string, args ...any) any {
		t.Helper()
		var raw []byte
		if err := db.QueryRow(ctx, q, args...).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	messageLifecycleSQL := `SELECT to_jsonb(m)-ARRAY['body','message_type','media_url','media_mimetype','media_filename','media_size','media_asset_id','quoted_message_id','quoted_body','quoted_sender','quoted_is_from_me','latitude','longitude','contact_name','contact_phone','contact_vcard','poll_question','poll_max_selections','group_mentions','media_unavailable_reason']::text[] FROM messages m WHERE id=$1`
	chatLifecycleSQL := `SELECT to_jsonb(c)-ARRAY['last_message','state_version','updated_at']::text[] FROM chats c WHERE id=$1`
	t.Run("same provider replay repairs content and preserves lifecycle", func(t *testing.T) {
		chat := newGroup()
		old := newPlaceholder(chat)
		boundary, operation := uuid.New(), uuid.New()
		exec(`UPDATE messages SET is_read=TRUE,status='read',read_at=$2,delivered_at=$2,sender='{"origin":"history"}',attention_through_at=$2,attention_through_id=$3,defer_attention=TRUE,send_operation_id=$4 WHERE id=$1`, old.ID, baseTime, boundary, operation)
		beforeMessage := snapshot(messageLifecycleSQL, old.ID)
		beforeChat := snapshot(chatLifecycleSQL, chat.ID)
		m := candidate(old)
		m.FromJID = placeholderTestPointer("7001@lid") // Alias must be proven by this group's metadata.
		m.Mentions = []domain.MessageMention{{JID: "7001@lid"}}
		m.QuotedMessageID = placeholderTestPointer("quoted-provider-id")
		m.QuotedBody = placeholderTestPointer("Original quote")
		m.QuotedSender = placeholderTestPointer("51999000112@s.whatsapp.net")
		m.QuotedIsFromMe = placeholderTestPointer(false)
		m.IsRead = false
		m.Sender = &domain.MessageSender{UserID: placeholderTestPointer(uuid.New()), Origin: "manual"}
		if err := repos.Message.Create(ctx, m); err != nil {
			t.Fatal(err)
		}
		if !m.RepairedPlaceholder || m.ID != old.ID || !m.Timestamp.Equal(old.Timestamp) || !m.CreatedAt.Equal(old.CreatedAt) || !m.IsRead || m.Status == nil || *m.Status != "read" || m.FromJID == nil || *m.FromJID != *old.FromJID || m.Sender == nil || m.Sender.Origin != "history" || m.Sender.UserID != nil || !m.DeferAttention || m.AttentionThroughID == nil || *m.AttentionThroughID != boundary || m.SendOperationID == nil || *m.SendOperationID != operation || len(m.Mentions) != 1 || m.QuotedMessageID == nil {
			t.Fatal("repaired projection lost canonical lifecycle/content")
		}
		if !reflect.DeepEqual(beforeMessage, snapshot(messageLifecycleSQL, old.ID)) {
			t.Fatal("repair changed message lifecycle")
		}
		if !reflect.DeepEqual(beforeChat, snapshot(chatLifecycleSQL, chat.ID)) {
			t.Fatal("repair changed chat counters, timestamps or attention")
		}
		var preview string
		if err := db.QueryRow(ctx, `SELECT last_message FROM chats WHERE id=$1`, chat.ID).Scan(&preview); err != nil || preview != *m.Body {
			t.Fatal("latest repaired preview missing", err)
		}
		replay := candidate(old)
		if err := repos.Message.Create(ctx, replay); !errors.Is(err, pgx.ErrNoRows) || replay.RepairedPlaceholder {
			t.Fatal("second replay was not idempotent", err)
		}
	})
	t.Run("older repair retains newer preview and produces recovery anchor only while gap exists", func(t *testing.T) {
		chat := newGroup()
		old := newPlaceholder(chat)
		newer := candidate(old)
		newer.MessageID = uuid.NewString()
		newer.Body = placeholderTestPointer("Newer visible payload")
		if err := repos.Message.Create(ctx, newer); err != nil {
			t.Fatal(err)
		}
		anchor, err := repos.Message.GetGroupHistoryRecoveryAnchor(ctx, a, device, chat.ID)
		if err != nil || anchor == nil || anchor.ID != newer.ID {
			t.Fatal("expected newer recovery anchor", err)
		}
		for _, scope := range [][3]uuid.UUID{{b, device, chat.ID}, {a, otherDevice, chat.ID}, {a, device, uuid.New()}} {
			anchor, err = repos.Message.GetGroupHistoryRecoveryAnchor(ctx, scope[0], scope[1], scope[2])
			if err != nil || anchor != nil {
				t.Fatal("anchor crossed account/device/chat scope", err)
			}
		}
		before := snapshot(`SELECT to_jsonb(c) FROM chats c WHERE id=$1`, chat.ID)
		if ok, err := repair(candidate(old)); err != nil || !ok {
			t.Fatal("older repair failed", err)
		}
		if !reflect.DeepEqual(before, snapshot(`SELECT to_jsonb(c) FROM chats c WHERE id=$1`, chat.ID)) {
			t.Fatal("older repair changed current chat preview or counters")
		}
		anchor, err = repos.Message.GetGroupHistoryRecoveryAnchor(ctx, a, device, chat.ID)
		if err != nil || anchor != nil {
			t.Fatal("completed gap still requested recovery", err)
		}
	})
	t.Run("attachment completion retains metadata and terminal reason", func(t *testing.T) {
		chat := newGroup()
		old := newPlaceholder(chat)
		m := candidate(old)
		m.Body = placeholderTestPointer("")
		m.MessageType = placeholderTestPointer("document")
		m.MediaFilename = placeholderTestPointer("synthetic.pdf")
		m.MediaMimetype = placeholderTestPointer("application/pdf")
		m.MediaSize = placeholderTestPointer(int64(64<<20) + 1)
		m.MediaUnavailableReason = "group_media_too_large"
		if err := repos.Message.Create(ctx, m); err != nil {
			t.Fatal(err)
		}
		if !m.RepairedPlaceholder || m.ID != old.ID || m.MessageType == nil || *m.MessageType != "document" || m.MediaFilename == nil || *m.MediaFilename != "synthetic.pdf" || m.MediaSize == nil || *m.MediaSize != (64<<20)+1 || m.MediaUnavailableReason != "group_media_too_large" {
			t.Fatal("attachment metadata/reason was not completed")
		}
		if ok, err := repair(candidate(old)); err != nil || ok {
			t.Fatal("completed attachment was overwritten", err)
		}
	})
	t.Run("ineligible existing rows and mismatched identities are immutable", func(t *testing.T) {
		tests := []struct {
			name, sql string
			change    func(*domain.Message)
		}{
			{name: "visible content", sql: `UPDATE messages SET body='Already visible' WHERE id=$1`},
			{name: "edited", sql: `UPDATE messages SET is_edited=TRUE WHERE id=$1`},
			{name: "revoked", sql: `UPDATE messages SET is_revoked=TRUE WHERE id=$1`},
			{name: "view once", sql: `UPDATE messages SET is_view_once=TRUE WHERE id=$1`},
			{name: "media type", sql: `UPDATE messages SET message_type='image' WHERE id=$1`},
			{name: "media URL", sql: `UPDATE messages SET media_url='synthetic-object' WHERE id=$1`},
			{name: "media deleted", sql: `UPDATE messages SET media_deleted=TRUE WHERE id=$1`},
			{name: "quote", sql: `UPDATE messages SET quoted_message_id='quote' WHERE id=$1`},
			{name: "mention", sql: `UPDATE messages SET group_mentions='[{"jid":"7001@lid"}]' WHERE id=$1`},
			{name: "provider", sql: `UPDATE messages SET provider='whatsapp_cloud' WHERE id=$1`},
			{name: "other author", change: func(m *domain.Message) { m.FromJID = placeholderTestPointer("51999000112@s.whatsapp.net") }},
			{name: "unproven alias", change: func(m *domain.Message) { m.FromJID = placeholderTestPointer("7002@lid") }},
			{name: "other account", change: func(m *domain.Message) { m.AccountID = b }},
			{name: "other device", change: func(m *domain.Message) { m.DeviceID = &otherDevice }},
			{name: "other chat", change: func(m *domain.Message) { m.ChatID = uuid.New() }},
			{name: "other provider ID", change: func(m *domain.Message) { m.MessageID = "different" }},
			{name: "other direction", change: func(m *domain.Message) { m.IsFromMe = true }},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				chat := newGroup()
				old := newPlaceholder(chat)
				if tt.sql != "" {
					exec(tt.sql, old.ID)
				}
				before := snapshot(`SELECT to_jsonb(m) FROM messages m WHERE id=$1`, old.ID)
				m := candidate(old)
				if tt.change != nil {
					tt.change(m)
				}
				if ok, err := repair(m); err != nil || ok {
					t.Fatal("ineligible row repaired", err)
				}
				if !reflect.DeepEqual(before, snapshot(`SELECT to_jsonb(m) FROM messages m WHERE id=$1`, old.ID)) {
					t.Fatal("ineligible row mutated")
				}
			})
		}
	})
	for _, state := range []string{"edit", "revoke"} {
		t.Run("stored "+state+" prevents repair and anchor", func(t *testing.T) {
			chat := newGroup()
			old := newPlaceholder(chat)
			newer := candidate(old)
			newer.MessageID = uuid.NewString()
			if err := repos.Message.Create(ctx, newer); err != nil {
				t.Fatal(err)
			}
			if state == "edit" {
				exec(`INSERT INTO chat_group_message_state(account_id,chat_id,message_id,edited_body,edited_at) VALUES($1,$2,$3,'Edited',NOW())`, a, chat.ID, old.MessageID)
			} else {
				exec(`INSERT INTO chat_group_message_state(account_id,chat_id,message_id,revoked) VALUES($1,$2,$3,TRUE)`, a, chat.ID, old.MessageID)
			}
			if ok, err := repair(candidate(old)); err != nil || ok {
				t.Fatal("stored edit/revoke bypassed", err)
			}
			if anchor, err := repos.Message.GetGroupHistoryRecoveryAnchor(ctx, a, device, chat.ID); err != nil || anchor != nil {
				t.Fatal("edited/revoked gap requested recovery", err)
			}
		})
	}
	t.Run("direct chats excluded", func(t *testing.T) {
		chat, err := repos.Chat.GetOrCreate(ctx, a, device, "51999000555@s.whatsapp.net", "Direct QA")
		if err != nil {
			t.Fatal(err)
		}
		old := newPlaceholder(chat)
		newer := candidate(old)
		newer.MessageID = uuid.NewString()
		if err := repos.Message.Create(ctx, newer); err != nil {
			t.Fatal(err)
		}
		if ok, err := repair(candidate(old)); err != nil || ok {
			t.Fatal("direct message repaired by group path", err)
		}
		if anchor, err := repos.Message.GetGroupHistoryRecoveryAnchor(ctx, a, device, chat.ID); err != nil || anchor != nil {
			t.Fatal("direct chat got group recovery anchor", err)
		}
	})
	t.Run("concurrent replays repair once", func(t *testing.T) {
		chat := newGroup()
		old := newPlaceholder(chat)
		var wg sync.WaitGroup
		type result struct {
			repaired bool
			err      error
		}
		results := make(chan result, 2)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				m := candidate(old)
				err := repos.Message.Create(ctx, m)
				results <- result{m.RepairedPlaceholder, err}
			}()
		}
		wg.Wait()
		close(results)
		repairs := 0
		for result := range results {
			if result.err == nil && result.repaired {
				repairs++
			} else if !errors.Is(result.err, pgx.ErrNoRows) {
				t.Fatal("unexpected replay result", result.err)
			}
		}
		if repairs != 1 {
			t.Fatalf("repairs=%d, want one", repairs)
		}
		var count, unread int
		if err := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM messages WHERE chat_id=$1),unread_count FROM chats WHERE id=$1`, chat.ID).Scan(&count, &unread); err != nil || count != 1 || unread != 1 {
			t.Fatal("concurrent repair duplicated message or unread", err)
		}
	})
}
