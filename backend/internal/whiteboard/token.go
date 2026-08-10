package whiteboard

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const (
	ShareSecretBytes     = 32
	DefaultLinkLifetime  = 7 * 24 * time.Hour
	DefaultGuestLifetime = 12 * time.Hour
	MaxGuestDisplayName  = 120
)

var ErrInvalidGuestDisplayName = errors.New("invalid whiteboard guest display name")

func NewSecret() (plain, hash string, err error) {
	buffer := make([]byte, ShareSecretBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", "", err
	}
	plain = base64.RawURLEncoding.EncodeToString(buffer)
	return plain, HashSecret(plain), nil
}

func HashSecret(secret string) string {
	digest := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(digest[:])
}

func SecretMatches(storedHash, candidate string) bool {
	decoded, err := hex.DecodeString(storedHash)
	if err != nil || len(decoded) != sha256.Size {
		return false
	}
	digest := sha256.Sum256([]byte(candidate))
	return subtle.ConstantTimeCompare(decoded, digest[:]) == 1
}

func NormalizeGuestDisplayName(raw string) (string, error) {
	name := strings.Join(strings.Fields(strings.TrimSpace(raw)), " ")
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > MaxGuestDisplayName {
		return "", ErrInvalidGuestDisplayName
	}
	return name, nil
}

func HashOptionalPassword(password string) (string, error) {
	password = strings.TrimSpace(password)
	if password == "" {
		return "", nil
	}
	if len(password) < 8 || len(password) > 200 {
		return "", errors.New("whiteboard link password must contain 8 to 200 bytes")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(hash), err
}

func PasswordMatches(storedHash, candidate string) bool {
	if storedHash == "" {
		return true
	}
	return bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(candidate)) == nil
}

func GuestSessionExpiry(now time.Time, linkExpiry *time.Time) time.Time {
	expires := now.Add(DefaultGuestLifetime)
	if linkExpiry != nil && linkExpiry.Before(expires) {
		return *linkExpiry
	}
	return expires
}
