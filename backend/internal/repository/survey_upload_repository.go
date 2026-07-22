package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrSurveyUploadInvalid = errors.New("survey upload is invalid or no longer available")

type SurveyFileUpload struct {
	ID               uuid.UUID
	AccountID        uuid.UUID
	SurveyID         uuid.UUID
	QuestionID       uuid.UUID
	RecipientID      *uuid.UUID
	RespondentToken  string
	AccessToken      uuid.UUID
	MediaAssetID     uuid.UUID
	ObjectKey        string
	OriginalFilename string
	ContentType      string
	SizeBytes        int64
	Status           string
	ExpiresAt        time.Time
}

type PrepareSurveyFileUploadInput struct {
	AccountID        uuid.UUID
	SurveyID         uuid.UUID
	QuestionID       uuid.UUID
	RecipientID      *uuid.UUID
	RespondentToken  string
	ObjectKey        string
	OriginalFilename string
	ContentType      string
	SizeBytes        int64
	ContentHash      string
	ExpiresAt        time.Time
}

// PrepareSurveyFileUpload writes the durable inventory before MinIO is
// touched. A process interruption can therefore only leave a discoverable,
// expiring object candidate—not an invisible active-account orphan.
func (r *SurveyRepository) PrepareSurveyFileUpload(ctx context.Context, input PrepareSurveyFileUploadInput) (*SurveyFileUpload, error) {
	upload := &SurveyFileUpload{
		ID:               uuid.New(),
		AccountID:        input.AccountID,
		SurveyID:         input.SurveyID,
		QuestionID:       input.QuestionID,
		RecipientID:      input.RecipientID,
		RespondentToken:  input.RespondentToken,
		AccessToken:      uuid.New(),
		MediaAssetID:     uuid.New(),
		ObjectKey:        input.ObjectKey,
		OriginalFilename: input.OriginalFilename,
		ContentType:      input.ContentType,
		SizeBytes:        input.SizeBytes,
		Status:           "staged",
		ExpiresAt:        input.ExpiresAt,
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		INSERT INTO media_assets (
			id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,updated_at
		) VALUES ($1,$2,$3,$4,'document',$5,$6,$7,'survey_upload_staged',NOW())
	`, upload.MediaAssetID, input.AccountID, "survey-upload:"+upload.ID.String()+":"+input.ContentHash,
		input.ObjectKey, input.ContentType, input.OriginalFilename, input.SizeBytes); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO storage_objects (
			account_id,object_key,media_type,content_type,filename,size_bytes,source,status,next_delete_at,updated_at
		) VALUES ($1,$2,'document',$3,$4,$5,'survey_upload','survey_upload_staged',$6,NOW())
	`, input.AccountID, input.ObjectKey, input.ContentType, input.OriginalFilename, input.SizeBytes, input.ExpiresAt); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO survey_file_uploads (
			id,account_id,survey_id,question_id,recipient_id,respondent_token,access_token,
			media_asset_id,object_key,original_filename,content_type,size_bytes,status,expires_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'staged',$13)
	`, upload.ID, input.AccountID, input.SurveyID, input.QuestionID, input.RecipientID,
		input.RespondentToken, upload.AccessToken, upload.MediaAssetID, input.ObjectKey,
		input.OriginalFilename, input.ContentType, input.SizeBytes, input.ExpiresAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return upload, nil
}

func (r *SurveyRepository) MarkSurveyFileUploadFailed(ctx context.Context, accountID, uploadID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var objectKey string
	var mediaAssetID uuid.UUID
	if err := tx.QueryRow(ctx, `
		UPDATE survey_file_uploads SET expires_at=NOW(),updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND status='staged'
		RETURNING object_key,media_asset_id
	`, accountID, uploadID).Scan(&objectKey, &mediaAssetID); err != nil {
		return err
	}
	_, _ = tx.Exec(ctx, `UPDATE storage_objects SET next_delete_at=NOW(),updated_at=NOW()
		WHERE account_id=$1 AND object_key=$2 AND source='survey_upload'`, accountID, objectKey)
	_, _ = tx.Exec(ctx, `UPDATE media_assets SET status='survey_upload_staged',updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, mediaAssetID)
	return tx.Commit(ctx)
}

func (r *SurveyRepository) GetSurveyFileUploadByAccessToken(ctx context.Context, accessToken uuid.UUID) (*SurveyFileUpload, error) {
	upload := &SurveyFileUpload{}
	err := r.db.QueryRow(ctx, `
		SELECT id,account_id,survey_id,question_id,recipient_id,respondent_token,access_token,
			media_asset_id,object_key,original_filename,content_type,size_bytes,status,expires_at
		FROM survey_file_uploads
		WHERE access_token=$1 AND status IN ('staged','attached')
		  AND (status='attached' OR expires_at>NOW())
	`, accessToken).Scan(&upload.ID, &upload.AccountID, &upload.SurveyID, &upload.QuestionID,
		&upload.RecipientID, &upload.RespondentToken, &upload.AccessToken, &upload.MediaAssetID,
		&upload.ObjectKey, &upload.OriginalFilename, &upload.ContentType, &upload.SizeBytes,
		&upload.Status, &upload.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return upload, nil
}

func (r *SurveyRepository) ClaimExpiredSurveyFileUploads(ctx context.Context, limit int) ([]SurveyFileUpload, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		WITH due AS (
			SELECT id FROM survey_file_uploads
			WHERE status IN ('staged','deleting') AND expires_at<=NOW()
			ORDER BY expires_at,id
			FOR UPDATE SKIP LOCKED
			LIMIT $1
		)
		UPDATE survey_file_uploads u SET status='deleting',updated_at=NOW()
		FROM due WHERE u.id=due.id
		RETURNING u.id,u.account_id,u.media_asset_id,u.object_key
	`, limit)
	if err != nil {
		return nil, err
	}
	items := make([]SurveyFileUpload, 0)
	for rows.Next() {
		var item SurveyFileUpload
		if err := rows.Scan(&item.ID, &item.AccountID, &item.MediaAssetID, &item.ObjectKey); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for _, item := range items {
		_, _ = tx.Exec(ctx, `UPDATE storage_objects SET status='survey_upload_deleting',updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND source='survey_upload'`, item.AccountID, item.ObjectKey)
		_, _ = tx.Exec(ctx, `UPDATE media_assets SET status='survey_upload_deleting',updated_at=NOW()
			WHERE account_id=$1 AND id=$2`, item.AccountID, item.MediaAssetID)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return items, nil
}

func (r *SurveyRepository) FinishSurveyFileUploadCleanup(ctx context.Context, item SurveyFileUpload, deleteErr error) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if deleteErr != nil {
		nextAttempt := time.Now().Add(15 * time.Minute)
		_, err = tx.Exec(ctx, `UPDATE survey_file_uploads SET status='staged',expires_at=$3,updated_at=NOW()
			WHERE account_id=$1 AND id=$2 AND status='deleting'`, item.AccountID, item.ID, nextAttempt)
		if err != nil {
			return err
		}
		_, _ = tx.Exec(ctx, `UPDATE storage_objects SET status='survey_upload_staged',next_delete_at=$3,
			delete_attempts=delete_attempts+1,delete_error=$4,updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND source='survey_upload'`, item.AccountID, item.ObjectKey, nextAttempt, deleteErr.Error())
		_, _ = tx.Exec(ctx, `UPDATE media_assets SET status='survey_upload_staged',updated_at=NOW()
			WHERE account_id=$1 AND id=$2`, item.AccountID, item.MediaAssetID)
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `UPDATE survey_file_uploads SET status='deleted',updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND status='deleting'`, item.AccountID, item.ID); err != nil {
		return err
	}
	_, _ = tx.Exec(ctx, `UPDATE storage_objects SET status='deleted',deleted_at=NOW(),next_delete_at=NULL,
		delete_error='',updated_at=NOW() WHERE account_id=$1 AND object_key=$2 AND source='survey_upload'`, item.AccountID, item.ObjectKey)
	_, _ = tx.Exec(ctx, `UPDATE media_assets SET status='deleted',deleted_at=NOW(),updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, item.AccountID, item.MediaAssetID)
	return tx.Commit(ctx)
}

func scanSurveyUploadForAttachment(ctx context.Context, tx pgx.Tx, respAccountID, respSurveyID, questionID, uploadID uuid.UUID, respondentToken string, recipientID *uuid.UUID) (uuid.UUID, string, uuid.UUID, error) {
	var accessToken uuid.UUID
	var objectKey string
	var mediaAssetID uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT access_token,object_key,media_asset_id
		FROM survey_file_uploads
		WHERE account_id=$1 AND survey_id=$2 AND question_id=$3 AND id=$4
		  AND respondent_token=$5 AND status='staged' AND expires_at>NOW()
		  AND (($6::uuid IS NULL AND recipient_id IS NULL) OR recipient_id=$6)
		FOR UPDATE
	`, respAccountID, respSurveyID, questionID, uploadID, respondentToken, recipientID).Scan(&accessToken, &objectKey, &mediaAssetID)
	if err == pgx.ErrNoRows {
		return uuid.Nil, "", uuid.Nil, ErrSurveyUploadInvalid
	}
	return accessToken, objectKey, mediaAssetID, err
}
