package api

import (
	"context"
	"encoding/json"
	"log"
	"net/url"
	"sort"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type storageUseSelection struct {
	Version     int                    `json:"version"`
	Action      string                 `json:"action"`
	Targets     []storageUseTarget     `json:"targets,omitempty"`
	RecoveryIDs []uuid.UUID            `json:"recovery_ids,omitempty"`
	Items       []storageUseReviewItem `json:"items"`
}
type storageUseReviewItem struct {
	RecoveryOrder int64 `json:"recovery_order,omitempty"`
	storageUseImpact
	ObjectKey       string   `json:"object_key"`
	RecoveryID      string   `json:"recovery_id,omitempty"`
	Filename        string   `json:"filename"`
	MediaType       string   `json:"media_type"`
	SizeBytes       int64    `json:"size_bytes"`
	Eligible        bool     `json:"eligible"`
	Reason          string   `json:"reason"`
	ReferencesCount int      `json:"references_count"`
	Fingerprint     string   `json:"fingerprint,omitempty"`
	UseIDs          []string `json:"use_ids,omitempty"`
}
type storageUseRecovery struct {
	RemovalOrder                          int64
	ID, ActorID                           uuid.UUID
	ObjectKey, Filename, MediaType, State string
	SizeBytes                             int64
	RemovedAt, RetainUntil                time.Time
	Snapshot                              storageUseSnapshot
}

func storageLoadRecovery(ctx context.Context, q storageSelfServiceQuerier, account, id uuid.UUID, lock bool) (storageUseRecovery, error) {
	var r storageUseRecovery
	var raw []byte
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	err := q.QueryRow(ctx, `SELECT id,actor_id,object_key,filename,media_type,size_bytes,state,removed_at,retain_until,snapshot,removal_order FROM storage_removed_references WHERE account_id=$1 AND id=$2`+suffix, account, id).Scan(&r.ID, &r.ActorID, &r.ObjectKey, &r.Filename, &r.MediaType, &r.SizeBytes, &r.State, &r.RemovedAt, &r.RetainUntil, &raw, &r.RemovalOrder)
	if err == nil {
		err = json.Unmarshal(raw, &r.Snapshot)
	}
	return r, err
}

func (s *Server) storageSelfServiceRecoveryFiles(ctx context.Context, q storageSelfServiceQuerier, actor storageUseActor, keys []string) ([]storageSelfServiceFile, error) {
	rows, err := q.Query(ctx, `SELECT id FROM storage_removed_references WHERE account_id=$1 AND state IN ('removed','purging') AND (actor_id=$2 OR $3::boolean) AND ($4::text[] IS NULL OR object_key=ANY($4::text[])) ORDER BY removed_at DESC,id`, actor.AccountID, actor.UserID, domain.HasAccountAdminAuthority(actor.Claims.Role, actor.Claims.IsSuperAdmin), keys)
	if err != nil {
		return nil, err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	files := []storageSelfServiceFile{}
	for _, id := range ids {
		recovery, e := storageLoadRecovery(ctx, q, actor.AccountID, id, false)
		if e != nil {
			return nil, e
		}
		if s.storageUseAuthorizeRecovery(ctx, q, actor, recovery.Snapshot, recovery.ActorID, "read") != nil {
			continue
		}
		refs, e := storageSelfServiceObjectReferences(ctx, q, actor.AccountID, recovery.ObjectKey, s.storage)
		if e != nil {
			return nil, e
		}
		retained := len(refs) > 0
		restore := recovery.State == "removed" && s.storageUseAuthorizeRecovery(ctx, q, actor, recovery.Snapshot, recovery.ActorID, "restore") == nil
		purge := !retained && !storageUseNow().Before(recovery.RetainUntil) && recovery.State == "removed" && s.storageUseAuthorizeRecovery(ctx, q, actor, recovery.Snapshot, recovery.ActorID, "purge") == nil
		var waiting bool
		if e = q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM storage_removed_references WHERE account_id=$1 AND object_key=$2 AND state IN ('removed','purging') AND retain_until>NOW())`, actor.AccountID, recovery.ObjectKey).Scan(&waiting); e != nil {
			return nil, e
		}
		allAuthorized, e := s.storageUseCanPurgeAllRecoveries(ctx, q, actor, recovery.ObjectKey)
		if e != nil {
			return nil, e
		}
		purge = purge && !waiting && allAuthorized
		reason := ""
		if retained {
			reason = "El archivo sigue en uso; puedes recuperar este uso sin afectar a los demás."
		} else if !purge {
			reason = "Se conserva durante al menos siete días antes del borrado definitivo."
		}
		previewURL := ""
		if recovery.State == "removed" {
			previewURL = "/api/storage/content?object_key=" + url.QueryEscape(recovery.ObjectKey)
		}
		files = append(files, storageSelfServiceFile{PreviewURL: previewURL, ObjectKey: recovery.ObjectKey, RecoveryID: id.String(), Filename: recovery.Filename, MediaType: recovery.MediaType, SizeBytes: recovery.SizeBytes, LastModified: recovery.RemovedAt, Origins: []storageSelfServiceReference{{Origin: recovery.Snapshot.Type, Label: recovery.Snapshot.Label, Href: recovery.Snapshot.Href}}, ReferencesCount: 1, CanRestore: restore, CanPurge: purge, BlockedReason: reason, Status: "trash", TrashAt: &recovery.RemovedAt, PurgeAfter: &recovery.RetainUntil, RemovedUsesCount: 1, RetainedElsewhere: retained, ObjectRetained: retained})
	}
	return files, nil
}

func (s *Server) storageBuildUseSelection(ctx context.Context, q storageSelfServiceQuerier, actor storageUseActor, selection storageUseSelection) (storageUseSelection, error) {
	selection.Items = []storageUseReviewItem{}
	if selection.Action == "trash" {
		if len(selection.Targets) < 1 || len(selection.Targets) > 100 || len(selection.RecoveryIDs) > 0 {
			return selection, errStorageUseProtected
		}
		seen := map[string]bool{}
		for _, target := range selection.Targets {
			if !storageSelfServiceValidKey(actor.AccountID, target.ObjectKey) || seen[target.ObjectKey] || (target.Mode != "file" && target.Mode != "uses") {
				return selection, errStorageUseProtected
			}
			seen[target.ObjectKey] = true
			uses, err := s.storageSelfServiceListUses(ctx, q, actor, target.ObjectKey)
			if err != nil {
				return selection, err
			}
			if len(uses) == 0 {
				return selection, errStorageUseProtected
			}
			refs, err := storageSelfServiceObjectReferences(ctx, q, actor.AccountID, target.ObjectKey, s.storage)
			if err != nil {
				return selection, err
			}
			info, err := s.storage.GetFileInfo(ctx, target.ObjectKey)
			if err != nil {
				return selection, err
			}
			item := storageUseReviewItem{ObjectKey: target.ObjectKey, Filename: "Archivo", MediaType: storageSelfServiceMediaType(target.ObjectKey, info.ContentType), SizeBytes: info.Size, Eligible: true, UseIDs: []string{}}
			if item.MediaType == "" {
				return selection, errStorageUseProtected
			}
			for _, use := range uses {
				if use.Filename != "" {
					item.Filename = use.Filename
					break
				}
			}
			requested := map[string]bool{}
			for _, id := range target.UseIDs {
				if id == "" || requested[id] {
					return selection, errStorageUseProtected
				}
				requested[id] = true
			}
			if target.Mode == "uses" && (len(requested) == 0 || len(requested) > 100) {
				return selection, errStorageUseProtected
			}
			covered, selectedCoverage := map[string]bool{}, map[string]bool{}
			fingerprints := []string{}
			for _, use := range uses {
				for _, id := range use.ReferenceIDs {
					covered[id] = true
				}
				selected := target.Mode == "file" || requested[use.UseID]
				if selected {
					if !use.CanRemove {
						item.Eligible = false
						item.Reason = use.BlockedReason
					}
					item.UseIDs = append(item.UseIDs, use.UseID)
					fingerprints = append(fingerprints, use.UseID+"|"+use.Fingerprint)
					for _, id := range use.ReferenceIDs {
						selectedCoverage[id] = true
					}
					delete(requested, use.UseID)
				} else {
					item.RetainedUsesVisibleCount++
				}
			}
			if target.Mode == "uses" && len(requested) > 0 {
				return selection, errStorageUseProtected
			}
			remaining := false
			for _, ref := range refs {
				refID := ref.Origin + "|" + ref.ID
				if !covered[refID] {
					item.RetainedElsewhere = true
				}
				if !selectedCoverage[refID] {
					remaining = true
				}
			}
			if target.Mode == "file" && (remaining || len(item.UseIDs) == 0) {
				item.Eligible = false
				item.Reason = "El archivo conserva usos protegidos. Selecciona los usos que puedas retirar."
			}
			item.SelectedUsesCount = len(item.UseIDs)
			item.RemovedUses = len(item.UseIDs)
			item.ReferencesCount = len(uses)
			item.WillTrash = !remaining && item.Eligible
			if item.WillTrash {
				item.TrashBytes = item.SizeBytes
			}
			if item.Reason == "" {
				item.Reason = "Se retirarán los usos seleccionados. Podrás recuperarlos desde la papelera."
			}
			item.Fingerprint = storageUseFingerprint([]any{info.ETag, info.Size, refs, fingerprints, item.Eligible, item.RetainedElsewhere, item.RetainedUsesVisibleCount, item.WillTrash})
			selection.Items = append(selection.Items, item)
		}
	} else {
		if len(selection.RecoveryIDs) < 1 || len(selection.RecoveryIDs) > 100 || len(selection.Targets) > 0 {
			return selection, errStorageUseProtected
		}
		seen := map[uuid.UUID]bool{}
		for _, id := range selection.RecoveryIDs {
			if seen[id] {
				return selection, errStorageUseProtected
			}
			seen[id] = true
			recovery, err := storageLoadRecovery(ctx, q, actor.AccountID, id, false)
			if err != nil {
				return selection, err
			}
			if err = s.storageUseAuthorizeRecovery(ctx, q, actor, recovery.Snapshot, recovery.ActorID, selection.Action); err != nil {
				return selection, err
			}
			refs, err := storageSelfServiceObjectReferences(ctx, q, actor.AccountID, recovery.ObjectKey, s.storage)
			if err != nil {
				return selection, err
			}
			info, err := s.storage.GetFileInfo(ctx, recovery.ObjectKey)
			if err != nil {
				return selection, err
			}
			item := storageUseReviewItem{ObjectKey: recovery.ObjectKey, RecoveryID: id.String(), RecoveryOrder: recovery.RemovalOrder, Filename: recovery.Filename, MediaType: recovery.MediaType, SizeBytes: info.Size, Eligible: recovery.State == "removed", storageUseImpact: storageUseImpact{SelectedUsesCount: 1, RemovedUses: 1, RetainedElsewhere: len(refs) > 0}}
			if selection.Action == "purge" {
				var waiting bool
				if err = q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM storage_removed_references WHERE account_id=$1 AND object_key=$2 AND state IN ('removed','purging') AND retain_until>NOW())`, actor.AccountID, recovery.ObjectKey).Scan(&waiting); err != nil {
					return selection, err
				}
				allAuthorized, e := s.storageUseCanPurgeAllRecoveries(ctx, q, actor, recovery.ObjectKey)
				if e != nil {
					return selection, e
				}
				item.Eligible = item.Eligible && !waiting && len(refs) == 0 && allAuthorized
				if item.Eligible {
					item.EstimatedFreedBytes = item.SizeBytes
					item.Reason = "Se eliminarán definitivamente los bytes del archivo y sus recuperaciones pendientes."
				} else {
					item.Reason = "El archivo se conserva mientras siga en uso o no termine el plazo de recuperación de todos sus usos."
				}
			} else {
				item.Reason = "Se recuperará este uso en su ubicación original si no ha cambiado."
			}
			item.Fingerprint = storageUseFingerprint([]any{recovery, info.ETag, refs, item.Eligible})
			selection.Items = append(selection.Items, item)
		}
	}
	if selection.Action == "restore" {
		sort.SliceStable(selection.Items, func(i, j int) bool { return selection.Items[i].RecoveryOrder > selection.Items[j].RecoveryOrder })
	}
	return selection, nil
}

func (s *Server) handleStorageUsePreview(c *fiber.Ctx, actor storageUseActor, action string, targets []storageUseTarget, recoveryIDs []uuid.UUID) error {
	ctx, cancel := context.WithTimeout(c.Context(), storageSelfServiceCatalogTimeout)
	defer cancel()
	if len(recoveryIDs) > 0 {
		var found int
		err := s.repos.DB().QueryRow(ctx, `SELECT count(*) FROM storage_removed_references WHERE account_id=$1 AND id=ANY($2::uuid[])`, actor.AccountID, recoveryIDs).Scan(&found)
		if err != nil {
			return err
		}
		if found == 0 {
			rows, err := s.repos.DB().Query(ctx, `SELECT object_key FROM storage_media_trash WHERE account_id=$1 AND id=ANY($2::uuid[]) AND (actor_id=$3 OR $4::boolean)`, actor.AccountID, recoveryIDs, actor.UserID, domain.HasAccountAdminAuthority(actor.Claims.Role, actor.Claims.IsSuperAdmin))
			if err != nil {
				return err
			}
			keys := []string{}
			for rows.Next() {
				var key string
				if err = rows.Scan(&key); err != nil {
					rows.Close()
					return err
				}
				keys = append(keys, key)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
			if len(keys) != len(recoveryIDs) {
				return storageSelfServiceError(c, 404, "storage_not_found", "La recuperación no está disponible.")
			}
			body, _ := json.Marshal(fiber.Map{"action": action, "object_keys": keys})
			c.Request().SetBody(body)
			return s.handleStorageCleanupPreview(c)
		}
		if found != len(recoveryIDs) {
			return storageSelfServiceError(c, 409, "storage_selection_changed", "Revisa las recuperaciones antiguas por separado.")
		}
	}
	selection, err := s.storageBuildUseSelection(ctx, s.repos.DB(), actor, storageUseSelection{Version: 1, Action: action, Targets: targets, RecoveryIDs: recoveryIDs})
	if err != nil {
		return storageSelfServiceError(c, 409, "storage_selection_changed", "La selección cambió o ya no tienes acceso. Revisa sus usos de nuevo.")
	}
	id := uuid.New()
	expires := storageUseNow().Add(10 * time.Minute)
	raw, _ := json.Marshal(selection)
	items, _ := json.Marshal(selection.Items)
	if _, err = s.repos.DB().Exec(ctx, `INSERT INTO storage_cleanup_previews(id,account_id,actor_id,action,items,expires_at,use_selection) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`, id, actor.AccountID, actor.UserID, action, items, expires, raw); err != nil {
		return err
	}
	eligible := 0
	selectedUses, retainedVisible := 0, 0
	retainedElsewhere := false
	var estimated, trashBytes, selectedBytes int64
	dedup := map[string]bool{}
	for i := range selection.Items {
		item := &selection.Items[i]
		item.Fingerprint = ""
		item.RecoveryOrder = 0
		selectedUses += item.SelectedUsesCount
		retainedVisible += item.RetainedUsesVisibleCount
		retainedElsewhere = retainedElsewhere || item.RetainedElsewhere
		if item.Eligible {
			eligible++
			if !dedup[item.ObjectKey] {
				dedup[item.ObjectKey] = true
				estimated += item.EstimatedFreedBytes
				selectedBytes += item.SizeBytes
				trashBytes += item.TrashBytes
			}
		}
	}
	return c.JSON(fiber.Map{"success": true, "preview_id": id, "action": action, "expires_at": expires, "items": selection.Items, "eligible_count": eligible, "estimated_bytes": selectedBytes, "estimated_freed_bytes": estimated, "trash_bytes": trashBytes, "retention_days": storageSelfServiceRetentionDays, "selected_uses_count": selectedUses, "removed_uses": selectedUses, "retained_uses_visible_count": retainedVisible, "retained_elsewhere": retainedElsewhere})
}

func (s *Server) handleStorageUseConfirm(c *fiber.Ctx, actor storageUseActor, id uuid.UUID) error {
	ctx, cancel := context.WithTimeout(c.Context(), 45*time.Second)
	defer cancel()
	tx, err := s.repos.DB().Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var raw, resultRaw []byte
	var expires, created time.Time
	var operationActor uuid.UUID
	err = tx.QueryRow(ctx, `SELECT use_selection,result,expires_at,created_at,actor_id FROM storage_cleanup_previews WHERE id=$1 AND account_id=$2 AND (actor_id=$3 OR ($4::boolean AND action='purge' AND result IS NOT NULL)) FOR UPDATE`, id, actor.AccountID, actor.UserID, domain.HasAccountAdminAuthority(actor.Claims.Role, actor.Claims.IsSuperAdmin)).Scan(&raw, &resultRaw, &expires, &created, &operationActor)
	if err != nil {
		return storageSelfServiceError(c, 404, "storage_preview_not_found", "La revisión no está disponible.")
	}
	var plan storageUseSelection
	if json.Unmarshal(raw, &plan) != nil || plan.Version != 1 {
		return storageSelfServiceError(c, 409, "storage_selection_changed", "Vuelve a revisar la selección.")
	}
	if len(resultRaw) > 0 {
		readable, e := s.storageUseCanReadOperation(ctx, tx, actor, id, plan)
		if e != nil {
			return storageSelfServiceError(c, 503, "storage_result_unavailable", "No se pudo verificar el acceso a la operación.")
		}
		if !readable {
			return storageSelfServiceError(c, 403, "storage_forbidden", "Ya no tienes acceso a esta operación.")
		}
		var result storageCleanupResult
		if json.Unmarshal(resultRaw, &result) != nil {
			return errStorageUseChanged
		}
		if plan.Action == "purge" && result.Status != "completed" {
			for _, rid := range plan.RecoveryIDs {
				r, e := storageLoadRecovery(ctx, tx, actor.AccountID, rid, false)
				if e != nil || s.storageUseAuthorizeRecovery(ctx, tx, actor, r.Snapshot, r.ActorID, "purge") != nil {
					return storageSelfServiceError(c, 403, "storage_forbidden", "Ya no tienes acceso a esta operación.")
				}
			}
			if _, err = tx.Exec(ctx, `UPDATE storage_cleanup_previews SET last_retried_by=$3 WHERE account_id=$1 AND id=$2`, actor.AccountID, id, actor.UserID); err != nil {
				return err
			}
			if err = tx.Commit(ctx); err != nil {
				return err
			}
			result, err = s.storageSelfServiceFinishPurge(ctx, actor.AccountID, operationActor, id)
			if err != nil {
				return storageSelfServiceError(c, 503, "storage_result_unavailable", "La eliminación sigue registrada. Reintenta desde Actividad.")
			}
			s.storageSelfServicePublishChanged(actor.AccountID, "changed")
			return c.JSON(result)
		}
		return c.JSON(result)
	}
	if storageUseNow().After(expires) {
		return storageSelfServiceError(c, 409, "storage_preview_expired", "La revisión caducó. Revisa otra vez el impacto.")
	}
	if _, err = tx.Exec(ctx, `SET LOCAL lock_timeout='3s'`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, storageSelfServiceReferenceLock, actor.AccountID); err != nil {
		return storageSelfServiceError(c, 409, "storage_busy", "Hay otra operación en curso. Inténtalo de nuevo.")
	}
	if _, err = tx.Exec(ctx, `INSERT INTO storage_reference_epochs(account_id,version) VALUES($1,1) ON CONFLICT(account_id) DO UPDATE SET version=storage_reference_epochs.version+1`, actor.AccountID); err != nil {
		return err
	}
	fresh, err := s.storageBuildUseSelection(ctx, tx, actor, plan)
	if err != nil || len(fresh.Items) != len(plan.Items) {
		log.Printf("[StorageSelfService] use revalidation failed: %v", err)
		return storageSelfServiceError(c, 409, "storage_selection_changed", "La selección cambió. Vuelve a revisar el impacto.")
	}
	for i := range plan.Items {
		if plan.Items[i].Fingerprint != fresh.Items[i].Fingerprint {
			log.Printf("[StorageSelfService] reviewed use fingerprint changed for action=%s", plan.Action)
			return storageSelfServiceError(c, 409, "storage_selection_changed", "La selección cambió. Vuelve a revisar el impacto.")
		}
	}
	result := storageCleanupResult{Success: true, OperationID: id, Action: plan.Action, Status: "completed", Items: []storageCleanupItemResult{}, CreatedAt: created}
	snapshots := []storageUseSnapshot{}
	processed := map[string]bool{}
	for _, item := range fresh.Items {
		if !item.Eligible {
			result.Items = append(result.Items, storageCleanupItemResult{RecoveryID: item.RecoveryID, ObjectKey: item.ObjectKey, Filename: item.Filename, Status: "skipped", Reason: item.Reason})
			continue
		}
		switch plan.Action {
		case "trash":
			for _, useID := range item.UseIDs {
				uses, e := s.storageSelfServiceListUses(ctx, tx, actor, item.ObjectKey)
				if e != nil {
					return e
				}
				var selected *storageSelfServiceUse
				for i := range uses {
					if uses[i].UseID == useID {
						selected = &uses[i]
						break
					}
				}
				if selected == nil || !selected.CanRemove {
					return storageSelfServiceError(c, 409, "storage_selection_changed", "Uno de los usos cambió. No se retiró ningún archivo.")
				}
				adapter := storageUseAdapterNamed(selected.Adapter)
				if adapter == nil {
					return errStorageUseProtected
				}
				snap, e := adapter.Detach(ctx, s, tx, actor, *selected)
				if e != nil {
					log.Printf("[StorageSelfService] detach adapter=%s failed: %v", selected.Adapter, e)
					return storageSelfServiceError(c, 409, "storage_selection_changed", "Uno de los usos cambió. No se retiró ningún archivo.")
				}
				payload, _ := json.Marshal(snap)
				recoveryID := uuid.New()
				if _, err = tx.Exec(ctx, `INSERT INTO storage_removed_references(id,account_id,actor_id,operation_id,object_key,use_id,adapter,origin_type,label,filename,media_type,size_bytes,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`, recoveryID, actor.AccountID, actor.UserID, id, item.ObjectKey, selected.UseID, selected.Adapter, selected.Type, selected.Label, item.Filename, item.MediaType, item.SizeBytes, payload); err != nil {
					return err
				}
				snapshots = append(snapshots, snap)
			}
			refs, e := storageSelfServiceObjectReferences(ctx, tx, actor.AccountID, item.ObjectKey, s.storage)
			if e != nil {
				return e
			}
			if len(refs) == 0 {
				if err = s.storageUseMarkPhysicalTrash(ctx, tx, actor, item); err != nil {
					return err
				}
			}
			result.RetainedBytes += item.SizeBytes
		case "restore":
			recoveryID, e := uuid.Parse(item.RecoveryID)
			if e != nil {
				return e
			}
			recovery, e := storageLoadRecovery(ctx, tx, actor.AccountID, recoveryID, true)
			if e != nil {
				return e
			}
			adapter := storageUseAdapterNamed(recovery.Snapshot.Adapter)
			if adapter == nil {
				return errStorageUseProtected
			}
			if e = adapter.Restore(ctx, s, tx, actor, recovery.Snapshot); e != nil {
				return storageSelfServiceError(c, 409, "storage_restore_conflict", "La ubicación original cambió. Se conserva la recuperación sin sobrescribir el contenido actual.")
			}
			if _, err = tx.Exec(ctx, `UPDATE storage_removed_references SET state='restored',restored_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND id=$2 AND state='removed'`, actor.AccountID, recoveryID); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `UPDATE storage_media_trash SET state='restored',updated_at=NOW() WHERE account_id=$1 AND object_key=$2 AND state='trash' AND jsonb_array_length(message_backups)=0`, actor.AccountID, item.ObjectKey); err != nil {
				return err
			}
			snapshots = append(snapshots, recovery.Snapshot)
		case "purge":
			if processed[item.ObjectKey] {
				result.Items = append(result.Items, storageCleanupItemResult{RecoveryID: item.RecoveryID, ObjectKey: item.ObjectKey, Filename: item.Filename, Status: "pending"})
				continue
			}
			processed[item.ObjectKey] = true
			if err = s.storageUseBeforePhysicalPurge(ctx, tx, actor, item.ObjectKey); err != nil {
				return storageSelfServiceError(c, 409, "storage_selection_changed", "Una recuperación cambió. Revisa de nuevo el impacto.")
			}
			if err = s.storageUseMarkPhysicalTrash(ctx, tx, actor, item); err != nil {
				return err
			}
			if err = s.storageSelfServiceStagePurge(ctx, tx, actor.AccountID, item.ObjectKey); err != nil {
				return storageSelfServiceError(c, 409, "storage_selection_changed", "El archivo volvió a utilizarse o sigue dentro del plazo de recuperación.")
			}
			if _, err = tx.Exec(ctx, `UPDATE storage_removed_references SET state='purging',updated_at=NOW() WHERE account_id=$1 AND object_key=$2 AND state='removed'`, actor.AccountID, item.ObjectKey); err != nil {
				return err
			}
		}
		status := "completed"
		if plan.Action == "purge" {
			status = "pending"
			result.Status = "processing"
		} else {
			result.FilesCount++
		}
		result.Items = append(result.Items, storageCleanupItemResult{RecoveryID: item.RecoveryID, ObjectKey: item.ObjectKey, Filename: item.Filename, Status: status})
	}
	if plan.Action != "purge" && result.FilesCount < len(result.Items) {
		result.Status = "partial"
		if result.FilesCount == 0 {
			result.Status = "failed"
		}
	}
	result.CompletedAt = storageUseNow()
	payload, _ := json.Marshal(result)
	if _, err = tx.Exec(ctx, `UPDATE storage_cleanup_previews SET result=$3::jsonb,completed_at=CASE WHEN $4='processing' THEN NULL ELSE NOW() END WHERE account_id=$1 AND id=$2`, actor.AccountID, id, payload, result.Status); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return storageSelfServiceError(c, 503, "storage_result_unavailable", "Revisa Actividad para confirmar el resultado.")
	}
	if plan.Action == "purge" {
		result, err = s.storageSelfServiceFinishPurge(ctx, actor.AccountID, operationActor, id)
		if err != nil {
			return storageSelfServiceError(c, 503, "storage_result_unavailable", "La eliminación sigue registrada. Reintenta desde Actividad.")
		}
	}
	s.storageUseAfterCommit(ctx, actor, snapshots, plan.Action)
	return c.JSON(result)
}

func (s *Server) storageUseBeforePhysicalPurge(ctx context.Context, tx pgx.Tx, actor storageUseActor, key string) error {
	if allowed, err := s.storageUseCanPurgeAllRecoveries(ctx, tx, actor, key); err != nil {
		return err
	} else if !allowed {
		return errStorageUseProtected
	}
	rows, err := tx.Query(ctx, `SELECT id FROM storage_removed_references WHERE account_id=$1 AND object_key=$2 AND state='removed' FOR UPDATE`, actor.AccountID, key)
	if err != nil {
		return err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		r, e := storageLoadRecovery(ctx, tx, actor.AccountID, id, false)
		if e != nil {
			return e
		}
		if e = s.storageUseAuthorizeRecovery(ctx, tx, actor, r.Snapshot, r.ActorID, "purge"); e != nil {
			return e
		}
		if hook, ok := storageUseAdapterNamed(r.Snapshot.Adapter).(storageUseBeforePurge); ok {
			if e = hook.BeforePurge(ctx, s, tx, actor, r.Snapshot); e != nil {
				return e
			}
		}
	}
	return nil
}
func (s *Server) storageUseMarkPhysicalTrash(ctx context.Context, tx pgx.Tx, actor storageUseActor, item storageUseReviewItem) error {
	_, err := tx.Exec(ctx, `INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,removed_at,purge_after)
 SELECT $1,$2,$3,$4,$5,$6,'[]'::jsonb,MIN(removed_at),MAX(retain_until) FROM storage_removed_references WHERE account_id=$1 AND object_key=$2 AND state IN ('removed','purging') HAVING count(*)>0
 ON CONFLICT(account_id,object_key) DO UPDATE SET actor_id=EXCLUDED.actor_id,filename=EXCLUDED.filename,media_type=EXCLUDED.media_type,size_bytes=EXCLUDED.size_bytes,message_backups='[]'::jsonb,removed_at=EXCLUDED.removed_at,purge_after=EXCLUDED.purge_after,state='trash',updated_at=NOW() WHERE storage_media_trash.state='restored' OR (storage_media_trash.state='trash' AND jsonb_array_length(storage_media_trash.message_backups)=0)`, actor.AccountID, item.ObjectKey, actor.UserID, item.Filename, item.MediaType, item.SizeBytes)
	return err
}

func (s *Server) storageUseCanPurgeAllRecoveries(ctx context.Context, q storageSelfServiceQuerier, actor storageUseActor, key string) (bool, error) {
	// Legacy backups are an independent recovery with its own owner and review.
	// A per-use purge must never silently replace or consume that recovery.
	var legacy bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state IN ('trash','purging') AND jsonb_array_length(message_backups)>0)`, actor.AccountID, key).Scan(&legacy); err != nil {
		return false, err
	}
	if legacy {
		return false, nil
	}
	rows, err := q.Query(ctx, `SELECT id FROM storage_removed_references WHERE account_id=$1 AND object_key=$2 AND state IN ('removed','purging')`, actor.AccountID, key)
	if err != nil {
		return false, err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return false, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	for _, id := range ids {
		r, e := storageLoadRecovery(ctx, q, actor.AccountID, id, false)
		if e != nil {
			return false, e
		}
		if s.storageUseAuthorizeRecovery(ctx, q, actor, r.Snapshot, r.ActorID, "purge") != nil {
			return false, nil
		}
	}
	return len(ids) > 0, nil
}

func (s *Server) storageUseCanReadOperation(ctx context.Context, q storageSelfServiceQuerier, actor storageUseActor, operationID uuid.UUID, plan storageUseSelection) (bool, error) {
	rows, err := q.Query(ctx, `SELECT id FROM storage_removed_references WHERE account_id=$1 AND (operation_id=$2 OR id=ANY($3::uuid[]))`, actor.AccountID, operationID, plan.RecoveryIDs)
	if err != nil {
		return false, err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return false, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	verified := map[string]bool{}
	for _, id := range ids {
		r, e := storageLoadRecovery(ctx, q, actor.AccountID, id, false)
		if e != nil {
			return false, e
		}
		allowed := s.storageUseAuthorizeRecovery(ctx, q, actor, r.Snapshot, r.ActorID, "read") == nil
		if !allowed {
			uses, e := s.storageSelfServiceListUses(ctx, q, actor, r.ObjectKey)
			if e != nil {
				return false, e
			}
			for _, use := range uses {
				if use.UseID == r.Snapshot.UseID {
					allowed = true
					break
				}
			}
		}
		if !allowed {
			return false, nil
		}
		verified[r.ObjectKey] = true
	}
	for _, item := range plan.Items {
		if verified[item.ObjectKey] {
			continue
		}
		uses, e := s.storageSelfServiceListUses(ctx, q, actor, item.ObjectKey)
		if e != nil {
			return false, e
		}
		visible := map[string]bool{}
		for _, use := range uses {
			visible[use.UseID] = true
		}
		for _, id := range item.UseIDs {
			if !visible[id] {
				return false, nil
			}
		}
		if len(uses) == 0 {
			return false, nil
		}
	}
	return true, nil
}
