package transport

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/naperu/clarin-offline-agent/internal/v3/engine"
)

const (
	syncChallengePath = "/api/offline/v3/sync/challenge"
	syncPath          = "/api/offline/v3/sync"
	maxParallelGrants = 4
	maxGrantsPerCycle = 8
)

var errSyncInFlight = errors.New("grant synchronization already in progress")

type GrantStatus struct {
	State         string    `json:"state"`
	Reachability  string    `json:"server_reachability"`
	LastAttemptAt time.Time `json:"last_attempt_at,omitempty"`
	LastSuccessAt time.Time `json:"last_success_at,omitempty"`
	NextAttemptAt time.Time `json:"next_attempt_at,omitempty"`
	LastErrorCode string    `json:"last_error_code,omitempty"`
	Retryable     bool      `json:"retryable"`
}

type Runner struct {
	engine  *engine.Engine
	baseURL string
	client  *http.Client
	trigger chan string

	mu       sync.RWMutex
	status   map[string]GrantStatus
	inFlight map[string]struct{}

	scheduleMu sync.Mutex
	nextGrant  int
}

func New(offlineEngine *engine.Engine) (*Runner, error) {
	if offlineEngine == nil {
		return nil, errors.New("offline engine is required")
	}
	parsed, err := url.Parse(offlineEngine.Origin())
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.Path != "" && parsed.Path != "/" {
		return nil, errors.New("sync origin rejected")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = http.ProxyFromEnvironment
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	transport.DialContext = (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 5 * time.Second
	transport.ResponseHeaderTimeout = 20 * time.Second
	transport.ExpectContinueTimeout = time.Second
	client := &http.Client{
		Timeout:       30 * time.Second,
		Transport:     transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &Runner{engine: offlineEngine, baseURL: strings.TrimRight(offlineEngine.Origin(), "/"), client: client, trigger: make(chan string, 16), status: make(map[string]GrantStatus), inFlight: make(map[string]struct{})}, nil
}

func (r *Runner) Run(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	r.syncAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.syncAll(ctx)
		case grantID := <-r.trigger:
			_ = r.SyncGrant(ctx, grantID)
		}
	}
}

func (r *Runner) Trigger(grantID string) {
	if strings.TrimSpace(grantID) == "" {
		return
	}
	select {
	case r.trigger <- grantID:
	default:
	}
}

func (r *Runner) Status(grantID string) GrantStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()
	status, ok := r.status[grantID]
	if !ok {
		return GrantStatus{State: "idle", Reachability: "unknown"}
	}
	return status
}

func (r *Runner) syncAll(ctx context.Context) {
	grantIDs, err := r.engine.TransportGrantIDs(ctx)
	if err != nil {
		return
	}
	grantIDs = r.nextBatch(grantIDs, maxGrantsPerCycle)
	if len(grantIDs) == 0 {
		return
	}
	workers := min(maxParallelGrants, len(grantIDs))
	jobs := make(chan string)
	var group sync.WaitGroup
	group.Add(workers)
	for range workers {
		go func() {
			defer group.Done()
			for grantID := range jobs {
				if ctx.Err() != nil {
					return
				}
				_ = r.SyncGrant(ctx, grantID)
			}
		}()
	}
	for _, grantID := range grantIDs {
		select {
		case <-ctx.Done():
			close(jobs)
			group.Wait()
			return
		case jobs <- grantID:
		}
	}
	close(jobs)
	group.Wait()
}

func (r *Runner) SyncGrant(ctx context.Context, grantID string) error {
	now := time.Now().UTC()
	previousSuccess, started := r.beginAttempt(grantID, now)
	if !started {
		return errSyncInFlight
	}
	defer r.endAttempt(grantID)
	challenge, err := r.challenge(ctx, grantID)
	if err != nil {
		r.failed(grantID, now, previousSuccess, "server_unreachable", true)
		return err
	}
	prepared, err := r.engine.BuildSync(ctx, grantID, *challenge)
	if err != nil {
		r.failed(grantID, now, previousSuccess, "sync_prepare_failed", false)
		return err
	}
	var response engine.SyncResponse
	status, err := r.postJSON(ctx, syncPath, prepared.Request, map[string]string{
		"Authorization":          "OfflineTransport " + prepared.TransportCapability,
		"X-Clarin-Service-Proof": prepared.ServiceProof,
		"X-Clarin-Protocol":      "3",
	}, &response, 64<<20)
	if err != nil {
		retryAt := time.Now().UTC().Add(30 * time.Second)
		_ = r.engine.MarkSyncAttempt(ctx, grantID, prepared.OperationIDs, retryAt)
		code, retryable := "server_unreachable", true
		if status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusLocked {
			code, retryable = "transport_denied", false
		}
		r.failed(grantID, now, previousSuccess, code, retryable)
		return err
	}
	// A successful HTTP response means the backend consumed the control ACKs,
	// even if a newly returned envelope later fails local validation. Remove
	// only the exact durable ACK batch that was included in this request so an
	// already-acknowledged ID cannot deadlock all future sync attempts.
	if err := r.engine.ConfirmSyncRequest(ctx, grantID, prepared.ControlAcknowledgements); err != nil {
		r.failed(grantID, now, previousSuccess, "sync_ack_commit_failed", false)
		return err
	}
	if err := r.engine.StoreSyncResponse(ctx, grantID, response); err != nil {
		r.failed(grantID, now, previousSuccess, "sync_response_rejected", false)
		return err
	}
	completedAt := time.Now().UTC()
	statusResult := GrantStatus{State: "idle", Reachability: "reachable", LastAttemptAt: now, LastSuccessAt: previousSuccess}
	switch response.State {
	case "synchronized":
		statusResult.LastSuccessAt = completedAt
	case "selection_changed":
		statusResult.State, statusResult.LastErrorCode = "blocked", "stale_selection"
	case "quota_exceeded":
		statusResult.State, statusResult.LastErrorCode = "blocked", "quota_exceeded"
	case "writes_disabled":
		statusResult.State, statusResult.LastErrorCode = "blocked", "writes_disabled"
	}
	r.setStatus(grantID, statusResult)
	return nil
}

func (r *Runner) challenge(ctx context.Context, grantID string) (*engine.SyncChallenge, error) {
	installationID, capability, err := r.engine.TransportChallengeBinding(ctx, grantID)
	if err != nil {
		return nil, err
	}
	var response engine.SyncChallenge
	status, err := r.postJSON(ctx, syncChallengePath, map[string]any{"grant_id": grantID, "installation_id": installationID}, map[string]string{"X-Clarin-Protocol": "3", "Authorization": "OfflineTransport " + capability}, &response, 64<<10)
	if err != nil {
		return nil, fmt.Errorf("sync challenge status %d: %w", status, err)
	}
	return &response, nil
}

func (r *Runner) postJSON(ctx context.Context, path string, input any, headers map[string]string, output any, responseLimit int64) (int, error) {
	raw, err := json.Marshal(input)
	if err != nil {
		return 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+path, bytes.NewReader(raw))
	if err != nil {
		return 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := r.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if err != nil || int64(len(body)) > responseLimit {
		return response.StatusCode, errors.New("sync response exceeded bounds")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, errors.New("sync server rejected request")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return response.StatusCode, errors.New("sync response was invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return response.StatusCode, errors.New("sync response contained trailing data")
	}
	return response.StatusCode, nil
}

func (r *Runner) failed(grantID string, attemptedAt, previousSuccess time.Time, code string, retryable bool) {
	status := GrantStatus{State: "error", Reachability: "unreachable", LastAttemptAt: attemptedAt, LastSuccessAt: previousSuccess, LastErrorCode: code, Retryable: retryable}
	if retryable {
		status.State = "waiting_network"
		status.NextAttemptAt = time.Now().UTC().Add(30 * time.Second)
	}
	r.setStatus(grantID, status)
}

func (r *Runner) beginAttempt(grantID string, attemptedAt time.Time) (time.Time, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.inFlight[grantID]; exists {
		return time.Time{}, false
	}
	previousSuccess := r.status[grantID].LastSuccessAt
	r.inFlight[grantID] = struct{}{}
	r.status[grantID] = GrantStatus{State: "syncing", Reachability: "unknown", LastAttemptAt: attemptedAt, LastSuccessAt: previousSuccess}
	return previousSuccess, true
}

func (r *Runner) endAttempt(grantID string) {
	r.mu.Lock()
	delete(r.inFlight, grantID)
	r.mu.Unlock()
}

func (r *Runner) nextBatch(grantIDs []string, limit int) []string {
	if len(grantIDs) == 0 || limit < 1 {
		return nil
	}
	r.scheduleMu.Lock()
	defer r.scheduleMu.Unlock()
	count := min(limit, len(grantIDs))
	start := r.nextGrant % len(grantIDs)
	result := make([]string, 0, count)
	for offset := range count {
		result = append(result, grantIDs[(start+offset)%len(grantIDs)])
	}
	r.nextGrant = (start + count) % len(grantIDs)
	return result
}

func (r *Runner) setStatus(grantID string, status GrantStatus) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.status[grantID] = status
}
