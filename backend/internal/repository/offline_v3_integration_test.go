package repository

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
)

var (
	offlineV3MigrationOnce sync.Once
	offlineV3MigrationErr  error
)

// offlineV3TestPool is shared by repository integration tests. Callers must
// create UUID-unique fixtures and must not truncate the shared disposable DB.
func offlineV3TestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	rawURL := os.Getenv("OFFLINE_V3_TEST_DATABASE_URL")
	if rawURL == "" {
		t.Skip("OFFLINE_V3_TEST_DATABASE_URL is required")
	}
	pool, err := pgxpool.New(context.Background(), rawURL)
	if err != nil {
		t.Fatalf("connect disposable PostgreSQL: %v", err)
	}
	t.Cleanup(pool.Close)
	offlineV3MigrationOnce.Do(func() { offlineV3MigrationErr = database.Migrate(pool) })
	if offlineV3MigrationErr != nil {
		t.Fatalf("migrate disposable PostgreSQL: %v", offlineV3MigrationErr)
	}
	return pool
}

type offlineV3Fixture struct {
	Repository          *OfflineV3Repository
	AccountID           uuid.UUID
	ForeignAccountID    uuid.UUID
	UserID              uuid.UUID
	ForeignUserID       uuid.UUID
	InstallationID      uuid.UUID
	PrincipalID         uuid.UUID
	BrowserProfileID    uuid.UUID
	AuthorizationID     uuid.UUID
	GrantID             uuid.UUID
	TransportCapability string
	EnvironmentID       uuid.UUID
	WorkflowID          uuid.UUID
	NotStartedStatusID  uuid.UUID
	DoneStatusID        uuid.UUID
	ListID              uuid.UUID
	SelectionID         uuid.UUID
}

func offlineV3EnrollmentInputForFixture(fixture offlineV3Fixture, authorizationID uuid.UUID, requestDigest string) OfflineV3EnrollmentInput {
	dummyJWK := json.RawMessage(`{"kty":"EC","crv":"P-256","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","use":"sig","alg":"ES256","kid":"fixture"}`)
	serviceJWK := json.RawMessage(`{"kty":"EC","crv":"P-256","x":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC","y":"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD","use":"enc","alg":"ECDH-ES+A256KW","kid":"fixture-enc"}`)
	return OfflineV3EnrollmentInput{
		InstallationID: fixture.InstallationID, WindowsPrincipalID: fixture.PrincipalID, BrowserProfileID: fixture.BrowserProfileID,
		AuthorizationID: authorizationID, UserID: fixture.UserID, DisplayName: "Fixture PC", PrincipalDisplayName: "Fixture SID",
		BrowserName: "Fixture browser", ClientVersion: "3.0.0", SIDHash: stringsOf("a", 64),
		InstallationSigningJWK: dummyJWK, InstallationKeyThumbprint: stringsOf(fixture.InstallationID.String(), 43), ServiceEncryptionJWK: serviceJWK,
		ServiceKeyThumbprint: stringsOf(fixture.PrincipalID.String(), 43), BrowserDPoPJWK: dummyJWK, BrowserKeyThumbprint: stringsOf(fixture.BrowserProfileID.String(), 43),
		RequestDigest: requestDigest,
	}
}

func seedOfflineV3Fixture(t *testing.T, pool *pgxpool.Pool, actions ...string) offlineV3Fixture {
	t.Helper()
	ctx := context.Background()
	fixture := offlineV3Fixture{
		Repository: &OfflineV3Repository{db: pool}, AccountID: uuid.New(), ForeignAccountID: uuid.New(),
		UserID: uuid.New(), ForeignUserID: uuid.New(), InstallationID: uuid.New(), PrincipalID: uuid.New(),
		BrowserProfileID: uuid.New(), AuthorizationID: uuid.New(), EnvironmentID: uuid.New(), WorkflowID: uuid.New(),
		NotStartedStatusID: uuid.New(), DoneStatusID: uuid.New(), ListID: uuid.New(),
	}
	if len(actions) == 0 {
		actions = []string{domain.OfflineV3ActionTasksRead, domain.OfflineV3ActionTasksCreate, domain.OfflineV3ActionTasksComplete}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,$2),($3,$4)`, fixture.AccountID,
		"Offline v3 "+fixture.AccountID.String(), fixture.ForeignAccountID, "Foreign "+fixture.ForeignAccountID.String()); err != nil {
		t.Fatalf("insert fixture accounts: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,display_name,role,is_admin,is_super_admin,is_active)
		VALUES($1,$2,$3,$4,'test-hash','Offline Actor','agent',FALSE,FALSE,TRUE),
		($5,$6,$7,$8,'foreign-hash','Foreign Actor','agent',FALSE,FALSE,TRUE)`, fixture.UserID, fixture.AccountID,
		"offline-"+fixture.UserID.String(), fixture.UserID.String()+"@test.invalid", fixture.ForeignUserID, fixture.ForeignAccountID,
		"foreign-"+fixture.ForeignUserID.String(), fixture.ForeignUserID.String()+"@test.invalid"); err != nil {
		t.Fatalf("insert fixture users: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES
		($1,$2,'admin',TRUE),($3,$4,'admin',TRUE)`, fixture.UserID, fixture.AccountID, fixture.ForeignUserID, fixture.ForeignAccountID); err != nil {
		t.Fatalf("insert fixture memberships: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_environments(id,account_id,name,visibility,default_access_level,created_by)
		VALUES($1,$2,'Offline environment','account','edit',$3)`, fixture.EnvironmentID, fixture.AccountID, fixture.UserID); err != nil {
		t.Fatalf("insert fixture environment: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_workflows(id,account_id,environment_id,name,is_default,created_by)
		VALUES($1,$2,$3,'Offline workflow',TRUE,$4)`, fixture.WorkflowID, fixture.AccountID, fixture.EnvironmentID, fixture.UserID); err != nil {
		t.Fatalf("insert fixture workflow: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_statuses(id,account_id,workflow_id,name,color,category,sort_order,is_default)
		VALUES($1,$2,$3,'Pendiente','#64748b','not_started',0,TRUE),($4,$2,$3,'Hecho','#10b981','done',1,FALSE)`,
		fixture.NotStartedStatusID, fixture.AccountID, fixture.WorkflowID, fixture.DoneStatusID); err != nil {
		t.Fatalf("insert fixture statuses: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_lists(id,account_id,environment_id,workflow_id,name,created_by)
		VALUES($1,$2,$3,$4,'Offline list',$5)`, fixture.ListID, fixture.AccountID, fixture.EnvironmentID, fixture.WorkflowID, fixture.UserID); err != nil {
		t.Fatalf("insert fixture list: %v", err)
	}
	dummyJWK := json.RawMessage(`{"kty":"EC","crv":"P-256","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","use":"sig","alg":"ES256","kid":"fixture"}`)
	serviceJWK := json.RawMessage(`{"kty":"EC","crv":"P-256","x":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC","y":"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD","use":"enc","alg":"ECDH-ES+A256KW","kid":"fixture-enc"}`)
	request, _, err := fixture.Repository.RequestEnrollment(ctx, offlineV3EnrollmentInputForFixture(fixture, fixture.AuthorizationID, stringsOf("e", 64)))
	if err != nil {
		t.Fatalf("request fixture enrollment: %v", err)
	}
	grants, err := fixture.Repository.ApproveEnrollment(ctx, request.ID, fixture.UserID, []OfflineV3GrantApproval{{
		AccountID: fixture.AccountID, Actions: actions, MaxResources: 20, QuotaBytes: 32 << 20,
	}})
	if err != nil || len(grants) != 1 {
		t.Fatalf("approve fixture enrollment: grants=%d err=%v", len(grants), err)
	}
	fixture.GrantID = grants[0].GrantID
	if fixture.TransportCapability, err = fixture.Repository.RegisterGrantKeys(ctx, fixture.GrantID, fixture.UserID, dummyJWK, stringsOf("f", 43), serviceJWK, stringsOf("g", 43)); err != nil {
		t.Fatalf("register fixture grant keys: %v", err)
	}
	revision, _, err := fixture.Repository.ReplaceSelections(ctx, fixture.GrantID, fixture.UserID, grants[0].SelectionRevision,
		[]domain.OfflineV3Selection{{Module: domain.OfflineModuleTasks, ResourceType: domain.OfflineResourceTaskList, ResourceID: fixture.ListID}}, nil)
	if err != nil || revision <= grants[0].SelectionRevision {
		t.Fatalf("select fixture task list: revision=%d err=%v", revision, err)
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM offline_v3_selections WHERE grant_id=$1 AND account_id=$2 AND resource_id=$3`,
		fixture.GrantID, fixture.AccountID, fixture.ListID).Scan(&fixture.SelectionID); err != nil {
		t.Fatalf("load fixture selection: %v", err)
	}
	return fixture
}

func stringsOf(value string, count int) string {
	result := ""
	for len(result) < count {
		result += value
	}
	return result[:count]
}

func TestOfflineV3CompositeForeignKeysRejectCrossAccountRows(t *testing.T) {
	pool := offlineV3TestPool(t)
	fixture := seedOfflineV3Fixture(t, pool)
	_, err := pool.Exec(context.Background(), `INSERT INTO offline_v3_receipts(grant_id,account_id,operation_id,request_hash,action_code,resource_id,status)
		VALUES($1,$2,$3,$4,'tasks.create',$5,'rejected')`, fixture.GrantID, fixture.ForeignAccountID, uuid.New(), stringsOf("a", 64), uuid.New())
	if err == nil {
		t.Fatal("cross-account receipt bypassed composite grant boundary")
	}
}

func TestOfflineV3EnrollmentRetryAndReplacementGrantLifecycle(t *testing.T) {
	pool := offlineV3TestPool(t)
	fixture := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()

	pendingAuthorizationID := uuid.New()
	pending, idempotent, err := fixture.Repository.RequestEnrollment(ctx,
		offlineV3EnrollmentInputForFixture(fixture, pendingAuthorizationID, stringsOf("1", 64)))
	if err != nil || idempotent || pending.AuthorizationID != pendingAuthorizationID {
		t.Fatalf("create second enrollment attempt: request=%+v idempotent=%v err=%v", pending, idempotent, err)
	}
	retry, idempotent, err := fixture.Repository.RequestEnrollment(ctx,
		offlineV3EnrollmentInputForFixture(fixture, uuid.New(), stringsOf("2", 64)))
	if err != nil || !idempotent || retry.ID != pending.ID || retry.AuthorizationID != pending.AuthorizationID {
		t.Fatalf("retry must return existing pending request: request=%+v idempotent=%v err=%v", retry, idempotent, err)
	}
	approval := []OfflineV3GrantApproval{{AccountID: fixture.AccountID,
		Actions: []string{domain.OfflineV3ActionTasksRead}, MaxResources: 5, QuotaBytes: 8 << 20}}
	if _, err := fixture.Repository.ApproveEnrollment(ctx, pending.ID, fixture.UserID, approval); !errors.Is(err, ErrOfflineV3Conflict) {
		t.Fatalf("duplicate live tuple/account grant was not rejected: %v", err)
	}
	if err := fixture.Repository.RejectEnrollment(ctx, pending.ID, fixture.UserID, "retry test"); err != nil {
		t.Fatalf("reject pending enrollment: %v", err)
	}

	replacementAuthorizationID := uuid.New()
	replacement, idempotent, err := fixture.Repository.RequestEnrollment(ctx,
		offlineV3EnrollmentInputForFixture(fixture, replacementAuthorizationID, stringsOf("3", 64)))
	if err != nil || idempotent || replacement.AuthorizationID != replacementAuthorizationID {
		t.Fatalf("request after rejection: request=%+v idempotent=%v err=%v", replacement, idempotent, err)
	}
	plan, err := fixture.Repository.PlanAdminControl(ctx, "grant", fixture.GrantID)
	if err != nil {
		t.Fatalf("plan prior grant revocation: %v", err)
	}
	if err := fixture.Repository.ApplyAdminControl(ctx, *plan, offlineV3TestAdminControl(*plan, "wipe"), fixture.UserID); err != nil {
		t.Fatalf("revoke prior grant: %v", err)
	}
	grants, err := fixture.Repository.ApproveEnrollment(ctx, replacement.ID, fixture.UserID, approval)
	if err != nil {
		t.Fatalf("approve replacement after irreversible revocation: %v", err)
	}
	activeForTuple := 0
	for _, grant := range grants {
		if grant.InstallationID == fixture.InstallationID && grant.BrowserProfileID == fixture.BrowserProfileID &&
			grant.UserID == fixture.UserID && grant.AccountID == fixture.AccountID && grant.State == "active" {
			activeForTuple++
			if grant.AuthorizationID != replacementAuthorizationID {
				t.Fatalf("active grant retained stale authorization: %s", grant.AuthorizationID)
			}
		}
	}
	if activeForTuple != 1 {
		t.Fatalf("expected exactly one active tuple/account grant, got %d", activeForTuple)
	}
}

func TestOfflineV3WhiteboardSnapshotClosesAndVerifiesReferencedAssets(t *testing.T) {
	pool := offlineV3TestPool(t)
	fixture := seedOfflineV3Fixture(t, pool, domain.OfflineV3ActionTasksRead, domain.OfflineV3ActionWhiteboardsRead)
	ctx := context.Background()
	boardID, mediaID, assetID := uuid.New(), uuid.New(), uuid.New()
	fileID := "offline-image"
	data := []byte("verified-offline-image-bytes")
	digest := sha256.Sum256(data)
	hash := hex.EncodeToString(digest[:])
	objectKey := fixture.AccountID.String() + "/_private/whiteboards/" + boardID.String() + "/assets/" + hash + ".png"
	scene := `{"type":"excalidraw","elements":[{"id":"image","type":"image","fileId":"` + fileID + `","isDeleted":false}],"appState":{},"files":{}}`
	if _, err := pool.Exec(ctx, `INSERT INTO subscriptions(account_id,plan_code,status) VALUES($1,'free','active')
		ON CONFLICT(account_id) DO UPDATE SET status='active',current_period_end=NULL`, fixture.AccountID); err != nil {
		t.Fatalf("insert active subscription: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO whiteboards(id,account_id,name,scene_json,access_mode,created_by,updated_by)
		VALUES($1,$2,'Offline board',$3::jsonb,'account',$4,$4)`, boardID, fixture.AccountID, scene, fixture.UserID); err != nil {
		t.Fatalf("insert board: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status)
		VALUES($1,$2,$3,$4,'image','image/png','offline.png',$5,'active')`, mediaID, fixture.AccountID,
		domain.MediaAssetHashWhiteboardPrefix+hash, objectKey, len(data)); err != nil {
		t.Fatalf("insert media: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO whiteboard_assets(id,account_id,board_id,media_asset_id,file_id,kind,uploaded_by,committed_at)
		VALUES($1,$2,$3,$4,$5,'asset',$6,NOW())`, assetID, fixture.AccountID, boardID, mediaID, fileID, fixture.UserID); err != nil {
		t.Fatalf("insert asset link: %v", err)
	}
	var revision int64
	if err := pool.QueryRow(ctx, `SELECT selection_revision FROM offline_v3_grants WHERE id=$1`, fixture.GrantID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	_, _, err := fixture.Repository.ReplaceSelections(ctx, fixture.GrantID, fixture.UserID, revision, []domain.OfflineV3Selection{
		{Module: domain.OfflineModuleTasks, ResourceType: domain.OfflineResourceTaskList, ResourceID: fixture.ListID},
		{Module: domain.OfflineModuleWhiteboards, ResourceType: domain.OfflineResourceWhiteboard, ResourceID: boardID},
	}, nil)
	if err != nil {
		t.Fatalf("select whiteboard: %v", err)
	}
	var selectionID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM offline_v3_selections WHERE grant_id=$1 AND resource_id=$2`, fixture.GrantID, boardID).Scan(&selectionID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT selection_revision FROM offline_v3_grants WHERE id=$1`, fixture.GrantID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	loaderCalls := 0
	snapshots, err := fixture.Repository.FetchSnapshotsV3(ctx, fixture.GrantID, revision, []uuid.UUID{selectionID},
		func(_ context.Context, accountID uuid.UUID, key string, maxBytes int64) ([]byte, error) {
			loaderCalls++
			if accountID != fixture.AccountID || key != objectKey || maxBytes < int64(len(data)) {
				t.Fatalf("asset loader escaped boundary: account=%s key=%q limit=%d", accountID, key, maxBytes)
			}
			return append([]byte(nil), data...), nil
		})
	if err != nil || len(snapshots) != 1 || loaderCalls != 1 {
		t.Fatalf("fetch complete whiteboard snapshot: snapshots=%d calls=%d err=%v", len(snapshots), loaderCalls, err)
	}
	text := string(snapshots[0].Payload)
	if !strings.Contains(text, `"data_base64":"`+base64.StdEncoding.EncodeToString(data)+`"`) ||
		!strings.Contains(text, `"content_hash":"`+hash+`"`) || strings.Contains(text, objectKey) {
		t.Fatalf("whiteboard snapshot is incomplete or leaks storage key: %s", text)
	}
	if _, err := fixture.Repository.FetchSnapshotsV3(ctx, fixture.GrantID, revision, []uuid.UUID{selectionID},
		func(context.Context, uuid.UUID, string, int64) ([]byte, error) { return []byte("corrupt"), nil }); err == nil {
		t.Fatal("corrupt whiteboard bytes were accepted")
	}
}

func TestOfflineV3ConfirmSnapshotsRevalidatesResourceACLAfterSigningGap(t *testing.T) {
	pool := offlineV3TestPool(t)
	fixture := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()
	roleID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO roles(id,name,permissions) VALUES($1,$2,ARRAY['tasks'])`,
		roleID, "snapshot-confirm-acl-"+roleID.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE user_accounts SET role='agent',role_id=$3
		WHERE user_id=$1 AND account_id=$2`, fixture.UserID, fixture.AccountID, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE task_environments SET visibility='account',default_access_level='view'
		WHERE id=$1 AND account_id=$2`, fixture.EnvironmentID, fixture.AccountID); err != nil {
		t.Fatal(err)
	}
	// The fixture grant is explicitly reauthenticated after the membership
	// role mutation. The later resource ACL change intentionally does not
	// mutate an offline authority epoch, exercising the post-signing ACL gate.
	if _, err := pool.Exec(ctx, `UPDATE offline_v3_grants grant_item SET
		last_authenticated_credential_epoch=account_user.offline_credential_epoch,
		last_authenticated_authority_epoch=account_user.offline_authority_epoch+epoch.authority_epoch
		FROM users account_user,offline_v3_membership_epochs epoch
		WHERE grant_item.id=$1 AND account_user.id=$2 AND epoch.user_id=$2 AND epoch.account_id=$3`,
		fixture.GrantID, fixture.UserID, fixture.AccountID); err != nil {
		t.Fatal(err)
	}
	record, err := fixture.Repository.GrantForUser(ctx, fixture.GrantID, fixture.UserID)
	if err != nil {
		t.Fatal(err)
	}
	snapshots, err := fixture.Repository.FetchSnapshotsV3(ctx, fixture.GrantID, record.SelectionRevision,
		[]uuid.UUID{fixture.SelectionID}, nil)
	if err != nil || len(snapshots) != 1 {
		t.Fatalf("fetch pre-revocation snapshot: snapshots=%d err=%v", len(snapshots), err)
	}
	if _, err := pool.Exec(ctx, `UPDATE task_environments SET default_access_level='none'
		WHERE id=$1 AND account_id=$2`, fixture.EnvironmentID, fixture.AccountID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.Repository.ConfirmSnapshotsIssued(ctx, record, snapshots); !errors.Is(err, ErrOfflineV3AccessDenied) {
		t.Fatalf("post-signing ACL revocation was not enforced: %v", err)
	}
}

func TestOfflineV3StoredControlRejectsCrossAccountGrantBinding(t *testing.T) {
	pool := offlineV3TestPool(t)
	fixture := seedOfflineV3Fixture(t, pool)
	foreign := fixture.ForeignAccountID
	grant := fixture.GrantID
	_, err := fixture.Repository.StoreControl(context.Background(), domain.OfflineV3Control{
		ID: uuid.New(), InstallationID: fixture.InstallationID, GrantID: &grant, AccountID: &foreign, Scope: "grant",
		ScopeID: fixture.GrantID, Revision: 1, Action: "wipe", Reason: "admin_revoked", Token: "signed-token", KeyID: "key", KeyVersion: 3,
	}, nil)
	if err == nil {
		t.Fatal("cross-account control bypassed grant binding")
	}
}

func offlineV3TestAdminControl(plan OfflineV3AdminControlPlan, action string) domain.OfflineV3Control {
	reason := "security_lock"
	if action == "wipe" {
		reason = "admin_revoked"
	}
	return domain.OfflineV3Control{ID: uuid.New(), InstallationID: plan.InstallationID, GrantID: plan.GrantID,
		AccountID: plan.AccountID, Scope: plan.Scope, ScopeID: plan.ScopeID, Revision: plan.CurrentRevision + 1,
		Action: action, Reason: reason, Token: "test-signed-control-" + uuid.NewString(), KeyID: "offline-v3-test", KeyVersion: 3}
}

func TestOfflineV3AdminGrantRevokePreservesControlsOnlyTransportAndIdempotentAck(t *testing.T) {
	pool := offlineV3TestPool(t)
	fixture := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()
	plan, err := fixture.Repository.PlanAdminControl(ctx, "grant", fixture.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	control := offlineV3TestAdminControl(*plan, "wipe")
	if err := fixture.Repository.ApplyAdminControl(ctx, *plan, control, fixture.UserID); err != nil {
		t.Fatalf("apply exact grant revoke: %v", err)
	}
	record, err := fixture.Repository.AuthenticateTransport(ctx, fixture.GrantID, fixture.TransportCapability)
	if err != nil || record.State != "revoked" {
		t.Fatalf("revoked grant lost controls-only transport or state: state=%q err=%v", record.State, err)
	}
	pending, err := fixture.Repository.PendingControls(ctx, record)
	if err != nil || len(pending) != 1 || pending[0].ID != control.ID {
		t.Fatalf("signed revoke control not deliverable: controls=%v err=%v", pending, err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := fixture.Repository.AcknowledgeControls(ctx, record, []uuid.UUID{control.ID}); err != nil {
			t.Fatalf("idempotent control acknowledgement attempt %d: %v", attempt+1, err)
		}
	}
	var transportState string
	if err := pool.QueryRow(ctx, `SELECT state FROM offline_v3_transport_credentials WHERE grant_id=$1`, fixture.GrantID).Scan(&transportState); err != nil || transportState != "active" {
		t.Fatalf("revocation disabled the only signed-control delivery path: state=%q err=%v", transportState, err)
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := fixture.Repository.LockActiveGrantTx(ctx, tx, fixture.GrantID, domain.OfflineV3ActionTasksRead); !errors.Is(err, ErrOfflineV3AccessDenied) {
		t.Fatalf("revoked grant retained data authority: %v", err)
	}
}

func TestOfflineV3AggregateControlIsAccountScopedAndAtomicallyRejectsStalePlan(t *testing.T) {
	pool := offlineV3TestPool(t)
	first := seedOfflineV3Fixture(t, pool)
	second := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()
	plans, err := first.Repository.PlanAdminGrantControls(ctx, "account", first.AccountID, uuid.Nil)
	if err != nil || len(plans) != 1 || plans[0].ScopeID != first.GrantID {
		t.Fatalf("account aggregate escaped tenant: plans=%v err=%v", plans, err)
	}
	control := offlineV3TestAdminControl(plans[0], "wipe")
	if err := first.Repository.ApplyAdminGrantControls(ctx, plans, []domain.OfflineV3Control{control}, first.UserID); err != nil {
		t.Fatalf("apply account-scoped revoke: %v", err)
	}
	var firstState, secondState string
	if err := pool.QueryRow(ctx, `SELECT state FROM offline_v3_grants WHERE id=$1`, first.GrantID).Scan(&firstState); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM offline_v3_grants WHERE id=$1`, second.GrantID).Scan(&secondState); err != nil {
		t.Fatal(err)
	}
	if firstState != "revoked" || secondState != "active" {
		t.Fatalf("account aggregate crossed boundary: first=%s second=%s", firstState, secondState)
	}

	third := seedOfflineV3Fixture(t, pool)
	fourth := seedOfflineV3Fixture(t, pool)
	thirdPlan, err := third.Repository.PlanAdminControl(ctx, "grant", third.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	fourthPlan, err := fourth.Repository.PlanAdminControl(ctx, "grant", fourth.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	batchPlans := []OfflineV3AdminControlPlan{*thirdPlan, *fourthPlan}
	batchControls := []domain.OfflineV3Control{offlineV3TestAdminControl(*thirdPlan, "wipe"), offlineV3TestAdminControl(*fourthPlan, "wipe")}
	if _, err := pool.Exec(ctx, `UPDATE offline_v3_grants SET revision=revision+1 WHERE id=$1`, fourth.GrantID); err != nil {
		t.Fatal(err)
	}
	if err := third.Repository.ApplyAdminGrantControls(ctx, batchPlans, batchControls, third.UserID); !errors.Is(err, ErrOfflineV3Conflict) {
		t.Fatalf("stale aggregate plan did not fail closed: %v", err)
	}
	var thirdState string
	if err := pool.QueryRow(ctx, `SELECT state FROM offline_v3_grants WHERE id=$1`, third.GrantID).Scan(&thirdState); err != nil || thirdState != "active" {
		t.Fatalf("stale batch partially revoked an earlier grant: state=%s err=%v", thirdState, err)
	}
	var controls int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM offline_v3_controls WHERE id=ANY($1::uuid[])`,
		[]uuid.UUID{batchControls[0].ID, batchControls[1].ID}).Scan(&controls); err != nil || controls != 0 {
		t.Fatalf("stale batch partially persisted controls: count=%d err=%v", controls, err)
	}
}

func TestOfflineV3TaskSnapshotCapabilitiesFollowGrantAndCanonicalWorkACL(t *testing.T) {
	pool := offlineV3TestPool(t)
	fixture := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()
	operation := offlineV3FixtureOperation(fixture)
	created, err := applyOfflineV3TestOperation(ctx, pool, fixture, operation, stringsOf("a", 64), true)
	if err != nil || created.Status != "applied" {
		t.Fatalf("create capability fixture: result=%+v err=%v", created, err)
	}
	roleID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO roles(id,name,permissions) VALUES($1,$2,ARRAY['tasks'])`, roleID, "snapshot-acl-"+roleID.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE user_accounts SET role='agent',role_id=$3 WHERE user_id=$1 AND account_id=$2`, fixture.UserID, fixture.AccountID, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE task_environments SET default_access_level='view' WHERE id=$1 AND account_id=$2`, fixture.EnvironmentID, fixture.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'edit',$3)`, fixture.AccountID, fixture.ListID, fixture.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_access_grants(account_id,task_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'view',$3)`, fixture.AccountID, operation.ResourceID, fixture.UserID); err != nil {
		t.Fatal(err)
	}
	// Fixture-only fresh authorization after the membership role mutation.
	if _, err := pool.Exec(ctx, `UPDATE offline_v3_grants grant_item SET
		last_authenticated_credential_epoch=account_user.offline_credential_epoch,
		last_authenticated_authority_epoch=account_user.offline_authority_epoch+epoch.authority_epoch
		FROM users account_user,offline_v3_membership_epochs epoch
		WHERE grant_item.id=$1 AND account_user.id=$2 AND epoch.user_id=$2 AND epoch.account_id=$3`,
		fixture.GrantID, fixture.UserID, fixture.AccountID); err != nil {
		t.Fatal(err)
	}
	readCapabilities := func() (bool, bool) {
		t.Helper()
		var revision int64
		if err := pool.QueryRow(ctx, `SELECT selection_revision FROM offline_v3_grants WHERE id=$1`, fixture.GrantID).Scan(&revision); err != nil {
			t.Fatal(err)
		}
		snapshots, err := fixture.Repository.FetchSnapshotsV3(ctx, fixture.GrantID, revision, []uuid.UUID{fixture.SelectionID}, nil)
		if err != nil || len(snapshots) != 1 {
			t.Fatalf("task capability snapshot: snapshots=%d err=%v", len(snapshots), err)
		}
		var payload struct {
			List struct {
				CanCreate bool `json:"can_create"`
			} `json:"list"`
			Tasks []struct {
				ID          uuid.UUID `json:"id"`
				CanComplete bool      `json:"can_complete"`
			} `json:"tasks"`
		}
		if err := json.Unmarshal(snapshots[0].Payload, &payload); err != nil {
			t.Fatal(err)
		}
		for _, task := range payload.Tasks {
			if task.ID == operation.ResourceID {
				return payload.List.CanCreate, task.CanComplete
			}
		}
		t.Fatal("created task missing from snapshot")
		return false, false
	}
	canCreate, canComplete := readCapabilities()
	if !canCreate || canComplete {
		t.Fatalf("list Editar/root Ver capabilities wrong: create=%v complete=%v", canCreate, canComplete)
	}
	if _, err := pool.Exec(ctx, `UPDATE task_list_access_grants SET access_level='view' WHERE account_id=$1 AND list_id=$2 AND user_id=$3`,
		fixture.AccountID, fixture.ListID, fixture.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE task_access_grants SET access_level='edit' WHERE account_id=$1 AND task_id=$2 AND user_id=$3`,
		fixture.AccountID, operation.ResourceID, fixture.UserID); err != nil {
		t.Fatal(err)
	}
	canCreate, canComplete = readCapabilities()
	if canCreate || !canComplete {
		t.Fatalf("list Ver/root Editar capabilities wrong: create=%v complete=%v", canCreate, canComplete)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET status='completed',status_id=$3,completed_at=NOW(),version=version+1
		WHERE id=$1 AND account_id=$2`, operation.ResourceID, fixture.AccountID, fixture.DoneStatusID); err != nil {
		t.Fatal(err)
	}
	canCreate, canComplete = readCapabilities()
	if canCreate || canComplete {
		t.Fatalf("closed task exposed a write capability: create=%v complete=%v", canCreate, canComplete)
	}
}

func TestOfflineV3PasswordAndMembershipEpochsInvalidateAuthorityButKeepControlTransport(t *testing.T) {
	pool := offlineV3TestPool(t)
	ctx := context.Background()
	for _, mutation := range []struct {
		name string
		run  func(offlineV3Fixture) error
	}{
		{name: "password", run: func(fixture offlineV3Fixture) error {
			_, err := pool.Exec(ctx, `UPDATE users SET password_hash=$2 WHERE id=$1`, fixture.UserID, "changed-"+uuid.NewString())
			return err
		}},
		{name: "username", run: func(fixture offlineV3Fixture) error {
			_, err := pool.Exec(ctx, `UPDATE users SET username=$2 WHERE id=$1`, fixture.UserID, "renamed-"+uuid.NewString())
			return err
		}},
		{name: "membership", run: func(fixture offlineV3Fixture) error {
			_, err := pool.Exec(ctx, `DELETE FROM user_accounts WHERE user_id=$1 AND account_id=$2`, fixture.UserID, fixture.AccountID)
			return err
		}},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			fixture := seedOfflineV3Fixture(t, pool)
			before, err := fixture.Repository.AuthRecord(ctx, fixture.GrantID)
			if err != nil {
				t.Fatal(err)
			}
			if err := mutation.run(fixture); err != nil {
				t.Fatal(err)
			}
			after, err := fixture.Repository.AuthenticateTransport(ctx, fixture.GrantID, fixture.TransportCapability)
			if err != nil {
				t.Fatalf("epoch change disabled control delivery: %v", err)
			}
			if after.CredentialEpoch == before.CredentialEpoch && after.AuthorityEpoch == before.AuthorityEpoch && after.MembershipActive == before.MembershipActive {
				t.Fatal("security mutation changed no durable authority input")
			}
			if err := fixture.Repository.MarkGrantAuthenticated(ctx, fixture.GrantID, fixture.UserID, true); !errors.Is(err, ErrOfflineV3AccessDenied) {
				t.Fatalf("ordinary online session silently blessed stale local secrets: %v", err)
			}
			if _, _, _, err := fixture.Repository.ListSelections(ctx, fixture.GrantID, fixture.UserID); !errors.Is(err, ErrOfflineV3AccessDenied) {
				t.Fatalf("stale grant retained selection metadata authority: %v", err)
			}
			if _, _, err := fixture.Repository.ReplaceSelections(ctx, fixture.GrantID, fixture.UserID, before.SelectionRevision,
				[]domain.OfflineV3Selection{{Module: domain.OfflineModuleTasks, ResourceType: domain.OfflineResourceTaskList, ResourceID: fixture.ListID}}, nil); !errors.Is(err, ErrOfflineV3AccessDenied) {
				t.Fatalf("stale grant retained selection mutation authority: %v", err)
			}
			tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err := fixture.Repository.LockActiveGrantTx(ctx, tx, fixture.GrantID, domain.OfflineV3ActionTasksRead); !errors.Is(err, ErrOfflineV3AccessDenied) {
				t.Fatalf("stale grant retained snapshot/write authority: %v", err)
			}
		})
	}
}
