package vault

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

func vaultTuple(grantID, accountID string) model.Tuple {
	return model.Tuple{
		InstallationID:     "11111111-1111-4111-8111-111111111111",
		WindowsPrincipalID: "22222222-2222-4222-8222-222222222222",
		BrowserProfileID:   "33333333-3333-4333-8333-333333333333",
		AuthorizationID:    "44444444-4444-4444-8444-444444444444",
		GrantID:            grantID,
		UserID:             "66666666-6666-4666-8666-666666666666",
		AccountID:          accountID,
	}
}

func openTestVault(t *testing.T, tuple model.Tuple) *Store {
	t.Helper()
	store, err := Open(t.TempDir(), tuple, 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestVaultEncryptsPayloadAndRejectsWrongGrantKey(t *testing.T) {
	ctx := context.Background()
	store := openTestVault(t, vaultTuple("55555555-5555-4555-8555-555555555555", "77777777-7777-4777-8777-777777777777"))
	key := bytes.Repeat([]byte{0x11}, 32)
	payload := json.RawMessage(`{"id":"99999999-9999-4999-8999-999999999999","title":"dato-super-secreto-123"}`)
	err := store.PutResource(ctx, key, Resource{SelectionID: "88888888-8888-4888-8888-888888888888", Module: "tasks", ResourceType: "task_list", ResourceID: "99999999-9999-4999-8999-999999999999", Revision: 2, Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	items, next, err := store.ListResources(ctx, key, "tasks", "", 50)
	if err != nil || next != "" || len(items) != 1 || !bytes.Equal(items[0].Payload, payload) {
		t.Fatalf("resource roundtrip failed: items=%d next=%q err=%v", len(items), next, err)
	}
	if _, _, err := store.ListResources(ctx, bytes.Repeat([]byte{0x22}, 32), "tasks", "", 50); err == nil {
		t.Fatal("vault opened resource with another grant key")
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		raw, readErr := os.ReadFile(store.Path() + suffix)
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			t.Fatal(readErr)
		}
		if bytes.Contains(raw, []byte("dato-super-secreto-123")) {
			t.Fatalf("plaintext leaked into SQLite file %s", filepath.Base(store.Path()+suffix))
		}
	}
}

func TestVaultTupleCannotBeReassigned(t *testing.T) {
	root := t.TempDir()
	first := vaultTuple("55555555-5555-4555-8555-555555555555", "77777777-7777-4777-8777-777777777777")
	store, err := Open(root, first, 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	_ = store.Close()
	other := first
	other.AccountID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	if _, err := Open(root, other, 32<<20); !errors.Is(err, ErrGrantMismatch) {
		t.Fatalf("vault tuple reassignment not rejected: %v", err)
	}
}

func TestOutboxIsDurableIdempotentAndReceiptRemovesIt(t *testing.T) {
	ctx := context.Background()
	store := openTestVault(t, vaultTuple("55555555-5555-4555-8555-555555555555", "77777777-7777-4777-8777-777777777777"))
	operationID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	duplicate, err := store.EnqueueSealed(ctx, operationID, 1, "sealed-operation-a")
	if err != nil || duplicate {
		t.Fatalf("first enqueue failed: duplicate=%v err=%v", duplicate, err)
	}
	duplicate, err = store.EnqueueSealed(ctx, operationID, 1, "sealed-operation-a")
	if err != nil || !duplicate {
		t.Fatalf("idempotent enqueue failed: duplicate=%v err=%v", duplicate, err)
	}
	if _, err := store.EnqueueSealed(ctx, operationID, 1, "sealed-operation-b"); !errors.Is(err, ErrOperationIDReuse) {
		t.Fatalf("operation id reuse not rejected: %v", err)
	}
	pending, err := store.PendingEnvelopes(ctx, time.Now().UTC(), 100)
	if err != nil || len(pending) != 1 || pending[0].Sequence != 1 {
		t.Fatalf("pending envelope mismatch: %#v %v", pending, err)
	}
	digest := sha256.Sum256([]byte("sealed-operation-a"))
	if err := store.CommitReceipt(ctx, operationID, "sealed-receipt", hex.EncodeToString(digest[:])); err != nil {
		t.Fatal(err)
	}
	pending, err = store.PendingEnvelopes(ctx, time.Now().UTC(), 100)
	if err != nil || len(pending) != 0 {
		t.Fatalf("receipt did not remove outbox: %#v %v", pending, err)
	}
}

func TestInboxDeduplicatesRandomizedEnvelopeBySemanticBinding(t *testing.T) {
	ctx := context.Background()
	store := openTestVault(t, vaultTuple("55555555-5555-4555-8555-555555555555", "77777777-7777-4777-8777-777777777777"))
	selectionID := "88888888-8888-4888-8888-888888888888"
	claimed := strings.Repeat("a", 64)
	duplicate, err := store.StoreInbox(ctx, InboxEnvelope{EnvelopeID: selectionID + ":1", Kind: "snapshot", Envelope: "randomized-jwe-first", ClaimedHash: claimed})
	if err != nil || duplicate {
		t.Fatalf("first semantic envelope failed: duplicate=%v err=%v", duplicate, err)
	}
	duplicate, err = store.StoreInbox(ctx, InboxEnvelope{EnvelopeID: selectionID + ":1", Kind: "snapshot", Envelope: "randomized-jwe-retry", ClaimedHash: claimed})
	if err != nil || !duplicate {
		t.Fatalf("randomized retry was not deduplicated: duplicate=%v err=%v", duplicate, err)
	}
	items, err := store.Inbox(ctx, 10)
	if err != nil || len(items) != 1 || items[0].Envelope != "randomized-jwe-retry" {
		t.Fatalf("pending retry did not replace unusable transport bytes: %#v %v", items, err)
	}
	if _, err := store.StoreInbox(ctx, InboxEnvelope{EnvelopeID: selectionID + ":1", Kind: "snapshot", Envelope: "different-semantic", ClaimedHash: strings.Repeat("b", 64)}); !errors.Is(err, ErrEnvelopeIDReuse) {
		t.Fatalf("semantic envelope ID reuse was not rejected: %v", err)
	}
	if err := store.MarkInboxProcessed(ctx, selectionID+":1", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if duplicate, err := store.StoreInbox(ctx, InboxEnvelope{EnvelopeID: selectionID + ":1", Kind: "snapshot", Envelope: "late-randomized-retry", ClaimedHash: claimed}); err != nil || !duplicate {
		t.Fatalf("processed semantic retry was not ignored: %v %v", duplicate, err)
	}
}

func TestWipeGrantDataPreservesOnlyControlAcknowledgement(t *testing.T) {
	ctx := context.Background()
	store := openTestVault(t, vaultTuple("55555555-5555-4555-8555-555555555555", "77777777-7777-4777-8777-777777777777"))
	key := bytes.Repeat([]byte{0x25}, 32)
	selectionID := "88888888-8888-4888-8888-888888888888"
	resourceID := "99999999-9999-4999-8999-999999999999"
	operationID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	controlID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	if err := store.PutResource(ctx, key, Resource{SelectionID: selectionID, Module: "contacts", ResourceType: "contact", ResourceID: resourceID, Revision: 1, Payload: json.RawMessage(`{"id":"` + resourceID + `","name":"privado"}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnqueueSealed(ctx, operationID, 1, "sealed-user-operation"); err != nil {
		t.Fatal(err)
	}
	if err := store.StoreConflict(ctx, key, ConflictRecord{OperationID: operationID, SelectionID: selectionID, ResourceID: resourceID, Status: "conflict", ClientChange: json.RawMessage(`{"title":"local"}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.StoreInbox(ctx, InboxEnvelope{EnvelopeID: controlID, Kind: "control", Envelope: "signed-wipe-control"}); err != nil {
		t.Fatal(err)
	}
	if err := store.WipeGrantData(ctx, controlID); err != nil {
		t.Fatal(err)
	}
	resources, _, err := store.ListResources(ctx, key, "contacts", "", 10)
	pending, pendingErr := store.PendingEnvelopes(ctx, time.Now().UTC(), 10)
	conflicts, conflictErr := store.ConflictCount(ctx)
	inbox, inboxErr := store.Inbox(ctx, 10)
	if err != nil || pendingErr != nil || conflictErr != nil || inboxErr != nil || len(resources) != 0 || len(pending) != 0 || conflicts != 0 || len(inbox) != 1 || inbox[0].EnvelopeID != controlID {
		t.Fatalf("wipe retained user data or lost ACK: resources=%d pending=%d conflicts=%d inbox=%#v errors=%v/%v/%v/%v", len(resources), len(pending), conflicts, inbox, err, pendingErr, conflictErr, inboxErr)
	}
	if err := store.WipeGrantData(ctx, ""); err != nil {
		t.Fatal(err)
	}
	if inbox, err := store.Inbox(ctx, 10); err != nil || len(inbox) != 0 {
		t.Fatalf("final wipe retained inbox rows: %#v %v", inbox, err)
	}
}

func TestResourcePagingIsBounded(t *testing.T) {
	ctx := context.Background()
	store := openTestVault(t, vaultTuple("55555555-5555-4555-8555-555555555555", "77777777-7777-4777-8777-777777777777"))
	key := bytes.Repeat([]byte{0x33}, 32)
	resources := []string{
		"10000000-0000-4000-8000-000000000001",
		"10000000-0000-4000-8000-000000000002",
		"10000000-0000-4000-8000-000000000003",
	}
	for _, resourceID := range resources {
		if err := store.PutResource(ctx, key, Resource{SelectionID: "88888888-8888-4888-8888-888888888888", Module: "contacts", ResourceType: "contact", ResourceID: resourceID, Revision: 1, Payload: json.RawMessage(`{"name":"cifrado"}`)}); err != nil {
			t.Fatal(err)
		}
	}
	first, cursor, err := store.ListResources(ctx, key, "contacts", "", 2)
	if err != nil || len(first) != 2 || cursor != resources[1] {
		t.Fatalf("first page mismatch: %d %q %v", len(first), cursor, err)
	}
	second, cursor, err := store.ListResources(ctx, key, "contacts", cursor, 2)
	if err != nil || len(second) != 1 || cursor != "" || second[0].ResourceID != resources[2] {
		t.Fatalf("second page mismatch: %#v %q %v", second, cursor, err)
	}
}

func TestConflictPreservesEncryptedClientChangeAndPages(t *testing.T) {
	ctx := context.Background()
	store := openTestVault(t, vaultTuple("55555555-5555-4555-8555-555555555555", "77777777-7777-4777-8777-777777777777"))
	key := bytes.Repeat([]byte{0x44}, 32)
	firstID := "10000000-0000-4000-8000-000000000001"
	secondID := "10000000-0000-4000-8000-000000000002"
	for _, operationID := range []string{firstID, secondID} {
		err := store.StoreConflict(ctx, key, ConflictRecord{
			OperationID:  operationID,
			SelectionID:  "88888888-8888-4888-8888-888888888888",
			ResourceID:   "99999999-9999-4999-8999-999999999999",
			Status:       "conflict",
			ErrorCode:    "version_conflict",
			ClientChange: json.RawMessage(`{"id":"99999999-9999-4999-8999-999999999999","title":"cambio-local-super-secreto"}`),
			ServerResult: json.RawMessage(`{"task":{"id":"99999999-9999-4999-8999-999999999999","title":"canonico"}}`),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	// An idempotent replay cannot replace the first preserved client change.
	if err := store.StoreConflict(ctx, key, ConflictRecord{OperationID: firstID, SelectionID: "88888888-8888-4888-8888-888888888888", ResourceID: "99999999-9999-4999-8999-999999999999", Status: "rejected", ClientChange: json.RawMessage(`{"title":"overwritten"}`)}); err != nil {
		t.Fatal(err)
	}
	items, cursor, err := store.Conflicts(ctx, key, "", 1)
	if err != nil || len(items) != 1 || cursor != firstID || items[0].Status != "conflict" || !bytes.Contains(items[0].ClientChange, []byte("cambio-local-super-secreto")) {
		t.Fatalf("first conflict page mismatch: %#v cursor=%q err=%v", items, cursor, err)
	}
	items, cursor, err = store.Conflicts(ctx, key, cursor, 1)
	if err != nil || len(items) != 1 || cursor != "" || items[0].OperationID != secondID {
		t.Fatalf("second conflict page mismatch: %#v cursor=%q err=%v", items, cursor, err)
	}
	if count, err := store.ConflictCount(ctx); err != nil || count != 2 {
		t.Fatalf("conflict count mismatch: %d %v", count, err)
	}
	if _, _, err := store.Conflicts(ctx, bytes.Repeat([]byte{0x55}, 32), "", 50); err == nil {
		t.Fatal("conflict opened with another grant key")
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		raw, readErr := os.ReadFile(store.Path() + suffix)
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			t.Fatal(readErr)
		}
		if bytes.Contains(raw, []byte("cambio-local-super-secreto")) {
			t.Fatalf("conflict plaintext leaked into SQLite file %s", filepath.Base(store.Path()+suffix))
		}
	}
}
