package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestAuthSessionDiagnosticClassifiesWithoutChangingErrorIdentity(t *testing.T) {
	cases := []struct {
		err     error
		reason  string
		expired bool
	}{
		{nil, "", false},
		{ErrAuthSessionIdleExpired, "idle", true},
		{errAuthSessionAbsoluteExpired, "absolute", true},
		{errAuthSessionRevoked, "revoked", true},
		{errAuthSessionMissing, "missing", true},
		{errAuthSessionIdentityMismatch, "scope_changed", true},
		{ErrAuthSessionScopeChanged, "scope_changed", false},
		{ErrAuthSessionUnavailable, "unavailable", false},
		{fmt.Errorf("%w: malformed session", ErrAuthSessionExpired), "invalid", true},
		{errors.New("arbitrary failure with confidential material"), "unknown", false},
	}
	for _, test := range cases {
		if reason := authSessionDiagnosticReason(test.err); reason != test.reason {
			t.Fatalf("reason=%q, want %q", reason, test.reason)
		}
		if errors.Is(test.err, ErrAuthSessionExpired) != test.expired {
			t.Fatalf("changed authentication identity for category %q", test.reason)
		}
		if test.err != nil && authSessionDiagnosticReason(fmt.Errorf("wrapped: %w", test.err)) != test.reason {
			t.Fatalf("wrapped category changed: %q", test.reason)
		}
	}
}

func TestAuthSessionDiagnosticProjectsOnlySafeFieldsAndSnapshotCorrelation(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	account, user := uuid.New(), uuid.New()
	sessionID := uuid.NewString()
	session := &authSessionData{UserID: user.String(), AccountID: account.String(), Username: "secret-user-name", InvalidationMarker: "secret-generation-marker", CreatedAt: now.Add(-time.Hour).Unix(), LastSeen: now.Add(-10 * time.Minute).Unix(), IdleTimeoutMinutes: 180}
	event := makeAuthSessionDiagnostic(now, sessionID, user, account, session, "idle")
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{sessionID, session.Username, session.InvalidationMarker, "refresh", "password", "cookie"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("diagnostic contains confidential field %q", forbidden)
		}
	}
	if event.Scope != session.snapshot(sessionID, account).Scope || len(event.Scope) != 64 {
		t.Fatal("diagnostic correlation differs from the browser snapshot")
	}
	if event.AccountID != account || event.UserID != user || event.IdleMinutes != 180 {
		t.Fatal("diagnostic lost its account, actor or effective policy")
	}
	if event.IdleExpiresAt == nil || !event.IdleExpiresAt.Equal(now.Add(170*time.Minute)) {
		t.Fatal("diagnostic changed the idle deadline")
	}
	if event.AbsoluteExpiresAt == nil || !event.AbsoluteExpiresAt.Equal(time.Unix(session.CreatedAt, 0).Add(AuthSessionAbsoluteLifetime)) {
		t.Fatal("diagnostic changed absolute lifetime")
	}
	if other := makeAuthSessionDiagnostic(now, sessionID, user, uuid.New(), nil, "unavailable"); other.Scope == event.Scope || other.IdleExpiresAt != nil {
		t.Fatal("diagnostic crossed account context or invented timing")
	}
	unsafe := makeAuthSessionDiagnostic(now, sessionID, user, account, nil, "secret-token\ninjected")
	if unsafe.Reason != "unknown" {
		t.Fatal("untrusted category was retained")
	}
}

func TestAuthSessionDiagnosticDeduplicatesAndBoundsRetainedScopes(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	limiter := authSessionDiagnosticLimiter{limit: 3, ttl: 5 * time.Minute}
	if !limiter.allow(now, "a", "idle") || limiter.allow(now.Add(time.Minute), "a", "idle") {
		t.Fatal("terminal scope/reason was not deduplicated")
	}
	if !limiter.allow(now.Add(time.Minute), "a", "revoked") {
		t.Fatal("distinct close reason was hidden")
	}
	if !limiter.allow(now.Add(5*time.Minute), "a", "idle") {
		t.Fatal("scope did not become observable again at the retention boundary")
	}
	for index := 0; index < 20; index++ {
		limiter.allow(now.Add(6*time.Minute), fmt.Sprint(index), "missing")
	}
	if len(limiter.entries) != 3 {
		t.Fatalf("diagnostic limiter retained %d entries", len(limiter.entries))
	}
	limiter.allow(now.Add(12*time.Minute), "fresh", "idle")
	if len(limiter.entries) != 1 {
		t.Fatal("expired correlation entries were not removed")
	}
	var wait sync.WaitGroup
	for index := 0; index < 20; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			limiter.allow(now.Add(13*time.Minute), fmt.Sprint(index), "unavailable")
		}(index)
	}
	wait.Wait()
	if len(limiter.entries) > 3 {
		t.Fatal("concurrent diagnostics bypassed their bound")
	}
}

func TestAuthSessionDiagnosticDoesNotModifyReadOnlyAuthentication(t *testing.T) {
	user, account, sessionID := uuid.New(), uuid.New(), uuid.NewString()
	created := time.Now().Add(-time.Hour).Truncate(time.Second)
	session := authSessionData{UserID: user.String(), AccountID: account.String(), CreatedAt: created.Unix(), LastSeen: created.Unix(), IdleTimeoutMinutes: 180}
	payload, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	cache := &authSessionFakeCache{values: map[string][]byte{sessionKeyPrefix + sessionID: payload}}
	service := &AuthService{cache: cache}
	if err := service.ValidateSessionReadOnly(context.Background(), sessionID, user, account); err != nil {
		t.Fatal(err)
	}
	if cache.setCalls != 0 || cache.delCalls != 0 || string(cache.values[sessionKeyPrefix+sessionID]) != string(payload) {
		t.Fatal("diagnostic authentication extended or modified the session")
	}
	delete(cache.values, sessionKeyPrefix+sessionID)
	if err := service.ValidateSessionReadOnly(context.Background(), sessionID, user, account); !errors.Is(err, ErrAuthSessionExpired) || authSessionDiagnosticReason(err) != "missing" {
		t.Fatal("missing session authentication changed")
	}
}
