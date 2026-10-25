package repository

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrForwardOperationConflict = errors.New("forward operation conflicts")
var ErrForwardSourceChanged = errors.New("forward source changed")

type ForwardTarget struct {
	ChatID            uuid.UUID       `json:"chat_id"`
	State             string          `json:"state"`
	Code              string          `json:"code,omitempty"`
	Error             string          `json:"error,omitempty"`
	CanRetry          bool            `json:"can_retry"`
	Message           *domain.Message `json:"message,omitempty"`
	JID               string          `json:"-"`
	ProviderMessageID string          `json:"-"`
}
type ForwardOperation struct {
	ID                uuid.UUID                `json:"operation_id"`
	Complete          bool                     `json:"complete"`
	Results           []ForwardTarget          `json:"results"`
	Forwarding        domain.MessageForwarding `json:"forwarding"`
	AccountID         uuid.UUID                `json:"-"`
	UserID            uuid.UUID                `json:"-"`
	DeviceID          uuid.UUID                `json:"-"`
	SourceChatID      uuid.UUID                `json:"-"`
	SourceMessageID   uuid.UUID                `json:"-"`
	RequestHash       string                   `json:"-"`
	SourceFingerprint string                   `json:"-"`
}

func (r *MessageRepository) CreateForwardOperation(ctx context.Context, op *ForwardOperation) (bool, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	// Lock parents before content, in the same order used by message mutations.
	ids := []uuid.UUID{op.SourceChatID}
	unique := map[uuid.UUID]bool{op.SourceChatID: true}
	for _, target := range op.Results {
		if !unique[target.ChatID] {
			ids = append(ids, target.ChatID)
			unique[target.ChatID] = true
		}
	}
	rows, err := tx.Query(ctx, `SELECT id FROM chats WHERE account_id=$1 AND device_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE`, op.AccountID, op.DeviceID, ids)
	if err != nil {
		return false, err
	}
	count := 0
	for rows.Next() {
		count++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	if count != len(ids) {
		return false, pgx.ErrNoRows
	}
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT to_jsonb(m) FROM messages m WHERE account_id=$1 AND chat_id=$2 AND id=$3 AND device_id=$4 FOR SHARE`, op.AccountID, op.SourceChatID, op.SourceMessageID, op.DeviceID).Scan(&raw)
	if err != nil {
		return false, err
	}
	var source domain.Message
	if err = json.Unmarshal(raw, &source); err != nil {
		return false, err
	}
	if domain.MessageForwardFingerprint(&source) != op.SourceFingerprint {
		return false, ErrForwardSourceChanged
	}
	inserted, err := tx.Exec(ctx, `INSERT INTO message_forward_operations(account_id,id,user_id,device_id,source_chat_id,source_message_id,request_hash,source_fingerprint,source_forwarding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(account_id,id) DO NOTHING`, op.AccountID, op.ID, op.UserID, op.DeviceID, op.SourceChatID, op.SourceMessageID, op.RequestHash, op.SourceFingerprint, op.Forwarding)
	if err != nil {
		return false, err
	}
	if inserted.RowsAffected() == 0 {
		var actor uuid.UUID
		var hash string
		if err = tx.QueryRow(ctx, `SELECT user_id,request_hash FROM message_forward_operations WHERE account_id=$1 AND id=$2`, op.AccountID, op.ID).Scan(&actor, &hash); err != nil {
			return false, err
		}
		if actor != op.UserID || hash != op.RequestHash {
			return false, ErrForwardOperationConflict
		}
		return false, tx.Commit(ctx)
	}
	for _, target := range op.Results {
		result, insertErr := tx.Exec(ctx, `INSERT INTO message_forward_targets(account_id,operation_id,chat_id,destination_jid,provider_message_id) SELECT $1,$2,c.id,c.jid,$5::text FROM chats c WHERE c.account_id=$1 AND c.device_id=$3 AND c.id=$4 AND c.jid=$6::text`, op.AccountID, op.ID, op.DeviceID, target.ChatID, target.ProviderMessageID, target.JID)
		if insertErr != nil {
			return false, insertErr
		}
		if result.RowsAffected() != 1 {
			return false, ErrForwardSourceChanged
		}
	}
	return true, tx.Commit(ctx)
}

func (r *MessageRepository) GetForwardOperation(ctx context.Context, accountID, userID, operationID uuid.UUID) (*ForwardOperation, error) {
	op := &ForwardOperation{ID: operationID, AccountID: accountID, UserID: userID, Results: []ForwardTarget{}, Complete: true}
	err := r.db.QueryRow(ctx, `SELECT device_id,source_chat_id,source_message_id,request_hash,source_fingerprint,source_forwarding FROM message_forward_operations WHERE account_id=$1 AND user_id=$2 AND id=$3`, accountID, userID, operationID).Scan(&op.DeviceID, &op.SourceChatID, &op.SourceMessageID, &op.RequestHash, &op.SourceFingerprint, &op.Forwarding)
	if err != nil {
		return nil, err
	}
	// A crashed request cannot be replayed: sending may already have reached WA.
	_, err = r.db.Exec(ctx, `UPDATE message_forward_targets SET state=CASE WHEN state='pending' THEN 'failed' ELSE 'uncertain' END,code=CASE WHEN state='pending' THEN 'forward_not_started' ELSE 'forward_outcome_pending' END,safe_error=CASE WHEN state='pending' THEN 'El envío no llegó a iniciarse.' ELSE 'WhatsApp aún no confirmó este envío. No se enviará otra copia.' END,can_retry=(state='pending'),updated_at=NOW() WHERE account_id=$1 AND operation_id=$2 AND state IN ('pending','sending') AND updated_at<NOW()-INTERVAL '5 minutes'`, accountID, operationID)
	if err != nil {
		return nil, err
	}
	rows, err := r.db.Query(ctx, `SELECT chat_id,destination_jid,provider_message_id,state,code,safe_error,can_retry FROM message_forward_targets WHERE account_id=$1 AND operation_id=$2 ORDER BY chat_id`, accountID, operationID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var target ForwardTarget
		if err = rows.Scan(&target.ChatID, &target.JID, &target.ProviderMessageID, &target.State, &target.Code, &target.Error, &target.CanRetry); err != nil {
			rows.Close()
			return nil, err
		}
		op.Results = append(op.Results, target)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range op.Results {
		target := &op.Results[i]
		if target.State == "sending" || target.State == "uncertain" || target.State == "sent" {
			message, findErr := r.GetByReference(ctx, accountID, target.ChatID, target.ProviderMessageID)
			if findErr == nil && message.DeviceID != nil && *message.DeviceID == op.DeviceID && message.IsFromMe {
				target.Message = message
				target.State = "sent"
				target.Code = ""
				target.Error = ""
				target.CanRetry = false
				_, err = r.db.Exec(ctx, `UPDATE message_forward_targets SET state='sent',code='',safe_error='',can_retry=FALSE,updated_at=NOW() WHERE account_id=$1 AND operation_id=$2 AND chat_id=$3 AND state IN ('sending','uncertain')`, accountID, operationID, target.ChatID)
				if err != nil {
					return nil, err
				}
			}
		}
		if target.State != "sent" && target.State != "failed" {
			op.Complete = false
		}
	}
	return op, nil
}

func (r *MessageRepository) ClaimForwardTarget(ctx context.Context, accountID, operationID, chatID uuid.UUID) (bool, error) {
	result, err := r.db.Exec(ctx, `UPDATE message_forward_targets SET state='sending',started_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND operation_id=$2 AND chat_id=$3 AND state='pending'`, accountID, operationID, chatID)
	return err == nil && result.RowsAffected() == 1, err
}

func (r *MessageRepository) FinishForwardTarget(ctx context.Context, accountID, operationID, chatID uuid.UUID, state, code, safeError string, canRetry bool) error {
	_, err := r.db.Exec(ctx, `UPDATE message_forward_targets SET state=$4::text,code=$5::text,safe_error=$6::text,can_retry=$7,updated_at=NOW() WHERE account_id=$1 AND operation_id=$2 AND chat_id=$3 AND state='sending'`, accountID, operationID, chatID, state, code, safeError, canRetry)
	return err
}
