package repository

import (
    "context"

    "github.com/google/uuid"
    "github.com/jackc/pgx/v5/pgxpool"
)

type AITokenRepository struct {
    db *pgxpool.Pool
}

func (r *AITokenRepository) Save(ctx context.Context, accountID, userID uuid.UUID, apiKeyPreview, model string, inputTokens, outputTokens, totalTokens int) error {
    _, err := r.db.Exec(ctx, `
        INSERT INTO ai_token_logs (account_id, user_id, api_key_preview, model, input_tokens, output_tokens, total_tokens)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, accountID, userID, apiKeyPreview, model, inputTokens, outputTokens, totalTokens)
    return err
}

func (r *AITokenRepository) GetTotalTokensUsage(ctx context.Context, accountID uuid.UUID, userID uuid.UUID) (int, int, int, error) {
    var inTok, outTok, total int
    err := r.db.QueryRow(ctx, `
        SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(total_tokens), 0)
        FROM ai_token_logs
        WHERE account_id = $1 AND user_id = $2
    `, accountID, userID).Scan(&inTok, &outTok, &total)
    return inTok, outTok, total, err
}
