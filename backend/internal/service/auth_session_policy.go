package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/cache"
)

const (
	authSessionReasonRetention = 5 * time.Minute
	consumedRefreshCredential  = "rotated"
	authSessionWriteAttempts   = 3
)

var (
	ErrAuthSessionIdleExpired  = fmt.Errorf("%w: idle deadline reached", ErrAuthSessionExpired)
	ErrAuthSessionScopeChanged = errors.New("auth session scope changed")
)

// AuthSessionSnapshot exposes timing and a non-credential correlation key to
// browser tabs. It never contains a JWT, Redis key or refresh credential.
type AuthSessionSnapshot struct {
	Scope              string    `json:"scope"`
	AccountID          uuid.UUID `json:"account_id"`
	IdleTimeoutMinutes int       `json:"idle_timeout_minutes"`
	ServerNow          time.Time `json:"server_now"`
	IdleExpiresAt      time.Time `json:"idle_expires_at"`
	AbsoluteExpiresAt  time.Time `json:"absolute_expires_at"`
}

func (snapshot AuthSessionSnapshot) Deadline() time.Time {
	if snapshot.AbsoluteExpiresAt.Before(snapshot.IdleExpiresAt) {
		return snapshot.AbsoluteExpiresAt
	}
	return snapshot.IdleExpiresAt
}

func (session *authSessionData) timeoutMinutes() int {
	if session.IdleTimeoutMinutes == 0 {
		return domain.DefaultSessionIdleTimeoutMinutes
	}
	return session.IdleTimeoutMinutes
}

func (session *authSessionData) idleDeadline() time.Time {
	return time.Unix(session.LastSeen, 0).UTC().Add(time.Duration(session.timeoutMinutes()) * time.Minute)
}

func (session *authSessionData) absoluteDeadline() time.Time {
	return time.Unix(session.CreatedAt, 0).UTC().Add(AuthSessionAbsoluteLifetime)
}

func (session *authSessionData) deadline() time.Time {
	idle, absolute := session.idleDeadline(), session.absoluteDeadline()
	if absolute.Before(idle) {
		return absolute
	}
	return idle
}

func (session *authSessionData) validateTime(now time.Time) error {
	if session.CreatedAt <= 0 || session.LastSeen < session.CreatedAt ||
		time.Unix(session.LastSeen, 0).After(now.Add(time.Minute)) || !domain.ValidSessionIdleTimeoutMinutes(session.timeoutMinutes()) {
		return fmt.Errorf("%w: invalid session timing", ErrAuthSessionExpired)
	}
	if !now.Before(session.absoluteDeadline()) {
		return errAuthSessionAbsoluteExpired
	}
	if !now.Before(session.idleDeadline()) {
		return ErrAuthSessionIdleExpired
	}
	return nil
}

func (session *authSessionData) snapshot(sessionID string, accountID uuid.UUID) AuthSessionSnapshot {
	return AuthSessionSnapshot{
		Scope: authSessionCorrelation(sessionID, accountID), AccountID: accountID, IdleTimeoutMinutes: session.timeoutMinutes(),
		ServerNow: time.Now().UTC(), IdleExpiresAt: session.idleDeadline(), AbsoluteExpiresAt: session.absoluteDeadline(),
	}
}

func (s *AuthService) loadSession(ctx context.Context, sessionID string, userID, accountID uuid.UUID) (loaded *authSessionData, raw []byte, resultErr error) {
	var diagnostic *authSessionData
	defer func() {
		if resultErr != nil {
			recordAuthSessionDiagnostic(sessionID, userID, accountID, diagnostic, authSessionDiagnosticReason(resultErr))
		}
	}()
	if s.cache == nil {
		return nil, nil, fmt.Errorf("%w: cache not configured", ErrAuthSessionUnavailable)
	}
	if id, err := uuid.Parse(sessionID); err != nil || id == uuid.Nil || userID == uuid.Nil {
		return nil, nil, fmt.Errorf("%w: missing session identity", ErrAuthSessionExpired)
	}
	data, err := s.cache.Get(ctx, sessionKeyPrefix+sessionID)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: session read failed: %v", ErrAuthSessionUnavailable, err)
	}
	if data == nil {
		return nil, nil, errAuthSessionMissing
	}
	var session authSessionData
	if err := json.Unmarshal(data, &session); err != nil {
		return nil, nil, fmt.Errorf("%w: malformed session", ErrAuthSessionExpired)
	}
	// Old sessions kept their initial account ID through switches. Their signed
	// credential account remains authoritative until the next switch/login.
	if session.UserID != userID.String() || (session.IdleTimeoutMinutes != 0 && accountID != uuid.Nil && session.AccountID != accountID.String()) {
		return nil, nil, errAuthSessionIdentityMismatch
	}
	diagnostic = &session
	if err := s.validateSessionInvalidationGeneration(ctx, &session); err != nil {
		return nil, nil, err
	}
	if err := session.validateTime(time.Now()); err != nil {
		return nil, nil, err
	}
	return &session, data, nil
}

func (s *AuthService) SessionSnapshot(ctx context.Context, sessionID string, userID, accountID uuid.UUID) (AuthSessionSnapshot, error) {
	session, _, err := s.loadSession(ctx, sessionID, userID, accountID)
	if err != nil {
		return AuthSessionSnapshot{}, err
	}
	return session.snapshot(sessionID, accountID), nil
}

func (s *AuthService) RecordSessionActivity(ctx context.Context, claims *JWTClaims, scope string) (AuthSessionSnapshot, error) {
	for attempt := 0; attempt < authSessionWriteAttempts; attempt++ {
		session, raw, err := s.loadSession(ctx, claims.SessionID, claims.UserID, claims.AccountID)
		if err != nil {
			return AuthSessionSnapshot{}, err
		}
		if scope != session.snapshot(claims.SessionID, claims.AccountID).Scope {
			recordAuthSessionDiagnostic(claims.SessionID, claims.UserID, claims.AccountID, session, "scope_changed")
			return AuthSessionSnapshot{}, ErrAuthSessionScopeChanged
		}
		previousDeadline := session.deadline()
		now := time.Now().Unix()
		if now <= session.LastSeen {
			return session.snapshot(claims.SessionID, claims.AccountID), nil
		}
		session.LastSeen = now
		value, _ := json.Marshal(session)
		updated, err := s.cache.UpdateAuthSession(ctx, sessionKeyPrefix+claims.SessionID,
			userSessionInvalidatedPrefix+session.UserID, raw, session.InvalidationMarker, previousDeadline,
			value, session.deadline().Add(authSessionReasonRetention))
		if err != nil {
			recordAuthSessionDiagnostic(claims.SessionID, claims.UserID, claims.AccountID, session, "unavailable")
			return AuthSessionSnapshot{}, fmt.Errorf("%w: session update failed: %v", ErrAuthSessionUnavailable, err)
		}
		if updated {
			return session.snapshot(claims.SessionID, claims.AccountID), nil
		}
	}
	recordAuthSessionDiagnostic(claims.SessionID, claims.UserID, claims.AccountID, nil, "unavailable")
	return AuthSessionSnapshot{}, fmt.Errorf("%w: session changed during activity", ErrAuthSessionUnavailable)
}

func (s *AuthService) readRefreshCredential(ctx context.Context, refreshToken string) (refreshTokenData, []byte, error) {
	var credential refreshTokenData
	if s.cache == nil {
		return credential, nil, fmt.Errorf("%w: cache not configured", ErrAuthSessionUnavailable)
	}
	data, err := s.cache.Get(ctx, refreshTokenKeyPrefix+strings.TrimSpace(refreshToken))
	if err != nil {
		return credential, nil, fmt.Errorf("%w: refresh credential read failed: %v", ErrAuthSessionUnavailable, err)
	}
	if string(data) == consumedRefreshCredential {
		return credential, nil, ErrAuthSessionScopeChanged
	}
	if len(data) == 0 || json.Unmarshal(data, &credential) != nil {
		return credential, nil, fmt.Errorf("%w: invalid refresh credential", ErrAuthSessionExpired)
	}
	return credential, data, nil
}

func (s *AuthService) replaceRefreshCredential(ctx context.Context, oldToken, newToken string, oldData []byte, next refreshTokenData, sourceSessionID string, sourceAccountID uuid.UUID, replacement *authSessionData) (AuthSessionSnapshot, error) {
	userID, err := uuid.Parse(next.UserID)
	if err != nil {
		return AuthSessionSnapshot{}, fmt.Errorf("%w: invalid credential user", ErrAuthSessionExpired)
	}
	for attempt := 0; attempt < authSessionWriteAttempts; attempt++ {
		if _, _, err := s.readRefreshCredential(ctx, oldToken); err != nil {
			return AuthSessionSnapshot{}, err
		}
		source, raw, err := s.loadSession(ctx, sourceSessionID, userID, sourceAccountID)
		if err != nil {
			if _, _, credentialErr := s.readRefreshCredential(ctx, oldToken); errors.Is(credentialErr, ErrAuthSessionScopeChanged) || errors.Is(credentialErr, ErrAuthSessionUnavailable) {
				return AuthSessionSnapshot{}, credentialErr
			}
			return AuthSessionSnapshot{}, err
		}
		if source.CreatedAt != next.CreatedAt {
			recordAuthSessionDiagnostic(sourceSessionID, userID, sourceAccountID, source, "invalid")
			return AuthSessionSnapshot{}, fmt.Errorf("%w: refresh session mismatch", ErrAuthSessionExpired)
		}
		value, _ := json.Marshal(next)
		rotation := cache.AuthCredentialRotation{
			SessionKey: sessionKeyPrefix + sourceSessionID, MarkerKey: userSessionInvalidatedPrefix + source.UserID,
			OldCredentialKey: refreshTokenKeyPrefix + oldToken, NewCredentialKey: refreshTokenKeyPrefix + newToken,
			ExpectedSession: raw, ExpectedCredential: oldData, Credential: value,
			Marker: source.InvalidationMarker, ConsumedMarker: consumedRefreshCredential,
			Deadline: source.deadline(), CredentialExpiresAt: source.absoluteDeadline(),
			NewSessionKey: sessionKeyPrefix + next.SessionID,
		}
		current := source
		if replacement != nil {
			current = replacement
			rotation.NewSession, _ = json.Marshal(replacement)
			rotation.NewSessionExpiresAt = replacement.deadline().Add(authSessionReasonRetention)
		}
		updated, err := s.cache.RotateAuthCredential(ctx, rotation)
		if err != nil {
			recordAuthSessionDiagnostic(sourceSessionID, userID, sourceAccountID, source, "unavailable")
			return AuthSessionSnapshot{}, fmt.Errorf("%w: refresh credential rotation failed: %v", ErrAuthSessionUnavailable, err)
		}
		if updated {
			accountID, _ := uuid.Parse(next.AccountID)
			return current.snapshot(next.SessionID, accountID), nil
		}
	}
	recordAuthSessionDiagnostic(sourceSessionID, userID, sourceAccountID, nil, "unavailable")
	return AuthSessionSnapshot{}, fmt.Errorf("%w: session changed during credential rotation", ErrAuthSessionUnavailable)
}
