package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrTaskRemovalPreviewChanged = errors.New("task removal preview changed")
	ErrTaskRemovalInvalid        = errors.New("invalid task container removal")
)

type taskRemovalScope struct {
	preview              *domain.TaskContainerRemovalPreview
	listIDs              []uuid.UUID
	retainedListIDs      []uuid.UUID
	futureSharedEventIDs []uuid.UUID
	directViews          int
	archived             bool
	destinationArchived  bool
	sourceManage         bool
	destinationManage    bool
}

func taskRemovalHash(value any) string {
	raw, _ := json.Marshal(value)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func validateTaskRemovalRequest(targetType string, req domain.TaskContainerRemovalRequest) error {
	if (targetType != "list" && targetType != "folder") || (req.Mode != "trash_all" && req.Mode != "preserve_contents") {
		return ErrTaskRemovalInvalid
	}
	if req.DestinationListID != nil && *req.DestinationListID == uuid.Nil {
		return ErrTaskRemovalInvalid
	}
	if req.Mode == "trash_all" && req.DestinationListID != nil {
		return ErrTaskRemovalInvalid
	}
	return nil
}

// lockTaskRemovalParentsTx uses the same hierarchy-before-view-before-board
// ordering as contextual whiteboard mutations. No view is locked before its
// source and destination structural rows have been locked and revalidated.
func lockTaskRemovalParentsTx(ctx context.Context, tx pgx.Tx, accountID, actorID, targetID uuid.UUID, targetType string, req domain.TaskContainerRemovalRequest) error {
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return err
	}
	folderIDs := []uuid.UUID{}
	listIDs := []uuid.UUID{}
	if targetType == "folder" {
		folderIDs = append(folderIDs, targetID)
	} else {
		listIDs = append(listIDs, targetID)
	}
	if req.DestinationListID != nil {
		listIDs = append(listIDs, *req.DestinationListID)
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT folder_id FROM task_lists WHERE account_id=$1 AND id=ANY($2::uuid[]) AND folder_id IS NOT NULL ORDER BY folder_id`, accountID, listIDs)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		folderIDs = append(folderIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	rows, err = tx.Query(ctx, `SELECT id FROM task_folders WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, accountID, folderIDs)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	rows, err = tx.Query(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND (id=ANY($2::uuid[]) OR ($3::text='folder' AND folder_id=$4) OR ($5::boolean AND folder_id IS NULL AND environment_id=(SELECT environment_id FROM task_folders WHERE account_id=$1 AND id=$4))) ORDER BY id FOR UPDATE`, accountID, listIDs, targetType, targetID, targetType == "folder" && req.Mode == "preserve_contents")
	if err != nil {
		return err
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var environmentID uuid.UUID
	table := "task_lists"
	if targetType == "folder" {
		table = "task_folders"
	}
	if err := tx.QueryRow(ctx, `SELECT environment_id FROM `+table+` WHERE account_id=$1 AND id=$2`, accountID, targetID).Scan(&environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessView, false); err != nil {
		return err
	}
	// Acquire all graph dependencies before the authority barrier. ACL writers
	// also lock their resource first; taking the account barrier before a task
	// or environment row would invert that order and deadlock a concurrent ACL.
	rows, err = tx.Query(ctx, `SELECT DISTINCT COALESCE(item.workflow_id,folder.workflow_id,workflow.id) AS workflow_id FROM task_lists item LEFT JOIN task_folders folder ON folder.account_id=item.account_id AND folder.id=item.folder_id LEFT JOIN task_workflows workflow ON workflow.account_id=item.account_id AND workflow.environment_id=item.environment_id AND workflow.is_default WHERE item.account_id=$1 AND (item.id=ANY($2::uuid[]) OR ($3::text='folder' AND item.folder_id=$4)) ORDER BY workflow_id`, accountID, listIDs, targetType, targetID)
	if err != nil {
		return err
	}
	workflowIDs := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		workflowIDs = append(workflowIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, id := range workflowIDs {
		if err := lockTaskWorkflowStatuses(ctx, tx, accountID, id); err != nil {
			return err
		}
	}
	for _, resourceTable := range []string{"tasks", "work_events"} {
		rows, err = tx.Query(ctx, `SELECT resource.id FROM `+resourceTable+` resource JOIN task_lists item ON item.account_id=resource.account_id AND item.id=resource.list_id WHERE resource.account_id=$1 AND (item.id=ANY($2::uuid[]) OR ($3::text='folder' AND item.folder_id=$4)) ORDER BY resource.id FOR UPDATE OF resource`, accountID, listIDs, targetType, targetID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
	}
	return nil
}

func loadTaskRemovalScopeTx(ctx context.Context, tx pgx.Tx, accountID, actorID, targetID uuid.UUID, targetType string, req domain.TaskContainerRemovalRequest, whiteboardsEnabled bool, lock bool) (*taskRemovalScope, error) {
	if err := validateTaskRemovalRequest(targetType, req); err != nil {
		return nil, err
	}
	p := &domain.TaskContainerRemovalPreview{Type: targetType, ID: targetID, Mode: req.Mode, DestinationListID: req.DestinationListID, Blockers: []string{}, CanExecute: true}
	s := &taskRemovalScope{preview: p, listIDs: []uuid.UUID{}, retainedListIDs: []uuid.UUID{}, futureSharedEventIDs: []uuid.UUID{}}
	var deletedAt, archivedAt *time.Time
	var rank int
	var isDefault bool
	query := `SELECT item.name,item.environment_id,item.deleted_at,item.archived_at,FALSE,(` + taskActorFolderAccessRankSQL("item", "$3") + `),(` + taskActorFolderCanManageSQL("item", "$3") + `) FROM task_folders item WHERE item.account_id=$1 AND item.id=$2`
	if targetType == "list" {
		query = `SELECT item.name,item.environment_id,item.deleted_at,COALESCE(item.archived_at,(SELECT archived_at FROM task_folders WHERE account_id=item.account_id AND id=item.folder_id)),item.is_default,(` + taskActorListAccessRankSQL("item", "$3") + `),(` + taskActorListCanManageSQL("item", "$3") + `) FROM task_lists item WHERE item.account_id=$1 AND item.id=$2 AND NOT EXISTS(SELECT 1 FROM task_folders parent WHERE parent.account_id=item.account_id AND parent.id=item.folder_id AND parent.deleted_at IS NOT NULL)`
	}
	if err := tx.QueryRow(ctx, query, accountID, targetID, actorID).Scan(&p.Name, &p.EnvironmentID, &deletedAt, &archivedAt, &isDefault, &rank, &s.sourceManage); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if rank < 1 {
		return nil, ErrTaskWorkNotFound
	}
	if rank < 4 {
		p.CanExecute = false
		p.Blockers = append(p.Blockers, "Necesitas Administrar en este recurso")
	}
	if lock {
		if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, p.EnvironmentID, domain.TaskAccessView, false); err != nil {
			return nil, err
		}
	} else {
		access, _, err := resolveEnvironmentAccessWith(ctx, tx, accountID, actorID, p.EnvironmentID)
		if err != nil {
			return nil, err
		}
		if !TaskAccessAllows(access, domain.TaskAccessView) {
			return nil, ErrTaskWorkNotFound
		}
		var environmentDeleted bool
		if err := tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM task_environments WHERE account_id=$1 AND id=$2`, accountID, p.EnvironmentID).Scan(&environmentDeleted); err != nil {
			return nil, err
		}
		if environmentDeleted {
			return nil, ErrTaskWorkNotFound
		}
	}
	if deletedAt != nil {
		return nil, ErrTaskWorkNotFound
	}
	if isDefault {
		p.CanExecute = false
		p.Blockers = append(p.Blockers, "La bandeja predeterminada debe permanecer")
	}
	var environmentArchived bool
	if err := tx.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM task_environments WHERE account_id=$1 AND id=$2`, accountID, p.EnvironmentID).Scan(&environmentArchived); err != nil {
		return nil, err
	}
	s.archived = archivedAt != nil || environmentArchived
	p.Lifecycle = domain.TaskLifecycleActive
	if s.archived {
		p.Lifecycle = domain.TaskLifecycleArchived
	}
	rows, err := tx.Query(ctx, `SELECT item.id,item.deleted_at,(`+taskActorListAccessRankSQL("item", "$4")+`) FROM task_lists item WHERE item.account_id=$1 AND (($3::text='list' AND item.id=$2) OR ($3::text='folder' AND item.folder_id=$2)) ORDER BY item.id`, accountID, targetID, targetType, actorID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id uuid.UUID
		var deleted *time.Time
		var access int
		if err := rows.Scan(&id, &deleted, &access); err != nil {
			rows.Close()
			return nil, err
		}
		s.listIDs = append(s.listIDs, id)
		if deleted == nil {
			if access < 1 {
				rows.Close()
				return nil, ErrTaskWorkNotFound
			}
			s.retainedListIDs = append(s.retainedListIDs, id)
			if access < 4 {
				p.CanExecute = false
				p.Blockers = append(p.Blockers, "No puedes administrar todo el contenido")
			}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if targetType == "folder" {
		p.Counts.Lists = len(s.retainedListIDs)
	}
	// Lock the complete task/event set before evaluating versions and eligibility.
	if lock {
		for _, table := range []string{"tasks", "work_events"} {
			rows, err = tx.Query(ctx, `SELECT id FROM `+table+` WHERE account_id=$1 AND list_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, accountID, s.listIDs)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var id uuid.UUID
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return nil, err
				}
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return nil, err
			}
			rows.Close()
		}
	}
	var invisible, insufficient int
	err = tx.QueryRow(ctx, `SELECT COUNT(*) FILTER(WHERE task.parent_task_id IS NULL AND task.deleted_at IS NULL)::int,
		COUNT(*) FILTER(WHERE task.parent_task_id IS NOT NULL AND task.deleted_at IS NULL)::int,
		COUNT(*) FILTER(WHERE task.parent_task_id IS NULL AND task.deleted_at IS NULL AND `+taskOpenCategorySQL("task", "status")+`)::int,
		COUNT(*) FILTER(WHERE task.parent_task_id IS NULL AND task.deleted_at IS NULL AND COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' ELSE '' END)='done')::int,
		COUNT(*) FILTER(WHERE task.parent_task_id IS NULL AND task.deleted_at IS NULL AND COALESCE(status.category,CASE task.status WHEN 'cancelled' THEN 'cancelled' ELSE '' END)='cancelled')::int,
		COUNT(*) FILTER(WHERE task.deleted_at IS NULL AND (`+taskActorAccessRankSQL("task", "item", "$3")+`)<1)::int,
		COUNT(*) FILTER(WHERE task.deleted_at IS NULL AND (`+taskActorAccessRankSQL("task", "item", "$3")+`)<4)::int
		FROM tasks task JOIN task_lists item ON item.account_id=task.account_id AND item.id=task.list_id
		LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id WHERE task.account_id=$1 AND task.list_id=ANY($2::uuid[])`, accountID, s.listIDs, actorID).Scan(&p.Counts.Tasks, &p.Counts.Subtasks, &p.Counts.OpenTasks, &p.Counts.CompletedTasks, &p.Counts.CancelledTasks, &invisible, &insufficient)
	if err != nil {
		return nil, err
	}
	if invisible > 0 {
		return nil, ErrTaskWorkNotFound
	}
	if insufficient > 0 {
		p.CanExecute = false
		p.Blockers = append(p.Blockers, "No puedes administrar todas las tareas")
	}
	err = tx.QueryRow(ctx, `SELECT COUNT(*)::int FROM work_events WHERE account_id=$1 AND list_id=ANY($2::uuid[]) AND deleted_at IS NULL`, accountID, s.listIDs).Scan(&p.Counts.Events)
	if err != nil {
		return nil, err
	}
	if req.Mode == "trash_all" {
		s.futureSharedEventIDs, err = futureSharedWorkEventIDsWith(ctx, tx, accountID, s.listIDs, time.Now())
		if err != nil {
			return nil, err
		}
	}
	p.RequiresEventCancellation = len(s.futureSharedEventIDs) > 0
	canUseViews, err := actorCanUseTaskLocationViewsWith(ctx, tx, accountID, actorID)
	if err != nil {
		return nil, err
	}
	var boards, visibleBoards int
	err = tx.QueryRow(ctx, `SELECT COUNT(*)::int,COUNT(*) FILTER(WHERE view_item.folder_id=$3)::int,
		COUNT(*) FILTER(WHERE $6::boolean AND `+taskTrashLocationViewCanViewSQL("view_item", "$5")+`)::int
		FROM task_location_views view_item JOIN task_location_whiteboard_views binding ON binding.account_id=view_item.account_id AND binding.task_view_id=view_item.id JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id WHERE view_item.account_id=$1 AND (view_item.list_id=ANY($2::uuid[]) OR ($4::text='folder' AND view_item.folder_id=$3)) AND view_item.deleted_at IS NULL AND board.archived_at IS NULL`, accountID, s.retainedListIDs, targetID, targetType, actorID, whiteboardsEnabled && canUseViews).Scan(&boards, &s.directViews, &visibleBoards)
	if err != nil {
		return nil, err
	}
	if whiteboardsEnabled && canUseViews {
		p.Counts.Whiteboards = visibleBoards
	}
	if boards > visibleBoards {
		// Container access is not authority over a restricted contextual view.
		// Do not disclose its identity/count or silently change its availability.
		p.CanExecute = false
		p.Blockers = append(p.Blockers, "No tienes permisos suficientes para gestionar todo el contenido de esta ubicación")
	}
	p.RequiresName = p.Counts.Lists+p.Counts.Tasks+p.Counts.Subtasks+p.Counts.Events+p.Counts.Whiteboards > 0
	if req.Mode == "preserve_contents" {
		if boards > 0 && !canUseViews {
			return nil, ErrTaskAccessDenied
		}
		if boards > 0 {
			boardQuery := strings.Replace(whiteboardActorAccessQuery, "board.id=$3", `board.id IN(SELECT binding.whiteboard_id FROM task_location_whiteboard_views binding JOIN task_location_views view_item ON view_item.account_id=binding.account_id AND view_item.id=binding.task_view_id WHERE view_item.account_id=$1 AND (view_item.list_id=ANY($3::uuid[]) OR ($5::text='folder' AND view_item.folder_id=$4)) AND view_item.deleted_at IS NULL) AND board.archived_at IS NULL`, 1)
			boardRows, err := tx.Query(ctx, boardQuery, accountID, actorID, s.retainedListIDs, targetID, targetType)
			if err != nil {
				return nil, err
			}
			for boardRows.Next() {
				state, err := scanWhiteboardActorAccessState(boardRows)
				if err != nil {
					boardRows.Close()
					return nil, err
				}
				access, _, err := resolveWhiteboardActorAccessState(state, actorID, false)
				if err != nil {
					boardRows.Close()
					return nil, err
				}
				if access == nil || access.Level != domain.WhiteboardAccessManage || !access.CanManageAccess {
					p.CanExecute = false
					p.Blockers = append(p.Blockers, "Necesitas administrar las pizarras y su acceso para trasladarlas")
				}
			}
			if err := boardRows.Err(); err != nil {
				boardRows.Close()
				return nil, err
			}
			boardRows.Close()
		}
		p.RequiresDestination = (targetType == "list" && (p.Counts.Tasks+p.Counts.Subtasks+p.Counts.Events+boards) > 0) || (targetType == "folder" && s.directViews > 0)
		if p.RequiresDestination && req.DestinationListID == nil {
			p.CanExecute = false
			p.Blockers = append(p.Blockers, "Selecciona una lista de destino")
		}
		if req.DestinationListID != nil {
			var env uuid.UUID
			var destinationDeleted, destinationArchived *time.Time
			var destinationRank int
			var folderDeleted *time.Time
			var folderArchived *time.Time
			err = tx.QueryRow(ctx, `SELECT item.environment_id,item.deleted_at,item.archived_at,folder.deleted_at,folder.archived_at,(`+taskActorListAccessRankSQL("item", "$3")+`),(`+taskActorListCanManageSQL("item", "$3")+`) FROM task_lists item LEFT JOIN task_folders folder ON folder.account_id=item.account_id AND folder.id=item.folder_id WHERE item.account_id=$1 AND item.id=$2`, accountID, *req.DestinationListID, actorID).Scan(&env, &destinationDeleted, &destinationArchived, &folderDeleted, &folderArchived, &destinationRank, &s.destinationManage)
			if errors.Is(err, pgx.ErrNoRows) || destinationRank < 1 {
				return nil, ErrTaskWorkNotFound
			}
			if err != nil {
				return nil, err
			}
			s.destinationArchived = destinationArchived != nil || folderArchived != nil || environmentArchived
			if env != p.EnvironmentID || destinationDeleted != nil || folderDeleted != nil || s.archived != s.destinationArchived || *req.DestinationListID == targetID {
				p.CanExecute = false
				p.Blockers = append(p.Blockers, "La lista de destino no es compatible")
			}
			if destinationRank < 3 {
				p.CanExecute = false
				p.Blockers = append(p.Blockers, "Necesitas Editar en la lista de destino")
			}
		}
		p.RequiresAccessConfirmation = (targetType == "folder" && len(s.retainedListIDs) > 0) || p.RequiresDestination
		if p.RequiresAccessConfirmation {
			p.AccessChangeSummary = "El contenido conservará sus permisos explícitos y heredará el acceso de su nueva ubicación."
			if !s.sourceManage || (req.DestinationListID != nil && !s.destinationManage) {
				p.CanExecute = false
				p.Blockers = append(p.Blockers, "Necesitas administrar el acceso de origen y destino")
			}
			if targetType == "folder" && len(s.retainedListIDs) > 0 {
				var canManageChildren bool
				if err := tx.QueryRow(ctx, `SELECT COALESCE(bool_and((`+taskActorListCanManageSQL("item", "$3")+`)),TRUE) FROM task_lists item WHERE item.account_id=$1 AND item.id=ANY($2::uuid[])`, accountID, s.retainedListIDs, actorID).Scan(&canManageChildren); err != nil {
					return nil, err
				}
				if !canManageChildren {
					p.CanExecute = false
					p.Blockers = append(p.Blockers, "Necesitas administrar el acceso de todas las listas que conservarás")
				}
			}
		}
		if boards > 0 && !whiteboardsEnabled {
			p.CanExecute = false
			p.Blockers = append(p.Blockers, "Activa las vistas de Pizarra para conservar y trasladar su contenido")
		}
		if targetType == "list" && req.DestinationListID != nil {
			var missing bool
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks task LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id JOIN task_lists destination ON destination.account_id=task.account_id AND destination.id=$3 LEFT JOIN task_folders destination_folder ON destination_folder.account_id=destination.account_id AND destination_folder.id=destination.folder_id LEFT JOIN task_workflows fallback ON fallback.account_id=destination.account_id AND fallback.environment_id=destination.environment_id AND fallback.is_default WHERE task.account_id=$1 AND task.list_id=$2 AND COALESCE(task.parent_task_id,task.id) IN(SELECT id FROM tasks WHERE account_id=$1 AND list_id=$2 AND parent_task_id IS NULL AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM task_statuses replacement WHERE replacement.account_id=task.account_id AND replacement.workflow_id=COALESCE(destination.workflow_id,destination_folder.workflow_id,fallback.id) AND replacement.category=COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)))`, accountID, targetID, *req.DestinationListID).Scan(&missing)
			if err != nil {
				return nil, err
			}
			if missing {
				p.CanExecute = false
				p.Blockers = append(p.Blockers, "El destino no tiene estados equivalentes para todas las tareas")
			}
		}
	}
	// The token includes content, lifecycle and all account ACL revisions. It is
	// evidence of what was reviewed, never authority to bypass mutation checks.
	var canonical string
	err = tx.QueryRow(ctx, `SELECT jsonb_build_object(
		'lists',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id) FROM task_lists item WHERE item.account_id=$1 AND (item.id=ANY($2::uuid[]) OR item.id=$3)),
		'folders',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id) FROM task_folders item WHERE item.account_id=$1 AND (item.id=$4 OR item.id IN(SELECT folder_id FROM task_lists WHERE account_id=$1 AND (id=$3 OR id=ANY($2::uuid[]))))),
		'tasks',(SELECT jsonb_agg(jsonb_build_array(id,version,list_id,status_id,parent_task_id,deleted_at,access_revision) ORDER BY id) FROM tasks WHERE account_id=$1 AND list_id=ANY($2::uuid[])),
		'events',(SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id) FROM work_events event WHERE event.account_id=$1 AND event.list_id=ANY($2::uuid[])),
		'attendees',(SELECT jsonb_agg(to_jsonb(attendee) ORDER BY attendee.event_id,attendee.user_id) FROM work_event_attendees attendee WHERE attendee.account_id=$1 AND attendee.event_id IN(SELECT id FROM work_events WHERE account_id=$1 AND list_id=ANY($2::uuid[]))),
		'views',(SELECT jsonb_agg(to_jsonb(view_item) ORDER BY view_item.id) FROM task_location_views view_item WHERE view_item.account_id=$1 AND (view_item.list_id=ANY($2::uuid[]) OR view_item.folder_id=$4)),
		'boards',(SELECT jsonb_agg(jsonb_build_array(board.id,board.access_revision,board.archived_at) ORDER BY board.id) FROM whiteboards board JOIN task_location_whiteboard_views binding ON binding.account_id=board.account_id AND binding.whiteboard_id=board.id JOIN task_location_views view_item ON view_item.account_id=binding.account_id AND view_item.id=binding.task_view_id WHERE view_item.account_id=$1 AND (view_item.list_id=ANY($2::uuid[]) OR view_item.folder_id=$4)),
		'env',(SELECT to_jsonb(item) FROM task_environments item WHERE item.account_id=$1 AND item.id=$5),
		'eg',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.environment_id,item.user_id) FROM task_environment_grants item WHERE item.account_id=$1 AND item.environment_id=$5),
		'fg',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.folder_id,item.user_id) FROM task_folder_access_grants item WHERE item.account_id=$1 AND (item.folder_id=$4 OR item.folder_id IN(SELECT folder_id FROM task_lists WHERE account_id=$1 AND (id=ANY($2::uuid[]) OR id=$3)))),
		'lg',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.list_id,item.user_id) FROM task_list_access_grants item WHERE item.account_id=$1 AND (item.list_id=ANY($2::uuid[]) OR item.list_id=$3)),
		'tg',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.task_id,item.user_id) FROM task_access_grants item WHERE item.account_id=$1 AND item.task_id IN(SELECT id FROM tasks WHERE account_id=$1 AND list_id=ANY($2::uuid[]))),
		'statuses',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id) FROM task_statuses item JOIN task_workflows workflow ON workflow.account_id=item.account_id AND workflow.id=item.workflow_id WHERE item.account_id=$1 AND workflow.environment_id=$5),
		'overrides',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.event_id,item.occurrence_key) FROM work_event_occurrence_overrides item WHERE item.account_id=$1 AND item.event_id IN(SELECT id FROM work_events WHERE account_id=$1 AND list_id=ANY($2::uuid[]))),
		'visibility',(SELECT jsonb_agg(to_jsonb(item) ORDER BY item.task_view_id,item.user_id) FROM task_location_view_visibility_members item WHERE item.account_id=$1 AND item.task_view_id IN(SELECT id FROM task_location_views WHERE account_id=$1 AND (list_id=ANY($2::uuid[]) OR folder_id=$4))))::text`, accountID, s.listIDs, req.DestinationListID, targetID, p.EnvironmentID).Scan(&canonical)
	if err != nil {
		return nil, err
	}
	p.PreviewToken = taskRemovalHash([]any{accountID, actorID, targetID, targetType, req.Mode, req.DestinationListID, canonical, whiteboardsEnabled, p.RequiresEventCancellation})
	return s, nil
}

func (r *TaskWorkRepository) PreviewTaskContainerRemoval(ctx context.Context, accountID, actorID, targetID uuid.UUID, targetType string, req domain.TaskContainerRemovalRequest, workWhiteboardViewsEnabled bool) (*domain.TaskContainerRemovalPreview, error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	s, err := loadTaskRemovalScopeTx(ctx, tx, accountID, actorID, targetID, targetType, req, workWhiteboardViewsEnabled, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.preview, nil
}

func taskRemovalRequestHash(actorID, targetID uuid.UUID, targetType string, req domain.TaskContainerRemovalRequest) string {
	return taskRemovalHash([]any{actorID, targetID, targetType, req})
}

func taskRemovalConfirmationsValid(p *domain.TaskContainerRemovalPreview, req domain.TaskContainerRemovalRequest) error {
	if req.PreviewToken == "" || req.PreviewToken != p.PreviewToken {
		return ErrTaskRemovalPreviewChanged
	}
	if !p.CanExecute {
		return ErrTaskRemovalInvalid
	}
	if p.RequiresName && req.ConfirmationName != p.Name {
		return ErrTaskTrashConfirmation
	}
	if p.RequiresEventCancellation && !req.CancelFutureEvents {
		return ErrWorkEventCancelRequired
	}
	if p.RequiresAccessConfirmation && !req.ConfirmAccessChanges {
		return ErrTaskAccessInvalid
	}
	return nil
}

// lockTaskContainerAccountReferenceTx protects any account-FK inserts performed
// by removal or its reminder-aware restoration, in account -> actor order.
func lockTaskContainerAccountReferenceTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	if err := tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR KEY SHARE`, accountID).Scan(new(uuid.UUID)); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	return nil
}

func (r *TaskWorkRepository) RemoveTaskContainer(ctx context.Context, accountID, actorID, targetID uuid.UUID, targetType string, req domain.TaskContainerRemovalRequest, operationID uuid.UUID, workWhiteboardViewsEnabled bool) (*domain.TaskContainerRemovalResult, error) {
	if operationID == uuid.Nil {
		return nil, ErrTaskRemovalInvalid
	}
	if err := validateTaskRemovalRequest(targetType, req); err != nil {
		return nil, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// A client operation is unique throughout the account, including across
	// retries from different sessions. A changed payload never reuses a result.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('clarin:container-removal:'||$1::text||':'||$2::text,0))`, accountID, operationID); err != nil {
		return nil, err
	}
	// The operation ledger has an account FK. Reserve that parent key before
	// taking the actor lock, matching purge's account -> actor order. Otherwise
	// its later INSERT could wait on a purge which is already waiting for this
	// actor, even when the two operations concern unrelated containers.
	if err := lockTaskContainerAccountReferenceTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	requestHash := taskRemovalRequestHash(actorID, targetID, targetType, req)
	var storedHash string
	var resultRaw []byte
	var storedBoards []uuid.UUID
	var restoredAt *time.Time
	err = tx.QueryRow(ctx, `SELECT request_hash,result_json,whiteboard_ids,restored_at FROM task_container_removal_operations WHERE account_id=$1 AND operation_id=$2`, accountID, operationID).Scan(&storedHash, &resultRaw, &storedBoards, &restoredAt)
	if err == nil {
		if strings.TrimSpace(storedHash) != requestHash || restoredAt != nil {
			return nil, ErrTaskRemovalPreviewChanged
		}
		result := &domain.TaskContainerRemovalResult{}
		if err := json.Unmarshal(resultRaw, result); err != nil {
			return nil, err
		}
		result.WhiteboardIDs = storedBoards
		result.Replayed = true
		if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, targetID, targetType, domain.TaskAccessFull); err != nil {
			return nil, err
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err := lockTaskRemovalParentsTx(ctx, tx, accountID, actorID, targetID, targetType, req); err != nil {
		return nil, err
	}
	// Existing ACL writers use this final authority barrier. Evaluate the
	// preview again after obtaining it so a confirmed token cannot survive a
	// concurrent access downgrade or unseen content change.
	if err := lockWhiteboardAuthorityAccountTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	s, err := loadTaskRemovalScopeTx(ctx, tx, accountID, actorID, targetID, targetType, req, workWhiteboardViewsEnabled, true)
	if err != nil {
		return nil, err
	}
	if err := taskRemovalConfirmationsValid(s.preview, req); err != nil {
		return nil, err
	}
	result := &domain.TaskContainerRemovalResult{OperationID: operationID, Type: targetType, ID: targetID, EnvironmentID: s.preview.EnvironmentID, Action: "trashed", Mode: req.Mode}
	resultRaw, err = json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_container_removal_operations(account_id,operation_id,actor_id,target_type,target_id,mode,request_hash,result_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, accountID, operationID, actorID, targetType, targetID, req.Mode, requestHash, resultRaw); err != nil {
		return nil, err
	}
	folderIDs := []uuid.UUID{}
	if targetType == "folder" {
		folderIDs = append(folderIDs, targetID)
	}
	boards, err := bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(ctx, tx, accountID, s.preview.EnvironmentID, folderIDs, s.listIDs, false)
	if err != nil {
		return nil, err
	}
	result.WhiteboardIDs = boards
	if req.Mode == "trash_all" {
		err = trashTaskRemovalScopeTx(ctx, tx, accountID, actorID, targetID, targetType, operationID, s)
	} else {
		err = preserveTaskRemovalScopeTx(ctx, tx, accountID, actorID, targetID, targetType, operationID, req, s)
	}
	if err != nil {
		return nil, err
	}
	// The ordinary lifecycle invariant remains true at the commit boundary.
	var retained int
	if targetType == "list" {
		err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND list_id=$2 AND deleted_at IS NULL`, accountID, targetID).Scan(&retained)
	} else {
		err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks task JOIN task_lists item ON item.account_id=task.account_id AND item.id=task.list_id WHERE task.account_id=$1 AND item.folder_id=$2 AND task.deleted_at IS NULL`, accountID, targetID).Scan(&retained)
	}
	if err != nil {
		return nil, err
	}
	if retained > 0 {
		return nil, ErrTaskContainerNotEmpty
	}
	if targetType == "list" {
		err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM work_events WHERE account_id=$1 AND list_id=$2 AND deleted_at IS NULL`, accountID, targetID).Scan(&retained)
	} else {
		err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM work_events event JOIN task_lists item ON item.account_id=event.account_id AND item.id=event.list_id WHERE event.account_id=$1 AND item.folder_id=$2 AND event.deleted_at IS NULL`, accountID, targetID).Scan(&retained)
	}
	if err != nil {
		return nil, err
	}
	if retained > 0 {
		return nil, ErrTaskContainerHasWorkEvents
	}
	if _, err := tx.Exec(ctx, `UPDATE task_container_removal_operations SET whiteboard_ids=$3::uuid[] WHERE account_id=$1 AND operation_id=$2`, accountID, operationID, boards); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

func recordTaskRemovalRowsTx(ctx context.Context, tx pgx.Tx, accountID, operationID uuid.UUID, table, resourceType, predicate string, args ...any) error {
	// table, resourceType and predicate are private, constant call-site values.
	parameters := []any{accountID, operationID, resourceType}
	parameters = append(parameters, args...)
	state := `jsonb_strip_nulls(jsonb_build_object('deleted_at',item.deleted_at,'deleted_by',to_jsonb(item)->'deleted_by','archived_at',to_jsonb(item)->'archived_at','folder_id',to_jsonb(item)->'folder_id','list_id',to_jsonb(item)->'list_id','workflow_id',to_jsonb(item)->'workflow_id','sort_order',to_jsonb(item)->'sort_order','archived_with_folder',to_jsonb(item)->'archived_with_folder'))`
	if resourceType == "task_reminder" {
		state = "to_jsonb(item)"
	} else if table == "task_reminders" {
		return ErrTaskRemovalInvalid
	}
	_, err := tx.Exec(ctx, `INSERT INTO task_container_removal_items(account_id,operation_id,resource_type,resource_id,previous_state) SELECT item.account_id,$2,$3::text,item.id,`+state+` FROM `+table+` item WHERE item.account_id=$1 AND `+predicate+` ON CONFLICT DO NOTHING`, parameters...)
	return err
}

func trashTaskRemovalScopeTx(ctx context.Context, tx pgx.Tx, accountID, actorID, targetID uuid.UUID, targetType string, operationID uuid.UUID, s *taskRemovalScope) error {
	if err := recordTaskRemovalRowsTx(ctx, tx, accountID, operationID, "tasks", "task", `item.list_id=ANY($4::uuid[]) AND item.deleted_at IS NULL`, s.listIDs); err != nil {
		return err
	}
	if err := recordTaskRemovalRowsTx(ctx, tx, accountID, operationID, "work_events", "event", `item.list_id=ANY($4::uuid[]) AND item.deleted_at IS NULL`, s.listIDs); err != nil {
		return err
	}
	if err := recordTaskRemovalRowsTx(ctx, tx, accountID, operationID, "task_reminders", "task_reminder", `item.task_id IN(SELECT id FROM tasks WHERE account_id=$1 AND list_id=ANY($4::uuid[]) AND deleted_at IS NULL)`, s.listIDs); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE work_events SET status='cancelled',cancelled_at=NOW(),cancelled_by=$3 WHERE account_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`, accountID, s.futureSharedEventIDs, actorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_reminders WHERE account_id=$1 AND task_id IN(SELECT id FROM tasks WHERE account_id=$1 AND list_id=ANY($2::uuid[]) AND deleted_at IS NULL)`, accountID, s.listIDs); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE tasks SET deleted_at=NOW(),deleted_by=$3,trash_operation_id=$4,version=COALESCE(version,1)+1,updated_at=NOW() WHERE account_id=$1 AND list_id=ANY($2::uuid[]) AND deleted_at IS NULL`, accountID, s.listIDs, actorID, operationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE work_events SET deleted_at=NOW(),deleted_by=$3,trash_operation_id=$4,operation_id=$4,version=version+1,updated_at=NOW() WHERE account_id=$1 AND list_id=ANY($2::uuid[]) AND deleted_at IS NULL`, accountID, s.listIDs, actorID, operationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE work_event_reminder_jobs SET cancelled_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND event_id IN(SELECT id FROM work_events WHERE account_id=$1 AND trash_operation_id=$2) AND delivered_at IS NULL AND cancelled_at IS NULL`, accountID, operationID); err != nil {
		return err
	}
	if targetType == "folder" {
		if err := recordTaskRemovalRowsTx(ctx, tx, accountID, operationID, "task_lists", "list", `item.folder_id=$4 AND item.deleted_at IS NULL`, targetID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE task_lists SET deleted_at=NOW(),deleted_by=$3,trash_operation_id=$4,deleted_with_folder=TRUE,updated_at=NOW() WHERE account_id=$1 AND folder_id=$2 AND deleted_at IS NULL AND NOT is_default`, accountID, targetID, actorID, operationID); err != nil {
			return err
		}
	}
	return trashTaskRemovalTargetTx(ctx, tx, accountID, actorID, targetID, targetType, operationID)
}

func trashTaskRemovalTargetTx(ctx context.Context, tx pgx.Tx, accountID, actorID, targetID uuid.UUID, targetType string, operationID uuid.UUID) error {
	table := "task_lists"
	if targetType == "folder" {
		table = "task_folders"
	}
	if err := recordTaskRemovalRowsTx(ctx, tx, accountID, operationID, table, targetType, `item.id=$4 AND item.deleted_at IS NULL`, targetID); err != nil {
		return err
	}
	extra := ""
	if targetType == "list" {
		extra = ",deleted_with_folder=FALSE"
	}
	_, err := tx.Exec(ctx, `UPDATE `+table+` SET deleted_at=NOW(),deleted_by=$3,trash_operation_id=$4,updated_at=NOW()`+extra+` WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, targetID, actorID, operationID)
	return err
}

func preserveTaskRemovalScopeTx(ctx context.Context, tx pgx.Tx, accountID, actorID, targetID uuid.UUID, targetType string, operationID uuid.UUID, req domain.TaskContainerRemovalRequest, s *taskRemovalScope) error {
	if targetType == "folder" {
		// Pin the concrete workflow: removing inheritance must never silently
		// remap statuses or change the workflow of existing tasks and subtasks.
		if err := recordTaskRemovalRowsTx(ctx, tx, accountID, operationID, "task_lists", "list", `item.folder_id=$4 AND item.deleted_at IS NULL`, targetID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `WITH next_order AS(SELECT COALESCE(MAX(sort_order),0) AS position FROM task_lists WHERE account_id=$1 AND environment_id=$3 AND folder_id IS NULL), moving AS(SELECT item.id,COALESCE(item.workflow_id,folder.workflow_id,workflow.id) AS effective_workflow_id,ROW_NUMBER() OVER(ORDER BY item.sort_order,item.created_at,item.id) AS position FROM task_lists item JOIN task_folders folder ON folder.account_id=item.account_id AND folder.id=item.folder_id LEFT JOIN task_workflows workflow ON workflow.account_id=item.account_id AND workflow.environment_id=item.environment_id AND workflow.is_default WHERE item.account_id=$1 AND item.folder_id=$2 AND item.deleted_at IS NULL) UPDATE task_lists item SET folder_id=NULL,workflow_id=moving.effective_workflow_id,workflow_inherited=FALSE,archived_with_folder=FALSE,sort_order=(next_order.position+moving.position*1024)::int,access_revision=access_revision+1,updated_at=NOW() FROM moving,next_order WHERE item.account_id=$1 AND item.id=moving.id`, accountID, targetID, s.preview.EnvironmentID); err != nil {
			return err
		}
	} else if req.DestinationListID != nil {
		destination := *req.DestinationListID
		var workflowID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT COALESCE(item.workflow_id,folder.workflow_id,workflow.id) FROM task_lists item LEFT JOIN task_folders folder ON folder.account_id=item.account_id AND folder.id=item.folder_id LEFT JOIN task_workflows workflow ON workflow.account_id=item.account_id AND workflow.environment_id=item.environment_id AND workflow.is_default WHERE item.account_id=$1 AND item.id=$2`, accountID, destination).Scan(&workflowID); err != nil {
			return err
		}
		if err := lockTaskWorkflowStatuses(ctx, tx, accountID, workflowID); err != nil {
			return err
		}
		if err := recordTaskRemovalRowsTx(ctx, tx, accountID, operationID, "tasks", "task", `item.list_id=$4 AND (item.id IN(SELECT id FROM tasks WHERE account_id=$1 AND list_id=$4 AND parent_task_id IS NULL AND deleted_at IS NULL) OR item.parent_task_id IN(SELECT id FROM tasks WHERE account_id=$1 AND list_id=$4 AND parent_task_id IS NULL AND deleted_at IS NULL))`, targetID); err != nil {
			return err
		}
		if err := recordTaskRemovalRowsTx(ctx, tx, accountID, operationID, "work_events", "event", `item.list_id=$4 AND item.deleted_at IS NULL`, targetID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `WITH next_order AS(
			SELECT COALESCE(MAX(sort_order),0) AS position FROM tasks WHERE account_id=$1 AND list_id=$3 AND parent_task_id IS NULL
		), moving AS(
			SELECT id,ROW_NUMBER() OVER(ORDER BY sort_order,created_at,id) AS position FROM tasks WHERE account_id=$1 AND list_id=$2 AND parent_task_id IS NULL AND deleted_at IS NULL
		), affected AS(
			SELECT task.id,CASE WHEN task.parent_task_id IS NULL THEN (next_order.position+moving.position*1024)::int ELSE task.sort_order END AS new_position
			FROM tasks task JOIN moving ON moving.id=COALESCE(task.parent_task_id,task.id) CROSS JOIN next_order WHERE task.account_id=$1 AND task.list_id=$2
		) UPDATE tasks task SET list_id=$3,status_id=(SELECT replacement.id FROM task_statuses replacement LEFT JOIN task_statuses old_status ON old_status.account_id=task.account_id AND old_status.id=task.status_id WHERE replacement.account_id=task.account_id AND replacement.workflow_id=$4 AND replacement.category=COALESCE(old_status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END) ORDER BY replacement.is_default DESC,replacement.sort_order,replacement.id LIMIT 1),sort_order=affected.new_position,version=COALESCE(task.version,1)+1,updated_at=NOW() FROM affected WHERE task.account_id=$1 AND task.id=affected.id`, accountID, targetID, destination, workflowID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE work_events SET list_id=$3,version=version+1,operation_id=$4,updated_at=NOW() WHERE account_id=$1 AND list_id=$2 AND deleted_at IS NULL`, accountID, targetID, destination, operationID); err != nil {
			return err
		}
	}
	if req.DestinationListID != nil {
		condition := "view_item.list_id=$2"
		if targetType == "folder" {
			condition = "view_item.folder_id=$2"
		}
		if _, err := tx.Exec(ctx, `UPDATE task_location_views view_item SET folder_id=NULL,list_id=$3,version=version+1,updated_at=NOW() WHERE view_item.account_id=$1 AND `+condition+` AND view_item.deleted_at IS NULL`, accountID, targetID, *req.DestinationListID); err != nil {
			return err
		}
	}
	return trashTaskRemovalTargetTx(ctx, tx, accountID, actorID, targetID, targetType, operationID)
}

// restoreTaskContainerRemovalContentsTx runs after the existing parent restore
// has cleared deleted_at. Ownership, rather than timestamp coincidence, keeps
// pre-existing Trash and individually archived history unchanged.
func restoreTaskContainerRemovalContentsTx(ctx context.Context, tx pgx.Tx, accountID, actorID, targetID uuid.UUID, targetType string) error {
	table := "task_lists"
	if targetType == "folder" {
		table = "task_folders"
	}
	var operationID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT trash_operation_id FROM `+table+` WHERE account_id=$1 AND id=$2`, accountID, targetID).Scan(&operationID); err != nil {
		return err
	}
	if operationID == nil {
		return nil
	}
	var mode string
	if err := tx.QueryRow(ctx, `SELECT mode FROM task_container_removal_operations WHERE account_id=$1 AND operation_id=$2 AND target_type=$3 AND target_id=$4 AND restored_at IS NULL FOR UPDATE`, accountID, *operationID, targetType, targetID).Scan(&mode); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if mode != "trash_all" {
		if _, err := tx.Exec(ctx, `UPDATE `+table+` SET trash_operation_id=NULL WHERE account_id=$1 AND id=$2`, accountID, targetID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE task_container_removal_operations SET restored_at=NOW() WHERE account_id=$1 AND operation_id=$2`, accountID, *operationID)
		return err
	}
	rows, err := tx.Query(ctx, `SELECT item.id FROM task_lists item JOIN task_container_removal_items provenance ON provenance.account_id=item.account_id AND provenance.resource_type='list' AND provenance.resource_id=item.id AND provenance.operation_id=$2 WHERE item.account_id=$1 AND item.trash_operation_id=$2 ORDER BY item.id FOR UPDATE OF item`, accountID, *operationID)
	if err != nil {
		return err
	}
	listIDs := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		listIDs = append(listIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err := requireTaskListSetAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, listIDs, domain.TaskAccessFull, true); err != nil {
		return err
	}
	var forbidden int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks task JOIN task_lists item ON item.account_id=task.account_id AND item.id=task.list_id WHERE task.account_id=$1 AND task.trash_operation_id=$2 AND (`+taskActorAccessRankSQL("task", "item", "$3")+`)<4`, accountID, *operationID, actorID).Scan(&forbidden); err != nil {
		return err
	}
	if forbidden > 0 {
		return ErrTaskAccessDenied
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET deleted_at=NULL,deleted_by=NULL,deleted_with_folder=FALSE,trash_operation_id=NULL,updated_at=NOW() WHERE account_id=$1 AND trash_operation_id=$2`, accountID, *operationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE tasks SET deleted_at=NULL,deleted_by=NULL,trash_operation_id=NULL,version=COALESCE(version,1)+1,updated_at=NOW() WHERE account_id=$1 AND trash_operation_id=$2 AND deleted_at IS NOT NULL`, accountID, *operationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE work_events SET deleted_at=NULL,deleted_by=NULL,trash_operation_id=NULL,version=version+1,updated_at=NOW() WHERE account_id=$1 AND trash_operation_id=$2 AND deleted_at IS NOT NULL`, accountID, *operationID); err != nil {
		return err
	}
	// Restore pending task reminders only when they are still in the future.
	if _, err := tx.Exec(ctx, `INSERT INTO task_reminders SELECT restored.* FROM task_container_removal_items provenance CROSS JOIN LATERAL jsonb_populate_record(NULL::task_reminders,provenance.previous_state) restored JOIN tasks task ON task.account_id=provenance.account_id AND task.id=restored.task_id JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id WHERE provenance.account_id=$1 AND provenance.operation_id=$2 AND provenance.resource_type='task_reminder' AND task.deleted_at IS NULL AND restored.reminder_at>NOW() AND list_item.archived_at IS NULL AND environment.archived_at IS NULL AND (folder.id IS NULL OR folder.archived_at IS NULL) ON CONFLICT(id) DO NOTHING`, accountID, *operationID); err != nil {
		return err
	}
	events := []uuid.UUID{}
	rows, err = tx.Query(ctx, `SELECT event.id FROM work_events event JOIN task_container_removal_items provenance ON provenance.account_id=event.account_id AND provenance.resource_id=event.id AND provenance.resource_type='event' AND provenance.operation_id=$2 JOIN task_lists list_item ON list_item.account_id=event.account_id AND list_item.id=event.list_id JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id WHERE event.account_id=$1 AND event.deleted_at IS NULL AND list_item.archived_at IS NULL AND environment.archived_at IS NULL AND (folder.id IS NULL OR folder.archived_at IS NULL) ORDER BY event.id`, accountID, *operationID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		events = append(events, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	workEvents := &WorkEventRepository{}
	for _, id := range events {
		event, attendees, err := workEvents.loadEventForReminderWith(ctx, tx, accountID, id)
		if err != nil {
			return err
		}
		if err := workEvents.rebuildRemindersWith(ctx, tx, event, attendees); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE `+table+` SET trash_operation_id=NULL WHERE account_id=$1 AND id=$2`, accountID, targetID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE task_container_removal_operations SET restored_at=NOW() WHERE account_id=$1 AND operation_id=$2`, accountID, *operationID)
	return err
}
