package repository

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type ErosResultSetRepository struct{ db *pgxpool.Pool }

func (r *ErosResultSetRepository) Save(ctx context.Context, set *domain.ErosResultSet) (*domain.ErosResultSet, error) {
	if set.ID == uuid.Nil {
		set.ID = uuid.New()
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var filters []byte
	err = tx.QueryRow(ctx, `INSERT INTO eros_result_sets (id,account_id,user_id,conversation_id,run_id,entity_type,source_tool,fields,filters,returned_count,has_more,next_cursor)
		SELECT $1,$2,$3,r.conversation_id,$4,$5,$6,$7,$8::jsonb,$9,$10,$11 FROM eros_runs r
		WHERE r.id=$4 AND r.account_id=$2 AND r.user_id=$3
		ON CONFLICT (run_id,source_tool) DO UPDATE SET fields=EXCLUDED.fields,filters=EXCLUDED.filters,returned_count=EXCLUDED.returned_count,has_more=EXCLUDED.has_more,next_cursor=EXCLUDED.next_cursor
		RETURNING id,account_id,user_id,conversation_id,run_id,entity_type,source_tool,fields,filters,returned_count,has_more,next_cursor,created_at`,
		set.ID, set.AccountID, set.UserID, set.RunID, set.EntityType, set.SourceTool, set.Fields, normalizedJSONRaw(set.Filters, "{}"), len(set.EntityIDs), set.HasMore, set.NextCursor).Scan(
		&set.ID, &set.AccountID, &set.UserID, &set.ConversationID, &set.RunID, &set.EntityType, &set.SourceTool, &set.Fields, &filters, &set.ReturnedCount, &set.HasMore, &set.NextCursor, &set.CreatedAt)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM eros_result_set_items WHERE result_set_id=$1`, set.ID); err != nil {
		return nil, err
	}
	for position, id := range set.EntityIDs {
		if _, err = tx.Exec(ctx, `INSERT INTO eros_result_set_items(result_set_id,account_id,entity_id,position) VALUES($1,$2,$3,$4)`, set.ID, set.AccountID, id, position); err != nil {
			return nil, err
		}
	}
	set.Filters = json.RawMessage(filters)
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return set, nil
}

func (r *ErosResultSetRepository) Get(ctx context.Context, accountID, userID, setID uuid.UUID) (*domain.ErosResultSet, error) {
	var set domain.ErosResultSet
	var filters []byte
	err := r.db.QueryRow(ctx, `SELECT id,account_id,user_id,conversation_id,run_id,entity_type,source_tool,fields,filters,returned_count,has_more,next_cursor,created_at FROM eros_result_sets WHERE id=$1 AND account_id=$2 AND user_id=$3`, setID, accountID, userID).Scan(&set.ID, &set.AccountID, &set.UserID, &set.ConversationID, &set.RunID, &set.EntityType, &set.SourceTool, &set.Fields, &filters, &set.ReturnedCount, &set.HasMore, &set.NextCursor, &set.CreatedAt)
	if err != nil {
		return nil, err
	}
	set.Filters = json.RawMessage(filters)
	rows, err := r.db.Query(ctx, `SELECT entity_id FROM eros_result_set_items WHERE result_set_id=$1 AND account_id=$2 ORDER BY position`, set.ID, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		set.EntityIDs = append(set.EntityIDs, id)
	}
	return &set, rows.Err()
}

func (r *ErosResultSetRepository) ListRecent(ctx context.Context, accountID, userID, conversationID uuid.UUID, limit int) ([]domain.ErosResultSet, error) {
	if limit <= 0 || limit > 10 {
		limit = 5
	}
	rows, err := r.db.Query(ctx, `SELECT id,account_id,user_id,conversation_id,run_id,entity_type,source_tool,fields,filters,returned_count,has_more,next_cursor,created_at FROM eros_result_sets WHERE account_id=$1 AND user_id=$2 AND conversation_id=$3 ORDER BY created_at DESC LIMIT $4`, accountID, userID, conversationID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sets := []domain.ErosResultSet{}
	for rows.Next() {
		var set domain.ErosResultSet
		var filters []byte
		if err = rows.Scan(&set.ID, &set.AccountID, &set.UserID, &set.ConversationID, &set.RunID, &set.EntityType, &set.SourceTool, &set.Fields, &filters, &set.ReturnedCount, &set.HasMore, &set.NextCursor, &set.CreatedAt); err != nil {
			return nil, err
		}
		set.Filters = json.RawMessage(filters)
		sets = append(sets, set)
	}
	return sets, rows.Err()
}
