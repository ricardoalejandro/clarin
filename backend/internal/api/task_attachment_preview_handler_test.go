package api

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestSetTaskAttachmentCommentPermissionsKeepsResolvedThreadsReadOnly(t *testing.T) {
	ownerID := uuid.New()
	otherID := uuid.New()
	rootID := uuid.New()
	resolvedRootID := uuid.New()
	items := []*domain.TaskAttachmentComment{
		{ID: rootID, AuthorID: ownerID},
		{ID: uuid.New(), ParentID: &rootID, AuthorID: ownerID},
		{ID: resolvedRootID, AuthorID: ownerID, ResolvedAt: timePointerForTaskAttachmentTest()},
		{ID: uuid.New(), ParentID: &resolvedRootID, AuthorID: ownerID},
		{ID: uuid.New(), AuthorID: ownerID, Deleted: true},
	}

	setTaskAttachmentCommentPermissions(items, ownerID, false, true)
	if !items[0].CanResolve || !items[0].CanEdit || !items[0].CanDelete {
		t.Fatal("an active root owned by the viewer must be editable, deletable and resolvable")
	}
	if items[1].CanResolve || !items[1].CanEdit || !items[1].CanDelete {
		t.Fatal("an active reply must be editable by its author but never independently resolvable")
	}
	if !items[2].CanResolve || items[2].CanEdit || items[2].CanDelete || items[3].CanEdit || items[3].CanDelete {
		t.Fatal("a resolved thread must remain reopenable while its root and replies are read-only")
	}
	if items[4].CanResolve || items[4].CanEdit || items[4].CanDelete {
		t.Fatal("a tombstone must not expose mutations")
	}

	setTaskAttachmentCommentPermissions(items[:2], otherID, true, true)
	if !items[0].CanEdit || !items[1].CanDelete {
		t.Fatal("an account administrator must be able to edit and delete active comments")
	}

	setTaskAttachmentCommentPermissions(items[:2], ownerID, false, false)
	if items[0].CanResolve || items[0].CanEdit || items[1].CanDelete {
		t.Fatal("view access must not expose comment mutation controls")
	}
}

func timePointerForTaskAttachmentTest() *time.Time {
	value := time.Unix(1, 0).UTC()
	return &value
}
