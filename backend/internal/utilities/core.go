// Package utilities owns personal utility documents and protected key material.
package utilities

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/google/uuid"
)

const DocumentLimit = 60 * 1024 * 1024
const SecretLimit = 1024 * 1024
const ConfigLimit = 64 * 1024

var (
	ErrMissing          = errors.New("utility not found")
	ErrConflict         = errors.New("utility version conflict")
	ErrInvalid          = errors.New("invalid utility request")
	ErrQuota            = errors.New("utility storage quota exceeded")
	ErrVaultUnavailable = errors.New("utility vault unavailable")
)

type Edit struct {
	Offset      int    `json:"offset"`
	DeleteCount int    `json:"delete_count"`
	Text        string `json:"text"`
}

// ApplyEdits follows Monaco's UTF-16 offsets, rejects split surrogate pairs and
// treats a batch as simultaneous, non-overlapping edits against one revision.
func ApplyEdits(source string, edits []Edit) (string, error) {
	if len(edits) == 0 || len(edits) > 10000 {
		return "", ErrInvalid
	}
	edits = append([]Edit(nil), edits...)
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].Offset < edits[j].Offset })
	boundaries := make(map[int]int, len(edits)*2)
	for _, e := range edits {
		if e.Offset < 0 || e.DeleteCount < 0 || e.Offset > int(^uint(0)>>1)-e.DeleteCount || !utf8.ValidString(e.Text) || strings.IndexByte(e.Text, 0) >= 0 {
			return "", ErrInvalid
		}
		boundaries[e.Offset] = -1
		boundaries[e.Offset+e.DeleteCount] = -1
	}
	units := 0
	for pos, r := range source {
		if _, ok := boundaries[units]; ok {
			boundaries[units] = pos
		}
		if r > 0xffff {
			units += 2
		} else {
			units++
		}
	}
	if _, ok := boundaries[units]; ok {
		boundaries[units] = len(source)
	}
	var out strings.Builder
	previous, bytes := 0, len(source)
	for _, e := range edits {
		start, a := boundaries[e.Offset]
		end, b := boundaries[e.Offset+e.DeleteCount]
		if !a || !b || start < previous || start < 0 || end < 0 {
			return "", ErrInvalid
		}
		bytes += len(e.Text) - (end - start)
		if bytes > DocumentLimit {
			return "", ErrInvalid
		}
		previous = end
	}
	if bytes > DocumentLimit {
		return "", ErrInvalid
	}
	out.Grow(bytes)
	previous = 0
	for _, e := range edits {
		start, end := boundaries[e.Offset], boundaries[e.Offset+e.DeleteCount]
		out.WriteString(source[previous:start])
		out.WriteString(e.Text)
		previous = end
	}
	out.WriteString(source[previous:])
	return out.String(), nil
}

func validType(kind string) bool {
	return kind == "json" || kind == "qr" || kind == "imagen-base64" || kind == "criptografia"
}
func validSlot(slot string) bool {
	if len(slot) == 0 || len(slot) > 32 {
		return false
	}
	for _, c := range slot {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}
func validName(s string, limit int) bool {
	return utf8.ValidString(s) && strings.IndexByte(s, 0) < 0 && utf8.RuneCountInString(strings.TrimSpace(s)) > 0 && utf8.RuneCountInString(s) <= limit
}
func validateConfig(kind string, raw json.RawMessage) error {
	if len(raw) > ConfigLimit {
		return ErrInvalid
	}
	var value map[string]json.RawMessage
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return ErrInvalid
	}
	if kind == "criptografia" {
		allowed := map[string]string{
			"active": "cipher|hash|keys|base64|vault", "cipher_mode": "encrypt|decrypt", "cipher_algorithm": "aes128|aes256|rsa",
			"hash_mode": "hash|hmac", "hash_algorithm": "SHA-256|SHA-384|SHA-512", "hash_format": "hex|base64",
			"base64_mode": "encode|decode", "base64_format": "base64|base64url", "base64_output": "text|binary",
		}
		for key, raw := range value {
			var selected string
			if key == "key_id" && string(raw) == "null" {
				continue
			}
			if json.Unmarshal(raw, &selected) != nil {
				return ErrInvalid
			}
			if key == "key_id" {
				if selected != "" {
					id, err := uuid.Parse(selected)
					if err != nil || id == uuid.Nil {
						return ErrInvalid
					}
				}
				continue
			}
			options, exists := allowed[key]
			if !exists {
				return ErrInvalid
			}
			found := false
			for _, option := range strings.Split(options, "|") {
				if selected == option {
					found = true
					break
				}
			}
			if !found {
				return ErrInvalid
			}
		}
	}
	return nil
}
func fingerprint(value any) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func escapedPattern(s string) string {
	return "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(s) + "%"
}

// SearchChunks deliberately overlaps by the largest accepted query so an
// occurrence that crosses the cut remains searchable without a giant tsvector.
func SearchChunks(s string) []string {
	const size, overlap = 8192, 128
	chunks := make([]string, 0, len(s)/size+1)
	for start := 0; start < len(s); {
		end := min(start+size, len(s))
		for end < len(s) && !utf8.RuneStart(s[end]) {
			end--
		}
		chunks = append(chunks, s[start:end])
		if end == len(s) {
			break
		}
		start = end
		for n := 0; n < overlap && start > 0; n++ {
			_, width := utf8.DecodeLastRuneInString(s[:start])
			start -= width
		}
	}
	return chunks
}

// Cipher uses independent per-entry data keys and a versioned master key ring.
// Master keys are runtime secrets, never database records or JWT-derived keys.
type Cipher struct {
	current string
	keys    map[string]cipher.AEAD
}

func NewCipher(current, encoded string) (*Cipher, error) {
	if current == "" || encoded == "" {
		return nil, ErrVaultUnavailable
	}
	var values map[string]string
	if json.Unmarshal([]byte(encoded), &values) != nil {
		return nil, ErrVaultUnavailable
	}
	c := &Cipher{current: current, keys: make(map[string]cipher.AEAD)}
	for id, value := range values {
		key, err := base64.StdEncoding.DecodeString(value)
		if err != nil || len(key) != 32 || len(id) > 64 {
			return nil, ErrVaultUnavailable
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		c.keys[id] = aead
	}
	if c.keys[current] == nil {
		return nil, ErrVaultUnavailable
	}
	return c, nil
}
func aad(account, owner, id uuid.UUID) []byte {
	return []byte("clarin.utility.vault.v1|" + account.String() + "|" + owner.String() + "|" + id.String())
}
func seal(a cipher.AEAD, plain, context []byte) ([]byte, error) {
	nonce := make([]byte, a.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return a.Seal(nonce, nonce, plain, context), nil
}
func open(a cipher.AEAD, encoded, context []byte) ([]byte, error) {
	if a == nil || len(encoded) < a.NonceSize()+a.Overhead() {
		return nil, ErrVaultUnavailable
	}
	return a.Open(nil, encoded[:a.NonceSize()], encoded[a.NonceSize():], context)
}
func (c *Cipher) Seal(account, owner, id uuid.UUID, plain []byte) (keyID string, wrapped, body []byte, err error) {
	if c == nil {
		return "", nil, nil, ErrVaultUnavailable
	}
	dataKey := make([]byte, 32)
	if _, err = rand.Read(dataKey); err != nil {
		return
	}
	defer clear(dataKey)
	block, _ := aes.NewCipher(dataKey)
	dataCipher, _ := cipher.NewGCM(block)
	context := aad(account, owner, id)
	wrapped, err = seal(c.keys[c.current], dataKey, append(context, []byte("|key")...))
	if err != nil {
		return
	}
	body, err = seal(dataCipher, plain, context)
	return c.current, wrapped, body, err
}
func (c *Cipher) Open(account, owner, id uuid.UUID, keyID string, wrapped, body []byte) ([]byte, error) {
	if c == nil {
		return nil, ErrVaultUnavailable
	}
	context := aad(account, owner, id)
	key, err := open(c.keys[keyID], wrapped, append(context, []byte("|key")...))
	if err != nil {
		return nil, ErrVaultUnavailable
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrVaultUnavailable
	}
	a, _ := cipher.NewGCM(block)
	result, err := open(a, body, context)
	if err != nil {
		return nil, ErrVaultUnavailable
	}
	return result, nil
}
func (c *Cipher) Rewrap(account, owner, id uuid.UUID, oldID string, wrapped []byte) (string, []byte, error) {
	if c == nil {
		return "", nil, ErrVaultUnavailable
	}
	context := append(aad(account, owner, id), []byte("|key")...)
	key, err := open(c.keys[oldID], wrapped, context)
	if err != nil {
		return "", nil, ErrVaultUnavailable
	}
	defer clear(key)
	encoded, err := seal(c.keys[c.current], key, context)
	return c.current, encoded, err
}

// UTF16Length is exported to test the wire contract shared with the editor.
func UTF16Length(s string) int {
	count := 0
	for _, r := range s {
		if utf16.IsSurrogate(r) {
			continue
		}
		if r > 0xffff {
			count += 2
		} else {
			count++
		}
	}
	return count
}

type cursor struct {
	Time string    `json:"t"`
	ID   uuid.UUID `json:"i"`
}

func encodeCursor(t string, id uuid.UUID) string {
	data, _ := json.Marshal(cursor{t, id})
	return base64.RawURLEncoding.EncodeToString(data)
}
func decodeCursor(s string) (cursor, error) {
	var c cursor
	if s == "" {
		return c, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || json.Unmarshal(data, &c) != nil || c.ID == uuid.Nil {
		return c, fmt.Errorf("%w: cursor", ErrInvalid)
	}
	return c, nil
}
