package repository

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

func privatePeerFixture(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID) {
	t.Helper()
	account, device := uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO accounts(id,name) VALUES($1,'Synthetic private peer')`, account)
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic peer device','connected')`, device, account)
	t.Cleanup(func() { integrityExec(t, pool, `DELETE FROM accounts WHERE id=$1`, account) })
	return account, device
}
func privatePeerProof(t *testing.T, pool *pgxpool.Pool, account, device uuid.UUID, pn, lid string) {
	t.Helper()
	r := NewRepositories(pool).Chat
	if _, err := r.EnsureWhatsAppIdentitySession(context.Background(), account, device, "synthetic-private-session"); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC()
	if _, err := r.ObserveWhatsAppPeersForSession(context.Background(), account, device, "synthetic-private-session", []domain.WhatsAppPeerObservation{{JID: lid, PN: pn, Source: "message", ObservedAt: &at}}); err != nil {
		t.Fatal(err)
	}
}
func privatePeerCounts(t *testing.T, pool *pgxpool.Pool, account uuid.UUID, wantContacts, wantChats, wantLeads int) {
	t.Helper()
	var contacts, chats, leads int
	if err := pool.QueryRow(context.Background(), `SELECT (SELECT COUNT(*) FROM contacts WHERE account_id=$1),(SELECT COUNT(*) FROM chats WHERE account_id=$1),(SELECT COUNT(*) FROM leads WHERE account_id=$1)`, account).Scan(&contacts, &chats, &leads); err != nil {
		t.Fatal(err)
	}
	if contacts != wantContacts || chats != wantChats || leads != wantLeads {
		t.Fatalf("got Contacts/Chats/Leads %d/%d/%d want %d/%d/%d", contacts, chats, leads, wantContacts, wantChats, wantLeads)
	}
}

func TestPrivatePeerCreationReusesSingleLIDHistoryAndContactAcrossRestart(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	account, device := privatePeerFixture(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool)
	pn, lid := "51900000001@s.whatsapp.net", "7001@lid"
	old, err := r.Chat.GetOrCreate(ctx, account, device, lid, "Original")
	if err != nil {
		t.Fatal(err)
	}
	messageID, leadID := uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO messages(id,account_id,device_id,chat_id,message_id,message_type,body,timestamp) VALUES($1,$2,$3,$4,'synthetic-old','text','Synthetic history',NOW())`, messageID, account, device, old.ID)
	integrityExec(t, pool, `INSERT INTO leads(id,account_id,contact_id,jid,title) VALUES($1,$2,$3,$4,'Synthetic opportunity')`, leadID, account, *old.ContactID, lid)
	privatePeerProof(t, pool, account, device, pn, lid)
	for _, jid := range []string{pn, lid, pn} {
		current, err := NewRepositories(pool).Chat.GetOrCreate(ctx, account, device, jid, "Current")
		if err != nil {
			t.Fatal(err)
		}
		if current.ID != old.ID || current.ContactID == nil || *current.ContactID != *old.ContactID || current.JID != lid || current.IdentityPending || current.ContactPhone == nil || *current.ContactPhone != "51900000001" {
			t.Fatalf("lost stable verified representation: %+v", current)
		}
		contact, err := NewRepositories(pool).Contact.GetOrCreate(ctx, account, &device, jid, "", "Current", "", false)
		if err != nil {
			t.Fatal(err)
		}
		if contact.ID != *old.ContactID {
			t.Fatal("sync created a second Contact")
		}
	}
	var chat, contact uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT m.chat_id,l.contact_id FROM messages m JOIN leads l ON l.account_id=m.account_id WHERE m.id=$1 AND l.id=$2`, messageID, leadID).Scan(&chat, &contact); err != nil {
		t.Fatal(err)
	}
	if chat != old.ID || contact != *old.ContactID {
		t.Fatal("history or Lead was relinked")
	}
	var aliases int
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM contact_aliases WHERE account_id=$1`, account, &aliases)
	if aliases != 3 {
		t.Fatalf("durable verified aliases: %d", aliases)
	}
	privatePeerCounts(t, pool, account, 1, 1, 1)
}

func TestPrivatePeerCreationSerializesPNLIDAndSyncAcrossDevices(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	account, device := privatePeerFixture(t, pool)
	second := uuid.New()
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Second synthetic peer','connected')`, second, account)
	pn, lid := "51900000002@s.whatsapp.net", "7002@lid"
	privatePeerProof(t, pool, account, device, pn, lid)
	privatePeerProof(t, pool, account, second, pn, lid)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	type output struct {
		contact, chat uuid.UUID
		err           error
	}
	results := make(chan output, 24)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			dev := device
			if i%2 == 0 {
				dev = second
			}
			jid := pn
			if i%3 == 0 {
				jid = lid
			}
			r := NewRepositories(pool)
			if i%4 == 0 {
				c, e := r.Contact.GetOrCreate(ctx, account, &dev, jid, "", "Synthetic", "", false)
				out := output{err: e}
				if c != nil {
					out.contact = c.ID
				}
				results <- out
				return
			}
			c, e := r.Chat.GetOrCreate(ctx, account, dev, jid, "Synthetic")
			out := output{err: e}
			if c != nil {
				out.chat = c.ID
				if c.ContactID != nil {
					out.contact = *c.ContactID
				}
			}
			results <- out
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	var contact, chat uuid.UUID
	for got := range results {
		if got.err != nil {
			t.Fatal(got.err)
		}
		if contact == uuid.Nil {
			contact = got.contact
		}
		if got.contact != contact {
			t.Fatal("concurrent aliases created multiple Contacts")
		}
		if got.chat != uuid.Nil {
			if chat == uuid.Nil {
				chat = got.chat
			}
			if got.chat != chat {
				t.Fatal("concurrent aliases created multiple Chats")
			}
		}
	}
	privatePeerCounts(t, pool, account, 1, 1, 0)
}

func TestPrivatePeerCreationKeepsDivergentLegacyContactsAndMessages(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	account, device := privatePeerFixture(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool)
	pn, lid := "51900000003@s.whatsapp.net", "7003@lid"
	chats := map[string]*domain.Chat{}
	for _, jid := range []string{pn, lid} {
		c, err := r.Chat.GetOrCreate(ctx, account, device, jid, "Synthetic legacy")
		if err != nil {
			t.Fatal(err)
		}
		chats[jid] = c
		integrityExec(t, pool, `INSERT INTO messages(account_id,device_id,chat_id,message_id,message_type,body,timestamp) VALUES($1,$2,$3,$4,'text','Synthetic duplicate stanza',NOW())`, account, device, c.ID, "same-provider-stanza")
		integrityExec(t, pool, `INSERT INTO leads(account_id,contact_id,jid,title) VALUES($1,$2,$3,'Synthetic legacy opportunity')`, account, *c.ContactID, jid)
	}
	privatePeerProof(t, pool, account, device, pn, lid)
	// Even a legacy alias pointing at the other Contact may not steal an exact
	// route. No new aliases are written while the two parents diverge.
	integrityExec(t, pool, `INSERT INTO contact_aliases(account_id,contact_id,alias_type,alias_value,normalized_value) VALUES($1,$2,'jid',$3,$3)`, account, *chats[pn].ContactID, lid)
	for _, jid := range []string{pn, lid} {
		got, err := r.Chat.GetOrCreate(ctx, account, device, jid, "")
		if err != nil {
			t.Fatal(err)
		}
		if got.ID != chats[jid].ID || *got.ContactID != *chats[jid].ContactID {
			t.Fatal("legacy exact history was replaced")
		}
		contact, err := r.Contact.GetOrCreate(ctx, account, &device, jid, "", "", "", false)
		if err != nil {
			t.Fatal(err)
		}
		if contact.ID != *chats[jid].ContactID {
			t.Fatal("legacy Contact was merged")
		}
	}
	privatePeerCounts(t, pool, account, 2, 2, 2)
	var messages int
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM messages WHERE account_id=$1`, account, &messages)
	if messages != 2 {
		t.Fatal("duplicate historical rows were deleted")
	}
	var lidPhone *string
	if err := pool.QueryRow(ctx, `SELECT phone FROM contacts WHERE account_id=$1 AND id=$2`, account, *chats[lid].ContactID).Scan(&lidPhone); err != nil {
		t.Fatal(err)
	}
	if lidPhone != nil && *lidPhone != "" {
		t.Fatal("conflicting LID inherited the other Contact's phone")
	}
}

func TestPrivatePeerCreationDoesNotCollapseTwoPhonesOfOneContact(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	account, device := privatePeerFixture(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool)
	first, err := r.Chat.GetOrCreate(ctx, account, device, "51900000004@s.whatsapp.net", "Two phones")
	if err != nil {
		t.Fatal(err)
	}
	pn, lid := "51900000005@s.whatsapp.net", "7005@lid"
	integrityExec(t, pool, `INSERT INTO contact_phones(contact_id,phone) VALUES($1,'900000005')`, *first.ContactID)
	privatePeerProof(t, pool, account, device, pn, lid)
	second, err := r.Chat.GetOrCreate(ctx, account, device, lid, "")
	if err != nil {
		t.Fatal(err)
	}
	if second.ID == first.ID || *second.ContactID != *first.ContactID {
		t.Fatal("distinct phones were collapsed or Contact duplicated")
	}
	privatePeerCounts(t, pool, account, 1, 2, 0)
}

func TestPrivatePeerCreationProofIsCurrentDeviceAndAccountScoped(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	account, device := privatePeerFixture(t, pool)
	otherAccount, otherDevice := privatePeerFixture(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool)
	pn, lid := "51900000006@s.whatsapp.net", "7006@lid"
	privatePeerProof(t, pool, account, device, pn, lid)
	a, err := r.Chat.GetOrCreate(ctx, account, device, lid, "")
	if err != nil {
		t.Fatal(err)
	}
	b, err := r.Chat.GetOrCreate(ctx, otherAccount, otherDevice, lid, "")
	if err != nil {
		t.Fatal(err)
	}
	if a.AccountID == b.AccountID || a.ID == b.ID || *a.ContactID == *b.ContactID || b.JID != lid || !b.IdentityPending || b.ContactPhone != nil {
		t.Fatal("provider proof crossed account/device")
	}
	foreign := uuid.New()
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'No proof','connected')`, foreign, account)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	unproven, err := verifiedPrivatePeerTx(ctx, tx, account, foreign, lid)
	_ = tx.Rollback(ctx)
	if err != nil || unproven == nil || unproven.verified || unproven.pn != "" {
		t.Fatalf("foreign device inherited proof: %+v %v", unproven, err)
	}
	if _, err = r.Chat.EnsureWhatsAppIdentitySession(ctx, account, device, "replacement-synthetic-session"); err != nil {
		t.Fatal(err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stale, err := verifiedPrivatePeerTx(ctx, tx, account, device, lid)
	_ = tx.Rollback(ctx)
	if err != nil || stale == nil || stale.verified || stale.pn != "" {
		t.Fatalf("replaced session retained proof: %+v %v", stale, err)
	}
	// The exact historical LID route can continue without claiming a phone.
	retained, err := r.Chat.GetOrCreate(ctx, otherAccount, otherDevice, lid, "")
	if err != nil || retained.ID != b.ID {
		t.Fatalf("exact path unavailable: %v", err)
	}
	privatePeerCounts(t, pool, account, 1, 1, 0)
	privatePeerCounts(t, pool, otherAccount, 1, 1, 0)
}

func TestPrivatePeerCreationRetainsTwoHistoriesOfSameContact(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	account, device := privatePeerFixture(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool)
	pn, lid := "51900000007@s.whatsapp.net", "7007@lid"
	first, err := r.Chat.GetOrCreate(ctx, account, device, pn, "")
	if err != nil {
		t.Fatal(err)
	}
	secondID := uuid.New()
	integrityExec(t, pool, `INSERT INTO chats(id,account_id,device_id,contact_id,jid,channel_key) VALUES($1,$2,$3,$4,$5,'whatsapp_web')`, secondID, account, device, *first.ContactID, lid)
	privatePeerProof(t, pool, account, device, pn, lid)
	for _, entry := range []struct {
		jid string
		id  uuid.UUID
	}{{pn, first.ID}, {lid, secondID}} {
		got, err := r.Chat.GetOrCreate(ctx, account, device, entry.jid, "")
		if err != nil {
			t.Fatal(err)
		}
		if got.ID != entry.id || *got.ContactID != *first.ContactID {
			t.Fatal("two historical chats of one Contact were merged or replaced")
		}
	}
	privatePeerCounts(t, pool, account, 1, 2, 0)
}

func TestPrivatePeerCreationSelectedContactAndReloadRemainSessionScoped(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	account, device := privatePeerFixture(t, pool)
	ctx := context.Background()
	r := NewRepositories(pool)
	pn, lid := "51900000008@s.whatsapp.net", "7008@lid"
	original, err := r.Chat.GetOrCreate(ctx, account, device, lid, "")
	if err != nil {
		t.Fatal(err)
	}
	privatePeerProof(t, pool, account, device, pn, lid)
	got, err := r.Chat.GetOrCreateForContact(ctx, account, device, *original.ContactID, pn, "51900000008", "")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != original.ID || got.JID != lid || got.IdentityPending || got.ContactPhone == nil {
		t.Fatalf("selected Contact created duplicate or lost verified hydration: %+v", got)
	}
	privatePeerCounts(t, pool, account, 1, 1, 0)
	unrelated := uuid.New()
	integrityExec(t, pool, `INSERT INTO contacts(id,account_id,jid) VALUES($1,$2,$3)`, unrelated, account, unrelated.String()+"@test.invalid")
	if _, err = r.Chat.GetOrCreateForContact(ctx, account, device, unrelated, pn, "51900000008", ""); err == nil {
		t.Fatal("selected parent was silently changed")
	}
	if _, err = r.Chat.EnsureWhatsAppIdentitySession(ctx, account, device, "new-synthetic-session"); err != nil {
		t.Fatal(err)
	}
	if err = r.Chat.HydratePrivatePeerIdentity(ctx, account, []*domain.Chat{got}); err != nil {
		t.Fatal(err)
	}
	if !got.IdentityPending || got.ContactPhone != nil {
		t.Fatal("stale hydrated phone survived session replacement")
	}
	// Despite missing current alias proof, the already linked exact LID route
	// stays available; neither its CRM parent nor history is reconstructed.
	retained, err := r.Chat.GetOrCreate(ctx, account, device, lid, "")
	if err != nil || retained.ID != original.ID {
		t.Fatalf("lost exact legacy route: %v", err)
	}
	privatePeerCounts(t, pool, account, 2, 1, 0)
}
