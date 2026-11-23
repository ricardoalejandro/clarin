package utilities

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"testing"
)

func TestLegacyCleanupManifestBindsOwnerAccountAndEveryCASVersion(t *testing.T) {
	owner, account, key, document := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	original := LegacyCleanupManifest{Version: 1, OperationID: uuid.New(), OwnerID: owner, Username: "synthetic-owner", Accounts: []LegacyCleanupAccount{{AccountID: account, Entries: []LegacyCleanupEntry{{ID: key, Version: 3, ObjectKey: "fixture"}}, References: []LegacyCleanupReference{{ID: document, Version: 5, KeyID: key.String()}}, Objects: []LegacyCleanupObject{{Key: "fixture", Bytes: 80, State: "active"}}}}}
	digest := original.Digest()
	if len(digest) != 64 || digest != original.Digest() {
		t.Fatal("manifest digest is not stable")
	}
	changed := original
	changed.OwnerID = uuid.New()
	if changed.Digest() == digest {
		t.Fatal("owner not bound")
	}
	changed = original
	changed.Accounts = append([]LegacyCleanupAccount(nil), original.Accounts...)
	changed.Accounts[0].AccountID = uuid.New()
	if changed.Digest() == digest {
		t.Fatal("account not bound")
	}
	changed = original
	changed.Accounts = append([]LegacyCleanupAccount(nil), original.Accounts...)
	changed.Accounts[0].Entries = append([]LegacyCleanupEntry(nil), original.Accounts[0].Entries...)
	changed.Accounts[0].Entries[0].Version++
	if changed.Digest() == digest {
		t.Fatal("entry CAS not bound")
	}
	changed = original
	changed.Accounts = append([]LegacyCleanupAccount(nil), original.Accounts...)
	changed.Accounts[0].References = append([]LegacyCleanupReference(nil), original.Accounts[0].References...)
	changed.Accounts[0].References[0].Version++
	if changed.Digest() == digest {
		t.Fatal("document CAS not bound")
	}
}

func TestCleanupRejectsInvalidOrUnreviewedScopeBeforeDatabase(t *testing.T) {
	store := &Store{}
	if _, err := store.PrepareLegacyCleanup(context.Background(), uuid.Nil, "synthetic"); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	manifest := LegacyCleanupManifest{Version: 1, OwnerID: uuid.New(), OperationID: uuid.New(), Username: "synthetic"}
	if _, err := store.ApplyLegacyCleanupAccount(context.Background(), manifest, LegacyCleanupAccount{AccountID: uuid.New()}); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}
