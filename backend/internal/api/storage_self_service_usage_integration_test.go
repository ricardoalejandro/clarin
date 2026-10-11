package api

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/storage"
)

func runStorageUsageIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	t.Helper()
	f := newStorageQAFixture(t, db, store)
	visible, _, _ := f.media(f.account, "chats", "visible.pdf", true)
	hidden, _, _ := f.media(f.account, "uploads", "unproven.pdf", false)
	foreign, _, _ := f.media(f.other, "chats", "other-account.pdf", true)
	objectSize := func(key string) float64 {
		t.Helper()
		object, err := store.GetFileInfo(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		return float64(object.Size)
	}
	visibleBytes, hiddenBytes, otherBytes := objectSize(visible), objectSize(hidden), objectSize(foreign)
	assertUsage := func(headers map[string]string, scope string, used, visible, reserved, limit, available float64) {
		t.Helper()
		code, data := f.request("GET", "/storage/usage", nil, headers)
		if code != 200 {
			t.Fatalf("usage failed: %d %v", code, data)
		}
		percent := float64(0)
		if limit > 0 {
			percent = 100 * used / limit
		}
		for field, want := range map[string]any{
			"scope": scope, "used_bytes": used, "visible_bytes": visible,
			"managed_elsewhere_bytes": reserved, "limit_bytes": limit,
			"available_bytes": available, "percent_used": percent,
			"object_count": float64(1),
		} {
			if data[field] != want {
				t.Errorf("usage %s=%v, want %v", field, data[field], want)
			}
		}
	}
	// Even a member with Settings sees only authorized content; a partial
	// inventory must never be presented as the account's free capacity.
	assertUsage(nil, "authorized", visibleBytes, visibleBytes, 0, 0, 0)
	f.exec(`UPDATE user_accounts SET role='admin' WHERE user_id=$1 AND account_id=$2`, f.user, f.account)
	const limit = float64(1048576)
	assertUsage(nil, "account", visibleBytes+hiddenBytes, visibleBytes, hiddenBytes, limit, limit-visibleBytes-hiddenBytes)
	// Membership is refreshed independently for each selected account, even
	// though both accounts are accessible by the same identity.
	assertUsage(map[string]string{"X-QA-Account": "other"}, "authorized", otherBytes, otherBytes, 0, 0, 0)
	f.exec(`UPDATE user_accounts SET role='member' WHERE user_id=$1 AND account_id=$2`, f.user, f.account)
	assertUsage(nil, "authorized", visibleBytes, visibleBytes, 0, 0, 0)
}
