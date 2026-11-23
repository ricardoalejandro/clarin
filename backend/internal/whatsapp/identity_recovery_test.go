package whatsapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow"
	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
	"io"
	"strings"
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

func TestIdentityRecoveryLookupOutcomeOnlyConsumesProviderRetries(t *testing.T) {
	providerFailure := errors.New("synthetic provider failure")
	persistenceFailure := withIdentityRecoveryFailureCode("persistence_unavailable", io.EOF)
	for _, tc := range []struct {
		name           string
		err            error
		success, fatal bool
	}{
		{"success", nil, true, false},
		{"provider", providerFailure, false, false},
		{"provider request timeout", context.DeadlineExceeded, false, false},
		{"persistence without pgconn type", persistenceFailure, false, true},
		{"persistence SQL", &pgconn.PgError{Code: "08006"}, false, true},
		{"changed session", repository.ErrWhatsAppIdentitySessionChanged, false, true},
		{"cancelled operation", context.Canceled, false, true},
		{"groups disabled", errIdentityRecoveryGroupsDisabled, false, true},
		{"receive disabled", errIdentityRecoveryReceiveDisabled, false, true},
		{"device disconnected", ErrDeviceDisconnected, false, true},
		{"provider device disconnected", ErrGroupReportDeviceNotConnected, false, true},
		{"SDK websocket disconnected", whatsmeow.ErrNotConnected, false, true},
		{"SDK query disconnected", whatsmeow.ErrIQDisconnected, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			succeeded, err := identityRecoveryLookupOutcome(tc.err)
			if succeeded != tc.success || (err != nil) != tc.fatal {
				t.Fatalf("wrong provider retry outcome: success=%v fatal=%v", succeeded, err != nil)
			}
			if tc.fatal && !errors.Is(err, tc.err) {
				t.Fatal("non-provider error lost its original cause")
			}
		})
	}
}

func TestIdentityRecoveryLookupDiagnosticNeverSerializesProviderPayload(t *testing.T) {
	secret := "synthetic_private_payload_must_not_be_logged"
	iq := &whatsmeow.IQError{Code: 0, Text: secret, RawNode: &waBinary.Node{Tag: "user", Attrs: waBinary.Attrs{"private": secret}}}
	diagnostic := identityRecoveryLookupDiagnosticFor(fmt.Errorf("private wrapper %s: %w", secret, iq), 17)
	raw, err := json.Marshal(diagnostic)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), secret) || diagnostic.BatchSize != 17 || diagnostic.IQCode != 0 {
		t.Fatal("provider content entered safe diagnostic")
	}
	if got := identityRecoveryLookupDiagnosticFor(&whatsmeow.IQError{Code: 429, Text: secret}, 3); got.IQCode != 429 {
		t.Fatal("safe IQ status lost")
	}
	if got := identityRecoveryLookupDiagnosticFor(context.DeadlineExceeded, 3); !got.ContextDeadline {
		t.Fatal("context timeout not classified")
	}
	if got := identityRecoveryLookupDiagnosticFor(whatsmeow.ErrIQTimedOut, 3); !got.IQTimeout {
		t.Fatal("SDK timeout not classified")
	}
	if got := identityRecoveryLookupDiagnosticFor(whatsmeow.ErrIQDisconnected, 3); !got.Disconnected {
		t.Fatal("SDK disconnect not classified")
	}
	// Merely constructing the diagnostic must not invoke an arbitrary Error method.
	_ = identityRecoveryLookupDiagnosticFor(identityRecoveryUnsafeStringError{}, 1)
}

type identityRecoveryUnsafeStringError struct{}

func (identityRecoveryUnsafeStringError) Error() string { panic("raw Error method must not run") }
