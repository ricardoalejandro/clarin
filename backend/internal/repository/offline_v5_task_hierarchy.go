package repository

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// Offline grants never raise the canonical actor's permissions. Structural and
// access-governance writes remain online; per-task grants may lower list access.
func offlineV5TaskAccess(rank int, edit, comment bool) *domain.TaskEffectiveAccess {
	level := domain.TaskAccessNone
	if rank >= 1 {
		level = domain.TaskAccessView
	}
	if rank >= 2 && comment {
		level = domain.TaskAccessComment
	}
	if rank >= 3 && edit {
		level = domain.TaskAccessEdit
	}
	access := buildTaskEffectiveAccess(level, false, "offline_prepared")
	access.CanComment = access.CanComment && comment
	return access
}

// Copy only ancestors of this selected list, never siblings or account-wide
// counts. Hidden folder identity is removed even when a direct list grant exists.
func offlineV5EnrichTaskHierarchy(ctx context.Context, tx pgx.Tx, accountID, userID, listID uuid.UUID, object map[string]any, canEdit, canComment bool) error {
	var listRaw, environmentRaw, folderRaw json.RawMessage
	var listRank int
	err := tx.QueryRow(ctx, `SELECT jsonb_build_object(
		'id',list_item.id,'account_id',list_item.account_id,'environment_id',list_item.environment_id,
		'folder_id',CASE WHEN (`+taskActorFolderAccessRankSQL("folder", "$3")+`)>=1 THEN folder.id END,
		'folder_name',CASE WHEN (`+taskActorFolderAccessRankSQL("folder", "$3")+`)>=1 THEN folder.name END,
		'workflow_id',list_item.workflow_id,'workflow_inherited',list_item.workflow_inherited,
		'is_default',list_item.is_default,'name',list_item.name,'description',list_item.description,
		'color',list_item.color,'icon',list_item.icon,'sort_order',list_item.sort_order,
		'access_revision',list_item.access_revision,'access_mode',list_item.access_mode,
		'created_at',list_item.created_at,'updated_at',list_item.updated_at,'created_by',list_item.created_by),
		jsonb_build_object('id',environment.id,'account_id',environment.account_id,'name',environment.name,
		'description',environment.description,'color',environment.color,'icon',environment.icon,'sort_order',environment.sort_order,
		'is_default',environment.is_default,'version',environment.version,'access_revision',environment.access_revision,
		'created_at',environment.created_at,'updated_at',environment.updated_at),
		CASE WHEN folder.id IS NOT NULL AND (`+taskActorFolderAccessRankSQL("folder", "$3")+`)>=1 THEN jsonb_build_object(
		'id',folder.id,'account_id',folder.account_id,'environment_id',folder.environment_id,'workflow_id',folder.workflow_id,
		'name',folder.name,'description',folder.description,'color',folder.color,'icon','folder','sort_order',folder.sort_order,
		'access_revision',folder.access_revision,'created_at',folder.created_at,'updated_at',folder.updated_at) ELSE 'null'::jsonb END,
		(`+taskActorListAccessRankSQL("list_item", "$3")+`)
		FROM task_lists list_item
		JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id
		LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
		WHERE list_item.account_id=$1 AND list_item.id=$2 AND list_item.archived_at IS NULL AND list_item.deleted_at IS NULL
		AND environment.archived_at IS NULL AND environment.deleted_at IS NULL
		AND (folder.id IS NULL OR (folder.archived_at IS NULL AND folder.deleted_at IS NULL))
		AND (`+taskActorListAccessRankSQL("list_item", "$3")+`)>=1`, accountID, listID, userID).Scan(&listRaw, &environmentRaw, &folderRaw, &listRank)
	if err != nil {
		return err
	}
	var list, environment, folder map[string]any
	if err = json.Unmarshal(listRaw, &list); err != nil {
		return err
	}
	if err = json.Unmarshal(environmentRaw, &environment); err != nil {
		return err
	}
	if err = json.Unmarshal(folderRaw, &folder); err != nil {
		return err
	}
	// Preserve workflow/environment labels from the original minimal projection.
	if previous, ok := object["list"].(map[string]any); ok {
		for _, key := range []string{"workflow_name", "environment_name"} {
			list[key] = previous[key]
		}
	}
	listAccess := offlineV5TaskAccess(listRank, canEdit, canComment)
	list["permissions"], list["capabilities"], list["effective_access_level"] = listAccess, listAccess, listAccess.Level
	list["can_manage_access"], list["can_create"] = false, listAccess.CanEdit
	read := offlineV5TaskAccess(1, false, false)
	for _, ancestor := range []map[string]any{environment, folder} {
		if ancestor == nil {
			continue
		}
		ancestor["permissions"], ancestor["capabilities"], ancestor["effective_access_level"] = read, read, read.Level
		ancestor["can_manage_access"] = false
	}
	object["list"], object["environment"], object["folder"] = list, environment, folder
	object["work_projection_version"] = 1
	return nil
}
