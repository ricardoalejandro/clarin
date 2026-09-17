package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"golang.org/x/crypto/bcrypt"
)

var ErrOfflineIdentityMismatch = errors.New("offline_identity_mismatch")
var ErrInvalidCurrentPassword = errors.New("invalid_current_password")
var ErrCurrentPasswordThrottled = errors.New("current_password_throttled")

// OfflineReauthIdentity only restricts an ordinary password-authenticated
// login. It is not proof of identity, membership, or permission, and can never
// create a session from an offline lease or a client-supplied account ID.
type OfflineReauthIdentity struct {
	UserID    uuid.UUID
	AccountID uuid.UUID
}

func (identity OfflineReauthIdentity) validateUser(user *domain.User) error {
	if identity.UserID == uuid.Nil || identity.AccountID == uuid.Nil || user == nil || !user.IsActive || user.ID != identity.UserID {
		return ErrOfflineIdentityMismatch
	}
	return nil
}

// VerifyCurrentPassword is a step-up check for an already authenticated actor.
// It issues no session, exposes no password verifier and never normalizes or
// changes membership. Provisioning must not silently use a typo as a new local
// password while telling the user it is their Clarin password.
func (s *AuthService) VerifyCurrentPassword(ctx context.Context, userID uuid.UUID, password string) error {
	if s.cache == nil || s.repos == nil {
		return ErrAuthSessionUnavailable
	}
	user, err := s.repos.User.GetByID(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && user == nil {
		return ErrInvalidCurrentPassword
	}
	if err != nil {
		return ErrAuthSessionUnavailable
	}
	failureKey := loginFailuresKeyPrefix + strings.ToLower(user.Username)
	raw, err := s.cache.Get(ctx, failureKey)
	if err != nil {
		return ErrAuthSessionUnavailable
	}
	var failures int
	if len(raw) > 0 && json.Unmarshal(raw, &failures) != nil {
		return ErrAuthSessionUnavailable
	}
	if failures >= maxLoginAttempts {
		return ErrCurrentPasswordThrottled
	}
	counter, ok := s.cache.(interface {
		IncrWithTTL(context.Context, string, time.Duration) (int64, error)
	})
	if !ok {
		return ErrAuthSessionUnavailable
	}
	// Reserve an attempt atomically before expensive verification, so concurrent
	// requests or multiple backend processes cannot reset/lower a Get/Set count.
	attempt, err := counter.IncrWithTTL(ctx, failureKey, loginLockoutTTL)
	if err != nil {
		return ErrAuthSessionUnavailable
	}
	if attempt > maxLoginAttempts {
		return ErrCurrentPasswordThrottled
	}
	if len(password) == 0 || len(password) > 1024 || !user.IsActive || bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return ErrInvalidCurrentPassword
	}
	if err := s.cache.Del(ctx, failureKey); err != nil {
		return ErrAuthSessionUnavailable
	}
	return nil
}
