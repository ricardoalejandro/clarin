package repository

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestOfflineV5IntegrationApprovalAdoptsLegacyGrantIdempotently(t *testing.T) {
	pool := offlineV5IntegrationPool(t)
	ctx := context.Background()
	v4 := &OfflineV4Repository{db: pool}
	v5 := &OfflineV5Repository{db: pool}
	accountID, userID, superadminID, profileID, contactID, boardID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()

	if _, err := pool.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'V5 adoption account')`, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO subscriptions(account_id,plan_code,status) VALUES($1,'free','active')`, accountID); err != nil {
		t.Fatal(err)
	}
	for _, actor := range []struct {
		id    uuid.UUID
		super bool
	}{{userID, false}, {superadminID, true}} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,is_active,is_super_admin)
			VALUES($1,$2,$3,$4,'test-only-hash',TRUE,$5)`, actor.id, accountID, "v5-adoption-"+actor.id.String(), actor.id.String()+"@test.invalid", actor.super); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES($1,$2,'admin',TRUE)`, actor.id, accountID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO contacts(id,account_id,jid,phone,name)
		VALUES($1,$2,'51900000010@s.whatsapp.net','51900000010','V5 adoption contact')`, contactID, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO whiteboards(id,account_id,name,access_mode,scene_json)
		VALUES($1,$2,'V5 adoption board','account','{"elements":[],"appState":{}}')`, boardID, accountID); err != nil {
		t.Fatal(err)
	}

	key := json.RawMessage(`{"kty":"EC","crv":"P-256","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","alg":"ES256","use":"sig","kid":"v5-adoption"}`)
	legacyChallenge, err := v4.CreateChallenge(ctx, userID, uuid.Nil, "enrollment")
	if err != nil {
		t.Fatal(err)
	}
	legacyRequestID, err := v4.RequestEnrollment(ctx, OfflineV4EnrollmentInput{BrowserProfileID: profileID, UserID: userID,
		BrowserName: "Adoption browser", DisplayName: "Adoption profile", SigningJWK: key, KeyThumbprint: profileID.String()},
		legacyChallenge.ID, legacyChallenge.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := v4.Approve(ctx, legacyRequestID, superadminID, []OfflineV3GrantApproval{{AccountID: accountID,
		Actions: []string{domain.OfflineV3ActionContactsRead, domain.OfflineV3ActionWhiteboardsRead}, MaxResources: 20, QuotaBytes: 32 << 20}})
	if err != nil || len(legacy) != 1 {
		t.Fatalf("create legacy grant: count=%d err=%v", len(legacy), err)
	}
	legacyGrantID := legacy[0].GrantID
	if err := v4.ReplaceSelections(ctx, legacyGrantID, userID, legacy[0].SelectionRevision, []domain.OfflineV3Selection{
		{Module: domain.OfflineModuleContacts, ResourceType: domain.OfflineResourceContact, ResourceID: contactID},
		{Module: domain.OfflineModuleWhiteboards, ResourceType: domain.OfflineResourceWhiteboard, ResourceID: boardID},
	}); err != nil {
		t.Fatal(err)
	}
	beforeSelections, beforeRecord, err := v4.Selections(ctx, legacyGrantID, userID)
	if err != nil || len(beforeSelections) != 2 {
		t.Fatalf("load legacy selection: count=%d err=%v", len(beforeSelections), err)
	}

	v5Challenge, err := v5.CreateChallenge(ctx, userID, uuid.Nil, "enrollment")
	if err != nil {
		t.Fatal(err)
	}
	v5RequestID, err := v5.RequestEnrollment(ctx, OfflineV4EnrollmentInput{BrowserProfileID: profileID, UserID: userID,
		BrowserName: "Adoption browser", DisplayName: "Adoption profile", SigningJWK: key, KeyThumbprint: profileID.String()},
		v5Challenge.ID, v5Challenge.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	approval := []OfflineV5GrantApproval{{AccountID: accountID,
		Modules: []string{domain.OfflineModuleContacts, domain.OfflineModuleWhiteboards}, MaxResources: 20, QuotaBytes: 32 << 20}}
	grants, err := v5.Approve(ctx, v5RequestID, superadminID, approval)
	if err != nil || len(grants) != 1 {
		t.Fatalf("adopt legacy grant: count=%d err=%v", len(grants), err)
	}
	if grants[0].GrantID != legacyGrantID {
		t.Fatalf("legacy grant identity changed: before=%s after=%s", legacyGrantID, grants[0].GrantID)
	}
	afterSelections, afterRecord, err := v4.Selections(ctx, legacyGrantID, userID)
	if err != nil || len(afterSelections) != 2 {
		t.Fatalf("load adopted selection: count=%d err=%v", len(afterSelections), err)
	}
	if afterSelections[0].ID != beforeSelections[0].ID || afterSelections[1].ID != beforeSelections[1].ID ||
		afterRecord.SelectionRevision != beforeRecord.SelectionRevision || afterRecord.SelectionDigest != beforeRecord.SelectionDigest {
		t.Fatalf("adoption changed authorized selections: before=%+v/%d/%s after=%+v/%d/%s",
			beforeSelections, beforeRecord.SelectionRevision, beforeRecord.SelectionDigest,
			afterSelections, afterRecord.SelectionRevision, afterRecord.SelectionDigest)
	}

	var activeGrants, policies, selections int
	var requestState string
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM offline_v4_grants WHERE browser_profile_id=$1 AND user_id=$2 AND account_id=$3 AND state='active'),
		(SELECT count(*) FROM offline_v5_grant_policies WHERE grant_id=$4 AND account_id=$3),
		(SELECT count(*) FROM offline_v4_selections WHERE grant_id=$4 AND account_id=$3),
		(SELECT state FROM offline_v4_enrollment_requests WHERE id=$5)`,
		profileID, userID, accountID, legacyGrantID, v5RequestID).Scan(&activeGrants, &policies, &selections, &requestState); err != nil {
		t.Fatal(err)
	}
	if activeGrants != 1 || policies != 1 || selections != 2 || requestState != "approved" {
		t.Fatalf("unexpected adopted state: active=%d policies=%d selections=%d request=%s", activeGrants, policies, selections, requestState)
	}

	retried, err := v5.Approve(ctx, v5RequestID, superadminID, approval)
	if err != nil || len(retried) != 1 || retried[0].GrantID != legacyGrantID {
		t.Fatalf("idempotent approval retry failed: grants=%+v err=%v", retried, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM offline_v4_grants
		WHERE browser_profile_id=$1 AND user_id=$2 AND account_id=$3 AND state='active'`, profileID, userID, accountID).Scan(&activeGrants); err != nil {
		t.Fatal(err)
	}
	if activeGrants != 1 {
		t.Fatalf("idempotent retry duplicated the active grant: %d", activeGrants)
	}

	narrowChallenge, err := v5.CreateChallenge(ctx, userID, uuid.Nil, "enrollment")
	if err != nil {
		t.Fatal(err)
	}
	narrowRequestID, err := v5.RequestEnrollment(ctx, OfflineV4EnrollmentInput{BrowserProfileID: profileID, UserID: userID,
		BrowserName: "Adoption browser", DisplayName: "Adoption profile", SigningJWK: key, KeyThumbprint: profileID.String()},
		narrowChallenge.ID, narrowChallenge.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	narrowed, err := v5.Approve(ctx, narrowRequestID, superadminID, []OfflineV5GrantApproval{{AccountID: accountID,
		Modules: []string{domain.OfflineModuleContacts}, MaxResources: 20, QuotaBytes: 32 << 20}})
	if err != nil || len(narrowed) != 1 || narrowed[0].GrantID != legacyGrantID {
		t.Fatalf("narrow adopted grant: grants=%+v err=%v", narrowed, err)
	}
	narrowSelections, narrowRecord, err := v4.Selections(ctx, legacyGrantID, userID)
	if err != nil || len(narrowSelections) != 1 || narrowSelections[0].ResourceID != contactID {
		t.Fatalf("narrowed selection kept an unauthorized module: selections=%+v err=%v", narrowSelections, err)
	}
	if narrowRecord.SelectionRevision != beforeRecord.SelectionRevision+1 || narrowRecord.SelectionDigest != offlineV4SelectionDigest(narrowSelections) {
		t.Fatalf("narrowed selection did not advance canonical revision/digest: revision=%d digest=%s", narrowRecord.SelectionRevision, narrowRecord.SelectionDigest)
	}
}
