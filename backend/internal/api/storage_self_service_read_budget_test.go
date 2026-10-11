package api

import (
	"context"
	"github.com/google/uuid"
	"sync"
	"testing"
)

func TestStorageReferenceReadBudgetRejectsBeforeParse(t *testing.T) {
	var byCount storageReferenceReadBudget
	for i := 0; i < storageFallbackCandidateLimit; i++ {
		if !byCount.consume(1) {
			t.Fatal("bounded candidate rejected")
		}
	}
	if byCount.consume(1) {
		t.Fatal("candidate budget not enforced")
	}
	var byBytes storageReferenceReadBudget
	if !byBytes.consume(storageFallbackPayloadLimit) || byBytes.consume(1) {
		t.Fatal("byte budget not enforced")
	}
	var oversized storageReferenceReadBudget
	if oversized.consume(storageFallbackPayloadLimit+1) || oversized.candidates != 0 || oversized.bytes != 0 {
		t.Fatal("oversized payload admitted")
	}
	if oversized.consume(-1) {
		t.Fatal("invalid payload length admitted")
	}
}
func TestStorageFallbackGateLimitsAndReleases(t *testing.T) {
	gate := storageFallbackGate{}
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	first, ok := gate.acquire(context.Background(), a)
	if !ok {
		t.Fatal("first admission failed")
	}
	if _, ok = gate.acquire(context.Background(), a); ok {
		t.Fatal("same account admitted twice")
	}
	second, ok := gate.acquire(context.Background(), b)
	if !ok {
		t.Fatal("second account rejected")
	}
	if _, ok = gate.acquire(context.Background(), c); ok {
		t.Fatal("third reader admitted")
	}
	first()
	first()
	third, ok := gate.acquire(context.Background(), c)
	if !ok {
		t.Fatal("completion did not release slot")
	}
	second()
	third()
	ctx, cancel := context.WithCancel(context.Background())
	release, ok := gate.acquire(ctx, a)
	if !ok {
		t.Fatal("cancellable read rejected")
	}
	done := make(chan struct{})
	go func() { defer close(done); defer release(); <-ctx.Done() }()
	cancel()
	<-done
	if _, ok = gate.acquire(ctx, b); ok {
		t.Fatal("cancelled reader admitted")
	}
	final, ok := gate.acquire(context.Background(), a)
	if !ok {
		t.Fatal("cancelled handler did not release slot")
	}
	final()
	if len(gate.active) != 0 {
		t.Fatal("completed account retained")
	}
}

func TestStorageFallbackGateConcurrentAdmission(t *testing.T) {
	gate := storageFallbackGate{}
	ready := make(chan struct{})
	releaseWorkers := make(chan struct{})
	admitted := make(chan bool, 32)
	var workers sync.WaitGroup
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-ready
			release, ok := gate.acquire(context.Background(), uuid.New())
			admitted <- ok
			if ok {
				defer release()
				<-releaseWorkers
			}
		}()
	}
	close(ready)
	count := 0
	for i := 0; i < 32; i++ {
		if <-admitted {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("concurrent admissions=%d", count)
	}
	close(releaseWorkers)
	workers.Wait()
	if len(gate.active) != 0 {
		t.Fatal("concurrent workers retained slots")
	}
}
