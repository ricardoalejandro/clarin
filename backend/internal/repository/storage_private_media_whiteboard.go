package repository

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

func ListWhiteboardStorageReferences(ctx context.Context, q StoragePrivateMediaQuerier, accountID, actorID uuid.UUID, keys []string) ([]PrivateStorageReference, error) {
	rows, err := q.Query(ctx, whiteboardHubAccessCTE+` SELECT link.id,board.id,asset.object_key,board.name,asset.filename,
		board.scene_sequence::text||':'||board.access_revision::text,
		(board.effective_level IN ('edit','manage') AND board.archived_at IS NULL AND board.view_deleted_at IS NULL AND board.work_lifecycle IN ('','active')),
		link.committed_at,link.uploaded_by,link.draft_expires_at
		FROM visible board JOIN whiteboard_assets link ON link.account_id=board.account_id AND link.board_id=board.id AND link.kind='asset'
		JOIN media_assets asset ON asset.account_id=link.account_id AND asset.id=link.media_asset_id AND asset.status='active'
		WHERE board.effective_level<>'none' AND (link.committed_at IS NOT NULL OR link.uploaded_by=$2)
		AND ($3::text[] IS NULL OR asset.object_key=ANY($3::text[])) ORDER BY link.id`, accountID, actorID, keys)
	if err != nil {
		return nil, err
	}
	refs := []PrivateStorageReference{}
	for rows.Next() {
		ref := PrivateStorageReference{Kind: "whiteboard_assets", Origin: "whiteboards"}
		var committed, expiry *time.Time
		var uploader *uuid.UUID
		if err := rows.Scan(&ref.ID, &ref.ParentID, &ref.ObjectKey, &ref.Label, &ref.Filename, &ref.Version, &ref.CanRemove, &committed, &uploader, &expiry); err != nil {
			rows.Close()
			return nil, err
		}
		ref.Href = "/dashboard/whiteboards/" + ref.ParentID.String()
		if committed == nil {
			ref.CanRemove = ref.CanRemove && uploader != nil && *uploader == actorID && expiry != nil && !expiry.After(time.Now())
			ref.Label += " · Carga sin colocar"
		}
		if !ref.CanRemove {
			ref.BlockedReason = "Esta imagen está protegida por los permisos o el estado de la pizarra."
		}
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	rows, err = q.Query(ctx, whiteboardHubAccessCTE+` SELECT link.id,board.id,asset.object_key,board.name,asset.filename,revision.revision_number::text
		FROM visible board JOIN whiteboard_revision_assets link ON link.account_id=board.account_id AND link.board_id=board.id
		JOIN whiteboard_revisions revision ON revision.account_id=link.account_id AND revision.id=link.revision_id AND revision.board_id=board.id
		JOIN media_assets asset ON asset.account_id=link.account_id AND asset.id=link.media_asset_id AND asset.status<>'deleted'
		WHERE board.effective_level<>'none' AND ($3::text[] IS NULL OR asset.object_key=ANY($3::text[])) ORDER BY link.id`, accountID, actorID, keys)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		ref := PrivateStorageReference{Kind: "whiteboard_revision_assets", Origin: "whiteboards", BlockedReason: "Se conserva para recuperar una versión de la pizarra."}
		if err := rows.Scan(&ref.ID, &ref.ParentID, &ref.ObjectKey, &ref.Label, &ref.Filename, &ref.Version); err != nil {
			rows.Close()
			return nil, err
		}
		ref.Label += " · Historial"
		ref.Href = "/dashboard/whiteboards/" + ref.ParentID.String()
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	// Library documents are shared reusable content with their own mutation
	// contract. Surface authorized image usage without treating the library as
	// an editable scene or discarding its item structure during cleanup.
	rows, err = q.Query(ctx, `SELECT link.id,library.id,asset.object_key,library.name,asset.filename,library.version::text
		FROM whiteboard_assets link JOIN whiteboard_libraries library ON library.account_id=link.account_id AND library.id=link.library_id
		JOIN media_assets asset ON asset.account_id=link.account_id AND asset.id=link.media_asset_id AND asset.status='active'
		JOIN users actor ON actor.id=$2 AND actor.is_active
		JOIN user_accounts member ON member.account_id=library.account_id AND member.user_id=actor.id
		WHERE link.account_id=$1 AND link.kind='asset' AND library.archived_at IS NULL
		AND (library.created_by=actor.id OR library.visibility='account' OR member.role IN ('admin','super_admin') OR actor.is_super_admin)
		AND (link.committed_at IS NOT NULL OR link.uploaded_by=actor.id)
		AND ($3::text[] IS NULL OR asset.object_key=ANY($3::text[])) ORDER BY link.id`, accountID, actorID, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		ref := PrivateStorageReference{Kind: "whiteboard_assets", Origin: "whiteboards", BlockedReason: "Se conserva porque forma parte de una biblioteca de Pizarras."}
		if err := rows.Scan(&ref.ID, &ref.ParentID, &ref.ObjectKey, &ref.Label, &ref.Filename, &ref.Version); err != nil {
			return nil, err
		}
		ref.Label += " · Biblioteca"
		ref.Href = "/dashboard/whiteboards"
		refs = append(refs, ref)
	}
	return refs, rows.Err()
}

type storageWhiteboardElementChange struct {
	ID     string          `json:"id"`
	Before json.RawMessage `json:"before"`
	After  json.RawMessage `json:"after"`
}
type storageWhiteboardRemovalSnapshot struct {
	LinkID         uuid.UUID                        `json:"link_id"`
	BoardID        uuid.UUID                        `json:"board_id"`
	AssetID        uuid.UUID                        `json:"asset_id"`
	ObjectKey      string                           `json:"object_key"`
	FileID         string                           `json:"file_id"`
	UploadedBy     *uuid.UUID                       `json:"uploaded_by"`
	GuestSessionID *uuid.UUID                       `json:"guest_session_id"`
	CommittedAt    *time.Time                       `json:"committed_at"`
	DraftExpiresAt *time.Time                       `json:"draft_expires_at"`
	CreatedAt      time.Time                        `json:"created_at"`
	Elements       []storageWhiteboardElementChange `json:"elements"`
}

func AuthorizeWhiteboardStorageRemovalRecovery(actorID, linkID, boardID uuid.UUID, backup json.RawMessage) error {
	var snapshot storageWhiteboardRemovalSnapshot
	if json.Unmarshal(backup, &snapshot) != nil || snapshot.LinkID != linkID || snapshot.BoardID != boardID || snapshot.AssetID == uuid.Nil {
		return ErrWhiteboardInvalid
	}
	if snapshot.CommittedAt == nil && (snapshot.UploadedBy == nil || *snapshot.UploadedBy != actorID) {
		return ErrWhiteboardForbidden
	}
	return nil
}

func storageWhiteboardElement(raw json.RawMessage) (map[string]json.RawMessage, string, int64, error) {
	var fields map[string]json.RawMessage
	var id string
	var version int64
	if json.Unmarshal(raw, &fields) != nil || json.Unmarshal(fields["id"], &id) != nil || id == "" || json.Unmarshal(fields["version"], &version) != nil || version < 0 || version >= 9007199254740991 {
		return nil, "", 0, ErrWhiteboardInvalid
	}
	return fields, id, version, nil
}
func storageWhiteboardBump(fields map[string]json.RawMessage, version int64, deleted bool, now time.Time) json.RawMessage {
	fields["version"], _ = json.Marshal(version + 1)
	fields["isDeleted"], _ = json.Marshal(deleted)
	fields["updated"], _ = json.Marshal(now.UnixMilli())
	nonce := uuid.New()
	fields["versionNonce"], _ = json.Marshal(uint32(nonce[0])<<16 | uint32(nonce[1])<<8 | uint32(nonce[2]))
	raw, _ := json.Marshal(fields)
	return raw
}
func storageWhiteboardElements(scene json.RawMessage) ([]json.RawMessage, error) {
	var envelope struct {
		Elements []json.RawMessage `json:"elements"`
	}
	if json.Unmarshal(scene, &envelope) != nil {
		return nil, ErrWhiteboardInvalid
	}
	return envelope.Elements, nil
}
func storageWhiteboardEqual(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	ax, _ := json.Marshal(x)
	by, _ := json.Marshal(y)
	return string(ax) == string(by)
}

// Changes only canonical image deletion metadata. Opaque document/element
// extensions survive through the same reconciler used by ordinary edits.
func removeStorageWhiteboardElements(scene json.RawMessage, fileID string, now time.Time) (json.RawMessage, []storageWhiteboardElementChange, []json.RawMessage, error) {
	elements, err := storageWhiteboardElements(scene)
	if err != nil {
		return nil, nil, nil, err
	}
	changes := []storageWhiteboardElementChange{}
	patch := []json.RawMessage{}
	for _, raw := range elements {
		fields, id, version, err := storageWhiteboardElement(raw)
		if err != nil {
			return nil, nil, nil, err
		}
		var used string
		var deleted bool
		_ = json.Unmarshal(fields["fileId"], &used)
		_ = json.Unmarshal(fields["isDeleted"], &deleted)
		if used != fileID || deleted {
			continue
		}
		next := storageWhiteboardBump(fields, version, true, now)
		changes = append(changes, storageWhiteboardElementChange{id, raw, next})
		patch = append(patch, next)
	}
	if len(patch) == 0 {
		return scene, changes, patch, nil
	}
	next, _, err := whiteboardcore.MaterializeScenePatch(scene, patch, nil)
	if err != nil {
		return nil, nil, nil, err
	}
	actual, _ := storageWhiteboardElements(next)
	for _, raw := range actual {
		_, id, _, _ := storageWhiteboardElement(raw)
		for i := range changes {
			if changes[i].ID == id {
				changes[i].After = raw
			}
		}
	}
	return next, changes, patch, nil
}

func restoreStorageWhiteboardElements(scene json.RawMessage, changes []storageWhiteboardElementChange, now time.Time) (json.RawMessage, []json.RawMessage, error) {
	elements, err := storageWhiteboardElements(scene)
	if err != nil {
		return nil, nil, err
	}
	current := map[string]json.RawMessage{}
	for _, raw := range elements {
		_, id, _, err := storageWhiteboardElement(raw)
		if err != nil {
			return nil, nil, err
		}
		current[id] = raw
	}
	patch := []json.RawMessage{}
	for _, change := range changes {
		raw, found := current[change.ID]
		if !found || !storageWhiteboardEqual(raw, change.After) {
			return nil, nil, ErrWhiteboardConflict
		}
		_, id, version, err := storageWhiteboardElement(raw)
		if err != nil || id != change.ID {
			return nil, nil, ErrWhiteboardInvalid
		}
		fields, beforeID, _, err := storageWhiteboardElement(change.Before)
		if err != nil || beforeID != change.ID {
			return nil, nil, ErrWhiteboardInvalid
		}
		patch = append(patch, storageWhiteboardBump(fields, version, false, now))
	}
	if len(patch) == 0 {
		return scene, patch, nil
	}
	next, _, err := whiteboardcore.MaterializeScenePatch(scene, patch, nil)
	return next, patch, err
}

func (r *WhiteboardRepository) RemoveStorageReferenceTx(ctx context.Context, tx pgx.Tx, accountID, actorID, linkID, operationID uuid.UUID, expectedVersion string) (json.RawMessage, uuid.UUID, error) {
	var boardID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT board_id FROM whiteboard_assets WHERE account_id=$1 AND id=$2 AND kind='asset' AND board_id IS NOT NULL`, accountID, linkID).Scan(&boardID); err != nil {
		return nil, uuid.Nil, err
	}
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID); err != nil {
		return nil, uuid.Nil, err
	}
	if _, err := lockActiveWhiteboardMutationRowsTx(ctx, tx, accountID, boardID); err != nil {
		return nil, uuid.Nil, err
	}
	if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessEdit, false); err != nil {
		return nil, uuid.Nil, err
	}
	snapshot := storageWhiteboardRemovalSnapshot{LinkID: linkID, BoardID: boardID}
	err := tx.QueryRow(ctx, `SELECT link.media_asset_id,asset.object_key,link.file_id,link.uploaded_by,link.guest_session_id,link.committed_at,link.draft_expires_at,link.created_at
		FROM whiteboard_assets link JOIN media_assets asset ON asset.account_id=link.account_id AND asset.id=link.media_asset_id
		WHERE link.account_id=$1 AND link.id=$2 AND link.board_id=$3 AND link.kind='asset' AND asset.status='active' FOR UPDATE OF link,asset`, accountID, linkID, boardID).Scan(&snapshot.AssetID, &snapshot.ObjectKey, &snapshot.FileID, &snapshot.UploadedBy, &snapshot.GuestSessionID, &snapshot.CommittedAt, &snapshot.DraftExpiresAt, &snapshot.CreatedAt)
	if err != nil {
		return nil, uuid.Nil, err
	}
	if snapshot.CommittedAt == nil && (snapshot.UploadedBy == nil || *snapshot.UploadedBy != actorID || snapshot.DraftExpiresAt == nil || snapshot.DraftExpiresAt.After(time.Now())) {
		return nil, uuid.Nil, ErrWhiteboardForbidden
	}
	var currentVersion string
	if err := tx.QueryRow(ctx, `SELECT scene_sequence::text||':'||access_revision::text FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&currentVersion); err != nil {
		return nil, uuid.Nil, err
	}
	if currentVersion != expectedVersion {
		return nil, uuid.Nil, ErrWhiteboardConflict
	}
	scene := &domain.WhiteboardScene{BoardID: boardID}
	if err := tx.QueryRow(ctx, `SELECT scene_json,scene_schema_version,editor_version,scene_sequence FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&scene.Scene, &scene.SceneSchemaVersion, &scene.EditorVersion, &scene.Sequence); err != nil {
		return nil, uuid.Nil, err
	}
	next, changes, patch, err := removeStorageWhiteboardElements(scene.Scene, snapshot.FileID, time.Now().UTC())
	if err != nil {
		return nil, uuid.Nil, err
	}
	snapshot.Elements = changes
	if len(patch) > 0 {
		if err := r.applyStorageSceneTx(ctx, tx, accountID, actorID, operationID, scene, next, patch); err != nil {
			return nil, uuid.Nil, err
		}
	}
	// A draft has no scene reference and is removed explicitly here. Normal
	// committed links were removed by canonical reconciliation above.
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_assets WHERE account_id=$1 AND id=$2 AND board_id=$3`, accountID, linkID, boardID); err != nil {
		return nil, uuid.Nil, err
	}
	backup, _ := json.Marshal(snapshot)
	return backup, boardID, nil
}

func (r *WhiteboardRepository) RestoreStorageReferenceTx(ctx context.Context, tx pgx.Tx, accountID, actorID, operationID uuid.UUID, backup json.RawMessage) (uuid.UUID, error) {
	var snapshot storageWhiteboardRemovalSnapshot
	if json.Unmarshal(backup, &snapshot) != nil || snapshot.LinkID == uuid.Nil || snapshot.BoardID == uuid.Nil || snapshot.AssetID == uuid.Nil {
		return uuid.Nil, ErrWhiteboardInvalid
	}
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID); err != nil {
		return uuid.Nil, err
	}
	if _, err := lockActiveWhiteboardMutationRowsTx(ctx, tx, accountID, snapshot.BoardID); err != nil {
		return uuid.Nil, err
	}
	if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, snapshot.BoardID, domain.WhiteboardAccessEdit, false); err != nil {
		return uuid.Nil, err
	}
	var active bool
	if err := tx.QueryRow(ctx, `SELECT status='active' AND object_key=$3 FROM media_assets WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, snapshot.AssetID, snapshot.ObjectKey).Scan(&active); err != nil {
		return uuid.Nil, err
	}
	if !active {
		return uuid.Nil, ErrWhiteboardConflict
	}
	scene := &domain.WhiteboardScene{BoardID: snapshot.BoardID}
	if err := tx.QueryRow(ctx, `SELECT scene_json,scene_schema_version,editor_version,scene_sequence FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, snapshot.BoardID).Scan(&scene.Scene, &scene.SceneSchemaVersion, &scene.EditorVersion, &scene.Sequence); err != nil {
		return uuid.Nil, err
	}
	next, patch, err := restoreStorageWhiteboardElements(scene.Scene, snapshot.Elements, time.Now().UTC())
	if err != nil {
		return uuid.Nil, err
	}
	// ON CONFLICT does not replace a newer file mapping: restoration fails as a
	// whole if a user has already reused the original file identity.
	command, err := tx.Exec(ctx, `INSERT INTO whiteboard_assets(id,account_id,board_id,media_asset_id,file_id,kind,uploaded_by,committed_at,draft_expires_at,created_at,guest_session_id)
		VALUES($1,$2,$3,$4,$5,'asset',CASE WHEN EXISTS(SELECT 1 FROM user_accounts WHERE account_id=$2 AND user_id=$9::uuid) THEN $9::uuid ELSE $6::uuid END,
		$7,CASE WHEN $7::timestamptz IS NULL THEN NOW()+INTERVAL '1 hour' ELSE NULL END,$8,
		CASE WHEN EXISTS(SELECT 1 FROM whiteboard_guest_sessions WHERE account_id=$2 AND board_id=$3 AND id=$10::uuid) THEN $10::uuid ELSE NULL END)
		ON CONFLICT DO NOTHING`, snapshot.LinkID, accountID, snapshot.BoardID, snapshot.AssetID, snapshot.FileID, actorID, snapshot.CommittedAt, snapshot.CreatedAt, snapshot.UploadedBy, snapshot.GuestSessionID)
	if err != nil {
		return uuid.Nil, err
	}
	if command.RowsAffected() != 1 {
		return uuid.Nil, ErrWhiteboardConflict
	}
	if len(patch) > 0 {
		if err := r.applyStorageSceneTx(ctx, tx, accountID, actorID, operationID, scene, next, patch); err != nil {
			return uuid.Nil, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_media_gc_jobs WHERE account_id=$1 AND media_asset_id=$2`, accountID, snapshot.AssetID); err != nil {
		return uuid.Nil, err
	}
	return snapshot.BoardID, nil
}

func (r *WhiteboardRepository) applyStorageSceneTx(ctx context.Context, tx pgx.Tx, accountID, actorID, operationID uuid.UUID, current *domain.WhiteboardScene, next json.RawMessage, patch []json.RawMessage) error {
	encodedPatch, _ := json.Marshal(map[string]any{"elements": patch})
	hash := fmt.Sprintf("%x", sha256.Sum256(next))
	payloadHash := fmt.Sprintf("%x", sha256.Sum256(encodedPatch))
	_, err := r.ApplyScenePatchTx(ctx, tx, accountID, actorID, current.BoardID, WhiteboardSceneWriteInput{ExpectedSequence: current.Sequence, OperationID: operationID, Scene: next, Patch: encodedPatch, SceneSchemaVersion: current.SceneSchemaVersion, EditorVersion: current.EditorVersion, RequestPayloadHash: payloadHash, ResultSceneHash: hash})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE whiteboard_activity SET details=jsonb_set(details,'{origin}','"storage"'::jsonb) WHERE account_id=$1 AND board_id=$2 AND operation_id=$3`, accountID, current.BoardID, operationID)
	return err
}
