package api

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
)

// Resolve attachment mirrors once, not once per reference of a shared file.
func storageOrdinaryParents(ctx context.Context, q storageSelfServiceQuerier, account uuid.UUID, refs []storageSelfServiceReference) (map[string]uuid.UUID, error) {
	ids := []uuid.UUID{}
	for _, ref := range refs {
		if ref.Origin == "campaigns" || ref.Origin == "quick_replies" {
			if id, err := uuid.Parse(ref.ID); err == nil {
				ids = append(ids, id)
			}
		}
	}
	result := map[string]uuid.UUID{}
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := q.Query(ctx, `SELECT 'campaigns',a.id,a.campaign_id FROM campaign_attachments a JOIN campaigns c ON c.id=a.campaign_id AND c.account_id=$1 WHERE a.id=ANY($2::uuid[])
 UNION ALL SELECT 'quick_replies',a.id,a.quick_reply_id FROM quick_reply_attachments a WHERE a.account_id=$1 AND a.id=ANY($2::uuid[])`, account, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind string
		var id, parent uuid.UUID
		if err = rows.Scan(&kind, &id, &parent); err != nil {
			return nil, err
		}
		result[kind+"|"+id.String()] = parent
	}
	return result, rows.Err()
}

// Each business kind is hydrated in one round trip after the SQL use page.
// Parent attachments remain ordered and canonical for capability calculation.
func storageOrdinaryLoadGroups(ctx context.Context, q storageSelfServiceQuerier, account uuid.UUID, parents map[string]uuid.UUID) (map[string]storageOrdinaryState, error) {
	grouped := map[string][]uuid.UUID{}
	for group, id := range parents {
		kind := strings.SplitN(group, "|", 2)[0]
		grouped[kind] = append(grouped[kind], id)
	}
	result := map[string]storageOrdinaryState{}
	for kind, ids := range grouped {
		table, fields, attachments := "", "", "'[]'::jsonb"
		switch kind {
		case "chats":
			table = "messages"
			fields = "id,chat_id,media_url,media_asset_id,media_size,media_filename,media_deleted,media_deleted_at,(SELECT ma.object_key FROM media_assets ma WHERE ma.id=messages.media_asset_id AND ma.account_id=messages.account_id) AS canonical_asset_key"
		case "campaigns":
			table = "campaigns"
			fields = "id,name,message_template,media_url,media_type,status,settings,updated_at"
			attachments = "COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.position,a.id) FROM campaign_attachments a WHERE a.campaign_id=r.id),'[]'::jsonb)"
		case "quick_replies":
			table = "quick_replies"
			fields = "id,title,body,media_url,media_type,media_filename,items,updated_at"
			attachments = "COALESCE((SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('canonical_asset_key',(SELECT ma.object_key FROM media_assets ma WHERE ma.id=a.media_asset_id AND ma.account_id=a.account_id)) ORDER BY a.position,a.id) FROM quick_reply_attachments a WHERE a.account_id=$1 AND a.quick_reply_id=r.id),'[]'::jsonb)"
		case "stickers":
			table = "saved_stickers"
			fields = "id,account_id,media_url,created_at"
		case "contacts":
			table = "contacts"
			fields = "id,name,avatar_url,avatar_media_asset_id,avatar_source,avatar_updated_at,avatar_revision,(SELECT ma.object_key FROM media_assets ma WHERE ma.id=contacts.avatar_media_asset_id AND ma.account_id=contacts.account_id) AS canonical_asset_key"
		default:
			return nil, errStorageUseProtected
		}
		rows, err := q.Query(ctx, "SELECT r.id,to_jsonb(r),"+attachments+" FROM (SELECT "+fields+" FROM "+table+" WHERE account_id=$1 AND id=ANY($2::uuid[])) r", account, ids)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id uuid.UUID
			var raw, items []byte
			var state storageOrdinaryState
			if err = rows.Scan(&id, &raw, &items); err != nil {
				rows.Close()
				return nil, err
			}
			if err = json.Unmarshal(raw, &state.Row); err != nil {
				rows.Close()
				return nil, err
			}
			if err = json.Unmarshal(items, &state.Attachments); err != nil {
				rows.Close()
				return nil, err
			}
			result[kind+"|"+id.String()] = state
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}
