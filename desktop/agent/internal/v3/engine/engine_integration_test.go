package engine

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"github.com/naperu/clarin-offline-agent/internal/v3/catalog"
	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
	"github.com/naperu/clarin-offline-agent/internal/v3/protocol"
	"github.com/naperu/clarin-offline-agent/internal/v3/vault"
)

type engineTestProtector struct{ key []byte }

func (p engineTestProtector) Protect(plain []byte, purpose string) ([]byte, error) {
	block, _ := aes.NewCipher(p.key)
	aead, _ := cipher.NewGCM(block)
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return append(nonce, aead.Seal(nil, nonce, plain, []byte(purpose))...), nil
}

func (p engineTestProtector) Unprotect(sealed []byte, purpose string) ([]byte, error) {
	block, _ := aes.NewCipher(p.key)
	aead, _ := cipher.NewGCM(block)
	if len(sealed) < aead.NonceSize() {
		return nil, errors.New("short test envelope")
	}
	return aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], []byte(purpose))
}

func TestSnapshotCompleteReceiptEndToEnd(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	service, err := Open(t.TempDir(), "https://clarin.example", "test-v3", engineTestProtector{key: bytes.Repeat([]byte{0x71}, 32)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close() })
	service.now = func() time.Time { return now }

	principal, err := service.catalog.EnsurePrincipal(ctx, "S-1-5-21-100-200-300-1001", "Test User")
	if err != nil {
		t.Fatal(err)
	}
	browserPrivate, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	browserPublic, _ := cryptokit.PublicJWK(&browserPrivate.PublicKey, "temporary-browser", "sig", "ES256")
	profile, err := service.catalog.CreateBrowserProfile(ctx, principal.ID, browserPublic, "Chrome Test")
	if err != nil {
		t.Fatal(err)
	}

	grantID := "55555555-5555-4555-8555-555555555555"
	selectionID := "88888888-8888-4888-8888-888888888888"
	listID := "99999999-9999-4999-8999-999999999999"
	taskID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	operationID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	tuple := model.Tuple{
		InstallationID: service.installation.ID, WindowsPrincipalID: principal.ID, BrowserProfileID: profile.ID,
		AuthorizationID: "44444444-4444-4444-8444-444444444444", GrantID: grantID,
		UserID: "66666666-6666-4666-8666-666666666666", AccountID: "77777777-7777-4777-8777-777777777777",
	}
	actions := []string{model.ActionTasksRead, model.ActionTasksCreate, model.ActionTasksComplete}
	selectionModel := model.Selection{SelectionID: selectionID, Module: "tasks", ResourceType: "task_list", ResourceID: listID}
	selectionDigest, err := model.SelectionDigest([]model.Selection{selectionModel})
	if err != nil {
		t.Fatal(err)
	}
	secrets, err := cryptokit.GenerateGrantSecrets()
	if err != nil {
		t.Fatal(err)
	}
	grantSigningJWK, _ := cryptokit.PublicJWK(&secrets.SigningKey.PublicKey, "grant-signing-test", "sig", "ES256")
	grantEncryptionJWK, _ := cryptokit.PublicJWK(&secrets.EncryptionKey.PublicKey, "grant-encryption-test", "enc", "ECDH-ES+A256KW")
	grantSigningRaw, _ := json.Marshal(grantSigningJWK)
	grantEncryptionRaw, _ := json.Marshal(grantEncryptionJWK)
	grantSigningThumb, _ := cryptokit.Thumbprint(grantSigningJWK)
	grantEncryptionThumb, _ := cryptokit.Thumbprint(grantEncryptionJWK)

	serverSigner, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serverSignerJWK, _ := cryptokit.PublicJWK(&serverSigner.PublicKey, "server-signing-3", "sig", "ES256")
	ring := protocol.PublicKeysResponse{Keys: []jose.JSONWebKey{serverSignerJWK}, KeyVersion: 3}
	ringRaw, _ := json.Marshal(ring)
	intakePrivate, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	intakeJWK, _ := cryptokit.PublicJWK(&intakePrivate.PublicKey, "server-intake-3", "enc", "ECDH-ES+A256KW")
	intakeRaw, _ := json.Marshal(intakeJWK)
	loginBinding, _ := model.LoginBinding("usuario")
	leaseClaims := model.LeaseClaims{
		Issuer: "clarin-offline-v3", Audience: "clarin-offline-unlock", IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(48 * time.Hour).Unix(),
		JWTID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Version: model.ProtocolVersion, Tuple: tuple,
		Epochs:          model.Epochs{Credential: 1, Authority: 1, Installation: 1, Principal: 1, Browser: 1, Authorization: 1, Grant: 1, Selection: 1},
		SelectionDigest: selectionDigest, LoginBindingSHA256: loginBinding, Actions: actions, MaxStorageBytes: 32 << 20,
		BrowserKeyThumbprint: profile.DPoPThumbprint, GrantSigningKeyThumbprint: grantSigningThumb, GrantEncryptionKeyThumbprint: grantEncryptionThumb,
	}
	leaseRaw, _ := json.Marshal(leaseClaims)
	lease, err := cryptokit.SignCompact(leaseRaw, serverSigner, serverSignerJWK.KeyID, protocol.LeaseType)
	if err != nil {
		t.Fatal(err)
	}
	grant := catalog.Grant{Tuple: tuple, State: "available", Actions: actions, QuotaBytes: 32 << 20, DisplayUser: "Usuario", DisplayAccount: "Cuenta",
		Lease: lease, SignerPublicKeys: ringRaw, TransportCapability: []byte("transport-test"), GrantSigningJWK: grantSigningRaw,
		GrantEncryptionJWK: grantEncryptionRaw, ServerIntakeJWK: intakeRaw, BrowserThumbprint: profile.DPoPThumbprint,
		GrantSigningThumbprint: grantSigningThumb, GrantEncryptionThumbprint: grantEncryptionThumb, SelectionRevision: 1,
		SelectionDigest: selectionDigest, LoginBindingSHA256: loginBinding, LeaseExpiresAt: time.Unix(leaseClaims.ExpiresAt, 0).UTC()}
	if err := service.catalog.SaveGrant(ctx, grant); err != nil {
		t.Fatal(err)
	}
	if err := service.catalog.ReplaceSelections(ctx, grantID, 1, selectionDigest, []catalog.Selection{{GrantID: grantID, SelectionID: selectionID, Module: "tasks", ResourceType: "task_list", ResourceID: listID, Label: "Lista", Readiness: "preparing"}}); err != nil {
		t.Fatal(err)
	}
	store, err := service.vaultFor(&grant)
	if err != nil {
		t.Fatal(err)
	}

	closure := json.RawMessage(`{"list":{"id":"99999999-9999-4999-8999-999999999999","name":"Lista","can_create":true},"statuses":[{"id":"12121212-1212-4212-8212-121212121212","category":"not_started"}],"tasks":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","version":1,"title":"Tarea servidor","list_id":"99999999-9999-4999-8999-999999999999","status_category":"not_started","priority":"medium","can_complete":true}]}`)
	normalized, _ := json.Marshal(closure)
	digest := sha256.Sum256(normalized)
	snapshotHash := hex.EncodeToString(digest[:])
	snapshotClaims := protocol.SignedSnapshot{Issuer: "clarin-offline-v3", Audience: "clarin-offline-snapshot", IssuedAt: now.Unix(), JWTID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", Version: 3, Kind: "snapshot", Tuple: tuple,
		SelectionID: selectionID, Module: "tasks", ResourceType: "task_list", ResourceID: listID, SelectionRevision: 1, HeadVersion: 1, ContentHash: snapshotHash, Payload: closure}
	snapshotRaw, _ := json.Marshal(snapshotClaims)
	snapshotJWS, _ := cryptokit.SignCompact(snapshotRaw, serverSigner, serverSignerJWK.KeyID, protocol.SnapshotJWSType)
	snapshotJWE := encryptNestedForTest(t, []byte(snapshotJWS), &secrets.EncryptionKey.PublicKey, grantEncryptionJWK.KeyID, protocol.SnapshotJWEType, protocol.SnapshotJWSType)
	if _, err := store.StoreInbox(ctx, vault.InboxEnvelope{EnvelopeID: selectionID + ":1", Kind: "snapshot", Envelope: snapshotJWE, ClaimedHash: snapshotHash, ReceivedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := service.processUnlockedInbox(ctx, &grant, secrets); err != nil {
		t.Fatal(err)
	}
	selection, _ := service.catalog.Selection(ctx, grantID, selectionID)
	if selection == nil || selection.Readiness != "available" || selection.HeadVersion != 1 {
		t.Fatalf("snapshot did not make selection available: %#v", selection)
	}
	if err := service.catalog.ActivateBrowserProfile(ctx, profile.ID, "signed-service-descriptor", ringRaw); err != nil {
		t.Fatal(err)
	}
	profile, err = service.catalog.BrowserProfile(ctx, profile.ID)
	if err != nil {
		t.Fatal(err)
	}

	issued, err := service.sessions.Open(profile.ID, tuple, actions, leaseClaims, profile.Epoch, cloneGrantSecrets(t, secrets))
	if err != nil {
		t.Fatal(err)
	}
	renewedClaims := leaseClaims
	renewedClaims.JWTID = "cccccccc-cccc-4ccc-8ccc-cccccccccccd"
	renewedClaims.ExpiresAt = now.Add(60 * time.Hour).Unix()
	renewedRaw, _ := json.Marshal(renewedClaims)
	renewedLease, _ := cryptokit.SignCompact(renewedRaw, serverSigner, serverSignerJWK.KeyID, protocol.LeaseType)
	if err := service.applyBackgroundLease(ctx, &grant, renewedLease, time.Unix(renewedClaims.ExpiresAt, 0).UTC()); err != nil {
		t.Fatalf("fully bound background lease renewal failed: %v", err)
	}
	access, err := service.sessions.Acquire(issued.Capability, profile.ID, issued.ProfileEpoch)
	if err != nil {
		t.Fatal(err)
	}
	if access.Lease.ExpiresAt != renewedClaims.ExpiresAt {
		access.Release()
		t.Fatal("live RAM session did not receive validated background lease")
	}
	access.Release()
	// A correctly signed but shorter lease is still an authority downgrade and
	// cannot replace the durable or RAM lease.
	if err := service.applyBackgroundLease(ctx, &grant, lease, time.Unix(leaseClaims.ExpiresAt, 0).UTC()); err == nil {
		t.Fatal("background lease expiry downgrade was accepted")
	}
	access, err = service.sessions.Acquire(issued.Capability, profile.ID, issued.ProfileEpoch)
	if err != nil {
		t.Fatal(err)
	}
	page, err := service.TaskPageForSelection(ctx, access, selectionID, "", 50)
	if err != nil || len(page.Items) != 1 || !bytes.Contains(page.Items[0], []byte("Tarea servidor")) {
		t.Fatalf("snapshot projection unavailable: %#v %v", page, err)
	}
	queued, err := service.CompleteTask(ctx, access, taskID, TaskCompleteInput{OperationID: operationID, SelectionID: selectionID, BaseVersion: 1, ClientOccurredAt: now})
	access.Release()
	if err != nil || queued.PendingCount != 1 || !bytes.Contains(queued.LocalTask, []byte(`"local_confirmation":"pending"`)) {
		t.Fatalf("complete was not queued from snapshot: %#v %v", queued, err)
	}
	pending, err := store.PendingEnvelopes(ctx, now, 10)
	if err != nil || len(pending) != 1 {
		t.Fatalf("durable outbox mismatch: %#v %v", pending, err)
	}
	canonicalTask := json.RawMessage(`{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","version":2,"title":"Tarea servidor","list_id":"99999999-9999-4999-8999-999999999999","status_category":"done","priority":"medium","can_complete":false}`)
	result := json.RawMessage(`{"task":` + string(canonicalTask) + `}`)
	receiptClaims := protocol.SignedReceipt{Issuer: "clarin-offline-v3", Audience: "clarin-offline-receipt", IssuedAt: now.Unix(), JWTID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", Version: 3, Kind: "receipt", Tuple: tuple,
		OperationID: operationID, RequestHash: pending[0].ContentHash, Status: "applied", ResourceID: taskID, ServerVersion: 2, Result: result}
	receiptRaw, _ := json.Marshal(receiptClaims)
	receiptJWS, _ := cryptokit.SignCompact(receiptRaw, serverSigner, serverSignerJWK.KeyID, protocol.ReceiptJWSType)
	receiptJWE := encryptNestedForTest(t, []byte(receiptJWS), &secrets.EncryptionKey.PublicKey, grantEncryptionJWK.KeyID, protocol.ReceiptJWEType, protocol.ReceiptJWSType)
	if err := service.StoreSyncResponse(ctx, grantID, SyncResponse{State: "synchronized", Receipts: []SealedServerEnvelope{{EnvelopeID: operationID, Kind: "receipt", CompactJWE: receiptJWE, ContentHash: pending[0].ContentHash}}, ServerTime: now}); err != nil {
		t.Fatal(err)
	}
	if _, pendingCount, inboxCount, err := store.Counts(ctx); err != nil || pendingCount != 0 || inboxCount != 0 {
		t.Fatalf("receipt did not commit atomically enough: pending=%d inbox=%d err=%v", pendingCount, inboxCount, err)
	}
	access, err = service.sessions.Acquire(issued.Capability, profile.ID, issued.ProfileEpoch)
	if err != nil {
		t.Fatal(err)
	}
	page, err = service.TaskPageForSelection(ctx, access, selectionID, "", 50)
	access.Release()
	if err != nil || len(page.Items) != 1 || !bytes.Contains(page.Items[0], []byte(`"version":2`)) || bytes.Contains(page.Items[0], []byte("local_confirmation")) {
		t.Fatalf("canonical receipt did not replace optimistic projection: %#v %v", page, err)
	}

	// A delayed receipt for an older command is valid evidence, but it must not
	// downgrade a newer canonical resource already committed locally.
	oldOperationID := "f0000000-0000-4000-8000-000000000001"
	if _, err := store.EnqueueSealed(ctx, oldOperationID, 900, "historical-operation-envelope"); err != nil {
		t.Fatal(err)
	}
	oldHashRaw := sha256.Sum256([]byte("historical-operation-envelope"))
	oldHash := hex.EncodeToString(oldHashRaw[:])
	oldCanonical := json.RawMessage(`{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","version":1,"title":"Tarea servidor antigua","list_id":"99999999-9999-4999-8999-999999999999","status_category":"not_started","priority":"low","can_complete":true}`)
	oldResult := json.RawMessage(`{"task":` + string(oldCanonical) + `}`)
	oldReceipt := protocol.SignedReceipt{Issuer: "clarin-offline-v3", Audience: "clarin-offline-receipt", IssuedAt: now.Unix(), JWTID: "f0000000-0000-4000-8000-000000000002", Version: 3, Kind: "receipt", Tuple: tuple,
		OperationID: oldOperationID, RequestHash: oldHash, Status: "applied", ResourceID: taskID, ServerVersion: 1, Result: oldResult}
	oldReceiptRaw, _ := json.Marshal(oldReceipt)
	oldReceiptJWS, _ := cryptokit.SignCompact(oldReceiptRaw, serverSigner, serverSignerJWK.KeyID, protocol.ReceiptJWSType)
	oldReceiptJWE := encryptNestedForTest(t, []byte(oldReceiptJWS), &secrets.EncryptionKey.PublicKey, grantEncryptionJWK.KeyID, protocol.ReceiptJWEType, protocol.ReceiptJWSType)
	if err := service.StoreSyncResponse(ctx, grantID, SyncResponse{State: "synchronized", Receipts: []SealedServerEnvelope{{EnvelopeID: oldOperationID, Kind: "receipt", CompactJWE: oldReceiptJWE, ContentHash: oldHash}}, ServerTime: now}); err != nil {
		t.Fatal(err)
	}
	access, err = service.sessions.Acquire(issued.Capability, profile.ID, issued.ProfileEpoch)
	if err != nil {
		t.Fatal(err)
	}
	page, err = service.TaskPageForSelection(ctx, access, selectionID, "", 50)
	access.Release()
	if err != nil || len(page.Items) != 1 || !bytes.Contains(page.Items[0], []byte(`"version":2`)) || bytes.Contains(page.Items[0], []byte("antigua")) {
		t.Fatalf("older receipt downgraded canonical task: %#v %v", page, err)
	}

	// An HTTP request may already hold a session reference when selection
	// suspension begins. Once suspension returns success, that stale request
	// must still lose the grant-scoped race at the durable enqueue boundary.
	staleAccess, err := service.sessions.Acquire(issued.Capability, profile.ID, issued.ProfileEpoch)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SuspendGrant(ctx, profile.ID, grantID, "selection_changed"); err != nil {
		staleAccess.Release()
		t.Fatalf("clean grant did not suspend: %v", err)
	}
	racingOperationID := "f0000000-0000-4000-8000-000000000010"
	racingTaskID := "f0000000-0000-4000-8000-000000000011"
	if _, err := service.CreateTask(ctx, staleAccess, TaskCreateInput{OperationID: racingOperationID, SelectionID: selectionID, TaskID: racingTaskID, ClientOccurredAt: now, Patch: model.TaskCreatePayload{Title: "No debe cruzar suspensión", Priority: "medium"}}); !errors.Is(err, ErrGrantLocked) {
		staleAccess.Release()
		t.Fatalf("pre-acquired request committed after suspension: %v", err)
	}
	staleAccess.Release()
	if _, pendingAfterRace, _, countErr := store.Counts(ctx); countErr != nil || pendingAfterRace != 0 {
		t.Fatalf("suspension race wrote to durable outbox: pending=%d err=%v", pendingAfterRace, countErr)
	}
	// Test-only restoration represents the signed lease activation performed by
	// the real renewal flow; the remainder exercises later receipt/control paths.
	if err := service.catalog.SetGrantState(ctx, grantID, "available"); err != nil {
		t.Fatal(err)
	}
	profile, err = service.catalog.BrowserProfile(ctx, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	issued, err = service.sessions.Open(profile.ID, tuple, actions, renewedClaims, profile.Epoch, cloneGrantSecrets(t, secrets))
	if err != nil {
		t.Fatal(err)
	}

	// A task created and then completed before either command reaches the
	// backend is represented as an ordered dependency derived exclusively from
	// the encrypted local create marker. The browser cannot supply the parent
	// operation ID and the internal marker is never exposed in its DTO.
	createOperationID := "f1000000-0000-4000-8000-000000000001"
	completeOperationID := "f1000000-0000-4000-8000-000000000002"
	createdTaskID := "f1000000-0000-4000-8000-000000000003"
	access, err = service.sessions.Acquire(issued.Capability, profile.ID, issued.ProfileEpoch)
	if err != nil {
		t.Fatal(err)
	}
	created, err := service.CreateTask(ctx, access, TaskCreateInput{OperationID: createOperationID, SelectionID: selectionID, TaskID: createdTaskID, ClientOccurredAt: now, Patch: model.TaskCreatePayload{Title: "Crear y completar sin red", Priority: "high"}})
	if err != nil || !bytes.Contains(created.LocalTask, []byte(`"can_complete":true`)) || bytes.Contains(created.LocalTask, []byte("local_create_operation_id")) {
		access.Release()
		t.Fatalf("offline create dependency metadata leaked or permission missing: %#v %v", created, err)
	}
	retried, err := service.CreateTask(ctx, access, TaskCreateInput{OperationID: createOperationID, SelectionID: selectionID, TaskID: createdTaskID, ClientOccurredAt: now, Patch: model.TaskCreatePayload{Title: "Crear y completar sin red", Priority: "high"}})
	if err != nil || retried.PendingCount != 1 || retried.OperationID != createOperationID {
		access.Release()
		t.Fatalf("lost localhost response was not idempotently retried: %#v %v", retried, err)
	}
	pendingAfterRetry, err := store.PendingEnvelopes(ctx, now, 10)
	if err != nil || len(pendingAfterRetry) != 1 || pendingAfterRetry[0].OperationID != createOperationID {
		access.Release()
		t.Fatalf("retry produced a second randomized operation: %#v %v", pendingAfterRetry, err)
	}
	completed, err := service.CompleteTask(ctx, access, createdTaskID, TaskCompleteInput{OperationID: completeOperationID, SelectionID: selectionID, BaseVersion: 0, ClientOccurredAt: now})
	access.Release()
	if err != nil || completed.PendingCount != 2 || bytes.Contains(completed.LocalTask, []byte("local_create_operation_id")) || bytes.Contains(completed.LocalTask, []byte("local_complete_operation_id")) {
		t.Fatalf("dependent offline complete failed: %#v %v", completed, err)
	}
	pending, err = store.PendingEnvelopes(ctx, now, 10)
	if err != nil || len(pending) != 2 {
		t.Fatalf("dependent commands not durably ordered: %#v %v", pending, err)
	}
	foundDependency := false
	for _, envelope := range pending {
		inner, err := cryptokit.DecryptNestedCompact(envelope.Envelope, intakePrivate, intakeJWK.KeyID, "clarin-offline-operation+jwe", "clarin-offline-operation+jws")
		if err != nil {
			t.Fatal(err)
		}
		payload, err := cryptokit.VerifyCompact(string(inner), &secrets.SigningKey.PublicKey, grantSigningJWK.KeyID, OperationJWSType)
		if err != nil {
			t.Fatal(err)
		}
		var operation model.OfflineOperation
		if json.Unmarshal(payload, &operation) != nil {
			t.Fatal("signed operation payload corrupt")
		}
		if operation.OperationID == completeOperationID {
			foundDependency = operation.DependsOnOperationID == createOperationID && operation.BaseVersion == 0 && operation.ResourceID == createdTaskID
		}
	}
	if !foundDependency {
		t.Fatal("complete operation did not derive its pending create dependency")
	}
	pendingByID := make(map[string]vault.PendingEnvelope, len(pending))
	for _, envelope := range pending {
		pendingByID[envelope.OperationID] = envelope
	}
	createPending := pendingByID[createOperationID]
	createCanonical := json.RawMessage(`{"id":"` + createdTaskID + `","version":1,"title":"Crear y completar sin red","list_id":"` + listID + `","status_category":"not_started","priority":"high","can_complete":true}`)
	createResult := json.RawMessage(`{"task":` + string(createCanonical) + `}`)
	createReceipt := protocol.SignedReceipt{Issuer: "clarin-offline-v3", Audience: "clarin-offline-receipt", IssuedAt: now.Unix(), JWTID: "f1000000-0000-4000-8000-000000000004", Version: 3, Kind: "receipt", Tuple: tuple,
		OperationID: createOperationID, RequestHash: createPending.ContentHash, Status: "applied", ResourceID: createdTaskID, ServerVersion: 1, Result: createResult}
	createReceiptRaw, _ := json.Marshal(createReceipt)
	createReceiptJWS, _ := cryptokit.SignCompact(createReceiptRaw, serverSigner, serverSignerJWK.KeyID, protocol.ReceiptJWSType)
	createReceiptJWE := encryptNestedForTest(t, []byte(createReceiptJWS), &secrets.EncryptionKey.PublicKey, grantEncryptionJWK.KeyID, protocol.ReceiptJWEType, protocol.ReceiptJWSType)
	if err := service.StoreSyncResponse(ctx, grantID, SyncResponse{State: "synchronized", Receipts: []SealedServerEnvelope{{EnvelopeID: createOperationID, Kind: "receipt", CompactJWE: createReceiptJWE, ContentHash: createPending.ContentHash}}, ServerTime: now}); err != nil {
		t.Fatal(err)
	}
	access, err = service.sessions.Acquire(issued.Capability, profile.ID, issued.ProfileEpoch)
	if err != nil {
		t.Fatal(err)
	}
	createdPage, err := service.TaskPageForSelection(ctx, access, selectionID, "", 50)
	access.Release()
	if err != nil || len(createdPage.Items) != 2 || !bytes.Contains(createdPage.Items[1], []byte(`"version":1`)) || !bytes.Contains(createdPage.Items[1], []byte(`"status_category":"done"`)) || !bytes.Contains(createdPage.Items[1], []byte(`"local_confirmation":"pending"`)) {
		t.Fatalf("create receipt erased dependent complete overlay: %#v %v", createdPage, err)
	}
	pending, err = store.PendingEnvelopes(ctx, now, 10)
	if err != nil || len(pending) != 1 || pending[0].OperationID != completeOperationID {
		t.Fatalf("create receipt did not leave only dependent completion: %#v %v", pending, err)
	}
	completeCanonical := json.RawMessage(`{"id":"` + createdTaskID + `","version":2,"title":"Crear y completar sin red","list_id":"` + listID + `","status_category":"done","priority":"high","can_complete":false}`)
	completeResult := json.RawMessage(`{"task":` + string(completeCanonical) + `}`)
	completeReceipt := protocol.SignedReceipt{Issuer: "clarin-offline-v3", Audience: "clarin-offline-receipt", IssuedAt: now.Unix(), JWTID: "f1000000-0000-4000-8000-000000000005", Version: 3, Kind: "receipt", Tuple: tuple,
		OperationID: completeOperationID, RequestHash: pending[0].ContentHash, Status: "applied", ResourceID: createdTaskID, ServerVersion: 2, Result: completeResult}
	completeReceiptRaw, _ := json.Marshal(completeReceipt)
	completeReceiptJWS, _ := cryptokit.SignCompact(completeReceiptRaw, serverSigner, serverSignerJWK.KeyID, protocol.ReceiptJWSType)
	completeReceiptJWE := encryptNestedForTest(t, []byte(completeReceiptJWS), &secrets.EncryptionKey.PublicKey, grantEncryptionJWK.KeyID, protocol.ReceiptJWEType, protocol.ReceiptJWSType)
	if err := service.StoreSyncResponse(ctx, grantID, SyncResponse{State: "synchronized", Receipts: []SealedServerEnvelope{{EnvelopeID: completeOperationID, Kind: "receipt", CompactJWE: completeReceiptJWE, ContentHash: pending[0].ContentHash}}, ServerTime: now}); err != nil {
		t.Fatal(err)
	}
	access, err = service.sessions.Acquire(issued.Capability, profile.ID, issued.ProfileEpoch)
	if err != nil {
		t.Fatal(err)
	}
	createdPage, err = service.TaskPageForSelection(ctx, access, selectionID, "", 50)
	if err != nil || len(createdPage.Items) != 2 || !bytes.Contains(createdPage.Items[1], []byte(`"version":2`)) || bytes.Contains(createdPage.Items[1], []byte("local_confirmation")) {
		access.Release()
		t.Fatalf("dependent completion did not reconcile canonically: %#v %v", createdPage, err)
	}

	// Leave one command pending so suspension can prove it preserves the WAL.
	keptOperationID := "f2000000-0000-4000-8000-000000000001"
	keptTaskID := "f2000000-0000-4000-8000-000000000002"
	if _, err := service.CreateTask(ctx, access, TaskCreateInput{OperationID: keptOperationID, SelectionID: selectionID, TaskID: keptTaskID, ClientOccurredAt: now, Patch: model.TaskCreatePayload{Title: "Debe sobrevivir suspensión", Priority: "medium"}}); err != nil {
		access.Release()
		t.Fatal(err)
	}
	access.Release()

	// A server-side selection change must fail closed without discarding the
	// two durable operations. It must also not advertise a blocked HTTP
	// exchange as a successful data reconciliation.
	if _, err := service.SuspendGrant(ctx, profile.ID, grantID, "selection_changed"); !errors.Is(err, ErrPendingOperations) {
		t.Fatalf("user selection suspension did not block a durable WAL: %v", err)
	}
	stillAvailable, err := service.catalog.Grant(ctx, grantID)
	_, pendingBeforeForcedSuspend, _, countErr := store.Counts(ctx)
	if err != nil || countErr != nil || stillAvailable.State != "available" || pendingBeforeForcedSuspend != 1 {
		t.Fatalf("blocked user suspension changed authority or WAL: grant=%#v pending=%d errors=%v/%v", stillAvailable, pendingBeforeForcedSuspend, err, countErr)
	}
	if stale, err := service.sessions.Acquire(issued.Capability, profile.ID, issued.ProfileEpoch); err == nil {
		stale.Release()
		t.Fatal("blocked selection suspension left decrypted session capability alive")
	}
	later := now.Add(time.Hour)
	service.now = func() time.Time { return later }
	if err := service.StoreSyncResponse(ctx, grantID, SyncResponse{State: "selection_changed", ServerTime: later}); err != nil {
		t.Fatal(err)
	}
	suspended, err := service.catalog.Grant(ctx, grantID)
	if err != nil || suspended.State != "expired" || !suspended.LastSyncAt.Equal(now) {
		t.Fatalf("selection change did not suspend without false success: %#v %v", suspended, err)
	}
	_, pendingCount, _, err := store.Counts(ctx)
	if err != nil || pendingCount != 1 {
		t.Fatalf("suspension discarded durable operations: pending=%d err=%v", pendingCount, err)
	}
	if access, err := service.sessions.Acquire(issued.Capability, profile.ID, issued.ProfileEpoch); err == nil {
		access.Release()
		t.Fatal("stale capability survived selection suspension")
	}
	profileAfter, err := service.catalog.BrowserProfile(ctx, profile.ID)
	if err != nil {
		t.Fatal(err)
	}
	epoch, err := service.SuspendGrant(ctx, profile.ID, grantID, "selection_changed")
	if err != nil || epoch != profileAfter.Epoch {
		t.Fatalf("repeated suspension was not idempotent: epoch=%d profile=%d err=%v", epoch, profileAfter.Epoch, err)
	}
	selectionControlID := "f2000000-0000-4000-8000-000000000003"
	selectionControlClaims := protocol.ControlClaims{Issuer: "clarin-offline-v3", Audience: "clarin-offline-control", IssuedAt: later.Unix(), NotBefore: later.Unix(), ExpiresAt: later.Add(72 * time.Hour).Unix(), JWTID: selectionControlID, Version: 3,
		InstallationID: tuple.InstallationID, Scope: "selection", ScopeID: selectionID, Revision: 1, Action: "wipe", Reason: "selection_removed"}
	selectionControlRaw, _ := json.Marshal(selectionControlClaims)
	selectionControl, _ := cryptokit.SignCompact(selectionControlRaw, serverSigner, serverSignerJWK.KeyID, protocol.ControlType)
	if err := service.StoreSyncResponse(ctx, grantID, SyncResponse{State: "controls_only", Controls: []string{selectionControl}, ServerTime: later}); err != nil {
		t.Fatal(err)
	}
	selectionWipedGrant, err := service.catalog.Grant(ctx, grantID)
	if err != nil || selectionWipedGrant.State != "expired" ||
		selectionWipedGrant.DisplayUser != "Usuario" || selectionWipedGrant.DisplayAccount != "Cuenta" ||
		len(selectionWipedGrant.TransportCapability) == 0 || len(selectionWipedGrant.SignerPublicKeys) == 0 ||
		len(selectionWipedGrant.GrantSigningJWK) == 0 {
		t.Fatalf("selection wipe incorrectly revoked the whole grant: %#v %v", selectionWipedGrant, err)
	}
	if _, err := service.catalog.Selection(ctx, grantID, selectionID); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("removed selection remained in catalog: %v", err)
	}
	_, pendingCount, _, err = store.Counts(ctx)
	selectionAcks, ackErr := store.PendingControlAcknowledgements(ctx, 10)
	if err != nil || ackErr != nil || pendingCount != 1 || len(selectionAcks) != 1 || selectionAcks[0] != selectionControlID {
		t.Fatalf("selection wipe lost WAL or ACK: pending=%d acks=%#v errors=%v/%v", pendingCount, selectionAcks, err, ackErr)
	}
	if err := service.ConfirmSyncRequest(ctx, grantID, selectionAcks); err != nil {
		t.Fatal(err)
	}

	// A signed grant wipe must crypto-erase the wrapped DEK/private keys and
	// user data, retaining only enough sealed transport state to ACK once.
	controlID := "f3000000-0000-4000-8000-000000000001"
	controlClaims := protocol.ControlClaims{Issuer: "clarin-offline-v3", Audience: "clarin-offline-control", IssuedAt: later.Unix(), NotBefore: later.Unix(), ExpiresAt: later.Add(72 * time.Hour).Unix(), JWTID: controlID, Version: 3,
		InstallationID: tuple.InstallationID, Scope: "grant", ScopeID: grantID, Revision: 1, Action: "wipe", Reason: "admin_revoked"}
	controlRaw, _ := json.Marshal(controlClaims)
	control, _ := cryptokit.SignCompact(controlRaw, serverSigner, serverSignerJWK.KeyID, protocol.ControlType)
	if err := service.StoreSyncResponse(ctx, grantID, SyncResponse{State: "controls_only", Controls: []string{control}, ServerTime: later}); err != nil {
		t.Fatal(err)
	}
	wiped, err := service.catalog.Grant(ctx, grantID)
	if err != nil || wiped.State != "revoked" || len(wiped.WrappedSecrets) != 0 || len(wiped.TransportCapability) == 0 || wiped.DisplayUser != "" || wiped.DisplayAccount != "" {
		t.Fatalf("signed wipe did not erase grant secrets before ACK: %#v %v", wiped, err)
	}
	_, pendingCount, _, err = store.Counts(ctx)
	acks, ackErr := store.PendingControlAcknowledgements(ctx, 10)
	if err != nil || ackErr != nil || pendingCount != 0 || len(acks) != 1 || acks[0] != controlID {
		t.Fatalf("wipe did not clear WAL or preserve exact ACK: pending=%d acks=%#v errors=%v/%v", pendingCount, acks, err, ackErr)
	}
	if err := service.ConfirmSyncRequest(ctx, grantID, acks); err != nil {
		t.Fatal(err)
	}
	wiped, err = service.catalog.Grant(ctx, grantID)
	if err != nil || len(wiped.TransportCapability) != 0 || len(wiped.SignerPublicKeys) != 0 {
		t.Fatalf("accepted wipe ACK left reusable transport authority: %#v %v", wiped, err)
	}
}

func cloneGrantSecrets(t *testing.T, source *cryptokit.GrantSecrets) *cryptokit.GrantSecrets {
	t.Helper()
	signingRaw, err := x509.MarshalECPrivateKey(source.SigningKey)
	if err != nil {
		t.Fatal(err)
	}
	signing, err := x509.ParseECPrivateKey(signingRaw)
	if err != nil {
		t.Fatal(err)
	}
	encryptionRaw, err := x509.MarshalECPrivateKey(source.EncryptionKey)
	if err != nil {
		t.Fatal(err)
	}
	encryption, err := x509.ParseECPrivateKey(encryptionRaw)
	if err != nil {
		t.Fatal(err)
	}
	return &cryptokit.GrantSecrets{DEK: append([]byte(nil), source.DEK...), SigningKey: signing, EncryptionKey: encryption}
}

func TestWhiteboardClosureAcceptsExactBackendShapeAndRejectsMissingBytes(t *testing.T) {
	assetBytes := []byte("offline-image-bytes")
	digest := sha256.Sum256(assetBytes)
	hash := hex.EncodeToString(digest[:])
	resourceID := "99999999-9999-4999-8999-999999999999"
	payload := json.RawMessage(`{"whiteboard":{"id":"` + resourceID + `","name":"Pizarra","description":"","scene":{"elements":[{"id":"shape","fileId":"asset-1","isDeleted":false}]},"scene_schema_version":"1","editor_version":"0.18.1","sequence":4,"version":7,"updated_at":"2026-09-14T00:00:00Z"},"referenced_assets":[{"file_id":"asset-1","content_hash":"` + hash + `","content_type":"image/png","data_base64":"` + base64.StdEncoding.EncodeToString(assetBytes) + `","size_bytes":19}]}`)
	count, err := validateSnapshotClosure("whiteboards", "whiteboard", resourceID, payload)
	if err != nil || count != 2 {
		t.Fatalf("exact backend whiteboard closure rejected: count=%d err=%v", count, err)
	}
	missing := json.RawMessage(`{"whiteboard":{"id":"` + resourceID + `","scene":{"elements":[{"fileId":"asset-1","isDeleted":false}]}},"referenced_assets":[]}`)
	if _, err := validateSnapshotClosure("whiteboards", "whiteboard", resourceID, missing); err == nil {
		t.Fatal("whiteboard scene was accepted without referenced asset bytes")
	}
}

func TestLocalCredentialRequiresExactLoginBinding(t *testing.T) {
	service, err := Open(t.TempDir(), "https://clarin.example", "3.0.0", engineTestProtector{key: bytes.Repeat([]byte{0x61}, 32)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close() })
	browserID := "33333333-3333-4333-8333-333333333333"
	grantID := "55555555-5555-4555-8555-555555555555"
	entry, err := service.challenges.Create("unlock", browserID, grantID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	payload := json.RawMessage(`{"v":3,"purpose":"unlock","challenge_id":"` + entry.ID + `","grant_id":"` + grantID + `","browser_profile_id":"` + browserID + `","login":"  Ricardo  ","password":"same-password"}`)
	token := encryptLocalCredentialForTest(t, payload, &service.installation.EncryptionKey.PublicKey, service.installation.EncryptionJWK.KeyID, UnlockCredentialJWEType, service.origin)
	credential, err := service.decryptCredential(token, entry)
	if err != nil {
		t.Fatal(err)
	}
	wanted, _ := model.LoginBinding("Ricardo")
	if credential.Login != "Ricardo" || credential.LoginBinding != wanted || string(credential.Password) != "same-password" {
		credential.Destroy()
		t.Fatal("credential did not preserve exact online login semantics")
	}
	credential.Destroy()

	missingLogin := json.RawMessage(`{"v":3,"purpose":"unlock","challenge_id":"` + entry.ID + `","grant_id":"` + grantID + `","browser_profile_id":"` + browserID + `","password":"same-password"}`)
	missingToken := encryptLocalCredentialForTest(t, missingLogin, &service.installation.EncryptionKey.PublicKey, service.installation.EncryptionJWK.KeyID, UnlockCredentialJWEType, service.origin)
	if _, err := service.decryptCredential(missingToken, entry); err == nil {
		t.Fatal("password-only credential was accepted")
	}
}

func encryptNestedForTest(t *testing.T, payload []byte, publicKey *ecdsa.PublicKey, keyID, typ, contentType string) string {
	t.Helper()
	options := (&jose.EncrypterOptions{}).WithType(jose.ContentType(typ)).WithContentType(jose.ContentType(contentType))
	encrypter, err := jose.NewEncrypter(jose.A256GCM, jose.Recipient{Algorithm: jose.ECDH_ES_A256KW, Key: publicKey, KeyID: keyID}, options)
	if err != nil {
		t.Fatal(err)
	}
	object, err := encrypter.Encrypt(payload)
	if err != nil {
		t.Fatal(err)
	}
	compact, err := object.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return compact
}

func encryptLocalCredentialForTest(t *testing.T, payload []byte, publicKey *ecdsa.PublicKey, keyID, typ, origin string) string {
	t.Helper()
	options := (&jose.EncrypterOptions{}).WithType(jose.ContentType(typ)).WithHeader(jose.HeaderKey("v"), model.ProtocolVersion).WithHeader(jose.HeaderKey("origin"), origin)
	encrypter, err := jose.NewEncrypter(jose.A256GCM, jose.Recipient{Algorithm: jose.ECDH_ES_A256KW, Key: publicKey, KeyID: keyID}, options)
	if err != nil {
		t.Fatal(err)
	}
	object, err := encrypter.Encrypt(payload)
	if err != nil {
		t.Fatal(err)
	}
	compact, err := object.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return compact
}
