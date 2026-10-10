package api

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

const storageOwnUploadReviewAge = 24 * time.Hour

type storageUploadOwnership struct {
	ID         uuid.UUID `json:"id"`
	ActorID    uuid.UUID `json:"actor_id"`
	Version    int64     `json:"version"`
	State      string    `json:"state"`
	Verified   bool      `json:"verified"`
	UploadedAt time.Time `json:"uploaded_at"`
	Filename   string    `json:"filename"`
}

// A successful deduplicated upload proves possession of the submitted bytes,
// but cannot establish the provenance of an old unregistered object. Only the
// creation of a new canonical object starts the durable ownership chain.
func (s *Server) recordStorageUpload(ctx context.Context, accountID, actorID uuid.UUID, asset *domain.MediaAsset, createdObject bool, submittedFilename ...string) error {
	if actorID == uuid.Nil || asset == nil || asset.AccountID != accountID || !storageSelfServiceValidKey(accountID, asset.ObjectKey) || storage.IsProtectedMediaObjectKey(asset.ObjectKey) {
		return fmt.Errorf("invalid upload ownership")
	}
	tx, err := s.repos.DB().Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended('storage-self-service:' || $1::text,0))`, accountID); err != nil {
		return err
	}
	var key, status string
	if err = tx.QueryRow(ctx, `SELECT object_key,status FROM media_assets WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, asset.ID).Scan(&key, &status); err != nil {
		return err
	}
	if key != asset.ObjectKey || status != "active" {
		return errStorageUseChanged
	}
	var retained bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state IN ('trash','purging','purged'))`, accountID, key).Scan(&retained); err != nil {
		return err
	}
	if retained {
		return errStorageUseProtected
	}
	filename := "Archivo subido"
	if len(submittedFilename) > 0 && submittedFilename[0] != "" {
		filename = path.Base(strings.ReplaceAll(submittedFilename[0], "\\", "/"))
	} else if createdObject && asset.Filename != "" {
		filename = asset.Filename
	}
	refs, err := storageSelfServiceObjectReferences(ctx, tx, accountID, key, s.storage)
	if err != nil {
		return err
	}
	state := "active"
	for _, ref := range refs {
		if ref.Origin != "private_upload_claims" {
			state = "attached"
			break
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO storage_upload_ownership(account_id,object_key,actor_id,provenance_verified,state,filename)
	 VALUES($1,$2,$3,$4 OR EXISTS(SELECT 1 FROM storage_upload_ownership WHERE account_id=$1 AND object_key=$2 AND provenance_verified),$5,$6)
	 ON CONFLICT(account_id,object_key,actor_id) DO UPDATE SET
	 provenance_verified=storage_upload_ownership.provenance_verified OR EXCLUDED.provenance_verified,
	 state=EXCLUDED.state,filename=EXCLUDED.filename,last_uploaded_at=NOW(),version=storage_upload_ownership.version+1`, accountID, key, actorID, createdObject, state, filename)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.storageSelfServicePublishChanged(accountID, "changed")
	return nil
}

type storageOwnUploadAdapter struct{}

func init() {
	storageAdditionalUseAdapters = append(storageAdditionalUseAdapters, storageOwnUploadAdapter{})
}
func (storageOwnUploadAdapter) Name() string { return "own_upload" }

func storageOwnUploadEligible(owner storageUploadOwnership, actorID uuid.UUID, hasBusinessReferences bool, now time.Time) (bool, string) {
	if owner.ActorID != actorID || !owner.Verified || owner.State != "active" {
		return false, "La procedencia de esta carga no está disponible."
	}
	if hasBusinessReferences {
		return false, "Esta carga ya se utiliza en un contenido. Revisa sus usos."
	}
	if now.Before(owner.UploadedAt.Add(storageOwnUploadReviewAge)) {
		return false, "Las cargas recientes se conservan durante 24 horas para que puedas terminar de adjuntarlas."
	}
	return true, ""
}

func (a storageOwnUploadAdapter) List(ctx context.Context, s *Server, q storageSelfServiceQuerier, actor storageUseActor, key string) ([]storageSelfServiceUse, error) {
	if storage.IsProtectedMediaObjectKey(key) {
		return nil, nil
	}
	rows, err := q.Query(ctx, `SELECT id,actor_id,version,state,provenance_verified,last_uploaded_at,filename FROM storage_upload_ownership
	 WHERE account_id=$1 AND object_key=$2 AND actor_id=$3 AND provenance_verified AND state='active'`, actor.AccountID, key, actor.UserID)
	if err != nil {
		return nil, err
	}
	owners := []storageUploadOwnership{}
	for rows.Next() {
		var owner storageUploadOwnership
		if err = rows.Scan(&owner.ID, &owner.ActorID, &owner.Version, &owner.State, &owner.Verified, &owner.UploadedAt, &owner.Filename); err != nil {
			rows.Close()
			return nil, err
		}
		owners = append(owners, owner)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(owners) == 0 {
		return nil, err
	}
	refs, err := storageSelfServiceObjectReferences(ctx, q, actor.AccountID, key, s.storage)
	if err != nil {
		return nil, err
	}
	hasBusinessRefs := false
	for _, ref := range refs {
		if ref.Origin != "private_upload_claims" {
			hasBusinessRefs = true
			break
		}
	}
	if hasBusinessRefs {
		return nil, nil
	}
	uses := make([]storageSelfServiceUse, 0, len(owners))
	for _, owner := range owners {
		allowed, reason := storageOwnUploadEligible(owner, actor.UserID, hasBusinessRefs, time.Now())
		if !storageSelfServiceHasPermission(actor.Claims, domain.PermSettings) {
			allowed = false
			reason = "Necesitas permiso para gestionar el almacenamiento."
		}
		uses = append(uses, storageSelfServiceUse{UseID: storageUseID(actor.AccountID, a.Name(), owner.ID, "upload", key), Type: "own_uploads", Label: "Carga propia sin adjuntar", Filename: owner.Filename, ContextLabel: "Subida por ti", CreatedAt: &owner.UploadedAt, CanRemove: allowed, BlockedReason: reason, Adapter: a.Name(), AccountID: actor.AccountID, ObjectKey: key, SourceID: owner.ID, Slot: "upload", Fingerprint: storageUseFingerprint(owner), ReferenceIDs: []string{"private_upload_claims|" + owner.ID.String()}})
	}
	return uses, nil
}

func (a storageOwnUploadAdapter) Detach(ctx context.Context, s *Server, tx pgx.Tx, actor storageUseActor, use storageSelfServiceUse) (storageUseSnapshot, error) {
	var snapshot storageUseSnapshot
	uses, err := a.List(ctx, s, tx, actor, use.ObjectKey)
	if err != nil {
		return snapshot, err
	}
	matched := false
	for _, current := range uses {
		if current.UseID == use.UseID && current.Fingerprint == use.Fingerprint && current.CanRemove {
			matched = true
			break
		}
	}
	if !matched {
		return snapshot, errStorageUseChanged
	}
	var before storageUploadOwnership
	err = tx.QueryRow(ctx, `SELECT id,actor_id,version,state,provenance_verified,last_uploaded_at,filename FROM storage_upload_ownership WHERE account_id=$1 AND id=$2 AND actor_id=$3 FOR UPDATE`, actor.AccountID, use.SourceID, actor.UserID).Scan(&before.ID, &before.ActorID, &before.Version, &before.State, &before.Verified, &before.UploadedAt, &before.Filename)
	if err != nil {
		return snapshot, err
	}
	if storageUseFingerprint(before) != use.Fingerprint {
		return snapshot, errStorageUseChanged
	}
	tag, err := tx.Exec(ctx, `UPDATE storage_upload_ownership SET state='removed',version=version+1 WHERE account_id=$1 AND id=$2 AND actor_id=$3 AND version=$4 AND state='active'`, actor.AccountID, use.SourceID, actor.UserID, before.Version)
	if err != nil {
		return snapshot, err
	}
	if tag.RowsAffected() != 1 {
		return snapshot, errStorageUseChanged
	}
	after := before
	after.State = "removed"
	after.Version++
	beforeJSON, _ := json.Marshal(before)
	afterJSON, _ := json.Marshal(after)
	snapshot = storageUseSnapshot{Version: 1, Adapter: a.Name(), UseID: use.UseID, AccountID: actor.AccountID, ObjectKey: use.ObjectKey, SourceID: use.SourceID, Slot: use.Slot, Type: use.Type, Label: use.Label, ContextLabel: use.ContextLabel, Before: beforeJSON, After: afterJSON}
	return snapshot, nil
}

func (a storageOwnUploadAdapter) Restore(ctx context.Context, s *Server, tx pgx.Tx, actor storageUseActor, snapshot storageUseSnapshot) error {
	if err := a.AuthorizeRecovery(ctx, s, tx, actor, snapshot, "restore"); err != nil {
		return err
	}
	var before, after storageUploadOwnership
	if snapshot.Version != 1 || snapshot.Adapter != a.Name() || snapshot.AccountID != actor.AccountID || json.Unmarshal(snapshot.Before, &before) != nil || json.Unmarshal(snapshot.After, &after) != nil {
		return errStorageUseRestoreConflict
	}
	// An account administrator may operate the durable recovery after an actor
	// is removed; restoration never transfers the upload to that administrator.
	if before.ActorID != actor.UserID && !domain.HasAccountAdminAuthority(actor.Claims.Role, actor.Claims.IsSuperAdmin) {
		return errStorageUseProtected
	}
	if !storageSelfServiceHasPermission(actor.Claims, domain.PermSettings) {
		return errStorageUseProtected
	}
	// A former abandoned upload must not be recreated as a hidden active claim
	// after somebody has attached it to a business resource. Its recovery stays
	// durable; the current content is never overwritten by restoration.
	refs, err := storageSelfServiceObjectReferences(ctx, tx, actor.AccountID, snapshot.ObjectKey, s.storage)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		if ref.Origin != "private_upload_claims" {
			return errStorageUseRestoreConflict
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE storage_upload_ownership SET state='active',version=version+1 WHERE account_id=$1 AND id=$2 AND actor_id=$3 AND state='removed' AND version=$4 AND provenance_verified`, actor.AccountID, snapshot.SourceID, before.ActorID, after.Version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errStorageUseRestoreConflict
	}
	return nil
}

func (a storageOwnUploadAdapter) AuthorizeRecovery(ctx context.Context, s *Server, q storageSelfServiceQuerier, actor storageUseActor, snapshot storageUseSnapshot, action string) error {
	var owner storageUploadOwnership
	if actor.Claims == nil || snapshot.Version != 1 || snapshot.AccountID != actor.AccountID || snapshot.Adapter != a.Name() || json.Unmarshal(snapshot.Before, &owner) != nil || !owner.Verified || !storageSelfServiceHasPermission(actor.Claims, domain.PermSettings) {
		return errStorageUseProtected
	}
	if owner.ActorID != actor.UserID && !domain.HasAccountAdminAuthority(actor.Claims.Role, actor.Claims.IsSuperAdmin) {
		return errStorageUseProtected
	}
	var valid bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM storage_upload_ownership WHERE account_id=$1 AND id=$2 AND object_key=$3 AND actor_id=$4 AND provenance_verified)`, actor.AccountID, snapshot.SourceID, snapshot.ObjectKey, owner.ActorID).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return errStorageUseProtected
	}
	return nil
}
