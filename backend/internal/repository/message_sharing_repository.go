package repository

import (
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// Own synchronized echoes may win insertion. The durable reservation exists
// before calling WA, so the first row already inherits local sharing policy.
// A PN/LID echo may land in another chat before identity reconciliation. The
// account-unique provider reservation can only restrict that own-device echo;
// it does not relocate identity or establish delivery to the selected chat.
func applyForwardOperationSharingLimitsTx(ctx context.Context, tx pgx.Tx, message *domain.Message) error {
	if message == nil || !message.IsFromMe || message.DeviceID == nil {
		return nil
	}
	var limits *domain.MessageSharingLimits
	err := tx.QueryRow(ctx, `SELECT op.sharing_limits FROM message_forward_operations op JOIN message_forward_targets target ON target.account_id=op.account_id AND target.operation_id=op.id WHERE op.account_id=$1 AND op.device_id=$2 AND target.provider_message_id=$3 LIMIT 1`, message.AccountID, *message.DeviceID, message.MessageID).Scan(&limits)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	message.SharingLimits = domain.MergeMessageSharingLimits(message.SharingLimits, limits)
	return nil
}

// MergeMessageSharingLimits never widens inherited restrictions. Every lookup
// binds account, real device, destination chat and the reserved provider ID.
func (r *MessageRepository) MergeMessageSharingLimits(ctx context.Context, accountID, deviceID, chatID uuid.UUID, providerID string, limits domain.MessageSharingLimits) (*domain.Message, error) {
	if !limits.Valid() {
		return nil, fmt.Errorf("invalid message sharing limits")
	}
	result, err := r.db.Exec(ctx, `UPDATE messages SET sharing_limits=clarin_min_message_sharing_limits(sharing_limits,$5::jsonb) WHERE account_id=$1 AND device_id=$2 AND chat_id=$3 AND message_id=$4 AND is_from_me`, accountID, deviceID, chatID, providerID, limits)
	if err != nil {
		return nil, err
	}
	if result.RowsAffected() != 1 {
		return nil, pgx.ErrNoRows
	}
	message, err := r.GetByReference(ctx, accountID, chatID, providerID)
	if err != nil {
		return nil, err
	}
	if message.DeviceID == nil || *message.DeviceID != deviceID || !message.IsFromMe {
		return nil, pgx.ErrNoRows
	}
	return message, nil
}
