package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
	"sync"
	"testing"
	"time"
)

func TestMessageSharingIntegrity(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	f := integrityProgram(t, db)
	ctx := context.Background()
	repos := NewRepositories(db)
	for pass := 0; pass < 2; pass++ {
		for _, migration := range database.MessageSharingMigrations() {
			if _, err := db.Exec(ctx, migration); err != nil {
				t.Fatal("idempotent migration", err)
			}
		}
	}
	device := uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic sharing','connected')`, device, f.account)
	chat, err := repos.Chat.GetOrCreate(ctx, f.account, device, "51900000123@s.whatsapp.net", "Synthetic sharing")
	if err != nil {
		t.Fatal(err)
	}
	body, kind, status := "Synthetic sharing policy", "text", "received"
	source := &domain.Message{AccountID: f.account, DeviceID: &device, ChatID: chat.ID, MessageID: uuid.NewString(), Body: &body, MessageType: &kind, Status: &status, Timestamp: time.Now().UTC(), Forwarding: domain.MessageForwarding{State: domain.ForwardingFrequentlyForwarded}}
	if err = repos.Message.Create(ctx, source); err != nil {
		t.Fatal(err)
	}
	source, err = repos.Message.GetByReference(ctx, f.account, chat.ID, source.MessageID)
	if err != nil {
		t.Fatal(err)
	}
	if source.SharingLimits != nil {
		t.Fatal("legacy null policy backfilled")
	}
	limits := domain.EffectiveMessageSharingLimits(source)
	op := &ForwardOperation{ID: uuid.New(), AccountID: f.account, UserID: f.user, DeviceID: device, SourceChatID: chat.ID, SourceMessageID: source.ID, RequestHash: "synthetic-copy-policy", SourceFingerprint: domain.MessageForwardFingerprint(source), Forwarding: source.Forwarding, Mode: domain.MessageSharingCopy, SharingLimits: &limits, Results: []ForwardTarget{{ChatID: chat.ID, JID: chat.JID, ProviderMessageID: uuid.NewString()}}}
	if created, err := repos.Message.CreateForwardOperation(ctx, op); err != nil || !created {
		t.Fatal("copy reservation", created, err)
	}

	// A PN/LID echo may initially be persisted in another chat. Restrict it by
	// the same-device/account reserved provider ID, without relocating identity
	// or declaring the original destination delivered.
	alternate, err := repos.Chat.GetOrCreate(ctx, f.account, device, "700123@lid", "Synthetic alternate echo")
	if err != nil {
		t.Fatal(err)
	}
	alternateEcho := &domain.Message{AccountID: f.account, DeviceID: &device, ChatID: alternate.ID, MessageID: op.Results[0].ProviderMessageID, Body: &body, MessageType: &kind, IsFromMe: true, Status: &status, Timestamp: time.Now().UTC(), Forwarding: domain.MessageForwarding{State: domain.ForwardingNotForwarded}}
	if err = repos.Message.Create(ctx, alternateEcho); err != nil {
		t.Fatal(err)
	}
	if alternateEcho.SharingLimits == nil || *alternateEcho.SharingLimits != limits || alternateEcho.ChatID != alternate.ID {
		t.Fatal("alternate echo lost policy or moved identity", alternateEcho)
	}
	if ok, err := repos.Message.ClaimForwardTarget(ctx, f.account, op.ID, chat.ID); err != nil || !ok {
		t.Fatal(err)
	}
	if err = repos.Message.FinishForwardTarget(ctx, f.account, op.ID, chat.ID, "uncertain", "forward_outcome_pending", "Synthetic", false); err != nil {
		t.Fatal(err)
	}
	pendingReceipt, err := repos.Message.GetForwardOperation(ctx, f.account, f.user, op.ID)
	if err != nil || pendingReceipt.Results[0].State != "uncertain" || pendingReceipt.Results[0].Message != nil {
		t.Fatal("alternate echo falsely confirmed selected destination", pendingReceipt, err)
	}
	otherDevice := uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic different device','connected')`, otherDevice, f.account)
	otherChat, err := repos.Chat.GetOrCreate(ctx, f.account, otherDevice, "700124@lid", "Synthetic device boundary")
	if err != nil {
		t.Fatal(err)
	}
	wrongDeviceEcho := *alternateEcho
	wrongDeviceEcho.ID = uuid.Nil
	wrongDeviceEcho.DeviceID = &otherDevice
	wrongDeviceEcho.ChatID = otherChat.ID
	wrongDeviceEcho.SharingLimits = nil
	if err = repos.Message.Create(ctx, &wrongDeviceEcho); err != nil || wrongDeviceEcho.SharingLimits != nil {
		t.Fatal("foreign device inherited reservation", err)
	}
	foreignFixture := integrityProgram(t, db)
	foreignDevice := uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic different account','connected')`, foreignDevice, foreignFixture.account)
	foreignChat, err := repos.Chat.GetOrCreate(ctx, foreignFixture.account, foreignDevice, "700123@lid", "Synthetic account boundary")
	if err != nil {
		t.Fatal(err)
	}
	wrongAccountEcho := *alternateEcho
	wrongAccountEcho.ID = uuid.Nil
	wrongAccountEcho.AccountID = foreignFixture.account
	wrongAccountEcho.DeviceID = &foreignDevice
	wrongAccountEcho.ChatID = foreignChat.ID
	wrongAccountEcho.SharingLimits = nil
	if err = repos.Message.Create(ctx, &wrongAccountEcho); err != nil || wrongAccountEcho.SharingLimits != nil {
		t.Fatal("foreign account inherited reservation", err)
	}
	// The provider echo wins before local transport persistence. It must be
	// restricted from its first visible row, not after a second follow-up write.
	echo := &domain.Message{AccountID: f.account, DeviceID: &device, ChatID: chat.ID, MessageID: op.Results[0].ProviderMessageID, Body: &body, MessageType: &kind, IsFromMe: true, Status: &status, Timestamp: time.Now().UTC(), Forwarding: domain.MessageForwarding{State: domain.ForwardingNotForwarded}}
	if err = repos.Message.Create(ctx, echo); err != nil {
		t.Fatal(err)
	}
	assertPolicy := func(label string, message *domain.Message, err error) {
		t.Helper()
		if err != nil || message == nil || message.SharingLimits == nil || *message.SharingLimits != limits {
			t.Fatalf("%s policy missing %+v %v", label, message, err)
		}
	}
	stored, err := repos.Message.GetByReference(ctx, f.account, chat.ID, echo.MessageID)
	assertPolicy("reference", stored, err)
	stored, err = repos.Message.GetByMessageID(ctx, chat.ID, echo.MessageID)
	assertPolicy("provider id", stored, err)
	pages, err := repos.Message.GetByChatID(ctx, chat.ID, 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range pages {
		if m.ID == echo.ID {
			assertPolicy("history", m, nil)
		}
	}
	found, _, err := repos.Message.SearchByChat(ctx, f.account, chat.ID, "Synthetic sharing", 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range found {
		if m.ID == echo.ID {
			assertPolicy("search", m, nil)
		}
	}
	window, err := repos.Message.GetWindowByChatID(ctx, f.account, chat.ID, 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range window {
		if m.ID == echo.ID {
			assertPolicy("window", m, nil)
		}
	}
	wide := domain.MessageSharingLimits{MaxChats: 5, MaxGroups: 5}
	stored, err = repos.Message.MergeMessageSharingLimits(ctx, f.account, device, chat.ID, echo.MessageID, wide)
	assertPolicy("transport echo reconciliation", stored, err)
	duplicate := *echo
	duplicate.SharingLimits = &wide
	if err = repos.Message.Create(ctx, &duplicate); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("duplicate changed identity", err)
	}
	stored, err = repos.Message.GetByReference(ctx, f.account, chat.ID, echo.MessageID)
	assertPolicy("late echo", stored, err)
	for _, scope := range []struct{ account, device, chat uuid.UUID }{{uuid.New(), device, chat.ID}, {f.account, uuid.New(), chat.ID}, {f.account, device, uuid.New()}} {
		if _, err = repos.Message.MergeMessageSharingLimits(ctx, scope.account, scope.device, scope.chat, echo.MessageID, wide); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal("foreign merge succeeded", err)
		}
	}
	if _, err = repos.Message.MergeMessageSharingLimits(ctx, f.account, device, chat.ID, source.MessageID, wide); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("incoming message policy mutated through outgoing merge", err)
	}
	// A concurrent own echo, a wide observation and a stronger local rule may
	// arrive in any order. PostgreSQL keeps the minimum, never last-writer-wins.
	standalone := *echo
	standalone.ID = uuid.Nil
	standalone.MessageID = uuid.NewString()
	standalone.SharingLimits = nil
	if err = repos.Message.Create(ctx, &standalone); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			p := wide
			if i%3 == 0 {
				p = limits
			} else if i%3 == 1 {
				p.MaxGroups = 1
			}
			if _, e := repos.Message.MergeMessageSharingLimits(ctx, f.account, device, chat.ID, standalone.MessageID, p); e != nil {
				t.Error(e)
			}
		}(i)
	}
	wg.Wait()
	stored, err = repos.Message.GetByReference(ctx, f.account, chat.ID, standalone.MessageID)
	assertPolicy("concurrent minimum", stored, err)
	// The response receipt and a later duplicate preserve mode and policy even
	// after an uncertain provider outcome, without another physical send.
	receipt, err := repos.Message.GetForwardOperation(ctx, f.account, f.user, op.ID)
	if err != nil || receipt.Mode != domain.MessageSharingCopy || receipt.ContentVariant != domain.MessageContentOriginal || receipt.SharingLimits == nil || *receipt.SharingLimits != limits || receipt.Results[0].State != "sent" {
		t.Fatal("receipt lost sharing contract", receipt, err)
	}
	assertPolicy("receipt message", receipt.Results[0].Message, nil)
	// Invalid policies are rejected by both typed writes and the DB contract.
	for _, bad := range []string{`{}`, `{"max_chats":0,"max_groups":1}`, `{"max_chats":1,"max_groups":5}`, `{"max_chats":5,"max_groups":"1"}`, `null`} {
		if _, err = db.Exec(ctx, `UPDATE messages SET sharing_limits=$2::jsonb WHERE id=$1`, echo.ID, bad); err == nil {
			t.Fatal("invalid persisted policy", bad)
		}
	}
	if _, err = repos.Message.MergeMessageSharingLimits(ctx, f.account, device, chat.ID, echo.MessageID, domain.MessageSharingLimits{MaxChats: 0, MaxGroups: 1}); err == nil {
		t.Fatal("invalid typed policy accepted")
	}
	// A policy strengthened after preparation invalidates the old fingerprint.
	integrityExec(t, db, `UPDATE messages SET sharing_limits='{"max_chats":5,"max_groups":5}'::jsonb WHERE id=$1`, standalone.ID)
	fresh, err := repos.Message.GetByReference(ctx, f.account, chat.ID, standalone.MessageID)
	if err != nil {
		t.Fatal(err)
	}
	stale := *op
	stale.ID = uuid.New()
	stale.SourceMessageID = fresh.ID
	stale.SourceFingerprint = domain.MessageForwardFingerprint(fresh)
	stale.Results = []ForwardTarget{{ChatID: chat.ID, JID: chat.JID, ProviderMessageID: uuid.NewString()}}
	if _, err = repos.Message.MergeMessageSharingLimits(ctx, f.account, device, chat.ID, fresh.MessageID, limits); err != nil {
		t.Fatal(err)
	}
	if _, err = repos.Message.CreateForwardOperation(ctx, &stale); !errors.Is(err, ErrForwardSourceChanged) {
		t.Fatal("policy change ignored", err)
	}
}

func TestNativeSharingIncompleteEchoRetainsOutputPolicy(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	f := integrityProgram(t, db)
	ctx := context.Background()
	repos := NewRepositories(db)
	device := uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic native output','connected')`, device, f.account)
	chat, err := repos.Chat.GetOrCreate(ctx, f.account, device, "51900000456@s.whatsapp.net", "Synthetic native output")
	if err != nil {
		t.Fatal(err)
	}
	body, kind, status := "Synthetic native output policy", "text", "received"
	four := uint32(4)
	for _, tc := range []struct {
		name       string
		forwarding domain.MessageForwarding
		want       domain.MessageSharingLimits
	}{
		{"received original", domain.MessageForwarding{State: domain.ForwardingNotForwarded}, domain.MessageSharingLimits{MaxChats: 5, MaxGroups: 1}},
		{"frequent threshold", domain.MessageForwarding{State: domain.ForwardingForwarded, Score: &four}, domain.MessageSharingLimits{MaxChats: 1, MaxGroups: 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := &domain.Message{AccountID: f.account, DeviceID: &device, ChatID: chat.ID, MessageID: uuid.NewString(), Body: &body, MessageType: &kind, Status: &status, Timestamp: time.Now().UTC(), Forwarding: tc.forwarding}
			if err := repos.Message.Create(ctx, source); err != nil {
				t.Fatal(err)
			}
			source, err = repos.Message.GetByReference(ctx, f.account, chat.ID, source.MessageID)
			if err != nil {
				t.Fatal(err)
			}
			limits, err := domain.MessageSharingOutputLimits(source, domain.MessageSharingNative)
			if err != nil || limits != tc.want {
				t.Fatal("prepared output policy", limits, err)
			}
			op := &ForwardOperation{ID: uuid.New(), AccountID: f.account, UserID: f.user, DeviceID: device, SourceChatID: chat.ID, SourceMessageID: source.ID, RequestHash: uuid.NewString(), SourceFingerprint: domain.MessageForwardFingerprint(source), Forwarding: source.Forwarding, Mode: domain.MessageSharingNative, SharingLimits: &limits, Results: []ForwardTarget{{ChatID: chat.ID, JID: chat.JID, ProviderMessageID: uuid.NewString()}}}
			if created, err := repos.Message.CreateForwardOperation(ctx, op); err != nil || !created {
				t.Fatal("native reservation", created, err)
			}
			echo := &domain.Message{AccountID: f.account, DeviceID: &device, ChatID: chat.ID, MessageID: op.Results[0].ProviderMessageID, Body: &body, MessageType: &kind, IsFromMe: true, Status: &status, Timestamp: time.Now().UTC()}
			if err := repos.Message.Create(ctx, echo); err != nil {
				t.Fatal(err)
			}
			if echo.Forwarding.Normalize().State != domain.ForwardingUnknown || echo.SharingLimits == nil || *echo.SharingLimits != tc.want || domain.EffectiveMessageSharingLimits(echo) != tc.want {
				t.Fatal("incomplete echo widened policy or invented native flags", echo)
			}
			wide := domain.EffectiveMessageSharingLimits(source)
			canonical, err := repos.Message.MergeMessageSharingLimits(ctx, f.account, device, chat.ID, echo.MessageID, wide)
			if err != nil || canonical.SharingLimits == nil || *canonical.SharingLimits != tc.want {
				t.Fatal("later persistence widened prepared policy", canonical, err)
			}
		})
	}
}
