package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// These errors retain the pre-existing text and ErrAuthSessionExpired identity.
// Diagnostics must classify typed states, never inspect/log arbitrary errors.
var (
	errAuthSessionAbsoluteExpired  = fmt.Errorf("%w: absolute lifetime exceeded", ErrAuthSessionExpired)
	errAuthSessionRevoked          = fmt.Errorf("%w: session invalidated", ErrAuthSessionExpired)
	errAuthSessionMissing          = fmt.Errorf("%w: session missing", ErrAuthSessionExpired)
	errAuthSessionIdentityMismatch = fmt.Errorf("%w: session identity mismatch", ErrAuthSessionExpired)
)

type authSessionDiagnostic struct {
	Reason            string     `json:"reason"`
	AccountID         uuid.UUID  `json:"account_id"`
	UserID            uuid.UUID  `json:"user_id"`
	Scope             string     `json:"scope"`
	ObservedAt        time.Time  `json:"observed_at"`
	IdleMinutes       int        `json:"idle_timeout_minutes,omitempty"`
	LastActivityAt    *time.Time `json:"last_activity_at,omitempty"`
	IdleExpiresAt     *time.Time `json:"idle_expires_at,omitempty"`
	AbsoluteExpiresAt *time.Time `json:"absolute_expires_at,omitempty"`
}

func authSessionCorrelation(sessionID string, accountID uuid.UUID) string {
	digest := sha256.Sum256([]byte("clarin-browser-session:" + sessionID + ":" + accountID.String()))
	return hex.EncodeToString(digest[:])
}

func authSessionDiagnosticReason(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrAuthSessionIdleExpired):
		return "idle"
	case errors.Is(err, errAuthSessionAbsoluteExpired):
		return "absolute"
	case errors.Is(err, errAuthSessionRevoked):
		return "revoked"
	case errors.Is(err, errAuthSessionMissing):
		return "missing"
	case errors.Is(err, ErrAuthSessionScopeChanged), errors.Is(err, errAuthSessionIdentityMismatch):
		return "scope_changed"
	case errors.Is(err, ErrAuthSessionUnavailable):
		return "unavailable"
	case errors.Is(err, ErrAuthSessionExpired):
		return "invalid"
	default:
		return "unknown"
	}
}

func makeAuthSessionDiagnostic(now time.Time, sessionID string, userID, accountID uuid.UUID, session *authSessionData, reason string) authSessionDiagnostic {
	// Only fixed categories enter the log. Neither a provider error nor an
	// untrusted reason can introduce token, cookie or credential material.
	switch reason {
	case "idle", "absolute", "revoked", "missing", "scope_changed", "unavailable", "invalid", "logout", "account_switch":
	default:
		reason = "unknown"
	}
	event := authSessionDiagnostic{Reason: reason, AccountID: accountID, UserID: userID, Scope: authSessionCorrelation(sessionID, accountID), ObservedAt: now.UTC()}
	if session != nil && session.CreatedAt > 0 && session.LastSeen >= session.CreatedAt && domain.ValidSessionIdleTimeoutMinutes(session.timeoutMinutes()) {
		last, idle, absolute := time.Unix(session.LastSeen, 0).UTC(), session.idleDeadline(), session.absoluteDeadline()
		event.IdleMinutes, event.LastActivityAt, event.IdleExpiresAt, event.AbsoluteExpiresAt = session.timeoutMinutes(), &last, &idle, &absolute
	}
	return event
}

type authSessionDiagnosticLimiter struct {
	mu      sync.Mutex
	entries map[string]time.Time
	limit   int
	ttl     time.Duration
}

func (limiter *authSessionDiagnosticLimiter) allow(now time.Time, scope, reason string) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	if limiter.limit <= 0 || limiter.ttl <= 0 {
		return false
	}
	if limiter.entries == nil {
		limiter.entries = make(map[string]time.Time)
	}
	key := scope + ":" + reason
	if until, found := limiter.entries[key]; found && now.Before(until) {
		return false
	}
	var oldestKey string
	var oldest time.Time
	for key, until := range limiter.entries {
		if !now.Before(until) {
			delete(limiter.entries, key)
			continue
		}
		if oldestKey == "" || until.Before(oldest) {
			oldestKey, oldest = key, until
		}
	}
	if len(limiter.entries) >= limiter.limit {
		delete(limiter.entries, oldestKey)
	}
	limiter.entries[key] = now.Add(limiter.ttl)
	return true
}

var sessionDiagnostics = authSessionDiagnosticLimiter{limit: 1024, ttl: 5 * time.Minute}

func recordAuthSessionDiagnostic(sessionID string, userID, accountID uuid.UUID, session *authSessionData, reason string) {
	if sessionID == "" || userID == uuid.Nil || accountID == uuid.Nil {
		return
	}
	now := time.Now()
	event := makeAuthSessionDiagnostic(now, sessionID, userID, accountID, session, reason)
	if !sessionDiagnostics.allow(now, event.Scope, event.Reason) {
		return
	}
	encoded, err := json.Marshal(event)
	if err == nil {
		log.Printf("[AuthSession] %s", encoded)
	}
}
