package model

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const (
	installationID  = "11111111-1111-4111-8111-111111111111"
	principalID     = "22222222-2222-4222-8222-222222222222"
	browserID       = "33333333-3333-4333-8333-333333333333"
	authorizationID = "44444444-4444-4444-8444-444444444444"
	grantID         = "55555555-5555-4555-8555-555555555555"
	userID          = "66666666-6666-4666-8666-666666666666"
	accountID       = "77777777-7777-4777-8777-777777777777"
	selectionID     = "88888888-8888-4888-8888-888888888888"
	resourceID      = "99999999-9999-4999-8999-999999999999"
)

func validTuple() Tuple {
	return Tuple{InstallationID: installationID, WindowsPrincipalID: principalID, BrowserProfileID: browserID, AuthorizationID: authorizationID, GrantID: grantID, UserID: userID, AccountID: accountID}
}

func TestLeaseClaimsValidateCompleteTupleAnd72HourBound(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	thumbprint := strings.Repeat("A", 43)
	loginBinding, _ := LoginBinding("ricardo")
	claims := LeaseClaims{
		Issuer: "clarin-offline-v3", Audience: "clarin-offline-unlock", IssuedAt: now.Unix(), NotBefore: now.Add(-time.Minute).Unix(), ExpiresAt: now.Add(72 * time.Hour).Unix(),
		JWTID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Version: ProtocolVersion, Tuple: validTuple(),
		Epochs:          Epochs{Credential: 1, Authority: 1, Installation: 1, Principal: 1, Browser: 1, Authorization: 1, Grant: 1, Selection: 1},
		SelectionDigest: strings.Repeat("0", 64), LoginBindingSHA256: loginBinding, Actions: []string{ActionTasksRead, ActionTasksCreate}, MaxStorageBytes: MaxStorageBytes,
		BrowserKeyThumbprint: thumbprint, GrantSigningKeyThumbprint: thumbprint, GrantEncryptionKeyThumbprint: thumbprint,
	}
	if err := claims.Validate(now, validTuple(), loginBinding, thumbprint, thumbprint, thumbprint); err != nil {
		t.Fatalf("valid lease rejected: %v", err)
	}
	claims.ExpiresAt++
	if err := claims.Validate(now, validTuple(), loginBinding, thumbprint, thumbprint, thumbprint); err == nil {
		t.Fatal("lease longer than 72 hours accepted")
	}
}

func TestLeaseClaimsRejectsCrossGrantSwap(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	thumbprint := strings.Repeat("B", 43)
	loginBinding, _ := LoginBinding("ricardo")
	claims := LeaseClaims{
		Issuer: "clarin-offline-v3", Audience: "clarin-offline-unlock", IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
		JWTID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Version: 3, Tuple: validTuple(),
		Epochs:          Epochs{Credential: 1, Authority: 1, Installation: 1, Principal: 1, Browser: 1, Authorization: 1, Grant: 1, Selection: 1},
		SelectionDigest: strings.Repeat("1", 64), LoginBindingSHA256: loginBinding, Actions: []string{ActionContactsRead}, MaxStorageBytes: 1024,
		BrowserKeyThumbprint: thumbprint, GrantSigningKeyThumbprint: thumbprint, GrantEncryptionKeyThumbprint: thumbprint,
	}
	other := validTuple()
	other.AccountID = "aaaaaaaa-1111-4111-8111-111111111111"
	if err := claims.Validate(now, other, loginBinding, thumbprint, thumbprint, thumbprint); err == nil {
		t.Fatal("cross-account lease accepted")
	}
	otherLogin, _ := LoginBinding("otro")
	if err := claims.Validate(now, validTuple(), otherLogin, thumbprint, thumbprint, thumbprint); err == nil {
		t.Fatal("lease accepted for another login")
	}
}

func TestLoginBindingMatchesOnlineTrimAndPreservesCase(t *testing.T) {
	plain, err := LoginBinding("  Ricardo  ")
	if err != nil {
		t.Fatal(err)
	}
	trimmed, _ := LoginBinding("Ricardo")
	lower, _ := LoginBinding("ricardo")
	if plain != trimmed || plain == lower {
		t.Fatal("login binding does not mirror exact case-sensitive online identity")
	}
}

func TestCommandAllowsOnlyFiniteTaskWrites(t *testing.T) {
	payload, _ := json.Marshal(TaskCreatePayload{Title: "Nueva tarea", Priority: "medium"})
	command := Command{OperationID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", GrantID: grantID, Action: ActionTasksCreate, SelectionID: selectionID, ResourceID: resourceID, ClientOccurredAt: time.Now().UTC(), Payload: payload}
	if err := command.Validate(validTuple(), []string{ActionTasksRead, ActionTasksCreate}); err != nil {
		t.Fatalf("valid task create rejected: %v", err)
	}
	command.Action = "contacts.update"
	if err := command.Validate(validTuple(), []string{ActionContactsRead}); err == nil {
		t.Fatal("unsupported write accepted")
	}
}

func TestCommandRejectsUnknownPatchField(t *testing.T) {
	payload := json.RawMessage(`{"title":"x","priority":"medium","account_id":"77777777-7777-4777-8777-777777777777"}`)
	command := Command{OperationID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", GrantID: grantID, Action: ActionTasksCreate, SelectionID: selectionID, ResourceID: resourceID, ClientOccurredAt: time.Now().UTC(), Payload: payload}
	if err := command.Validate(validTuple(), []string{ActionTasksRead, ActionTasksCreate}); err == nil {
		t.Fatal("authority field hidden inside patch was accepted")
	}
}

func TestCompleteVersionZeroRequiresOneCanonicalDependency(t *testing.T) {
	command := Command{OperationID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", DependsOnOperationID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", GrantID: grantID, Action: ActionTasksComplete, SelectionID: selectionID, ResourceID: resourceID, BaseVersion: 0, ClientOccurredAt: time.Now().UTC(), Payload: json.RawMessage(`{}`)}
	if err := command.Validate(validTuple(), []string{ActionTasksRead, ActionTasksComplete}); err != nil {
		t.Fatalf("dependent complete rejected: %v", err)
	}
	command.DependsOnOperationID = ""
	if err := command.Validate(validTuple(), []string{ActionTasksRead, ActionTasksComplete}); err == nil {
		t.Fatal("version-zero complete accepted without dependency")
	}
	command.DependsOnOperationID = command.OperationID
	if err := command.Validate(validTuple(), []string{ActionTasksRead, ActionTasksComplete}); err == nil {
		t.Fatal("self-dependent complete accepted")
	}
	command.BaseVersion = 1
	command.DependsOnOperationID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	if err := command.Validate(validTuple(), []string{ActionTasksRead, ActionTasksComplete}); err == nil {
		t.Fatal("positive-version complete accepted with dependency")
	}
}

func TestSelectionDigestIsOrderIndependent(t *testing.T) {
	a := Selection{SelectionID: selectionID, Module: "tasks", ResourceType: "task_list", ResourceID: resourceID, HeadVersion: 1}
	b := Selection{SelectionID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Module: "contacts", ResourceType: "contact", ResourceID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", HeadVersion: 2}
	first, err := SelectionDigest([]Selection{a, b})
	if err != nil {
		t.Fatal(err)
	}
	second, err := SelectionDigest([]Selection{b, a})
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("selection digest depends on order: %s != %s", first, second)
	}
}
