package bridge

import (
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"
)

type noncePool struct {
	mu     sync.Mutex
	values map[string]time.Time
	now    func() time.Time
}

func newNoncePool() *noncePool {
	return &noncePool{values: make(map[string]time.Time), now: time.Now}
}

func (p *noncePool) issue() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return ""
	}
	value := base64.RawURLEncoding.EncodeToString(raw)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sweepLocked()
	if len(p.values) >= 512 {
		for nonce := range p.values {
			delete(p.values, nonce)
			break
		}
	}
	p.values[value] = p.now().UTC().Add(2 * time.Minute)
	return value
}

func (p *noncePool) accepts(value string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sweepLocked()
	expiresAt, ok := p.values[value]
	return ok && expiresAt.After(p.now().UTC())
}

func (p *noncePool) sweepLocked() {
	now := p.now().UTC()
	for value, expiresAt := range p.values {
		if !expiresAt.After(now) {
			delete(p.values, value)
		}
	}
}
