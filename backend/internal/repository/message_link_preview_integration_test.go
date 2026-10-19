package repository

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
)

func TestChatLinkPreviewIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CHAT_LINK_PREVIEW_INTEGRATION") != "1" {
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
	name := "clarin_preview_qa_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	var triggerOID uint32
	for i := 0; i < 2; i++ {
		if err = database.Migrate(db); err != nil {
			t.Fatal(err)
		}
		// The worker repeats Migrate while the backend is already serving.
		// Replacing the trigger must preserve its identity instead of leaving
		// a committed DROP/CREATE gap without preview version increments.
		var currentOID uint32
		if err := db.QueryRow(ctx, `SELECT oid FROM pg_trigger WHERE tgrelid='messages'::regclass AND tgname='trg_messages_link_preview_version' AND NOT tgisinternal`).Scan(&currentOID); err != nil {
			t.Fatalf("read preview version trigger after migration %d: %v", i+1, err)
		}
		if currentOID == 0 || (i > 0 && currentOID != triggerOID) {
			t.Fatal("startup migration dropped/recreated the live preview version trigger")
		}
		triggerOID = currentOID
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	account, foreign, device, otherDevice := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Preview QA'),($2,'Foreign QA')`, account, foreign)
	exec(`INSERT INTO devices(id,account_id,name) VALUES($1,$3,'Synthetic'),($2,$3,'Other synthetic')`, device, otherDevice, account)
	repos := NewRepositories(db)
	group, err := repos.Chat.GetOrCreateGroup(ctx, account, device, "120098@g.us", "Preview QA")
	if err != nil {
		t.Fatal(err)
	}
	other, err := repos.Chat.GetOrCreateGroup(ctx, account, otherDevice, group.JID, "Other device")
	if err != nil {
		t.Fatal(err)
	}
	direct, err := repos.Chat.GetOrCreate(ctx, account, device, "51999000888@s.whatsapp.net", "Synthetic")
	if err != nil {
		t.Fatal(err)
	}
	exec(`CREATE FUNCTION reject_preview_crm() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'preview touched Leads'; END $$`)
	exec(`CREATE TRIGGER reject_preview_crm BEFORE INSERT OR UPDATE OR DELETE ON leads FOR EACH STATEMENT EXECUTE FUNCTION reject_preview_crm()`)
	link, body, kind, status, sender := "https://example.test/resource", "Read https://example.test/resource", "text", "received", "51999000888@s.whatsapp.net"
	alias := "999000888@lid"
	if err = repos.Chat.SaveGroup(ctx, account, group.ID, &domain.ChatGroup{Subject: "Preview QA", MembershipStatus: "member", Kind: "group"}, []domain.GroupParticipant{{JID: sender, LID: alias, Name: "Synthetic"}}); err != nil {
		t.Fatal(err)
	}
	makeMessage := func(chatID uuid.UUID, id string) *domain.Message {
		return &domain.Message{AccountID: account, DeviceID: &device, ChatID: chatID, MessageID: id, Body: &body, MessageType: &kind, Status: &status, FromJID: &sender, Timestamp: time.Now().UTC(), QuotedMessageID: func() *string { v := "quote-provider"; return &v }()}
	}
	for _, chat := range []*domain.Chat{group, direct} {
		t.Run(chat.Kind, func(t *testing.T) {
			message := makeMessage(chat.ID, "preview-initial")
			if err := repos.Message.Create(ctx, message); err != nil {
				t.Fatal(err)
			}
			var before, after string
			state := `SELECT jsonb_build_object('unread',unread_count,'waiting',waiting_since,'version',state_version,'attention',attention_through_at,'leads',(SELECT count(*) FROM leads WHERE account_id=$1))::text FROM chats WHERE account_id=$1 AND id=$2`
			if err := db.QueryRow(ctx, state, account, chat.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			for _, mutation := range []func(*domain.Message){func(m *domain.Message) { m.AccountID = foreign }, func(m *domain.Message) { m.ChatID = other.ID }, func(m *domain.Message) { m.DeviceID = &otherDevice }, func(m *domain.Message) { v := "different body"; m.Body = &v }, func(m *domain.Message) { m.IsEdited = true }, func(m *domain.Message) { v := "51999000777@s.whatsapp.net"; m.FromJID = &v }} {
				candidate := *message
				candidate.LinkPreview = domain.ReceivedMessageLinkPreview(body, link, "Different", "Metadata")
				mutation(&candidate)
				if changed, err := repos.Message.EnrichLinkPreview(ctx, &candidate); err != nil || changed {
					t.Fatal("invalid duplicate enrichment", err)
				}
			}
			duplicate := makeMessage(chat.ID, message.MessageID)
			duplicate.LinkPreview = domain.ReceivedMessageLinkPreview(body, link, "Title", "Description")
			if chat.ID == group.ID {
				duplicate.FromJID = &alias // roster-proven PN/LID identity must enrich once
			}
			changed, err := repos.Message.EnrichLinkPreview(ctx, duplicate)
			if err != nil || !changed || duplicate.ID != message.ID || duplicate.LinkPreviewVersion != 1 {
				t.Fatal("missing idempotent enrichment", err)
			}
			changed, err = repos.Message.EnrichLinkPreview(ctx, duplicate)
			if err != nil || changed {
				t.Fatal("duplicate enrichment was not idempotent", err)
			}
			exec(`UPDATE messages SET link_preview=link_preview,status=status WHERE account_id=$1 AND id=$2`, account, message.ID)
			if err := db.QueryRow(ctx, state, account, chat.ID).Scan(&after); err != nil || before != after {
				t.Fatal("enrichment changed attention/counters/Leads", err)
			}
			loaded, err := repos.Message.GetByReference(ctx, account, chat.ID, message.ID.String())
			if err != nil || loaded.LinkPreview == nil || loaded.LinkPreview.URL != link || loaded.LinkPreviewVersion != 1 || loaded.QuotedMessageID == nil {
				t.Fatal("reference lost preview or quote", err)
			}
			pages, err := repos.Message.GetByChatID(ctx, chat.ID, 50, 0)
			if err != nil || len(pages) != 1 || pages[0].LinkPreview == nil || pages[0].LinkPreviewVersion != 1 {
				t.Fatal("history lost preview", err)
			}
			search, _, err := repos.Message.SearchByChat(ctx, account, chat.ID, "resource", 50, 0)
			if err != nil || len(search) != 1 || search[0].LinkPreview == nil || search[0].LinkPreviewVersion != 1 {
				t.Fatal("search lost preview", err)
			}
			window, err := repos.Message.GetWindowByChatID(ctx, account, chat.ID, 50, 0)
			if err != nil || len(window) != 1 || window[0].LinkPreview == nil || window[0].LinkPreviewVersion != 1 {
				t.Fatal("context lost preview", err)
			}
			staleTarget, staleWindow := *loaded, *loaded
			staleTarget.LinkPreview = nil
			staleWindow.LinkPreview = nil
			foreignProjection := staleTarget
			foreignProjection.AccountID = foreign
			otherProjection := staleTarget
			otherProjection.ChatID = other.ID
			if err := repos.Message.HydrateLinkPreviews(ctx, account, chat.ID, []*domain.Message{&staleTarget, &staleWindow, &foreignProjection, &otherProjection}); err != nil {
				t.Fatal(err)
			}
			if staleTarget.LinkPreview == nil || staleWindow.LinkPreview == nil || staleTarget.LinkPreview == staleWindow.LinkPreview || staleTarget.LinkPreviewVersion != 1 || staleWindow.LinkPreviewVersion != 1 || foreignProjection.LinkPreview != nil || otherProjection.LinkPreview != nil {
				t.Fatal("projection hydration crossed identity or aliased pointers")
			}

			if err := repos.Message.EditInChat(ctx, account, chat.ID, message.MessageID, "Edited plain text"); err != nil {
				t.Fatal(err)
			}
			if changed, err := repos.Message.EnrichLinkPreview(ctx, duplicate); err != nil || changed {
				t.Fatal("old original restored edited preview", err)
			}
			loaded, err = repos.Message.GetByReference(ctx, account, chat.ID, message.ID.String())
			if err != nil || loaded.LinkPreview != nil || !loaded.IsEdited || loaded.LinkPreviewVersion != 2 {
				t.Fatal("editing without URL retained preview", err)
			}
		})
	}
	t.Run("edit before original and revoke", func(t *testing.T) {
		const providerID = "late-original"
		editedBody := "Updated https://example.test/new"
		preview := domain.ReceivedMessageLinkPreview(editedBody, "https://example.test/new", "New title", "")
		at := time.Now().UTC()
		changed, err := repos.Message.ApplyGroupMessageEdit(ctx, account, group.ID, providerID, editedBody, []domain.MessageMention{}, at, preview, nil)
		if err != nil || !changed {
			t.Fatal(err)
		}
		message := makeMessage(group.ID, providerID)
		message.LinkPreview = domain.ReceivedMessageLinkPreview(body, link, "Old title", "")
		if err := repos.Message.Create(ctx, message); err != nil {
			t.Fatal(err)
		}
		if message.Body == nil || *message.Body != editedBody || !message.IsEdited || message.LinkPreview == nil || message.LinkPreview.Title != "New title" {
			t.Fatal("original replaced earlier authoritative edit")
		}
		changed, err = repos.Message.ApplyGroupMessageEdit(ctx, account, group.ID, providerID, body, nil, at.Add(-time.Minute), nil, nil)
		if err != nil || changed {
			t.Fatal("stale edit replaced preview", err)
		}
		if err := repos.Message.RevokeInChat(ctx, account, group.ID, providerID); err != nil {
			t.Fatal(err)
		}
		if err := repos.Message.HydrateLinkPreviews(ctx, account, group.ID, []*domain.Message{message}); err != nil || message.LinkPreview != nil {
			t.Fatal("revoked preview remains visible", err)
		}
	})
	t.Run("asset ownership and inactive thumbnail", func(t *testing.T) {
		asset := uuid.New()
		key := foreign.String() + "/link-previews/" + strings.Repeat("a", 64) + ".jpg"
		exec(`INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status) VALUES($1,$2,$3,$4,'image','image/jpeg','preview.jpg',12,'active')`, asset, foreign, "link_preview:"+strings.Repeat("a", 64), key)
		message := makeMessage(group.ID, "foreign-asset")
		message.LinkPreview = domain.ReceivedMessageLinkPreview(body, link, "Text survives", "")
		message.LinkPreviewMediaAssetID = &asset
		if err := repos.Message.Create(ctx, message); err != nil {
			t.Fatal(err)
		}
		if message.LinkPreview == nil || message.LinkPreview.ThumbnailURL != nil || message.LinkPreviewMediaAssetID != nil {
			t.Fatal("foreign thumbnail attached or text lost")
		}
		if _, err := db.Exec(ctx, `UPDATE messages SET link_preview_media_asset_id=$3 WHERE account_id=$1 AND id=$2`, account, message.ID, asset); err == nil {
			t.Fatal("composite asset ownership FK missing")
		}
		owned, key, _, err := repos.MediaAsset.ReserveLinkPreviewMedia(ctx, account, "link_preview:"+strings.Repeat("b", 64), 12)
		if err != nil {
			t.Fatal(err)
		}
		if err = repos.MediaAsset.CompleteLinkPreviewMedia(ctx, account, owned, key, true); err != nil {
			t.Fatal(err)
		}
		active := makeMessage(group.ID, "active-asset")
		active.LinkPreview = domain.ReceivedMessageLinkPreview(body, link, "Keep metadata", "")
		active.LinkPreviewMediaAssetID = &owned
		if err = repos.Message.Create(ctx, active); err != nil {
			t.Fatal(err)
		}
		if active.LinkPreview == nil || active.LinkPreview.ThumbnailURL == nil {
			t.Fatal("owned active preview missing")
		}
		exec(`UPDATE media_assets SET status='orphan' WHERE account_id=$1 AND id=$2`, account, owned)
		if err = repos.Message.HydrateLinkPreviews(ctx, account, group.ID, []*domain.Message{active}); err != nil {
			t.Fatal(err)
		}
		if active.LinkPreview == nil || active.LinkPreview.Title != "Keep metadata" || active.LinkPreview.ThumbnailURL != nil {
			t.Fatal("inactive thumbnail leaked or textual preview lost")
		}
	})
	t.Run("manual thumbnail removal survives provider replay", func(t *testing.T) {
		asset, key, _, err := repos.MediaAsset.ReserveLinkPreviewMedia(ctx, account, "link_preview:"+strings.Repeat("c", 64), 12)
		if err != nil {
			t.Fatal(err)
		}
		if err = repos.MediaAsset.CompleteLinkPreviewMedia(ctx, account, asset, key, true); err != nil {
			t.Fatal(err)
		}
		thumbnail := "/api/media/file/" + key
		preview := func(text string) *domain.MessageLinkPreview {
			p := domain.ReceivedMessageLinkPreview(text, link, "Retired image", "Metadata stays")
			p.ThumbnailURL = &thumbnail
			return p
		}
		detach := func(slot string, id uuid.UUID) {
			t.Helper()
			table, column, assetColumn := "messages", "link_preview", "link_preview_media_asset_id"
			if slot == "group_edit" {
				table, column, assetColumn = "chat_group_message_state", "edited_link_preview", "edited_link_preview_media_asset_id"
			}
			exec(`UPDATE `+table+` SET `+column+`=`+column+`-'thumbnail_url',`+assetColumn+`=NULL WHERE account_id=$1 AND id=$2`, account, id)
			exec(`INSERT INTO storage_removed_references(account_id,actor_id,operation_id,object_key,use_id,adapter,origin_type,filename,media_type,size_bytes,snapshot)
    SELECT $1::uuid,$3::uuid,$4::uuid,$5::text,($2::uuid)::text||($4::uuid)::text,'link_preview','chats','preview.jpg','image',12,
    jsonb_build_object('source_id',($2::uuid)::text,'slot',$6::text,'after',jsonb_build_object('body',$7::text,'preview',`+column+`)) FROM `+table+` WHERE account_id=$1::uuid AND id=$2::uuid`, account, id, uuid.New(), uuid.New(), key, slot, body)
		}
		var plain *domain.Message
		for _, state := range []string{"removed", "purging", "purged"} {
			plain = makeMessage(direct.ID, "retired-direct-"+state)
			plain.LinkPreview, plain.LinkPreviewMediaAssetID = preview(body), &asset
			if err = repos.Message.Create(ctx, plain); err != nil {
				t.Fatal(err)
			}
			detach("message", plain.ID)
			exec(`UPDATE storage_removed_references SET state=$3 WHERE account_id=$1 AND snapshot->>'source_id'=$2`, account, plain.ID.String(), state)
			duplicate := makeMessage(direct.ID, plain.MessageID)
			duplicate.LinkPreview, duplicate.LinkPreviewMediaAssetID = preview(body), &asset
			if changed, e := repos.Message.EnrichLinkPreview(ctx, duplicate); e != nil || changed {
				t.Fatalf("%s replay restored removed thumbnail: %v", state, e)
			}
			p := preview(body)
			if e := repos.Message.EditInChatWithLinkPreview(ctx, account, direct.ID, plain.MessageID, body, p, &asset); e != nil || p.ThumbnailURL != nil {
				t.Fatalf("%s edit replay restored thumbnail: %v", state, e)
			}
		}
		newBody := "A real new edit " + link
		p := preview(newBody)
		if err = repos.Message.EditInChatWithLinkPreview(ctx, account, direct.ID, plain.MessageID, newBody, p, &asset); err != nil || p.ThumbnailURL == nil {
			t.Fatal("new direct edit was blocked", err)
		}
		at := time.Now().UTC().Truncate(time.Millisecond)
		const providerID = "retired-group-edit"
		if applied, e := repos.Message.ApplyGroupMessageEdit(ctx, account, group.ID, providerID, body, nil, at, preview(body), &asset); e != nil || !applied {
			t.Fatal(e)
		}
		original := makeMessage(group.ID, providerID)
		if err = repos.Message.Create(ctx, original); err != nil {
			t.Fatal(err)
		}
		var stateID uuid.UUID
		if err = db.QueryRow(ctx, `SELECT id FROM chat_group_message_state WHERE account_id=$1 AND chat_id=$2 AND message_id=$3`, account, group.ID, providerID).Scan(&stateID); err != nil {
			t.Fatal(err)
		}
		detach("message", original.ID)
		detach("group_edit", stateID)
		if applied, e := repos.Message.ApplyGroupMessageEdit(ctx, account, group.ID, providerID, body, nil, at, preview(body), &asset); e != nil || applied {
			t.Fatal("equal timestamp replay was not a no-op", e)
		}
		p = preview(body)
		if applied, e := repos.Message.ApplyGroupMessageEdit(ctx, account, group.ID, providerID, body, nil, time.Time{}, p, &asset); e != nil || !applied || p.ThumbnailURL != nil {
			t.Fatal("timestamp-free replay restored thumbnail", e)
		}
		var messageThumb, stateThumb *string
		var messageMentions, stateMentions int
		if err = db.QueryRow(ctx, `SELECT m.link_preview->>'thumbnail_url',s.edited_link_preview->>'thumbnail_url',jsonb_array_length(m.group_mentions),jsonb_array_length(s.edited_mentions) FROM messages m JOIN chat_group_message_state s ON s.account_id=m.account_id AND s.chat_id=m.chat_id AND s.message_id=m.message_id WHERE m.account_id=$1 AND m.id=$2`, account, original.ID).Scan(&messageThumb, &stateThumb, &messageMentions, &stateMentions); err != nil || messageThumb != nil || stateThumb != nil || messageMentions != 0 || stateMentions != 0 {
			t.Fatal("retired image or empty mention collection was not preserved", err)
		}
		if applied, e := repos.Message.ApplyGroupMessageEdit(ctx, account, group.ID, providerID, body, nil, time.Now().Add(time.Second), preview(body), &asset); e != nil || !applied {
			t.Fatal("newer authoritative group edit was blocked", e)
		}
		canonical, e := repos.Message.GetByReference(ctx, account, group.ID, original.ID.String())
		if e != nil || canonical.LinkPreview == nil || canonical.LinkPreview.ThumbnailURL == nil {
			t.Fatal("new group edit lost its preview", e)
		}
	})

}
