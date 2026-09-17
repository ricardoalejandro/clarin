package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/pkg/database"
	"golang.org/x/crypto/bcrypt"
)

func (c *authSessionFakeCache) IncrWithTTL(ctx context.Context, key string, ttl time.Duration) (int64, error) {
	var value int64
	_ = json.Unmarshal(c.values[key], &value)
	value++
	raw, _ := json.Marshal(value)
	return value, c.Set(ctx, key, raw, ttl)
}

func TestOfflineReauthIdentityCannotGrantAuthority(t *testing.T) {
	userID, accountID := uuid.New(), uuid.New()
	identity := OfflineReauthIdentity{UserID: userID, AccountID: accountID}
	for _, user := range []*domain.User{nil, {ID: userID}, {ID: uuid.New(), IsActive: true, IsSuperAdmin: true}} {
		if !errors.Is(identity.validateUser(user), ErrOfflineIdentityMismatch) {
			t.Fatal("unauthenticated or different identity accepted")
		}
	}
	if identity.validateUser(&domain.User{ID: userID, IsActive: true}) != nil {
		t.Fatal("exact active identity rejected")
	}
	if (OfflineReauthIdentity{UserID: userID}).validateUser(&domain.User{ID: userID, IsActive: true}) == nil {
		t.Fatal("missing account accepted")
	}
}

func TestOfflineReauthLoginRealPostgres(t *testing.T) {
	url := os.Getenv("OFFLINE_V3_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("OFFLINE_V3_TEST_DATABASE_URL is required")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := database.Migrate(pool); err != nil {
		t.Fatal(err)
	}
	userID, accountID, otherAccountID, foreignAccountID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	username := "reauth-" + userID.String()
	password := "synthetic-test-password-only"
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Reauth default'),($2,'Reauth selected'),($3,'Reauth foreign')`, accountID, otherAccountID, foreignAccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,display_name,role,is_active,is_admin,is_super_admin) VALUES($1,$2,$3,$4,$5,'QA reauth','agent',TRUE,FALSE,FALSE)`, userID, accountID, username, userID.String()+"@test.invalid", string(hash)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES($1,$2,'agent',TRUE),($1,$3,'agent',FALSE)`, userID, accountID, otherAccountID); err != nil {
		t.Fatal(err)
	}
	repos := repository.NewRepositories(pool)
	for _, test := range []struct {
		name, password    string
		userID, accountID uuid.UUID
		success           bool
		identityError     bool
	}{
		{"other actor", password, uuid.New(), accountID, false, true},
		{"no membership", password, userID, foreignAccountID, false, true},
		{"wrong password", "wrong", userID, otherAccountID, false, false},
		{"exact nondefault account", password, userID, otherAccountID, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			cache := &authSessionFakeCache{}
			service := &AuthService{repos: repos, cache: cache}
			token, refresh, user, _, _, err := service.Login(ctx, username, test.password, "qa-only-jwt-key", OfflineReauthIdentity{UserID: test.userID, AccountID: test.accountID})
			if (err == nil) != test.success {
				t.Fatalf("unexpected login result: %v", err)
			}
			if !test.success {
				if token != "" || refresh != "" || user != nil {
					t.Fatal("failed reauth issued credentials")
				}
				for _, key := range cache.setKeys {
					if strings.HasPrefix(key, sessionKeyPrefix) || strings.HasPrefix(key, refreshTokenKeyPrefix) {
						t.Fatal("failed reauth created a session")
					}
				}
				if errors.Is(err, ErrOfflineIdentityMismatch) != test.identityError {
					t.Fatalf("unexpected rejection type: %v", err)
				}
				return
			}
			if user.ID != userID || user.AccountID != otherAccountID || refresh == "" {
				t.Fatal("reauth silently selected another identity")
			}
			claims := &JWTClaims{}
			parsed, err := jwt.ParseWithClaims(token, claims, func(_ *jwt.Token) (any, error) { return []byte("qa-only-jwt-key"), nil }, jwt.WithValidMethods([]string{"HS256"}))
			if err != nil || !parsed.Valid || claims.UserID != userID || claims.AccountID != otherAccountID {
				t.Fatal("issued JWT has wrong account binding")
			}
		})
	}
	t.Run("provision verifies actual password and throttles durably without issuing a session", func(t *testing.T) {
		cache := &authSessionFakeCache{}
		service := &AuthService{repos: repos, cache: cache}
		if err := service.VerifyCurrentPassword(ctx, userID, password); err != nil {
			t.Fatal(err)
		}
		for index := 0; index < maxLoginAttempts; index++ {
			if err := service.VerifyCurrentPassword(ctx, userID, "wrong"); !errors.Is(err, ErrInvalidCurrentPassword) {
				t.Fatalf("wrong password attempt: %v", err)
			}
		}
		restarted := &AuthService{repos: repos, cache: cache}
		if err := restarted.VerifyCurrentPassword(ctx, userID, password); !errors.Is(err, ErrCurrentPasswordThrottled) {
			t.Fatalf("throttle did not survive service recreation: %v", err)
		}
		for _, key := range cache.setKeys {
			if strings.HasPrefix(key, sessionKeyPrefix) || strings.HasPrefix(key, refreshTokenKeyPrefix) {
				t.Fatal("password step-up created credentials")
			}
		}
		cache.errors = map[string]error{loginFailuresKeyPrefix + username: errors.New("cache down")}
		if err := restarted.VerifyCurrentPassword(ctx, userID, password); !errors.Is(err, ErrAuthSessionUnavailable) {
			t.Fatalf("cache failure did not fail closed: %v", err)
		}
	})
	if _, err := pool.Exec(ctx, `UPDATE accounts SET is_active=FALSE WHERE id=$1`, otherAccountID); err != nil {
		t.Fatal(err)
	}
	cache := &authSessionFakeCache{}
	service := &AuthService{repos: repos, cache: cache}
	if token, _, _, _, _, err := service.Login(ctx, username, password, "qa-only-jwt-key", OfflineReauthIdentity{UserID: userID, AccountID: otherAccountID}); !errors.Is(err, ErrOfflineIdentityMismatch) || token != "" || cache.setCalls != 0 {
		t.Fatalf("inactive account received a session: %v", err)
	}
}
