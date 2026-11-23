package database

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestTaskContainerRemovalExtendedLifecycle(t *testing.T) {
	if os.Getenv("CLARIN_RUN_TASK_WORK_MIGRATION_INTEGRATION") != "1" {
		t.Skip("isolated PostgreSQL integration opt-in required")
	}
	parsed, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Port() != "55432" {
		t.Fatal("requires disposable local PostgreSQL on 127.0.0.1:55432")
	}
	const dbName = "clarin_task_container_removal_extended_test"
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	adminURL, testURL := *parsed, *parsed
	adminURL.Path, testURL.Path = "/postgres", "/"+dbName
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
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	account, actor, manager, attendee, role := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Extended removal QA')`, account)
	exec(`INSERT INTO subscriptions(account_id,plan_code,status,current_period_start,current_period_end) VALUES($1,'enterprise','active',NOW(),NOW()+INTERVAL '1 year')`, account)
	exec(`INSERT INTO roles(id,name,permissions) VALUES($1,$2,ARRAY['tasks','whiteboards']::text[])`, role, "Extended removal QA "+role.String())
	for _, id := range []uuid.UUID{actor, manager, attendee} {
		exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'test')`, id, account, "extended-"+id.String(), id.String()+"@test.invalid")
		exec(`INSERT INTO user_accounts(account_id,user_id,role,role_id,is_default) VALUES($1,$2,$3,$4,TRUE)`, account, id, map[bool]string{true: "admin", false: "agent"}[id == actor], role)
	}
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
	newFolder := func(name string) uuid.UUID {
		t.Helper()
		id := uuid.New()
		exec(`INSERT INTO task_folders(id,account_id,environment_id,workflow_id,name,created_by) VALUES($1,$2,$3,$4,$5,$6)`, id, account, environment, workflow, name, actor)
		return id
	}
	newTask := func(list uuid.UUID) uuid.UUID {
		t.Helper()
		id := uuid.New()
		exec(`INSERT INTO tasks(id,account_id,list_id,created_by,assigned_to,title,status,status_id,sort_order) VALUES($1,$2,$3,$4,$4,'Extended removal task','pending',$5,1024)`, id, account, list, actor, activeStatus)
		return id
	}
	prepare := func(id uuid.UUID, kind string, req domain.TaskContainerRemovalRequest) domain.TaskContainerRemovalRequest {
		t.Helper()
		p, err := repo.PreviewTaskContainerRemoval(ctx, account, actor, id, kind, req, true)
		if err != nil || !p.CanExecute {
			t.Fatalf("prepare: %#v %v", p, err)
		}
		req.PreviewToken = p.PreviewToken
		req.ConfirmationName = p.Name
		req.ConfirmAccessChanges = true
		req.CancelFutureEvents = true
		return req
	}
	assertActive := func(list uuid.UUID) {
		t.Helper()
		var active bool
		if err := db.QueryRow(ctx, `SELECT deleted_at IS NULL FROM task_lists WHERE account_id=$1 AND id=$2`, account, list).Scan(&active); err != nil || !active {
			t.Fatalf("list unexpectedly mutated: %t %v", active, err)
		}
	}
	await := func(ch <-chan error) error {
		t.Helper()
		select {
		case err := <-ch:
			return err
		case <-time.After(8 * time.Second):
			t.Fatal("concurrent removal did not finish")
			return context.DeadlineExceeded
		}
	}
	waitLock := func() {
		t.Helper()
		deadline := time.Now().Add(4 * time.Second)
		for time.Now().Before(deadline) {
			var blocked bool
			if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock')`).Scan(&blocked); err != nil {
				t.Fatal(err)
			}
			if blocked {
				return
			}
			time.Sleep(15 * time.Millisecond)
		}
		t.Fatal("removal did not reach expected lock barrier")
	}

	t.Run("shared recurrence cancellation reminders stale override and exact restore", func(t *testing.T) {
		list := newList("Recurring event removal", nil)
		task := newTask(list)
		event, reminder, job := uuid.New(), uuid.New(), uuid.New()
		start := time.Now().UTC().Truncate(time.Second).Add(-25 * time.Hour)
		end := start.Add(time.Hour)
		futureKey := start.Add(48 * time.Hour).Format("20060102T150405Z")
		exec(`INSERT INTO work_events(id,account_id,list_id,organizer_id,title,start_at,end_at,timezone,recurrence_rule,created_by) VALUES($1,$2,$3,$4,'Recurring QA',$5,$6,'UTC','FREQ=DAILY;COUNT=3',$4)`, event, account, list, actor, start, end)
		exec(`INSERT INTO work_event_attendees(account_id,event_id,user_id,reminder_minutes) VALUES($1,$2,$3,10),($1,$2,$4,10)`, account, event, actor, attendee)
		exec(`INSERT INTO work_event_occurrence_overrides(account_id,event_id,occurrence_key,is_cancelled,created_by) VALUES($1,$2,$3,TRUE,$4)`, account, event, futureKey, actor)
		exec(`INSERT INTO task_reminders(id,account_id,task_id,assigned_to,reminder_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '2 hours')`, reminder, account, task, actor)
		exec(`INSERT INTO work_event_reminder_jobs(id,account_id,event_id,occurrence_key,user_id,reminder_at) VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '2 hours')`, job, account, event, futureKey, actor)
		p, err := repo.PreviewTaskContainerRemoval(ctx, account, actor, list, "list", domain.TaskContainerRemovalRequest{Mode: "trash_all"}, true)
		if err != nil || p.RequiresEventCancellation {
			t.Fatalf("cancelled recurrence counted as future: %#v %v", p, err)
		}
		req := prepare(list, "list", domain.TaskContainerRemovalRequest{Mode: "trash_all"})
		exec(`DELETE FROM work_event_occurrence_overrides WHERE account_id=$1 AND event_id=$2`, account, event)
		if _, err := repo.RemoveTaskContainer(ctx, account, actor, list, "list", req, uuid.New(), true); !errors.Is(err, repository.ErrTaskRemovalPreviewChanged) {
			t.Fatalf("changed override did not invalidate preview: %v", err)
		}
		assertActive(list)
		req = prepare(list, "list", domain.TaskContainerRemovalRequest{Mode: "trash_all"})
		req.CancelFutureEvents = false
		if _, err := repo.RemoveTaskContainer(ctx, account, actor, list, "list", req, uuid.New(), true); !errors.Is(err, repository.ErrWorkEventCancelRequired) {
			t.Fatalf("unconfirmed shared cancellation: %v", err)
		}
		assertActive(list)
		req.CancelFutureEvents = true
		if _, err := repo.RemoveTaskContainer(ctx, account, actor, list, "list", req, uuid.New(), true); err != nil {
			t.Fatal(err)
		}
		var deleted, cancelled bool
		var status string
		var reminders int
		if err := db.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,status FROM work_events WHERE account_id=$1 AND id=$2`, account, event).Scan(&deleted, &status); err != nil || !deleted || status != "cancelled" {
			t.Fatalf("event not cancelled and trashed: %t %s %v", deleted, status, err)
		}
		if err := db.QueryRow(ctx, `SELECT cancelled_at IS NOT NULL FROM work_event_reminder_jobs WHERE account_id=$1 AND id=$2`, account, job).Scan(&cancelled); err != nil || !cancelled {
			t.Fatalf("pending event reminder survived: %t %v", cancelled, err)
		}
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_reminders WHERE account_id=$1 AND task_id=$2`, account, task).Scan(&reminders); err != nil || reminders != 0 {
			t.Fatalf("pending task reminder survived: %d %v", reminders, err)
		}
		if _, err := repo.RestoreList(ctx, account, actor, list); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,status FROM work_events WHERE account_id=$1 AND id=$2`, account, event).Scan(&deleted, &status); err != nil || deleted || status != "cancelled" {
			t.Fatalf("restore republished cancelled meeting: %t %s %v", deleted, status, err)
		}
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_reminders WHERE account_id=$1 AND task_id=$2 AND reminder_at>NOW()`, account, task).Scan(&reminders); err != nil || reminders != 1 {
			t.Fatalf("pending task reminder not restored: %d %v", reminders, err)
		}
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM work_event_reminder_jobs WHERE account_id=$1 AND event_id=$2 AND cancelled_at IS NULL AND delivered_at IS NULL`, account, event).Scan(&reminders); err != nil || reminders != 0 {
			t.Fatalf("cancelled meeting rescheduled reminders: %d %v", reminders, err)
		}
	})

	t.Run("contextual board keeps binding scene revision and private metadata", func(t *testing.T) {
		source, destination := newList("Board source", nil), newList("Board destination", nil)
		board, view, revision := uuid.New(), uuid.New(), uuid.New()
		key := account.String() + "/whiteboards/" + board.String() + "/revisions/qa.json.gz"
		exec(`INSERT INTO whiteboards(id,account_id,name,scene_json,created_by,updated_by) VALUES($1,$2,'Preserved board','{"elements":[{"id":"original"}],"appState":{}}',$3,$3)`, board, account, actor)
		exec(`INSERT INTO task_location_views(id,account_id,environment_id,list_id,view_type,sort_order,created_by) VALUES($1,$2,$3,$4,'whiteboard',1024,$5)`, view, account, environment, source, actor)
		exec(`INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id) VALUES($1,$2,$3)`, account, view, board)
		exec(`INSERT INTO storage_objects(account_id,object_key,media_type,size_bytes,source,status) VALUES($1,$2,'document',8,'whiteboard_revision','active')`, account, key)
		exec(`INSERT INTO whiteboard_revisions(id,account_id,board_id,revision_number,sequence,operation_id,write_kind,revision_kind,snapshot_object_key,snapshot_content_hash,snapshot_size_bytes,scene_schema_version,editor_version) VALUES($1,$2,$3,1,0,$4,'snapshot','manual',$5,$6,8,'excalidraw','qa')`, revision, account, board, uuid.New(), key, strings.Repeat("a", 64))
		var before string
		if err := db.QueryRow(ctx, `SELECT scene_json::text FROM whiteboards WHERE account_id=$1 AND id=$2`, account, board).Scan(&before); err != nil {
			t.Fatal(err)
		}
		req := prepare(source, "list", domain.TaskContainerRemovalRequest{Mode: "preserve_contents", DestinationListID: &destination})
		if _, err := repo.RemoveTaskContainer(ctx, account, actor, source, "list", req, uuid.New(), true); err != nil {
			t.Fatal(err)
		}
		var actualBoard, actualList uuid.UUID
		var after string
		var count int
		if err := db.QueryRow(ctx, `SELECT binding.whiteboard_id,view_item.list_id,board.scene_json::text FROM task_location_views view_item JOIN task_location_whiteboard_views binding ON binding.account_id=view_item.account_id AND binding.task_view_id=view_item.id JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id WHERE view_item.account_id=$1 AND view_item.id=$2`, account, view).Scan(&actualBoard, &actualList, &after); err != nil || actualBoard != board || actualList != destination || after != before {
			t.Fatalf("board identity/scene lost: %v %v %v", actualBoard, actualList, err)
		}
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_revisions WHERE account_id=$1 AND board_id=$2 AND id=$3 AND snapshot_object_key=$4`, account, board, revision, key).Scan(&count); err != nil || count != 1 {
			t.Fatalf("revision history changed: %d %v", count, err)
		}
		exec(`UPDATE task_location_views SET visibility_mode='restricted' WHERE account_id=$1 AND id=$2`, account, view)
		exec(`INSERT INTO task_location_view_visibility_members(account_id,task_view_id,user_id) VALUES($1,$2,$3)`, account, view, actor)
		exec(`INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,can_manage_access,created_by) VALUES($1,$2,$3,'full',FALSE,$4)`, account, destination, manager, actor)
		p, err := repo.PreviewTaskContainerRemoval(ctx, account, manager, destination, "list", domain.TaskContainerRemovalRequest{Mode: "trash_all"}, true)
		if err != nil {
			t.Fatal(err)
		}
		if p.Counts.Whiteboards != 0 {
			t.Fatalf("restricted board inventory leaked: %#v", p)
		}
		if p.CanExecute {
			t.Fatal("a hidden contextual board cannot be trashed through its parent")
		}
		blocked := domain.TaskContainerRemovalRequest{Mode: "trash_all", PreviewToken: p.PreviewToken, ConfirmationName: p.Name}
		if _, err := repo.RemoveTaskContainer(ctx, account, manager, destination, "list", blocked, uuid.New(), true); !errors.Is(err, repository.ErrTaskRemovalInvalid) {
			t.Fatalf("hidden contextual content was mutated: %v", err)
		}
		assertActive(destination)
	})

	t.Run("folder preservation pins inherited workflow and keeps individual archive", func(t *testing.T) {
		folder := newFolder("Preserve workflow folder")
		customWorkflow, customOpen, customDone := uuid.New(), uuid.New(), uuid.New()
		exec(`INSERT INTO task_workflows(id,account_id,environment_id,name,created_by) VALUES($1,$2,$3,'Folder workflow QA',$4)`, customWorkflow, account, environment, actor)
		exec(`INSERT INTO task_statuses(id,account_id,workflow_id,name,category,is_default,sort_order) VALUES($1,$3,$4,'Open QA','not_started',TRUE,1024),($2,$3,$4,'Done QA','done',FALSE,2048)`, customOpen, customDone, account, customWorkflow)
		exec(`UPDATE task_folders SET workflow_id=$3,workflow_inherited=FALSE WHERE account_id=$1 AND id=$2`, account, folder, customWorkflow)
		active, archived := newList("Inherited active child", &folder), newList("Individually archived child", &folder)
		exec(`UPDATE task_lists SET workflow_id=$3,workflow_inherited=TRUE WHERE account_id=$1 AND id=ANY($2::uuid[])`, account, []uuid.UUID{active, archived}, customWorkflow)
		exec(`UPDATE task_lists SET archived_at=NOW()-INTERVAL '1 day',archived_with_folder=FALSE WHERE account_id=$1 AND id=$2`, account, archived)
		task := newTask(active)
		exec(`UPDATE tasks SET status_id=$3 WHERE account_id=$1 AND id=$2`, account, task, customOpen)
		req := prepare(folder, "folder", domain.TaskContainerRemovalRequest{Mode: "preserve_contents"})
		if _, err := repo.RemoveTaskContainer(ctx, account, actor, folder, "folder", req, uuid.New(), true); err != nil {
			t.Fatal(err)
		}
		for _, list := range []uuid.UUID{active, archived} {
			var actualWorkflow uuid.UUID
			var atRoot, inherited, history bool
			if err := db.QueryRow(ctx, `SELECT workflow_id,folder_id IS NULL,workflow_inherited,archived_at IS NOT NULL FROM task_lists WHERE account_id=$1 AND id=$2`, account, list).Scan(&actualWorkflow, &atRoot, &inherited, &history); err != nil || actualWorkflow != customWorkflow || !atRoot || inherited || history != (list == archived) {
				t.Fatalf("workflow/archive changed for %v: %v %t %t %t %v", list, actualWorkflow, atRoot, inherited, history, err)
			}
		}
		var actualStatus uuid.UUID
		if err := db.QueryRow(ctx, `SELECT status_id FROM tasks WHERE account_id=$1 AND id=$2`, account, task).Scan(&actualStatus); err != nil || actualStatus != customOpen {
			t.Fatalf("task remapped during folder preservation: %v %v", actualStatus, err)
		}
	})

	t.Run("restricted child and foreign account cannot partially remove", func(t *testing.T) {
		folder := newFolder("Restricted removal")
		list := newList("Denied child", &folder)
		task := newTask(list)
		exec(`INSERT INTO task_folder_access_grants(account_id,folder_id,user_id,access_level,created_by) VALUES($1,$2,$3,'full',$4)`, account, folder, manager, actor)
		exec(`INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,created_by) VALUES($1,$2,$3,'none',$4)`, account, list, manager, actor)
		if _, err := repo.PreviewTaskContainerRemoval(ctx, account, manager, folder, "folder", domain.TaskContainerRemovalRequest{Mode: "trash_all"}, true); !errors.Is(err, repository.ErrTaskWorkNotFound) {
			t.Fatalf("restricted child leaked: %v", err)
		}
		req := prepare(list, "list", domain.TaskContainerRemovalRequest{Mode: "trash_all"})
		foreign := uuid.New()
		exec(`INSERT INTO accounts(id,name) VALUES($1,'Foreign removal QA')`, foreign)
		if _, err := repo.RemoveTaskContainer(ctx, foreign, actor, list, "list", req, uuid.New(), true); !errors.Is(err, repository.ErrTaskWorkNotFound) {
			t.Fatalf("foreign account mutation: %v", err)
		}
		assertActive(list)
		var deleted bool
		if err := db.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM tasks WHERE account_id=$1 AND id=$2`, account, task).Scan(&deleted); err != nil || deleted {
			t.Fatalf("failed mutation was partial: %t %v", deleted, err)
		}
	})

	t.Run("concurrent create invalidates preparation without deleting either task", func(t *testing.T) {
		list := newList("Concurrent create", nil)
		newTask(list)
		req := prepare(list, "list", domain.TaskContainerRemovalRequest{Mode: "trash_all"})
		tx, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND id=$2 FOR UPDATE`, account, list); err != nil {
			t.Fatal(err)
		}
		result := make(chan error, 1)
		go func() {
			_, err := repo.RemoveTaskContainer(ctx, account, actor, list, "list", req, uuid.New(), true)
			result <- err
		}()
		waitLock()
		if _, err := tx.Exec(ctx, `INSERT INTO tasks(id,account_id,list_id,created_by,assigned_to,title,status,status_id,sort_order) VALUES($1,$2,$3,$4,$4,'Concurrent new task','pending',$5,2048)`, uuid.New(), account, list, actor, activeStatus); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := await(result); !errors.Is(err, repository.ErrTaskRemovalPreviewChanged) {
			t.Fatalf("concurrent create not rejected: %v", err)
		}
		assertActive(list)
		var count int
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND list_id=$2 AND deleted_at IS NULL`, account, list).Scan(&count); err != nil || count != 2 {
			t.Fatalf("partial concurrent delete: %d %v", count, err)
		}
	})

	t.Run("delegated managers can archive and unarchive with environment view", func(t *testing.T) {
		exec(`UPDATE task_environments SET default_access_level='view' WHERE account_id=$1 AND id=$2`, account, environment)
		list := newList("Delegated archive list", nil)
		task := newTask(list)
		exec(`UPDATE tasks SET status='completed',status_id=$3 WHERE account_id=$1 AND id=$2`, account, task, doneStatus)
		exec(`INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,created_by) VALUES($1,$2,$3,'full',$4)`, account, list, manager, actor)
		if _, err := repo.ArchiveList(ctx, account, manager, list); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.UnarchiveList(ctx, account, manager, list); err != nil {
			t.Fatal(err)
		}
		folder := newFolder("Delegated archive folder")
		newList("Delegated archive child", &folder)
		exec(`INSERT INTO task_folder_access_grants(account_id,folder_id,user_id,access_level,created_by) VALUES($1,$2,$3,'full',$4)`, account, folder, manager, actor)
		if _, err := repo.ArchiveFolder(ctx, account, manager, folder); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.UnarchiveFolder(ctx, account, manager, folder); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("destination catalog pages the complete compatible scope", func(t *testing.T) {
		source := newList("Catalog source", nil)
		exec(`INSERT INTO task_lists(id,account_id,environment_id,workflow_id,name,created_by,sort_order)
			SELECT gen_random_uuid(),$1,$2,$3,'Catalog destination '||n,$4,n*1024 FROM generate_series(1,215) n`, account, environment, workflow, actor)
		archived := newList("Catalog archived", nil)
		exec(`UPDATE task_lists SET archived_at=NOW() WHERE id=$1`, archived)
		seen := make(map[uuid.UUID]bool)
		var cursor *repository.TaskStructurePageCursor
		for page := 0; page < 8; page++ {
			items, next, err := repo.ListTaskRemovalDestinations(ctx, account, actor, source, "list", 50, cursor, "Catalog")
			if err != nil || len(items) > 50 {
				t.Fatalf("destination page: %d %v", len(items), err)
			}
			for _, item := range items {
				if item.ID == source || item.ID == archived || item.Lifecycle != "active" || seen[item.ID] {
					t.Fatalf("incompatible or duplicate destination: %#v", item)
				}
				seen[item.ID] = true
			}
			cursor = next
			if next == nil {
				break
			}
		}
		if len(seen) != 215 || cursor != nil {
			t.Fatalf("destination catalog omitted rows: %d", len(seen))
		}
	})

	t.Run("environment revocation and removal respect the same lock order", func(t *testing.T) {
		list := newList("Concurrent revocation", nil)
		newTask(list)
		exec(`INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,created_by) VALUES($1,$2,$3,'full',$4)`, account, list, manager, actor)
		p, err := repo.PreviewTaskContainerRemoval(ctx, account, manager, list, "list", domain.TaskContainerRemovalRequest{Mode: "trash_all"}, true)
		if err != nil || !p.CanExecute {
			t.Fatalf("delegated preparation: %#v %v", p, err)
		}
		req := domain.TaskContainerRemovalRequest{Mode: "trash_all", PreviewToken: p.PreviewToken, ConfirmationName: p.Name}
		tx, err := db.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout='4s'`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `SELECT id FROM task_environments WHERE account_id=$1 AND id=$2 FOR UPDATE`, account, environment); err != nil {
			t.Fatal(err)
		}
		result := make(chan error, 1)
		go func() {
			_, err := repo.RemoveTaskContainer(ctx, account, manager, list, "list", req, uuid.New(), true)
			result <- err
		}()
		waitLock()
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,731943))`, account); err != nil {
			t.Fatalf("authority barrier deadlocked with removal: %v", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO task_environment_grants(account_id,environment_id,user_id,access_level,created_by) VALUES($1,$2,$3,'none',$4) ON CONFLICT(account_id,environment_id,user_id) DO UPDATE SET access_level='none'`, account, environment, manager, actor); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err := await(result); !errors.Is(err, repository.ErrTaskWorkNotFound) && !errors.Is(err, repository.ErrTaskAccessDenied) {
			t.Fatalf("revoked actor mutation: %v", err)
		}
		assertActive(list)
	})
}
