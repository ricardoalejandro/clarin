package api

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"sync"
)

const storageFallbackCandidateLimit = 2000
const storageFallbackPayloadLimit int64 = 4 * 1024 * 1024

var errStorageIndexingBudget = errors.New("storage indexing read budget reached")

type storageReferenceReadBudgetKey struct{}
type storageReferenceReadBudget struct {
	candidates int
	bytes      int64
}

func (b *storageReferenceReadBudget) consume(size int64) bool {
	if size < 0 || b.candidates >= storageFallbackCandidateLimit || size > storageFallbackPayloadLimit-b.bytes {
		return false
	}
	b.candidates++
	b.bytes += size
	return true
}

// Only the non-authoritative /uses fallback acquires these slots. There is no
// wait queue and no tenant map retained after completion/cancellation.
type storageFallbackGate struct {
	mu     sync.Mutex
	active map[uuid.UUID]bool
}

var storageFallbackReaders = storageFallbackGate{active: make(map[uuid.UUID]bool)}

func (g *storageFallbackGate) acquire(ctx context.Context, account uuid.UUID) (func(), bool) {
	if ctx.Err() != nil {
		return nil, false
	}
	g.mu.Lock()
	if len(g.active) >= 2 || g.active[account] {
		g.mu.Unlock()
		return nil, false
	}
	if g.active == nil {
		g.active = make(map[uuid.UUID]bool)
	}
	g.active[account] = true
	g.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { g.mu.Lock(); delete(g.active, account); g.mu.Unlock() }) }, true
}
