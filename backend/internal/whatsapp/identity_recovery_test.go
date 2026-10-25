package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow/types"
	"testing"
	"time"
)

func TestRecoveryAgendaSeedsOnlyScopedPNAddressBookNames(t *testing.T) {
	pn := types.NewJID("51900000456", types.DefaultUserServer)
	lid := types.NewJID("700123", types.HiddenUserServer)
	candidates, facts := recoveryAgendaCandidates(map[types.JID]types.ContactInfo{pn: {FullName: "Synthetic agenda", FirstName: "Synthetic", PushName: "Global copied push", BusinessName: "Global copied business"}, lid: {FullName: "Unproven LID", PushName: "Unproven push"}, types.NewJID("51900000789", types.DefaultUserServer): {PushName: "No agenda"}})
	if len(candidates) != 1 || candidates[0] != pn.String() || len(facts) != 1 || facts[0].PN != pn.String() || facts[0].LID != "" || facts[0].ObservedAt != nil {
		t.Fatal("inventory inferred a pair or imported unsupported cache data")
	}
	if len(facts[0].Fields) != 2 || facts[0].Fields["full_name"] != "Synthetic agenda" || facts[0].Fields["push_name"] != "" || facts[0].Fields["business_name"] != "" {
		t.Fatal("non-agenda fields were imported", facts[0].Fields)
	}
}
func TestIdentityRecoveryWaitCancelsWithoutDelay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if identityRecoveryWait(ctx, time.Hour) {
		t.Fatal("cancelled worker kept its pacing wait")
	}
	if (&DevicePool{}).identityRecoveryAllowed(uuid.New(), uuid.New()) == nil {
		t.Fatal("disabled rollout allowed recovery")
	}
}

func TestIdentityRecoveryStateMachinePrioritizesPNAndResumesWithoutFullSyncReplay(t *testing.T) {
	if next := identityRecoveryInventoryNextPhase("inventory"); next != "lookup" {
		t.Fatal("AppState ran before inventory PN", next)
	}
	for _, waiting := range []bool{false, true} {
		if next := identityRecoveryLookupNextPhase("lookup", false, waiting); next != "appstate" {
			t.Fatal("initial PN attempt did not reach independent fallback", next)
		}
	}
	if next := identityRecoveryInventoryNextPhase("inventory_after_appstate"); next != "lookup_after_appstate" {
		t.Fatal("fullsync PN candidates were skipped", next)
	}
	if next := identityRecoveryLookupNextPhase("lookup_after_appstate", true, true); next != "" {
		t.Fatal("deferred PN work was declared complete", next)
	}
	if next := identityRecoveryLookupNextPhase("lookup_after_appstate", true, false); next != "projection" {
		t.Fatal("second inventory repeated fullsync", next)
	}
	if next := identityRecoveryLookupNextPhase("lookup", true, false); next != "projection" {
		t.Fatal("durable ACK replayed fullsync", next)
	}
}

func TestIdentityRecoveryFailureLabelsKeepActualCause(t *testing.T) {
	for _, tc := range []struct {
		name           string
		err            error
		fallback, want string
	}{
		{"checkpoint", errors.New("synthetic SQL transport failure"), "persistence_unavailable", "persistence_unavailable"},
		{"provider", errors.New("synthetic provider failure"), "provider_unavailable", "provider_unavailable"},
		{"appstate", errors.New("synthetic sync failure"), "appstate_unavailable", "appstate_unavailable"},
		{"database inside appstate", &pgconn.PgError{Code: "08006"}, "appstate_unavailable", "persistence_unavailable"},
		{"typed persistence", withIdentityRecoveryFailureCode("persistence_unavailable", errors.New("synthetic storage failure")), "appstate_unavailable", "persistence_unavailable"},
		{"wrapped session", fmt.Errorf("late: %w", repository.ErrWhatsAppIdentitySessionChanged), "persistence_unavailable", "session_changed"},
		{"receive disabled", errIdentityRecoveryReceiveDisabled, "provider_unavailable", "receive_disabled"},
		{"rollout disabled", errIdentityRecoveryGroupsDisabled, "persistence_unavailable", "groups_disabled"},
		{"cancelled", context.Canceled, "persistence_unavailable", "cancelled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := identityRecoveryFailureCode(tc.err, tc.fallback); got != tc.want {
				t.Fatal(got, tc.want)
			}
		})
	}
	if withIdentityRecoveryFailureCode("persistence_unavailable", nil) != nil {
		t.Fatal("successful operation became an error")
	}
}
