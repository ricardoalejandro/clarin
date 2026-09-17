package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

const (
	IdleTimeout      = 30 * time.Minute
	HeartbeatTimeout = 90 * time.Second
	ReapInterval     = 5 * time.Second
)

var (
	ErrExpired         = errors.New("session_expired")
	ErrIdentityChanged = errors.New("identity_changed")
	ErrInvalid         = errors.New("invalid_session")
)

type Issued struct {
	SessionID     string    `json:"session_id"`
	Capability    string    `json:"capability"`
	ProfileEpoch  int64     `json:"profile_epoch"`
	IdleExpiresAt time.Time `json:"idle_expires_at"`
}

type Snapshot struct {
	SessionID    string
	BrowserID    string
	Tuple        model.Tuple
	Actions      []string
	Lease        model.LeaseClaims
	ProfileEpoch int64
	Secrets      *cryptokit.GrantSecrets
}

type Access struct {
	manager *Manager
	session *activeSession
	Snapshot
	once sync.Once
}

func (a *Access) Release() {
	if a == nil {
		return
	}
	a.once.Do(func() { a.manager.release(a.session) })
}

type activeSession struct {
	id                string
	browserID         string
	tuple             model.Tuple
	actions           []string
	lease             model.LeaseClaims
	profileEpoch      int64
	capabilityHash    [32]byte
	secrets           *cryptokit.GrantSecrets
	openedAt          time.Time
	lastActivity      time.Time
	heartbeats        map[string]time.Time
	activitySequences map[string]uint64
	references        int
	closing           bool
}

type Manager struct {
	mu        sync.Mutex
	byHash    map[[32]byte]*activeSession
	byBrowser map[string]*activeSession
	now       func() time.Time
	closed    bool
}

func NewManager() *Manager {
	return &Manager{byHash: make(map[[32]byte]*activeSession), byBrowser: make(map[string]*activeSession), now: time.Now}
}

func (m *Manager) Open(browserID string, tuple model.Tuple, actions []string, lease model.LeaseClaims, profileEpoch int64, secrets *cryptokit.GrantSecrets) (Issued, error) {
	if m == nil || secrets == nil || tuple.Validate() != nil || browserID != tuple.BrowserProfileID || profileEpoch < 1 || model.ValidateActions(actions) != nil {
		return Issued{}, ErrInvalid
	}
	rawCapability := make([]byte, 32)
	if _, err := rand.Read(rawCapability); err != nil {
		return Issued{}, err
	}
	capability := base64.RawURLEncoding.EncodeToString(rawCapability)
	hash := sha256.Sum256([]byte(capability))
	for index := range rawCapability {
		rawCapability[index] = 0
	}
	now := m.now().UTC()
	active := &activeSession{
		id: uuid.NewString(), browserID: browserID, tuple: tuple, actions: append([]string(nil), actions...), lease: lease,
		profileEpoch: profileEpoch, capabilityHash: hash, secrets: secrets, openedAt: now, lastActivity: now, heartbeats: make(map[string]time.Time), activitySequences: make(map[string]uint64),
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		secrets.Destroy()
		return Issued{}, ErrExpired
	}
	if prior := m.byBrowser[browserID]; prior != nil {
		m.closeLocked(prior)
	}
	m.byHash[hash], m.byBrowser[browserID] = active, active
	return Issued{SessionID: active.id, Capability: capability, ProfileEpoch: profileEpoch, IdleExpiresAt: now.Add(IdleTimeout)}, nil
}

func (m *Manager) Acquire(capability, browserID string, profileEpoch int64) (*Access, error) {
	if capability == "" || browserID == "" {
		return nil, ErrInvalid
	}
	hash := sha256.Sum256([]byte(capability))
	m.mu.Lock()
	defer m.mu.Unlock()
	active := m.byHash[hash]
	if active == nil || active.closing {
		return nil, ErrExpired
	}
	if active.browserID != browserID || active.profileEpoch != profileEpoch {
		return nil, ErrIdentityChanged
	}
	now := m.now().UTC()
	if m.expiredLocked(active, now) {
		m.closeLocked(active)
		return nil, ErrExpired
	}
	active.references++
	return &Access{manager: m, session: active, Snapshot: Snapshot{
		SessionID: active.id, BrowserID: active.browserID, Tuple: active.tuple, Actions: append([]string(nil), active.actions...), Lease: active.lease,
		ProfileEpoch: active.profileEpoch, Secrets: active.secrets,
	}}, nil
}

// AcquireGrant is reserved for trusted in-process reconciliation after the
// transport stores a signed envelope. It never crosses the loopback API and
// never creates a new session; without an already-unlocked matching grant it
// returns ErrExpired and the ciphertext remains sealed until the next unlock.
func (m *Manager) AcquireGrant(grantID string) (*Access, error) {
	if grantID == "" {
		return nil, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, active := range m.byBrowser {
		if active.tuple.GrantID != grantID || active.closing {
			continue
		}
		now := m.now().UTC()
		if m.expiredLocked(active, now) {
			m.closeLocked(active)
			return nil, ErrExpired
		}
		active.references++
		return &Access{manager: m, session: active, Snapshot: Snapshot{
			SessionID: active.id, BrowserID: active.browserID, Tuple: active.tuple, Actions: append([]string(nil), active.actions...), Lease: active.lease,
			ProfileEpoch: active.profileEpoch, Secrets: active.secrets,
		}}, nil
	}
	return nil, ErrExpired
}

func (m *Manager) Heartbeat(capability, browserID string, profileEpoch int64, sessionID, clientInstanceID string, activitySequence ...uint64) (time.Time, error) {
	if parsed, err := uuid.Parse(clientInstanceID); err != nil || parsed.String() != clientInstanceID {
		return time.Time{}, ErrInvalid
	}
	var sequence uint64
	if len(activitySequence) > 1 {
		return time.Time{}, ErrInvalid
	}
	if len(activitySequence) == 1 {
		sequence = activitySequence[0]
	}
	if sequence > 9007199254740991 {
		return time.Time{}, ErrInvalid
	}
	access, err := m.Acquire(capability, browserID, profileEpoch)
	if err != nil {
		return time.Time{}, err
	}
	defer access.Release()
	if access.SessionID != sessionID {
		return time.Time{}, ErrIdentityChanged
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if access.session.closing {
		return time.Time{}, ErrExpired
	}
	if _, known := access.session.activitySequences[clientInstanceID]; !known && len(access.session.activitySequences) >= 16 {
		return time.Time{}, ErrInvalid
	}
	now := m.now().UTC()
	if m.expiredLocked(access.session, now) {
		m.closeLocked(access.session)
		return time.Time{}, ErrExpired
	}
	access.session.heartbeats[clientInstanceID] = now
	// Liveness and user interaction are separate. Ordinary reads, transport
	// reconciliation, visibility changes and repeated polls cannot keep an
	// unattended unlocked vault alive. This is a client activity signal, not
	// trusted hardware evidence that a human interacted with the browser.
	if sequence > access.session.activitySequences[clientInstanceID] {
		access.session.lastActivity = now
		access.session.activitySequences[clientInstanceID] = sequence
	} else if _, known := access.session.activitySequences[clientInstanceID]; !known {
		access.session.activitySequences[clientInstanceID] = 0
	}
	return access.session.lastActivity.Add(IdleTimeout), nil
}

func (m *Manager) LockBrowser(browserID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if active := m.byBrowser[browserID]; active != nil {
		m.closeLocked(active)
	}
}

// RenewGrantLease extends only an already-open in-memory session for the same
// immutable tuple. It never creates a capability and never opens grant keys.
func (m *Manager) RenewGrantLease(grantID string, lease model.LeaseClaims) error {
	if grantID == "" || lease.Tuple.Validate() != nil || lease.GrantID != grantID {
		return ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, active := range m.byBrowser {
		if active.tuple.GrantID != grantID || active.closing {
			continue
		}
		if !active.tuple.Equal(lease.Tuple) || lease.ExpiresAt < active.lease.ExpiresAt {
			return ErrIdentityChanged
		}
		active.lease = lease
		return nil
	}
	return nil
}

func (m *Manager) Sweep() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now().UTC()
	closed := 0
	for _, active := range m.byBrowser {
		if m.expiredLocked(active, now) {
			m.closeLocked(active)
			closed++
		}
	}
	return closed
}

// RunReaper guarantees that expired in-memory keys are destroyed even when
// the browser is closed and no later request arrives to observe the expiry.
// It returns only after cancellation and never owns the Manager lifecycle.
func (m *Manager) RunReaper(ctx context.Context) {
	ticker := time.NewTicker(ReapInterval)
	defer ticker.Stop()
	m.runReaper(ctx, ticker.C)
}

func (m *Manager) runReaper(ctx context.Context, ticks <-chan time.Time) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			m.Sweep()
		}
	}
}

func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for _, active := range m.byBrowser {
		m.closeLocked(active)
	}
}

func (m *Manager) release(active *activeSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if active.references > 0 {
		active.references--
	}
	if active.closing && active.references == 0 && active.secrets != nil {
		active.secrets.Destroy()
		active.secrets = nil
	}
}

func (m *Manager) closeLocked(active *activeSession) {
	if active == nil || active.closing {
		return
	}
	active.closing = true
	delete(m.byHash, active.capabilityHash)
	if m.byBrowser[active.browserID] == active {
		delete(m.byBrowser, active.browserID)
	}
	if active.references == 0 && active.secrets != nil {
		active.secrets.Destroy()
		active.secrets = nil
	}
}

func (m *Manager) expiredLocked(active *activeSession, now time.Time) bool {
	if active.closing || !now.Before(active.lastActivity.Add(IdleTimeout)) || now.Unix() >= active.lease.ExpiresAt {
		return true
	}
	if len(active.heartbeats) == 0 {
		return now.After(active.openedAt.Add(HeartbeatTimeout))
	}
	latest := time.Time{}
	for clientID, seenAt := range active.heartbeats {
		if now.After(seenAt.Add(HeartbeatTimeout)) {
			delete(active.heartbeats, clientID)
			continue
		}
		if seenAt.After(latest) {
			latest = seenAt
		}
	}
	return latest.IsZero()
}
