package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestOfflineV5ProofBindsVersionOriginRouteBodyAndTuple(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := &jose.JSONWebKey{Key: &privateKey.PublicKey, KeyID: "v5-test", Use: "sig", Algorithm: "ES256"}
	now := time.Unix(1900000000, 0).UTC()
	body := []byte(`{"grant_id":"opaque","operations":[]}`)
	hash := sha256.Sum256(body)
	proof := offlineV5Proof{Version: 5, Purpose: "sync", ChallengeID: uuid.New(),
		Nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Method: "POST", Path: "/api/offline/v5/sync",
		BodySHA256: hex.EncodeToString(hash[:]), Audience: "https://clarin.example.invalid", BrowserProfileID: uuid.New(),
		GrantID: uuid.New(), IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix(), ID: uuid.New()}
	sign := func(value offlineV5Proof, typ string) string {
		t.Helper()
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: privateKey},
			new(jose.SignerOptions).WithType(jose.ContentType(typ)))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(value)
		object, err := signer.Sign(raw)
		if err != nil {
			t.Fatal(err)
		}
		compact, err := object.CompactSerialize()
		if err != nil {
			t.Fatal(err)
		}
		return compact
	}
	if err := verifyOfflineV5Proof(sign(proof, offlineV5ProofType), publicKey, proof, body, now); err != nil {
		t.Fatalf("valid v5 proof rejected: %v", err)
	}
	mutations := map[string]func(*offlineV5Proof){
		"version":   func(value *offlineV5Proof) { value.Version = 4 },
		"purpose":   func(value *offlineV5Proof) { value.Purpose = "prepare" },
		"origin":    func(value *offlineV5Proof) { value.Audience = "https://other.example.invalid" },
		"path":      func(value *offlineV5Proof) { value.Path = "/api/offline/v4/sync" },
		"method":    func(value *offlineV5Proof) { value.Method = "GET" },
		"profile":   func(value *offlineV5Proof) { value.BrowserProfileID = uuid.New() },
		"grant":     func(value *offlineV5Proof) { value.GrantID = uuid.New() },
		"challenge": func(value *offlineV5Proof) { value.ChallengeID = uuid.New() },
		"future":    func(value *offlineV5Proof) { value.IssuedAt = now.Add(2 * time.Minute).Unix() },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			changed := proof
			mutate(&changed)
			if verifyOfflineV5Proof(sign(changed, offlineV5ProofType), publicKey, proof, body, now) == nil {
				t.Fatal("mismatched v5 proof accepted")
			}
		})
	}
	if verifyOfflineV5Proof(sign(proof, "clarin-offline-v4-proof+jwt"), publicKey, proof, body, now) == nil {
		t.Fatal("v4 proof type accepted by v5")
	}
	if verifyOfflineV5Proof(sign(proof, offlineV5ProofType), publicKey, proof, append(body, ' '), now) == nil {
		t.Fatal("proof accepted for modified request bytes")
	}
}

func TestOfflineV5RoutesAndBodyLimitsRemainExplicit(t *testing.T) {
	source, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, route := range []string{
		`api.Get("/offline/v5/runtime/availability"`, `offlineV5Public.Get("/lease-keys"`,
		`offlineV5Public.Post("/grants/status"`,
		`offlineV5Public.Post("/sync/challenge"`, `offlineV5Public.Post("/sync"`,
		`offlineV5.Post("/enrollment/challenge"`, `offlineV5.Post("/enrollment/requests"`,
		`offlineV5.Get("/grants/:grantId/resources"`, `offlineV5.Put("/grants/:grantId/selection"`,
		`offlineV5.Post("/grants/:grantId/prepare/challenge"`, `offlineV5.Post("/grants/:grantId/prepare"`,
	} {
		if !strings.Contains(text, route) {
			t.Fatalf("offline v5 route not registered: %s", route)
		}
	}
	if got := offlineV4RequestLimit("/api/offline/v5/sync"); got != 2<<20 {
		t.Fatalf("sync body limit=%d", got)
	}
	if got := offlineV4RequestLimit("/api/offline/v5/grants/a/selection"); got != 32<<10 {
		t.Fatalf("selection body limit=%d", got)
	}
	if got := offlineV4RequestLimit("/api/not-offline"); got != 0 {
		t.Fatalf("unrelated endpoint limited=%d", got)
	}
}

func TestOfflineV5GrantStatusReturnsOnlyActiveGrantsForExactBrowserProfile(t *testing.T) {
	profileID := uuid.New()
	activeID := uuid.New()
	revokedID := uuid.New()
	foreignID := uuid.New()
	records := []*repository.OfflineV4AuthRecord{
		{OfflineV4Grant: domain.OfflineV4Grant{OfflineV4Tuple: domain.OfflineV4Tuple{BrowserProfileID: profileID, GrantID: activeID}, State: "active"}},
		{OfflineV4Grant: domain.OfflineV4Grant{OfflineV4Tuple: domain.OfflineV4Tuple{BrowserProfileID: profileID, GrantID: revokedID}, State: "revoked"}},
		{OfflineV4Grant: domain.OfflineV4Grant{OfflineV4Tuple: domain.OfflineV4Tuple{BrowserProfileID: uuid.New(), GrantID: foreignID}, State: "active"}},
		{OfflineV4Grant: domain.OfflineV4Grant{OfflineV4Tuple: domain.OfflineV4Tuple{BrowserProfileID: profileID, GrantID: activeID}, State: "active"}},
	}
	got := offlineV5ActiveGrantIDs(profileID, records)
	if len(got) != 1 || got[0] != activeID {
		t.Fatalf("unexpected active grant status: %v", got)
	}
}

func TestOfflineV5SyncBatchLimitRunsBeforeExpensiveValidation(t *testing.T) {
	input := &repository.OfflineV5SyncInput{
		Operations:    make([]domain.OfflineV5Operation, offlineMaxOperations),
		WantSnapshots: make([]uuid.UUID, domain.OfflineV5MaxResources),
	}
	if !offlineV5SyncBatchWithinLimits(input) {
		t.Fatal("maximum supported v5 sync batch was rejected")
	}
	input.Operations = append(input.Operations, domain.OfflineV5Operation{})
	if offlineV5SyncBatchWithinLimits(input) {
		t.Fatal("oversized v5 operation batch reached expensive validation")
	}
	input.Operations = input.Operations[:offlineMaxOperations]
	input.WantSnapshots = append(input.WantSnapshots, uuid.Nil)
	if offlineV5SyncBatchWithinLimits(input) {
		t.Fatal("oversized v5 snapshot request batch was accepted")
	}
}

func TestOfflineV5WritesShutdownStillReachesReceiptRecovery(t *testing.T) {
	source, err := os.ReadFile("offline_v5_handler.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	repositorySync := strings.Index(text, "result, err := s.repos.OfflineV5.Sync")
	disabledMapping := strings.Index(text, "errors.Is(err, repository.ErrOfflineV5WritesDisabled)")
	if repositorySync < 0 || disabledMapping < repositorySync {
		t.Fatal("writes-disabled mapping must occur after repository sync decides normal-write versus recovery")
	}
	if strings.Contains(text[:repositorySync], "len(input.Operations) > 0 && !s.cfg.OfflineV5WritesEnabled") {
		t.Fatal("handler blocks committed receipt recovery before inspecting the superseded manifest")
	}
	renewalGate := strings.Index(text[repositorySync:], "if !s.cfg.OfflineV5PrepareEnabled")
	refreshManifest := strings.Index(text[repositorySync:], "s.repos.OfflineV5.RefreshManifest")
	if renewalGate < 0 || refreshManifest < 0 || renewalGate > refreshManifest {
		t.Fatal("global preparation kill switch must run after receipt recovery and before manifest renewal")
	}
	if !strings.Contains(text[repositorySync:], `"renewal_available": false`) || !strings.Contains(text[repositorySync:], "result.RecoveredReceipts") {
		t.Fatal("preparation shutdown lost receipt-only recovery response")
	}
	challengeHandler := strings.Index(text, "func (s *Server) handleOfflineV5GrantChallenge")
	prepareHandler := strings.Index(text, "func (s *Server) handleOfflineV5Prepare")
	registerKeyHandler := strings.Index(text, "func (s *Server) handleOfflineV5RegisterKey")
	if challengeHandler < 0 || registerKeyHandler <= challengeHandler || prepareHandler <= registerKeyHandler ||
		!strings.Contains(text[challengeHandler:registerKeyHandler], "!s.cfg.OfflineV5PrepareEnabled") ||
		!strings.Contains(text[registerKeyHandler:prepareHandler], "!s.cfg.OfflineV5PrepareEnabled") {
		t.Fatal("preparation shutdown must reject key and preparation challenge provisioning")
	}
}
