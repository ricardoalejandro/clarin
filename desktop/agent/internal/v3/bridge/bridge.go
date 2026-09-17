package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/naperu/clarin-offline-agent/internal/v3/catalog"
	"github.com/naperu/clarin-offline-agent/internal/v3/dpop"
	"github.com/naperu/clarin-offline-agent/internal/v3/engine"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
	"github.com/naperu/clarin-offline-agent/internal/v3/protocol"
	"github.com/naperu/clarin-offline-agent/internal/v3/session"
	"github.com/naperu/clarin-offline-agent/internal/v3/vault"
)

const (
	listenHost     = "127.0.0.1:17373"
	localBaseURL   = "http://127.0.0.1:17373/v3"
	maxRequestBody = 1 << 20
)

type Server struct {
	engine  *engine.Engine
	dpop    *dpop.Verifier
	nonces  *noncePool
	started time.Time

	mu           sync.Mutex
	enrollNonces map[string]enrollNonce
	rateWindow   time.Time
	rateCount    int
	syncHooks    SyncHooks
}

type SyncRuntimeStatus struct {
	State         string
	Reachability  string
	LastAttemptAt time.Time
	LastSuccessAt time.Time
	NextAttemptAt time.Time
	LastErrorCode string
	Retryable     bool
}

type SyncHooks struct {
	Trigger func(grantID string)
	Status  func(grantID string) SyncRuntimeStatus
}

type enrollNonce struct {
	value     string
	expiresAt time.Time
}

func New(offlineEngine *engine.Engine) (*Server, error) {
	return NewWithSync(offlineEngine, SyncHooks{})
}

func NewWithSync(offlineEngine *engine.Engine, hooks SyncHooks) (*Server, error) {
	if offlineEngine == nil {
		return nil, errors.New("offline engine is required")
	}
	return &Server{engine: offlineEngine, dpop: dpop.NewVerifier(), nonces: newNoncePool(), started: time.Now().UTC(), enrollNonces: make(map[string]enrollNonce), syncHooks: hooks}, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID := r.Header.Get("X-Clarin-Request-ID")
	if !canonicalUUID(requestID) {
		requestID = uuid.NewString()
	}
	s.securityHeaders(w, requestID)
	if r.Host != listenHost {
		s.writeError(w, http.StatusForbidden, "host_denied", "", requestID, 0)
		return
	}
	if r.Header.Get("Origin") != s.engine.Origin() {
		s.writeError(w, http.StatusForbidden, "origin_denied", "", requestID, 0)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", s.engine.Origin())
	if r.Method == http.MethodOptions {
		s.preflight(w, r, requestID)
		return
	}
	if r.Header.Get("X-Clarin-Protocol") != strconv.Itoa(model.ProtocolVersion) || !canonicalUUID(r.Header.Get("X-Clarin-Request-ID")) {
		s.writeError(w, http.StatusBadRequest, "invalid_request", "", requestID, 0)
		return
	}
	if !s.allowRequest() {
		w.Header().Set("Retry-After", "1")
		s.writeError(w, http.StatusTooManyRequests, "local_rate_limited", "", requestID, 0)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	if !strings.HasPrefix(r.URL.Path, "/v3/") && r.URL.Path != "/v3" {
		s.writeError(w, http.StatusNotFound, "not_found", "", requestID, 0)
		return
	}
	s.route(w, r, requestID)
}

func (s *Server) route(w http.ResponseWriter, r *http.Request, requestID string) {
	path := strings.TrimPrefix(r.URL.Path, "/v3")
	switch {
	case path == "/health" && r.Method == http.MethodGet:
		s.writeJSON(w, http.StatusOK, map[string]any{"protocol": 3, "service": "clarin-offline", "service_version": s.engine.Version(), "engine_state": "ready", "configured_origin": s.engine.Origin(), "server_reachability": "unknown", "now": time.Now().UTC()})
	case path == "/browser-profiles/principal-challenge" && r.Method == http.MethodPost:
		if !s.requireEmptyObject(w, r, requestID) {
			return
		}
		result, err := s.engine.CreatePrincipalChallenge()
		s.respond(w, result, err, http.StatusCreated, requestID, 0)
	case strings.HasPrefix(path, "/browser-profiles/principal-challenges/") && r.Method == http.MethodGet:
		id := strings.TrimPrefix(path, "/browser-profiles/principal-challenges/")
		if !canonicalUUID(id) {
			s.writeError(w, http.StatusBadRequest, "invalid_request", "", requestID, 0)
			return
		}
		result, err := s.engine.PrincipalChallengeStatus(id)
		s.respond(w, result, err, http.StatusOK, requestID, 0)
	case path == "/browser-profiles/challenge" && r.Method == http.MethodPost:
		var input struct {
			ClientBuild  string `json:"client_build"`
			BrowserLabel string `json:"browser_label"`
		}
		if !s.decode(w, r, &input, requestID) || strings.TrimSpace(input.ClientBuild) == "" || len(input.ClientBuild) > 100 || len([]rune(input.BrowserLabel)) > 200 {
			return
		}
		result, err := s.engine.CreateBrowserChallenge()
		if err == nil {
			s.mu.Lock()
			s.enrollNonces[result.ChallengeID] = enrollNonce{value: result.Nonce, expiresAt: result.ExpiresAt}
			s.mu.Unlock()
		}
		s.respond(w, result, err, http.StatusCreated, requestID, 0)
	case path == "/browser-profiles/enroll" && r.Method == http.MethodPost:
		s.enrollBrowser(w, r, requestID)
	case path == "/browser-profiles/prove" && r.Method == http.MethodPost:
		var input struct {
			ClientBuild string `json:"client_build"`
		}
		if !s.decode(w, r, &input, requestID) || input.ClientBuild == "" || len(input.ClientBuild) > 100 {
			return
		}
		profile, ok := s.browserProof(w, r, requestID, nil)
		if !ok {
			return
		}
		s.writeJSONWithEpoch(w, http.StatusOK, map[string]any{"browser_profile_id": profile.ID, "state": profile.State, "profile_epoch": profile.Epoch}, profile.Epoch)
	case path == "/browser-profiles/enrollment-material" && r.Method == http.MethodPost:
		profile, ok := s.browserProof(w, r, requestID, nil)
		if !ok {
			return
		}
		var input engine.EnrollmentMaterialInput
		if !s.decode(w, r, &input, requestID) {
			return
		}
		result, err := s.engine.EnrollmentMaterial(r.Context(), profile.ID, input)
		s.respond(w, result, err, http.StatusOK, requestID, profile.Epoch)
	case path == "/browser-profiles/activate" && r.Method == http.MethodPost:
		profile, ok := s.browserProof(w, r, requestID, nil)
		if !ok {
			return
		}
		var input struct {
			ServiceDescriptor string                      `json:"service_descriptor"`
			SignerPublicKeys  protocol.PublicKeysResponse `json:"signer_public_keys"`
		}
		if !s.decode(w, r, &input, requestID) {
			return
		}
		err := s.engine.ActivateBrowserProfile(r.Context(), profile.ID, input.ServiceDescriptor, input.SignerPublicKeys)
		if err == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
	case path == "/runtime/service-descriptor" && r.Method == http.MethodGet:
		profile, ok := s.browserProof(w, r, requestID, nil)
		if !ok {
			return
		}
		result, err := s.engine.ServiceDescriptor(r.Context(), profile.ID, r.URL.Query().Get("challenge"))
		s.respond(w, result, err, http.StatusOK, requestID, profile.Epoch)
	case path == "/grants" && r.Method == http.MethodGet:
		profile, ok := s.browserProof(w, r, requestID, nil)
		if !ok {
			return
		}
		limit := pageLimit(r.URL.Query().Get("limit"), 100)
		items, next, err := s.engine.Grants(r.Context(), profile.ID, r.URL.Query().Get("cursor"), limit)
		if err != nil {
			s.respond(w, nil, err, 0, requestID, profile.Epoch)
			return
		}
		result := make([]map[string]any, 0, len(items))
		for _, grant := range items {
			_, pending, _, _ := s.engine.Counts(r.Context(), grant.Tuple.GrantID)
			conflicts, _ := s.engine.ConflictCount(r.Context(), grant.Tuple.GrantID)
			readiness, _ := s.engine.GrantReadiness(r.Context(), &grant)
			result = append(result, map[string]any{"grant_id": grant.Tuple.GrantID, "state": grant.State, "display_user": grant.DisplayUser, "display_account": grant.DisplayAccount, "actions": grant.Actions, "ready": readiness.Usable, "needs_online_provision": grant.State == "preparing", "lease_expires_at": optionalTime(grant.LeaseExpiresAt), "last_sync_at": optionalTime(grant.LastSyncAt), "pending_count": pending, "conflict_count": conflicts, "selection_revision": grant.SelectionRevision, "selection_total": readiness.Total, "selection_ready": readiness.Ready, "selection_errors": readiness.Errors})
		}
		s.writeJSONWithEpoch(w, http.StatusOK, map[string]any{"items": result, "next_cursor": next}, profile.Epoch)
	case strings.HasPrefix(path, "/grants/"):
		s.routeGrant(w, r, requestID, path)
	case path == "/session/lock" && r.Method == http.MethodPost:
		access, profile, ok := s.sessionProof(w, r, requestID)
		if !ok {
			return
		}
		defer access.Release()
		var input struct {
			Reason string `json:"reason"`
		}
		if !s.decode(w, r, &input, requestID) || (input.Reason != "logout" && input.Reason != "switch" && input.Reason != "idle" && input.Reason != "security") {
			return
		}
		if _, err := s.engine.LockBrowser(r.Context(), profile.ID); err != nil {
			s.respond(w, nil, err, 0, requestID, profile.Epoch)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case path == "/session/heartbeat" && r.Method == http.MethodPost:
		s.heartbeat(w, r, requestID)
	case path == "/resources" && r.Method == http.MethodGet:
		s.resources(w, r, requestID)
	case path == "/tasks/lists" && r.Method == http.MethodGet:
		s.taskLists(w, r, requestID)
	case path == "/tasks" && r.Method == http.MethodGet:
		s.tasks(w, r, requestID)
	case path == "/contacts" && r.Method == http.MethodGet:
		s.collection(w, r, requestID, "contacts", "")
	case strings.HasPrefix(path, "/contacts/") && r.Method == http.MethodGet:
		s.contactDetail(w, r, requestID, strings.TrimPrefix(path, "/contacts/"))
	case path == "/programs" && r.Method == http.MethodGet:
		s.collection(w, r, requestID, "programs", "")
	case strings.HasPrefix(path, "/programs/") && r.Method == http.MethodGet:
		s.programDetail(w, r, requestID, strings.TrimPrefix(path, "/programs/"))
	case path == "/whiteboards" && r.Method == http.MethodGet:
		s.collection(w, r, requestID, "whiteboards", "")
	case strings.HasPrefix(path, "/whiteboards/") && r.Method == http.MethodGet:
		s.whiteboardDetail(w, r, requestID, strings.TrimPrefix(path, "/whiteboards/"))
	case path == "/operations/tasks/create" && r.Method == http.MethodPost:
		s.createTask(w, r, requestID)
	case strings.HasPrefix(path, "/operations/tasks/") && strings.HasSuffix(path, "/complete") && r.Method == http.MethodPost:
		s.completeTask(w, r, requestID, strings.TrimSuffix(strings.TrimPrefix(path, "/operations/tasks/"), "/complete"))
	case path == "/sync/status" && r.Method == http.MethodGet:
		s.syncStatus(w, r, requestID, false)
	case path == "/sync/trigger" && r.Method == http.MethodPost:
		s.syncStatus(w, r, requestID, true)
	case path == "/conflicts" && r.Method == http.MethodGet:
		s.conflicts(w, r, requestID)
	default:
		s.writeError(w, http.StatusNotFound, "not_found", "", requestID, 0)
	}
}

func (s *Server) routeGrant(w http.ResponseWriter, r *http.Request, requestID, path string) {
	parts := strings.Split(strings.TrimPrefix(path, "/grants/"), "/")
	if len(parts) < 2 || !canonicalUUID(parts[0]) {
		s.writeError(w, http.StatusNotFound, "not_found", "", requestID, 0)
		return
	}
	grantID := parts[0]
	suffix := strings.Join(parts[1:], "/")
	if suffix == "lease/proof" && r.Method == http.MethodPost {
		access, profile, ok := s.sessionProof(w, r, requestID)
		if !ok {
			return
		}
		defer access.Release()
		if access.Tuple.GrantID != grantID {
			s.writeError(w, http.StatusNotFound, "resource_not_available", "", requestID, profile.Epoch)
			return
		}
		var input engine.LeaseProofInput
		if !s.decode(w, r, &input, requestID) {
			return
		}
		result, err := s.engine.BuildLeaseProof(r.Context(), access, input)
		s.respond(w, result, err, http.StatusOK, requestID, profile.Epoch)
		return
	}
	profile, ok := s.browserProof(w, r, requestID, nil)
	if !ok {
		return
	}
	switch {
	case suffix == "unlock/challenge" && r.Method == http.MethodPost:
		if !s.requireEmptyObject(w, r, requestID) {
			return
		}
		result, err := s.engine.CredentialChallenge(r.Context(), "unlock", profile.ID, grantID)
		s.respond(w, result, err, http.StatusOK, requestID, profile.Epoch)
	case suffix == "provision/challenge" && r.Method == http.MethodPost:
		if !s.requireEmptyObject(w, r, requestID) {
			return
		}
		result, err := s.engine.CredentialChallenge(r.Context(), "provision", profile.ID, grantID)
		s.respond(w, result, err, http.StatusOK, requestID, profile.Epoch)
	case suffix == "lease/challenge" && r.Method == http.MethodPost:
		if !s.requireEmptyObject(w, r, requestID) {
			return
		}
		result, err := s.engine.CredentialChallenge(r.Context(), "renew", profile.ID, grantID)
		s.respond(w, result, err, http.StatusOK, requestID, profile.Epoch)
	case suffix == "provision" && r.Method == http.MethodPost:
		var input engine.PrepareGrantInput
		if !s.decode(w, r, &input, requestID) {
			return
		}
		result, err := s.engine.PrepareGrant(r.Context(), profile.ID, grantID, input)
		s.respond(w, result, err, http.StatusOK, requestID, profile.Epoch)
	case suffix == "provision/activate" && r.Method == http.MethodPost:
		var input engine.ActivateGrantInput
		if !s.decode(w, r, &input, requestID) {
			return
		}
		err := s.engine.ActivateGrant(r.Context(), profile.ID, grantID, input)
		if err == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
	case suffix == "lease/prepare" && r.Method == http.MethodPost:
		var input engine.PrepareLeaseInput
		if !s.decode(w, r, &input, requestID) {
			return
		}
		result, err := s.engine.PrepareLease(r.Context(), profile.ID, grantID, input)
		s.respond(w, result, err, http.StatusOK, requestID, profile.Epoch)
	case suffix == "lease/activate" && r.Method == http.MethodPost:
		var input engine.ActivateLeaseInput
		if !s.decode(w, r, &input, requestID) {
			return
		}
		epoch, err := s.engine.ActivateLease(r.Context(), profile.ID, grantID, input)
		s.respond(w, map[string]any{"state": "updated", "profile_epoch": epoch}, err, http.StatusOK, requestID, epoch)
	case suffix == "suspend" && r.Method == http.MethodPost:
		var input struct {
			Reason string `json:"reason"`
		}
		if !s.decode(w, r, &input, requestID) {
			return
		}
		epoch, err := s.engine.SuspendGrant(r.Context(), profile.ID, grantID, input.Reason)
		s.respond(w, map[string]any{"state": "suspended", "profile_epoch": epoch}, err, http.StatusOK, requestID, epoch)
	case suffix == "unlock" && r.Method == http.MethodPost:
		var input struct {
			ChallengeID   string `json:"challenge_id"`
			CredentialJWE string `json:"credential_jwe"`
		}
		if !s.decode(w, r, &input, requestID) {
			return
		}
		result, err := s.engine.Unlock(r.Context(), profile.ID, grantID, input.ChallengeID, input.CredentialJWE)
		if err != nil {
			s.respond(w, nil, err, 0, requestID, profile.Epoch)
			return
		}
		_, pending, _, _ := s.engine.Counts(r.Context(), grantID)
		payload := map[string]any{"session": map[string]any{
			"session_id": result.Session.SessionID, "capability": result.Session.Capability, "profile_epoch": result.Session.ProfileEpoch,
			"idle_expires_at": result.Session.IdleExpiresAt, "lease_expires_at": result.Grant.LeaseExpiresAt,
			"actor": map[string]any{"user_id": result.Grant.Tuple.UserID, "username": result.Login, "display_name": result.Grant.DisplayUser, "account_id": result.Grant.Tuple.AccountID, "account_name": result.Grant.DisplayAccount}, "actions": result.Grant.Actions,
		}, "sync": s.syncPayload(result.Grant, pending, s.conflictCount(r.Context(), grantID), "idle")}
		s.writeJSONWithEpoch(w, http.StatusOK, payload, result.Session.ProfileEpoch)
	default:
		s.writeError(w, http.StatusNotFound, "not_found", "", requestID, profile.Epoch)
	}
}

func (s *Server) enrollBrowser(w http.ResponseWriter, r *http.Request, requestID string) {
	var input struct {
		PrincipalChallengeID string `json:"principal_challenge_id"`
		ChallengeID          string `json:"challenge_id"`
		ClientBuild          string `json:"client_build"`
		BrowserLabel         string `json:"browser_label"`
	}
	if !s.decode(w, r, &input, requestID) || !canonicalUUID(input.PrincipalChallengeID) || !canonicalUUID(input.ChallengeID) || input.ClientBuild == "" {
		return
	}
	s.mu.Lock()
	stored, ok := s.enrollNonces[input.ChallengeID]
	if ok {
		delete(s.enrollNonces, input.ChallengeID)
	}
	s.mu.Unlock()
	if !ok || !stored.expiresAt.After(time.Now().UTC()) {
		s.writeError(w, http.StatusUnauthorized, "invalid_dpop", "", requestID, 0)
		return
	}
	proof, err := s.dpop.VerifyEnrolling(r.Header.Get("DPoP"), r.Method, exactURI(r), stored.value)
	if err != nil {
		s.writeError(w, http.StatusUnauthorized, "invalid_dpop", "", requestID, 0)
		return
	}
	result, err := s.engine.EnrollBrowser(r.Context(), input.PrincipalChallengeID, input.ChallengeID, input.BrowserLabel, proof.PublicJWK)
	s.respond(w, result, err, http.StatusCreated, requestID, 0)
}

func (s *Server) browserProof(w http.ResponseWriter, r *http.Request, requestID string, capability []byte) (*catalog.BrowserProfile, bool) {
	browserID := r.Header.Get("X-Clarin-Browser-Profile-ID")
	if !canonicalUUID(browserID) {
		s.writeError(w, http.StatusUnauthorized, "invalid_dpop", "", requestID, 0)
		return nil, false
	}
	profile, err := s.engine.BrowserProfile(r.Context(), browserID)
	if err != nil || profile.State == "revoked" {
		s.writeError(w, http.StatusUnauthorized, "invalid_dpop", "", requestID, 0)
		return nil, false
	}
	token := r.Header.Get("DPoP")
	nonce, err := dpop.ExtractNonce(token)
	if err != nil || !s.nonces.accepts(nonce) {
		s.writeError(w, http.StatusUnauthorized, "invalid_dpop", "", requestID, profile.Epoch)
		return nil, false
	}
	if _, err := s.dpop.Verify(token, browserID, profile.DPoPJWK, r.Method, exactURI(r), nonce, capability); err != nil {
		s.writeError(w, http.StatusUnauthorized, "invalid_dpop", "", requestID, profile.Epoch)
		return nil, false
	}
	return profile, true
}

func (s *Server) sessionProof(w http.ResponseWriter, r *http.Request, requestID string) (*session.Access, *catalog.BrowserProfile, bool) {
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "DPoP ") || strings.Count(authorization, " ") != 1 {
		s.writeError(w, http.StatusUnauthorized, "session_expired", "", requestID, 0)
		return nil, nil, false
	}
	capability := strings.TrimPrefix(authorization, "DPoP ")
	if len(capability) != 43 {
		s.writeError(w, http.StatusUnauthorized, "session_expired", "", requestID, 0)
		return nil, nil, false
	}
	profile, ok := s.browserProof(w, r, requestID, []byte(capability))
	if !ok {
		return nil, nil, false
	}
	access, err := s.engine.AcquireSession(capability, profile.ID, profile.Epoch)
	if err != nil {
		code := "session_expired"
		status := http.StatusUnauthorized
		if errors.Is(err, session.ErrIdentityChanged) {
			code, status = "identity_changed", http.StatusConflict
		}
		s.writeError(w, status, code, "", requestID, profile.Epoch)
		return nil, nil, false
	}
	return access, profile, true
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request, requestID string) {
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	var input struct {
		SessionID        string `json:"session_id"`
		ClientInstanceID string `json:"client_instance_id"`
		ProfileEpoch     int64  `json:"profile_epoch"`
		Visible          bool   `json:"visible"`
		ActivitySequence uint64 `json:"activity_sequence"`
	}
	if !s.decode(w, r, &input, requestID) || input.ProfileEpoch != profile.Epoch {
		return
	}
	idle, err := s.engine.Heartbeat(strings.TrimPrefix(r.Header.Get("Authorization"), "DPoP "), profile.ID, profile.Epoch, input.SessionID, input.ClientInstanceID, input.ActivitySequence)
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	grant, _ := s.grantForAccess(r.Context(), access)
	_, pending, _, _ := s.engine.Counts(r.Context(), access.Tuple.GrantID)
	s.writeJSONWithEpoch(w, http.StatusOK, map[string]any{"ok": true, "profile_epoch": profile.Epoch, "idle_expires_at": idle, "lease_expires_at": time.Unix(access.Lease.ExpiresAt, 0).UTC(), "sync": s.syncPayload(grant, pending, s.conflictCount(r.Context(), access.Tuple.GrantID), "idle")}, profile.Epoch)
}

func (s *Server) resources(w http.ResponseWriter, r *http.Request, requestID string) {
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	module := r.URL.Query().Get("module")
	items, next, err := s.engine.Selections(r.Context(), access, module, r.URL.Query().Get("cursor"), pageLimit(r.URL.Query().Get("limit"), 100))
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		result = append(result, map[string]any{"selection_id": item.SelectionID, "resource_id": item.ResourceID, "module": item.Module, "resource_type": item.ResourceType, "label": item.Label, "readiness": item.Readiness, "head_version": item.HeadVersion, "content_hash": item.ContentHash, "item_count": item.ItemCount, "byte_size": item.ByteSize, "last_synced_at": optionalTime(item.LastSyncedAt), "error_code": item.ErrorCode})
	}
	s.writeJSONWithEpoch(w, http.StatusOK, map[string]any{"items": result, "next_cursor": next, "selection_revision": access.Lease.Selection}, profile.Epoch)
}

func (s *Server) taskLists(w http.ResponseWriter, r *http.Request, requestID string) {
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	items, next, err := s.engine.Selections(r.Context(), access, "tasks", r.URL.Query().Get("cursor"), pageLimit(r.URL.Query().Get("limit"), 100))
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	result := make([]json.RawMessage, 0, len(items))
	for _, item := range items {
		if item.Readiness != "available" {
			continue
		}
		resource, resourceErr := s.engine.Resource(r.Context(), access, "tasks", "task_list", item.ResourceID)
		if resourceErr != nil {
			s.respond(w, nil, resourceErr, 0, requestID, profile.Epoch)
			return
		}
		projected, projectErr := projectTaskList(item.SelectionID, resource.Payload)
		if projectErr != nil {
			s.respond(w, nil, projectErr, 0, requestID, profile.Epoch)
			return
		}
		result = append(result, projected)
	}
	s.writeJSONWithEpoch(w, http.StatusOK, map[string]any{"items": result, "next_cursor": next, "snapshot": snapshotMeta(access, items)}, profile.Epoch)
}

func (s *Server) tasks(w http.ResponseWriter, r *http.Request, requestID string) {
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	selectionID := r.URL.Query().Get("selection_id")
	if !canonicalUUID(selectionID) {
		s.writeError(w, http.StatusBadRequest, "invalid_request", "", requestID, profile.Epoch)
		return
	}
	page, err := s.engine.TaskPageForSelection(r.Context(), access, selectionID, r.URL.Query().Get("cursor"), pageLimit(r.URL.Query().Get("limit"), 200))
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	s.writeJSONWithEpoch(w, http.StatusOK, map[string]any{"items": page.Items, "next_cursor": page.NextCursor,
		"snapshot": map[string]any{"selection_revision": page.SelectionRevision, "head_version": page.HeadVersion, "last_synced_at": page.LastSyncedAt}}, profile.Epoch)
}

func (s *Server) collection(w http.ResponseWriter, r *http.Request, requestID, module, selectionID string) {
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	var itemsRaw []json.RawMessage
	var next string
	var err error
	limit, cursor := pageLimit(r.URL.Query().Get("limit"), 200), r.URL.Query().Get("cursor")
	var resources []struct{ Payload json.RawMessage }
	if selectionID != "" {
		actual, page, listErr := s.engine.ListResourcesForSelection(r.Context(), access, module, selectionID, cursor, limit)
		next, err = page, listErr
		for _, item := range actual {
			resources = append(resources, struct{ Payload json.RawMessage }{item.Payload})
		}
	} else {
		actual, page, listErr := s.engine.ListResources(r.Context(), access, module, cursor, limit)
		next, err = page, listErr
		for _, item := range actual {
			resources = append(resources, struct{ Payload json.RawMessage }{item.Payload})
		}
	}
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	for _, item := range resources {
		projected, projectErr := projectClosure(module, item.Payload)
		if projectErr != nil {
			s.respond(w, nil, projectErr, 0, requestID, profile.Epoch)
			return
		}
		itemsRaw = append(itemsRaw, projected)
	}
	grant, _ := s.grantForAccess(r.Context(), access)
	lastSynced := time.Time{}
	if grant != nil {
		lastSynced = grant.LastSyncAt
	}
	s.writeJSONWithEpoch(w, http.StatusOK, map[string]any{"items": itemsRaw, "next_cursor": next, "snapshot": map[string]any{"selection_revision": access.Lease.Selection, "head_version": int64(0), "last_synced_at": lastSynced}}, profile.Epoch)
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request, requestID string) {
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	var input engine.TaskCreateInput
	if !s.decode(w, r, &input, requestID) {
		return
	}
	result, err := s.engine.CreateTask(r.Context(), access, input)
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	grant, _ := s.grantForAccess(r.Context(), access)
	s.writeJSONWithEpoch(w, http.StatusCreated, map[string]any{"operation_id": result.OperationID, "state": result.State, "local_task": result.LocalTask, "pending_count": result.PendingCount, "sync": s.syncPayload(grant, result.PendingCount, s.conflictCount(r.Context(), access.Tuple.GrantID), "waiting_network")}, profile.Epoch)
}

func (s *Server) completeTask(w http.ResponseWriter, r *http.Request, requestID, taskID string) {
	if !canonicalUUID(taskID) {
		s.writeError(w, http.StatusBadRequest, "invalid_request", "", requestID, 0)
		return
	}
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	var input engine.TaskCompleteInput
	if !s.decode(w, r, &input, requestID) {
		return
	}
	result, err := s.engine.CompleteTask(r.Context(), access, taskID, input)
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	grant, _ := s.grantForAccess(r.Context(), access)
	s.writeJSONWithEpoch(w, http.StatusOK, map[string]any{"operation_id": result.OperationID, "state": result.State, "local_task": result.LocalTask, "pending_count": result.PendingCount, "sync": s.syncPayload(grant, result.PendingCount, s.conflictCount(r.Context(), access.Tuple.GrantID), "waiting_network")}, profile.Epoch)
}

func (s *Server) syncStatus(w http.ResponseWriter, r *http.Request, requestID string, trigger bool) {
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	if trigger {
		var input struct {
			Reason string `json:"reason"`
		}
		if !s.decode(w, r, &input, requestID) || input.Reason != "user" {
			return
		}
		if s.syncHooks.Trigger != nil {
			s.syncHooks.Trigger(access.Tuple.GrantID)
		}
	}
	grant, err := s.grantForAccess(r.Context(), access)
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	_, pending, _, _ := s.engine.Counts(r.Context(), grant.Tuple.GrantID)
	state := "idle"
	if pending > 0 {
		state = "waiting_network"
	}
	status := http.StatusOK
	if trigger {
		status = http.StatusAccepted
	}
	s.writeJSONWithEpoch(w, status, s.syncPayload(grant, pending, s.conflictCount(r.Context(), grant.Tuple.GrantID), state), profile.Epoch)
}

func (s *Server) conflicts(w http.ResponseWriter, r *http.Request, requestID string) {
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	items, next, err := s.engine.Conflicts(r.Context(), access, r.URL.Query().Get("cursor"), pageLimit(r.URL.Query().Get("limit"), 100))
	s.respond(w, map[string]any{"items": items, "next_cursor": next}, err, http.StatusOK, requestID, profile.Epoch)
}

func (s *Server) grantForAccess(ctx context.Context, access *session.Access) (*catalog.Grant, error) {
	items, _, err := s.engine.Grants(ctx, access.BrowserID, "", 100)
	if err != nil {
		return nil, err
	}
	for index := range items {
		if items[index].Tuple.GrantID == access.Tuple.GrantID {
			return &items[index], nil
		}
	}
	return nil, engine.ErrNotFound
}

func (s *Server) syncPayload(grant *catalog.Grant, pending, conflicts int, state string) map[string]any {
	selectionRevision := int64(0)
	leaseExpiry := time.Time{}
	lastSuccess := time.Time{}
	if grant != nil {
		selectionRevision, leaseExpiry, lastSuccess = grant.SelectionRevision, grant.LeaseExpiresAt, grant.LastSyncAt
	}
	result := map[string]any{"state": state, "server_reachability": "unknown", "pending_count": pending, "conflict_count": conflicts, "outcome_unknown_count": 0, "lease_expires_at": leaseExpiry, "selection_revision": selectionRevision, "last_success_at": optionalTime(lastSuccess)}
	if grant != nil && s.syncHooks.Status != nil {
		runtime := s.syncHooks.Status(grant.Tuple.GrantID)
		if runtime.State != "" {
			result["state"] = runtime.State
		}
		if runtime.Reachability != "" {
			result["server_reachability"] = runtime.Reachability
		}
		result["last_attempt_at"] = optionalTime(runtime.LastAttemptAt)
		if runtime.LastSuccessAt.After(lastSuccess) {
			result["last_success_at"] = optionalTime(runtime.LastSuccessAt)
		}
		result["next_attempt_at"] = optionalTime(runtime.NextAttemptAt)
		if runtime.LastErrorCode != "" {
			result["last_error"] = map[string]any{"code": runtime.LastErrorCode, "message": "La sincronización local requiere reintento.", "retryable": runtime.Retryable}
		}
	}
	return result
}

func (s *Server) conflictCount(ctx context.Context, grantID string) int {
	count, _ := s.engine.ConflictCount(ctx, grantID)
	return count
}

func snapshotMeta(access *session.Access, items []catalog.Selection) map[string]any {
	version := int64(0)
	lastSync := time.Time{}
	for _, item := range items {
		if item.HeadVersion > version {
			version = item.HeadVersion
		}
		if item.LastSyncedAt.After(lastSync) {
			lastSync = item.LastSyncedAt
		}
	}
	return map[string]any{"selection_revision": access.Lease.Selection, "head_version": version, "last_synced_at": lastSync}
}

func (s *Server) preflight(w http.ResponseWriter, r *http.Request, requestID string) {
	method := r.Header.Get("Access-Control-Request-Method")
	if method != http.MethodGet && method != http.MethodPost {
		s.writeError(w, http.StatusForbidden, "cors_denied", "", requestID, 0)
		return
	}
	allowed := map[string]bool{"authorization": true, "content-type": true, "dpop": true, "x-clarin-browser-profile-id": true, "x-clarin-protocol": true, "x-clarin-request-id": true}
	for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
		header = strings.ToLower(strings.TrimSpace(header))
		if header != "" && !allowed[header] {
			s.writeError(w, http.StatusForbidden, "cors_denied", "", requestID, 0)
			return
		}
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,DPoP,X-Clarin-Browser-Profile-ID,X-Clarin-Protocol,X-Clarin-Request-ID")
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) securityHeaders(w http.ResponseWriter, requestID string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	w.Header().Set("X-Clarin-Protocol", "3")
	w.Header().Set("X-Clarin-Request-ID", requestID)
	w.Header().Set("DPoP-Nonce", s.nonces.issue())
	w.Header().Add("Vary", "Origin")
	w.Header().Add("Vary", "Access-Control-Request-Method")
	w.Header().Add("Vary", "Access-Control-Request-Headers")
}

func (s *Server) decode(w http.ResponseWriter, r *http.Request, target any, requestID string) bool {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		s.writeError(w, http.StatusUnsupportedMediaType, "invalid_content_type", "", requestID, 0)
		return false
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid_request", "", requestID, 0)
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		s.writeError(w, http.StatusBadRequest, "invalid_request", "", requestID, 0)
		return false
	}
	return true
}

func (s *Server) requireEmptyObject(w http.ResponseWriter, r *http.Request, requestID string) bool {
	var input struct{}
	return s.decode(w, r, &input, requestID)
}

func (s *Server) respond(w http.ResponseWriter, value any, err error, successStatus int, requestID string, epoch int64) {
	if err == nil {
		s.writeJSONWithEpoch(w, successStatus, value, epoch)
		return
	}
	status, code := errorStatus(err)
	if errors.Is(err, engine.ErrCredentialBusy) {
		w.Header().Set("Retry-After", "2")
	}
	s.writeError(w, status, code, "", requestID, epoch)
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, value any) {
	s.writeJSONWithEpoch(w, status, value, 0)
}

func (s *Server) writeJSONWithEpoch(w http.ResponseWriter, status int, value any, epoch int64) {
	if epoch > 0 {
		w.Header().Set("X-Clarin-Profile-Epoch", strconv.FormatInt(epoch, 10))
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (s *Server) writeError(w http.ResponseWriter, status int, code, message, requestID string, epoch int64) {
	payload := map[string]any{"error": code, "request_id": requestID}
	if message != "" {
		payload["message"] = message
	}
	if epoch > 0 {
		payload["profile_epoch"] = epoch
	}
	s.writeJSONWithEpoch(w, status, payload, epoch)
}

func errorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, engine.ErrInvalid):
		return http.StatusBadRequest, "invalid_request"
	case errors.Is(err, engine.ErrNotFound), errors.Is(err, catalog.ErrNotFound):
		return http.StatusNotFound, "resource_not_available"
	case errors.Is(err, engine.ErrDescriptor):
		return http.StatusLocked, "descriptor_unavailable"
	case errors.Is(err, engine.ErrGrantLocked):
		return http.StatusLocked, "grant_locked"
	case errors.Is(err, engine.ErrGrantRevoked):
		return http.StatusLocked, "grant_revoked"
	case errors.Is(err, engine.ErrLeaseExpired):
		return http.StatusLocked, "lease_expired"
	case errors.Is(err, engine.ErrAlreadyAvailable):
		return http.StatusConflict, "grant_already_available"
	case errors.Is(err, engine.ErrActionDenied):
		return http.StatusForbidden, "action_denied"
	case errors.Is(err, engine.ErrCredential):
		return http.StatusUnauthorized, "invalid_offline_credential"
	case errors.Is(err, engine.ErrCredentialBusy):
		return http.StatusTooManyRequests, "credential_busy"
	case errors.Is(err, engine.ErrPendingOperations):
		return http.StatusConflict, "pending_operations"
	case errors.Is(err, vault.ErrOperationIDReuse):
		return http.StatusConflict, "operation_id_reuse"
	case errors.Is(err, vault.ErrQuotaExceeded), errors.Is(err, vault.ErrOutboxFull):
		return http.StatusInsufficientStorage, "quota_exceeded"
	case errors.Is(err, engine.ErrOperationEnvelopeTooLarge):
		return http.StatusRequestEntityTooLarge, "operation_too_large"
	case errors.Is(err, catalog.ErrUnlockThrottled):
		return http.StatusTooManyRequests, "unlock_throttled"
	case errors.Is(err, catalog.ErrTupleMismatch):
		return http.StatusConflict, "identity_changed"
	default:
		return http.StatusInternalServerError, "local_service_error"
	}
}

func exactURI(r *http.Request) string {
	return localBaseURL + strings.TrimPrefix(r.URL.RequestURI(), "/v3")
}

func canonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == strings.ToLower(value)
}

func pageLimit(raw string, maximum int) int {
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 50
	}
	if value > maximum {
		return maximum
	}
	return value
}

func optionalTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}

func (s *Server) allowRequest() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if s.rateWindow.IsZero() || now.Sub(s.rateWindow) >= time.Second {
		s.rateWindow, s.rateCount = now, 0
	}
	s.rateCount++
	return s.rateCount <= 300
}

var _ = fmt.Sprintf
var _ = url.URL{}
