package repository

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestChatGroupIntegration(t *testing.T) {
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
	name := "clarin_groups_qa_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	a, b, d, e := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Group QA'),($2,'Other QA')`, a, b)
	exec(`INSERT INTO devices(id,account_id,name,status) VALUES($1,$3,'First','connected'),($2,$3,'Second','connected')`, d, e, a)
	repos := NewRepositories(db)
	jid := "120001@g.us"
	first, err := repos.Chat.GetOrCreateGroup(ctx, a, d, jid, "Equipo")
	if err != nil {
		t.Fatal(err)
	}
	second, err := repos.Chat.GetOrCreateGroup(ctx, a, e, jid, "Equipo")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID || first.ContactID == nil || second.ContactID == nil || *first.ContactID != *second.ContactID || first.Kind != "group" || first.ContactPhone != nil {
		t.Fatal("group/device/parent identity mismatch")
	}
	if _, err = repos.Chat.GetOrCreateGroup(ctx, b, d, jid, "wrong account"); err == nil {
		t.Fatal("cross-account group accepted")
	}
	// A group rename must never even execute a commercial UPDATE statement.
	exec(`CREATE FUNCTION reject_group_crm() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'group reached Leads'; END $$`)
	exec(`CREATE TRIGGER reject_group_crm BEFORE UPDATE ON leads FOR EACH STATEMENT EXECUTE FUNCTION reject_group_crm()`)
	if _, err = repos.Chat.GetOrCreateGroup(ctx, a, d, jid, "Equipo cambiado"); err != nil {
		t.Fatal(err)
	}
	exec(`DROP TRIGGER reject_group_crm ON leads`)
	group := &domain.ChatGroup{Subject: "Equipo", MembershipStatus: "member", Kind: "group"}
	members := []domain.GroupParticipant{{JID: "51999000111@s.whatsapp.net", Name: "Ana", Role: "member", LID: "7001@lid"}, {JID: "51999000112@s.whatsapp.net", Name: "Luis", Role: "admin"}}
	if err = repos.Chat.SaveGroup(ctx, a, first.ID, group, members); err != nil {
		t.Fatal(err)
	}
	if err = repos.Chat.HydrateGroups(ctx, a, []*domain.Chat{first}); err != nil || first.Group == nil || !first.Group.CanSend {
		t.Fatal("metadata hydrate failed", err)
	}
	now := time.Now().UTC()
	body := "hola @51999000111"
	author := members[0].JID
	quoted := members[1].JID
	status := "received"
	kind := "text"
	incoming := &domain.Message{AccountID: a, DeviceID: &d, ChatID: first.ID, MessageID: "incoming", FromJID: &author, Body: &body, Timestamp: now, Status: &status, MessageType: &kind, Mentions: []domain.MessageMention{{JID: author}}, QuotedSender: &quoted}
	if err = repos.Message.Create(ctx, incoming); err != nil {
		t.Fatal(err)
	}
	if err = repos.Message.HydrateMentions(ctx, a, first.ID, []*domain.Message{incoming}); err != nil || incoming.Mentions[0].Name != "Ana" || incoming.QuotedSenderName == nil || *incoming.QuotedSenderName != "Luis" {
		t.Fatal("member mention/quote labels missing", err)
	}
	canonical, err := repos.Chat.GetByID(ctx, first.ID)
	if err != nil || canonical.UnreadCount != 1 || canonical.WaitingSince != nil || canonical.NeedsReply {
		t.Fatal("group generated pending instead of unread", err)
	}
	exec(`UPDATE chats SET waiting_since=NOW(),attention_through_at=NOW(),attention_through_id=$3 WHERE account_id=$1 AND id=$2`, a, first.ID, uuid.New())
	var pending bool
	if err = db.QueryRow(ctx, `SELECT waiting_since IS NOT NULL OR attention_through_at IS NOT NULL FROM chats WHERE account_id=$1 AND id=$2`, a, first.ID).Scan(&pending); err != nil || pending {
		t.Fatal("group attention guard bypassed", err)
	}
	outgoing := &domain.Message{AccountID: a, DeviceID: &d, ChatID: first.ID, MessageID: "outgoing", Body: &body, Timestamp: now.Add(time.Second), Status: &status, MessageType: &kind, IsFromMe: true}
	if err = repos.Message.Create(ctx, outgoing); err != nil {
		t.Fatal(err)
	}
	for _, m := range members {
		if err = repos.Message.SaveGroupReceipt(ctx, a, first.ID, outgoing.MessageID, m.JID, "read", now); err != nil {
			t.Fatal(err)
		}
	}
	if err = repos.Message.SaveGroupReceipt(ctx, a, first.ID, outgoing.MessageID, "7001@lid", "delivered", now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	receipts, next, total, err := repos.Message.GroupReceipts(ctx, a, first.ID, outgoing.MessageID, "", 1)
	if err != nil || len(receipts) != 1 || next == "" || total != 2 {
		t.Fatal("receipt pagination failed", err)
	}
	tail, _, _, err := repos.Message.GroupReceipts(ctx, a, first.ID, outgoing.MessageID, next, 1)
	if err != nil || len(tail) != 1 || tail[0].JID == receipts[0].JID {
		t.Fatal("receipt cursor repeated", err)
	}
	other, _, _, err := repos.Message.GroupReceipts(ctx, a, second.ID, outgoing.MessageID, "", 50)
	if err != nil || len(other) != 0 {
		t.Fatal("receipt leaked across devices")
	}
	groups, total, err := repos.Chat.GetByAccountIDWithFilters(ctx, a, domain.ChatFilter{Kind: "group", Limit: 50})
	if err != nil || total != 2 || len(groups) != 2 {
		t.Fatal("group list missing", err)
	}
	// The group/pending intersection remains empty even when a direct chat is
	// pending. Without this fixture, replacing the kind predicate could pass.
	directContact, directChat := uuid.New(), uuid.New()
	directJID := "51999000999@s.whatsapp.net"
	exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Direct QA')`, directContact, a, directJID)
	exec(`INSERT INTO chats(id,account_id,device_id,contact_id,jid,name,channel_key) VALUES($1,$2,$3,$4,$5,'Direct QA','whatsapp_web')`, directChat, a, d, directContact, directJID)
	directIncoming := &domain.Message{AccountID: a, DeviceID: &d, ChatID: directChat, MessageID: "direct-incoming", FromJID: &directJID, Body: &body, Timestamp: now, Status: &status, MessageType: &kind}
	if err = repos.Message.Create(ctx, directIncoming); err != nil {
		t.Fatal(err)
	}
	for _, chatKind := range []string{"", "all", "direct", "group"} {
		t.Run("pending_kind_"+chatKind, func(t *testing.T) {
			pendingChats, count, queryErr := repos.Chat.GetByAccountIDWithFilters(ctx, a, domain.ChatFilter{Kind: chatKind, PendingOnly: true, Limit: 50})
			expected := 1
			if chatKind == "group" {
				expected = 0
			}
			if queryErr != nil || count != expected || len(pendingChats) != expected {
				t.Fatalf("pending/kind intersection: got rows=%d total=%d want=%d error=%v", len(pendingChats), count, expected, queryErr)
			}
			if expected == 1 && pendingChats[0].ID != directChat {
				t.Fatal("pending list returned a group")
			}
		})
	}
	exec(`DELETE FROM chats WHERE account_id=$1 AND id=$2`, a, first.ID)
	hidden, err := repos.Chat.GroupHidden(ctx, a, d, jid)
	if err != nil || !hidden {
		t.Fatal("deleted group rediscovered", err)
	}
	visible, err := repos.Chat.RevealGroupActivity(ctx, a, d, jid, now.Add(-time.Hour))
	if err != nil || visible {
		t.Fatal("old history resurrected group", err)
	}
	visible, err = repos.Chat.RevealGroupActivity(ctx, a, d, jid, time.Now().Add(time.Second))
	if err != nil || !visible {
		t.Fatal("new activity failed to restore group", err)
	}
	var leads int
	if err = db.QueryRow(ctx, `SELECT COUNT(*) FROM leads WHERE account_id=$1`, a).Scan(&leads); err != nil || leads != 0 {
		t.Fatal("group created Leads")
	}
	exec(`DELETE FROM accounts WHERE id=$1`, a)
}
