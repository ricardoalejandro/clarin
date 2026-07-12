package repository

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
)

type webhookTestRow struct {
	scan func(dest ...any) error
}

func (r webhookTestRow) Scan(dest ...any) error {
	return r.scan(dest...)
}

type webhookTestDB struct {
	queryRowSQL  string
	queryRowArgs []any
	row          pgx.Row
	execSQL      string
	execArgs     []any
	execErr      error
}

func (db *webhookTestDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.queryRowSQL = sql
	db.queryRowArgs = args
	return db.row
}

func (db *webhookTestDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query call")
}

func (db *webhookTestDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execSQL = sql
	db.execArgs = args
	return pgconn.CommandTag{}, db.execErr
}

func TestClaimWebhookEventClaimsBeforeProcessing(t *testing.T) {
	claimedID := uuid.New()
	receivedAt := time.Unix(123, 0)
	db := &webhookTestDB{
		row: webhookTestRow{scan: func(dest ...any) error {
			*(dest[0].(*uuid.UUID)) = claimedID
			*(dest[1].(*time.Time)) = receivedAt
			return nil
		}},
	}
	repo := &WhatsAppAPIRepository{db: db}
	event := &domain.WhatsAppWebhookEvent{
		PhoneNumberID: "phone-id",
		EventID:       "wamid.123",
		EventType:     "message_received",
	}

	claimed, err := repo.ClaimWebhookEvent(context.Background(), event)
	if err != nil {
		t.Fatalf("claim failed: %v", err)
	}
	if !claimed {
		t.Fatal("new event was not claimed")
	}
	if event.ID != claimedID || !event.ReceivedAt.Equal(receivedAt) {
		t.Fatalf("claim metadata not returned: id=%s received_at=%s", event.ID, event.ReceivedAt)
	}
	if !strings.Contains(db.queryRowSQL, "ON CONFLICT (event_id) DO NOTHING") || !strings.Contains(db.queryRowSQL, "RETURNING id, received_at") {
		t.Fatalf("claim query is not atomic: %s", db.queryRowSQL)
	}
	if len(db.queryRowArgs) < 4 || db.queryRowArgs[3] != event.EventID {
		t.Fatalf("provider event ID was not used as the idempotency key: %#v", db.queryRowArgs)
	}
}

func TestClaimWebhookEventRejectsReplay(t *testing.T) {
	db := &webhookTestDB{
		row: webhookTestRow{scan: func(...any) error { return pgx.ErrNoRows }},
	}
	repo := &WhatsAppAPIRepository{db: db}
	claimed, err := repo.ClaimWebhookEvent(context.Background(), &domain.WhatsAppWebhookEvent{
		EventID:   "wamid.replayed",
		EventType: "message_received",
	})
	if err != nil {
		t.Fatalf("replay check failed: %v", err)
	}
	if claimed {
		t.Fatal("replayed event must not be processed again")
	}
}

func TestCompleteWebhookEventRecordsOutcome(t *testing.T) {
	db := &webhookTestDB{}
	repo := &WhatsAppAPIRepository{db: db}
	eventID := uuid.New()
	errorMessage := "processing failed"

	if err := repo.CompleteWebhookEvent(context.Background(), eventID, false, &errorMessage); err != nil {
		t.Fatalf("complete failed: %v", err)
	}
	if !strings.Contains(db.execSQL, "SET processed = $2, error_message = $3") {
		t.Fatalf("completion query does not persist outcome: %s", db.execSQL)
	}
	if len(db.execArgs) != 3 || db.execArgs[0] != eventID || db.execArgs[1] != false || db.execArgs[2] != &errorMessage {
		t.Fatalf("unexpected completion arguments: %#v", db.execArgs)
	}
}
