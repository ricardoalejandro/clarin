package database

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestAccountAuthorityIsolationAndPurgeRelocation(t *testing.T) {
	if os.Getenv("CLARIN_RUN_ACCOUNT_AUTHORITY_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_ACCOUNT_AUTHORITY_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	const databaseName = "clarin_account_authority_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + databaseName
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()
	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	repos := repository.NewRepositories(db)

	accountA, accountB := uuid.New(), uuid.New()
	legacyAdmin, accountScopedSuper, exclusiveAuthor, boardOwner := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	environmentB, boardB := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Authority A'),($2,'Authority B')`, accountA, accountB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO subscriptions(account_id,plan_code,status,current_period_start,current_period_end)
		VALUES($1,'enterprise','active',NOW(),NOW()+INTERVAL '1 year'),
			($2,'enterprise','active',NOW(),NOW()+INTERVAL '1 year')`, accountA, accountB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,role,is_admin,is_super_admin)
		VALUES($1,$2,$3,$4,'test','admin',TRUE,FALSE),
			($5,$2,$6,$7,'test','agent',FALSE,FALSE),
			($8,$2,$9,$10,'test','agent',FALSE,FALSE),
			($11,$12,$13,$14,'test','admin',TRUE,FALSE)`,
		legacyAdmin, accountA, "legacy-admin-"+legacyAdmin.String(), legacyAdmin.String()+"@test.invalid",
		accountScopedSuper, "scoped-super-"+accountScopedSuper.String(), accountScopedSuper.String()+"@test.invalid",
		exclusiveAuthor, "exclusive-author-"+exclusiveAuthor.String(), exclusiveAuthor.String()+"@test.invalid",
		boardOwner, accountB, "board-owner-"+boardOwner.String(), boardOwner.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES
		($1,$2,'admin',TRUE),($1,$3,'agent',FALSE),
		($4,$2,'agent',TRUE),($4,$3,'super_admin',FALSE),
		($5,$2,'agent',TRUE),($6,$3,'admin',TRUE)`, legacyAdmin, accountA, accountB, accountScopedSuper, exclusiveAuthor, boardOwner); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_environments(id,account_id,name,visibility,default_access_level,created_by)
		VALUES($1,$2,'Private B','restricted','none',$3)`, environmentB, accountB, boardOwner); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboards(id,account_id,name,access_mode,created_by,updated_by)
		VALUES($1,$2,'Private B','private',$3,$3)`, boardB, accountB, boardOwner); err != nil {
		t.Fatal(err)
	}
	// Account purge must retain the membership until the account-wide cascade:
	// both Whiteboards provenance and Work event organizers reference it with
	// NO ACTION/RESTRICT semantics.
	boardA := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO whiteboards(id,account_id,name,access_mode,created_by,updated_by)
		VALUES($1,$2,'Purge provenance A','private',$3,$3)`, boardA, accountA, legacyAdmin); err != nil {
		t.Fatal(err)
	}
	boardExclusive := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO whiteboards(id,account_id,name,access_mode,created_by,updated_by)
		VALUES($1,$2,'Exclusive provenance A','private',$3,$3)`, boardExclusive, accountA, exclusiveAuthor); err != nil {
		t.Fatal(err)
	}
	whiteboardFolderParent, whiteboardFolderChild := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_folders(id,account_id,parent_id,name,created_by)
		VALUES($1,$2,NULL,'Purge whiteboard root A',$3),
			($4,$2,$1,'Purge whiteboard child A',$3)`,
		whiteboardFolderParent, accountA, legacyAdmin, whiteboardFolderChild); err != nil {
		t.Fatalf("insert nested whiteboard folders A: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE whiteboards SET folder_id=$3 WHERE account_id=$1 AND id=$2`,
		accountA, boardA, whiteboardFolderChild); err != nil {
		t.Fatalf("attach standalone whiteboard A to nested folder: %v", err)
	}
	var environmentA, workflowA, listA uuid.UUID
	if err := db.QueryRow(ctx, `SELECT list_item.environment_id,list_item.workflow_id,list_item.id FROM task_lists list_item
		WHERE list_item.account_id=$1 AND list_item.is_default AND list_item.archived_at IS NULL AND list_item.deleted_at IS NULL
		ORDER BY list_item.id LIMIT 1`, accountA).Scan(&environmentA, &workflowA, &listA); err != nil {
		t.Fatalf("load generated Work list A: %v", err)
	}
	exclusiveFolder, exclusiveList := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_folders(id,account_id,environment_id,workflow_id,name,created_by)
		VALUES($1,$2,$3,$4,'Exclusive folder A',$5)`, exclusiveFolder, accountA, environmentA, workflowA, exclusiveAuthor); err != nil {
		t.Fatalf("insert exclusive Work folder A: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(id,account_id,environment_id,folder_id,workflow_id,name,created_by)
		VALUES($1,$2,$3,$4,$5,'Exclusive list A',$6)`, exclusiveList, accountA, environmentA, exclusiveFolder, workflowA, exclusiveAuthor); err != nil {
		t.Fatalf("insert exclusive Work list A: %v", err)
	}
	var statusA uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM task_statuses
		WHERE account_id=$1 AND workflow_id=$2 ORDER BY sort_order,id LIMIT 1`, accountA, workflowA).Scan(&statusA); err != nil {
		t.Fatalf("load generated Work status A: %v", err)
	}
	exclusiveTask, exclusiveTaskComment := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO tasks(
		id,account_id,created_by,assigned_to,title,list_id,status_id,sort_order
	) VALUES($1,$2,$3,$3,'Exclusive task A',$4,$5,1024)`,
		exclusiveTask, accountA, exclusiveAuthor, exclusiveList, statusA); err != nil {
		t.Fatalf("insert exclusive Work task A: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_comments(id,account_id,task_id,author_id,body)
		VALUES($1,$2,$3,$4,'Exclusive task comment A')`,
		exclusiveTaskComment, accountA, exclusiveTask, exclusiveAuthor); err != nil {
		t.Fatalf("insert exclusive Work task comment A: %v", err)
	}
	workViewA := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_location_views(
		id,account_id,environment_id,list_id,view_type,sort_order,created_by
	) VALUES($1,$2,$3,$4,'whiteboard',1024,$5)`,
		workViewA, accountA, environmentA, exclusiveList, exclusiveAuthor); err != nil {
		t.Fatalf("insert exclusive Work whiteboard view A: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id)
		VALUES($1,$2,$3)`, accountA, workViewA, boardExclusive); err != nil {
		t.Fatalf("bind exclusive Work whiteboard view A: %v", err)
	}
	whiteboardThread, whiteboardComment := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_comment_threads(
		id,account_id,board_id,anchor_x,anchor_y,created_by,operation_id,request_payload_hash
	) VALUES($1,$2,$3,0,0,$4,$5,$6)`,
		whiteboardThread, accountA, boardExclusive, exclusiveAuthor, uuid.New(), fmt.Sprintf("%064d", 1)); err != nil {
		t.Fatalf("insert exclusive whiteboard comment thread A: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_comments(id,account_id,board_id,thread_id,author_id,body)
		VALUES($1,$2,$3,$4,$5,'Exclusive whiteboard comment A')`,
		whiteboardComment, accountA, boardExclusive, whiteboardThread, exclusiveAuthor); err != nil {
		t.Fatalf("insert exclusive whiteboard comment A: %v", err)
	}
	workEventA := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO work_events(
		id,account_id,list_id,organizer_id,title,is_all_day,start_at,end_at,timezone,created_by
	) VALUES($1,$2,$3,$4,'Purge event A',FALSE,'2026-08-25T10:00:00Z','2026-08-25T11:00:00Z','UTC',$4)`,
		workEventA, accountA, listA, legacyAdmin); err != nil {
		t.Fatalf("insert purge Work event A: %v", err)
	}
	exclusiveEvent, exclusiveOverride := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO work_events(
		id,account_id,list_id,organizer_id,title,is_all_day,start_at,end_at,timezone,created_by
	) VALUES($1,$2,$3,$4,'Exclusive event A',FALSE,'2026-08-25T12:00:00Z','2026-08-25T13:00:00Z','UTC',$4)`,
		exclusiveEvent, accountA, exclusiveList, exclusiveAuthor); err != nil {
		t.Fatalf("insert exclusive Work event A: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO work_event_occurrence_overrides(
		id,account_id,event_id,occurrence_key,created_by
	) VALUES($1,$2,$3,'2026-08-25T12:00:00Z',$4)`, exclusiveOverride, accountA, exclusiveEvent, exclusiveAuthor); err != nil {
		t.Fatalf("insert exclusive Work event override A: %v", err)
	}
	if _, err := repos.UserAccount.RemoveWithActorAndNormalize(ctx, legacyAdmin, accountA, accountScopedSuper); !errors.Is(err, repository.ErrTaskMembershipOwnsEvents) {
		t.Fatalf("membership removal with Work organizer history error=%v, want typed conflict", err)
	}
	var retainedOrganizerMembership int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM user_accounts WHERE account_id=$1 AND user_id=$2`,
		accountA, legacyAdmin).Scan(&retainedOrganizerMembership); err != nil || retainedOrganizerMembership != 1 {
		t.Fatalf("organizer membership changed after rejected removal: count=%d err=%v", retainedOrganizerMembership, err)
	}

	access, err := repos.TaskWork.ResolveEnvironmentAccess(ctx, accountB, legacyAdmin, environmentB)
	if err != nil {
		t.Fatal(err)
	}
	if access == nil || access.CanView || access.Level != domain.TaskAccessNone {
		t.Fatalf("legacy admin in A bypassed Work in B: %#v", access)
	}
	if _, err := repos.Whiteboard.RequireAccess(ctx, accountB, legacyAdmin, boardB, domain.WhiteboardAccessView); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("legacy admin in A opened private whiteboard in B: %v", err)
	}
	boards, _, err := repos.Whiteboard.ListBoards(ctx, accountB, legacyAdmin, repository.WhiteboardListOptions{Limit: 50, IncludeWork: true})
	if err != nil || len(boards) != 0 {
		t.Fatalf("legacy admin in A leaked into B Hub: boards=%d err=%v", len(boards), err)
	}

	if _, err := db.Exec(ctx, `UPDATE user_accounts SET role='admin' WHERE user_id=$1 AND account_id=$2`, legacyAdmin, accountB); err != nil {
		t.Fatal(err)
	}
	access, err = repos.TaskWork.ResolveEnvironmentAccess(ctx, accountB, legacyAdmin, environmentB)
	if err != nil || access == nil || access.Level != domain.TaskAccessFull {
		t.Fatalf("account admin in B lacked Work recovery: access=%#v err=%v", access, err)
	}
	if _, err := repos.Whiteboard.RequireAccess(ctx, accountB, legacyAdmin, boardB, domain.WhiteboardAccessManage); err != nil {
		t.Fatalf("account admin in B lacked whiteboard recovery: %v", err)
	}

	if _, err := db.Exec(ctx, `UPDATE user_accounts SET role='agent' WHERE user_id=$1 AND account_id=$2`, legacyAdmin, accountB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE users SET is_super_admin=TRUE WHERE id=$1`, legacyAdmin); err != nil {
		t.Fatal(err)
	}
	access, err = repos.TaskWork.ResolveEnvironmentAccess(ctx, accountB, legacyAdmin, environmentB)
	if err != nil || access == nil || access.Level != domain.TaskAccessFull {
		t.Fatalf("global super admin lacked Work recovery: access=%#v err=%v", access, err)
	}
	if _, err := repos.Whiteboard.RequireAccess(ctx, accountB, legacyAdmin, boardB, domain.WhiteboardAccessManage); err != nil {
		t.Fatalf("global super admin lacked whiteboard recovery: %v", err)
	}

	// Restore the legacy shape that triggered the bug, then purge its default
	// account. Relocation must mirror the B agent role without carrying admin.
	if _, err := db.Exec(ctx, `UPDATE users SET is_super_admin=FALSE,is_admin=TRUE,account_id=$2,role='admin' WHERE id=$1`, legacyAdmin, accountA); err != nil {
		t.Fatal(err)
	}
	if _, err := repos.Account.PurgeWithAuthorityImpact(ctx, accountA, "stale account name"); !errors.Is(err, repository.ErrAccountPurgeConfirmation) {
		t.Fatalf("stale purge confirmation error=%v, want account_changed", err)
	}
	effect, err := repos.Account.PurgeWithAuthorityImpact(ctx, accountA, "Authority A")
	if err != nil {
		t.Fatalf("purge account A: %v", err)
	}
	if len(effect.UserIDs) != 3 || len(effect.AccountIDs) != 2 {
		t.Fatalf("purge effect not exact: %#v", effect)
	}
	var relocatedAccount uuid.UUID
	var relocatedRole string
	var relocatedAdmin, relocatedSuper, defaultB bool
	if err := db.QueryRow(ctx, `SELECT account_id,role,is_admin,is_super_admin FROM users WHERE id=$1`, legacyAdmin).
		Scan(&relocatedAccount, &relocatedRole, &relocatedAdmin, &relocatedSuper); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT is_default FROM user_accounts WHERE user_id=$1 AND account_id=$2`, legacyAdmin, accountB).Scan(&defaultB); err != nil {
		t.Fatal(err)
	}
	if relocatedAccount != accountB || relocatedRole != domain.RoleAgent || relocatedAdmin || relocatedSuper || !defaultB {
		t.Fatalf("purge carried legacy authority into B: account=%s role=%s admin=%t super=%t default=%t",
			relocatedAccount, relocatedRole, relocatedAdmin, relocatedSuper, defaultB)
	}
	var scopedAccount uuid.UUID
	var scopedRole string
	var scopedAdmin, scopedGlobalSuper bool
	if err := db.QueryRow(ctx, `SELECT account_id,role,is_admin,is_super_admin FROM users WHERE id=$1`, accountScopedSuper).
		Scan(&scopedAccount, &scopedRole, &scopedAdmin, &scopedGlobalSuper); err != nil {
		t.Fatal(err)
	}
	if scopedAccount != accountB || scopedRole != domain.RoleSuperAdmin || !scopedAdmin || scopedGlobalSuper {
		t.Fatalf("account-scoped super_admin was promoted globally: account=%s role=%s admin=%t global_super=%t",
			scopedAccount, scopedRole, scopedAdmin, scopedGlobalSuper)
	}
	var boardRevision int64
	if err := db.QueryRow(ctx, `SELECT access_revision FROM whiteboards WHERE account_id=$1 AND id=$2`, accountB, boardB).Scan(&boardRevision); err != nil {
		t.Fatal(err)
	}
	if boardRevision != 2 {
		t.Fatalf("B whiteboard revision=%d, want 2 after relocated-user invalidation", boardRevision)
	}
	var purgedAccountRows, purgedBoardRows, purgedEventRows, exclusiveUserRows, exclusiveFolderRows, exclusiveListRows int
	var exclusiveTaskRows, exclusiveTaskCommentRows, exclusiveOverrideRows, workViewRows, workBindingRows int
	var whiteboardThreadRows, whiteboardCommentRows int
	var whiteboardFolderParentRows, whiteboardFolderChildRows int
	if err := db.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM accounts WHERE id=$1),
		(SELECT COUNT(*) FROM whiteboards WHERE account_id=$1 AND id=$2),
		(SELECT COUNT(*) FROM work_events WHERE account_id=$1 AND id=$3),
		(SELECT COUNT(*) FROM users WHERE id=$4),
		(SELECT COUNT(*) FROM task_folders WHERE account_id=$1 AND id=$5),
		(SELECT COUNT(*) FROM task_lists WHERE account_id=$1 AND id=$6),
		(SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND id=$7),
		(SELECT COUNT(*) FROM task_comments WHERE account_id=$1 AND id=$8),
		(SELECT COUNT(*) FROM work_event_occurrence_overrides WHERE account_id=$1 AND id=$9),
		(SELECT COUNT(*) FROM task_location_views WHERE account_id=$1 AND id=$10),
		(SELECT COUNT(*) FROM task_location_whiteboard_views WHERE account_id=$1 AND task_view_id=$10),
		(SELECT COUNT(*) FROM whiteboard_comment_threads WHERE account_id=$1 AND id=$11),
		(SELECT COUNT(*) FROM whiteboard_comments WHERE account_id=$1 AND id=$12),
		(SELECT COUNT(*) FROM whiteboard_folders WHERE account_id=$1 AND id=$13),
		(SELECT COUNT(*) FROM whiteboard_folders WHERE account_id=$1 AND id=$14)`,
		accountA, boardA, workEventA, exclusiveAuthor, exclusiveFolder, exclusiveList,
		exclusiveTask, exclusiveTaskComment, exclusiveOverride, workViewA, whiteboardThread, whiteboardComment,
		whiteboardFolderParent, whiteboardFolderChild).
		Scan(&purgedAccountRows, &purgedBoardRows, &purgedEventRows, &exclusiveUserRows,
			&exclusiveFolderRows, &exclusiveListRows, &exclusiveTaskRows, &exclusiveTaskCommentRows,
			&exclusiveOverrideRows, &workViewRows, &workBindingRows, &whiteboardThreadRows, &whiteboardCommentRows,
			&whiteboardFolderParentRows, &whiteboardFolderChildRows); err != nil {
		t.Fatal(err)
	}
	if purgedAccountRows != 0 || purgedBoardRows != 0 || purgedEventRows != 0 || exclusiveUserRows != 0 ||
		exclusiveFolderRows != 0 || exclusiveListRows != 0 || exclusiveTaskRows != 0 || exclusiveTaskCommentRows != 0 ||
		exclusiveOverrideRows != 0 || workViewRows != 0 || workBindingRows != 0 || whiteboardThreadRows != 0 || whiteboardCommentRows != 0 ||
		whiteboardFolderParentRows != 0 || whiteboardFolderChildRows != 0 {
		t.Fatalf("account purge incomplete: account=%d board=%d work_event=%d user=%d folder=%d list=%d task=%d task_comment=%d override=%d work_view=%d binding=%d whiteboard_thread=%d whiteboard_comment=%d whiteboard_folders=%d/%d",
			purgedAccountRows, purgedBoardRows, purgedEventRows, exclusiveUserRows,
			exclusiveFolderRows, exclusiveListRows, exclusiveTaskRows, exclusiveTaskCommentRows,
			exclusiveOverrideRows, workViewRows, workBindingRows, whiteboardThreadRows, whiteboardCommentRows,
			whiteboardFolderParentRows, whiteboardFolderChildRows)
	}

	// Account purge must leave no account-scoped row in any current or future
	// table. This catalog assertion complements the named regression fixtures
	// above and catches an additive schema table omitted from the purge tree.
	tableRows, err := db.Query(ctx, `SELECT table_class.relname
		FROM pg_class table_class
		JOIN pg_namespace table_schema ON table_schema.oid=table_class.relnamespace
		JOIN pg_attribute account_column ON account_column.attrelid=table_class.oid
			AND account_column.attname='account_id' AND NOT account_column.attisdropped
		WHERE table_schema.nspname='public' AND table_class.relkind IN ('r','p')
		ORDER BY table_class.relname`)
	if err != nil {
		t.Fatal(err)
	}
	accountTables := make([]string, 0, 128)
	for tableRows.Next() {
		var table string
		if err := tableRows.Scan(&table); err != nil {
			tableRows.Close()
			t.Fatal(err)
		}
		accountTables = append(accountTables, table)
	}
	if err := tableRows.Err(); err != nil {
		tableRows.Close()
		t.Fatal(err)
	}
	tableRows.Close()
	for _, table := range accountTables {
		var count int
		query := `SELECT COUNT(*) FROM ` + pgx.Identifier{table}.Sanitize() + ` WHERE account_id=$1`
		if err := db.QueryRow(ctx, query, accountA).Scan(&count); err != nil {
			t.Fatalf("count purged account rows in %s: %v", table, err)
		}
		if count != 0 {
			t.Fatalf("account-scoped orphan survived in %s: %d rows", table, count)
		}
	}

	var accountBRows, boardBRows, environmentBRows, membershipBRows int
	if err := db.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM accounts WHERE id=$1),
		(SELECT COUNT(*) FROM whiteboards WHERE account_id=$1 AND id=$2),
		(SELECT COUNT(*) FROM task_environments WHERE account_id=$1 AND id=$3),
		(SELECT COUNT(*) FROM user_accounts WHERE account_id=$1 AND user_id IN ($4,$5))`,
		accountB, boardB, environmentB, legacyAdmin, accountScopedSuper).
		Scan(&accountBRows, &boardBRows, &environmentBRows, &membershipBRows); err != nil {
		t.Fatal(err)
	}
	if accountBRows != 1 || boardBRows != 1 || environmentBRows != 1 || membershipBRows != 2 {
		t.Fatalf("account B changed during A purge: account=%d board=%d environment=%d memberships=%d",
			accountBRows, boardBRows, environmentBRows, membershipBRows)
	}
}
