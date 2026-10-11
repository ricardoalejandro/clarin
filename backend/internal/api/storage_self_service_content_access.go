package api

import (
	"context"
	"errors"
	"log"
	"path"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
)

// An indexed source only locates an attachment. Its generation must still
// match the live source, and the resource/module ACL is evaluated in this SQL.
func storageInventoryObjectCTE(claims *service.JWTClaims, private bool) string {
	sql := storageInventoryCTE(claims, private)
	sql = strings.ReplaceAll(sql, "WHERE ir.account_id=$1 AND ir.readable", "WHERE ir.account_id=$1 AND ir.object_key=$7::text AND ir.readable")
	sql = strings.ReplaceAll(sql, "WHERE rr.account_id=$1 AND rr.state", "WHERE rr.account_id=$1 AND rr.object_key=$7::text AND rr.state")
	return sql
}
func storageInventoryKeysCTE(claims *service.JWTClaims, private bool) string {
	return strings.ReplaceAll(storageInventoryObjectCTE(claims, private), "object_key=$7::text", "object_key=ANY($7::text[])")
}

func (s *Server) storageObjectHasPrivateReferences(ctx context.Context, account uuid.UUID, key string) (bool, error) {
	var value bool
	err := s.repos.DB().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM storage_inventory_references
 WHERE account_id=$1 AND object_key=$2 AND source_kind IN ('task_attachments','whiteboard_assets','whiteboard_revision_assets'))
 OR EXISTS(SELECT 1 FROM storage_removed_references WHERE account_id=$1 AND object_key=$2 AND state='removed' AND adapter IN ('private_work','private_whiteboards'))`, account, key).Scan(&value)
	return value, err
}

func storageReadFailure(operation string, err error) {
	kind := "unavailable"
	var pgerr *pgconn.PgError
	if errors.Is(err, context.DeadlineExceeded) {
		kind = "deadline"
	} else if errors.Is(err, context.Canceled) {
		kind = "cancelled"
	} else if errors.As(err, &pgerr) {
		kind = "postgres:" + pgerr.Code
	}
	// Never include object keys, filenames, payloads, credentials or raw SQL.
	log.Printf("[StorageRead] operation=%s error=%s", operation, kind)
}

func storageReadableFilename(filename, key string) string {
	filename = path.Base(strings.ReplaceAll(filename, "\\", "/"))
	if filename != "" && filename != "." {
		return filename
	}
	switch storageSelfServiceMediaType(key, "") {
	case "image":
		return "Foto"
	case "video":
		return "Vídeo"
	case "audio":
		return "Audio"
	default:
		return "Documento"
	}
}

// Content authorization needs one current readable location, never the complete
// list of uses, mutation fingerprints, cleanup recommendations or S3 inventory.
func (s *Server) storageAuthorizeContent(ctx context.Context, actor storageUseActor, key string) (string, bool, error) {
	if !storageSelfServiceValidKey(actor.AccountID, key) || storage.IsAccountStatusObjectKey(actor.AccountID, key) {
		return "", false, nil
	}
	private, err := s.storageObjectHasPrivateReferences(ctx, actor.AccountID, key)
	if err != nil {
		return "", false, err
	}
	args := append(storageInventoryArguments(actor.AccountID, actor.UserID, actor.Claims), key)
	var filename string
	err = s.repos.DB().QueryRow(ctx, storageInventoryObjectCTE(actor.Claims, private)+`
 SELECT filename FROM authorized_refs WHERE object_key=$7::text LIMIT 1`, args...).Scan(&filename)
	if err == nil {
		return storageReadableFilename(filename, key), true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", false, err
	}

	// Newly written/dirty sources may not have reached the bounded worker yet.
	// This read-only scalar fallback never upgrades hidden inventory metadata into
	// permission and never gets reused across a mutation or another request.
	refs, err := storageSelfServiceObjectReferences(ctx, s.repos.DB(), actor.AccountID, key, s.storage)
	if err != nil {
		return "", false, err
	}
	for _, ref := range refs {
		permission := storageSelfServiceOriginPermission(ref.Origin)
		if permission != "" && storageSelfServiceHasPermission(actor.Claims, permission) &&
			(!storage.IsProtectedMediaObjectKey(key) || (ref.Origin == "contacts" && storage.IsAccountPrivateAvatarObjectKey(actor.AccountID, key))) {
			return storageReadableFilename(ref.Filename, key), true, nil
		}
	}
	for _, adapter := range []storagePrivateUseAdapter{{}, {whiteboards: true}} {
		refs, err := adapter.references(ctx, s.repos.DB(), actor, key)
		if err != nil {
			return "", false, err
		}
		if len(refs) > 0 {
			return storageReadableFilename(refs[0].Filename, key), true, nil
		}
	}
	ownCtx := context.WithValue(ctx, storageSelectedReferenceSnapshotKey{}, &storageSelectedReferenceSnapshot{account: actor.AccountID, querier: s.repos.DB(), stores: []*storage.Storage{s.storage}, refs: map[string][]storageSelfServiceReference{key: refs}})
	if ownFilename, allowed, err := s.storageOwnUploadReadAllowed(ownCtx, s.repos.DB(), actor.AccountID, actor.UserID, key); err != nil {
		return "", false, err
	} else if allowed {
		return ownFilename, true, nil
	}
	// Recoveries still require the adapter's canonical current ACL and backup
	// ownership checks. Stop at the first authorized retained copy.
	rows, err := s.repos.DB().Query(ctx, `SELECT id FROM storage_removed_references WHERE account_id=$1
 AND object_key=$2 AND state='removed' AND (actor_id=$3 OR $4::boolean) ORDER BY id`, actor.AccountID, key, actor.UserID, domain.HasAccountAdminAuthority(actor.Claims.Role, actor.Claims.IsSuperAdmin))
	if err != nil {
		return "", false, err
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return "", false, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return "", false, err
	}
	for _, id := range ids {
		recovery, err := storageLoadRecovery(ctx, s.repos.DB(), actor.AccountID, id, false)
		if err != nil {
			return "", false, err
		}
		if s.storageUseAuthorizeRecovery(ctx, s.repos.DB(), actor, recovery.Snapshot, recovery.ActorID, "read") == nil {
			return storageReadableFilename(recovery.Filename, key), true, nil
		}
	}
	if !storage.IsProtectedMediaObjectKey(key) && storageSelfServiceHasPermission(actor.Claims, domain.PermChats) {
		err = s.repos.DB().QueryRow(ctx, `SELECT filename FROM storage_media_trash WHERE account_id=$1 AND object_key=$2
   AND state='trash' AND jsonb_array_length(message_backups)>0 AND (actor_id=$3 OR $4::boolean) LIMIT 1`, actor.AccountID, key, actor.UserID, domain.HasAccountAdminAuthority(actor.Claims.Role, actor.Claims.IsSuperAdmin)).Scan(&filename)
		if err == nil {
			return storageReadableFilename(filename, key), true, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", false, err
		}
	}
	return "", false, nil
}

// Own-upload access is durable for the uploader's draft, while attachment into
// any business resource or entry into retention immediately ends this path.
func (s *Server) storageOwnUploadReadAllowed(ctx context.Context, q storageSelfServiceQuerier, account, actor uuid.UUID, key string) (string, bool, error) {
	if actor == uuid.Nil || !storageSelfServiceValidKey(account, key) || storage.IsProtectedMediaObjectKey(key) {
		return "", false, nil
	}
	var filename string
	err := q.QueryRow(ctx, `SELECT filename FROM storage_upload_ownership own WHERE own.account_id=$1 AND own.object_key=$2 AND own.actor_id=$3 AND own.provenance_verified AND own.state='active'
        AND NOT EXISTS(SELECT 1 FROM storage_media_trash trash WHERE trash.account_id=$1 AND trash.object_key=$2 AND trash.state IN ('trash','purging','purged'))
        AND NOT EXISTS(SELECT 1 FROM storage_removed_references removed WHERE removed.account_id=$1 AND removed.object_key=$2 AND removed.state IN ('removed','purging','purged')) LIMIT 1`, account, key, actor).Scan(&filename)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	refs, err := storageSelfServiceObjectReferences(ctx, q, account, key, s.storage)
	if err != nil {
		return "", false, err
	}
	for _, ref := range refs {
		if ref.Origin != "private_upload_claims" {
			return "", false, nil
		}
	}
	return storageReadableFilename(filename, key), true, nil
}
