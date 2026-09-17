package api

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func globalAuthorityHandlerSource(t *testing.T, name string) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), name))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func boundedGlobalAuthorityHandler(t *testing.T, source, name, next string) string {
	t.Helper()
	startMarker := "func (s *Server) " + name
	start := strings.Index(source, startMarker)
	if start < 0 {
		t.Fatalf("missing handler %s", name)
	}
	end := len(source)
	if next != "" {
		offset := strings.Index(source[start+1:], "func (s *Server) "+next)
		if offset < 0 {
			t.Fatalf("missing handler boundary %s", next)
		}
		end = start + 1 + offset
	}
	return source[start:end]
}

func assertMutationNotifyOrder(t *testing.T, body, mutation, notification string) {
	t.Helper()
	mutationIndex := strings.Index(body, mutation)
	notifyIndex := strings.Index(body, notification)
	if mutationIndex < 0 || notifyIndex <= mutationIndex {
		t.Fatalf("expected mutation %q -> notification %q, got %d -> %d",
			mutation, notification, mutationIndex, notifyIndex)
	}
	if strings.Contains(body, "WhiteboardIDsForAccount") || strings.Contains(body, "WhiteboardAccessTargets") ||
		strings.Contains(body, "revokeWhiteboardUserSockets") || strings.Contains(body, "access_revoked") {
		t.Fatal("global authority handler must revalidate rooms, not force an unconditional revoke")
	}
}

func TestAdminMembershipAndAccountMutationsNotifyAffectedAccountsAfterCommit(t *testing.T) {
	t.Parallel()
	source := globalAuthorityHandlerSource(t, "server.go")
	tests := []struct {
		name, next, mutation, notification string
	}{
		{"handleAdminToggleAccount", "handleAdminDeleteAccount", "s.services.Account.ToggleActive", "s.notifyAccountAuthorityChanged"},
		{"handleAdminDeleteAccount", "adminAccountPurgeSummary", "s.services.Account.Delete", "s.notifyAccountAuthorityChanged"},
		{"handleAdminPurgeAccount", "handleAdminGetUsers", "s.repos.Account.PurgeWithAuthorityImpact", "s.invalidateAndNotifyUserAuthority"},
		{"handleAdminAssignUserAccount", "handleAdminRemoveUserAccount", "s.services.Account.AssignUserAccountWithAuthorityImpact", "s.invalidateAndNotifyUserAuthority"},
		{"handleAdminRemoveUserAccount", "handleGetQuickReplies", "s.services.Account.RemoveUserAccountAsWithAuthorityImpact", "s.invalidateAndNotifyUserAuthority"},
	}
	for _, test := range tests {
		body := boundedGlobalAuthorityHandler(t, source, test.name, test.next)
		assertMutationNotifyOrder(t, body, test.mutation, test.notification)
	}
	purge := boundedGlobalAuthorityHandler(t, source, "handleAdminPurgeAccount", "handleAdminGetUsers")
	if !strings.Contains(purge, "s.invalidateAndNotifyUserAuthority(authorityEffect)") {
		t.Fatal("account purge must revoke every captured user before publishing cross-instance authority")
	}
	purgeCommit := strings.Index(purge, "s.repos.Account.PurgeWithAuthorityImpact")
	physicalDelete := strings.Index(purge, "s.storage.DeletePrefix")
	if purgeCommit < 0 || physicalDelete <= purgeCommit {
		t.Fatal("account purge must commit database authority before physical prefix deletion")
	}
	for _, required := range []string{"finalizeAccountPurgeStorageCleanup", "deleted-account", `"deleted_files": cleanup.DeletedFiles`} {
		if !strings.Contains(purge, required) {
			t.Fatalf("account purge lost retryable post-commit storage contract %q", required)
		}
	}
}

func TestAdminAccountPurgeSummaryIncludesContextualWhiteboardRows(t *testing.T) {
	t.Parallel()
	source := globalAuthorityHandlerSource(t, "server.go")
	start := strings.Index(source, "func (s *Server) adminAccountPurgeSummary(")
	endOffset := strings.Index(source[start+1:], "type adminStorageOrphanItem struct")
	if start < 0 || endOffset < 0 {
		t.Fatal("admin account purge summary bounds changed")
	}
	body := source[start : start+1+endOffset]
	for _, table := range []string{
		"task_environments",
		"task_folders",
		"task_lists",
		"tasks",
		"work_events",
		"task_location_views",
		"task_location_view_visibility_members",
		"task_location_whiteboard_views",
		"task_location_view_operations",
	} {
		if !strings.Contains(body, `"`+table+`"`) {
			t.Fatalf("account purge preview omits contextual whiteboard table %s", table)
		}
	}
}

func TestExistingAccountPurgeTablesSkipsOptionalTablesWithoutReordering(t *testing.T) {
	t.Parallel()
	requested := []string{"contacts", "documents", "tasks", "automation_flows"}
	present := []string{"tasks", "contacts", "unrelated"}
	want := []string{"contacts", "tasks"}
	if got := existingAccountPurgeTables(requested, present); !reflect.DeepEqual(got, want) {
		t.Fatalf("existingAccountPurgeTables()=%v, want %v", got, want)
	}
}

func TestProfileMetadataUpdateCannotSilentlyChangeAuthority(t *testing.T) {
	t.Parallel()
	serverSource := globalAuthorityHandlerSource(t, "server.go")
	profile := boundedGlobalAuthorityHandler(t, serverSource, "handleUpdateProfile", "handleUpdateAccount")
	if !strings.Contains(profile, "s.services.Account.UpdateUser") ||
		strings.Contains(profile, "UpdateUserWithAuthorityImpact") ||
		strings.Contains(profile, "notifyWhiteboard") {
		t.Fatal("profile must stay on the metadata-only update path")
	}
	if strings.Count(serverSource, "s.services.Account.UpdateUser(c.Context(), user)") != 1 {
		t.Fatal("metadata-only UpdateUser gained an unreviewed API callsite")
	}

	repositorySource := globalAuthorityHandlerSource(t, "../repository/repository.go")
	start := strings.Index(repositorySource, "func (r *UserRepository) Update(ctx")
	endOffset := strings.Index(repositorySource[start+1:], "func (r *UserRepository) UpdateWithAuthorityImpact")
	if start < 0 || endOffset < 0 {
		t.Fatal("cannot bound metadata-only user update")
	}
	body := repositorySource[start : start+1+endOffset]
	for _, forbidden := range []string{"UpdateWithAuthorityImpact", "bumpAllWhiteboardAccessRevisionTx", "is_admin", "is_super_admin", "role="} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("profile metadata update must not contain authority mutation %q", forbidden)
		}
	}
}

func TestAdminRoleUpdateAndDeleteUseExactCommittedEffect(t *testing.T) {
	t.Parallel()
	source := globalAuthorityHandlerSource(t, "server.go")
	tests := []struct {
		name, next, mutation string
	}{
		{"handleAdminUpdateRole", "handleAdminDeleteRole", "s.services.Role.UpdateWithAuthorityImpact"},
		{"handleAdminDeleteRole", "handleAdminListIntegrations", "s.services.Role.DeleteWithAuthorityImpact"},
	}
	for _, test := range tests {
		body := boundedGlobalAuthorityHandler(t, source, test.name, test.next)
		assertMutationNotifyOrder(t, body, test.mutation, "s.invalidateAndNotifyUserAuthority")
		mutation := strings.Index(body, test.mutation)
		invalidate := strings.Index(body, "s.invalidateAndNotifyUserAuthority(authorityEffect)")
		if invalidate <= mutation {
			t.Fatalf("%s must invalidate the users returned by the committed mutation", test.name)
		}
	}
}

func TestAdminMembershipRemovalReportsWorkEventOrganizerHistory(t *testing.T) {
	t.Parallel()
	source := globalAuthorityHandlerSource(t, "server.go")
	for _, item := range []struct{ name, next string }{
		{"handleAdminDeleteUser", "notifyWhiteboardAuthorityEffect"},
		{"handleAdminRemoveUserAccount", "handleGetQuickReplies"},
	} {
		body := boundedGlobalAuthorityHandler(t, source, item.name, item.next)
		if !strings.Contains(body, "repository.ErrTaskMembershipOwnsEvents") ||
			!strings.Contains(body, `"code": "work_event_organizer_history"`) ||
			!strings.Contains(body, "fiber.StatusConflict") {
			t.Fatalf("%s does not expose the Work organizer-history conflict as HTTP 409", item.name)
		}
	}
}

func TestSubscriptionAuthorityHandlersNotifyAfterSuccessfulMutation(t *testing.T) {
	t.Parallel()
	source := globalAuthorityHandlerSource(t, "subscription_handler.go")
	tests := []struct {
		name, next, mutation string
	}{
		{"handleAdminUpdateAccountSubscription", "handleAdminExtendTrial", "s.services.Subscription.Upsert"},
		{"handleAdminExtendTrial", "handleAdminSuspendSubscription", "s.services.Subscription.ExtendTrial"},
		{"handleAdminSuspendSubscription", "handleAdminReactivateSubscription", "s.services.Subscription.Suspend"},
		{"handleAdminReactivateSubscription", "", "s.services.Subscription.Reactivate"},
	}
	for _, test := range tests {
		body := boundedGlobalAuthorityHandler(t, source, test.name, test.next)
		assertMutationNotifyOrder(t, body, test.mutation, "s.notifyAccountAuthorityChanged")
	}
}

func TestLoginPublishesLazyNormalizationEffectEvenWhenLaterLoginWorkFails(t *testing.T) {
	t.Parallel()
	serverSource := globalAuthorityHandlerSource(t, "server.go")
	login := boundedGlobalAuthorityHandler(t, serverSource, "handleLogin", "handleLogout")
	mutation := strings.Index(login, "s.services.Auth.Login")
	notify := strings.Index(login, "s.notifyWhiteboardAuthorityEffect(authorityEffect)")
	errorBranch := strings.Index(login, "if err != nil")
	if mutation < 0 || notify <= mutation || errorBranch <= notify {
		t.Fatal("login must publish a committed normalization effect before handling later login errors")
	}

	registration := globalAuthorityHandlerSource(t, "auth_registration_handler.go")
	mutation = strings.Index(registration, "s.services.Auth.Login")
	notify = strings.Index(registration, "s.notifyWhiteboardAuthorityEffect(authorityEffect)")
	errorBranch = strings.Index(registration[mutation:], "if err != nil")
	if mutation < 0 || notify <= mutation || errorBranch < 0 || mutation+errorBranch <= notify {
		t.Fatal("registration login must publish a committed normalization effect before its error branch")
	}
}

func TestGlobalAuthorityEffectPublishesOneAccountSignalPerAffectedTenant(t *testing.T) {
	t.Parallel()
	source := globalAuthorityHandlerSource(t, "server.go")
	body := boundedGlobalAuthorityHandler(t, source, "notifyWhiteboardAuthorityEffect", "handleSwitchAccount")
	if !strings.Contains(body, "for _, accountID := range effect.AccountIDs") ||
		!strings.Contains(body, "s.notifyWhiteboardAccountAccessChanged(accountID)") {
		t.Fatal("global authority effects are not published as account-scoped signals")
	}
	if strings.Contains(body, "WhiteboardIDsForAccount") || strings.Contains(body, "notifyWhiteboardAccessChanged") {
		t.Fatal("global authority effect still fans out one signal per board")
	}
}

func TestSessionInvalidationDisconnectsGeneralRealtimeSockets(t *testing.T) {
	t.Parallel()
	source := globalAuthorityHandlerSource(t, "server.go")
	body := boundedGlobalAuthorityHandler(t, source, "invalidateUserSessions", "handleAdminGetRoles")
	redisInvalidation := strings.Index(body, "s.services.Auth.InvalidateUserSessions(userID)")
	socketDisconnect := strings.Index(body, "s.hub.DisconnectUsers([]uuid.UUID{userID})")
	if redisInvalidation < 0 || socketDisconnect <= redisInvalidation {
		t.Fatal("authority invalidation must revoke session credentials and then disconnect stale account sockets")
	}
}

func TestUserAuthorityRevocationInvalidatesBeforeCrossInstanceSignals(t *testing.T) {
	t.Parallel()
	source := globalAuthorityHandlerSource(t, "server.go")
	body := boundedGlobalAuthorityHandler(t, source, "invalidateAndNotifyUserAuthority", "handleSwitchAccount")
	invalidate := strings.Index(body, "s.invalidateUserSessions(effect.UserIDs)")
	whiteboards := strings.Index(body, "s.notifyWhiteboardAuthorityEffect(effect)")
	general := strings.Index(body, "s.publishGeneralRealtimeUserAuthorityChanged(accountID)")
	if invalidate < 0 || general <= invalidate || whiteboards <= general {
		t.Fatalf("revocation order must be session marker/local disconnect -> ID-free general signal -> whiteboard revalidation, got %d -> %d -> %d", invalidate, general, whiteboards)
	}
}

func TestGeneralWebSocketRegistrationUsesFinalSessionAndAuthorityBarrier(t *testing.T) {
	t.Parallel()
	source := globalAuthorityHandlerSource(t, "server.go")
	upgrade := boundedGlobalAuthorityHandler(t, source, "wsUpgrade", "handleLogin")
	epoch := strings.Index(upgrade, "s.hub.AuthorityEpoch(claims.AccountID, claims.UserID)")
	hydrate := strings.Index(upgrade, "s.hydrateAccountScopedClaims")
	if epoch < 0 || hydrate <= epoch || !strings.Contains(upgrade, `c.Locals("ws_authority_epoch", authorityEpoch)`) {
		t.Fatal("WebSocket upgrade must snapshot authority before final account hydration")
	}

	handler := boundedGlobalAuthorityHandler(t, source, "handleWebSocket", "Listen")
	validate := strings.Index(handler, "s.services.Auth.ValidateSessionReadOnly")
	register := strings.Index(handler, "s.hub.RegisterAtAuthorityEpoch")
	writer := strings.Index(handler, "go client.WritePump()")
	if validate < 0 || register <= validate || writer <= register {
		t.Fatalf("general socket activation must validate session -> atomically register epoch -> start writer, got %d -> %d -> %d", validate, register, writer)
	}
}
