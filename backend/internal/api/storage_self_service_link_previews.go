package api

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type storageLinkPreviewUseAdapter struct{}

// Startup/upload failures remain durable inventory candidates after a full day.
// Live references and recoveries are checked separately under the deletion barrier.
const storageLinkPreviewAssetSQL = `content_hash LIKE 'link_preview:%' AND object_key LIKE account_id::text||'/link-previews/%'`
const storageLinkPreviewAssetLeaseSQL = `(` + storageLinkPreviewAssetSQL + `) AND updated_at>NOW()-INTERVAL '24 hours' AND status<>'deleted'`

func init() {
	storageAdditionalUseAdapters = append(storageAdditionalUseAdapters, storageLinkPreviewUseAdapter{})
}
func (storageLinkPreviewUseAdapter) Name() string { return "link_preview" }

func storagePreviewReferenceID(slot string, id uuid.UUID) string {
	if slot == "group_edit" {
		return "edit-preview:" + id.String()
	}
	return "preview:" + id.String()
}
func storagePreviewReferenceSourceID(kind, id string) string {
	if kind == "messages" {
		return strings.TrimPrefix(id, "preview:")
	}
	if kind == "chat_group_message_state" {
		return strings.TrimPrefix(id, "edit-preview:")
	}
	return id
}
func storagePreviewReference(ref storageSelfServiceReference) (string, uuid.UUID, bool) {
	if ref.Origin != "chats" {
		return "", uuid.Nil, false
	}
	slot, prefix := "message", "preview:"
	if strings.HasPrefix(ref.ID, "edit-preview:") {
		slot, prefix = "group_edit", "edit-preview:"
	}
	if !strings.HasPrefix(ref.ID, prefix) {
		return "", uuid.Nil, false
	}
	id, err := uuid.Parse(strings.TrimPrefix(ref.ID, prefix))
	return slot, id, err == nil
}

// Snapshot only the independent thumbnail slot, plus its content revision.
// Read receipts, reactions and the main attachment do not conflict or roll back.
type storageLinkPreviewState struct {
	ChatID   uuid.UUID       `json:"chat_id"`
	Preview  json.RawMessage `json:"preview"`
	AssetID  *uuid.UUID      `json:"asset_id"`
	Key      string          `json:"canonical_key"`
	Body     string          `json:"body"`
	EditedAt string          `json:"edited_at"`
	Revoked  bool            `json:"revoked"`
}

func storageLinkPreviewTable(slot string) (string, string, string) {
	if slot == "message" {
		return "messages", "link_preview", "link_preview_media_asset_id"
	}
	if slot == "group_edit" {
		return "chat_group_message_state", "edited_link_preview", "edited_link_preview_media_asset_id"
	}
	return "", "", ""
}
func storageLinkPreviewSelect(slot string) string {
	table, preview, asset := storageLinkPreviewTable(slot)
	if table == "" {
		return ""
	}
	body, edited, revoked := "COALESCE(r.body,'')", "COALESCE(r.edited_at::text,'')", "COALESCE(r.is_revoked,false)"
	if slot == "group_edit" {
		body, edited, revoked = "COALESCE(r.edited_body,'')", "COALESCE(r.edited_at::text,'')", "r.revoked"
	}
	// Messages use is_edited and body as their revision; edited_at is provider
	// state only and is not a column in the message table.
	if slot == "message" {
		edited = "COALESCE(r.is_edited,false)::text"
	}
	return `r.chat_id,r.` + preview + `,r.` + asset + `,COALESCE(ma.object_key,''),` + body + `,` + edited + `,` + revoked + ` FROM ` + table + ` r LEFT JOIN media_assets ma ON ma.account_id=r.account_id AND ma.id=r.` + asset + ` WHERE r.account_id=$1`
}
func storageLoadLinkPreview(ctx context.Context, q storageSelfServiceQuerier, account, id uuid.UUID, slot string, lock bool) (storageLinkPreviewState, error) {
	var state storageLinkPreviewState
	selectSQL := storageLinkPreviewSelect(slot)
	if selectSQL == "" {
		return state, errStorageUseProtected
	}
	suffix := ""
	if lock {
		suffix = " FOR UPDATE OF r"
	}
	err := q.QueryRow(ctx, `SELECT `+selectSQL+` AND r.id=$2`+suffix, account, id).Scan(&state.ChatID, &state.Preview, &state.AssetID, &state.Key, &state.Body, &state.EditedAt, &state.Revoked)
	return state, err
}
func (s *Server) storageRemoveLinkPreview(key string, state storageLinkPreviewState) (storageLinkPreviewState, error) {
	if state.Revoked || (state.Key != "" && state.Key != key) {
		return state, errStorageUseProtected
	}
	var preview map[string]json.RawMessage
	if json.Unmarshal(state.Preview, &preview) != nil || preview == nil {
		return state, errStorageUseProtected
	}
	url := storageJSONText(preview, "thumbnail_url")
	if state.Key == "" && !s.sameOrdinaryMediaKey(url, key) {
		return state, errStorageUseProtected
	}
	if url != "" && !s.sameOrdinaryMediaKey(url, key) {
		return state, errStorageUseProtected
	}
	delete(preview, "thumbnail_url")
	state.Preview, _ = json.Marshal(preview)
	state.AssetID = nil
	state.Key = ""
	return state, nil
}
func storageSaveLinkPreview(ctx context.Context, tx pgx.Tx, account, id uuid.UUID, slot string, state storageLinkPreviewState) error {
	table, preview, asset := storageLinkPreviewTable(slot)
	if table == "" {
		return errStorageUseProtected
	}
	tag, err := tx.Exec(ctx, `UPDATE `+table+` SET `+preview+`=$3,`+asset+`=$4 WHERE account_id=$1 AND id=$2`, account, id, state.Preview, state.AssetID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errStorageUseChanged
	}
	return nil
}
func (a storageLinkPreviewUseAdapter) List(ctx context.Context, s *Server, q storageSelfServiceQuerier, actor storageUseActor, key string) ([]storageSelfServiceUse, error) {
	if !storageSelfServiceHasPermission(actor.Claims, domain.PermChats) {
		return nil, nil
	}
	selected, bounded := storageReadSelectedIDs(ctx, a.Name())
	if bounded && len(selected) == 0 {
		return nil, nil
	}
	ids := map[uuid.UUID]bool{}
	for _, id := range selected {
		ids[id] = true
	}
	refs, err := storageSelfServiceObjectReferences(ctx, q, actor.AccountID, key, s.storage)
	if err != nil {
		return nil, err
	}
	var result []storageSelfServiceUse
	groups := map[string][]uuid.UUID{}
	candidateOnly, _ := ctx.Value(storageReadUseCandidatesOnlyKey{}).(bool)
	for _, ref := range refs {
		slot, id, ok := storagePreviewReference(ref)
		if ok && (!bounded || ids[id]) {
			groups[slot] = append(groups[slot], id)
			if candidateOnly {
				result = append(result, storageSelfServiceUse{UseID: storageUseID(actor.AccountID, a.Name(), id, slot, key), Type: "chats", Adapter: a.Name(), AccountID: actor.AccountID, ObjectKey: key, SourceID: id, Slot: slot, ReferenceIDs: []string{"chats|" + ref.ID}})
			}
		}
	}
	if candidateOnly {
		return result, nil
	}
	states := map[string]storageLinkPreviewState{}
	for slot, sourceIDs := range groups {
		rows, e := q.Query(ctx, `SELECT r.id,`+storageLinkPreviewSelect(slot)+` AND r.id=ANY($2::uuid[])`, actor.AccountID, sourceIDs)
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var id uuid.UUID
			var state storageLinkPreviewState
			if e = rows.Scan(&id, &state.ChatID, &state.Preview, &state.AssetID, &state.Key, &state.Body, &state.EditedAt, &state.Revoked); e != nil {
				rows.Close()
				return nil, e
			}
			states[slot+"|"+id.String()] = state
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
	}
	for _, ref := range refs {
		slot, id, ok := storagePreviewReference(ref)
		if !ok || (bounded && !ids[id]) {
			continue
		}
		state, found := states[slot+"|"+id.String()]
		if !found {
			continue
		}
		_, e := s.storageRemoveLinkPreview(key, state)
		canRemove := e == nil && storageOrdinaryCanManage(actor, "chats")
		reason := ""
		if !canRemove {
			reason = "Necesitas permiso para gestionar esta miniatura."
		}
		result = append(result, storageSelfServiceUse{UseID: storageUseID(actor.AccountID, a.Name(), id, slot, key), Type: "chats", Label: "Vista previa de enlace", Href: "/dashboard/chats?open=" + state.ChatID.String(), CanRemove: canRemove, BlockedReason: reason, Adapter: a.Name(), AccountID: actor.AccountID, ObjectKey: key, SourceID: id, ParentID: state.ChatID, Slot: slot, Filename: "link-preview.jpg", Fingerprint: storageUseFingerprint(state), ReferenceIDs: []string{"chats|" + ref.ID}})
	}
	return result, nil
}
func (a storageLinkPreviewUseAdapter) Detach(ctx context.Context, s *Server, tx pgx.Tx, actor storageUseActor, use storageSelfServiceUse) (storageUseSnapshot, error) {
	snap := storageUseSnapshot{Version: 1, Adapter: a.Name(), UseID: use.UseID, AccountID: actor.AccountID, ObjectKey: use.ObjectKey, SourceID: use.SourceID, ParentID: use.ParentID, Slot: use.Slot, Type: "chats", Label: use.Label, Href: use.Href}
	if !storageOrdinaryCanManage(actor, "chats") || use.AccountID != actor.AccountID {
		return snap, errStorageUseProtected
	}
	before, err := storageLoadLinkPreview(ctx, tx, actor.AccountID, use.SourceID, use.Slot, true)
	if err != nil {
		return snap, err
	}
	if storageUseFingerprint(before) != use.Fingerprint {
		return snap, errStorageUseChanged
	}
	after, err := s.storageRemoveLinkPreview(use.ObjectKey, before)
	if err != nil {
		return snap, err
	}
	if err = storageSaveLinkPreview(ctx, tx, actor.AccountID, use.SourceID, use.Slot, after); err != nil {
		return snap, err
	}
	after, err = storageLoadLinkPreview(ctx, tx, actor.AccountID, use.SourceID, use.Slot, false)
	if err != nil {
		return snap, err
	}
	snap.Before, _ = json.Marshal(before)
	snap.After, _ = json.Marshal(after)
	return snap, nil
}
func (a storageLinkPreviewUseAdapter) AuthorizeRecovery(_ context.Context, _ *Server, _ storageSelfServiceQuerier, actor storageUseActor, snap storageUseSnapshot, action string) error {
	if snap.AccountID != actor.AccountID || !storageSelfServiceHasPermission(actor.Claims, domain.PermChats) || (action != "read" && !storageOrdinaryCanManage(actor, "chats")) {
		return errStorageUseProtected
	}
	return nil
}
func (a storageLinkPreviewUseAdapter) Restore(ctx context.Context, s *Server, tx pgx.Tx, actor storageUseActor, snap storageUseSnapshot) error {
	if err := a.AuthorizeRecovery(ctx, s, tx, actor, snap, "restore"); err != nil {
		return err
	}
	var before, after storageLinkPreviewState
	if json.Unmarshal(snap.Before, &before) != nil || json.Unmarshal(snap.After, &after) != nil {
		return errStorageUseRestoreConflict
	}
	current, err := storageLoadLinkPreview(ctx, tx, actor.AccountID, snap.SourceID, snap.Slot, true)
	if err != nil {
		return err
	}
	if storageUseFingerprint(current) != storageUseFingerprint(after) {
		return errStorageUseRestoreConflict
	}
	return storageSaveLinkPreview(ctx, tx, actor.AccountID, snap.SourceID, snap.Slot, before)
}
func (a storageLinkPreviewUseAdapter) AfterCommit(ctx context.Context, s *Server, actor storageUseActor, snaps []storageUseSnapshot, action string) {
	result := storageCleanupResult{Action: action}
	for _, snap := range snaps {
		if snap.Slot == "message" {
			result.Items = append(result.Items, storageCleanupItemResult{ObjectKey: snap.ObjectKey, Status: "completed"})
		}
	}
	s.storageSelfServiceReconcileMessages(actor.AccountID, result)
}
