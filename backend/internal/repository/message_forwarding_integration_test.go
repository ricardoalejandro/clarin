package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"sync"
	"testing"
	"time"
)

func TestMessageForwardingIntegrity(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	f := integrityProgram(t, db)
	ctx := context.Background()
	repos := NewRepositories(db)
	device := uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic forwarding','connected')`, device, f.account)
	chat, err := repos.Chat.GetOrCreate(ctx, f.account, device, "51900000123@s.whatsapp.net", "Synthetic forwarding")
	if err != nil {
		t.Fatal(err)
	}
	kind, body, status := "text", "Synthetic forwarding", "received"
	message := &domain.Message{AccountID: f.account, DeviceID: &device, ChatID: chat.ID, MessageID: uuid.NewString(), Body: &body, MessageType: &kind, Status: &status, Timestamp: time.Now().UTC().Truncate(time.Microsecond)}
	if err = repos.Message.Create(ctx, message); err != nil {
		t.Fatal(err)
	}
	stored, err := repos.Message.GetByReference(ctx, f.account, chat.ID, message.ID.String())
	if err != nil || stored.Forwarding.Normalize().State != domain.ForwardingUnknown {
		t.Fatal("legacy not unknown", err)
	}
	score := uint32(5)
	duplicate := *message
	duplicate.Forwarding = domain.MessageForwarding{State: domain.ForwardingFrequentlyForwarded, Score: &score}
	if err = repos.Message.Create(ctx, &duplicate); !errors.Is(err, pgx.ErrNoRows) || !duplicate.ForwardingHydrated {
		t.Fatalf("duplicate metadata not committed: %v", err)
	}
	legacy := *message
	legacy.Forwarding = domain.MessageForwarding{}
	if err = repos.Message.Create(ctx, &legacy); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal(err)
	}
	foreign := duplicate
	foreign.AccountID = uuid.New()
	if changed, err := repos.Message.HydrateMessageForwarding(ctx, &foreign); err != nil || changed {
		t.Fatal("foreign metadata accepted", err)
	}
	pages, err := repos.Message.GetByChatID(ctx, chat.ID, 50, 0)
	if err != nil || len(pages) != 1 || pages[0].Forwarding.State != domain.ForwardingFrequentlyForwarded {
		t.Fatal("history lost forwarding", err)
	}
	found, _, err := repos.Message.SearchByChat(ctx, f.account, chat.ID, "Synthetic", 50, 0)
	if err != nil || len(found) != 1 || found[0].Forwarding.Score == nil || *found[0].Forwarding.Score != 5 {
		t.Fatal("search lost forwarding", err)
	}
	window, err := repos.Message.GetWindowByChatID(ctx, f.account, chat.ID, 50, 0)
	if err != nil || len(window) != 1 || window[0].Forwarding.State != domain.ForwardingFrequentlyForwarded {
		t.Fatal("window lost forwarding", err)
	}
	stored, err = repos.Message.GetByReference(ctx, f.account, chat.ID, message.ID.String())
	if err != nil || stored.Body == nil || *stored.Body != body || stored.ID != message.ID || !stored.Timestamp.Equal(message.Timestamp) || stored.IsRead {
		t.Fatal("metadata hydration changed content or chronology", err)
	}
	// A provider message ID is not an author credential: a second group
	// participant may choose the same stanza ID. Its metadata must not merge.
	group, groupErr := repos.Chat.GetOrCreateGroup(ctx, f.account, device, "120036000000001@g.us", "Synthetic forwarding authors")
	if groupErr != nil {
		t.Fatal(groupErr)
	}
	authorA, authorB, aliasA := "51900000111@s.whatsapp.net", "51900000222@s.whatsapp.net", "701@lid"
	if groupErr = repos.Chat.SaveGroup(ctx, f.account, group.ID, &domain.ChatGroup{Subject: "Synthetic forwarding authors", MembershipStatus: "member", Kind: "group"}, []domain.GroupParticipant{{JID: authorA, LID: aliasA, Name: "Synthetic A", Role: "member"}, {JID: authorB, LID: "702@lid", Name: "Synthetic B", Role: "member"}}); groupErr != nil {
		t.Fatal(groupErr)
	}
	audioKind := "audio"
	originalGroup := &domain.Message{AccountID: f.account, DeviceID: &device, ChatID: group.ID, MessageID: uuid.NewString(), FromJID: &authorA, Body: &body, MessageType: &audioKind, Status: &status, Timestamp: time.Now().UTC().Truncate(time.Microsecond)}
	if groupErr = repos.Message.Create(ctx, originalGroup); groupErr != nil {
		t.Fatal(groupErr)
	}
	falsePTT, truePTT := false, true
	unrelated := *originalGroup
	unrelated.FromJID = &authorB
	unrelated.Forwarding = domain.MessageForwarding{State: domain.ForwardingFrequentlyForwarded, Score: &score}
	unrelated.AudioPTT = &truePTT
	if groupErr = repos.Message.Create(ctx, &unrelated); !errors.Is(groupErr, pgx.ErrNoRows) || unrelated.ForwardingHydrated {
		t.Fatal("another participant hydrated the duplicate stanza", groupErr)
	}
	if changed, groupErr := repos.Message.HydrateMessageForwarding(ctx, &unrelated); groupErr != nil || changed {
		t.Fatal("direct hydration bypassed the group author guard", groupErr)
	}
	untouched, groupErr := repos.Message.GetByReference(ctx, f.account, group.ID, originalGroup.MessageID)
	if groupErr != nil || untouched.Forwarding.Normalize().State != domain.ForwardingUnknown || untouched.AudioPTT != nil || untouched.FromJID == nil || *untouched.FromJID != authorA {
		t.Fatal("unrelated participant changed canonical provenance", groupErr)
	}
	one := uint32(1)
	verifiedAlias := *originalGroup
	verifiedAlias.FromJID = &aliasA
	verifiedAlias.Forwarding = domain.MessageForwarding{State: domain.ForwardingForwarded, Score: &one}
	verifiedAlias.AudioPTT = &falsePTT
	if groupErr = repos.Message.Create(ctx, &verifiedAlias); !errors.Is(groupErr, pgx.ErrNoRows) || !verifiedAlias.ForwardingHydrated {
		t.Fatal("verified PN/LID author could not hydrate", groupErr)
	}
	canonicalGroup, groupErr := repos.Message.GetByReference(ctx, f.account, group.ID, originalGroup.MessageID)
	if groupErr != nil || canonicalGroup.Forwarding.State != domain.ForwardingForwarded || canonicalGroup.Forwarding.Score == nil || *canonicalGroup.Forwarding.Score != 1 || canonicalGroup.AudioPTT == nil || *canonicalGroup.AudioPTT || canonicalGroup.FromJID == nil || *canonicalGroup.FromJID != authorA {
		t.Fatal("verified alias metadata was not preserved without changing author", groupErr)
	}
	missingAuthor := *originalGroup
	missingAuthor.FromJID = nil
	missingAuthor.Forwarding = domain.MessageForwarding{State: domain.ForwardingFrequentlyForwarded, Score: &score}
	if changed, groupErr := repos.Message.HydrateMessageForwarding(ctx, &missingAuthor); groupErr != nil || changed {
		t.Fatal("missing group author accepted", groupErr)
	}
	// The source chat is also the destination. Its parent is locked exactly
	// once, and concurrent replay can claim its transport once only.
	op := &ForwardOperation{ID: uuid.New(), AccountID: f.account, UserID: f.user, DeviceID: device, SourceChatID: chat.ID, SourceMessageID: stored.ID, RequestHash: "synthetic-fixed-request", SourceFingerprint: domain.MessageForwardFingerprint(stored), Forwarding: stored.Forwarding, Results: []ForwardTarget{{ChatID: chat.ID, JID: chat.JID, ProviderMessageID: uuid.NewString()}}}
	created, err := repos.Message.CreateForwardOperation(ctx, op)
	if err != nil || !created {
		t.Fatal("operation not prepared", err)
	}
	created, err = repos.Message.CreateForwardOperation(ctx, op)
	if err != nil || created {
		t.Fatal("replay created another operation", err)
	}
	var targetCount int
	if err = db.QueryRow(ctx, `SELECT COUNT(*) FROM message_forward_targets WHERE account_id=$1 AND operation_id=$2`, f.account, op.ID).Scan(&targetCount); err != nil || targetCount != 1 {
		t.Fatal("same-chat operation duplicated its target", err)
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	claimed := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := repos.Message.ClaimForwardTarget(ctx, f.account, op.ID, chat.ID)
			if err != nil {
				t.Error(err)
			}
			if ok {
				mu.Lock()
				claimed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if claimed != 1 {
		t.Fatalf("transport claimed %d times", claimed)
	}
	if err = repos.Message.FinishForwardTarget(ctx, f.account, op.ID, chat.ID, "uncertain", "forward_outcome_pending", "Synthetic timeout", false); err != nil {
		t.Fatal(err)
	}
	receipt, err := repos.Message.GetForwardOperation(ctx, f.account, f.user, op.ID)
	if err != nil || receipt.Complete || len(receipt.Results) != 1 || receipt.Results[0].State != "uncertain" || receipt.Results[0].CanRetry {
		t.Fatal("uncertain replay unsafe", err)
	}
	if ok, err := repos.Message.ClaimForwardTarget(ctx, f.account, op.ID, chat.ID); err != nil || ok {
		t.Fatal("uncertain operation re-sent", err)
	}
	if _, err := repos.Message.GetForwardOperation(ctx, uuid.New(), f.user, op.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("foreign receipt visible", err)
	}
	if _, err := repos.Message.GetForwardOperation(ctx, f.account, uuid.New(), op.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("other actor receipt visible", err)
	}
	op.RequestHash = "changed"
	if _, err := repos.Message.CreateForwardOperation(ctx, op); !errors.Is(err, ErrForwardOperationConflict) {
		t.Fatal("changed retry accepted", err)
	}
	// A later verified own echo resolves a lost result without sending again.
	outgoing := &domain.Message{AccountID: f.account, DeviceID: &device, ChatID: chat.ID, MessageID: op.Results[0].ProviderMessageID, Body: &body, MessageType: &kind, IsFromMe: true, Status: &status, Timestamp: time.Now().UTC(), Forwarding: stored.Forwarding}
	if err = repos.Message.Create(ctx, outgoing); err != nil {
		t.Fatal(err)
	}
	receipt, err = repos.Message.GetForwardOperation(ctx, f.account, f.user, op.ID)
	if err != nil || !receipt.Complete || receipt.Results[0].State != "sent" || receipt.Results[0].Message == nil {
		t.Fatal("own echo not reconciled", err)
	}
}
