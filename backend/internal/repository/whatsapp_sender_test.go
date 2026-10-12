package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestWhatsAppSenderConfirmationContract(t *testing.T) {
	for _, tt := range []struct {
		name            string
		history         bool
		prior, selected string
		want            bool
	}{
		{"new chat", false, "", "51900000001", false},
		{"same number", true, "51900000001", "51900000001", false},
		{"different number", true, "51900000001", "51900000002", true},
		{"unknown history", true, "", "51900000002", true},
		{"unknown current sender", true, "51900000001", "", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := requiresSenderConfirmation(tt.history, tt.prior, tt.selected); got != tt.want {
				t.Fatalf("confirmation=%v, want %v", got, tt.want)
			}
		})
	}
	deviceID := uuid.New()
	history := WhatsAppSenderContext{HistoricalPhone: "51900000001", Revision: "revision"}
	valid := WhatsAppSenderConfirmation{DeviceID: deviceID, DevicePhone: "51900000002", HistoryRevision: history.Revision}
	if !senderConfirmationMatches(&valid, deviceID, "51900000002", history) {
		t.Fatal("explicit current confirmation rejected")
	}
	for _, confirmation := range []*WhatsAppSenderConfirmation{nil, {DeviceID: uuid.New(), DevicePhone: valid.DevicePhone, HistoryRevision: valid.HistoryRevision}, {DeviceID: deviceID, DevicePhone: "51900000003", HistoryRevision: valid.HistoryRevision}, {DeviceID: deviceID, DevicePhone: valid.DevicePhone, HistoryRevision: "old"}} {
		if senderConfirmationMatches(confirmation, deviceID, "51900000002", history) {
			t.Fatal("stale or unrelated confirmation accepted")
		}
	}
	if got := senderPhone("51900000001:12@s.whatsapp.net"); got != "51900000001" {
		t.Fatalf("sender phone=%q", got)
	}
}

func TestManualWhatsAppOpeningUsesContactBeforeChatLock(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	deviceID, chatID := uuid.New(), uuid.New()
	jid, phone := "51900000007@s.whatsapp.net", "51900000007"
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,phone,status) VALUES($1,$2,'Synthetic sender','51900000001','connected')`, deviceID, f.account)
	integrityExec(t, pool, `UPDATE contacts SET jid=$2,phone=$3 WHERE id=$1`, f.contact, jid, phone)
	integrityExec(t, pool, `INSERT INTO chats(id,account_id,device_id,contact_id,jid,channel_key) VALUES($1,$2,$3,$4,$5,'whatsapp_web')`, chatID, f.account, deviceID, f.contact, jid)
	// Model the first lock of inbound GetOrCreate's Contact→Chat CTE.
	inbound, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer inbound.Rollback(context.Background())
	var locked uuid.UUID
	if err = inbound.QueryRow(ctx, `SELECT id FROM contacts WHERE id=$1 FOR UPDATE`, f.contact).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, openErr := (&ChatRepository{db: pool}).OpenManualWhatsAppChat(ctx, f.account, deviceID, &f.contact, jid, phone, "", nil)
		done <- openErr
	}()
	waitIntegrityLock(t, pool, "contact")
	// A manual opener waiting for Contact must not already hold Chat. If the
	// order regresses this update forms the old cycle and PostgreSQL aborts it.
	if _, err = inbound.Exec(ctx, `UPDATE chats SET updated_at=updated_at WHERE id=$1`, chatID); err != nil {
		t.Fatalf("manual opening inverted ingestion lock order: %v", err)
	}
	if err = inbound.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatalf("manual open after inbound commit: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("manual opening failed to finish")
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM chats WHERE account_id=$1 AND jid=$2`, f.account, jid).Scan(&count); err != nil || count != 1 {
		t.Fatalf("concurrent open duplicated chat: %d %v", count, err)
	}
}

func TestManualWhatsAppSenderTransaction(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	repo := NewRepositories(pool).Chat
	ctx := context.Background()
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,phone,status) VALUES($1,$4,'A','51900000001','connected'),($2,$4,'B','51900000002','connected'),($3,$4,'C','51900000003','connected')`, a, b, c, f.account)
	chat, err := repo.OpenManualWhatsAppChat(ctx, f.account, a, nil, "51900000009@s.whatsapp.net", "51900000009", "Synthetic recipient", nil)
	if err != nil {
		t.Fatal(err)
	}
	if chat.ContactID == nil {
		t.Fatal("chat has no Contact parent")
	}
	firstID := chat.ID
	if _, err = repo.OpenManualWhatsAppChat(ctx, f.account, b, chat.ContactID, chat.JID, "51900000009", "", nil); !errors.Is(err, ErrWhatsAppSenderConfirmation) {
		t.Fatalf("unconfirmed switch: %v", err)
	}
	stored, err := repo.GetByID(ctx, chat.ID)
	if err != nil || stored.DeviceID == nil || *stored.DeviceID != a {
		t.Fatal("rejected switch changed sender")
	}
	history, err := repo.WhatsAppSenderContext(ctx, f.account, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	confirmation := &WhatsAppSenderConfirmation{DeviceID: b, DevicePhone: "51900000002", HistoryRevision: history.Revision}
	chat, err = repo.OpenManualWhatsAppChat(ctx, f.account, b, chat.ContactID, chat.JID, "51900000009", "", confirmation)
	if err != nil || chat.ID != firstID || chat.DeviceID == nil || *chat.DeviceID != b {
		t.Fatalf("confirmed switch did not reuse chat: %v", err)
	}
	stale := &WhatsAppSenderConfirmation{DeviceID: c, DevicePhone: "51900000003", HistoryRevision: history.Revision}
	if _, err = repo.OpenManualWhatsAppChat(ctx, f.account, c, chat.ContactID, chat.JID, "51900000009", "", stale); !errors.Is(err, ErrWhatsAppSenderConfirmation) {
		t.Fatalf("stale history accepted: %v", err)
	}
	if _, err = repo.OpenManualWhatsAppChat(ctx, uuid.New(), b, chat.ContactID, chat.JID, "51900000009", "", nil); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-account sender accepted: %v", err)
	}
	integrityExec(t, pool, `UPDATE devices SET status='disconnected' WHERE id=$1`, c)
	currentHistory, err := repo.WhatsAppSenderContext(ctx, f.account, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = repo.OpenManualWhatsAppChat(ctx, f.account, c, chat.ContactID, chat.JID, "51900000009", "", &WhatsAppSenderConfirmation{DeviceID: c, DevicePhone: "51900000003", HistoryRevision: currentHistory.Revision}); !errors.Is(err, ErrWhatsAppSenderUnavailable) {
		t.Fatalf("disconnected sender accepted: %v", err)
	}
	stored, err = repo.GetByID(ctx, chat.ID)
	if err != nil || stored.DeviceID == nil || *stored.DeviceID != b {
		t.Fatal("disconnected opening changed canonical sender")
	}
	if _, err = repo.OpenManualWhatsAppChat(ctx, f.account, c, nil, "51900000008@s.whatsapp.net", "51900000008", "Synthetic disconnected target", nil); !errors.Is(err, ErrWhatsAppSenderUnavailable) {
		t.Fatalf("disconnected sender created new chat: %v", err)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM chats WHERE account_id=$1 AND jid=$2`, f.account, chat.JID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate chat: count=%d err=%v", count, err)
	}
	if err = pool.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE account_id=$1 AND chat_id=$2`, f.account, chat.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("opening unexpectedly sent a message")
	}
}
