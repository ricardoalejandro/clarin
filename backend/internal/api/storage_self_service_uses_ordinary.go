package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/internal/ws"
)

type storageOrdinaryUseAdapter struct{}

func (storageOrdinaryUseAdapter) Name() string { return "ordinary" }

type storageOrdinaryState struct {
	Row         map[string]json.RawMessage   `json:"row"`
	Attachments []map[string]json.RawMessage `json:"attachments"`
}

func storageJSONText(row map[string]json.RawMessage, key string) string {
	var v string
	_ = json.Unmarshal(row[key], &v)
	return v
}
func storageJSONSet(row map[string]json.RawMessage, key string, value any) {
	row[key], _ = json.Marshal(value)
}
func storageJSONID(row map[string]json.RawMessage, key string) uuid.UUID {
	v, _ := uuid.Parse(storageJSONText(row, key))
	return v
}

func storageOrdinaryLoad(ctx context.Context, q storageSelfServiceQuerier, account, id uuid.UUID, kind string, lock bool) (storageOrdinaryState, error) {
	state := storageOrdinaryState{Attachments: []map[string]json.RawMessage{}}
	table, fields, attachmentTable := "", "", ""
	switch kind {
	case "chats":
		table = "messages"
		fields = "id,chat_id,media_url,media_asset_id,media_size,media_filename,media_deleted,media_deleted_at,(SELECT ma.object_key FROM media_assets ma WHERE ma.id=messages.media_asset_id AND ma.account_id=messages.account_id) AS canonical_asset_key"
	case "campaigns":
		table = "campaigns"
		fields = "id,name,message_template,media_url,media_type,status,settings,updated_at"
		attachmentTable = "campaign_attachments"
	case "quick_replies":
		table = "quick_replies"
		fields = "id,title,body,media_url,media_type,media_filename,items,updated_at"
		attachmentTable = "quick_reply_attachments"
	case "stickers":
		table = "saved_stickers"
		fields = "id,account_id,media_url,created_at"
	case "contacts":
		table = "contacts"
		fields = "id,name,avatar_url,avatar_media_asset_id,avatar_source,avatar_updated_at,avatar_revision,(SELECT ma.object_key FROM media_assets ma WHERE ma.id=contacts.avatar_media_asset_id AND ma.account_id=contacts.account_id) AS canonical_asset_key"
	default:
		return state, errStorageUseProtected
	}
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	var payload []byte
	err := q.QueryRow(ctx, `SELECT to_jsonb(r) FROM (SELECT `+fields+` FROM `+table+` WHERE account_id=$1 AND id=$2`+suffix+`) r`, account, id).Scan(&payload)
	if err != nil {
		return state, err
	}
	if err = json.Unmarshal(payload, &state.Row); err != nil {
		return state, err
	}
	if attachmentTable != "" {
		fk := "campaign_id"
		where := ""
		if kind == "quick_replies" {
			fk = "quick_reply_id"
			where = " AND account_id=$2"
		}
		args := []any{id}
		if where != "" {
			args = append(args, account)
		}
		attachmentPayload := "to_jsonb(a)"
		if kind == "quick_replies" {
			attachmentPayload = "to_jsonb(a)||jsonb_build_object('canonical_asset_key',(SELECT ma.object_key FROM media_assets ma WHERE ma.id=a.media_asset_id AND ma.account_id=a.account_id))"
		}
		rows, e := q.Query(ctx, `SELECT `+attachmentPayload+` FROM `+attachmentTable+` a WHERE `+fk+`=$1`+where+` ORDER BY position,id`+suffix, args...)
		if e != nil {
			return state, e
		}
		for rows.Next() {
			var raw []byte
			if e = rows.Scan(&raw); e != nil {
				rows.Close()
				return state, e
			}
			var item map[string]json.RawMessage
			if e = json.Unmarshal(raw, &item); e != nil {
				rows.Close()
				return state, e
			}
			state.Attachments = append(state.Attachments, item)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return state, e
		}
	}
	return state, nil
}

func (a storageOrdinaryUseAdapter) List(ctx context.Context, s *Server, q storageSelfServiceQuerier, actor storageUseActor, key string) ([]storageSelfServiceUse, error) {
	selected, bounded := storageReadSelectedIDs(ctx, a.Name())
	if bounded && len(selected) == 0 {
		return nil, nil
	}
	selectedIDs := make(map[uuid.UUID]bool, len(selected))
	for _, id := range selected {
		selectedIDs[id] = true
	}
	refs, err := storageSelfServiceObjectReferences(ctx, q, actor.AccountID, key, s.storage)
	if err != nil {
		return nil, err
	}
	linkedParents, err := storageOrdinaryParents(ctx, q, actor.AccountID, refs)
	if err != nil {
		return nil, err
	}
	parents := map[string]uuid.UUID{}
	coverage := map[string][]string{}
	for _, ref := range refs {
		if storage.IsProtectedMediaObjectKey(key) && !(ref.Origin == "contacts" && storage.IsAccountPrivateAvatarObjectKey(actor.AccountID, key)) {
			continue
		}
		switch ref.Origin {
		case "chats", "campaigns", "quick_replies", "stickers", "contacts":
		default:
			continue
		}
		if !storageSelfServiceHasPermission(actor.Claims, storageSelfServiceOriginPermission(ref.Origin)) {
			continue
		}
		id, e := uuid.Parse(ref.ID)
		if e != nil {
			continue
		}
		parent := id
		if linked, ok := linkedParents[ref.Origin+"|"+ref.ID]; ok {
			parent = linked
		}
		if bounded && !selectedIDs[parent] {
			continue
		}
		group := ref.Origin + "|" + parent.String()
		parents[group] = parent
		coverage[group] = append(coverage[group], ref.Origin+"|"+ref.ID)
	}
	groups := make([]string, 0, len(parents))
	for group := range parents {
		groups = append(groups, group)
	}
	sort.Strings(groups)
	if candidateOnly, _ := ctx.Value(storageReadUseCandidatesOnlyKey{}).(bool); candidateOnly {
		result := make([]storageSelfServiceUse, 0, len(groups))
		for _, group := range groups {
			kind := strings.SplitN(group, "|", 2)[0]
			id := parents[group]
			result = append(result, storageSelfServiceUse{UseID: storageUseID(actor.AccountID, a.Name(), id, kind, key), Type: kind, Adapter: a.Name(), AccountID: actor.AccountID, ObjectKey: key, SourceID: id, Slot: kind, ReferenceIDs: coverage[group]})
		}
		return result, nil
	}
	states, err := storageOrdinaryLoadGroups(ctx, q, actor.AccountID, parents)
	if err != nil {
		return nil, err
	}
	result := []storageSelfServiceUse{}
	for _, group := range groups {
		kind := strings.SplitN(group, "|", 2)[0]
		id := parents[group]
		state, found := states[group]
		if !found {
			continue
		}
		label, href := "Adjunto en Chats", "/dashboard/chats"
		parent := id
		switch kind {
		case "chats":
			parent = storageJSONID(state.Row, "chat_id")
			href += "?chat=" + parent.String()
		case "campaigns":
			label = storageJSONText(state.Row, "name")
			href = "/dashboard/broadcasts"
		case "quick_replies":
			label = storageJSONText(state.Row, "title")
			href = "/dashboard/settings?tab=quick-replies"
		case "stickers":
			label = "Sticker guardado"
		case "contacts":
			label = "Foto de " + storageJSONText(state.Row, "name")
			href = "/dashboard/contacts"
		}
		_, e := s.storageOrdinaryRemovedState(kind, key, state)
		if !storageOrdinaryCanManage(actor, kind) {
			e = errStorageUseProtected
		}
		filename := storageJSONText(state.Row, "media_filename")
		if filename == "" {
			for _, attachment := range state.Attachments {
				if s.sameOrdinaryMediaKey(storageJSONText(attachment, "media_url"), key) {
					filename = storageJSONText(attachment, "media_filename")
					if filename == "" {
						filename = storageJSONText(attachment, "file_name")
					}
					break
				}
			}
		}
		reason := ""
		if e != nil {
			reason = e.Error()
			if errors.Is(e, errStorageUseProtected) {
				reason = "Necesitas permiso para editar este contenido."
				if kind == "quick_replies" {
					href = "/dashboard/chats"
				}
			}
		}
		result = append(result, storageSelfServiceUse{UseID: storageUseID(actor.AccountID, a.Name(), id, kind, key), Type: kind, Label: label, Href: href, CanRemove: e == nil, BlockedReason: reason, Adapter: a.Name(), AccountID: actor.AccountID, ObjectKey: key, SourceID: id, ParentID: parent, Slot: kind, Filename: filename, Fingerprint: storageUseFingerprint(state), ReferenceIDs: coverage[group]})
	}
	return result, nil
}

// Only known media slots are edited. Unrecognized JSON remains a protected dependency.
func (s *Server) storageOrdinaryRemovedState(kind, key string, before storageOrdinaryState) (storageOrdinaryState, error) {
	raw, _ := json.Marshal(before)
	var after storageOrdinaryState
	_ = json.Unmarshal(raw, &after)
	matches := func(raw string) bool { return s.sameOrdinaryMediaKey(raw, key) }
	if kind == "chats" || kind == "contacts" {
		assetKey := storageJSONText(before.Row, "canonical_asset_key")
		if assetKey != "" && assetKey != key {
			return after, errStorageUseProtected
		}
		field := "media_url"
		if kind == "contacts" {
			field = "avatar_url"
		}
		if rawKey, stored := s.ordinaryObjectKeyFromURL(storageJSONText(before.Row, field)); stored && rawKey != key {
			return after, errStorageUseProtected
		}
	}
	switch kind {
	case "chats":
		storageJSONSet(after.Row, "media_url", nil)
		storageJSONSet(after.Row, "media_asset_id", nil)
		storageJSONSet(after.Row, "media_size", nil)
		storageJSONSet(after.Row, "media_deleted", true)
		storageJSONSet(after.Row, "media_deleted_at", storageUseNow())
	case "campaigns", "quick_replies":
		storageJSONSet(after.Row, "updated_at", storageUseNow())
		if kind == "campaigns" && storageJSONText(before.Row, "status") != "draft" {
			return after, fmt.Errorf("Las campañas programadas, activas o ya enviadas conservan sus medios.")
		}
		if kind == "campaigns" && storageJSONContainsKey(before.Row["settings"], key, s) {
			return after, fmt.Errorf("Este contenido forma parte de la configuración de la campaña y se conserva.")
		}
		removedIDs := map[string]bool{}
		after.Attachments = []map[string]json.RawMessage{}
		for _, att := range before.Attachments {
			assetKey := storageJSONText(att, "canonical_asset_key")
			urlKey, stored := s.ordinaryObjectKeyFromURL(storageJSONText(att, "media_url"))
			if assetKey != "" && ((assetKey == key && (!stored || urlKey != key)) || (stored && urlKey == key && assetKey != key)) {
				return after, errStorageUseProtected
			}
			if matches(storageJSONText(att, "media_url")) {
				removedIDs[storageJSONText(att, "id")] = true
			} else {
				after.Attachments = append(after.Attachments, att)
			}
		}
		if matches(storageJSONText(after.Row, "media_url")) {
			storageJSONSet(after.Row, "media_url", "")
			storageJSONSet(after.Row, "media_type", "")
			if kind == "quick_replies" {
				storageJSONSet(after.Row, "media_filename", "")
			}
		}
		if kind == "quick_replies" {
			var items []map[string]json.RawMessage
			if json.Unmarshal(before.Row["items"], &items) != nil {
				return after, errStorageUseProtected
			}
			kept := []map[string]json.RawMessage{}
			for _, item := range items {
				if removedIDs[storageJSONText(item, "attachment_id")] || matches(storageJSONText(item, "media_url")) {
					continue
				}
				kept = append(kept, item)
			}
			if len(kept) == 0 && strings.TrimSpace(storageJSONText(after.Row, "body")) != "" {
				item := map[string]json.RawMessage{}
				storageJSONSet(item, "id", uuid.New())
				storageJSONSet(item, "type", "text")
				storageJSONSet(item, "text", storageJSONText(after.Row, "body"))
				kept = append(kept, item)
			}
			storageJSONSet(after.Row, "items", kept)
			if storageJSONText(after.Row, "media_url") == "" && len(after.Attachments) > 0 {
				first := after.Attachments[0]
				storageJSONSet(after.Row, "media_url", storageJSONText(first, "media_url"))
				storageJSONSet(after.Row, "media_type", storageJSONText(first, "media_type"))
				storageJSONSet(after.Row, "media_filename", storageJSONText(first, "media_filename"))
			}
			hasText := strings.TrimSpace(storageJSONText(after.Row, "body")) != ""
			for _, item := range kept {
				if storageJSONText(item, "type") == "text" && strings.TrimSpace(storageJSONText(item, "text")) != "" {
					hasText = true
				}
			}
			if len(after.Attachments) == 0 && !hasText && storageJSONText(after.Row, "media_url") == "" {
				return after, fmt.Errorf("La respuesta rápida debe conservar texto u otro adjunto para poder enviarse.")
			}
		}
		candidate, _ := json.Marshal(after)
		if storageJSONContainsKey(candidate, key, s) {
			return after, errStorageUseProtected
		}
	case "stickers":
		after.Row = nil
	case "contacts":
		storageJSONSet(after.Row, "avatar_url", nil)
		storageJSONSet(after.Row, "avatar_media_asset_id", nil)
		storageJSONSet(after.Row, "avatar_source", nil)
		storageJSONSet(after.Row, "avatar_updated_at", storageUseNow())
		var revision int64
		_ = json.Unmarshal(before.Row["avatar_revision"], &revision)
		storageJSONSet(after.Row, "avatar_revision", revision+1)
	default:
		return after, errStorageUseProtected
	}
	return after, nil
}
func storageJSONContainsKey(raw []byte, key string, s *Server) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	var walk func(any) bool
	walk = func(v any) bool {
		switch item := v.(type) {
		case string:
			return item == key || s.sameOrdinaryMediaKey(item, key)
		case []any:
			for _, v := range item {
				if walk(v) {
					return true
				}
			}
		case map[string]any:
			for _, v := range item {
				if walk(v) {
					return true
				}
			}
		}
		return false
	}
	return walk(value)
}

func storageOrdinarySave(ctx context.Context, tx pgx.Tx, account, id uuid.UUID, kind string, state storageOrdinaryState) error {
	raw, _ := json.Marshal(state.Row)
	query := ""
	switch kind {
	case "chats":
		query = `UPDATE messages m SET media_url=r.media_url,media_asset_id=r.media_asset_id,media_size=r.media_size,media_deleted=r.media_deleted,media_deleted_at=r.media_deleted_at FROM jsonb_populate_record(NULL::messages,$3::jsonb) r WHERE m.account_id=$1 AND m.id=$2`
	case "contacts":
		query = `UPDATE contacts c SET avatar_url=r.avatar_url,avatar_media_asset_id=r.avatar_media_asset_id,avatar_source=r.avatar_source,avatar_updated_at=r.avatar_updated_at,avatar_revision=r.avatar_revision,updated_at=NOW() FROM jsonb_populate_record(NULL::contacts,$3::jsonb) r WHERE c.account_id=$1 AND c.id=$2`
	case "campaigns":
		query = `UPDATE campaigns c SET media_url=r.media_url,media_type=r.media_type,updated_at=r.updated_at FROM jsonb_populate_record(NULL::campaigns,$3::jsonb) r WHERE c.account_id=$1 AND c.id=$2 AND c.status='draft'`
	case "quick_replies":
		query = `UPDATE quick_replies q SET media_url=r.media_url,media_type=r.media_type,media_filename=r.media_filename,items=r.items,updated_at=r.updated_at FROM jsonb_populate_record(NULL::quick_replies,$3::jsonb) r WHERE q.account_id=$1 AND q.id=$2`
	case "stickers":
		if state.Row == nil {
			_, e := tx.Exec(ctx, `DELETE FROM saved_stickers WHERE account_id=$1 AND id=$2`, account, id)
			return e
		}
		_, e := tx.Exec(ctx, `INSERT INTO saved_stickers SELECT * FROM jsonb_populate_record(NULL::saved_stickers,$1::jsonb)`, raw)
		return e
	}
	tag, err := tx.Exec(ctx, query, account, id, raw)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errStorageUseChanged
	}
	if kind == "campaigns" || kind == "quick_replies" {
		table, fk := "campaign_attachments", "campaign_id"
		if kind == "quick_replies" {
			table = "quick_reply_attachments"
			fk = "quick_reply_id"
		}
		// Parent was locked and account-checked before this helper. Preserve IDs/order of retained attachments.
		if _, err = tx.Exec(ctx, `DELETE FROM `+table+` WHERE `+fk+`=$1`, id); err != nil {
			return err
		}
		for _, attachment := range state.Attachments {
			payload, _ := json.Marshal(attachment)
			if _, err = tx.Exec(ctx, `INSERT INTO `+table+` SELECT * FROM jsonb_populate_record(NULL::`+table+`,$1::jsonb)`, payload); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a storageOrdinaryUseAdapter) Detach(ctx context.Context, s *Server, tx pgx.Tx, actor storageUseActor, use storageSelfServiceUse) (storageUseSnapshot, error) {
	snap := storageUseSnapshot{Version: 1, Adapter: a.Name(), UseID: use.UseID, AccountID: actor.AccountID, ObjectKey: use.ObjectKey, SourceID: use.SourceID, ParentID: use.ParentID, Slot: use.Slot, Type: use.Type, Label: use.Label, Href: use.Href}
	if !storageOrdinaryCanManage(actor, use.Type) {
		return snap, errStorageUseProtected
	}
	before, err := storageOrdinaryLoad(ctx, tx, actor.AccountID, use.SourceID, use.Slot, true)
	if err != nil {
		return snap, err
	}
	if storageUseFingerprint(before) != use.Fingerprint {
		return snap, errStorageUseChanged
	}
	after, err := s.storageOrdinaryRemovedState(use.Slot, use.ObjectKey, before)
	if err != nil {
		return snap, err
	}
	if err = storageOrdinarySave(ctx, tx, actor.AccountID, use.SourceID, use.Slot, after); err != nil {
		return snap, err
	}
	if use.Slot != "stickers" {
		after, err = storageOrdinaryLoad(ctx, tx, actor.AccountID, use.SourceID, use.Slot, false)
		if err != nil {
			return snap, err
		}
	}
	snap.Before, _ = json.Marshal(before)
	snap.After, _ = json.Marshal(after)
	return snap, nil
}
func (a storageOrdinaryUseAdapter) Restore(ctx context.Context, s *Server, tx pgx.Tx, actor storageUseActor, snap storageUseSnapshot) error {
	if err := a.AuthorizeRecovery(ctx, s, tx, actor, snap, "restore"); err != nil {
		return err
	}
	var before, after storageOrdinaryState
	if json.Unmarshal(snap.Before, &before) != nil || json.Unmarshal(snap.After, &after) != nil {
		return errStorageUseRestoreConflict
	}
	current, err := storageOrdinaryLoad(ctx, tx, actor.AccountID, snap.SourceID, snap.Slot, true)
	if snap.Slot == "stickers" && errors.Is(err, pgx.ErrNoRows) {
		return storageOrdinarySave(ctx, tx, actor.AccountID, snap.SourceID, snap.Slot, before)
	}
	if err != nil {
		return err
	}
	if storageUseFingerprint(current) != storageUseFingerprint(after) {
		return errStorageUseRestoreConflict
	}
	if snap.Slot == "contacts" {
		var revision int64
		_ = json.Unmarshal(current.Row["avatar_revision"], &revision)
		storageJSONSet(before.Row, "avatar_revision", revision+1)
		storageJSONSet(before.Row, "avatar_updated_at", storageUseNow())
	}
	return storageOrdinarySave(ctx, tx, actor.AccountID, snap.SourceID, snap.Slot, before)
}
func (a storageOrdinaryUseAdapter) AuthorizeRecovery(ctx context.Context, s *Server, q storageSelfServiceQuerier, actor storageUseActor, snap storageUseSnapshot, action string) error {
	if !storageSelfServiceHasPermission(actor.Claims, storageSelfServiceOriginPermission(snap.Type)) || (action != "read" && !storageOrdinaryCanManage(actor, snap.Type)) {
		return errStorageUseProtected
	}
	if snap.Slot == "campaigns" && action == "restore" {
		var status string
		if err := q.QueryRow(ctx, `SELECT status FROM campaigns WHERE account_id=$1 AND id=$2`, actor.AccountID, snap.SourceID).Scan(&status); err != nil {
			return err
		}
		if status != "draft" {
			return errStorageUseProtected
		}
	}
	return nil
}
func (a storageOrdinaryUseAdapter) AfterCommit(ctx context.Context, s *Server, actor storageUseActor, snapshots []storageUseSnapshot, action string) {
	result := storageCleanupResult{Action: action}
	for _, snap := range snapshots {
		if snap.Type == "campaigns" {
			s.invalidateCampaignsCache(actor.AccountID)
		}
		if snap.Type == "quick_replies" && s.hub != nil {
			if reply, err := s.repos.QuickReply.GetByID(ctx, actor.AccountID, snap.SourceID); err == nil {
				s.hub.BroadcastToAccountWithPermission(actor.AccountID, domain.PermChats, ws.EventQuickReplyUpdate, map[string]any{"action": "updated", "quick_reply": reply, "quick_reply_id": snap.SourceID})
			}
		}
		if snap.Type == "contacts" {
			if record, err := s.repos.ContactAvatar.Get(ctx, actor.AccountID, snap.SourceID); err == nil {
				s.afterContactAvatarChange(actor.AccountID, snap.SourceID, record, "avatar_updated")
			}
		}
		if snap.Type == "chats" {
			result.Items = append(result.Items, storageCleanupItemResult{ObjectKey: snap.ObjectKey, Status: "completed"})
		}
	}
	if len(result.Items) > 0 {
		s.storageSelfServiceReconcileMessages(actor.AccountID, result)
	}
}

func storageOrdinaryCanManage(actor storageUseActor, kind string) bool {
	return storageSelfServiceHasPermission(actor.Claims, domain.PermSettings) && storageSelfServiceHasPermission(actor.Claims, storageSelfServiceOriginPermission(kind)) && (kind != "quick_replies" || storageSelfServiceHasPermission(actor.Claims, domain.PermQuickRepliesManage))
}
