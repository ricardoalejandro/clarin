package repository

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWhiteboardGuestRevocationsAdvanceAccessRevisionInsideTransaction(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve repository source directory")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_share_repository.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	functions := []struct {
		name string
		next string
	}{
		{name: "func (r *WhiteboardRepository) RevokeShareLink(", next: "func (r *WhiteboardRepository) GetActiveShareLinkByTokenHash("},
		{name: "func (r *WhiteboardRepository) RevokeGuestSession(", next: ""},
	}
	for _, function := range functions {
		start := strings.Index(source, function.name)
		if start < 0 {
			t.Fatalf("missing %s", function.name)
		}
		end := len(source)
		if function.next != "" {
			if offset := strings.Index(source[start:], function.next); offset > 0 {
				end = start + offset
			}
		}
		body := source[start:end]
		revoke := strings.Index(body, "SET revoked_at=COALESCE(revoked_at,NOW())")
		bump := strings.Index(body, "SET access_revision=access_revision+1,updated_at=NOW()")
		commit := strings.Index(body, "return tx.Commit(ctx)")
		idempotent := strings.Index(body, "if !alreadyRevoked {")
		if revoke < 0 || idempotent < 0 || bump < 0 || commit < 0 || !(revoke < idempotent && idempotent < bump && bump < commit) {
			t.Fatalf("%s must bump the board revision once, in the same transaction as revocation", function.name)
		}
	}
}

func TestGuestFanoutResolverIsTenantBoardAndSessionScoped(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve repository source directory")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_share_repository.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	start := strings.Index(source, "func (r *WhiteboardRepository) ResolveActiveGuestSessionAccessByID(")
	end := strings.Index(source, "func (r *WhiteboardRepository) ListGuestSessions(")
	if start < 0 || end <= start {
		t.Fatal("guest fanout resolver source bounds changed")
	}
	body := source[start:end]
	for _, required := range []string{
		"session.account_id=$1", "session.board_id=$2", "session.id=$3",
		"session.revoked_at IS NULL", "session.expires_at>$4", "link.revoked_at IS NULL",
		"JOIN accounts account", "COALESCE(account.is_active,TRUE)", "whiteboardStandaloneBoardOriginSQL",
		"JOIN subscriptions account_subscription", "account_subscription.status='active'",
		"account_subscription.status='trialing'", "account_subscription.status='grace'",
	} {
		if !strings.Contains(body, required) {
			t.Fatalf("guest fanout resolver lost required scope/policy fragment %q", required)
		}
	}
}

func TestGuestSceneWriteRevalidatesTenantAfterBoardLock(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve repository source directory")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_guest_scene_repository.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	start := strings.Index(source, "func (r *WhiteboardRepository) writeSceneAsGuest(")
	if start < 0 {
		t.Fatal("guest scene mutation source boundary changed")
	}
	body := source[start:]
	firstResolve := strings.Index(body, "resolveGuestSessionWith(ctx, tx")
	boardLock := strings.Index(body, "FOR UPDATE")
	secondResolve := strings.Index(body[firstResolve+1:], "resolveGuestSessionWith(ctx, tx")
	if firstResolve < 0 || boardLock <= firstResolve || secondResolve < 0 || firstResolve+1+secondResolve <= boardLock {
		t.Fatal("guest scene write must discover authority, lock the board, then revalidate current tenant/session authority")
	}
	for _, required := range []string{
		"JOIN subscriptions account_subscription", "account_subscription.status='active'",
		"account_subscription.status='trialing'", "account_subscription.status='grace'",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("guest scene authority lost %q", required)
		}
	}
}
