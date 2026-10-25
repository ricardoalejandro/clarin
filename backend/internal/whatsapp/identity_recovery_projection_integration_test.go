package whatsapp

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/pkg/database"
)

func TestIdentityRecoveryPartialCheckpointProjectsBeforeRemainingBackoff(t *testing.T) {
	raw := os.Getenv("INTEGRITY_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("requires dedicated synthetic PostgreSQL")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Path != "/program_survey_integrity_test" {
		t.Fatal("dedicated program_survey_integrity_test database required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	repos := repository.NewRepositories(db)
	account, device, contact := uuid.New(), uuid.New(), uuid.New()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Synthetic partial identity recovery')`, account)
	t.Cleanup(func() { _, _ = db.Exec(context.Background(), `DELETE FROM accounts WHERE id=$1`, account) })
	exec(`INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic local projection','connected')`, device, account)
	const fingerprint = "synthetic-partial-checkpoint"
	const pn = "51980000421@s.whatsapp.net"
	const phone = "51980000421"
	const lid = "70000421@lid"
	const waitingPN = "51980000422@s.whatsapp.net"
	exec(`INSERT INTO contacts(id,account_id,device_id,jid,phone,name) VALUES($1,$2,$3,$4,$5,'Preserve canonical CRM identity')`, contact, account, device, pn, phone)
	if _, err = repos.Chat.EnsureWhatsAppIdentitySession(ctx, account, device, fingerprint); err != nil {
		t.Fatal(err)
	}
	chat, err := repos.Chat.GetOrCreateGroup(ctx, account, device, "120099900000421@g.us", "Synthetic partial recovery")
	if err != nil {
		t.Fatal(err)
	}
	group := &domain.ChatGroup{Subject: "Synthetic partial recovery", MembershipStatus: "member", Kind: "group"}
	members := []domain.GroupParticipant{{JID: lid, LID: lid, Name: "Nombre no disponible", NameSource: "unavailable", Role: "admin"}}
	if err = repos.Chat.SaveGroupForIdentitySession(ctx, account, device, chat.ID, group, members, fingerprint); err != nil {
		t.Fatal(err)
	}
	runID, err := repos.Chat.EnqueueWhatsAppIdentityRecovery(ctx, account, device, fingerprint, "connected", []string{pn, waitingPN})
	if err != nil {
		t.Fatal(err)
	}
	run, err := repos.Chat.ClaimIdentityRecoveryRun(ctx)
	if err != nil || run == nil || run.ID != runID {
		t.Fatal("could not claim synthetic recovery", run, err)
	}
	if err = repos.Chat.CheckpointIdentityRecovery(ctx, run, "lookup_after_appstate", true); err != nil {
		t.Fatal(err)
	}
	if err = repos.Chat.CompleteIdentityRecoveryBatch(ctx, run, []string{waitingPN}, false); err != nil {
		t.Fatal(err)
	}
	if err = repos.Chat.SetIdentityRecoveryUnresolved(ctx, run, 1); err != nil {
		t.Fatal(err)
	}
	// The provider's late, scoped response resolves this member while a separate
	// candidate is still waiting for its next retry. No provider client is used.
	at := time.Now().UTC()
	if _, err = repos.Chat.ObserveWhatsAppPeersForSession(ctx, account, device, fingerprint, []domain.WhatsAppPeerObservation{{JID: pn, PN: pn, LID: lid, Source: "user_info", ObservedAt: &at}, {JID: pn, PN: pn, Source: "contact_action", ObservedAt: &at, Fields: map[string]string{"full_name": "Synthetic recovered agenda"}}}); err != nil {
		t.Fatal(err)
	}
	if err = repos.Chat.CompleteIdentityRecoveryBatch(ctx, run, []string{pn}, true); err != nil {
		t.Fatal(err)
	}
	counts := func() (int, int) {
		t.Helper()
		var contacts, chats int
		if err := db.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM contacts WHERE account_id=$1),(SELECT COUNT(*) FROM chats WHERE account_id=$1)`, account).Scan(&contacts, &chats); err != nil {
			t.Fatal(err)
		}
		return contacts, chats
	}
	beforeContacts, beforeChats := counts()
	pool := &DevicePool{repos: repos, devices: map[uuid.UUID]*DeviceInstance{}}
	if err = pool.checkpointPartialIdentityRecovery(ctx, run); err != nil {
		t.Fatal("partial checkpoint failed", err)
	}
	projected, _, err := repos.Chat.GroupParticipants(ctx, account, chat.ID, "", "", 50)
	if err != nil || len(projected) != 1 || projected[0].LID != lid || projected[0].Phone != phone || projected[0].Name != "Synthetic recovered agenda" || projected[0].Role != "admin" {
		t.Fatal("resolved member stayed hidden behind another candidate's backoff", projected, err)
	}
	status, err := repos.Chat.IdentityRecoveryStatus(ctx, account, device)
	if err != nil || status == nil || status.State != "recovering" || status.Phase != "lookup_after_appstate" || status.UnresolvedMembers != 0 || status.Pending != 1 || status.Resolved != 1 {
		t.Fatal("partial checkpoint lost pending work or failed to reconcile its counter", status, err)
	}
	var backoffPreserved bool
	if err = db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whatsapp_identity_recovery_items WHERE account_id=$1 AND run_id=$2 AND pn_jid=$3 AND state='pending' AND attempts=1 AND next_attempt_at>NOW())`, account, run.ID, waitingPN).Scan(&backoffPreserved); err != nil || !backoffPreserved {
		t.Fatal("projection reset another candidate's retry", err)
	}
	var firstProjection string
	if err = db.QueryRow(ctx, `SELECT participants::text FROM chat_groups WHERE account_id=$1 AND chat_id=$2`, account, chat.ID).Scan(&firstProjection); err != nil {
		t.Fatal(err)
	}
	revision, err := repos.Chat.GroupRevision(ctx, account, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = pool.checkpointPartialIdentityRecovery(ctx, run); err != nil {
		t.Fatal("idempotent checkpoint failed", err)
	}
	var replayProjection string
	if err = db.QueryRow(ctx, `SELECT participants::text FROM chat_groups WHERE account_id=$1 AND chat_id=$2`, account, chat.ID).Scan(&replayProjection); err != nil || replayProjection != firstProjection {
		t.Fatal("replay rewrote a stable provider projection", err)
	}
	afterRevision, err := repos.Chat.GroupRevision(ctx, account, chat.ID)
	if err != nil || afterRevision != revision {
		t.Fatal("replay changed group material version", revision, afterRevision, err)
	}
	afterContacts, afterChats := counts()
	if afterContacts != beforeContacts || afterChats != beforeChats {
		t.Fatal("local checkpoint created CRM records", beforeContacts, afterContacts, beforeChats, afterChats)
	}
	var canonicalName string
	if err = db.QueryRow(ctx, `SELECT name FROM contacts WHERE account_id=$1 AND id=$2`, account, contact).Scan(&canonicalName); err != nil || canonicalName != "Preserve canonical CRM identity" {
		t.Fatal("provider projection changed canonical Contact identity", err)
	}
}
