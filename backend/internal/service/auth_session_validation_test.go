package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/naperu/clarin/pkg/cache"
)

type authSessionFakeCache struct {
	values          map[string][]byte
	errors          map[string]error
	setErrors       map[string]error
	delErrors       map[string]error
	getKeys         []string
	setCalls        int
	delCalls        int
	setKeys         []string
	delKeys         []string
	setTTLs         []time.Duration
	beforeAuthWrite func()
	authWriteError  error
}

func (c *authSessionFakeCache) Get(_ context.Context, key string) ([]byte, error) {
	c.getKeys = append(c.getKeys, key)
	if err := c.errors[key]; err != nil {
		return nil, err
	}
	return c.values[key], nil
}

func (c *authSessionFakeCache) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	c.setCalls++
	c.setKeys = append(c.setKeys, key)
	c.setTTLs = append(c.setTTLs, ttl)
	if err := c.setErrors[key]; err != nil {
		return err
	}
	if c.values == nil {
		c.values = make(map[string][]byte)
	}
	c.values[key] = value
	return nil
}

func (c *authSessionFakeCache) Del(_ context.Context, keys ...string) error {
	for _, key := range keys {
		c.delCalls++
		c.delKeys = append(c.delKeys, key)
		if err := c.delErrors[key]; err != nil {
			return err
		}
		delete(c.values, key)
	}
	return nil
}

func (c *authSessionFakeCache) UpdateAuthSession(ctx context.Context, sessionKey, markerKey string, expected []byte, marker string, deadline time.Time, value []byte, expiresAt time.Time) (bool, error) {
	if c.beforeAuthWrite != nil {
		c.beforeAuthWrite()
	}
	if c.authWriteError != nil {
		return false, c.authWriteError
	}
	if !bytes.Equal(c.values[sessionKey], expected) || (c.values[markerKey] != nil && string(c.values[markerKey]) != marker) || !time.Now().Before(deadline) {
		return false, nil
	}
	return true, c.Set(ctx, sessionKey, value, time.Until(expiresAt))
}

func (c *authSessionFakeCache) RotateAuthCredential(ctx context.Context, rotation cache.AuthCredentialRotation) (bool, error) {
	if c.beforeAuthWrite != nil {
		c.beforeAuthWrite()
	}
	if c.authWriteError != nil {
		return false, c.authWriteError
	}
	if !bytes.Equal(c.values[rotation.SessionKey], rotation.ExpectedSession) ||
		!bytes.Equal(c.values[rotation.OldCredentialKey], rotation.ExpectedCredential) ||
		(c.values[rotation.MarkerKey] != nil && string(c.values[rotation.MarkerKey]) != rotation.Marker) ||
		!time.Now().Before(rotation.Deadline) {
		return false, nil
	}
	c.values[rotation.NewCredentialKey] = rotation.Credential
	c.values[rotation.OldCredentialKey] = []byte(rotation.ConsumedMarker)
	if len(rotation.NewSession) != 0 {
		c.values[rotation.NewSessionKey] = rotation.NewSession
		delete(c.values, rotation.SessionKey)
	}
	return true, nil
}

func authSessionJSON(t *testing.T, userID uuid.UUID, accountID uuid.UUID, createdAt time.Time) []byte {
	t.Helper()
	payload, err := json.Marshal(authSessionData{
		UserID: userID.String(), AccountID: accountID.String(), Username: "tester",
		CreatedAt: createdAt.Unix(), LastSeen: createdAt.Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func refreshCredentialJSON(t *testing.T, userID, accountID uuid.UUID, sessionID string, createdAt time.Time) []byte {
	t.Helper()
	payload, err := json.Marshal(refreshTokenData{
		UserID: userID.String(), AccountID: accountID.String(), Username: "tester",
		SessionID: sessionID, CreatedAt: createdAt.Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func signedAuthSessionToken(t *testing.T, method jwt.SigningMethod, secret string, claims JWTClaims) string {
	t.Helper()
	token, err := jwt.NewWithClaims(method, claims).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestValidateSessionReadOnlyDoesNotTouchSessionTTL(t *testing.T) {
	userID := uuid.New()
	sessionID := uuid.NewString()
	cache := &authSessionFakeCache{values: map[string][]byte{
		sessionKeyPrefix + sessionID: authSessionJSON(t, userID, uuid.New(), time.Now().Add(-10*time.Minute)),
	}}
	service := &AuthService{cache: cache}

	if err := service.ValidateSessionReadOnly(context.Background(), sessionID, userID, uuid.Nil); err != nil {
		t.Fatalf("validate live session: %v", err)
	}
	if cache.setCalls != 0 || cache.delCalls != 0 {
		t.Fatalf("read-only validation mutated cache: set=%d del=%d", cache.setCalls, cache.delCalls)
	}
	if len(cache.getKeys) != 2 || cache.getKeys[0] != sessionKeyPrefix+sessionID || cache.getKeys[1] != userSessionInvalidatedPrefix+userID.String() {
		t.Fatalf("unexpected cache reads: %v", cache.getKeys)
	}
}

func TestValidateTokenReadOnlyDoesNotTouchSessionTTL(t *testing.T) {
	userID := uuid.New()
	accountID := uuid.New()
	sessionID := uuid.NewString()
	secret := "test-only-secret"
	claims := JWTClaims{
		UserID: userID, AccountID: accountID, SessionID: sessionID, Username: "tester",
		RegisteredClaims: jwt.RegisteredClaims{
			ID: uuid.NewString(), Issuer: "clarin", IssuedAt: jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	cache := &authSessionFakeCache{values: map[string][]byte{
		sessionKeyPrefix + sessionID: authSessionJSON(t, userID, accountID, time.Now()),
	}}
	service := &AuthService{cache: cache}
	decoded, err := service.ValidateTokenReadOnly(context.Background(), token, secret)
	if err != nil {
		t.Fatalf("validate token read-only: %v", err)
	}
	if decoded.SessionID != sessionID || decoded.UserID != userID || decoded.AccountID != accountID {
		t.Fatalf("unexpected claims: %+v", decoded)
	}
	if cache.setCalls != 0 || cache.delCalls != 0 {
		t.Fatalf("read-only token validation mutated cache: set=%d del=%d", cache.setCalls, cache.delCalls)
	}
}

func TestValidateTokenReadOnlyRemainsStrictForExpiredAndInvalidJWTs(t *testing.T) {
	userID := uuid.New()
	accountID := uuid.New()
	sessionID := uuid.NewString()
	secret := "test-only-secret"
	now := time.Now()
	baseClaims := JWTClaims{
		UserID: userID, AccountID: accountID, SessionID: sessionID, Username: "tester",
		RegisteredClaims: jwt.RegisteredClaims{
			ID: uuid.NewString(), Issuer: "clarin", IssuedAt: jwt.NewNumericDate(now.Add(-time.Minute)),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
		},
	}
	liveSession := authSessionJSON(t, userID, accountID, now.Add(-10*time.Minute))
	tests := []struct {
		name          string
		claims        JWTClaims
		method        jwt.SigningMethod
		signingSecret string
		verifySecret  string
		blacklist     bool
		redisError    bool
		legacyError   bool
		wantTransient bool
	}{
		{name: "expired", claims: func() JWTClaims {
			value := baseClaims
			value.ExpiresAt = jwt.NewNumericDate(now.Add(-time.Second))
			return value
		}(), method: jwt.SigningMethodHS256, signingSecret: secret, verifySecret: secret},
		{name: "wrong issuer", claims: func() JWTClaims { value := baseClaims; value.Issuer = "other"; return value }(), method: jwt.SigningMethodHS256, signingSecret: secret, verifySecret: secret},
		{name: "missing jti", claims: func() JWTClaims { value := baseClaims; value.ID = ""; return value }(), method: jwt.SigningMethodHS256, signingSecret: secret, verifySecret: secret},
		{name: "invalid session id", claims: func() JWTClaims { value := baseClaims; value.SessionID = "not-a-uuid"; return value }(), method: jwt.SigningMethodHS256, signingSecret: secret, verifySecret: secret},
		{name: "missing account", claims: func() JWTClaims { value := baseClaims; value.AccountID = uuid.Nil; return value }(), method: jwt.SigningMethodHS256, signingSecret: secret, verifySecret: secret},
		{name: "wrong signature", claims: baseClaims, method: jwt.SigningMethodHS256, signingSecret: secret, verifySecret: "different-secret"},
		{name: "wrong hmac variant", claims: baseClaims, method: jwt.SigningMethodHS384, signingSecret: secret, verifySecret: secret},
		{name: "blacklisted", claims: baseClaims, method: jwt.SigningMethodHS256, signingSecret: secret, verifySecret: secret, blacklist: true},
		{name: "blacklist store unavailable", claims: baseClaims, method: jwt.SigningMethodHS256, signingSecret: secret, verifySecret: secret, redisError: true, wantTransient: true},
		{name: "legacy invalidation store unavailable", claims: baseClaims, method: jwt.SigningMethodHS256, signingSecret: secret, verifySecret: secret, legacyError: true, wantTransient: true},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			token := signedAuthSessionToken(t, testCase.method, testCase.signingSecret, testCase.claims)
			blacklistKey := jwtBlacklistKeyPrefix + testCase.claims.ID
			cache := &authSessionFakeCache{values: map[string][]byte{
				sessionKeyPrefix + sessionID: liveSession,
			}}
			if testCase.blacklist {
				cache.values[blacklistKey] = []byte("1")
			}
			if testCase.redisError {
				cache.errors = map[string]error{blacklistKey: errors.New("redis unavailable")}
			}
			if testCase.legacyError {
				cache.errors = map[string]error{userInvalidatedPrefix + userID.String(): errors.New("redis unavailable")}
			}
			_, err := (&AuthService{cache: cache}).ValidateTokenReadOnly(context.Background(), token, testCase.verifySecret)
			if err == nil {
				t.Fatal("invalid JWT was accepted")
			}
			if got := errors.Is(err, ErrAuthSessionUnavailable); got != testCase.wantTransient {
				t.Fatalf("transient = %v, want %v: %v", got, testCase.wantTransient, err)
			}
		})
	}
}

func TestValidateRefreshTokenReadOnlyUsesCanonicalSessionWithoutTouchingTTL(t *testing.T) {
	userID := uuid.New()
	accountID := uuid.New()
	sessionID := uuid.NewString()
	refreshToken := uuid.NewString()
	createdAt := time.Now().Add(-10 * time.Minute).Truncate(time.Second)
	cache := &authSessionFakeCache{values: map[string][]byte{
		refreshTokenKeyPrefix + refreshToken: refreshCredentialJSON(t, userID, accountID, sessionID, createdAt),
		sessionKeyPrefix + sessionID:         authSessionJSON(t, userID, uuid.New(), createdAt),
	}}
	identity, err := (&AuthService{cache: cache}).ValidateRefreshTokenReadOnly(context.Background(), refreshToken)
	if err != nil {
		t.Fatalf("validate refresh credential read-only: %v", err)
	}
	if identity.UserID != userID || identity.AccountID != accountID || identity.SessionID != sessionID || !identity.CreatedAt.Equal(createdAt) {
		t.Fatalf("unexpected identity: %+v", identity)
	}
	if cache.setCalls != 0 || cache.delCalls != 0 {
		t.Fatalf("read-only refresh validation mutated cache: set=%d del=%d", cache.setCalls, cache.delCalls)
	}
}

func TestWhiteboardReconnectFallsBackFromExpiredJWTToCurrentScopedCredential(t *testing.T) {
	userID := uuid.New()
	accountID := uuid.New()
	sessionID := uuid.NewString()
	refreshToken := uuid.NewString()
	secret := "test-only-secret"
	createdAt := time.Now().Add(-10 * time.Minute).Truncate(time.Second)
	claims := JWTClaims{
		UserID: userID, AccountID: accountID, SessionID: sessionID, Username: "tester",
		RegisteredClaims: jwt.RegisteredClaims{
			ID: uuid.NewString(), Issuer: "clarin", IssuedAt: jwt.NewNumericDate(createdAt),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Second)),
		},
	}
	cache := &authSessionFakeCache{values: map[string][]byte{
		refreshTokenKeyPrefix + refreshToken: refreshCredentialJSON(t, userID, accountID, sessionID, createdAt),
		sessionKeyPrefix + sessionID:         authSessionJSON(t, userID, accountID, createdAt),
	}}
	service := &AuthService{cache: cache}
	if _, err := service.ValidateTokenReadOnly(context.Background(), signedAuthSessionToken(t, jwt.SigningMethodHS256, secret, claims), secret); err == nil {
		t.Fatal("normal JWT validator accepted an expired access token")
	}
	identity, err := service.ValidateRefreshTokenReadOnly(context.Background(), refreshToken)
	if err != nil {
		t.Fatalf("current whiteboard session credential was rejected: %v", err)
	}
	if identity.UserID != userID || identity.AccountID != accountID || identity.SessionID != sessionID {
		t.Fatalf("fallback changed canonical identity: %+v", identity)
	}
	if cache.setCalls != 0 || cache.delCalls != 0 {
		t.Fatalf("reconnect fallback mutated Redis: set=%d del=%d", cache.setCalls, cache.delCalls)
	}
}

func TestValidateRefreshTokenReadOnlyClassifiesTerminalAndTransientStates(t *testing.T) {
	userID := uuid.New()
	accountID := uuid.New()
	sessionID := uuid.NewString()
	refreshToken := uuid.NewString()
	createdAt := time.Now().Add(-10 * time.Minute).Truncate(time.Second)
	validRefresh := refreshCredentialJSON(t, userID, accountID, sessionID, createdAt)
	validSession := authSessionJSON(t, userID, accountID, createdAt)
	tests := []struct {
		name          string
		token         string
		values        map[string][]byte
		errors        map[string]error
		wantTransient bool
	}{
		{name: "invalid credential id", token: "not-a-uuid"},
		{name: "missing credential", token: refreshToken, values: map[string][]byte{}},
		{name: "malformed credential", token: refreshToken, values: map[string][]byte{refreshTokenKeyPrefix + refreshToken: []byte(`{"user_id":`)}},
		{name: "missing session", token: refreshToken, values: map[string][]byte{refreshTokenKeyPrefix + refreshToken: validRefresh}},
		{name: "session creation mismatch", token: refreshToken, values: map[string][]byte{
			refreshTokenKeyPrefix + refreshToken: validRefresh,
			sessionKeyPrefix + sessionID:         authSessionJSON(t, userID, accountID, createdAt.Add(-time.Minute)),
		}},
		{name: "credential store unavailable", token: refreshToken, errors: map[string]error{
			refreshTokenKeyPrefix + refreshToken: errors.New("redis unavailable"),
		}, wantTransient: true},
		{name: "session store unavailable", token: refreshToken, values: map[string][]byte{
			refreshTokenKeyPrefix + refreshToken: validRefresh,
		}, errors: map[string]error{sessionKeyPrefix + sessionID: errors.New("redis unavailable")}, wantTransient: true},
		{name: "generation store unavailable", token: refreshToken, values: map[string][]byte{
			refreshTokenKeyPrefix + refreshToken: validRefresh,
			sessionKeyPrefix + sessionID:         validSession,
		}, errors: map[string]error{userSessionInvalidatedPrefix + userID.String(): errors.New("redis unavailable")}, wantTransient: true},
		{name: "legacy invalidation store unavailable", token: refreshToken, values: map[string][]byte{
			refreshTokenKeyPrefix + refreshToken: validRefresh,
			sessionKeyPrefix + sessionID:         validSession,
		}, errors: map[string]error{userInvalidatedPrefix + userID.String(): errors.New("redis unavailable")}, wantTransient: true},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			cache := &authSessionFakeCache{values: testCase.values, errors: testCase.errors}
			_, err := (&AuthService{cache: cache}).ValidateRefreshTokenReadOnly(context.Background(), testCase.token)
			if err == nil {
				t.Fatal("invalid reconnect credential was accepted")
			}
			if got := errors.Is(err, ErrAuthSessionUnavailable); got != testCase.wantTransient {
				t.Fatalf("transient = %v, want %v: %v", got, testCase.wantTransient, err)
			}
			if !testCase.wantTransient && !errors.Is(err, ErrAuthSessionExpired) {
				t.Fatalf("error = %v, want ErrAuthSessionExpired", err)
			}
			if cache.setCalls != 0 || cache.delCalls != 0 {
				t.Fatalf("failed read-only validation mutated cache: set=%d del=%d", cache.setCalls, cache.delCalls)
			}
		})
	}
}

func TestValidateSessionReadOnlyClassifiesTerminalStates(t *testing.T) {
	userID := uuid.New()
	sessionID := uuid.NewString()
	now := time.Now()
	valid := authSessionJSON(t, userID, uuid.New(), now.Add(-time.Hour))
	tests := []struct {
		name   string
		values map[string][]byte
	}{
		{name: "missing", values: map[string][]byte{}},
		{name: "malformed", values: map[string][]byte{sessionKeyPrefix + sessionID: []byte(`{"user_id":`)}},
		{name: "different user", values: map[string][]byte{sessionKeyPrefix + sessionID: authSessionJSON(t, uuid.New(), uuid.New(), now)}},
		{name: "absolute expiry", values: map[string][]byte{sessionKeyPrefix + sessionID: authSessionJSON(t, userID, uuid.New(), now.Add(-refreshTokenTTL-time.Minute))}},
		{name: "different generation", values: map[string][]byte{
			sessionKeyPrefix + sessionID: valid, userSessionInvalidatedPrefix + userID.String(): []byte("different-generation"),
		}},
		{name: "invalidated", values: map[string][]byte{
			sessionKeyPrefix + sessionID: valid, userSessionInvalidatedPrefix + userID.String(): []byte(strconv.FormatInt(time.Now().Unix(), 10)),
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			cache := &authSessionFakeCache{values: testCase.values}
			err := (&AuthService{cache: cache}).ValidateSessionReadOnly(context.Background(), sessionID, userID, uuid.Nil)
			if !errors.Is(err, ErrAuthSessionExpired) {
				t.Fatalf("error = %v, want ErrAuthSessionExpired", err)
			}
			if cache.setCalls != 0 || cache.delCalls != 0 {
				t.Fatalf("terminal read mutated cache: set=%d del=%d", cache.setCalls, cache.delCalls)
			}
		})
	}
}

func TestValidateSessionReadOnlyClassifiesCacheFailuresAsTransient(t *testing.T) {
	userID := uuid.New()
	sessionID := uuid.NewString()
	readFailure := errors.New("redis unavailable")
	tests := []struct {
		name  string
		cache authCache
	}{
		{name: "cache missing", cache: nil},
		{name: "session read", cache: &authSessionFakeCache{errors: map[string]error{sessionKeyPrefix + sessionID: readFailure}}},
		{name: "invalidation read", cache: &authSessionFakeCache{
			values: map[string][]byte{sessionKeyPrefix + sessionID: authSessionJSON(t, userID, uuid.New(), time.Now())},
			errors: map[string]error{userSessionInvalidatedPrefix + userID.String(): readFailure},
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			err := (&AuthService{cache: testCase.cache}).ValidateSessionReadOnly(context.Background(), sessionID, userID, uuid.Nil)
			if !errors.Is(err, ErrAuthSessionUnavailable) {
				t.Fatalf("error = %v, want ErrAuthSessionUnavailable", err)
			}
		})
	}
}

func TestInvalidateUserSessionsCoversMaximumSessionLifetime(t *testing.T) {
	cache := &authSessionFakeCache{}
	service := &AuthService{cache: cache}
	userID := uuid.New()
	service.InvalidateUserSessions(userID)
	if cache.setCalls != 2 {
		t.Fatalf("set calls = %d, want 2", cache.setCalls)
	}
	if len(cache.setKeys) != 2 || cache.setKeys[0] != userInvalidatedPrefix+userID.String() || cache.setTTLs[0] != jwtAccessTTL {
		t.Fatalf("legacy JWT invalidation changed: keys=%v ttls=%v", cache.setKeys, cache.setTTLs)
	}
	if cache.setKeys[1] != userSessionInvalidatedPrefix+userID.String() || cache.setTTLs[1] != refreshTokenTTL {
		t.Fatalf("session generation invalidation mismatch: keys=%v ttls=%v", cache.setKeys, cache.setTTLs)
	}
}

func TestCreateSessionCopiesCurrentInvalidationGeneration(t *testing.T) {
	userID := uuid.New()
	accountID := uuid.New()
	marker := []byte("generation-created-in-the-same-second")
	cache := &authSessionFakeCache{values: map[string][]byte{
		userSessionInvalidatedPrefix + userID.String(): marker,
	}}
	service := &AuthService{cache: cache}
	sessionID, _, err := service.createSession(context.Background(), userID, accountID, "tester", 45)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	var stored authSessionData
	if err := json.Unmarshal(cache.values[sessionKeyPrefix+sessionID], &stored); err != nil {
		t.Fatalf("decode stored session: %v", err)
	}
	if stored.InvalidationMarker != string(marker) {
		t.Fatalf("stored marker = %q, want %q", stored.InvalidationMarker, marker)
	}
	if err := service.ValidateSessionReadOnly(context.Background(), sessionID, userID, uuid.Nil); err != nil {
		t.Fatalf("new session with current generation rejected: %v", err)
	}
}

func TestSessionDeadlinesExpireAtTheExactBoundary(t *testing.T) {
	now := time.Date(2026, 11, 5, 18, 0, 0, 0, time.UTC)
	short := &authSessionData{CreatedAt: now.Unix(), LastSeen: now.Unix(), IdleTimeoutMinutes: 5}
	long := &authSessionData{CreatedAt: now.Unix(), LastSeen: now.Unix(), IdleTimeoutMinutes: 1440}
	legacy := &authSessionData{CreatedAt: now.Unix(), LastSeen: now.Unix()}
	if err := short.validateTime(now.Add(5*time.Minute - time.Nanosecond)); err != nil {
		t.Fatalf("session expired before deadline: %v", err)
	}
	if err := short.validateTime(now.Add(5 * time.Minute)); !errors.Is(err, ErrAuthSessionIdleExpired) {
		t.Fatalf("short policy did not expire at deadline: %v", err)
	}
	if err := long.validateTime(now.Add(5 * time.Minute)); err != nil {
		t.Fatalf("short policy leaked into the longer session: %v", err)
	}
	if err := legacy.validateTime(now.Add(30 * time.Minute)); !errors.Is(err, ErrAuthSessionIdleExpired) {
		t.Fatalf("legacy session lost default policy: %v", err)
	}
	absolute := now.Add(AuthSessionAbsoluteLifetime)
	long.LastSeen = absolute.Add(-time.Minute).Unix()
	if err := long.validateTime(absolute); !errors.Is(err, ErrAuthSessionExpired) || errors.Is(err, ErrAuthSessionIdleExpired) {
		t.Fatalf("activity bypassed absolute deadline: %v", err)
	}
}

func TestRecordSessionActivityUsesCanonicalScopeAndNeverResurrectsSession(t *testing.T) {
	userID, accountID := uuid.New(), uuid.New()
	sessionID := uuid.NewString()
	claims := &JWTClaims{SessionID: sessionID, UserID: userID, AccountID: accountID}
	before := time.Now().Add(-time.Minute).Truncate(time.Second)
	base := authSessionData{
		UserID: userID.String(), AccountID: accountID.String(), IdleTimeoutMinutes: 45,
		CreatedAt: before.Unix(), LastSeen: before.Unix(), InvalidationMarker: "generation",
	}
	raw, _ := json.Marshal(base)
	scope := base.snapshot(sessionID, accountID).Scope
	sessionKey, markerKey := sessionKeyPrefix+sessionID, userSessionInvalidatedPrefix+userID.String()

	for _, tc := range []struct {
		name  string
		scope string
		race  string
		want  error
	}{
		{name: "interaction renews the configured timeout", scope: scope},
		{name: "stale tab cannot renew", scope: "previous", want: ErrAuthSessionScopeChanged},
		{name: "revoked during compare-and-set", scope: scope, race: "revoked", want: ErrAuthSessionExpired},
		{name: "logout during compare-and-set", scope: scope, race: "logout", want: ErrAuthSessionExpired},
		{name: "store outage", scope: scope, race: "outage", want: ErrAuthSessionUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &authSessionFakeCache{values: map[string][]byte{sessionKey: raw, markerKey: []byte("generation")}}
			switch tc.race {
			case "revoked":
				store.beforeAuthWrite = func() { store.values[markerKey] = []byte("new-generation") }
			case "logout":
				store.beforeAuthWrite = func() { delete(store.values, sessionKey) }
			case "outage":
				store.authWriteError = errors.New("redis unavailable")
			}
			snapshot, err := (&AuthService{cache: store}).RecordSessionActivity(context.Background(), claims, tc.scope)
			if !errors.Is(err, tc.want) {
				t.Fatalf("activity error = %v, want %v", err, tc.want)
			}
			if tc.want != nil {
				if store.setCalls != 0 {
					t.Fatal("failed activity changed the stored session")
				}
				return
			}
			if store.setCalls != 1 || snapshot.Scope != scope || snapshot.IdleTimeoutMinutes != 45 ||
				!snapshot.IdleExpiresAt.After(base.idleDeadline()) || !snapshot.AbsoluteExpiresAt.Equal(base.absoluteDeadline()) {
				t.Fatalf("unexpected renewal: sets=%d snapshot=%+v", store.setCalls, snapshot)
			}
		})
	}
}

func TestRefreshTokenRejectsInvalidatedSessionBeforeRotation(t *testing.T) {
	userID := uuid.New()
	accountID := uuid.New()
	sessionID := uuid.NewString()
	refreshToken := uuid.NewString()
	sessionRaw := authSessionJSON(t, userID, accountID, time.Now())
	var session authSessionData
	if err := json.Unmarshal(sessionRaw, &session); err != nil {
		t.Fatal(err)
	}
	session.InvalidationMarker = "old-generation"
	sessionRaw, _ = json.Marshal(session)
	refreshRaw, _ := json.Marshal(refreshTokenData{
		UserID: userID.String(), AccountID: accountID.String(), Username: "tester",
		SessionID: sessionID, CreatedAt: session.CreatedAt,
	})
	cache := &authSessionFakeCache{values: map[string][]byte{
		refreshTokenKeyPrefix + refreshToken:           refreshRaw,
		sessionKeyPrefix + sessionID:                   sessionRaw,
		userSessionInvalidatedPrefix + userID.String(): []byte("new-generation"),
	}}
	service := &AuthService{cache: cache}
	if _, _, _, err := service.RefreshToken(context.Background(), refreshToken, "unused-secret"); err == nil {
		t.Fatal("refresh rotated an invalidated session")
	}
	if cache.setCalls != 0 {
		t.Fatalf("invalidated refresh performed %d SET calls", cache.setCalls)
	}
	if cache.delCalls != 0 {
		t.Fatalf("terminal refresh deleted %d tokens; it could erase a concurrent rotation marker", cache.delCalls)
	}
}

func TestRefreshTokenPreservesCredentialWhenSessionStoreIsUnavailable(t *testing.T) {
	userID := uuid.New()
	accountID := uuid.New()
	sessionID := uuid.NewString()
	refreshToken := uuid.NewString()
	refreshRaw, _ := json.Marshal(refreshTokenData{
		UserID: userID.String(), AccountID: accountID.String(), Username: "tester",
		SessionID: sessionID, CreatedAt: time.Now().Unix(),
	})
	cache := &authSessionFakeCache{
		values: map[string][]byte{refreshTokenKeyPrefix + refreshToken: refreshRaw},
		errors: map[string]error{sessionKeyPrefix + sessionID: errors.New("redis unavailable")},
	}
	service := &AuthService{cache: cache}
	if _, _, _, err := service.RefreshToken(context.Background(), refreshToken, "unused-secret"); !errors.Is(err, ErrAuthSessionUnavailable) {
		t.Fatalf("error = %v, want ErrAuthSessionUnavailable", err)
	}
	if cache.delCalls != 0 || cache.setCalls != 0 {
		t.Fatalf("transient refresh mutated credentials: del=%d set=%d", cache.delCalls, cache.setCalls)
	}
}

func TestRefreshTokenClassifiesCredentialStoreFailureAsUnavailable(t *testing.T) {
	refreshToken := uuid.NewString()
	cache := &authSessionFakeCache{errors: map[string]error{
		refreshTokenKeyPrefix + refreshToken: errors.New("redis unavailable"),
	}}
	service := &AuthService{cache: cache}
	if _, _, _, err := service.RefreshToken(context.Background(), refreshToken, "unused-secret"); !errors.Is(err, ErrAuthSessionUnavailable) {
		t.Fatalf("error = %v, want ErrAuthSessionUnavailable", err)
	}
	if cache.delCalls != 0 || cache.setCalls != 0 {
		t.Fatalf("credential store outage mutated credentials: del=%d set=%d", cache.delCalls, cache.setCalls)
	}
}

func TestReplaceRefreshCredentialKeepsDeadlineAndConsumesOldScope(t *testing.T) {
	userID, accountID, targetID := uuid.New(), uuid.New(), uuid.New()
	sourceID, targetSessionID := uuid.NewString(), uuid.NewString()
	oldToken, newToken := uuid.NewString(), uuid.NewString()
	created := time.Now().Add(-2 * time.Minute).Truncate(time.Second)
	seen := created.Add(time.Minute)
	source := authSessionData{UserID: userID.String(), AccountID: accountID.String(), CreatedAt: created.Unix(), LastSeen: seen.Unix(), IdleTimeoutMinutes: 60}
	sourceRaw, _ := json.Marshal(source)
	oldRaw := refreshCredentialJSON(t, userID, accountID, sourceID, created)
	for _, tc := range []struct {
		name          string
		switchAccount bool
		writeError    error
	}{
		{name: "refresh remains passive"},
		{name: "switch replaces the scope and preserves original login time", switchAccount: true},
		{name: "Redis failure preserves both prior credentials", switchAccount: true, writeError: errors.New("redis unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &authSessionFakeCache{
				values:         map[string][]byte{sessionKeyPrefix + sourceID: sourceRaw, refreshTokenKeyPrefix + oldToken: oldRaw},
				authWriteError: tc.writeError,
			}
			auth := &AuthService{cache: store}
			next := refreshTokenData{UserID: userID.String(), AccountID: accountID.String(), SessionID: sourceID, CreatedAt: created.Unix()}
			var replacement *authSessionData
			if tc.switchAccount {
				next.AccountID, next.SessionID = targetID.String(), targetSessionID
				copy := source
				copy.AccountID, copy.IdleTimeoutMinutes = targetID.String(), 5
				replacement = &copy
			}
			snapshot, err := auth.replaceRefreshCredential(context.Background(), oldToken, newToken, oldRaw, next, sourceID, accountID, replacement)
			if tc.writeError != nil {
				if !errors.Is(err, ErrAuthSessionUnavailable) ||
					!bytes.Equal(store.values[sessionKeyPrefix+sourceID], sourceRaw) ||
					!bytes.Equal(store.values[refreshTokenKeyPrefix+oldToken], oldRaw) ||
					store.values[refreshTokenKeyPrefix+newToken] != nil {
					t.Fatalf("failed rotation mutated authority: %v", err)
				}
				return
			}
			if err != nil || !snapshot.AbsoluteExpiresAt.Equal(source.absoluteDeadline()) {
				t.Fatalf("rotate refresh: snapshot=%+v err=%v", snapshot, err)
			}
			if _, _, err := auth.readRefreshCredential(context.Background(), oldToken); !errors.Is(err, ErrAuthSessionScopeChanged) {
				t.Fatalf("old credential is not marked consumed: %v", err)
			}
			if tc.switchAccount {
				if store.values[sessionKeyPrefix+sourceID] != nil || snapshot.AccountID != targetID || snapshot.IdleTimeoutMinutes != 5 {
					t.Fatalf("old account scope survived switch: snapshot=%+v", snapshot)
				}
			} else if !bytes.Equal(store.values[sessionKeyPrefix+sourceID], sourceRaw) || !snapshot.IdleExpiresAt.Equal(source.idleDeadline()) {
				t.Fatalf("passive refresh changed deadline: snapshot=%+v", snapshot)
			}
		})
	}
}
