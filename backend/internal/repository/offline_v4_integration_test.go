package repository

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
)

func offlineV4IntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("OFFLINE_V4_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("OFFLINE_V4_TEST_DATABASE_URL required for dedicated synthetic DB")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Path != "/v4_integration" {
		t.Fatal("integration tests require exact disposable database v4_integration")
	}
	pool, err := pgxpool.New(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err = database.Migrate(pool); err != nil {
		t.Fatalf("first startup migration: %v", err)
	}
	if err = database.Migrate(pool); err != nil {
		t.Fatalf("second startup migration: %v", err)
	}
	return pool
}

func TestOfflineV4IntegrationIsolationReplayRevokeAndTasks(t *testing.T) {
	pool := offlineV4IntegrationPool(t)
	ctx := context.Background()
	r := &OfflineV4Repository{db: pool}
	accountID, foreignAccountID, actor, other, super := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{accountID, foreignAccountID} {
		if _, err := pool.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'V4 synthetic account')`, id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO subscriptions(account_id,plan_code,status) VALUES($1,'free','active')`, id); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []uuid.UUID{actor, other, super} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,is_active,is_super_admin) VALUES($1,$2,$3,$4,'test-only-hash',TRUE,$5)`, id, accountID, "v4-"+id.String(), id.String()+"@test.invalid", id == super); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES($1,$2,'admin',TRUE)`, id, accountID); err != nil {
			t.Fatal(err)
		}
	}
	profile := uuid.New()
	key := json.RawMessage(`{"kty":"EC","crv":"P-256","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","alg":"ES256","use":"sig","kid":"fixture"}`)
	enroll := func(user uuid.UUID) (uuid.UUID, error) {
		challenge, err := r.CreateChallenge(ctx, user, uuid.Nil, "enrollment")
		if err != nil {
			return uuid.Nil, err
		}
		return r.RequestEnrollment(ctx, OfflineV4EnrollmentInput{BrowserProfileID: profile, UserID: user, BrowserName: "Synthetic browser", DisplayName: "Synthetic profile", SigningJWK: key, KeyThumbprint: profile.String()}, challenge.ID, challenge.Nonce)
	}
	request, err := enroll(actor)
	if err != nil {
		t.Fatal(err)
	}
	approval := []OfflineV3GrantApproval{{AccountID: accountID, Actions: []string{"tasks.read", "tasks.create", "tasks.complete", "contacts.read", "programs.read", "whiteboards.read"}, MaxResources: 20, QuotaBytes: 32 << 20}}
	if _, err = r.Approve(ctx, request, actor, approval); !errors.Is(err, ErrOfflineV3AccessDenied) {
		t.Fatalf("non-superadmin approved: %v", err)
	}
	grants, err := r.Approve(ctx, request, super, approval)
	if err != nil || len(grants) != 1 {
		t.Fatalf("approve: count=%d err=%v", len(grants), err)
	}
	grant := grants[0]
	otherRequest, err := enroll(other)
	if err != nil {
		t.Fatal(err)
	}
	others, err := r.Approve(ctx, otherRequest, super, approval)
	if err != nil || len(others) != 1 {
		t.Fatalf("second user same profile: %v", err)
	}
	if others[0].GrantID == grant.GrantID {
		t.Fatal("two users share grant")
	}
	if _, err = pool.Exec(ctx, `INSERT INTO offline_v4_grant_keys(grant_id,account_id,signing_jwk,key_thumbprint) VALUES($1,$2,$3,'foreign-key')`, others[0].GrantID, foreignAccountID, key); err == nil {
		t.Fatal("composite FK admitted a grant key in another account")
	} else {
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
			t.Fatalf("expected account FK rejection, got %v", err)
		}
	}
	keys, err := r.CreateChallenge(ctx, actor, grant.GrantID, "keys")
	if err != nil {
		t.Fatal(err)
	}
	if err = r.RegisterKey(ctx, grant.GrantID, actor, keys.ID, keys.Nonce, key, "grant-key"); err != nil {
		t.Fatal(err)
	}
	if err = r.RegisterKey(ctx, grant.GrantID, actor, keys.ID, keys.Nonce, key, "grant-key"); !errors.Is(err, ErrOfflineV3Replay) {
		t.Fatalf("key challenge replay: %v", err)
	}
	contactID, foreignContactID := uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO contacts(id,account_id,jid,phone,name) VALUES($1,$2,'51900000001@s.whatsapp.net','51900000001','Visible synthetic'),($3,$4,'51900000002@s.whatsapp.net','51900000002','Foreign synthetic')`, contactID, accountID, foreignContactID, foreignAccountID); err != nil {
		t.Fatal(err)
	}
	badSelection := []domain.OfflineV3Selection{{Module: "contacts", ResourceType: "contact", ResourceID: foreignContactID}}
	if err = r.ReplaceSelections(ctx, grant.GrantID, actor, 1, badSelection); !errors.Is(err, ErrOfflineV3AccessDenied) {
		t.Fatalf("foreign contact selected: %v", err)
	}
	if err = r.ReplaceSelections(ctx, grant.GrantID, other, 1, nil); !errors.Is(err, ErrOfflineV3NotFound) {
		t.Fatalf("other actor selected for grant: %v", err)
	}
	environment, workflow, list, openStatus, doneStatus := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO task_environments(id,account_id,name,visibility,default_access_level,created_by) VALUES($1,$2,'V4 environment','account','edit',$3)`, environment, accountID, actor); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO task_workflows(id,account_id,environment_id,name,is_default,created_by) VALUES($1,$2,$3,'V4 workflow',TRUE,$4)`, workflow, accountID, environment, actor); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO task_statuses(id,account_id,workflow_id,name,color,category,sort_order,is_default) VALUES($1,$2,$3,'Open','#64748b','not_started',0,TRUE),($4,$2,$3,'Done','#10b981','done',1,FALSE)`, openStatus, accountID, workflow, doneStatus); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO task_lists(id,account_id,environment_id,workflow_id,name,created_by) VALUES($1,$2,$3,$4,'V4 list',$5)`, list, accountID, environment, workflow, actor); err != nil {
		t.Fatal(err)
	}
	programID, boardID, archivedBoard, foreignBoard, foreignProgram, legacyEvent := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO programs(id,account_id,name,type) VALUES($1,$2,'V4 catalog program','course'),($3,$4,'V4 catalog program','course'),($5,$2,'V4 catalog program','event')`, programID, accountID, foreignProgram, foreignAccountID, legacyEvent); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO whiteboards(id,account_id,name,access_mode,archived_at,scene_json) VALUES($1,$2,'V4 catalog board','account',NULL,'{"elements":[],"appState":{}}'),($3,$2,'V4 catalog board','account',NOW(),'{}'),($4,$5,'V4 catalog board','account',NULL,'{}')`, boardID, accountID, archivedBoard, foreignBoard, foreignAccountID); err != nil {
		t.Fatal(err)
	}
	// Empty custom_name must not hide the canonical display label from search.
	if _, err = pool.Exec(ctx, `UPDATE contacts SET custom_name='' WHERE id=$1 AND account_id=$2`, contactID, accountID); err != nil {
		t.Fatal(err)
	}
	for _, catalog := range []struct {
		module, query string
		resource      uuid.UUID
	}{{"tasks", "  V4 LIST  ", list}, {"contacts", "VISIBLE SYNTHETIC", contactID}, {"programs", "V4 CATALOG PROGRAM", programID}, {"whiteboards", "V4 CATALOG BOARD", boardID}} {
		t.Run("catalog_"+catalog.module, func(t *testing.T) {
			items, next, err := r.ListResourceCandidates(ctx, grant.GrantID, actor, catalog.module, catalog.query, uuid.Nil, 50)
			if err != nil || len(items) != 1 || items[0].ResourceID != catalog.resource || next != nil {
				t.Fatalf("catalog returned foreign, archived or wrong resource: count=%d err=%v", len(items), err)
			}
			if items[0].Module != catalog.module || items[0].Label == "" {
				t.Fatal("catalog omitted its module or canonical label")
			}
			end, continuation, err := r.ListResourceCandidates(ctx, grant.GrantID, actor, catalog.module, catalog.query, catalog.resource, 1)
			if err != nil || len(end) != 0 || continuation != nil {
				t.Fatalf("catalog cursor repeated its anchor or admitted foreign/archive rows: %v", err)
			}
			empty, cursor, err := r.ListResourceCandidates(ctx, grant.GrantID, actor, catalog.module, "does-not-exist-in-synthetic-account", uuid.Nil, 50)
			if err != nil || len(empty) != 0 || cursor != nil {
				t.Fatalf("empty search invalid: %v", err)
			}
			if _, _, err = r.ListResourceCandidates(ctx, grant.GrantID, other, catalog.module, "", uuid.Nil, 50); !errors.Is(err, ErrOfflineV3NotFound) {
				t.Fatalf("catalog allowed another grant actor: %v", err)
			}
		})
	}
	for _, invalidBoard := range []uuid.UUID{archivedBoard, foreignBoard} {
		if err = r.ReplaceSelections(ctx, grant.GrantID, actor, 1, []domain.OfflineV3Selection{{Module: "whiteboards", ResourceType: "whiteboard", ResourceID: invalidBoard}}); !errors.Is(err, ErrOfflineV3AccessDenied) {
			t.Fatalf("archived/foreign whiteboard passed selection ACL: %v", err)
		}
	}
	selection := []domain.OfflineV3Selection{{Module: "contacts", ResourceType: "contact", ResourceID: contactID}, {Module: "tasks", ResourceType: "task_list", ResourceID: list}, {Module: "programs", ResourceType: "program", ResourceID: programID}, {Module: "whiteboards", ResourceType: "whiteboard", ResourceID: boardID}}
	if err = r.ReplaceSelections(ctx, grant.GrantID, actor, 1, selection); err != nil {
		t.Fatal(err)
	}
	selected, current, err := r.Selections(ctx, grant.GrantID, actor)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 4 || current.SelectionRevision != 2 {
		t.Fatal("selection not committed")
	}
	secondContact := uuid.New()
	if _, err = pool.Exec(ctx, `INSERT INTO contacts(id,account_id,jid,phone,name) VALUES($1,$2,'51900000003@s.whatsapp.net','51900000003','Second synthetic')`, secondContact, accountID); err != nil {
		t.Fatal(err)
	}
	firstPage, next, err := r.ListResourceCandidates(ctx, grant.GrantID, actor, "contacts", "", uuid.Nil, 1)
	if err != nil || len(firstPage) != 1 || next == nil {
		t.Fatalf("catalog first page lost continuation: %v", err)
	}
	lastPage, last, err := r.ListResourceCandidates(ctx, grant.GrantID, actor, "contacts", "", *next, 1)
	if err != nil || len(lastPage) != 1 || last != nil || firstPage[0].ResourceID == lastPage[0].ResourceID {
		t.Fatalf("catalog continuation invalid: %v", err)
	}
	var listSelection uuid.UUID
	for _, s := range selected {
		if s.ResourceID == list {
			listSelection = s.ID
		}
	}
	record, err := r.AuthRecord(ctx, grant.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := r.CreateChallenge(ctx, uuid.Nil, grant.GrantID, "sync")
	if err != nil {
		t.Fatal(err)
	}
	wantSnapshots := make([]uuid.UUID, 0, len(selected))
	for _, item := range selected {
		wantSnapshots = append(wantSnapshots, item.ID)
	}
	input := OfflineV4SyncInput{GrantID: grant.GrantID, BrowserProfileID: profile, ChallengeID: challenge.ID, Nonce: challenge.Nonce, SelectionRevision: 2, WantSnapshots: wantSnapshots}
	synced, err := r.Sync(ctx, input, record, true, nil, nil)
	if err != nil || len(synced.Snapshots) != 4 {
		t.Fatalf("initial snapshot sync: %v", err)
	}
	if _, err = r.Sync(ctx, input, record, true, nil, nil); !errors.Is(err, ErrOfflineV3Replay) {
		t.Fatalf("sync challenge replay: %v", err)
	}
	operation := domain.OfflineV3Operation{ProtocolVersion: 4, GrantID: grant.GrantID, BrowserProfileID: profile, UserID: actor, AccountID: accountID, OperationID: uuid.New(), Action: "tasks.create", SelectionID: listSelection, ResourceID: uuid.New(), SelectionRevision: 2, CredentialEpoch: record.CredentialEpoch, AuthorityEpoch: record.AuthorityEpoch, Payload: json.RawMessage(`{"title":"Offline synthetic task","description":"Unicode ñ < >","priority":"medium"}`), OccurredAt: time.Now().UTC()}
	complete := operation
	complete.OperationID = uuid.New()
	complete.Action = "tasks.complete"
	complete.Payload = json.RawMessage(`{}`)
	complete.DependsOnOperationID = &operation.OperationID
	syncOps := func(ops []domain.OfflineV3Operation, finalize func(context.Context, *OfflineV4AuthRecord) error) (*OfflineV4SyncResult, error) {
		challenge, err := r.CreateChallenge(ctx, uuid.Nil, grant.GrantID, "sync")
		if err != nil {
			return nil, err
		}
		return r.Sync(ctx, OfflineV4SyncInput{GrantID: grant.GrantID, BrowserProfileID: profile, ChallengeID: challenge.ID, Nonce: challenge.Nonce, SelectionRevision: 2, Operations: ops}, record, true, nil, finalize)
	}
	result, err := syncOps([]domain.OfflineV3Operation{operation, complete}, nil)
	if err != nil || len(result.Receipts) != 2 || result.Receipts[0].Status != "applied" || result.Receipts[1].Status != "applied" {
		t.Fatalf("create+complete: result=%+v err=%v", result, err)
	}
	result, err = syncOps([]domain.OfflineV3Operation{operation, complete}, nil)
	if err != nil || result.Receipts[0].Status != "applied" {
		t.Fatalf("idempotent retry: %v", err)
	}
	var tasks, receipts, effects int
	if err = pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM tasks WHERE id=$1),(SELECT count(*) FROM offline_v4_receipts WHERE grant_id=$2),(SELECT count(*) FROM offline_v4_event_outbox WHERE grant_id=$2)`, operation.ResourceID, grant.GrantID).Scan(&tasks, &receipts, &effects); err != nil {
		t.Fatal(err)
	}
	if tasks != 1 || receipts != 2 || effects != 2 {
		t.Fatalf("duplicate task effects: %d/%d/%d", tasks, receipts, effects)
	}
	changed := operation
	changed.Payload = json.RawMessage(`{"title":"Changed duplicate"}`)
	if _, err = syncOps([]domain.OfflineV3Operation{changed}, nil); !errors.Is(err, ErrOfflineV3ReceiptReuse) {
		t.Fatalf("operation ID reuse: %v", err)
	}
	foreign := operation
	foreign.OperationID = uuid.New()
	foreign.UserID = other
	if _, err = syncOps([]domain.OfflineV3Operation{foreign}, nil); !errors.Is(err, ErrOfflineV3Invalid) {
		t.Fatalf("foreign actor operation: %v", err)
	}
	rollback := operation
	rollback.OperationID = uuid.New()
	rollback.ResourceID = uuid.New()
	if _, err = syncOps([]domain.OfflineV3Operation{rollback}, func(context.Context, *OfflineV4AuthRecord) error { return errors.New("signer unavailable") }); err == nil {
		t.Fatal("signer failure committed")
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE id=$1`, rollback.ResourceID).Scan(&tasks); err != nil || tasks != 0 {
		t.Fatal("task survived signer rollback")
	}
	if _, err = pool.Exec(ctx, `UPDATE offline_v4_selections SET byte_size=$2 WHERE id=$1`, listSelection, record.QuotaBytes+1); err != nil {
		t.Fatal(err)
	}
	if _, err = syncOps(nil, nil); !errors.Is(err, ErrOfflineV4QuotaExceeded) {
		t.Fatalf("quota budget ignored: %v", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE offline_v4_selections SET byte_size=0 WHERE id=$1`, listSelection); err != nil {
		t.Fatal(err)
	}
	if _, err = syncOps(nil, func(ctx context.Context, _ *OfflineV4AuthRecord) error {
		contender, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer contender.Rollback(ctx)
		var locked uuid.UUID
		err = contender.QueryRow(ctx, `SELECT id FROM offline_v4_grants WHERE id=$1 FOR UPDATE NOWAIT`, grant.GrantID).Scan(&locked)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
			return errors.New("lease finalizer ran without holding grant authority lock")
		}
		return nil
	}); err != nil {
		t.Fatalf("lease/revoke serialization: %v", err)
	}
	if count, err := r.Revoke(ctx, super, grant.GrantID, "grant"); err != nil || count != 1 {
		t.Fatalf("revoke: %d %v", count, err)
	}
	if _, err = syncOps(nil, nil); !errors.Is(err, ErrOfflineV3AccessDenied) {
		t.Fatalf("revoked grant sync: %v", err)
	}
	otherGrants, err := r.ListGrants(ctx, other, profile)
	if err != nil || len(otherGrants) != 1 || otherGrants[0].State != "active" {
		t.Fatal("revoking actor A changed B")
	}
	var nativeRows int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM offline_v3_installations WHERE display_name LIKE 'V4%'`).Scan(&nativeRows); err != nil || nativeRows != 0 {
		t.Fatal("browser enrollment created native identities")
	}
}
