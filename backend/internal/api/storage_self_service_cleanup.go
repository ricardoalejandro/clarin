package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
	"github.com/naperu/clarin/internal/domain"
)

type storageCleanupItem struct {
	ObjectKey       string `json:"object_key"`
	Filename        string `json:"filename"`
	SizeBytes       int64  `json:"size_bytes"`
	Eligible        bool   `json:"eligible"`
	Reason          string `json:"reason"`
	ReferencesCount int    `json:"references_count"`
	Fingerprint     string `json:"fingerprint,omitempty"`
}
type storageCleanupItemResult struct {
	ObjectKey string `json:"object_key"`
	Filename  string `json:"filename"`
	Status    string `json:"status"`
	Reason    string `json:"reason"`
}
type storageCleanupResult struct {
	Success       bool                       `json:"success"`
	OperationID   uuid.UUID                  `json:"operation_id"`
	Action        string                     `json:"action"`
	Status        string                     `json:"status"`
	Items         []storageCleanupItemResult `json:"items"`
	FreedBytes    int64                      `json:"freed_bytes"`
	RetainedBytes int64                      `json:"retained_bytes"`
	FilesCount    int                        `json:"files_count"`
	CreatedAt     time.Time                  `json:"created_at"`
	CompletedAt   time.Time                  `json:"completed_at"`
}

func storageSelfServiceCleanSelection(accountID uuid.UUID, keys []string) ([]string, error) {
	if len(keys) < 1 || len(keys) > 100 {
		return nil, fmt.Errorf("Selecciona entre 1 y 100 archivos.")
	}
	seen := map[string]bool{}
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if !storageSelfServiceValidKey(accountID, key) {
			return nil, fmt.Errorf("La selección contiene archivos no disponibles.")
		}
		if !seen[key] {
			seen[key] = true
			result = append(result, key)
		}
	}
	sort.Strings(result)
	return result, nil
}
func storageSelfServiceEligibility(file storageSelfServiceFile, action string) (bool, string) {
	switch action {
	case "trash":
		if file.Status == "active" && file.CanRemove {
			return true, fmt.Sprintf("Se retirará el adjunto de %d mensaje(s). El texto se conserva y podrás recuperarlo desde la papelera.", file.ReferencesCount)
		}
	case "restore":
		if file.Status == "trash" && file.CanRestore {
			return true, "Se recuperarán los adjuntos en los mensajes que todavía existan."
		}
	case "purge":
		if file.Status == "trash" && file.CanPurge {
			return true, "Se eliminará definitivamente. Esta acción no se puede deshacer."
		}
	}
	if file.BlockedReason != "" {
		return false, file.BlockedReason
	}
	return false, "El archivo no admite esta operación."
}
func (s *Server) handleStorageCleanupPreview(c *fiber.Ctx) error {
	if s.storage == nil {
		return storageSelfServiceError(c, 503, "storage_unavailable", "El almacenamiento no está disponible.")
	}
	ctx, cancel := context.WithTimeout(c.Context(), storageSelfServiceCatalogTimeout)
	defer cancel()
	accountID, actorID, claims, err := s.storageSelfServiceActor(c, ctx)
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return storageSelfServiceError(c, 503, "storage_scan_failed", "No se pudo verificar la selección. No se ha modificado ningún archivo.")
	}
	if err != nil || !storageSelfServiceHasPermission(claims, domain.PermSettings) {
		return storageSelfServiceError(c, 403, "storage_forbidden", "No tienes permiso para gestionar el almacenamiento.")
	}
	var req struct {
		ObjectKeys []string `json:"object_keys"`
		Action     string   `json:"action"`
	}
	if err := c.BodyParser(&req); err != nil {
		return storageSelfServiceError(c, 400, "invalid_selection", "Revisa los archivos seleccionados.")
	}
	if req.Action != "trash" && req.Action != "restore" && req.Action != "purge" {
		return storageSelfServiceError(c, 400, "invalid_action", "La operación no es válida.")
	}
	keys, err := storageSelfServiceCleanSelection(accountID, req.ObjectKeys)
	if err != nil {
		return storageSelfServiceError(c, 400, "invalid_selection", err.Error())
	}
	catalog, err := s.storageSelfServiceCatalog(ctx, s.repos.DB(), accountID, actorID, claims, keys)
	if err != nil {
		log.Printf("[StorageSelfService] preview scan failed: %v", err)
		return storageSelfServiceError(c, 503, "storage_scan_failed", "No se pudo verificar la selección. No se ha modificado ningún archivo.")
	}
	indexed := map[string]storageSelfServiceFile{}
	for _, f := range catalog.Files {
		indexed[f.ObjectKey] = f
	}
	items := make([]storageCleanupItem, 0, len(keys))
	eligible := 0
	var bytes int64
	for _, key := range keys {
		f, ok := indexed[key]
		if !ok {
			return storageSelfServiceError(c, 404, "storage_not_found", "La selección contiene un archivo que ya no está disponible.")
		}
		allowed, reason := storageSelfServiceEligibility(f, req.Action)
		items = append(items, storageCleanupItem{key, f.Filename, f.SizeBytes, allowed, reason, f.ReferencesCount, f.Fingerprint})
		if allowed {
			eligible++
			bytes += f.SizeBytes
		}
	}
	payload, err := json.Marshal(items)
	if err != nil {
		return err
	}
	expires := time.Now().UTC().Add(10 * time.Minute)
	id := uuid.New()
	_, err = s.repos.DB().Exec(ctx, `INSERT INTO storage_cleanup_previews(id,account_id,actor_id,action,items,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, id, accountID, actorID, req.Action, payload, expires)
	if err != nil {
		return storageSelfServiceError(c, 503, "storage_preview_failed", "No se pudo preparar la revisión. Inténtalo de nuevo.")
	}
	for i := range items {
		items[i].Fingerprint = ""
	}
	return c.JSON(fiber.Map{"success": true, "preview_id": id, "action": req.Action, "expires_at": expires, "items": items, "eligible_count": eligible, "estimated_bytes": bytes, "retention_days": storageSelfServiceRetentionDays})
}

// All reference writers take the shared form of this same tenant-scoped lock.
// It serializes only the selected account and is released before S3 deletion.
const storageSelfServiceReferenceLock = `SELECT pg_advisory_xact_lock(hashtextextended('storage-self-service:' || $1::text,0))`

func (s *Server) handleStorageCleanupConfirm(c *fiber.Ctx) error {
	if s.storage == nil {
		return storageSelfServiceError(c, 503, "storage_unavailable", "El almacenamiento no está disponible.")
	}
	accountID, actorID, claims, err := s.storageSelfServiceActor(c)
	if err != nil || !storageSelfServiceHasPermission(claims, domain.PermSettings) || !storageSelfServiceHasPermission(claims, domain.PermChats) {
		return storageSelfServiceError(c, 403, "storage_forbidden", "No tienes permiso para gestionar el almacenamiento.")
	}
	var req struct {
		PreviewID string `json:"preview_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return storageSelfServiceError(c, 400, "invalid_preview", "Revisa nuevamente la selección.")
	}
	id, err := uuid.Parse(req.PreviewID)
	if err != nil {
		return storageSelfServiceError(c, 400, "invalid_preview", "Revisa nuevamente la selección.")
	}
	ctx, cancel := context.WithTimeout(c.Context(), 45*time.Second)
	defer cancel()
	tx, err := s.repos.DB().Begin(ctx)
	if err != nil {
		return storageSelfServiceError(c, 503, "storage_busy", "No se pudo iniciar la operación.")
	}
	defer tx.Rollback(context.Background())
	var action string
	var operationActor uuid.UUID
	var payload, resultJSON []byte
	var expires, created time.Time
	err = tx.QueryRow(ctx, `SELECT action,items,expires_at,created_at,result,actor_id FROM storage_cleanup_previews WHERE id=$1 AND account_id=$2 AND (actor_id=$3 OR ($4::boolean AND action='purge' AND result IS NOT NULL)) FOR UPDATE`, id, accountID, actorID, domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin)).Scan(&action, &payload, &expires, &created, &resultJSON, &operationActor)
	if err != nil {
		return storageSelfServiceError(c, 404, "storage_preview_not_found", "La revisión no está disponible. Prepara una nueva.")
	}
	if len(resultJSON) > 0 {
		var prior storageCleanupResult
		if json.Unmarshal(resultJSON, &prior) != nil {
			return storageSelfServiceError(c, 503, "storage_result_unavailable", "Consulta Actividad para verificar el resultado.")
		}
		if action == "purge" && prior.Status != "completed" {
			if !storageSelfServiceHasPermission(claims, domain.PermChats) {
				return storageSelfServiceError(c, 403, "storage_forbidden", "Necesitas acceso a Chats para reanudar esta operación.")
			}
			if _, err := tx.Exec(ctx, `UPDATE storage_cleanup_previews SET last_retried_by=$3 WHERE id=$1 AND account_id=$2`, id, accountID, actorID); err != nil {
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return storageSelfServiceError(c, 503, "storage_busy", "No se pudo reanudar la operación.")
			}
			result, err := s.storageSelfServiceFinishPurge(ctx, accountID, operationActor, id)
			if err != nil {
				return storageSelfServiceError(c, 503, "storage_result_unavailable", "La eliminación sigue registrada. Puedes reintentarla desde Actividad.")
			}
			return c.JSON(result)
		}
		return c.JSON(prior)
	}
	if !time.Now().Before(expires) {
		return storageSelfServiceError(c, 409, "storage_preview_expired", "La revisión caducó. Revisa nuevamente la selección.")
	}
	var items []storageCleanupItem
	if json.Unmarshal(payload, &items) != nil || len(items) < 1 || len(items) > 100 {
		return storageSelfServiceError(c, 409, "storage_preview_invalid", "Prepara una nueva revisión.")
	}
	anyEligible := false
	for _, item := range items {
		if item.Eligible {
			anyEligible = true
		}
	}
	if !anyEligible {
		return storageSelfServiceError(c, 409, "storage_no_eligible_files", "Ningún archivo de esta selección permite la operación.")
	}
	if _, err = tx.Exec(ctx, `SET LOCAL lock_timeout='3s'`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, storageSelfServiceReferenceLock, accountID); err != nil {
		return storageSelfServiceError(c, 409, "storage_busy", "Hay cambios en curso. Espera un momento y vuelve a intentarlo.")
	}
	selected := make([]string, 0, len(items))
	for _, item := range items {
		selected = append(selected, item.ObjectKey)
	}
	if _, err = tx.Exec(ctx, `UPDATE storage_reference_epochs SET version=version+1 WHERE account_id=$1`, accountID); err != nil {
		return storageSelfServiceError(c, 503, "storage_guard_unavailable", "No se pudo verificar la seguridad de la operación.")
	}
	catalog, err := s.storageSelfServiceCatalog(ctx, tx, accountID, actorID, claims, selected)
	if err != nil {
		log.Printf("[StorageSelfService] confirmation scan failed: %v", err)
		return storageSelfServiceError(c, 503, "storage_scan_failed", "No se pudo volver a verificar la selección. No se ha modificado ningún archivo.")
	}
	indexed := map[string]storageSelfServiceFile{}
	for _, f := range catalog.Files {
		indexed[f.ObjectKey] = f
	}
	for _, item := range items {
		f, ok := indexed[item.ObjectKey]
		if !ok || f.Fingerprint != item.Fingerprint {
			return storageSelfServiceError(c, 409, "storage_preview_stale", "Los archivos o sus usos cambiaron. Revisa nuevamente la selección; no se ha modificado ningún archivo.")
		}
		eligible, _ := storageSelfServiceEligibility(f, action)
		if eligible != item.Eligible {
			return storageSelfServiceError(c, 409, "storage_preview_stale", "Los permisos o el estado cambiaron. Revisa nuevamente la selección.")
		}
	}
	result := storageCleanupResult{Success: true, OperationID: id, Action: action, Items: make([]storageCleanupItemResult, 0, len(items)), CreatedAt: created}
	if action == "purge" {
		result.Status = "processing"
		for _, item := range items {
			r := storageCleanupItemResult{ObjectKey: item.ObjectKey, Filename: item.Filename, Status: "blocked", Reason: item.Reason}
			if item.Eligible {
				if err := s.storageSelfServiceStagePurge(ctx, tx, accountID, item.ObjectKey); err != nil {
					return storageSelfServiceError(c, 409, "storage_preview_stale", "El estado cambió. Revisa nuevamente la selección.")
				}
				r.Status = "pending"
				r.Reason = "La eliminación está registrada."
			}
			result.Items = append(result.Items, r)
		}
		encoded, _ := json.Marshal(result)
		if _, err := tx.Exec(ctx, `UPDATE storage_cleanup_previews SET result=$4::jsonb WHERE id=$1 AND account_id=$2 AND actor_id=$3`, id, accountID, actorID, encoded); err != nil {
			return storageSelfServiceError(c, 503, "storage_result_unavailable", "No se pudo registrar la operación.")
		}
		if err := tx.Commit(ctx); err != nil {
			return storageSelfServiceError(c, 503, "storage_result_unavailable", "No se pudo confirmar el registro de la operación. Consulta Actividad.")
		}
		result, err := s.storageSelfServiceFinishPurge(ctx, accountID, actorID, id)
		if err != nil {
			return storageSelfServiceError(c, 503, "storage_result_unavailable", "La eliminación sigue registrada. Puedes reintentarla desde Actividad.")
		}
		return c.JSON(result)
	}
	completed, failed := 0, 0
	for _, item := range items {
		r := storageCleanupItemResult{ObjectKey: item.ObjectKey, Filename: item.Filename, Status: "blocked", Reason: item.Reason}
		if !item.Eligible {
			result.Items = append(result.Items, r)
			continue
		}
		if _, err = tx.Exec(ctx, `SAVEPOINT storage_file`); err != nil {
			return storageSelfServiceError(c, 503, "storage_operation_failed", "No se pudo completar la operación.")
		}
		var freed int64
		switch action {
		case "trash":
			err = s.storageSelfServiceTrash(ctx, tx, accountID, actorID, indexed[item.ObjectKey])
		case "restore":
			err = s.storageSelfServiceRestore(ctx, tx, accountID, item.ObjectKey)
		}
		if err != nil {
			log.Printf("[StorageSelfService] %s item failed account=%s: %v", action, accountID, err)
			if _, rollbackErr := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT storage_file`); rollbackErr != nil {
				return storageSelfServiceError(c, 503, "storage_operation_failed", "No se pudo confirmar el resultado. Consulta Actividad antes de volver a intentarlo.")
			}
			r.Status = "failed"
			r.Reason = "No se pudo completar este archivo. Vuelve a revisar su estado antes de intentarlo otra vez."
			failed++
		} else {
			r.Status = "completed"
			r.Reason = ""
			completed++
			result.FreedBytes += freed
			if action == "trash" {
				result.RetainedBytes += item.SizeBytes
			}
		}
		_, err = tx.Exec(ctx, `RELEASE SAVEPOINT storage_file`)
		if err != nil {
			return err
		}
		result.Items = append(result.Items, r)
	}
	result.Status = "completed"
	if failed > 0 || completed < len(items) {
		result.Status = "partial"
	}
	if completed == 0 {
		result.Status = "failed"
	}
	result.FilesCount = completed
	result.CompletedAt = time.Now().UTC()
	resultJSON, err = json.Marshal(result)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE storage_cleanup_previews SET result=$4::jsonb,completed_at=NOW() WHERE id=$1 AND account_id=$2 AND actor_id=$3`, id, accountID, actorID, resultJSON); err != nil {
		return storageSelfServiceError(c, 503, "storage_result_unavailable", "No se pudo confirmar el resultado. Revisa Actividad antes de volver a intentarlo.")
	}
	if err = tx.Commit(ctx); err != nil {
		return storageSelfServiceError(c, 503, "storage_result_unavailable", "No se pudo confirmar el resultado. Revisa Actividad antes de volver a intentarlo.")
	}
	if completed > 0 && (action == "trash" || action == "restore") {
		s.invalidateMessagesCache(accountID, nil)
		s.storageSelfServiceReconcileMessages(accountID, result)
	}
	return c.JSON(result)
}

type storageMessageBackup struct {
	ID      uuid.UUID  `json:"id"`
	ChatID  uuid.UUID  `json:"chat_id"`
	URL     *string    `json:"media_url"`
	AssetID *uuid.UUID `json:"media_asset_id"`
	Size    *int64     `json:"media_size"`
}

func (s *Server) storageSelfServiceTrash(ctx context.Context, tx pgx.Tx, accountID, actorID uuid.UUID, file storageSelfServiceFile) error {
	ids := make([]uuid.UUID, 0, len(file.refs))
	for _, ref := range file.refs {
		if ref.Origin != "chats" {
			return fmt.Errorf("shared file")
		}
		id, err := uuid.Parse(ref.ID)
		if err != nil {
			return err
		}
		ids = append(ids, id)
	}
	rows, err := tx.Query(ctx, `SELECT id,chat_id,media_url,media_asset_id,media_size FROM messages WHERE account_id=$1 AND id=ANY($2::uuid[]) AND NOT COALESCE(media_deleted,false) FOR UPDATE`, accountID, ids)
	if err != nil {
		return err
	}
	backups := make([]storageMessageBackup, 0, len(ids))
	for rows.Next() {
		var b storageMessageBackup
		if err := rows.Scan(&b.ID, &b.ChatID, &b.URL, &b.AssetID, &b.Size); err != nil {
			rows.Close()
			return err
		}
		backups = append(backups, b)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(backups) != len(ids) || len(ids) == 0 {
		return fmt.Errorf("message references changed")
	}
	payload, err := json.Marshal(backups)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,purge_after) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,NOW()+INTERVAL '7 days') ON CONFLICT(account_id,object_key) DO UPDATE SET actor_id=EXCLUDED.actor_id,filename=EXCLUDED.filename,media_type=EXCLUDED.media_type,size_bytes=EXCLUDED.size_bytes,message_backups=EXCLUDED.message_backups,removed_at=NOW(),purge_after=EXCLUDED.purge_after,state='trash',updated_at=NOW() WHERE storage_media_trash.state<>'trash'`, accountID, file.ObjectKey, actorID, file.Filename, file.MediaType, file.SizeBytes, payload)
	if err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `UPDATE messages SET media_url=NULL,media_asset_id=NULL,media_size=NULL,media_deleted=TRUE,media_deleted_at=NOW() WHERE account_id=$1 AND id=ANY($2::uuid[]) AND NOT COALESCE(media_deleted,false)`, accountID, ids)
	if err != nil {
		return err
	}
	if result.RowsAffected() != int64(len(backups)) {
		return fmt.Errorf("message count changed")
	}
	return nil
}
func (s *Server) storageSelfServiceRestore(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, key string) error {
	// Reading the bytes' metadata prevents claiming restoration of a missing file.
	if _, err := s.storage.GetFileInfo(ctx, key); err != nil {
		return err
	}
	var payload []byte
	err := tx.QueryRow(ctx, `SELECT message_backups FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state='trash' FOR UPDATE`, accountID, key).Scan(&payload)
	if err != nil {
		return err
	}
	var backups []storageMessageBackup
	if err := json.Unmarshal(payload, &backups); err != nil {
		return err
	}
	restored := int64(0)
	for _, b := range backups {
		result, err := tx.Exec(ctx, `UPDATE messages SET media_url=$4,media_asset_id=$5,media_size=$6,media_deleted=FALSE,media_deleted_at=NULL WHERE account_id=$1 AND id=$2 AND chat_id=$3 AND COALESCE(media_deleted,false) AND media_url IS NULL AND media_asset_id IS NULL`, accountID, b.ID, b.ChatID, b.URL, b.AssetID, b.Size)
		if err != nil {
			return err
		}
		restored += result.RowsAffected()
	}
	if restored == 0 {
		return fmt.Errorf("original messages no longer available")
	}
	_, err = tx.Exec(ctx, `UPDATE storage_media_trash SET state='restored',updated_at=NOW() WHERE account_id=$1 AND object_key=$2 AND state='trash'`, accountID, key)
	return err
}

// Commit the tombstone before touching S3. Reference guards prevent both
// new URL references and reuse of the retired media asset while it is pending.
func (s *Server) storageSelfServiceStagePurge(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, key string) error {
	var eligible bool
	err := tx.QueryRow(ctx, `SELECT purge_after<=NOW() FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state IN ('trash','purging') FOR UPDATE`, accountID, key).Scan(&eligible)
	if err != nil || !eligible {
		return fmt.Errorf("retention not completed")
	}
	refs, err := storageSelfServiceObjectReferences(ctx, tx, accountID, key, s.storage)
	if err != nil {
		return err
	}
	if len(refs) > 0 {
		return fmt.Errorf("file has references")
	}
	if _, err = tx.Exec(ctx, `UPDATE storage_media_trash SET state='purging',updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, key); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE media_assets SET status='deleting',updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, key); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE storage_objects SET status='storage_purging',updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, key)
	return err
}

// Safe to retry after any interruption. The durable tombstone is never rolled
// back with an object deletion, completed items never execute twice, and an
// already missing object contributes zero unverified bytes to the saving.
func (s *Server) storageSelfServiceFinishPurge(ctx context.Context, accountID, actorID, operationID uuid.UUID) (storageCleanupResult, error) {
	var result storageCleanupResult
	attempted := map[string]bool{}
	for {
		tx, err := s.repos.DB().Begin(ctx)
		if err != nil {
			return result, err
		}
		var payload []byte
		err = tx.QueryRow(ctx, `SELECT result FROM storage_cleanup_previews WHERE id=$1 AND account_id=$2 AND actor_id=$3 AND action='purge' FOR UPDATE`, operationID, accountID, actorID).Scan(&payload)
		if err != nil {
			tx.Rollback(context.Background())
			return result, err
		}
		if err = json.Unmarshal(payload, &result); err != nil {
			tx.Rollback(context.Background())
			return result, err
		}
		index := -1
		for i, r := range result.Items {
			if (r.Status == "pending" || r.Status == "failed") && !attempted[r.ObjectKey] {
				index = i
				break
			}
		}
		if index < 0 {
			tx.Rollback(context.Background())
			return result, nil
		}
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended('storage-self-service:' || $1::text,0))`, accountID); err != nil {
			tx.Rollback(context.Background())
			return result, err
		}
		item := &result.Items[index]
		attempted[item.ObjectKey] = true
		var state string
		err = tx.QueryRow(ctx, `SELECT state FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 FOR UPDATE`, accountID, item.ObjectKey).Scan(&state)
		if err != nil {
			tx.Rollback(context.Background())
			return result, err
		}
		freed := int64(0)
		if state != "purged" && state != "purging" {
			tx.Rollback(context.Background())
			return result, fmt.Errorf("purge intent unavailable")
		}
		if state == "purging" {
			info, statErr := s.storage.GetFileInfo(ctx, item.ObjectKey)
			if statErr == nil {
				err = s.storage.DeleteFile(ctx, item.ObjectKey)
				if err == nil {
					_, verifyErr := s.storage.GetFileInfo(ctx, item.ObjectKey)
					if storageSelfServiceObjectMissing(verifyErr) {
						freed = info.Size
					} else {
						err = fmt.Errorf("storage deletion not confirmed")
					}
				}
			} else if !storageSelfServiceObjectMissing(statErr) {
				err = statErr
			}
		}
		if err != nil {
			log.Printf("[StorageSelfService] purge remains durable account=%s: %v", accountID, err)
			item.Status = "failed"
			item.Reason = "No se confirmó la eliminación. Reintenta desde Actividad; los demás archivos se conservarán."
		} else {
			if _, err = tx.Exec(ctx, `UPDATE media_assets SET status='deleted',deleted_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, item.ObjectKey); err == nil {
				_, err = tx.Exec(ctx, `UPDATE storage_objects SET status='deleted',deleted_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, item.ObjectKey)
			}
			if err == nil {
				_, err = tx.Exec(ctx, `UPDATE storage_media_trash SET state='purged',updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, item.ObjectKey)
			}
			if err != nil {
				tx.Rollback(context.Background())
				return result, err
			}
			item.Status = "completed"
			item.Reason = ""
			result.FreedBytes += freed
		}
		completed, failed, pending := 0, 0, 0
		for _, r := range result.Items {
			switch r.Status {
			case "completed":
				completed++
			case "failed":
				failed++
			case "pending":
				pending++
			}
		}
		result.FilesCount = completed
		result.Status = "completed"
		if pending > 0 {
			result.Status = "processing"
		} else if failed > 0 || completed < len(result.Items) {
			result.Status = "partial"
			if completed == 0 {
				result.Status = "failed"
			}
		}
		result.CompletedAt = time.Now().UTC()
		payload, _ = json.Marshal(result)
		_, err = tx.Exec(ctx, `UPDATE storage_cleanup_previews SET result=$4::jsonb,completed_at=CASE WHEN $5='processing' THEN NULL ELSE NOW() END WHERE id=$1 AND account_id=$2 AND actor_id=$3`, operationID, accountID, actorID, payload, result.Status)
		if err != nil {
			tx.Rollback(context.Background())
			return result, err
		}
		if err = tx.Commit(ctx); err != nil {
			return result, err
		}
	}
}
func storageSelfServiceObjectMissing(err error) bool {
	if err == nil {
		return false
	}
	code := minio.ToErrorResponse(err).Code
	return code == "NoSuchKey" || code == "NoSuchObject" || code == "NotFound"
}

func (s *Server) handleStorageCleanupActivity(c *fiber.Ctx) error {
	accountID, actorID, claims, err := s.storageSelfServiceActor(c)
	if err != nil || !storageSelfServiceHasPermission(claims, domain.PermSettings) {
		return storageSelfServiceError(c, 403, "storage_forbidden", "No tienes acceso a esta actividad.")
	}
	limit, offset := storageSelfServicePage(c)
	rows, err := s.repos.DB().Query(c.Context(), `SELECT id,action,result,created_at FROM storage_cleanup_previews WHERE account_id=$1 AND (actor_id=$2 OR ($5::boolean AND action='purge')) AND result IS NOT NULL ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`, accountID, actorID, limit, offset, domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin))
	if err != nil {
		return storageSelfServiceError(c, 503, "storage_activity_unavailable", "No se pudo cargar la actividad.")
	}
	defer rows.Close()
	operations := make([]fiber.Map, 0)
	for rows.Next() {
		var id uuid.UUID
		var action string
		var payload []byte
		var created time.Time
		if err := rows.Scan(&id, &action, &payload, &created); err != nil {
			return err
		}
		var result storageCleanupResult
		if err := json.Unmarshal(payload, &result); err != nil {
			return err
		}
		canRetry := false
		if action == "purge" {
			for _, item := range result.Items {
				if item.Status == "pending" || item.Status == "failed" {
					canRetry = true
				}
			}
		}
		operations = append(operations, fiber.Map{"can_retry": canRetry, "id": id, "action": action, "status": result.Status, "created_at": created, "completed_at": result.CompletedAt, "files_count": result.FilesCount, "freed_bytes": result.FreedBytes, "retained_bytes": result.RetainedBytes})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var total int
	if err := s.repos.DB().QueryRow(c.Context(), `SELECT COUNT(*) FROM storage_cleanup_previews WHERE account_id=$1 AND (actor_id=$2 OR ($3::boolean AND action='purge')) AND result IS NOT NULL`, accountID, actorID, domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin)).Scan(&total); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "operations": operations, "total": total, "has_more": offset+len(operations) < total})
}
