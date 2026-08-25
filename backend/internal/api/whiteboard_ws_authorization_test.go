package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

func TestWhiteboardRealtimeAuthorizationClassification(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		outcome   string
		event     string
		code      string
		closeCode int
	}{
		{
			name: "session expired", err: service.ErrAuthSessionExpired,
			outcome: whiteboardAuthorizationSessionExpired, event: whiteboardcore.EventError,
			code: "session_expired", closeCode: websocket.ClosePolicyViolation,
		},
		{
			name: "view revoked", err: repository.ErrWhiteboardForbidden,
			outcome: whiteboardAuthorizationAccessRevoked, event: whiteboardcore.EventAccessRevoked,
			code: "access_revoked", closeCode: websocket.ClosePolicyViolation,
		},
		{
			name: "board archived or purged", err: repository.ErrWhiteboardNotFound,
			outcome: whiteboardAuthorizationAccessRevoked, event: whiteboardcore.EventAccessRevoked,
			code: "access_revoked", closeCode: websocket.ClosePolicyViolation,
		},
		{
			name: "guest revoked", err: repository.ErrWhiteboardSessionUnavailable,
			outcome: whiteboardAuthorizationAccessRevoked, event: whiteboardcore.EventAccessRevoked,
			code: "access_revoked", closeCode: websocket.ClosePolicyViolation,
		},
		{
			name: "session store unavailable", err: service.ErrAuthSessionUnavailable,
			outcome: whiteboardAuthorizationUnavailable, event: whiteboardcore.EventError,
			code: "authorization_unavailable", closeCode: websocket.CloseTryAgainLater,
		},
		{
			name: "database deadline", err: context.DeadlineExceeded,
			outcome: whiteboardAuthorizationUnavailable, event: whiteboardcore.EventError,
			code: "authorization_unavailable", closeCode: websocket.CloseTryAgainLater,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			wrapped := whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessView, testCase.err)
			if outcome := classifyWhiteboardRealtimeAuthorization(wrapped); outcome != testCase.outcome {
				t.Fatalf("outcome = %q, want %q", outcome, testCase.outcome)
			}
			termination := whiteboardSocketTerminationForAuthorization(wrapped)
			if termination.Message.Event != testCase.event || termination.Message.Code != testCase.code || termination.CloseCode != testCase.closeCode {
				t.Fatalf("unexpected termination: %+v", termination)
			}
		})
	}
}

func TestWhiteboardRealtimeAuthorizationRetainsRequiredLevel(t *testing.T) {
	wrapped := whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessEdit, repository.ErrWhiteboardForbidden)
	if !errors.Is(wrapped, repository.ErrWhiteboardForbidden) {
		t.Fatalf("wrapped error lost repository cause: %v", wrapped)
	}
	if level := whiteboardRealtimeAuthorizationRequiredLevel(wrapped, domain.WhiteboardAccessView); level != domain.WhiteboardAccessEdit {
		t.Fatalf("required level = %q, want edit", level)
	}
	if level := whiteboardRealtimeRequiredLevelForEvent(whiteboardcore.EventScenePatch); level != domain.WhiteboardAccessEdit {
		t.Fatalf("scene.patch level = %q, want edit", level)
	}
	if level := whiteboardRealtimeRequiredLevelForEvent(whiteboardcore.EventSyncRequest); level != domain.WhiteboardAccessView {
		t.Fatalf("sync.request level = %q, want view", level)
	}
}

func TestWhiteboardMemberTicketIgnoresAccessJWTExpiry(t *testing.T) {
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	userID := uuid.New()
	member := &whiteboardRealtimePrincipal{UserID: &userID, SessionID: uuid.NewString()}
	if got, want := whiteboardCollabTicketExpiresAt(now, member), now.Add(whiteboardCollabTicketTTL); !got.Equal(want) {
		t.Fatalf("member ticket expiry = %s, want %s", got, want)
	}

	guestID := uuid.New()
	guestExpiry := now.Add(10 * time.Second)
	guest := &whiteboardRealtimePrincipal{GuestSession: &guestID, GuestExpiresAt: &guestExpiry}
	if got := whiteboardCollabTicketExpiresAt(now, guest); !got.Equal(guestExpiry) {
		t.Fatalf("guest ticket expiry = %s, want %s", got, guestExpiry)
	}
}

func TestWhiteboardCollabTicketAccountContextUsesOptionalCanonicalOverride(t *testing.T) {
	fallback := uuid.New()
	override := uuid.New()
	tests := []struct {
		name string
		body string
		want uuid.UUID
	}{
		{name: "empty legacy body", want: fallback},
		{name: "legacy object", body: `{}`, want: fallback},
		{name: "omitted field", body: `{"client":"legacy"}`, want: fallback},
		{name: "canonical override", body: `{"account_id":"` + override.String() + `"}`, want: override},
		{name: "uppercase canonical override", body: `{"account_id":"` + strings.ToUpper(override.String()) + `"}`, want: override},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := whiteboardCollabTicketAccountID([]byte(testCase.body), fallback)
			if err != nil {
				t.Fatalf("resolve account context: %v", err)
			}
			if got != testCase.want {
				t.Fatalf("account = %s, want %s", got, testCase.want)
			}
		})
	}
	if override == fallback {
		t.Fatal("test did not exercise an account override")
	}
}

func TestWhiteboardCollabTicketAccountContextRejectsNonCanonicalUUIDs(t *testing.T) {
	fallback := uuid.New()
	valid := uuid.New()
	compact := strings.ReplaceAll(valid.String(), "-", "")
	tests := []struct {
		name     string
		body     string
		fallback uuid.UUID
	}{
		{name: "missing fallback", body: `{}`, fallback: uuid.Nil},
		{name: "invalid json", body: `{"account_id":`, fallback: fallback},
		{name: "top-level null", body: `null`, fallback: fallback},
		{name: "array", body: `[]`, fallback: fallback},
		{name: "null account", body: `{"account_id":null}`, fallback: fallback},
		{name: "numeric account", body: `{"account_id":7}`, fallback: fallback},
		{name: "empty account", body: `{"account_id":""}`, fallback: fallback},
		{name: "nil UUID", body: `{"account_id":"` + uuid.Nil.String() + `"}`, fallback: fallback},
		{name: "compact UUID", body: `{"account_id":"` + compact + `"}`, fallback: fallback},
		{name: "UUID with whitespace", body: `{"account_id":" ` + valid.String() + `"}`, fallback: fallback},
		{name: "URN UUID", body: `{"account_id":"urn:uuid:` + valid.String() + `"}`, fallback: fallback},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := whiteboardCollabTicketAccountID([]byte(testCase.body), testCase.fallback); !errors.Is(err, repository.ErrWhiteboardInvalid) {
				t.Fatalf("error = %v, want ErrWhiteboardInvalid", err)
			}
		})
	}
}

func TestWhiteboardGuestTicketResolutionClassifiesCanonicalAndTransientFailures(t *testing.T) {
	linkID := uuid.New()
	valid := &domain.WhiteboardGuestContext{Session: &domain.WhiteboardGuestSession{ShareLinkID: linkID}}
	tests := []struct {
		name  string
		guest *domain.WhiteboardGuestContext
		err   error
		want  error
	}{
		{name: "valid", guest: valid},
		{name: "canonical session loss", err: repository.ErrWhiteboardSessionUnavailable, want: repository.ErrWhiteboardSessionUnavailable},
		{name: "database unavailable", err: errors.New("database unavailable"), want: service.ErrAuthSessionUnavailable},
		{name: "deadline", err: context.DeadlineExceeded, want: service.ErrAuthSessionUnavailable},
		{name: "missing guest", want: repository.ErrWhiteboardSessionUnavailable},
		{name: "missing session", guest: &domain.WhiteboardGuestContext{}, want: repository.ErrWhiteboardSessionUnavailable},
		{name: "link mismatch", guest: &domain.WhiteboardGuestContext{Session: &domain.WhiteboardGuestSession{ShareLinkID: uuid.New()}}, want: repository.ErrWhiteboardSessionUnavailable},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got := whiteboardGuestTicketResolutionError(testCase.guest, linkID, testCase.err)
			if testCase.want == nil && got != nil {
				t.Fatalf("error = %v, want nil", got)
			}
			if testCase.want != nil && !errors.Is(got, testCase.want) {
				t.Fatalf("error = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestWhiteboardMemberPrincipalSerializesOnlyStableSessionIdentity(t *testing.T) {
	userID := uuid.New()
	principal := &whiteboardRealtimePrincipal{
		AccountID: uuid.New(), BoardID: uuid.New(), UserID: &userID, SessionID: uuid.NewString(),
		Actor: whiteboardcore.RealtimeActor{Kind: "user", ID: uuid.New(), UserID: &userID, Access: domain.WhiteboardAccessEdit},
	}
	payload, err := json.Marshal(principal)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(payload)
	if !strings.Contains(serialized, `"session_id"`) {
		t.Fatalf("member principal omitted session identity: %s", serialized)
	}
	for _, forbidden := range []string{`"claims"`, `"expires_at"`, `"last_ephemeral_validation"`} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("member principal leaked unstable field %s: %s", forbidden, serialized)
		}
	}
}

func TestWhiteboardModuleUsesCurrentAdminAndMembershipPermissions(t *testing.T) {
	active := &domain.User{IsActive: true}
	tests := []struct {
		name       string
		user       *domain.User
		membership *domain.UserAccount
		allowed    bool
	}{
		{name: "legacy admin", user: &domain.User{IsActive: true, IsAdmin: true}, membership: &domain.UserAccount{Role: domain.RoleAgent}, allowed: true},
		{name: "super admin", user: &domain.User{IsActive: true, IsSuperAdmin: true}, membership: &domain.UserAccount{Role: domain.RoleAgent}, allowed: true},
		{name: "account admin", user: active, membership: &domain.UserAccount{Role: domain.RoleAdmin}, allowed: true},
		{name: "explicit whiteboards", user: active, membership: &domain.UserAccount{Role: domain.RoleAgent, Permissions: []string{domain.PermWhiteboards}}, allowed: true},
		{name: "wildcard", user: active, membership: &domain.UserAccount{Role: domain.RoleAgent, Permissions: []string{domain.PermAll}}, allowed: true},
		{name: "unrelated permission", user: active, membership: &domain.UserAccount{Role: domain.RoleAgent, Permissions: []string{domain.PermChats}}},
		{name: "inactive admin", user: &domain.User{IsActive: false, IsAdmin: true}, membership: &domain.UserAccount{Role: domain.RoleAdmin}},
		{name: "missing membership", user: active},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if got := whiteboardMembershipAllowsModule(testCase.user, testCase.membership); got != testCase.allowed {
				t.Fatalf("allowed = %v, want %v", got, testCase.allowed)
			}
		})
	}
}
