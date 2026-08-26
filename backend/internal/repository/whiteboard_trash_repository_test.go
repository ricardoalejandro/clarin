package repository

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestWhiteboardTrashEligibilityIsInclusiveAtRetentionBoundary(t *testing.T) {
	archivedAt := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	next, eligible := whiteboardTrashEligibility(archivedAt, 30, archivedAt.Add(30*24*time.Hour))
	if !eligible {
		t.Fatal("board must become eligible exactly at the retention boundary")
	}
	if !next.Equal(time.Date(2026, 1, 31, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("unexpected eligibility date: %s", next)
	}
	_, eligible = whiteboardTrashEligibility(archivedAt, 30, archivedAt.Add(30*24*time.Hour-time.Nanosecond))
	if eligible {
		t.Fatal("board must not be eligible before the complete retention period")
	}
}

func TestContextualWhiteboardPurgeRequiresRealMemberWorkAdmin(t *testing.T) {
	t.Parallel()
	actorID := uuid.New()
	deletedAt := time.Now().UTC().Add(-45 * 24 * time.Hour)
	state := testWorkWhiteboardListState(actorID)
	state.BoardArchivedAt = &deletedAt
	state.ViewDeletedAt = &deletedAt
	state.Membership = false
	state.UserSuperAdmin = true
	state.Permissions = []string{domain.PermTasks, domain.PermWhiteboards}

	access, location, err := resolveWhiteboardActorAccessState(state, actorID, false)
	if err != nil || access == nil || access.CanView || access.Level != domain.WhiteboardAccessNone || location != nil {
		t.Fatalf("contextual purge admitted a super-admin without account membership: access=%#v location=%#v err=%v", access, location, err)
	}

	state.Membership = true
	state.MembershipRole = domain.RoleAdmin
	state.Permissions = nil
	access, location, err = resolveWhiteboardActorAccessState(state, actorID, false)
	if err != nil || access == nil || access.Level != domain.WhiteboardAccessManage || !access.CanDelete || location == nil ||
		location.Lifecycle != domain.WhiteboardWorkLifecycleTrash {
		t.Fatalf("contextual purge rejected a real member Work admin: access=%#v location=%#v err=%v", access, location, err)
	}

	source := readRepositorySource(t, "whiteboard_trash_repository.go")
	start := strings.Index(source, "func (r *WhiteboardRepository) PurgeBoard(")
	if start < 0 {
		t.Fatal("PurgeBoard source bounds changed")
	}
	purge := source[start:]
	membershipIndex := strings.Index(purge, "lockWhiteboardActorMembershipsTx(")
	lockIndex := strings.Index(purge, "lockWorkWhiteboardParentViewTx(")
	boardQueryIndex := strings.Index(purge, "SELECT name,archived_at FROM whiteboards")
	boardLockIndex := -1
	if boardQueryIndex >= 0 {
		boardLockIndex = strings.Index(purge[boardQueryIndex:], "FOR UPDATE")
		if boardLockIndex >= 0 {
			boardLockIndex += boardQueryIndex
		}
	}
	workGateIndex := strings.Index(purge, "if workLock != nil {")
	resolverIndex := strings.Index(purge, "requireWorkWhiteboardLifecycleAccessTx(")
	standaloneIndex := strings.Index(purge, "else if err := requireWhiteboardAccountAdminTx(")
	if membershipIndex < 0 || lockIndex < 0 || boardQueryIndex < 0 || boardLockIndex < 0 ||
		workGateIndex < 0 || resolverIndex < 0 || standaloneIndex < 0 ||
		!(membershipIndex < lockIndex && lockIndex < boardQueryIndex && boardQueryIndex < boardLockIndex &&
			boardLockIndex < workGateIndex && workGateIndex < resolverIndex && resolverIndex < standaloneIndex) {
		t.Fatal("PurgeBoard must lock member -> Work parent/view -> board, then revalidate contextual or standalone authority")
	}
}
