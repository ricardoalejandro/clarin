package domain

import (
	"time"

	"github.com/google/uuid"
)

const TaskLocationViewTypeWhiteboard = "whiteboard"

const (
	TaskLocationViewVisibilityInherit    = "inherit"
	TaskLocationViewVisibilityRestricted = "restricted"
)

// TaskLocationViewCapabilities are derived from the owning Work container.
// They deliberately do not expose a second ACL for the linked resource.
type TaskLocationViewCapabilities struct {
	CanView         bool `json:"can_view"`
	CanComment      bool `json:"can_comment"`
	CanEdit         bool `json:"can_edit"`
	CanManage       bool `json:"can_manage"`
	CanManageAccess bool `json:"can_manage_access"`
}

type TaskLocationViewResource struct {
	Whiteboard *Whiteboard `json:"whiteboard,omitempty"`
}

// TaskLocationView is a user-installed view at one Work list or folder. The
// resource remains canonical in its own module; this row supplies ownership,
// ordering and lifecycle provenance only.
type TaskLocationView struct {
	ID             uuid.UUID                    `json:"id"`
	AccountID      uuid.UUID                    `json:"account_id,omitempty"`
	Type           string                       `json:"type"`
	EnvironmentID  uuid.UUID                    `json:"environment_id"`
	Scope          *WhiteboardWorkLocation      `json:"scope"`
	SortOrder      int64                        `json:"sort_order"`
	Version        int64                        `json:"version"`
	AccessRevision int64                        `json:"access_revision"`
	VisibilityMode string                       `json:"visibility_mode"`
	Lifecycle      string                       `json:"lifecycle"`
	CreatedBy      *uuid.UUID                   `json:"created_by,omitempty"`
	DeletedAt      *time.Time                   `json:"deleted_at,omitempty"`
	CreatedAt      time.Time                    `json:"created_at"`
	UpdatedAt      time.Time                    `json:"updated_at"`
	Resource       TaskLocationViewResource     `json:"resource"`
	Capabilities   TaskLocationViewCapabilities `json:"capabilities"`
}

type TaskLocationViewVisibilityMember struct {
	UserID               uuid.UUID `json:"user_id"`
	DisplayName          string    `json:"display_name"`
	Username             string    `json:"username"`
	EffectiveAccessLevel string    `json:"effective_access_level"`
	Eligible             bool      `json:"eligible"`
}

type TaskLocationViewVisibilityPolicy struct {
	ViewID          uuid.UUID                           `json:"view_id"`
	VisibilityMode  string                              `json:"visibility_mode"`
	AccessRevision  int64                               `json:"access_revision"`
	Members         []*TaskLocationViewVisibilityMember `json:"members"`
	EffectiveAccess *WhiteboardEffectiveAccess          `json:"effective_access"`
}

type TaskLocationViewVisibilityCandidate struct {
	UserID               uuid.UUID `json:"user_id"`
	DisplayName          string    `json:"display_name"`
	Username             string    `json:"username"`
	EffectiveAccessLevel string    `json:"effective_access_level"`
}

func TaskLocationCapabilities(access *TaskEffectiveAccess) TaskLocationViewCapabilities {
	if access == nil {
		return TaskLocationViewCapabilities{}
	}
	return TaskLocationViewCapabilities{
		CanView: access.CanView, CanComment: access.CanComment, CanEdit: access.CanEdit,
		CanManage: access.Level == TaskAccessFull, CanManageAccess: access.CanManageAccess,
	}
}
