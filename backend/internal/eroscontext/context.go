package eroscontext

import (
	"errors"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const Audience = "clarin-eros-mcp"

// Claims binds a single Eros execution to one cuenta and one user. The token is
// short-lived and is never returned to the browser.
type Claims struct {
	RunID       string   `json:"run_id,omitempty"`
	AccountID   string   `json:"account_id"`
	UserID      string   `json:"user_id"`
	Permissions []string `json:"permissions,omitempty"`
	Legacy      bool     `json:"legacy,omitempty"`
	jwt.RegisteredClaims
}

func Sign(secret string, runID, accountID, userID uuid.UUID, permissions []string, legacy bool, ttl time.Duration) (string, error) {
	if strings.TrimSpace(secret) == "" || accountID == uuid.Nil || userID == uuid.Nil {
		return "", errors.New("invalid Eros context signing input")
	}
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	now := time.Now().UTC()
	claims := Claims{
		AccountID:   accountID.String(),
		UserID:      userID.String(),
		Permissions: append([]string(nil), permissions...),
		Legacy:      legacy,
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{Audience},
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now.Add(-15 * time.Second)),
			ID:        uuid.NewString(),
		},
	}
	if runID != uuid.Nil {
		claims.RunID = runID.String()
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

func Parse(secret, raw string) (*Claims, error) {
	if strings.TrimSpace(secret) == "" || strings.TrimSpace(raw) == "" {
		return nil, errors.New("missing Eros context")
	}
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("invalid Eros context algorithm")
		}
		return []byte(secret), nil
	}, jwt.WithAudience(Audience), jwt.WithExpirationRequired())
	if err != nil || !token.Valid {
		return nil, errors.New("invalid or expired Eros context")
	}
	if _, err := uuid.Parse(claims.AccountID); err != nil {
		return nil, errors.New("invalid Eros account context")
	}
	if _, err := uuid.Parse(claims.UserID); err != nil {
		return nil, errors.New("invalid Eros user context")
	}
	if _, err := uuid.Parse(claims.RunID); err != nil {
		return nil, errors.New("invalid Eros run context")
	}
	return claims, nil
}

func HasPermission(claims *Claims, permission string) bool {
	if claims == nil {
		return false
	}
	for _, value := range claims.Permissions {
		if value == "*" || value == permission {
			return true
		}
	}
	return false
}
