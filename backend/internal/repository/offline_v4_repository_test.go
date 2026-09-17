package repository

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestOfflineV4CatalogStatementsUseCanonicalLifecycleAndBoundaries(t *testing.T) {
	for module, alias := range map[string]string{"tasks": "list", "contacts": "contact", "programs": "program", "whiteboards": "board"} {
		t.Run(module, func(t *testing.T) {
			query := offlineV4CatalogStatement(module)
			for _, predicate := range []string{alias + ".account_id=$1", alias + ".id>$2", "LIKE $3", "ORDER BY " + alias + ".id LIMIT $4"} {
				if !strings.Contains(query, predicate) {
					t.Fatalf("catalog lost account/search/cursor bound: %s", predicate)
				}
			}
			if module == "whiteboards" && (!strings.Contains(query, "board.archived_at IS NULL") || strings.Contains(query, "deleted_at")) {
				t.Fatal("whiteboards must use canonical archived_at, never a synthetic deleted_at")
			}
		})
	}
	contactQuery := offlineV4CatalogStatement("contacts")
	if strings.Count(contactQuery, "NULLIF(BTRIM(contact.custom_name),'')") != 2 || strings.Count(contactQuery, "contact.push_name") != 2 {
		t.Fatal("contact search must match the canonical display label, including empty-name fallbacks")
	}
	if offlineV4CatalogStatement("untrusted") != "" {
		t.Fatal("unrecognized module selected a catalog")
	}
}

func TestOfflineV4OperationCannotCrossGrantOrActor(t *testing.T) {
	now := time.Now().UTC()
	record := &OfflineV4AuthRecord{OfflineV4Grant: domain.OfflineV4Grant{OfflineV4Tuple: domain.OfflineV4Tuple{BrowserProfileID: uuid.New(), UserID: uuid.New(), AccountID: uuid.New(), GrantID: uuid.New()}, SelectionRevision: 3, CredentialEpoch: 4, AuthorityEpoch: 5}}
	op := domain.OfflineV3Operation{ProtocolVersion: 4, BrowserProfileID: record.BrowserProfileID, UserID: record.UserID, AccountID: record.AccountID, GrantID: record.GrantID, SelectionRevision: 3, CredentialEpoch: 4, AuthorityEpoch: 5, OperationID: uuid.New(), SelectionID: uuid.New(), ResourceID: uuid.New(), Action: "tasks.create", OccurredAt: now}
	if !offlineV4OperationBinding(record, op, now) {
		t.Fatal("valid binding rejected")
	}
	cases := map[string]func(*domain.OfflineV3Operation){"profile": func(o *domain.OfflineV3Operation) { o.BrowserProfileID = uuid.New() }, "user same account": func(o *domain.OfflineV3Operation) { o.UserID = uuid.New() }, "account same user": func(o *domain.OfflineV3Operation) { o.AccountID = uuid.New() }, "grant": func(o *domain.OfflineV3Operation) { o.GrantID = uuid.New() }, "protocol": func(o *domain.OfflineV3Operation) { o.ProtocolVersion = 3 }, "selection": func(o *domain.OfflineV3Operation) { o.SelectionRevision++ }, "password": func(o *domain.OfflineV3Operation) { o.CredentialEpoch++ }, "authority": func(o *domain.OfflineV3Operation) { o.AuthorityEpoch++ }, "future": func(o *domain.OfflineV3Operation) { o.OccurredAt = now.Add(time.Hour) }, "action": func(o *domain.OfflineV3Operation) { o.Action = "contacts.write" }, "missing operation": func(o *domain.OfflineV3Operation) { o.OperationID = uuid.Nil }}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			bad := op
			change(&bad)
			if offlineV4OperationBinding(record, bad, now) {
				t.Fatal("foreign/stale operation accepted")
			}
		})
	}
}

func TestOfflineV4SelectionDigestAndShape(t *testing.T) {
	a := domain.OfflineV3Selection{Module: "tasks", ResourceType: "task_list", ResourceID: uuid.New()}
	b := domain.OfflineV3Selection{Module: "contacts", ResourceType: "contact", ResourceID: uuid.New()}
	if !offlineV4SelectionShape(a) || !offlineV4SelectionShape(b) {
		t.Fatal("valid resource shape rejected")
	}
	bad := a
	bad.ResourceType = "contact"
	if offlineV4SelectionShape(bad) {
		t.Fatal("cross-module resource shape accepted")
	}
	if offlineV4SelectionDigest([]domain.OfflineV3Selection{a, b}) != offlineV4SelectionDigest([]domain.OfflineV3Selection{b, a}) {
		t.Fatal("selection order changes digest")
	}
	if offlineV4SelectionDigest(nil) != "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" {
		t.Fatal("empty digest differs from migration")
	}
	if offlineV4SelectionDigest([]domain.OfflineV3Selection{a}) == offlineV4SelectionDigest([]domain.OfflineV3Selection{b}) {
		t.Fatal("different resources share selection digest")
	}
}
