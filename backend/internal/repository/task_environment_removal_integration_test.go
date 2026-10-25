package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
	"strings"
	"testing"
	"time"
)

func removalExec(t *testing.T, f taskIntegrityFixture, q string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(), q, args...); err != nil {
		t.Fatal(err)
	}
}
func reviewedEnvironmentRemoval(t *testing.T, f taskIntegrityFixture) domain.TaskContainerRemovalRequest {
	t.Helper()
	req := domain.TaskContainerRemovalRequest{Mode: "trash_all"}
	p, err := (&TaskWorkRepository{db: f.pool}).PreviewTaskContainerRemoval(context.Background(), f.account, f.actor, f.environment, "environment", req, true)
	if err != nil {
		t.Fatal(err)
	}
	if !p.CanExecute {
		t.Fatalf("blocked: %v", p.Blockers)
	}
	req.PreviewToken = p.PreviewToken
	req.ConfirmationName = p.Name
	req.CancelFutureEvents = true
	return req
}
func TestEnvironmentRemovalIntegrityRoundTrip(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	ctx := context.Background()
	repo := &TaskWorkRepository{db: f.pool}
	tasks := &TaskRepository{db: f.pool}
	folder, oldFolder, inbox, oldList, view, board, event, guest := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	removalExec(t, f, `INSERT INTO task_folders(id,account_id,environment_id,workflow_id,name,created_by,archived_at) VALUES($1,$2,$3,$4,'Archived folder',$5,NOW()),($6,$2,$3,$4,'Old trash folder',$5,NULL)`, folder, f.account, f.environment, f.workflow, f.actor, oldFolder)
	removalExec(t, f, `UPDATE task_folders SET deleted_at=NOW()-INTERVAL '10 days' WHERE account_id=$1 AND id=$2`, f.account, oldFolder)
	removalExec(t, f, `UPDATE task_lists SET folder_id=$3,archived_at=NOW(),archived_with_folder=TRUE WHERE account_id=$1 AND id=$2`, f.account, f.list, folder)
	removalExec(t, f, `INSERT INTO task_lists(id,account_id,environment_id,workflow_id,name,is_default,created_by) VALUES($1,$2,$3,$4,'Inbox',TRUE,$5),($6,$2,$3,$4,'Old trash list',FALSE,$5)`, inbox, f.account, f.environment, f.workflow, f.actor, oldList)
	removalExec(t, f, `UPDATE task_lists SET deleted_at=NOW()-INTERVAL '10 days' WHERE account_id=$1 AND id=$2`, f.account, oldList)
	root := f.task("Retained root")
	root.ListID = &inbox
	if err := tasks.Create(ctx, root); err != nil {
		t.Fatal(err)
	}
	child := f.task("Real subtask")
	child.ListID = &inbox
	child.ParentTaskID = &root.ID
	if err := tasks.Create(ctx, child); err != nil {
		t.Fatal(err)
	}
	old := f.task("Earlier trash")
	old.ListID = &inbox
	if err := tasks.Create(ctx, old); err != nil {
		t.Fatal(err)
	}
	removalExec(t, f, `UPDATE tasks SET deleted_at=NOW()-INTERVAL '12 days',deleted_by=$3 WHERE account_id=$1 AND id=$2`, f.account, old.ID, f.actor)
	removalExec(t, f, `INSERT INTO task_reminders(id,account_id,task_id,assigned_to,reminder_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '3 days')`, uuid.New(), f.account, root.ID, f.actor)
	removalExec(t, f, `INSERT INTO users(id,account_id,username,email,password_hash,display_name,role,is_active) VALUES($1,$2,$3,$4,'qa','QA Guest','agent',TRUE)`, guest, f.account, guest.String(), guest.String()+"@test.invalid")
	removalExec(t, f, `INSERT INTO user_accounts(user_id,account_id,role) VALUES($1,$2,'admin')`, guest, f.account)
	removalExec(t, f, `INSERT INTO work_events(id,account_id,list_id,organizer_id,title,start_at,end_at,created_by) VALUES($1,$2,$3,$4,'Future shared',NOW()+INTERVAL '2 days',NOW()+INTERVAL '2 days 1 hour',$4)`, event, f.account, inbox, f.actor)
	removalExec(t, f, `INSERT INTO work_event_attendees(account_id,event_id,user_id) VALUES($1,$2,$3),($1,$2,$4)`, f.account, event, f.actor, guest)
	removalExec(t, f, `INSERT INTO whiteboards(id,account_id,name,scene_json,created_by) VALUES($1,$2,'Preserved scene','{"elements":[],"appState":{"viewBackgroundColor":"#ffffff"}}',$3)`, board, f.account, f.actor)
	removalExec(t, f, `INSERT INTO task_location_views(id,account_id,environment_id,folder_id,view_type,created_by) VALUES($1,$2,$3,$4,'whiteboard',$5)`, view, f.account, f.environment, folder, f.actor)
	removalExec(t, f, `INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id) VALUES($1,$2,$3)`, f.account, view, board)
	oldBoard, oldView := uuid.New(), uuid.New()
	removalExec(t, f, `INSERT INTO whiteboards(id,account_id,name,created_by) VALUES($1,$2,'Already unavailable history',$3)`, oldBoard, f.account, f.actor)
	removalExec(t, f, `INSERT INTO task_location_views(id,account_id,environment_id,folder_id,view_type,created_by) VALUES($1,$2,$3,$4,'whiteboard',$5)`, oldView, f.account, f.environment, oldFolder, f.actor)
	removalExec(t, f, `INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id) VALUES($1,$2,$3)`, f.account, oldView, oldBoard)

	done := uuid.New()
	removalExec(t, f, `INSERT INTO task_statuses(id,account_id,workflow_id,name,color,category,sort_order) VALUES($1,$2,$3,'Done','#10B981','done',1024)`, done, f.account, f.workflow)
	history := f.task("Closed archived history")
	history.ListID = &inbox
	if err := tasks.Create(ctx, history); err != nil {
		t.Fatal(err)
	}
	removalExec(t, f, `UPDATE tasks SET list_id=$3,status_id=$4,status='completed',progress=100,completed_at=NOW(),completed_by=$5 WHERE account_id=$1 AND id=$2`, f.account, history.ID, f.list, done, f.actor)
	req := reviewedEnvironmentRemoval(t, f)
	preview, err := repo.PreviewTaskContainerRemoval(ctx, f.account, f.actor, f.environment, "environment", req, true)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Counts.Folders != 1 || preview.Counts.Lists != 2 || preview.Counts.Tasks != 2 || preview.Counts.OpenTasks != 1 || preview.Counts.CompletedTasks != 1 || preview.Counts.Subtasks != 1 || preview.Counts.Whiteboards != 1 || preview.Counts.Events != 1 || !preview.RequiresEventCancellation || !preview.RequiresName {
		t.Fatalf("inventory: %+v", preview)
	}
	noCancel := req
	noCancel.CancelFutureEvents = false
	if _, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", noCancel, uuid.New(), true); !errors.Is(err, ErrWorkEventCancelRequired) {
		t.Fatalf("cancellation guard=%v", err)
	}
	op := uuid.New()
	result, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", req, op, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.ViewerUserIDs) != 2 || len(result.WhiteboardIDs) != 2 {
		t.Fatalf("captured viewers=%d boards=%d", len(result.ViewerUserIDs), len(result.WhiteboardIDs))
	}
	replay, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", req, op, true)
	if err != nil || !replay.Replayed {
		t.Fatalf("replay=%v %v", replay, err)
	}
	var retained, reminders int
	var version int64
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND deleted_at IS NULL),(SELECT COUNT(*) FROM task_reminders WHERE account_id=$1),version FROM task_environments WHERE account_id=$1 AND id=$2`, f.account, f.environment).Scan(&retained, &reminders, &version); err != nil {
		t.Fatal(err)
	}
	if retained != 0 || reminders != 0 {
		t.Fatalf("retained/reminders=%d/%d", retained, reminders)
	}
	if _, err := repo.RestoreEnvironmentFromTrash(ctx, f.account, f.actor, f.environment, version); err != nil {
		t.Fatal(err)
	}
	var oldTasks, oldFolders, oldLists, archivedLists, archivedFolders, inboxes, scheduled int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL),(SELECT COUNT(*) FROM task_folders WHERE account_id=$1 AND id=$3 AND deleted_at IS NOT NULL),(SELECT COUNT(*) FROM task_lists WHERE account_id=$1 AND id=$4 AND deleted_at IS NOT NULL),(SELECT COUNT(*) FROM task_lists WHERE account_id=$1 AND id=$5 AND deleted_at IS NULL AND archived_at IS NOT NULL AND archived_with_folder),(SELECT COUNT(*) FROM task_folders WHERE account_id=$1 AND id=$6 AND deleted_at IS NULL AND archived_at IS NOT NULL),(SELECT COUNT(*) FROM task_lists WHERE account_id=$1 AND id=$7 AND deleted_at IS NULL AND is_default),(SELECT COUNT(*) FROM work_events WHERE account_id=$1 AND id=$8 AND deleted_at IS NULL AND status='scheduled'),(SELECT COUNT(*) FROM task_reminders WHERE account_id=$1)`, f.account, old.ID, oldFolder, oldList, f.list, folder, inbox, event).Scan(&oldTasks, &oldFolders, &oldLists, &archivedLists, &archivedFolders, &inboxes, &scheduled, &reminders); err != nil {
		t.Fatal(err)
	}
	if oldTasks != 1 || oldFolders != 1 || oldLists != 1 || archivedLists != 1 || archivedFolders != 1 || inboxes != 1 || scheduled != 0 || reminders != 1 {
		t.Fatalf("restore history: %d %d %d %d %d %d %d %d", oldTasks, oldFolders, oldLists, archivedLists, archivedFolders, inboxes, scheduled, reminders)
	}
	var unchanged bool
	if err := f.pool.QueryRow(ctx, `SELECT scene_json='{"elements":[],"appState":{"viewBackgroundColor":"#ffffff"}}'::jsonb AND archived_at IS NULL AND EXISTS(SELECT 1 FROM task_location_views WHERE account_id=$1 AND id=$3 AND deleted_at IS NULL) FROM whiteboards WHERE account_id=$1 AND id=$2`, f.account, board, view).Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("board/binding changed=%v %v", unchanged, err)
	}
	if _, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", req, op, true); !errors.Is(err, ErrTaskRemovalPreviewChanged) {
		t.Fatalf("restored replay=%v", err)
	}
	var historyArchived bool
	if err := f.pool.QueryRow(ctx, `SELECT task.deleted_at IS NULL AND task.status='completed' AND item.archived_at IS NOT NULL FROM tasks task JOIN task_lists item ON item.account_id=task.account_id AND item.id=task.list_id WHERE task.account_id=$1 AND task.id=$2`, f.account, history.ID).Scan(&historyArchived); err != nil || !historyArchived {
		t.Fatalf("closed history escaped Archive: %v %v", historyArchived, err)
	}

	if err := database.Migrate(f.pool); err != nil {
		t.Fatalf("migration repeat=%v", err)
	}
}
func TestEnvironmentRemovalIntegrityGuardsSnapshotAndAccount(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	ctx := context.Background()
	repo := &TaskWorkRepository{db: f.pool}
	req := domain.TaskContainerRemovalRequest{Mode: "trash_all"}
	removalExec(t, f, `UPDATE task_lists SET is_default=TRUE WHERE account_id=$1 AND id=$2`, f.account, f.list)
	inbox, err := repo.PreviewTaskContainerRemoval(ctx, f.account, f.actor, f.list, "list", req, true)
	if err != nil || inbox.CanExecute {
		t.Fatalf("Inbox guard=%v %v", inbox, err)
	}
	var generalID uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM task_environments WHERE account_id=$1 AND is_default`, f.account).Scan(&generalID); err != nil {
		t.Fatal(err)
	}
	general, err := repo.PreviewTaskContainerRemoval(ctx, f.account, f.actor, generalID, "environment", req, true)
	if err != nil || general.CanExecute {
		t.Fatalf("General guard=%v %v", general, err)
	}

	req = reviewedEnvironmentRemoval(t, f)
	folder := &domain.TaskFolder{AccountID: f.account, EnvironmentID: f.environment, Name: "New child", CreatedBy: f.actor}
	if err := repo.CreateFolder(ctx, folder); err != nil {
		t.Fatal(err)
	}
	op := uuid.New()
	if _, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", req, op, true); !errors.Is(err, ErrTaskRemovalPreviewChanged) {
		t.Fatalf("stale snapshot=%v", err)
	}
	var consumed int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM task_container_removal_operations WHERE account_id=$1 AND operation_id=$2`, f.account, op).Scan(&consumed); err != nil || consumed != 0 {
		t.Fatalf("consumed op=%d %v", consumed, err)
	}
	req = reviewedEnvironmentRemoval(t, f)
	req.ConfirmationName = "wrong"
	if _, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", req, uuid.New(), true); !errors.Is(err, ErrTaskTrashConfirmation) {
		t.Fatalf("name guard=%v", err)
	}
	other := newTaskIntegrityFixture(t)
	if _, err := repo.PreviewTaskContainerRemoval(ctx, other.account, other.actor, f.environment, "environment", domain.TaskContainerRemovalRequest{Mode: "trash_all"}, true); !errors.Is(err, ErrTaskWorkNotFound) {
		t.Fatalf("cross-account=%v", err)
	}
}
func TestEnvironmentRemovalIntegrityBarrierAndActiveParent(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	ctx := context.Background()
	repo := &TaskWorkRepository{db: f.pool}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := lockWorkEnvironmentBarrierTx(ctx, tx, f.account, []uuid.UUID{f.environment}, true); err != nil {
		t.Fatal(err)
	}
	timeout, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	folder := &domain.TaskFolder{AccountID: f.account, EnvironmentID: f.environment, Name: "Blocked child", CreatedBy: f.actor}
	if err := repo.CreateFolder(timeout, folder); err == nil {
		t.Fatal("creation bypassed exclusive barrier")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := repo.CreateFolder(ctx, folder); err != nil {
		t.Fatalf("release=%v", err)
	}
	req := reviewedEnvironmentRemoval(t, f)
	if _, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", req, uuid.New(), true); err != nil {
		t.Fatal(err)
	}
	folder.Name = "After deletion"
	if err := repo.CreateFolder(ctx, folder); !errors.Is(err, ErrTaskWorkNotFound) {
		t.Fatalf("removed parent accepted=%v", err)
	}
}
func TestWorkEnvironmentBarrierCanonicalKeys(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	got := canonicalWorkEnvironmentIDs([]uuid.UUID{b, uuid.Nil, a, b, a})
	if len(got) != 2 || got[0].String() > got[1].String() {
		t.Fatalf("keys=%v", got)
	}
}

// Real writers all wait before taking their first Work row. A timeout rolls
// back any receipt/provenance and cannot leave a partial child or access edit.
func TestEnvironmentRemovalIntegrityBarrierCoversWriters(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	ctx := context.Background()
	repo := &TaskWorkRepository{db: f.pool}
	tasks := &TaskRepository{db: f.pool}
	active := f.task("Move source")
	if err := tasks.Create(ctx, active); err != nil {
		t.Fatal(err)
	}
	trashed := f.task("Restore source")
	if err := tasks.Create(ctx, trashed); err != nil {
		t.Fatal(err)
	}
	if err := repo.SoftDeleteTask(ctx, f.account, trashed.ID, f.actor); err != nil {
		t.Fatal(err)
	}
	other := &domain.TaskEnvironment{AccountID: f.account, Name: "Move destination", Color: "#10B981", Icon: "layers"}
	if err := repo.CreateEnvironment(ctx, other, f.actor, nil); err != nil {
		t.Fatal(err)
	}
	var destination uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND environment_id=$2 AND is_default`, f.account, other.ID).Scan(&destination); err != nil {
		t.Fatal(err)
	}
	board, view := uuid.New(), uuid.New()
	removalExec(t, f, `INSERT INTO whiteboards(id,account_id,name,created_by) VALUES($1,$2,'Barrier board',$3)`, board, f.account, f.actor)
	removalExec(t, f, `INSERT INTO task_location_views(id,account_id,environment_id,list_id,view_type,created_by) VALUES($1,$2,$3,$4,'whiteboard',$5)`, view, f.account, f.environment, f.list, f.actor)
	removalExec(t, f, `INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id) VALUES($1,$2,$3)`, f.account, view, board)
	folder := &domain.TaskFolder{AccountID: f.account, EnvironmentID: f.environment, Name: "Metadata source", CreatedBy: f.actor}
	if err := repo.CreateFolder(ctx, folder); err != nil {
		t.Fatal(err)
	}
	asset := uuid.New()
	removalExec(t, f, `INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status) VALUES($1,$2,$3,$4,'document','application/pdf','synthetic.pdf',1,'active')`, asset, f.account, strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", ""), f.account.String()+"/qa.pdf")
	attachment, err := repo.AddAttachment(ctx, f.account, active.ID, asset, f.actor)
	if err != nil {
		t.Fatal(err)
	}

	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := lockWorkEnvironmentBarrierTx(ctx, tx, f.account, []uuid.UUID{f.environment}, true); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name  string
		write func(context.Context) error
	}{
		{"set collaborators", func(ctx context.Context) error {
			_, err := repo.SetCollaborators(ctx, f.account, active.ID, f.actor, []uuid.UUID{}, 1, true, nil)
			return err
		}},
		{"legacy list metadata", func(ctx context.Context) error {
			name := "Must rollback"
			return tasks.UpdateList(ctx, f.list, f.account, &name, nil, nil, nil, f.actor)
		}},
		{"legacy folder metadata", func(ctx context.Context) error {
			name := "Must rollback"
			return repo.UpdateFolder(ctx, f.account, folder.ID, &name, nil, nil, nil, false, f.actor)
		}},
		{"ensure inbox", func(ctx context.Context) error {
			_, err := repo.EnsureDefaultListForEnvironment(ctx, f.account, f.environment, f.actor)
			return err
		}},
		{"attach existing asset", func(ctx context.Context) error {
			_, err := repo.AddAttachment(ctx, f.account, active.ID, asset, f.actor)
			return err
		}},
		{"detach asset", func(ctx context.Context) error {
			return repo.DeleteAttachment(ctx, f.account, active.ID, attachment.ID, f.actor)
		}},
		{"complete task", func(ctx context.Context) error { return tasks.MarkCompleted(ctx, active.ID, f.account, f.actor) }},

		{"create task", func(ctx context.Context) error { return tasks.Create(ctx, f.task("Must rollback")) }},
		{"restore task", func(ctx context.Context) error { return repo.RestoreTask(ctx, f.account, f.actor, trashed.ID) }},
		{"cross environment move", func(ctx context.Context) error {
			_, _, err := repo.MoveTaskToEnvironment(ctx, f.account, f.actor, active.ID, destination, 1, true, uuid.New())
			return err
		}},
		{"access replacement", func(ctx context.Context) error {
			_, _, _, err := repo.ReplaceAccessGrants(ctx, f.account, f.actor, "environment", f.environment, nil, nil, 1, uuid.New())
			return err
		}},
		{"create event", func(ctx context.Context) error {
			start := time.Now().Add(72 * time.Hour)
			end := start.Add(time.Hour)
			event := &domain.WorkEvent{AccountID: f.account, ListID: f.list, Title: "Must rollback", StartAt: &start, EndAt: &end, Timezone: "America/Lima", Availability: "free", Status: "scheduled"}
			return (&WorkEventRepository{db: f.pool}).Create(ctx, event, f.actor, true)
		}},
		{"contextual board metadata", func(ctx context.Context) error {
			_, err := (&WhiteboardRepository{db: f.pool}).UpdateBoard(ctx, f.account, f.actor, board, WhiteboardUpdateInput{Name: "Must rollback", ExpectedVersion: 1})
			return err
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			wait, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			result := make(chan error, 1)
			go func() { result <- test.write(wait) }()
			if !waitForRemovalBarrierWaiter(wait, f) {
				select {
				case err := <-result:
					t.Fatalf("writer never waited at barrier: %v", err)
				default:
					t.Fatal("writer blocked before environment barrier")
				}
			}
			// The lifecycle holder must still be able to lock its complete
			// tree; a child writer waiting with a prelocked row would fail NOWAIT.
			for _, table := range []string{"task_environments", "task_folders", "task_lists", "tasks"} {
				if _, err := tx.Exec(ctx, `SELECT id FROM `+table+` WHERE account_id=$1 FOR UPDATE NOWAIT`, f.account); err != nil {
					t.Fatalf("writer took Work rows before barrier: %v", err)
				}
			}
			cancel()
			if err := <-result; err == nil {
				t.Fatal("cancelled writer committed through exclusive barrier")
			}
		})
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var taskCount, deletedCount, eventCount int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*),COUNT(*) FILTER(WHERE deleted_at IS NOT NULL),(SELECT COUNT(*) FROM work_events WHERE account_id=$1) FROM tasks WHERE account_id=$1`, f.account).Scan(&taskCount, &deletedCount, &eventCount); err != nil {
		t.Fatal(err)
	}
	if taskCount != 2 || deletedCount != 1 || eventCount != 0 {
		t.Fatalf("timed out writes escaped rollback: %d/%d/%d", taskCount, deletedCount, eventCount)
	}
}

func TestEnvironmentRemovalIntegrityArchivedEnvironmentRestoresAsArchive(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	ctx := context.Background()
	repo := &TaskWorkRepository{db: f.pool}
	tasks := &TaskRepository{db: f.pool}
	task := f.task("Closed historical task")
	if err := tasks.Create(ctx, task); err != nil {
		t.Fatal(err)
	}
	done := uuid.New()
	removalExec(t, f, `INSERT INTO task_statuses(id,account_id,workflow_id,name,color,category,sort_order) VALUES($1,$2,$3,'Done','#10B981','done',1024)`, done, f.account, f.workflow)
	removalExec(t, f, `UPDATE tasks SET status_id=$3,status='completed',progress=100,completed_at=NOW(),completed_by=$4 WHERE account_id=$1 AND id=$2`, f.account, task.ID, done, f.actor)
	if _, err := repo.ArchiveEnvironment(ctx, f.account, f.actor, f.environment, 1); err != nil {
		t.Fatal(err)
	}
	req := reviewedEnvironmentRemoval(t, f)
	p, err := repo.PreviewTaskContainerRemoval(ctx, f.account, f.actor, f.environment, "environment", req, true)
	if err != nil || p.Lifecycle != "archived" || p.Counts.CompletedTasks != 1 {
		t.Fatalf("archived inventory=%+v %v", p, err)
	}
	if _, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", req, uuid.New(), true); err != nil {
		t.Fatal(err)
	}
	var version int64
	if err := f.pool.QueryRow(ctx, `SELECT version FROM task_environments WHERE account_id=$1 AND id=$2`, f.account, f.environment).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RestoreEnvironmentFromTrash(ctx, f.account, f.actor, f.environment, version); err != nil {
		t.Fatal(err)
	}
	var archived bool
	if err := f.pool.QueryRow(ctx, `SELECT environment.archived_at IS NOT NULL AND environment.deleted_at IS NULL AND task.deleted_at IS NULL AND task.status='completed' AND item.archived_at IS NULL FROM task_environments environment JOIN task_lists item ON item.account_id=environment.account_id AND item.environment_id=environment.id JOIN tasks task ON task.account_id=item.account_id AND task.list_id=item.id WHERE environment.account_id=$1 AND environment.id=$2 AND task.id=$3`, f.account, f.environment, task.ID).Scan(&archived); err != nil || !archived {
		t.Fatalf("archive lifecycle changed %v %v", archived, err)
	}
}

func TestEnvironmentRemovalIntegrityManualPurgeRetentionAndDurableLedger(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	ctx := context.Background()
	repo := &TaskWorkRepository{db: f.pool}
	task := f.task("Purge retained tree")
	if err := (&TaskRepository{db: f.pool}).Create(ctx, task); err != nil {
		t.Fatal(err)
	}
	days := 7
	if err := repo.UpdateTrashRetentionDays(ctx, f.account, &days); err != nil {
		t.Fatal(err)
	}
	req := reviewedEnvironmentRemoval(t, f)
	op := uuid.New()
	if _, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", req, op, true); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.PurgeEnvironment(ctx, f.account, f.actor, f.environment, req.ConfirmationName, time.Now(), true); !errors.Is(err, ErrTaskTrashNotEligible) {
		t.Fatalf("retention guard=%v", err)
	}
	result, err := repo.PurgeEnvironment(ctx, f.account, f.actor, f.environment, req.ConfirmationName, time.Now().Add(8*24*time.Hour), true)
	if err != nil {
		t.Fatal(err)
	}
	if result.Tasks != 1 || result.Lists != 1 || len(result.ViewerUserIDs) != 1 {
		t.Fatalf("purge inventory=%+v", result)
	}
	var roots, tasks, operations int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM task_environments WHERE account_id=$1 AND id=$2),(SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND id=$3),(SELECT COUNT(*) FROM task_container_removal_operations WHERE account_id=$1 AND operation_id=$4)`, f.account, f.environment, task.ID, op).Scan(&roots, &tasks, &operations); err != nil || roots != 0 || tasks != 0 || operations != 1 {
		t.Fatalf("purge atomicity/ledger=%d/%d/%d %v", roots, tasks, operations, err)
	}
	if _, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", req, op, true); !errors.Is(err, ErrTaskWorkNotFound) {
		t.Fatalf("purged replay resurrected or disclosed tree: %v", err)
	}
}

func TestEnvironmentRemovalIntegrityEventCannotMoveAcrossEnvironments(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	ctx := context.Background()
	repo := &TaskWorkRepository{db: f.pool}
	events := &WorkEventRepository{db: f.pool}
	other := &domain.TaskEnvironment{AccountID: f.account, Name: "Other event scope", Color: "#10B981", Icon: "layers"}
	if err := repo.CreateEnvironment(ctx, other, f.actor, nil); err != nil {
		t.Fatal(err)
	}
	var destination uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND environment_id=$2 AND is_default`, f.account, other.ID).Scan(&destination); err != nil {
		t.Fatal(err)
	}
	start := time.Now().Add(72 * time.Hour)
	end := start.Add(time.Hour)
	event := &domain.WorkEvent{AccountID: f.account, ListID: f.list, Title: "Fixed event scope", StartAt: &start, EndAt: &end, Timezone: "America/Lima", Availability: "free", Status: "scheduled"}
	if err := events.Create(ctx, event, f.actor, true); err != nil {
		t.Fatal(err)
	}
	event.ListID = destination
	if err := events.Update(ctx, event, f.actor, true); !errors.Is(err, ErrWorkEventInvalid) {
		t.Fatalf("event crossed environment: %v", err)
	}
	var current uuid.UUID
	var version int64
	if err := f.pool.QueryRow(ctx, `SELECT list_id,version FROM work_events WHERE account_id=$1 AND id=$2`, f.account, event.ID).Scan(&current, &version); err != nil || current != f.list || version != 1 {
		t.Fatalf("cross environment rejection was not atomic: %v %d %v", current, version, err)
	}
}

func TestEnvironmentRemovalIntegrityChildDenialDoesNotRevealOrRemoveInventory(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	ctx := context.Background()
	repo := &TaskWorkRepository{db: f.pool}
	role := uuid.New()
	removalExec(t, f, `INSERT INTO roles(id,name,permissions) VALUES($1,$2,ARRAY['tasks','whiteboards'])`, role, "QA Work "+role.String())
	removalExec(t, f, `UPDATE user_accounts SET role='agent',role_id=$3 WHERE account_id=$1 AND user_id=$2`, f.account, f.actor, role)
	removalExec(t, f, `INSERT INTO task_environment_grants(account_id,environment_id,user_id,access_level,can_manage_access,created_by) VALUES($1,$2,$3,'full',TRUE,$3)`, f.account, f.environment, f.actor)
	removalExec(t, f, `INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,can_manage_access,created_by) VALUES($1,$2,$3,'none',FALSE,$3)`, f.account, f.list, f.actor)
	req := domain.TaskContainerRemovalRequest{Mode: "trash_all"}
	if preview, err := repo.PreviewTaskContainerRemoval(ctx, f.account, f.actor, f.environment, "environment", req, true); !errors.Is(err, ErrTaskWorkNotFound) || preview != nil {
		t.Fatalf("hidden child inventory disclosed: %+v %v", preview, err)
	}
	removalExec(t, f, `UPDATE task_list_access_grants SET access_level='view' WHERE account_id=$1 AND list_id=$2 AND user_id=$3`, f.account, f.list, f.actor)
	preview, err := repo.PreviewTaskContainerRemoval(ctx, f.account, f.actor, f.environment, "environment", req, true)
	if err != nil || preview.CanExecute {
		t.Fatalf("child admin denial bypassed: %+v %v", preview, err)
	}
	req.PreviewToken = preview.PreviewToken
	req.ConfirmationName = preview.Name
	op := uuid.New()
	if _, err := repo.RemoveTaskContainer(ctx, f.account, f.actor, f.environment, "environment", req, op, true); !errors.Is(err, ErrTaskRemovalInvalid) {
		t.Fatalf("partial authority removal accepted: %v", err)
	}
	var changed int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM task_container_removal_operations WHERE account_id=$1 AND operation_id=$2)+(SELECT COUNT(*) FROM task_environments WHERE account_id=$1 AND id=$3 AND deleted_at IS NOT NULL)+(SELECT COUNT(*) FROM task_lists WHERE account_id=$1 AND id=$4 AND deleted_at IS NOT NULL)`, f.account, op, f.environment, f.list).Scan(&changed); err != nil || changed != 0 {
		t.Fatalf("permission failure changed tree: %d %v", changed, err)
	}
}

func waitForRemovalBarrierWaiter(ctx context.Context, f taskIntegrityFixture) bool {
	for {
		var waiting bool
		err := f.pool.QueryRow(ctx, `WITH barrier AS(SELECT hashtextextended('clarin:work-environment:'||$1::text||':'||$2::text,0) AS key) SELECT EXISTS(SELECT 1 FROM pg_locks,barrier WHERE locktype='advisory' AND NOT granted AND classid=((barrier.key>>32)&4294967295)::oid AND objid=(barrier.key&4294967295)::oid AND objsubid=1)`, f.account, f.environment).Scan(&waiting)
		if err != nil {
			return false
		}
		if waiting {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestEnvironmentRemovalIntegrityRechecksModuleAuthorityAfterBarrierWait(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	ctx := context.Background()
	repo := &TaskWorkRepository{db: f.pool}
	role := uuid.New()
	removalExec(t, f, `INSERT INTO roles(id,name,permissions) VALUES($1,$2,ARRAY['tasks'])`, role, "QA revocation "+role.String())
	removalExec(t, f, `UPDATE user_accounts SET role='agent',role_id=$3 WHERE account_id=$1 AND user_id=$2`, f.account, f.actor, role)
	removalExec(t, f, `INSERT INTO task_environment_grants(account_id,environment_id,user_id,access_level,can_manage_access,created_by) VALUES($1,$2,$3,'full',TRUE,$3)`, f.account, f.environment, f.actor)
	req := reviewedEnvironmentRemoval(t, f)
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := lockWorkEnvironmentBarrierTx(ctx, tx, f.account, []uuid.UUID{f.environment}, true); err != nil {
		t.Fatal(err)
	}
	wait, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	op := uuid.New()
	result := make(chan error, 1)
	go func() {
		_, err := repo.RemoveTaskContainer(wait, f.account, f.actor, f.environment, "environment", req, op, true)
		result <- err
	}()
	if !waitForRemovalBarrierWaiter(wait, f) {
		t.Fatal("removal never reached environment barrier")
	}
	removalExec(t, f, `UPDATE roles SET permissions='{}'::text[] WHERE id=$1`, role)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, ErrTaskWorkNotFound) {
		t.Fatalf("stale module authority accepted: %v", err)
	}
	var changed int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM task_container_removal_operations WHERE account_id=$1 AND operation_id=$2)+(SELECT COUNT(*) FROM task_environments WHERE account_id=$1 AND id=$3 AND deleted_at IS NOT NULL)`, f.account, op, f.environment).Scan(&changed); err != nil || changed != 0 {
		t.Fatalf("revoked mutation changed tree=%d %v", changed, err)
	}
}
