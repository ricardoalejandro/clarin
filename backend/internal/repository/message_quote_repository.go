package repository

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

const hydrateMessageQuoteSQL = `UPDATE messages SET
 quoted_message_id=COALESCE(NULLIF(quoted_message_id,''),$4),
 quoted_body=COALESCE(NULLIF(quoted_body,''),$5),
 quoted_sender=COALESCE(NULLIF(quoted_sender,''),$6),
 quoted_is_from_me=COALESCE(quoted_is_from_me,$7)
 WHERE account_id=$1 AND chat_id=$2 AND message_id=$3
 AND (quoted_message_id IS NULL OR quoted_message_id='' OR quoted_message_id=$4)
 AND ((COALESCE(quoted_message_id,'')='' AND $4::text IS NOT NULL)
   OR (COALESCE(quoted_body,'')='' AND $5::text IS NOT NULL)
   OR (COALESCE(quoted_sender,'')='' AND $6::text IS NOT NULL)
   OR (quoted_is_from_me IS NULL AND $7::boolean IS NOT NULL))`

func (r *MessageRepository) HydrateMissingQuote(ctx context.Context, accountID, chatID uuid.UUID, messageID string, quote domain.MessageQuote) (bool, error) {
	if quote.MessageID == nil || strings.TrimSpace(*quote.MessageID) == "" {
		return false, nil
	}
	command, err := r.db.Exec(ctx, hydrateMessageQuoteSQL, accountID, chatID, messageID, quote.MessageID, quote.Body, quote.Sender, quote.IsFromMe)
	return command.RowsAffected() > 0, err
}
