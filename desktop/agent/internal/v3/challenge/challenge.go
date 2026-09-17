package challenge

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
)

var (
	ErrNotFound = errors.New("challenge_not_found")
	ErrExpired  = errors.New("challenge_expired")
	ErrConsumed = errors.New("challenge_consumed")
)

type Entry struct {
	ID          string
	Nonce       string
	Purpose     string
	BrowserID   string
	GrantID     string
	PrincipalID string
	ExpiresAt   time.Time
	Completed   bool
	Consumed    bool
}

type Manager struct {
	mu      sync.Mutex
	entries map[string]Entry
	now     func() time.Time
}

func NewManager() *Manager {
	return &Manager{entries: make(map[string]Entry), now: time.Now}
}

func (m *Manager) Create(purpose, browserID, grantID string, ttl time.Duration) (Entry, error) {
	if m == nil || purpose == "" || ttl <= 0 || ttl > 10*time.Minute {
		return Entry{}, errors.New("challenge parameters rejected")
	}
	nonceRaw := make([]byte, 32)
	if _, err := rand.Read(nonceRaw); err != nil {
		return Entry{}, err
	}
	now := m.now().UTC()
	entry := Entry{ID: uuid.NewString(), Nonce: base64.RawURLEncoding.EncodeToString(nonceRaw), Purpose: purpose, BrowserID: browserID, GrantID: grantID, ExpiresAt: now.Add(ttl)}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sweepLocked(now)
	if len(m.entries) >= 4096 {
		return Entry{}, errors.New("challenge capacity exhausted")
	}
	m.entries[entry.ID] = entry
	return entry, nil
}

func (m *Manager) Get(id, purpose string) (Entry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.getLocked(id, purpose, false)
}

func (m *Manager) Consume(id, purpose string) (Entry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, err := m.getLocked(id, purpose, true)
	if err != nil {
		return Entry{}, err
	}
	entry.Consumed = true
	m.entries[id] = entry
	return entry, nil
}

func (m *Manager) CompletePrincipal(id, principalID string) (Entry, error) {
	if principalID == "" {
		return Entry{}, errors.New("principal identity rejected")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, err := m.getLocked(id, "principal", true)
	if err != nil {
		return Entry{}, err
	}
	if entry.Completed {
		if entry.PrincipalID != principalID {
			return Entry{}, ErrConsumed
		}
		return entry, nil
	}
	entry.Completed = true
	entry.PrincipalID = principalID
	m.entries[id] = entry
	return entry, nil
}

func (m *Manager) getLocked(id, purpose string, allowCompleted bool) (Entry, error) {
	entry, ok := m.entries[id]
	if !ok || purpose == "" || entry.Purpose != purpose {
		return Entry{}, ErrNotFound
	}
	if !entry.ExpiresAt.After(m.now().UTC()) {
		delete(m.entries, id)
		return Entry{}, ErrExpired
	}
	if entry.Consumed || (!allowCompleted && entry.Completed && purpose != "principal") {
		return Entry{}, ErrConsumed
	}
	return entry, nil
}

func (m *Manager) sweepLocked(now time.Time) {
	for id, entry := range m.entries {
		if !entry.ExpiresAt.After(now) {
			delete(m.entries, id)
		}
	}
}
