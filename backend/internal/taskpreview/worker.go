package taskpreview

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/storage"
)

type job struct {
	id, accountID, previewID, attachmentID uuid.UUID
	objectKey, filename                    string
	attempts                               int
}

func previewObjectKey(accountID, attachmentID uuid.UUID, hash string) string {
	return storage.PrivateObjectKey(accountID, "tasks", "previews", attachmentID.String(), hash+".pdf")
}

func Run(ctx context.Context, db *pgxpool.Pool, store *storage.Storage) error {
	if store == nil {
		return fmt.Errorf("task preview worker requires storage")
	}
	workerID := "task-preview-" + uuid.NewString()
	log.Printf("[Task Preview] worker %s started", workerID)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			for i := 0; i < 2; i++ {
				claimed, err := claim(ctx, db, workerID)
				if err != nil {
					log.Printf("[Task Preview] claim failed: %v", err)
					break
				}
				if claimed == nil {
					break
				}
				if err := process(ctx, db, store, *claimed); err != nil {
					log.Printf("[Task Preview] job %s failed: %v", claimed.id, err)
					_ = fail(ctx, db, *claimed, err)
				}
			}
		}
	}
}

func claim(ctx context.Context, db *pgxpool.Pool, workerID string) (*job, error) {
	item := &job{}
	err := db.QueryRow(ctx, `WITH stale AS (
		UPDATE task_attachment_preview_jobs SET status='pending',locked_at=NULL,locked_by=NULL,available_at=NOW(),updated_at=NOW()
		WHERE status='processing' AND locked_at<NOW()-INTERVAL '10 minutes'
	), candidate AS (
		SELECT j.id FROM task_attachment_preview_jobs j
		JOIN task_attachment_previews p ON p.id=j.preview_id AND p.account_id=j.account_id
		JOIN task_attachments ta ON ta.account_id=p.account_id AND ta.id=p.attachment_id
		JOIN media_assets ma ON ma.account_id=ta.account_id AND ma.id=ta.media_asset_id AND ma.status='active'
		WHERE j.status IN ('pending','failed') AND j.available_at<=NOW() AND j.attempts<5
		ORDER BY j.available_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
	), claimed AS (
		UPDATE task_attachment_preview_jobs j SET status='processing',attempts=attempts+1,locked_at=NOW(),locked_by=$1,updated_at=NOW()
		FROM candidate WHERE j.id=candidate.id RETURNING j.id,j.account_id,j.preview_id,j.attempts
	) SELECT c.id,c.account_id,c.preview_id,p.attachment_id,ma.object_key,ma.filename,c.attempts
	FROM claimed c JOIN task_attachment_previews p ON p.id=c.preview_id AND p.account_id=c.account_id
	JOIN task_attachments ta ON ta.account_id=p.account_id AND ta.id=p.attachment_id
	JOIN media_assets ma ON ma.account_id=ta.account_id AND ma.id=ta.media_asset_id AND ma.status='active'`, workerID).Scan(&item.id, &item.accountID, &item.previewID, &item.attachmentID, &item.objectKey, &item.filename, &item.attempts)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	_, _ = db.Exec(ctx, `UPDATE task_attachment_previews SET status='processing',error='',updated_at=NOW(),version=version+1 WHERE id=$1 AND account_id=$2`, item.previewID, item.accountID)
	return item, nil
}

func process(parent context.Context, db *pgxpool.Pool, store *storage.Storage, item job) error {
	ctx, cancel := context.WithTimeout(parent, 50*time.Second)
	defer cancel()
	data, err := store.GetFile(ctx, item.objectKey)
	if err != nil {
		return err
	}
	tempDir, err := os.MkdirTemp("", "clarin-task-preview-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tempDir)
	if err := os.Chmod(tempDir, 0700); err != nil {
		return err
	}
	cleanName := filepath.Base(item.filename)
	if cleanName == "." || cleanName == "" {
		cleanName = "document.docx"
	}
	input := filepath.Join(tempDir, cleanName)
	if err := os.WriteFile(input, data, 0600); err != nil {
		return err
	}
	profile := filepath.Join(tempDir, "profile")
	if err := os.Mkdir(profile, 0700); err != nil {
		return err
	}
	command := exec.CommandContext(ctx, "libreoffice", "--headless", "--nologo", "--nodefault", "--nolockcheck", "--nofirststartwizard", "-env:UserInstallation=file://"+profile, "--convert-to", "pdf", "--outdir", tempDir, input)
	command.Env = []string{"HOME=" + tempDir, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"}
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("libreoffice: %w (%s)", err, strings.TrimSpace(string(output)))
	}
	pdfPath := filepath.Join(tempDir, strings.TrimSuffix(cleanName, filepath.Ext(cleanName))+".pdf")
	pdf, err := os.ReadFile(pdfPath)
	if err != nil {
		return fmt.Errorf("converted PDF missing: %w", err)
	}
	if len(pdf) < 5 || string(pdf[:5]) != "%PDF-" {
		return fmt.Errorf("invalid converted PDF")
	}
	digest := sha256.Sum256(pdf)
	hash := hex.EncodeToString(digest[:])
	objectKey := previewObjectKey(item.accountID, item.attachmentID, hash)
	if _, err := store.UploadObject(ctx, objectKey, pdf, "application/pdf"); err != nil {
		return err
	}
	keepUploadedObject := false
	defer func() {
		if !keepUploadedObject {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cleanupCancel()
			_ = store.DeleteFile(cleanupCtx, objectKey)
		}
	}()
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	assetID := uuid.New()
	var canonicalID uuid.UUID
	var canonicalKey string
	err = tx.QueryRow(ctx, `INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,created_at,updated_at) VALUES($1,$2,$3,$4,'document','application/pdf',$5,$6,'active',NOW(),NOW()) ON CONFLICT(account_id,content_hash) DO UPDATE SET status='active',deleted_at=NULL,updated_at=NOW() RETURNING id,object_key`, assetID, item.accountID, hash, objectKey, strings.TrimSuffix(cleanName, filepath.Ext(cleanName))+".pdf", len(pdf)).Scan(&canonicalID, &canonicalKey)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source,status,created_at,updated_at) VALUES($1,$2,'document','application/pdf',$3,$4,'task_preview','active',NOW(),NOW()) ON CONFLICT(account_id,object_key) DO UPDATE SET status='active',deleted_at=NULL,updated_at=NOW()`, item.accountID, canonicalKey, filepath.Base(canonicalKey), len(pdf)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_attachment_previews SET derivative_asset_id=$2,status='ready',error='',updated_at=NOW(),version=version+1 WHERE id=$1 AND account_id=$3`, item.previewID, canonicalID, item.accountID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_attachment_preview_jobs SET status='complete',locked_at=NULL,locked_by=NULL,last_error='',updated_at=NOW() WHERE id=$1`, item.id); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if canonicalKey == objectKey {
		keepUploadedObject = true
	} else {
		_ = store.DeleteFile(ctx, objectKey)
	}
	return nil
}

func fail(ctx context.Context, db *pgxpool.Pool, item job, cause error) error {
	message := cause.Error()
	if len(message) > 1500 {
		message = message[:1500]
	}
	terminal := item.attempts >= 5
	status := "pending"
	previewStatus := "pending"
	if terminal {
		status = "failed"
		previewStatus = "failed"
	}
	delay := time.Duration(item.attempts*item.attempts) * time.Minute
	_, err := db.Exec(ctx, `WITH updated AS (UPDATE task_attachment_preview_jobs SET status=$2,last_error=$3,available_at=NOW()+$4::interval,locked_at=NULL,locked_by=NULL,updated_at=NOW() WHERE id=$1 AND account_id=$6 RETURNING preview_id,account_id) UPDATE task_attachment_previews p SET status=$5,error=$3,updated_at=NOW(),version=version+1 FROM updated WHERE p.id=updated.preview_id AND p.account_id=updated.account_id`, item.id, status, message, delay.String(), previewStatus, item.accountID)
	return err
}
