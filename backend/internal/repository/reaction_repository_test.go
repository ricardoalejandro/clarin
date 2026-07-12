package repository

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
)

type reactionRowStub struct {
	id        uuid.UUID
	createdAt time.Time
	err       error
}

func (r reactionRowStub) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*(dest[0].(*uuid.UUID)) = r.id
	*(dest[1].(*time.Time)) = r.createdAt
	return nil
}

type reactionDBStub struct {
	row       pgx.Row
	execTag   pgconn.CommandTag
	execErr   error
	querySQL  string
	queryArgs []any
	execSQL   string
	execArgs  []any
}

func (db *reactionDBStub) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	db.querySQL = sql
	db.queryArgs = args
	return db.row
}

func (db *reactionDBStub) Query(_ context.Context, _ string, _ ...any) (pgx.Rows, error) {
	return nil, nil
}

func (db *reactionDBStub) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.execSQL = sql
	db.execArgs = args
	return db.execTag, db.execErr
}

func TestReactionRepositoryUpsertReportsSemanticNoop(t *testing.T) {
	t.Parallel()

	db := &reactionDBStub{row: reactionRowStub{err: pgx.ErrNoRows}}
	repo := &ReactionRepository{db: db}
	reaction := testMessageReaction()

	changed, err := repo.Upsert(context.Background(), reaction)
	if err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}
	if changed {
		t.Fatal("Upsert() changed = true for a semantic no-op")
	}
	if !strings.Contains(db.querySQL, "ON CONFLICT (account_id, chat_id, target_message_id, sender_jid)") {
		t.Fatal("Upsert() is not scoped by account in its conflict key")
	}
	if !strings.Contains(db.querySQL, "EXCLUDED.timestamp >= message_reactions.timestamp") {
		t.Fatal("Upsert() does not reject stale reaction events")
	}
}

func TestReactionRepositoryUpsertReportsChange(t *testing.T) {
	t.Parallel()

	wantID := uuid.New()
	wantCreatedAt := time.Date(2026, time.July, 11, 6, 0, 0, 0, time.UTC)
	db := &reactionDBStub{row: reactionRowStub{id: wantID, createdAt: wantCreatedAt}}
	repo := &ReactionRepository{db: db}
	reaction := testMessageReaction()

	changed, err := repo.Upsert(context.Background(), reaction)
	if err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}
	if !changed {
		t.Fatal("Upsert() changed = false for an inserted/updated reaction")
	}
	if reaction.ID != wantID || !reaction.CreatedAt.Equal(wantCreatedAt) {
		t.Fatalf("Upsert() returned identity (%s, %s), want (%s, %s)", reaction.ID, reaction.CreatedAt, wantID, wantCreatedAt)
	}
}

func TestReactionRepositoryDeleteReportsChangeAndGuardsTimestamp(t *testing.T) {
	t.Parallel()

	db := &reactionDBStub{execTag: pgconn.NewCommandTag("DELETE 1")}
	repo := &ReactionRepository{db: db}
	accountID := uuid.New()
	chatID := uuid.New()
	removedAt := time.Date(2026, time.July, 11, 6, 5, 0, 0, time.UTC)

	changed, err := repo.Delete(context.Background(), accountID, chatID, "target-id", "51987654321:17@s.whatsapp.net", removedAt)
	if err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if !changed {
		t.Fatal("Delete() changed = false after deleting one row")
	}
	if !strings.Contains(db.execSQL, "account_id = $1") {
		t.Fatal("Delete() is not account-scoped")
	}
	if !strings.Contains(db.execSQL, "timestamp <= $5") {
		t.Fatal("Delete() can remove a newer reaction with a delayed event")
	}
	if len(db.execArgs) != 5 || db.execArgs[4] != removedAt {
		t.Fatalf("Delete() args = %#v, want removal timestamp as fifth argument", db.execArgs)
	}
}

func TestReactionRepositoryDeleteReportsSemanticNoop(t *testing.T) {
	t.Parallel()

	db := &reactionDBStub{execTag: pgconn.NewCommandTag("DELETE 0")}
	repo := &ReactionRepository{db: db}

	changed, err := repo.Delete(context.Background(), uuid.New(), uuid.New(), "target-id", "51987654321@s.whatsapp.net", time.Now())
	if err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if changed {
		t.Fatal("Delete() changed = true when no row was removed")
	}
}

func testMessageReaction() *domain.MessageReaction {
	return &domain.MessageReaction{
		AccountID:       uuid.New(),
		ChatID:          uuid.New(),
		TargetMessageID: "target-id",
		SenderJID:       "51987654321@s.whatsapp.net",
		Emoji:           "👍",
		IsFromMe:        true,
		Timestamp:       time.Date(2026, time.July, 11, 6, 0, 0, 0, time.UTC),
	}
}
