package database

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestTaskContainerRemovalAtomicLifecycle(t *testing.T) {
	if os.Getenv("CLARIN_RUN_TASK_WORK_MIGRATION_INTEGRATION") != "1" {
		t.Skip("isolated PostgreSQL integration opt-in required")
	}
	parsed, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Port() != "55432" {
		t.Fatal("requires disposable local PostgreSQL on 127.0.0.1:55432")
	}
	const dbName = "clarin_task_container_removal_test"
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + dbName
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, dbName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+dbName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+dbName); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_, _ = admin.Exec(cleanup, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, dbName)
		_, _ = admin.Exec(cleanup, `DROP DATABASE IF EXISTS `+dbName)
	}()
	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	if err := migrateTaskContainerRemoval(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err := migrateTaskContainerRemoval(ctx, db); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	account, actor, manager, role := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Removal QA')`, account)
	exec(`INSERT INTO roles(id,name,permissions) VALUES($1,$2,ARRAY['tasks','whiteboards']::text[])`, role, "Removal QA "+role.String())
	for _, id := range []uuid.UUID{actor, manager} {
		exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'test')`, id, account, "removal-"+id.String(), id.String()+"@test.invalid")
	}
	exec(`INSERT INTO user_accounts(account_id,user_id,role,role_id,is_default) VALUES($1,$2,'admin',$4,TRUE),($1,$3,'agent',$4,FALSE)`, account, actor, manager, role)
	var environment, workflow, activeStatus, doneStatus uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM task_environments WHERE account_id=$1 AND is_default`, account).Scan(&environment); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT id FROM task_workflows WHERE account_id=$1 AND environment_id=$2 AND is_default`, account, environment).Scan(&workflow); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT id FROM task_statuses WHERE account_id=$1 AND workflow_id=$2 AND category='not_started' LIMIT 1`, account, workflow).Scan(&activeStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT id FROM task_statuses WHERE account_id=$1 AND workflow_id=$2 AND category='done' LIMIT 1`, account, workflow).Scan(&doneStatus); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewRepositories(db).TaskWork
	newList := func(name string, folder *uuid.UUID) uuid.UUID {
		t.Helper()
		id := uuid.New()
		exec(`INSERT INTO task_lists(id,account_id,environment_id,folder_id,workflow_id,name,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, account, environment, folder, workflow, name, actor)
		return id
	}
	newTask := func(list uuid.UUID, parent *uuid.UUID, deleted bool, position int) uuid.UUID {
		t.Helper()
		id := uuid.New()
		exec(`INSERT INTO tasks(id,account_id,list_id,created_by,assigned_to,title,status,status_id,parent_task_id,sort_order,deleted_at) VALUES($1,$2,$3,$4,$4,'Removal QA task','pending',$5,$6,$7,CASE WHEN $8::boolean THEN NOW()-INTERVAL '2 days' END)`, id, account, list, actor, activeStatus, parent, position, deleted)
		return id
	}
	preview := func(id uuid.UUID, kind string, request domain.TaskContainerRemovalRequest) *domain.TaskContainerRemovalPreview {
		t.Helper()
		p, err := repo.PreviewTaskContainerRemoval(ctx, account, actor, id, kind, request, true)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	prepare := func(id uuid.UUID, kind string, request domain.TaskContainerRemovalRequest) domain.TaskContainerRemovalRequest {
		t.Helper()
		p := preview(id, kind, request)
		if !p.CanExecute {
			t.Fatalf("blocked preview: %#v", p)
		}
		request.PreviewToken = p.PreviewToken
		request.ConfirmationName = p.Name
		request.CancelFutureEvents = true
		request.ConfirmAccessChanges = true
		return request
	}
	assertDeleted := func(id uuid.UUID, want bool) {
		t.Helper()
		var deleted bool
		if err := db.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM tasks WHERE account_id=$1 AND id=$2`, account, id).Scan(&deleted); err != nil {
			t.Fatal(err)
		}
		if deleted != want {
			t.Fatalf("task deleted=%v want %v", deleted, want)
		}
	}

	t.Run("stale atomic cascade replay and exact restore", func(t *testing.T) {
		list := newList("Cascade", nil)
		root := newTask(list, nil, false, 1024)
		child := newTask(list, &root, false, 123)
		priorChild := newTask(list, &root, true, 456)
		priorRoot := newTask(list, nil, true, 2048)
		request := prepare(list, "list", domain.TaskContainerRemovalRequest{Mode: "trash_all"})
		exec(`UPDATE tasks SET version=version+1 WHERE account_id=$1 AND id=$2`, account, root)
		if _, err := repo.RemoveTaskContainer(ctx, account, actor, list, "list", request, uuid.New(), true); !errors.Is(err, repository.ErrTaskRemovalPreviewChanged) {
			t.Fatalf("stale token: %v", err)
		}
		assertDeleted(root, false)
		assertDeleted(child, false)
		request = prepare(list, "list", request)
		operation := uuid.New()
		if _, err := repo.RemoveTaskContainer(ctx, account, actor, list, "list", request, operation, true); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.RemoveTaskContainer(ctx, account, actor, list, "list", request, operation, true); err != nil {
			t.Fatalf("replay: %v", err)
		}
		assertDeleted(root, true)
		assertDeleted(child, true)
		if err := repo.RestoreTask(ctx, account, actor, root); !errors.Is(err, repository.ErrTaskWorkNotFound) {
			t.Fatalf("task restored under deleted list: %v", err)
		}
		if _, err := repo.RestoreList(ctx, account, actor, list); err != nil {
			t.Fatal(err)
		}
		assertDeleted(root, false)
		assertDeleted(child, false)
		assertDeleted(priorChild, true)
		assertDeleted(priorRoot, true)
		if err := repo.SoftDeleteTask(ctx, account, root, actor); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.TrashListConfirmed(ctx, account, actor, list, "Cascade"); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.RestoreList(ctx, account, actor, list); err != nil {
			t.Fatal(err)
		}
		assertDeleted(root, true)
		assertDeleted(child, true)
	})

	t.Run("preserve retained roots children and exact child order", func(t *testing.T) {
		source, destination := newList("Preserve source", nil), newList("Preserve destination", nil)
		root := newTask(source, nil, false, 1024)
		child := newTask(source, &root, false, 77)
		deletedChild := newTask(source, &root, true, 91)
		oldRoot := newTask(source, nil, true, 2048)
		request := prepare(source, "list", domain.TaskContainerRemovalRequest{Mode: "preserve_contents", DestinationListID: &destination})
		if _, err := repo.RemoveTaskContainer(ctx, account, actor, source, "list", request, uuid.New(), true); err != nil {
			t.Fatal(err)
		}
		for _, id := range []uuid.UUID{root, child, deletedChild} {
			var list uuid.UUID
			if err := db.QueryRow(ctx, `SELECT list_id FROM tasks WHERE account_id=$1 AND id=$2`, account, id).Scan(&list); err != nil || list != destination {
				t.Fatalf("move: %v %v", list, err)
			}
		}
		var position int
		if err := db.QueryRow(ctx, `SELECT sort_order FROM tasks WHERE account_id=$1 AND id=$2`, account, child).Scan(&position); err != nil || position != 77 {
			t.Fatalf("child order=%d err=%v", position, err)
		}
		var list uuid.UUID
		if err := db.QueryRow(ctx, `SELECT list_id FROM tasks WHERE account_id=$1 AND id=$2`, account, oldRoot).Scan(&list); err != nil || list != source {
			t.Fatalf("prior Trash moved: %v", err)
		}
		assertDeleted(deletedChild, true)
	})

	t.Run("folder cascade mixed archive and prior trash", func(t *testing.T) {
		folder := uuid.New()
		exec(`INSERT INTO task_folders(id,account_id,environment_id,workflow_id,name,created_by) VALUES($1,$2,$3,$4,'Folder cascade',$5)`, folder, account, environment, workflow, actor)
		active, archived, priorTrash := newList("Active child", &folder), newList("Archived child", &folder), newList("Prior Trash child", &folder)
		exec(`UPDATE task_lists SET archived_at=NOW()-INTERVAL '1 day' WHERE id=$1`, archived)
		exec(`UPDATE task_lists SET deleted_at=NOW()-INTERVAL '2 days' WHERE id=$1`, priorTrash)
		root := newTask(active, nil, false, 1024)
		history := newTask(archived, nil, false, 1024)
		exec(`UPDATE tasks SET status='completed',status_id=$3 WHERE account_id=$1 AND id=$2`, account, history, doneStatus)
		request := prepare(folder, "folder", domain.TaskContainerRemovalRequest{Mode: "trash_all"})
		if _, err := repo.RemoveTaskContainer(ctx, account, actor, folder, "folder", request, uuid.New(), true); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.RestoreFolder(ctx, account, actor, folder); err != nil {
			t.Fatal(err)
		}
		assertDeleted(root, false)
		assertDeleted(history, false)
		var archivedState, deletedState bool
		if err := db.QueryRow(ctx, `SELECT archived_at IS NOT NULL,deleted_at IS NOT NULL FROM task_lists WHERE id=$1`, archived).Scan(&archivedState, &deletedState); err != nil || !archivedState || deletedState {
			t.Fatalf("archive changed: %v", err)
		}
		if err := db.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM task_lists WHERE id=$1`, priorTrash).Scan(&deletedState); err != nil || !deletedState {
			t.Fatalf("prior Trash restored: %v", err)
		}
	})

	t.Run("more than one page and delegated manager", func(t *testing.T) {
		list := newList("Large delegated list", nil)
		exec(`INSERT INTO tasks(id,account_id,list_id,created_by,assigned_to,title,status,status_id,sort_order) SELECT gen_random_uuid(),$1,$2,$3,$3,'Bulk removal QA','pending',$4,position*1024 FROM generate_series(1,215) position`, account, list, actor, activeStatus)
		exec(`UPDATE task_environments SET default_access_level='view' WHERE account_id=$1 AND id=$2`, account, environment)
		exec(`INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,created_by) VALUES($1,$2,$3,'full',$4)`, account, list, manager, actor)
		request := domain.TaskContainerRemovalRequest{Mode: "trash_all"}
		p, err := repo.PreviewTaskContainerRemoval(ctx, account, manager, list, "list", request, true)
		if err != nil || !p.CanExecute || p.Counts.Tasks != 215 {
			t.Fatalf("delegated preview: %#v err=%v", p, err)
		}
		request.PreviewToken = p.PreviewToken
		request.ConfirmationName = p.Name
		if _, err := repo.RemoveTaskContainer(ctx, account, manager, list, "list", request, uuid.New(), true); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.RestoreList(ctx, account, manager, list); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND list_id=$2 AND deleted_at IS NULL`, account, list).Scan(&count); err != nil || count != 215 {
			t.Fatalf("incomplete restore %d: %v", count, err)
		}
	})

	t.Run("delegated folder restore ignores untouched denied old trash", func(t *testing.T) {
		folder := uuid.New()
		exec(`UPDATE task_environments SET default_access_level='view' WHERE account_id=$1 AND id=$2`, account, environment)
		exec(`INSERT INTO task_folders(id,account_id,environment_id,workflow_id,name,created_by) VALUES($1,$2,$3,$4,'Delegated folder restore',$5)`, folder, account, environment, workflow, actor)
		owned, oldTrash := newList("Owned child", &folder), newList("Denied old Trash", &folder)
		root := newTask(owned, nil, false, 1024)
		exec(`UPDATE task_lists SET deleted_at=NOW()-INTERVAL '2 days' WHERE account_id=$1 AND id=$2`, account, oldTrash)
		// A contextual board follows the List's Trash lifecycle; its own view
		// and board rows stay live. It is untouched historical content, not a
		// protected retained descendant of the new folder removal.
		viewID, boardID := uuid.New(), uuid.New()
		exec(`INSERT INTO whiteboards(id,account_id,name,created_by,updated_by) VALUES($1,$2,'Prior Trash board',$3,$3)`, boardID, account, actor)
		exec(`INSERT INTO task_location_views(id,account_id,environment_id,list_id,view_type,sort_order,created_by) VALUES($1,$2,$3,$4,'whiteboard',1024,$5)`, viewID, account, environment, oldTrash, actor)
		exec(`INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id) VALUES($1,$2,$3)`, account, viewID, boardID)
		var priorDeletedAt time.Time
		if err := db.QueryRow(ctx, `SELECT deleted_at FROM task_lists WHERE account_id=$1 AND id=$2`, account, oldTrash).Scan(&priorDeletedAt); err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO task_folder_access_grants(account_id,folder_id,user_id,access_level,created_by) VALUES($1,$2,$3,'full',$4)`, account, folder, manager, actor)
		exec(`INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,created_by) VALUES($1,$2,$3,'none',$4)`, account, oldTrash, manager, actor)
		request := domain.TaskContainerRemovalRequest{Mode: "trash_all"}
		p, err := repo.PreviewTaskContainerRemoval(ctx, account, manager, folder, "folder", request, true)
		if err != nil || !p.CanExecute {
			t.Fatalf("delegated folder preview: %#v %v", p, err)
		}
		if p.Counts.Whiteboards != 0 {
			t.Fatal("untouched prior Trash board appeared in removal inventory")
		}
		request.PreviewToken = p.PreviewToken
		request.ConfirmationName = p.Name
		if _, err := repo.RemoveTaskContainer(ctx, account, manager, folder, "folder", request, uuid.New(), true); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.RestoreFolder(ctx, account, manager, folder); err != nil {
			t.Fatalf("untouched child denied operation-owned restore: %v", err)
		}
		assertDeleted(root, false)
		var stillDeleted bool
		if err := db.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM task_lists WHERE account_id=$1 AND id=$2`, account, oldTrash).Scan(&stillDeleted); err != nil || !stillDeleted {
			t.Fatalf("old denied Trash changed: %v", err)
		}
		var bindingID uuid.UUID
		var listDeletedAt time.Time
		var viewDeletedAt, boardArchivedAt *time.Time
		if err := db.QueryRow(ctx, `SELECT binding.whiteboard_id,list_item.deleted_at,view_item.deleted_at,board.archived_at FROM task_location_whiteboard_views binding JOIN task_location_views view_item ON view_item.account_id=binding.account_id AND view_item.id=binding.task_view_id JOIN task_lists list_item ON list_item.account_id=view_item.account_id AND list_item.id=view_item.list_id JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id WHERE binding.account_id=$1 AND binding.task_view_id=$2`, account, viewID).Scan(&bindingID, &listDeletedAt, &viewDeletedAt, &boardArchivedAt); err != nil {
			t.Fatal(err)
		}
		if bindingID != boardID || !listDeletedAt.Equal(priorDeletedAt) || viewDeletedAt != nil || boardArchivedAt != nil {
			t.Fatal("old Trash board identity or retention changed")
		}
	})

	t.Run("same actor purge and removal follow account before actor", func(t *testing.T) {
		for _, operationKind := range []string{"remove", "restore_list", "restore_folder"} {
			source, purgeTarget := newList("Concurrent removal", nil), newList("Concurrent purge", nil)
			exec(`UPDATE task_lists SET deleted_at=NOW()-INTERVAL '60 days' WHERE account_id=$1 AND id=$2`, account, purgeTarget)
			request := prepare(source, "list", domain.TaskContainerRemovalRequest{Mode: "trash_all"})
			var restoreTarget uuid.UUID
			if operationKind != "remove" {
				restoreTarget = source
				targetType := "list"
				root := newTask(source, nil, false, 1024)
				exec(`INSERT INTO task_reminders(account_id,task_id,assigned_to,reminder_at) VALUES($1,$2,$3,NOW()+INTERVAL '2 days')`, account, root, actor)
				if operationKind == "restore_folder" {
					restoreTarget = uuid.New()
					targetType = "folder"
					exec(`INSERT INTO task_folders(id,account_id,environment_id,workflow_id,name,created_by) VALUES($1,$2,$3,$4,'Concurrent folder restore',$5)`, restoreTarget, account, environment, workflow, actor)
					exec(`UPDATE task_lists SET folder_id=$3 WHERE account_id=$1 AND id=$2`, account, source, restoreTarget)
				}
				prepared := prepare(restoreTarget, targetType, domain.TaskContainerRemovalRequest{Mode: "trash_all"})
				if _, err := repo.RemoveTaskContainer(ctx, account, actor, restoreTarget, targetType, prepared, uuid.New(), true); err != nil {
					t.Fatal(err)
				}
			}
			locker, err := db.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer locker.Rollback(context.Background())
			if _, err := locker.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,731942))`, actor); err != nil {
				t.Fatal(err)
			}
			raceCtx, stop := context.WithTimeout(ctx, 12*time.Second)
			defer stop()
			removed := make(chan error, 1)
			purged := make(chan error, 1)
			go func() {
				var err error
				switch operationKind {
				case "restore_list":
					_, err = repo.RestoreList(raceCtx, account, actor, restoreTarget)
				case "restore_folder":
					_, err = repo.RestoreFolder(raceCtx, account, actor, restoreTarget)
				default:
					_, err = repo.RemoveTaskContainer(raceCtx, account, actor, source, "list", request, uuid.New(), true)
				}
				removed <- err
			}()
			// Wait for the first request at the actor lock, rather than relying on a
			// scheduler delay. A purge is then guaranteed to contend with that request.
			deadline := time.Now().Add(5 * time.Second)
			for {
				var waiting bool
				err := db.QueryRow(raceCtx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%hashtextextended($1::text,731942)%')`).Scan(&waiting)
				if err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("removal never reached actor barrier")
				}
				time.Sleep(10 * time.Millisecond)
			}
			go func() {
				_, err := repo.PurgeList(raceCtx, account, actor, purgeTarget, "Concurrent purge", time.Now().UTC(), true)
				purged <- err
			}()
			deadline = time.Now().Add(5 * time.Second)
			for {
				var waiting bool
				err := db.QueryRow(raceCtx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM accounts WHERE id=$1 FOR UPDATE%') OR (SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%hashtextextended($1::text,731942)%')>=2`).Scan(&waiting)
				if err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("purge never reached contention barrier")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err := locker.Rollback(raceCtx); err != nil {
				t.Fatal(err)
			}
			for _, result := range []<-chan error{removed, purged} {
				select {
				case err := <-result:
					if err != nil {
						t.Fatalf("purge/%s lock inversion: %v", operationKind, err)
					}
				case <-raceCtx.Done():
					t.Fatal("purge/removal did not finish")
				}
			}
		}
	})
}
