package session

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

func sessionTuple(browser, grant string) model.Tuple {
	return model.Tuple{
		InstallationID:     "11111111-1111-4111-8111-111111111111",
		WindowsPrincipalID: "22222222-2222-4222-8222-222222222222",
		BrowserProfileID:   browser,
		AuthorizationID:    "44444444-4444-4444-8444-444444444444",
		GrantID:            grant,
		UserID:             "66666666-6666-4666-8666-666666666666",
		AccountID:          "77777777-7777-4777-8777-777777777777",
	}
}

func testSecrets(t *testing.T) *cryptokit.GrantSecrets {
	t.Helper()
	secrets, err := cryptokit.GenerateGrantSecrets()
	if err != nil {
		t.Fatal(err)
	}
	return secrets
}

func leaseFor(tuple model.Tuple, expires time.Time) model.LeaseClaims {
	return model.LeaseClaims{Tuple: tuple, ExpiresAt: expires.Unix()}
}

func TestSwitchGrantInvalidatesPriorCapabilityAndDestroysSecrets(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	manager := NewManager()
	manager.now = func() time.Time { return now }
	browser := "33333333-3333-4333-8333-333333333333"
	firstTuple := sessionTuple(browser, "55555555-5555-4555-8555-555555555555")
	firstSecrets := testSecrets(t)
	firstDEK := firstSecrets.DEK
	first, err := manager.Open(browser, firstTuple, []string{model.ActionContactsRead}, leaseFor(firstTuple, now.Add(time.Hour)), 2, firstSecrets)
	if err != nil {
		t.Fatal(err)
	}
	secondTuple := sessionTuple(browser, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	secondSecrets := testSecrets(t)
	second, err := manager.Open(browser, secondTuple, []string{model.ActionProgramsRead}, leaseFor(secondTuple, now.Add(time.Hour)), 3, secondSecrets)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Acquire(first.Capability, browser, first.ProfileEpoch); err != ErrExpired {
		t.Fatalf("stale capability remained active: %v", err)
	}
	if !bytes.Equal(firstDEK, make([]byte, len(firstDEK))) {
		t.Fatal("prior grant DEK was not destroyed")
	}
	access, err := manager.Acquire(second.Capability, browser, second.ProfileEpoch)
	if err != nil || access.Tuple.GrantID != secondTuple.GrantID {
		t.Fatalf("new session unavailable: %#v %v", access, err)
	}
	access.Release()
	manager.Close()
}

func TestHeartbeatLossAndIdleExpireSession(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	manager := NewManager()
	manager.now = func() time.Time { return now }
	browser := "33333333-3333-4333-8333-333333333333"
	tuple := sessionTuple(browser, "55555555-5555-4555-8555-555555555555")
	issued, err := manager.Open(browser, tuple, []string{model.ActionTasksRead}, leaseFor(tuple, now.Add(time.Hour)), 1, testSecrets(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Heartbeat(issued.Capability, browser, 1, issued.SessionID, "88888888-8888-4888-8888-888888888888"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(HeartbeatTimeout + time.Second)
	if manager.Sweep() != 1 {
		t.Fatal("lost heartbeat did not close session")
	}
	if _, err := manager.Acquire(issued.Capability, browser, 1); err != ErrExpired {
		t.Fatalf("expired session remained usable: %v", err)
	}
}

func TestReaperDestroysExpiredSecretsWithoutAnotherRequestAndStops(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	manager := NewManager()
	manager.now = func() time.Time { return now }
	browser := "33333333-3333-4333-8333-333333333333"
	tuple := sessionTuple(browser, "55555555-5555-4555-8555-555555555555")
	secrets := testSecrets(t)
	dek := secrets.DEK
	issued, err := manager.Open(browser, tuple, []string{model.ActionTasksRead}, leaseFor(tuple, now.Add(time.Hour)), 1, secrets)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time)
	done := make(chan struct{})
	go func() {
		manager.runReaper(ctx, ticks)
		close(done)
	}()
	now = now.Add(HeartbeatTimeout + time.Second)
	ticks <- now
	if _, err := manager.Acquire(issued.Capability, browser, 1); err != ErrExpired {
		t.Fatalf("background reaper left expired capability usable: %v", err)
	}
	if !bytes.Equal(dek, make([]byte, len(dek))) {
		t.Fatal("background reaper left expired DEK in memory")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("background reaper did not stop after cancellation")
	}
}

func TestAcquireReferenceDefersDestructionUntilRequestCompletes(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	manager := NewManager()
	manager.now = func() time.Time { return now }
	browser := "33333333-3333-4333-8333-333333333333"
	tuple := sessionTuple(browser, "55555555-5555-4555-8555-555555555555")
	secrets := testSecrets(t)
	dek := secrets.DEK
	issued, _ := manager.Open(browser, tuple, []string{model.ActionWhiteboardsRead}, leaseFor(tuple, now.Add(time.Hour)), 1, secrets)
	access, err := manager.Acquire(issued.Capability, browser, 1)
	if err != nil {
		t.Fatal(err)
	}
	manager.LockBrowser(browser)
	if bytes.Equal(dek, make([]byte, len(dek))) {
		t.Fatal("active request secrets destroyed before release")
	}
	access.Release()
	if !bytes.Equal(dek, make([]byte, len(dek))) {
		t.Fatal("closing session secrets survived final release")
	}
}

func TestBackgroundPollingNeverExtendsUserInactivity(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	started := now
	manager := NewManager()
	defer manager.Close()
	manager.now = func() time.Time { return now }
	browser := "33333333-3333-4333-8333-333333333333"
	tuple := sessionTuple(browser, "55555555-5555-4555-8555-555555555555")
	secrets := testSecrets(t)
	dek := secrets.DEK
	issued, err := manager.Open(browser, tuple, []string{model.ActionTasksRead}, leaseFor(tuple, now.Add(72*time.Hour)), 1, secrets)
	if err != nil {
		t.Fatal(err)
	}
	for now.Before(started.Add(IdleTimeout)) {
		expiry, err := manager.Heartbeat(issued.Capability, browser, 1, issued.SessionID, "88888888-8888-4888-8888-888888888888", 0)
		if err != nil || !expiry.Equal(started.Add(IdleTimeout)) {
			t.Fatalf("poll renewed inactivity: %v %v", expiry, err)
		}
		access, err := manager.Acquire(issued.Capability, browser, 1)
		if err != nil {
			t.Fatal(err)
		}
		access.Release()
		background, err := manager.AcquireGrant(tuple.GrantID)
		if err != nil {
			t.Fatal(err)
		}
		background.Release()
		now = now.Add(30 * time.Second)
	}
	if _, err := manager.Heartbeat(issued.Capability, browser, 1, issued.SessionID, "88888888-8888-4888-8888-888888888888", 1); err != ErrExpired {
		t.Fatalf("activity revived expired grant: %v", err)
	}
	if !bytes.Equal(dek, make([]byte, len(dek))) {
		t.Fatal("idle secrets survived")
	}
}

func TestOnlyAdvancingInteractionSequenceExtendsInactivity(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	manager := NewManager()
	defer manager.Close()
	manager.now = func() time.Time { return now }
	browser := "33333333-3333-4333-8333-333333333333"
	client := "88888888-8888-4888-8888-888888888888"
	tuple := sessionTuple(browser, "55555555-5555-4555-8555-555555555555")
	issued, err := manager.Open(browser, tuple, []string{model.ActionTasksRead}, leaseFor(tuple, now.Add(time.Hour)), 1, testSecrets(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Heartbeat(issued.Capability, browser, 1, issued.SessionID, client, 2); err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Second)
	expiry, err := manager.Heartbeat(issued.Capability, browser, 1, issued.SessionID, client, 3)
	if err != nil || !expiry.Equal(now.Add(IdleTimeout)) {
		t.Fatalf("interaction did not renew: %v %v", expiry, err)
	}
	for _, sequence := range []uint64{3, 2, 0} {
		now = now.Add(30 * time.Second)
		got, err := manager.Heartbeat(issued.Capability, browser, 1, issued.SessionID, client, sequence)
		if err != nil || !got.Equal(expiry) {
			t.Fatalf("replayed/regressive interaction renewed: %v %v", got, err)
		}
	}
	if _, err := manager.Heartbeat(issued.Capability, browser, 1, issued.SessionID, client, 9007199254740992); err != ErrInvalid {
		t.Fatalf("unsafe sequence accepted: %v", err)
	}
}
