package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"testing"
	"time"
)

func TestPeerIdentityObservationRejectsFabricatedAddresses(t *testing.T) {
	for _, raw := range []string{"handle@s.whatsapp.net", "username@lid", "12001@g.us", "+51900000001@s.whatsapp.net", "7001@unknown"} {
		if canonicalPeerAddress(raw) != "" {
			t.Fatalf("not a verified PN/LID address: %q", raw)
		}
	}
	now := time.Now().UTC()
	next, ok := normalizePeerObservation(domain.WhatsAppPeerObservation{JID: "7001@lid", Source: "message", Fields: map[string]string{"push_name": "Real name", "phone": "7001"}}, now)
	if !ok || next.PN != "" || len(next.Fields) != 1 {
		t.Fatalf("LID digits became phone: %+v", next)
	}
}

func TestPeerIdentityPostgresIsolationAliasesAndMonotonicFields(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f, other := integrityProgram(t, pool), integrityProgram(t, pool)
	repo := NewRepositories(pool).Chat
	device, secondDevice, foreignDevice := uuid.New(), uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$4,'Identity A','connected'),($2,$4,'Identity B','connected'),($3,$5,'Foreign identity','connected')`, device, secondDevice, foreignDevice, f.account, other.account)
	lid, pn := "7001@lid", "51900000001@s.whatsapp.net"
	oldAt := time.Now().UTC().Add(-time.Hour)
	newAt := oldAt.Add(time.Minute)
	observe := func(account, dev uuid.UUID, in domain.WhatsAppPeerObservation) {
		t.Helper()
		if _, err := repo.ObserveWhatsAppPeers(ctx, account, dev, []domain.WhatsAppPeerObservation{in}); err != nil {
			t.Fatal(err)
		}
	}
	observe(f.account, device, domain.WhatsAppPeerObservation{JID: lid, Source: "message", ObservedAt: &newAt, Fields: map[string]string{"push_name": "Current name"}})
	observe(f.account, device, domain.WhatsAppPeerObservation{JID: lid, PN: pn, Source: "history_contact", Fields: map[string]string{"username": "current.handle"}})
	observe(f.account, device, domain.WhatsAppPeerObservation{JID: lid, Source: "history_message", ObservedAt: &oldAt, Fields: map[string]string{"push_name": "Old history"}})
	observe(f.account, device, domain.WhatsAppPeerObservation{JID: lid, Source: "history_push_name", Fields: map[string]string{"push_name": "Undated old history"}})
	snap, err := repo.WhatsAppPeerIdentities(ctx, f.account, device, []string{pn})
	if err != nil {
		t.Fatal(err)
	}
	if snap.LIDForPN[pn] != lid || snap.Fields[lid]["push_name"].Value != "Current name" || snap.Fields[lid]["username"].Value != "current.handle" {
		t.Fatalf("lost alias/current identity: %+v", snap)
	}
	for _, scope := range []struct{ account, device uuid.UUID }{{f.account, secondDevice}, {other.account, foreignDevice}, {other.account, device}} {
		snap, err = repo.WhatsAppPeerIdentities(ctx, scope.account, scope.device, []string{pn, lid})
		if err != nil || len(snap.Fields) != 0 || len(snap.LIDForPN) != 0 {
			t.Fatalf("identity crossed scope: %+v %v", snap, err)
		}
	}
	_, err = repo.ObserveWhatsAppPeers(ctx, other.account, device, []domain.WhatsAppPeerObservation{{JID: lid, Source: "message", ObservedAt: &newAt, Fields: map[string]string{"push_name": "Foreign write"}}})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("foreign device write accepted", err)
	}
	removedAt := newAt.Add(time.Minute)
	observe(f.account, device, domain.WhatsAppPeerObservation{JID: lid, Source: "contact_action", ObservedAt: &removedAt, Fields: map[string]string{"username": ""}})
	observe(f.account, device, domain.WhatsAppPeerObservation{JID: lid, Source: "history_account", Fields: map[string]string{"username": "old.handle"}})
	snap, err = repo.WhatsAppPeerIdentities(ctx, f.account, device, []string{lid})
	if err != nil || snap.Fields[lid]["username"].Value != "" || snap.Fields[lid]["username"].Source != "contact_action" {
		t.Fatal("history revived username", err)
	}
	var contacts, chats int
	integrityScanCount(t, pool, `SELECT count(*) FROM contacts WHERE account_id=$1`, f.account, &contacts)
	integrityScanCount(t, pool, `SELECT count(*) FROM chats WHERE account_id=$1`, f.account, &chats)
	if contacts != 1 || chats != 0 {
		t.Fatalf("identity lookup imported CRM: %d Contacts %d Chats", contacts, chats)
	}
}

func TestPeerIdentityPostgresReassignmentAndStoredGroupMessageFallback(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, pool)
	repo := NewRepositories(pool).Chat
	device := uuid.New()
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Identity','connected')`, device, f.account)
	pn, oldLID, newLID := "51900000001@s.whatsapp.net", "7001@lid", "7002@lid"
	at := time.Now().UTC().Add(-time.Hour)
	_, err := repo.ObserveWhatsAppPeers(ctx, f.account, device, []domain.WhatsAppPeerObservation{{JID: pn, Source: "contact_action", ObservedAt: &at, Fields: map[string]string{"full_name": "Old owner"}}, {JID: oldLID, PN: pn, Source: "group_metadata", ObservedAt: &at}})
	if err != nil {
		t.Fatal(err)
	}
	// The new owner's stable facts predate the observed phone reassignment.
	// Alias invalidation must leave them intact and visible to projection.
	_, err = repo.ObserveWhatsAppPeers(ctx, f.account, device, []domain.WhatsAppPeerObservation{{JID: newLID, Source: "contact_action", ObservedAt: &at, Fields: map[string]string{"full_name": "New stable owner", "username": "new.handle"}}})
	if err != nil {
		t.Fatal(err)
	}
	later := at.Add(time.Minute)
	_, err = repo.ObserveWhatsAppPeers(ctx, f.account, device, []domain.WhatsAppPeerObservation{{JID: newLID, PN: pn, Source: "group_metadata", ObservedAt: &later, Fields: map[string]string{"push_name": "New owner"}}})
	if err != nil {
		t.Fatal(err)
	}
	snap, err := repo.WhatsAppPeerIdentities(ctx, f.account, device, []string{pn})
	if err != nil || snap.LIDForPN[pn] != newLID || snap.Fields[pn]["full_name"].Value != "" {
		t.Fatalf("reassignment carried old identity: %+v %v", snap, err)
	}
	if snap.Fields[newLID]["full_name"].Value != "New stable owner" || snap.Fields[newLID]["username"].Value != "new.handle" || len(snap.Fields[pn]) != 6 || snap.Fields[pn]["username"].Source != "alias_reassigned" {
		t.Fatalf("alias invalidation erased stable facts or failed to invalidate an unpersisted cached field: %+v", snap)
	}
	_, err = repo.ObserveWhatsAppPeers(ctx, f.account, device, []domain.WhatsAppPeerObservation{{JID: oldLID, PN: pn, Source: "history_contact", Fields: map[string]string{"full_name": "Stale alias"}}})
	if err != nil {
		t.Fatal(err)
	}
	snap, err = repo.WhatsAppPeerIdentities(ctx, f.account, device, []string{pn})
	if err != nil || snap.LIDForPN[pn] != newLID {
		t.Fatal("old history rebound phone")
	}
	chat, err := repo.GetOrCreateGroup(ctx, f.account, device, "120012@g.us", "Identity group")
	if err != nil {
		t.Fatal(err)
	}
	integrityExec(t, pool, `INSERT INTO messages(account_id,device_id,chat_id,message_id,from_jid,from_name,body,message_type,is_from_me,timestamp) VALUES($1,$2,$3,$4,'7003@lid','Name from real stored message','Synthetic QA','text',FALSE,$5)`, f.account, device, chat.ID, uuid.NewString(), later)
	snap, err = repo.WhatsAppPeerIdentities(ctx, f.account, device, []string{"7003@lid"})
	if err != nil || snap.Fields["7003@lid"]["push_name"].Value != "Name from real stored message" || snap.Fields["7003@lid"]["push_name"].ObservedAt == nil {
		t.Fatalf("stored sender fallback missing: %+v %v", snap, err)
	}
}

func TestPeerIdentityPostgresConcurrentOldHistoryCannotWin(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	f := integrityProgram(t, pool)
	repo := NewRepositories(pool).Chat
	device := uuid.New()
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Concurrent identity','connected')`, device, f.account)
	at := time.Now().UTC().Add(-time.Minute)
	results := make(chan error, 12)
	for i := 0; i < 12; i++ {
		i := i
		go func() {
			in := domain.WhatsAppPeerObservation{JID: "7001@lid", Source: "history_push_name", Fields: map[string]string{"push_name": "Old undated history"}}
			if i%2 == 0 {
				in.Source = "message"
				in.ObservedAt = &at
				in.Fields["push_name"] = "Current sender name"
			}
			_, err := repo.ObserveWhatsAppPeers(ctx, f.account, device, []domain.WhatsAppPeerObservation{in})
			results <- err
		}()
	}
	for i := 0; i < 12; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	snap, err := repo.WhatsAppPeerIdentities(ctx, f.account, device, []string{"7001@lid"})
	if err != nil || snap.Fields["7001@lid"]["push_name"].Value != "Current sender name" {
		t.Fatalf("concurrent history replaced current provider facts: %+v %v", snap, err)
	}
}
