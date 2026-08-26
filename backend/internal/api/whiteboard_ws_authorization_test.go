package api

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
	"github.com/naperu/clarin/pkg/config"
)

func TestWhiteboardRoomInvalidationMessagesDescribeLifecycleTruth(t *testing.T) {
	t.Parallel()
	work := workWhiteboardInvalidationMessage()
	if work.Event != whiteboardcore.EventAccessRevoked || work.Code != "work_access_changed" || strings.Contains(strings.ToLower(work.Error), "permanente") {
		t.Fatalf("misleading Work invalidation: %#v", work)
	}
	archived := whiteboardArchivedMessage()
	if archived.Code != "board_archived" || strings.Contains(strings.ToLower(archived.Error), "permanente") {
		t.Fatalf("misleading archive invalidation: %#v", archived)
	}
	deleted := whiteboardBoardDeletedMessage()
	if deleted.Code != "board_deleted" || !strings.Contains(strings.ToLower(deleted.Error), "permanente") {
		t.Fatalf("purge did not retain permanent-delete semantics: %#v", deleted)
	}
}

func TestWhiteboardRealtimeAuthorizationClassification(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		outcome   string
		event     string
		code      string
		closeCode int
	}{
		{
			name: "session expired", err: service.ErrAuthSessionExpired,
			outcome: whiteboardAuthorizationSessionExpired, event: whiteboardcore.EventError,
			code: "session_expired", closeCode: websocket.ClosePolicyViolation,
		},
		{
			name: "view revoked", err: repository.ErrWhiteboardForbidden,
			outcome: whiteboardAuthorizationAccessRevoked, event: whiteboardcore.EventAccessRevoked,
			code: "access_revoked", closeCode: websocket.ClosePolicyViolation,
		},
		{
			name: "board archived or purged", err: repository.ErrWhiteboardNotFound,
			outcome: whiteboardAuthorizationAccessRevoked, event: whiteboardcore.EventAccessRevoked,
			code: "access_revoked", closeCode: websocket.ClosePolicyViolation,
		},
		{
			name: "guest revoked", err: repository.ErrWhiteboardSessionUnavailable,
			outcome: whiteboardAuthorizationAccessRevoked, event: whiteboardcore.EventAccessRevoked,
			code: "access_revoked", closeCode: websocket.ClosePolicyViolation,
		},
		{
			name: "session store unavailable", err: service.ErrAuthSessionUnavailable,
			outcome: whiteboardAuthorizationUnavailable, event: whiteboardcore.EventError,
			code: "authorization_unavailable", closeCode: websocket.CloseTryAgainLater,
		},
		{
			name: "database deadline", err: context.DeadlineExceeded,
			outcome: whiteboardAuthorizationUnavailable, event: whiteboardcore.EventError,
			code: "authorization_unavailable", closeCode: websocket.CloseTryAgainLater,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			wrapped := whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessView, testCase.err)
			if outcome := classifyWhiteboardRealtimeAuthorization(wrapped); outcome != testCase.outcome {
				t.Fatalf("outcome = %q, want %q", outcome, testCase.outcome)
			}
			termination := whiteboardSocketTerminationForAuthorization(wrapped)
			if termination.Message.Event != testCase.event || termination.Message.Code != testCase.code || termination.CloseCode != testCase.closeCode {
				t.Fatalf("unexpected termination: %+v", termination)
			}
		})
	}
}

func TestWhiteboardRealtimeAuthorizationRetainsRequiredLevel(t *testing.T) {
	wrapped := whiteboardRealtimeAuthorizationFailure(domain.WhiteboardAccessEdit, repository.ErrWhiteboardForbidden)
	if !errors.Is(wrapped, repository.ErrWhiteboardForbidden) {
		t.Fatalf("wrapped error lost repository cause: %v", wrapped)
	}
	if level := whiteboardRealtimeAuthorizationRequiredLevel(wrapped, domain.WhiteboardAccessView); level != domain.WhiteboardAccessEdit {
		t.Fatalf("required level = %q, want edit", level)
	}
	if level := whiteboardRealtimeRequiredLevelForEvent(whiteboardcore.EventScenePatch); level != domain.WhiteboardAccessEdit {
		t.Fatalf("scene.patch level = %q, want edit", level)
	}
	if level := whiteboardRealtimeRequiredLevelForEvent(whiteboardcore.EventSyncRequest); level != domain.WhiteboardAccessView {
		t.Fatalf("sync.request level = %q, want view", level)
	}
}

func TestWhiteboardMemberTicketIgnoresAccessJWTExpiry(t *testing.T) {
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	userID := uuid.New()
	member := &whiteboardRealtimePrincipal{UserID: &userID, SessionID: uuid.NewString()}
	if got, want := whiteboardCollabTicketExpiresAt(now, member), now.Add(whiteboardCollabTicketTTL); !got.Equal(want) {
		t.Fatalf("member ticket expiry = %s, want %s", got, want)
	}

	guestID := uuid.New()
	guestExpiry := now.Add(10 * time.Second)
	guest := &whiteboardRealtimePrincipal{GuestSession: &guestID, GuestExpiresAt: &guestExpiry}
	if got := whiteboardCollabTicketExpiresAt(now, guest); !got.Equal(guestExpiry) {
		t.Fatalf("guest ticket expiry = %s, want %s", got, guestExpiry)
	}
}

func TestWhiteboardCollabTicketAccountContextUsesOptionalCanonicalOverride(t *testing.T) {
	fallback := uuid.New()
	override := uuid.New()
	tests := []struct {
		name string
		body string
		want uuid.UUID
	}{
		{name: "empty legacy body", want: fallback},
		{name: "legacy object", body: `{}`, want: fallback},
		{name: "omitted field", body: `{"client":"legacy"}`, want: fallback},
		{name: "canonical override", body: `{"account_id":"` + override.String() + `"}`, want: override},
		{name: "uppercase canonical override", body: `{"account_id":"` + strings.ToUpper(override.String()) + `"}`, want: override},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := whiteboardCollabTicketAccountID([]byte(testCase.body), fallback)
			if err != nil {
				t.Fatalf("resolve account context: %v", err)
			}
			if got != testCase.want {
				t.Fatalf("account = %s, want %s", got, testCase.want)
			}
		})
	}
	if override == fallback {
		t.Fatal("test did not exercise an account override")
	}
}

func TestWhiteboardCollabTicketAccountContextRejectsNonCanonicalUUIDs(t *testing.T) {
	fallback := uuid.New()
	valid := uuid.New()
	compact := strings.ReplaceAll(valid.String(), "-", "")
	tests := []struct {
		name     string
		body     string
		fallback uuid.UUID
	}{
		{name: "missing fallback", body: `{}`, fallback: uuid.Nil},
		{name: "invalid json", body: `{"account_id":`, fallback: fallback},
		{name: "top-level null", body: `null`, fallback: fallback},
		{name: "array", body: `[]`, fallback: fallback},
		{name: "null account", body: `{"account_id":null}`, fallback: fallback},
		{name: "numeric account", body: `{"account_id":7}`, fallback: fallback},
		{name: "empty account", body: `{"account_id":""}`, fallback: fallback},
		{name: "nil UUID", body: `{"account_id":"` + uuid.Nil.String() + `"}`, fallback: fallback},
		{name: "compact UUID", body: `{"account_id":"` + compact + `"}`, fallback: fallback},
		{name: "UUID with whitespace", body: `{"account_id":" ` + valid.String() + `"}`, fallback: fallback},
		{name: "URN UUID", body: `{"account_id":"urn:uuid:` + valid.String() + `"}`, fallback: fallback},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := whiteboardCollabTicketAccountID([]byte(testCase.body), testCase.fallback); !errors.Is(err, repository.ErrWhiteboardInvalid) {
				t.Fatalf("error = %v, want ErrWhiteboardInvalid", err)
			}
		})
	}
}

func TestWhiteboardCollabTicketKillSwitchUsesEffectiveCrossAccountContextBeforeCacheWrite(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve API source directory")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_collab_ticket.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	start := strings.Index(source, "func (s *Server) handleCreateWhiteboardCollabTicket(")
	end := strings.Index(source, "func (s *Server) handleCreateWhiteboardGuestCollabTicket(")
	if start < 0 || end <= start {
		t.Fatal("member collab-ticket handler source bounds changed")
	}
	handler := source[start:end]
	effectiveAccount := strings.Index(handler, "accountID, err := whiteboardCollabTicketAccountID(c.Body(), fallbackAccountID)")
	board := strings.Index(handler, "boardID, err := whiteboardPathID(c, \"id\")")
	accountGate := strings.Index(handler, "s.requireWhiteboardAccountAccess(c.Context(), accountID)")
	moduleGate := strings.Index(handler, "s.whiteboardModuleAllowed(c.Context(), userID, accountID)")
	access := strings.Index(handler, "s.repos.Whiteboard.RequireActiveAccess(c.Context(), accountID, userID, boardID")
	flag := strings.Index(handler, "if !s.workWhiteboardViewsEnabled() {")
	origin := strings.Index(handler, "s.repos.Whiteboard.IsWorkOrigin(c.Context(), accountID, boardID)")
	genericNotFound := strings.Index(handler, "whiteboardError(c, repository.ErrWhiteboardNotFound)")
	cacheWrite := strings.Index(handler, "s.issueWhiteboardCollabTicket(")
	if effectiveAccount < 0 || board < 0 || accountGate < 0 || moduleGate < 0 || access < 0 || flag < 0 || origin < 0 || genericNotFound < 0 || cacheWrite < 0 ||
		!(effectiveAccount < board && board < accountGate && accountGate < moduleGate && moduleGate < access && access < flag && flag < origin && origin < genericNotFound && genericNotFound < cacheWrite) {
		t.Fatal("effective account must pass subscription, module and canonical Ver before origin discovery and ticket cache write")
	}
	if strings.Contains(handler, "work_whiteboard_views_disabled") {
		t.Fatal("member collab-ticket exposed the contextual rollout code on a generic credential route")
	}
}

func TestWhiteboardSocketKillSwitchReauthorizesTicketBeforeOriginDiscovery(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve API source directory")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_ws.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	start := strings.Index(source, "func (s *Server) whiteboardWSUpgrade(")
	end := strings.Index(source, "func (s *Server) requireWhiteboardAccountAccess(")
	if start < 0 || end <= start {
		t.Fatal("whiteboard upgrade source bounds changed")
	}
	handler := source[start:end]
	consume := strings.Index(handler, "s.consumeWhiteboardCollabTicket(c, boardID)")
	account := strings.Index(handler, "s.requireWhiteboardAccountAccess(c.Context(), principal.AccountID)")
	revalidate := strings.Index(handler, "s.validateWhiteboardRealtimeAccess(c.Context(), principal, domain.WhiteboardAccessView)")
	revision := strings.Index(handler, "s.repos.Whiteboard.AccessRevision(c.Context(), principal.AccountID, boardID)")
	if consume < 0 || account <= consume || revalidate <= account || revision <= revalidate {
		t.Fatal("socket upgrade lost ticket -> account -> canonical access -> revision order")
	}

	resolverStart := strings.Index(source, "func (s *Server) resolveWhiteboardRealtimeAccess(")
	resolverEnd := strings.Index(source, "func (s *Server) validateWhiteboardRealtimeAccess(")
	if resolverStart < 0 || resolverEnd <= resolverStart {
		t.Fatal("realtime access resolver source bounds changed")
	}
	resolver := source[resolverStart:resolverEnd]
	session := strings.Index(resolver, "s.services.Auth.ValidateSessionReadOnly(")
	module := strings.Index(resolver, "s.whiteboardModuleAllowed(")
	access := strings.Index(resolver, "s.repos.Whiteboard.RequireActiveAccess(")
	origin := strings.Index(resolver, "s.repos.Whiteboard.IsWorkOrigin(")
	notFound := strings.Index(resolver, "repository.ErrWhiteboardNotFound")
	if session < 0 || module <= session || access <= module || origin <= access || notFound <= origin {
		t.Fatal("realtime member resolver lost session -> module -> canonical access -> origin order")
	}
	guest := resolver[:session]
	if strings.Contains(guest, "IsWorkOrigin(") {
		t.Fatal("guest resolver inspected origin before the standalone-only guest credential query")
	}
}

func TestWhiteboardGuestTicketChecksResolvedAccountBeforeCacheWrite(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve API source directory")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_collab_ticket.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	start := strings.Index(source, "func (s *Server) handleCreateWhiteboardGuestCollabTicket(")
	end := strings.Index(source, "func (s *Server) consumeWhiteboardCollabTicket(")
	if start < 0 || end <= start {
		t.Fatal("guest collab-ticket handler source bounds changed")
	}
	handler := source[start:end]
	resolve := strings.Index(handler, "s.repos.Whiteboard.ResolveGuestSession(")
	accountGate := strings.Index(handler, "s.requireWhiteboardAccountAccess(c.Context(), guest.Session.AccountID)")
	cacheWrite := strings.Index(handler, "s.issueWhiteboardCollabTicket(")
	if resolve < 0 || accountGate < 0 || cacheWrite < 0 || !(resolve < accountGate && accountGate < cacheWrite) {
		t.Fatal("guest ticket must resolve its canonical account and gate tenant access before cache write")
	}
}

func TestWhiteboardSocketRevalidatesAfterRegisterBeforeSnapshotDelivery(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve API source directory")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_ws.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	start := strings.Index(source, "func (s *Server) handleWhiteboardWebSocket(")
	end := strings.Index(source, "func (s *Server) handleWhiteboardRealtimeMessage(")
	if start < 0 || end <= start {
		t.Fatal("websocket handler source bounds changed")
	}
	handler := source[start:end]
	register := strings.Index(handler, "s.whiteboardRooms.Register(client)")
	finalGate := strings.Index(handler, "s.revalidateRegisteredWhiteboardClient(finalCtx, principal, client)")
	sceneRead := strings.Index(handler, "initialScene, err := s.whiteboardRealtimeScene(sceneCtx, principal")
	activation := strings.Index(handler, "client.ActivateWithInitial(initialPayloads...)")
	writer := strings.Index(handler, "go s.writeWhiteboardSocket(")
	if register < 0 || finalGate < 0 || sceneRead < 0 || activation < 0 || writer < 0 ||
		!(register < finalGate && finalGate < sceneRead && sceneRead < activation && activation < writer) {
		t.Fatal("registered activation barrier must hold fanout until canonical snapshot is fixed before writer start")
	}
}

func TestWhiteboardFanoutReauthorizationRetainsWorkSocketAndUpdatesPermission(t *testing.T) {
	t.Parallel()
	hub := whiteboardcore.NewRoomHub()
	server := &Server{whiteboardRooms: hub, cfg: &config.Config{WorkWhiteboardViewsEnabled: true}}
	accountID, boardID, userID := uuid.New(), uuid.New(), uuid.New()
	client := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID, AccessRevision: 8,
		Actor: whiteboardcore.RealtimeActor{ID: uuid.New(), UserID: &userID, Access: domain.WhiteboardAccessComment},
		Send:  make(chan []byte, 2),
	}
	if err := hub.Register(client); err != nil {
		t.Fatal(err)
	}
	server.reconcileWhiteboardFanoutClients(context.Background(), accountID, boardID, 9, true,
		[]whiteboardcore.RealtimeAuthorization{client.AuthorizationSnapshot()},
		func(context.Context, whiteboardcore.RealtimeAuthorization) (string, error) {
			return domain.WhiteboardAccessEdit, nil
		})
	if client.IsClosed() {
		t.Fatal("authorized Work socket was closed after comment-to-edit change")
	}
	snapshot := client.AuthorizationSnapshot()
	if snapshot.AccessRevision != 9 || snapshot.Access != domain.WhiteboardAccessEdit || client.ActorSnapshot().Access != domain.WhiteboardAccessEdit {
		t.Fatalf("canonical permission was not advanced: %#v", snapshot)
	}
	var message whiteboardcore.OutgoingMessage
	select {
	case payload := <-client.Control():
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatal("permission change was not announced")
	}
	if message.Event != whiteboardcore.EventError || message.Code != "permission_changed" {
		t.Fatalf("retained Work socket received terminal semantics: %#v", message)
	}
}

func TestWhiteboardPriorityPermissionControlPreservesFullDurableQueue(t *testing.T) {
	t.Parallel()
	server := &Server{}
	client := &whiteboardcore.RealtimeClient{Send: make(chan []byte, 2)}
	scene := []byte(`{"event":"scene.patch","sequence":12}`)
	comment := []byte(`{"event":"comment.changed","data":{"body":"persistente"}}`)
	if !client.Enqueue(scene) || !client.Enqueue(comment) {
		t.Fatal("could not saturate durable queue")
	}
	server.queuePriorityWhiteboardMessage(client, whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventError, Code: "permission_changed",
		Data: map[string]any{"access": domain.WhiteboardAccessView},
	})
	if got := <-client.Send; string(got) != string(scene) {
		t.Fatalf("scene event was displaced by permission control: %s", got)
	}
	if got := <-client.Send; string(got) != string(comment) {
		t.Fatalf("comment event was displaced by permission control: %s", got)
	}
	select {
	case payload := <-client.Control():
		var message whiteboardcore.OutgoingMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatal(err)
		}
		if message.Code != "permission_changed" {
			t.Fatalf("unexpected control payload: %#v", message)
		}
	default:
		t.Fatal("permission control was not queued on its independent lane")
	}
}

func TestWhiteboardFanoutEpochSerializesACLCommitAfterEnqueue(t *testing.T) {
	t.Parallel()
	hub := whiteboardcore.NewRoomHub()
	accountID, boardID, userID := uuid.New(), uuid.New(), uuid.New()
	client := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID, AccessRevision: 1,
		Actor: whiteboardcore.RealtimeActor{ID: uuid.New(), UserID: &userID, Access: domain.WhiteboardAccessView},
		Send:  make(chan []byte, 2),
	}
	if err := hub.Register(client); err != nil {
		t.Fatal(err)
	}

	var boardEpoch sync.RWMutex
	epochHeld := make(chan struct{})
	allowEnqueue := make(chan struct{})
	server := &Server{
		whiteboardRooms: hub,
		whiteboardFanoutEpochRunner: func(_ context.Context, gotAccount, gotBoard uuid.UUID, callback func(int64) error) error {
			if gotAccount != accountID || gotBoard != boardID {
				t.Fatalf("epoch scope crossed board/account: %s/%s", gotAccount, gotBoard)
			}
			boardEpoch.RLock()
			defer boardEpoch.RUnlock()
			close(epochHeld)
			<-allowEnqueue
			return callback(1)
		},
	}
	broadcastDone := make(chan struct{})
	go func() {
		defer close(broadcastDone)
		server.broadcastWhiteboardMessage(accountID, boardID,
			whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventScenePatch, Sequence: 21}, uuid.Nil)
	}()
	<-epochHeld

	commitAttempted := make(chan struct{})
	commitDone := make(chan struct{})
	go func() {
		close(commitAttempted)
		boardEpoch.Lock()
		client.UpdateAuthorization(2, domain.WhiteboardAccessView)
		boardEpoch.Unlock()
		close(commitDone)
	}()
	<-commitAttempted
	select {
	case <-commitDone:
		t.Fatal("ACL commit crossed the board epoch before fanout enqueue")
	default:
	}
	close(allowEnqueue)
	<-broadcastDone
	select {
	case payload := <-client.Send:
		var message whiteboardcore.OutgoingMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatal(err)
		}
		if message.Sequence != 21 {
			t.Fatalf("unexpected serialized payload: %#v", message)
		}
	default:
		t.Fatal("fanout did not enqueue while holding the access epoch")
	}
	<-commitDone
	if snapshot := client.AuthorizationSnapshot(); snapshot.AccessRevision != 2 {
		t.Fatalf("ACL mutation did not commit after epoch release: %#v", snapshot)
	}
	if slow := hub.BroadcastAtRevision(accountID, boardID,
		whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventScenePatch, Sequence: 22}, uuid.Nil, 1); len(slow) != 0 {
		t.Fatalf("stale epoch recipient was misclassified as slow: %v", slow)
	}
	select {
	case payload := <-client.Send:
		t.Fatalf("stale expected revision enqueued after ACL commit: %s", payload)
	default:
	}
}

func TestWhiteboardEphemeralCacheRequiresOpenClientAtCanonicalRevision(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	client := &whiteboardcore.RealtimeClient{AccessRevision: 7, Send: make(chan []byte, 1)}
	if !whiteboardRealtimeEphemeralCacheValid(client, 7, now.Add(-time.Second), now) {
		t.Fatal("fresh same-revision client cache was rejected")
	}
	if whiteboardRealtimeEphemeralCacheValid(client, 8, now.Add(-time.Second), now) {
		t.Fatal("stale client revision was accepted for ephemeral fanout")
	}
	client.CloseWithTerminal(nil)
	if whiteboardRealtimeEphemeralCacheValid(client, 7, now.Add(-time.Second), now) {
		t.Fatal("closed client reused its ephemeral authorization cache")
	}
}

func TestWhiteboardPresentationEpochRejectsDowngradeWithoutLeaseOrAckAndDeliversStop(t *testing.T) {
	t.Parallel()
	leaseCreated, ackQueued, startedFannedOut := false, false, false
	_, _, err := runWhiteboardPresentationStartAtEpoch(
		func() error {
			return whiteboardRealtimeAuthorizationFailure(
				domain.WhiteboardAccessEdit, repository.ErrWhiteboardForbidden,
			)
		},
		func() (*whiteboardPresentation, bool, error) {
			leaseCreated = true
			return &whiteboardPresentation{ID: uuid.New()}, false, nil
		},
		func(*whiteboardPresentation) error {
			startedFannedOut = true
			return nil
		},
		func(*whiteboardPresentation, bool) { ackQueued = true },
	)
	if err == nil || leaseCreated || ackQueued || startedFannedOut {
		t.Fatalf("downgraded start escaped epoch: err=%v lease=%v ack=%v fanout=%v",
			err, leaseCreated, ackQueued, startedFannedOut)
	}
	if whiteboardFanoutSourceRevisionMatches(whiteboardcore.FanoutEnvelope{SourceAccessRevision: 9}, 10) {
		t.Fatal("remote instance accepted delayed started fanout after ACL epoch advanced")
	}
	if !whiteboardFanoutSourceRevisionMatches(whiteboardcore.FanoutEnvelope{}, 10) {
		t.Fatal("canonical stopped fanout was tied to the obsolete presenter epoch")
	}

	hub := whiteboardcore.NewRoomHub()
	server := &Server{whiteboardRooms: hub}
	accountID, boardID := uuid.New(), uuid.New()
	viewer := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID, AccessRevision: 10,
		Actor: whiteboardcore.RealtimeActor{ID: uuid.New(), Access: domain.WhiteboardAccessView},
		Send:  make(chan []byte, 1),
	}
	if err := hub.Register(viewer); err != nil {
		t.Fatal(err)
	}
	stopped := whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventPresentationChanged,
		Data:  map[string]any{"presentation_id": uuid.New(), "status": "stopped", "reason": "permission_revoked"},
	}
	if !server.enqueueWhiteboardFanoutAtRevision(accountID, boardID, stopped, uuid.Nil, nil, 10) {
		t.Fatal("canonical stop was suppressed after downgrade")
	}
	select {
	case payload := <-viewer.Send:
		var message whiteboardcore.OutgoingMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatal(err)
		}
		data, ok := message.Data.(map[string]any)
		if message.Event != whiteboardcore.EventPresentationChanged || !ok || data["status"] != "stopped" {
			t.Fatalf("unexpected stop payload after downgrade: %#v", message)
		}
	default:
		t.Fatal("viewer did not receive canonical presentation stop")
	}
}

func TestWhiteboardFanoutReauthorizationClosesOnlyCanonicalLossAndTransientFailure(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		workOrigin bool
		err        error
		wantEvent  string
		wantCode   string
	}{
		{name: "standalone revoked", err: repository.ErrWhiteboardForbidden,
			wantEvent: whiteboardcore.EventAccessRevoked, wantCode: "access_revoked"},
		{name: "work revoked", workOrigin: true, err: repository.ErrWhiteboardNotFound,
			wantEvent: whiteboardcore.EventAccessRevoked, wantCode: "work_access_changed"},
		{name: "database unavailable", err: context.DeadlineExceeded,
			wantEvent: whiteboardcore.EventError, wantCode: "authorization_unavailable"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			hub := whiteboardcore.NewRoomHub()
			server := &Server{whiteboardRooms: hub, cfg: &config.Config{WorkWhiteboardViewsEnabled: true}}
			accountID, boardID, userID := uuid.New(), uuid.New(), uuid.New()
			client := &whiteboardcore.RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID,
				AccessRevision: 1, Actor: whiteboardcore.RealtimeActor{ID: uuid.New(), UserID: &userID, Access: domain.WhiteboardAccessView},
				Send: make(chan []byte, 1)}
			if err := hub.Register(client); err != nil {
				t.Fatal(err)
			}
			server.reconcileWhiteboardFanoutClients(context.Background(), accountID, boardID, 2, testCase.workOrigin,
				[]whiteboardcore.RealtimeAuthorization{client.AuthorizationSnapshot()},
				func(context.Context, whiteboardcore.RealtimeAuthorization) (string, error) { return "", testCase.err })
			if !client.IsClosed() {
				t.Fatal("unauthorized socket remained open")
			}
			var message whiteboardcore.OutgoingMessage
			if err := json.Unmarshal(client.TakeTerminal(), &message); err != nil {
				t.Fatal(err)
			}
			if message.Event != testCase.wantEvent || message.Code != testCase.wantCode {
				t.Fatalf("terminal = %#v, want %s/%s", message, testCase.wantEvent, testCase.wantCode)
			}
		})
	}
}

func TestWhiteboardFanoutReauthorizationDeduplicatesSamePrincipal(t *testing.T) {
	t.Parallel()
	hub := whiteboardcore.NewRoomHub()
	server := &Server{whiteboardRooms: hub, cfg: &config.Config{WorkWhiteboardViewsEnabled: true}}
	accountID, boardID, userID := uuid.New(), uuid.New(), uuid.New()
	clients := make([]*whiteboardcore.RealtimeClient, 0, 2)
	authorizations := make([]whiteboardcore.RealtimeAuthorization, 0, 2)
	for range 2 {
		client := &whiteboardcore.RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID,
			AccessRevision: 4, Actor: whiteboardcore.RealtimeActor{ID: uuid.New(), UserID: &userID, Access: domain.WhiteboardAccessView},
			Send: make(chan []byte, 1)}
		if err := hub.Register(client); err != nil {
			t.Fatal(err)
		}
		clients = append(clients, client)
		authorizations = append(authorizations, client.AuthorizationSnapshot())
	}
	resolverCalls := 0
	server.reconcileWhiteboardFanoutClients(context.Background(), accountID, boardID, 5, false, authorizations,
		func(context.Context, whiteboardcore.RealtimeAuthorization) (string, error) {
			resolverCalls++
			return domain.WhiteboardAccessView, nil
		})
	if resolverCalls != 1 {
		t.Fatalf("resolver calls = %d, want one per stable principal", resolverCalls)
	}
	for _, client := range clients {
		if client.IsClosed() || client.AuthorizationSnapshot().AccessRevision != 5 {
			t.Fatalf("same-user socket was not retained and advanced: %#v", client.AuthorizationSnapshot())
		}
	}
}

func TestWhiteboardFanoutForcedGuestRevalidationDoesNotTrustCurrentRevision(t *testing.T) {
	t.Parallel()
	hub := whiteboardcore.NewRoomHub()
	server := &Server{whiteboardRooms: hub, cfg: &config.Config{WorkWhiteboardViewsEnabled: true}}
	accountID, boardID, guestID := uuid.New(), uuid.New(), uuid.New()
	expiresAt := time.Now().UTC().Add(time.Hour)
	client := &whiteboardcore.RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		AccessRevision: 12, GuestExpiresAt: &expiresAt,
		Actor: whiteboardcore.RealtimeActor{ID: uuid.New(), GuestID: &guestID, Access: domain.WhiteboardAccessEdit},
		Send:  make(chan []byte, 1)}
	if err := hub.Register(client); err != nil {
		t.Fatal(err)
	}
	resolverCalls := 0
	server.reconcileWhiteboardFanoutClients(context.Background(), accountID, boardID, 12, false,
		[]whiteboardcore.RealtimeAuthorization{client.AuthorizationSnapshot()},
		func(context.Context, whiteboardcore.RealtimeAuthorization) (string, error) {
			resolverCalls++
			return "", repository.ErrWhiteboardSessionUnavailable
		})
	if resolverCalls != 1 || !client.IsClosed() {
		t.Fatalf("current-revision guest bypassed forced validation: calls=%d closed=%v", resolverCalls, client.IsClosed())
	}
}

func TestWhiteboardGuestTicketResolutionClassifiesCanonicalAndTransientFailures(t *testing.T) {
	linkID := uuid.New()
	valid := &domain.WhiteboardGuestContext{Session: &domain.WhiteboardGuestSession{ShareLinkID: linkID}}
	tests := []struct {
		name  string
		guest *domain.WhiteboardGuestContext
		err   error
		want  error
	}{
		{name: "valid", guest: valid},
		{name: "canonical session loss", err: repository.ErrWhiteboardSessionUnavailable, want: repository.ErrWhiteboardSessionUnavailable},
		{name: "database unavailable", err: errors.New("database unavailable"), want: service.ErrAuthSessionUnavailable},
		{name: "deadline", err: context.DeadlineExceeded, want: service.ErrAuthSessionUnavailable},
		{name: "missing guest", want: repository.ErrWhiteboardSessionUnavailable},
		{name: "missing session", guest: &domain.WhiteboardGuestContext{}, want: repository.ErrWhiteboardSessionUnavailable},
		{name: "link mismatch", guest: &domain.WhiteboardGuestContext{Session: &domain.WhiteboardGuestSession{ShareLinkID: uuid.New()}}, want: repository.ErrWhiteboardSessionUnavailable},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got := whiteboardGuestTicketResolutionError(testCase.guest, linkID, testCase.err)
			if testCase.want == nil && got != nil {
				t.Fatalf("error = %v, want nil", got)
			}
			if testCase.want != nil && !errors.Is(got, testCase.want) {
				t.Fatalf("error = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestWhiteboardMemberPrincipalSerializesOnlyStableSessionIdentity(t *testing.T) {
	userID := uuid.New()
	principal := &whiteboardRealtimePrincipal{
		AccountID: uuid.New(), BoardID: uuid.New(), UserID: &userID, SessionID: uuid.NewString(),
		Actor: whiteboardcore.RealtimeActor{Kind: "user", ID: uuid.New(), UserID: &userID, Access: domain.WhiteboardAccessEdit},
	}
	payload, err := json.Marshal(principal)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(payload)
	if !strings.Contains(serialized, `"session_id"`) {
		t.Fatalf("member principal omitted session identity: %s", serialized)
	}
	for _, forbidden := range []string{`"claims"`, `"expires_at"`, `"last_ephemeral_validation"`} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("member principal leaked unstable field %s: %s", forbidden, serialized)
		}
	}
}

func TestWhiteboardModuleUsesCurrentAdminAndMembershipPermissions(t *testing.T) {
	active := &domain.User{IsActive: true}
	tests := []struct {
		name       string
		user       *domain.User
		membership *domain.UserAccount
		allowed    bool
	}{
		{name: "legacy admin in another account is not authority", user: &domain.User{IsActive: true, IsAdmin: true}, membership: &domain.UserAccount{Role: domain.RoleAgent}},
		{name: "super admin", user: &domain.User{IsActive: true, IsSuperAdmin: true}, membership: &domain.UserAccount{Role: domain.RoleAgent}, allowed: true},
		{name: "account admin", user: active, membership: &domain.UserAccount{Role: domain.RoleAdmin}, allowed: true},
		{name: "explicit whiteboards", user: active, membership: &domain.UserAccount{Role: domain.RoleAgent, Permissions: []string{domain.PermWhiteboards}}, allowed: true},
		{name: "wildcard", user: active, membership: &domain.UserAccount{Role: domain.RoleAgent, Permissions: []string{domain.PermAll}}, allowed: true},
		{name: "unrelated permission", user: active, membership: &domain.UserAccount{Role: domain.RoleAgent, Permissions: []string{domain.PermChats}}},
		{name: "inactive admin", user: &domain.User{IsActive: false, IsAdmin: true}, membership: &domain.UserAccount{Role: domain.RoleAdmin}},
		{name: "missing membership", user: active},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if got := whiteboardMembershipAllowsModule(testCase.user, testCase.membership); got != testCase.allowed {
				t.Fatalf("allowed = %v, want %v", got, testCase.allowed)
			}
		})
	}
}
