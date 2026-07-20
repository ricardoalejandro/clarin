package whatsappcloud

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
)

const tokenCipherVersion byte = 1

// TokenCipher encrypts Meta business tokens before they are persisted. The
// key stays in runtime configuration and ciphertexts are bound to a Clarin
// account/device pair through authenticated additional data.
type TokenCipher struct {
	aead cipher.AEAD
}

func NewTokenCipher(encodedKey string) (*TokenCipher, error) {
	encodedKey = strings.TrimSpace(encodedKey)
	if encodedKey == "" {
		return nil, errors.New("WhatsApp Cloud token encryption key is not configured")
	}
	key, err := decodeKey(encodedKey)
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("WhatsApp Cloud token encryption key must decode to 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create token cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create token GCM: %w", err)
	}
	return &TokenCipher{aead: aead}, nil
}

func decodeKey(value string) ([]byte, error) {
	encodings := []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	}
	for _, encoding := range encodings {
		if key, err := encoding.DecodeString(value); err == nil {
			return key, nil
		}
	}
	return nil, errors.New("WhatsApp Cloud token encryption key must be base64 encoded")
}

func (c *TokenCipher) Seal(token string, additionalData []byte) ([]byte, error) {
	if c == nil || c.aead == nil {
		return nil, errors.New("token cipher is unavailable")
	}
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("cannot encrypt an empty token")
	}
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate token nonce: %w", err)
	}
	sealed := c.aead.Seal(nil, nonce, []byte(token), additionalData)
	result := make([]byte, 1+len(nonce)+len(sealed))
	result[0] = tokenCipherVersion
	copy(result[1:], nonce)
	copy(result[1+len(nonce):], sealed)
	return result, nil
}

func (c *TokenCipher) Open(ciphertext, additionalData []byte) (string, error) {
	if c == nil || c.aead == nil {
		return "", errors.New("token cipher is unavailable")
	}
	minimumLength := 1 + c.aead.NonceSize() + c.aead.Overhead()
	if len(ciphertext) < minimumLength || ciphertext[0] != tokenCipherVersion {
		return "", errors.New("invalid encrypted token")
	}
	nonceEnd := 1 + c.aead.NonceSize()
	plain, err := c.aead.Open(nil, ciphertext[1:nonceEnd], ciphertext[nonceEnd:], additionalData)
	if err != nil {
		return "", errors.New("encrypted token authentication failed")
	}
	return string(plain), nil
}
