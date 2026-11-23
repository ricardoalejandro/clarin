package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
	"sync"
	"testing"
	"time"
)

func TestIdentityRecoveryPostgresSessionRevisionsAndQueue(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, db)
	repos := NewRepositories(db)
	repo := repos.Chat
	for pass := 0; pass < 2; pass++ {
		for _, migration := range database.IdentityRecoveryMigrations() {
			if _, err := db.Exec(ctx, migration); err != nil {
				t.Fatal("idempotent recovery migration", err)
			}
		}
	}
	device := uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic identity recovery','connected')`, device, f.account)
	pn, lid := "51900000456@s.whatsapp.net", "700123@lid"
	at := time.Now().UTC().Add(-time.Minute)
	legacy := domain.WhatsAppPeerObservation{JID: lid, PN: pn, Source: "message", ObservedAt: &at, Fields: map[string]string{"push_name": "Synthetic original"}}
	if _, err := repo.ObserveWhatsAppPeers(ctx, f.account, device, []domain.WhatsAppPeerObservation{legacy}); err != nil {
		t.Fatal(err)
	}
	gen, err := repo.EnsureWhatsAppIdentitySession(ctx, f.account, device, "synthetic-session-a")
	if err != nil || gen != 1 {
		t.Fatal("baseline session", gen, err)
	}
	snapshot, err := repo.WhatsAppPeerIdentities(ctx, f.account, device, []string{pn})
	if err != nil || snapshot.LIDForPN[pn] != lid {
		t.Fatal("baseline did not adopt scoped facts", snapshot, err)
	}
	revision, err := repo.WhatsAppIdentityRevision(ctx, f.account, device)
	if err != nil {
		t.Fatal(err)
	}
	newer := at.Add(time.Second)
	same := legacy
	same.ObservedAt = &newer
	if _, err = repo.ObserveWhatsAppPeersForSession(ctx, f.account, device, "synthetic-session-a", []domain.WhatsAppPeerObservation{same}); err != nil {
		t.Fatal(err)
	}
	unchanged, err := repo.WhatsAppIdentityRevision(ctx, f.account, device)
	if err != nil || unchanged != revision {
		t.Fatal("metadata refresh invalidated identity", revision, unchanged, err)
	}
	for _, observation := range []domain.WhatsAppPeerObservation{{JID: pn, Source: "provider_cache", Fields: map[string]string{"full_name": "Synthetic agenda"}}, {JID: pn, Source: "history_contact", Fields: map[string]string{"full_name": "Different undated"}}} {
		if _, err = repo.ObserveWhatsAppPeersForSession(ctx, f.account, device, "synthetic-session-a", []domain.WhatsAppPeerObservation{observation}); err != nil {
			t.Fatal(err)
		}
	}
	snapshot, err = repo.WhatsAppPeerIdentities(ctx, f.account, device, []string{pn})
	if err != nil || snapshot.Fields[pn]["full_name"].Value != "Synthetic agenda" {
		t.Fatal("undated source overwrote known name", err)
	}
	id, err := repo.EnqueueWhatsAppIdentityRecovery(ctx, f.account, device, "synthetic-session-a", "connected", []string{pn, pn, "51900000789@s.whatsapp.net", lid, "handle@example"})
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := repo.EnqueueWhatsAppIdentityRecovery(ctx, f.account, device, "synthetic-session-a", "connected", []string{pn})
	if err != nil || duplicate != id {
		t.Fatal("queue replay duplicated run", err)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	claims := []*domain.WhatsAppIdentityRecoveryRun{}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			run, e := repo.ClaimIdentityRecoveryRun(ctx)
			if errors.Is(e, pgx.ErrNoRows) {
				return
			}
			if e != nil {
				t.Error(e)
				return
			}
			mu.Lock()
			claims = append(claims, run)
			mu.Unlock()
		}()
	}
	wg.Wait()
	if len(claims) != 1 || claims[0].ID != id || claims[0].Phase != "inventory" {
		t.Fatal("device claimed repeatedly or wrong phase", claims)
	}
	run := claims[0]
	firstDelay, err := repo.ReserveIdentityRecoveryLookup(ctx, run)
	if err != nil || firstDelay > time.Second {
		t.Fatal("first paced slot", firstDelay, err)
	}
	secondDelay, err := repo.ReserveIdentityRecoveryLookup(ctx, run)
	if err != nil || secondDelay < 1500*time.Millisecond {
		t.Fatal("device pacing reset", secondDelay, err)
	}
	batch, err := repo.PendingIdentityRecoveryBatch(ctx, run)
	if err != nil || len(batch) != 2 {
		t.Fatal("candidate validation/dedup failed", batch, err)
	}
	if err = repo.CompleteIdentityRecoveryBatch(ctx, run, batch, true); err != nil {
		t.Fatal(err)
	}
	if err = repo.CheckpointIdentityRecovery(ctx, run, "projection", true); err != nil {
		t.Fatal(err)
	}
	if err = repo.SetIdentityRecoveryUnresolved(ctx, run, 3); err != nil {
		t.Fatal(err)
	}
	if err = repo.FinishIdentityRecoveryCycle(ctx, run, "partial", "done", "", 0); err != nil {
		t.Fatal(err)
	}
	status, err := repo.IdentityRecoveryStatus(ctx, f.account, device)
	if err != nil || status == nil || status.Processed != 2 || status.Resolved != 1 || status.Pending != 0 || status.UnresolvedMembers != 3 || status.State != "partial" {
		t.Fatal("recovery status counts", status, err)
	}
	if _, err = repo.EnqueueWhatsAppIdentityRecovery(ctx, f.account, device, "synthetic-session-a", "sync", nil); err != nil {
		t.Fatal(err)
	}
	resumed, err := repo.ClaimIdentityRecoveryRun(ctx)
	if err != nil || !resumed.AppStateAcknowledged || resumed.Phase != "inventory" {
		t.Fatal("manual retry lost durable fullsync ACK", resumed, err)
	}
	// A new pairing retires provider projections and prevents both late writes
	// and already-claimed workers from reviving the previous session.
	gen, err = repo.EnsureWhatsAppIdentitySession(ctx, f.account, device, "synthetic-session-b")
	if err != nil || gen != 2 {
		t.Fatal("replacement session", gen, err)
	}
	if _, err = repo.ObserveWhatsAppPeersForSession(ctx, f.account, device, "synthetic-session-a", []domain.WhatsAppPeerObservation{legacy}); !errors.Is(err, ErrWhatsAppIdentitySessionChanged) {
		t.Fatal("late observation revived old session", err)
	}
	if _, err = repo.EnqueueWhatsAppIdentityRecovery(ctx, f.account, device, "synthetic-session-a", "sync", nil); !errors.Is(err, ErrWhatsAppIdentitySessionChanged) {
		t.Fatal("late enqueue replaced current session", err)
	}
	if err = repo.RenewIdentityRecoveryLease(ctx, resumed); !errors.Is(err, ErrWhatsAppIdentitySessionChanged) {
		t.Fatal("old worker retained lease", err)
	}
	snapshot, err = repo.WhatsAppPeerIdentities(ctx, f.account, device, []string{pn, lid})
	if err != nil || len(snapshot.Fields) != 0 || len(snapshot.LIDForPN) != 0 {
		t.Fatal("previous pairing leaked facts", snapshot, err)
	}
	status, err = repo.IdentityRecoveryStatus(ctx, f.account, device)
	if err != nil || status != nil {
		t.Fatal("old status became current", status, err)
	}
	if _, err = repo.EnsureWhatsAppIdentitySession(ctx, uuid.New(), device, "foreign-session"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("foreign device session accepted", err)
	}
}

func TestIdentityRecoveryPostgresGroupMaterialCASAndCRM(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, db)
	repos := NewRepositories(db)
	repo := repos.Chat
	device := uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic group revision','connected')`, device, f.account)
	chat, err := repo.GetOrCreateGroup(ctx, f.account, device, "120099900000001@g.us", "Synthetic group revision")
	if err != nil {
		t.Fatal(err)
	}
	group := &domain.ChatGroup{Subject: "Synthetic group revision", Kind: "group", MembershipStatus: "member"}
	members := []domain.GroupParticipant{{JID: "51900000456@s.whatsapp.net", LID: "700123@lid", Phone: "51900000456", Name: "Original", Role: "member"}}
	if err = repo.SaveGroup(ctx, f.account, chat.ID, group, members); err != nil {
		t.Fatal(err)
	}
	revision, err := repo.GroupRevision(ctx, f.account, chat.ID)
	if err != nil || revision < 1 {
		t.Fatal("group revision missing", revision, err)
	}
	material := domain.WhatsAppGroupIdentityVersionMaterial(group, members)
	same, err := repo.RecordWhatsAppGroupSnapshotVersionCAS(ctx, f.account, device, chat.JID, material, revision)
	if err != nil || same != revision {
		t.Fatal("SQL/domain material differ", same, revision, err)
	}
	members[0].Name = "Renamed"
	members[0].NameSource = "full_name"
	if err = repo.SaveGroup(ctx, f.account, chat.ID, group, members); err != nil {
		t.Fatal(err)
	}
	same, err = repo.GroupRevision(ctx, f.account, chat.ID)
	if err != nil || same != revision {
		t.Fatal("name metadata changed membership version", same, revision, err)
	}
	members[0].Role = "admin"
	if err = repo.SaveGroup(ctx, f.account, chat.ID, group, members); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.RecordWhatsAppGroupSnapshotVersionCAS(ctx, f.account, device, chat.JID, material, revision); !errors.Is(err, ErrWhatsAppGroupSnapshotChanged) {
		t.Fatal("old remote snapshot overwrote fresh event", err)
	}
	after, err := repo.GroupRevisionByJID(ctx, f.account, device, chat.JID)
	if err != nil || after <= revision {
		t.Fatal("material role change not versioned", after, err)
	}
	if _, _, err = repo.SnapshotVersionByGroupJID(ctx, uuid.New(), device, chat.JID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("foreign snapshot revision readable", err)
	}
	crm, err := repo.CRMIdentityRevision(ctx, f.account)
	if err != nil {
		t.Fatal(err)
	}
	integrityExec(t, db, `UPDATE contacts SET custom_name='Synthetic renamed contact' WHERE account_id=$1 AND id=$2`, f.account, f.contact)
	changed, err := repo.CRMIdentityRevision(ctx, f.account)
	if err != nil || changed <= crm {
		t.Fatal("CRM identity change not versioned", changed, crm, err)
	}
	integrityExec(t, db, `UPDATE contacts SET updated_at=NOW() WHERE account_id=$1 AND id=$2`, f.account, f.contact)
	stable, err := repo.CRMIdentityRevision(ctx, f.account)
	if err != nil || stable != changed {
		t.Fatal("nonmaterial touch changed CRM version", stable, changed, err)
	}
	pipeline, stage := uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO pipelines(id,account_id,name) VALUES($1,$2,'Synthetic recovery pipeline')`, pipeline, f.account)
	integrityExec(t, db, `INSERT INTO pipeline_stages(id,pipeline_id,name) VALUES($1,$2,'Synthetic recovery stage')`, stage, pipeline)
	beforeStage, err := repo.CRMIdentityRevision(ctx, f.account)
	if err != nil {
		t.Fatal(err)
	}
	integrityExec(t, db, `UPDATE pipeline_stages SET name='Synthetic renamed stage' WHERE id=$1`, stage)
	afterStage, err := repo.CRMIdentityRevision(ctx, f.account)
	if err != nil || afterStage <= beforeStage {
		t.Fatal("stage account was not resolved through pipeline", beforeStage, afterStage, err)
	}
	beforeDelete, err := repo.GroupRevision(ctx, f.account, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	integrityExec(t, db, `DELETE FROM chats WHERE account_id=$1 AND id=$2`, f.account, chat.ID)
	afterDelete, err := repo.GroupRevisionByJID(ctx, f.account, device, chat.JID)
	if err != nil || afterDelete <= beforeDelete {
		t.Fatal("chat cascade did not tombstone group version", beforeDelete, afterDelete, err)
	}
}

func TestIdentityRecoveryPostgresPairedOfflineWaitsAndResumes(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, db)
	repo := NewRepositories(db).Chat
	device := uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic offline recovery','disconnected')`, device, f.account)
	if _, err := repo.EnsureWhatsAppIdentitySession(ctx, f.account, device, "synthetic-paired-session"); err != nil {
		t.Fatal(err)
	}
	id, err := repo.EnqueueWhatsAppIdentityRecovery(ctx, f.account, device, "synthetic-paired-session", "paired", nil)
	if err != nil {
		t.Fatal(err)
	}
	status, err := repo.IdentityRecoveryStatus(ctx, f.account, device)
	if err != nil || status == nil || status.State != "waiting_connection" || status.Phase != "inventory" || status.Pending != 0 {
		t.Fatal("offline paired device has no durable waiting state", status, err)
	}
	if run, claimErr := repo.ClaimIdentityRecoveryRun(ctx); !errors.Is(claimErr, pgx.ErrNoRows) || run != nil {
		t.Fatal("offline run was claimed", run, claimErr)
	}
	integrityExec(t, db, `UPDATE devices SET status='connected' WHERE account_id=$1 AND id=$2`, f.account, device)
	resumedID, err := repo.EnqueueWhatsAppIdentityRecovery(ctx, f.account, device, "synthetic-paired-session", "connected", nil)
	if err != nil || resumedID != id {
		t.Fatal("connection created a duplicate run", resumedID, id, err)
	}
	run, err := repo.ClaimIdentityRecoveryRun(ctx)
	if err != nil || run == nil || run.ID != id {
		t.Fatal("connected run could not resume", run, err)
	}
	if err = repo.CheckpointIdentityRecovery(ctx, run, "projection", true); err != nil {
		t.Fatal(err)
	}
	if replayID, replayErr := repo.EnqueueWhatsAppIdentityRecovery(ctx, f.account, device, "synthetic-paired-session", "paired", nil); replayErr != nil || replayID != id {
		t.Fatal("paired replay duplicated active run", replayID, replayErr)
	}
	if err = repo.RenewIdentityRecoveryLease(ctx, run); err != nil {
		t.Fatal("paired replay removed active lease", err)
	}
	status, err = repo.IdentityRecoveryStatus(ctx, f.account, device)
	if err != nil || status == nil || status.State != "recovering" || status.Phase != "projection" {
		t.Fatal("paired replay reset active progress", status, err)
	}
	if err = repo.FinishIdentityRecoveryCycle(ctx, run, "partial", "done", "provider_unavailable", 0); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.EnqueueWhatsAppIdentityRecovery(ctx, f.account, device, "synthetic-paired-session", "paired", nil); err != nil {
		t.Fatal(err)
	}
	status, err = repo.IdentityRecoveryStatus(ctx, f.account, device)
	if err != nil || status == nil || status.State != "partial" || status.Phase != "done" || status.LastErrorCode != "provider_unavailable" {
		t.Fatal("paired replay reset partial outcome", status, err)
	}
	if _, err = repo.EnqueueWhatsAppIdentityRecovery(ctx, f.account, device, "synthetic-paired-session", "sync", nil); err != nil {
		t.Fatal(err)
	}
	run, err = repo.ClaimIdentityRecoveryRun(ctx)
	if err != nil || run == nil || run.ID != id || !run.AppStateAcknowledged {
		t.Fatal("explicit retry lost run or ACK", run, err)
	}
	if err = repo.FinishIdentityRecoveryCycle(ctx, run, "completed", "done", "", 0); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.EnqueueWhatsAppIdentityRecovery(ctx, f.account, device, "synthetic-paired-session", "paired", nil); err != nil {
		t.Fatal(err)
	}
	status, err = repo.IdentityRecoveryStatus(ctx, f.account, device)
	if err != nil || status == nil || status.State != "completed" || status.Phase != "done" {
		t.Fatal("paired replay reset completed run", status, err)
	}
}
