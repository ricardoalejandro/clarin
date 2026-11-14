package domain

import "github.com/google/uuid"

// TaskContainerRemovalRequest describes one reviewed, atomic structure removal.
type TaskContainerRemovalRequest struct {
	Mode                 string     `json:"mode"`
	DestinationListID    *uuid.UUID `json:"destination_list_id,omitempty"`
	PreviewToken         string     `json:"preview_token"`
	ConfirmationName     string     `json:"confirmation_name"`
	CancelFutureEvents   bool       `json:"cancel_future_events"`
	ConfirmAccessChanges bool       `json:"confirm_access_changes"`
}

type TaskContainerRemovalCounts struct {
	Lists          int `json:"lists"`
	Tasks          int `json:"tasks"`
	Subtasks       int `json:"subtasks"`
	OpenTasks      int `json:"open_tasks"`
	CompletedTasks int `json:"completed_tasks"`
	CancelledTasks int `json:"cancelled_tasks"`
	Events         int `json:"events"`
	Whiteboards    int `json:"whiteboards"`
}

type TaskContainerRemovalPreview struct {
	Type                       string                     `json:"type"`
	ID                         uuid.UUID                  `json:"id"`
	Name                       string                     `json:"name"`
	EnvironmentID              uuid.UUID                  `json:"environment_id"`
	Lifecycle                  string                     `json:"lifecycle"`
	Mode                       string                     `json:"mode"`
	DestinationListID          *uuid.UUID                 `json:"destination_list_id,omitempty"`
	PreviewToken               string                     `json:"preview_token"`
	Counts                     TaskContainerRemovalCounts `json:"counts"`
	RequiresName               bool                       `json:"requires_name"`
	RequiresDestination        bool                       `json:"requires_destination"`
	RequiresEventCancellation  bool                       `json:"requires_event_cancellation"`
	RequiresAccessConfirmation bool                       `json:"requires_access_confirmation"`
	CanExecute                 bool                       `json:"can_execute"`
	Blockers                   []string                   `json:"blockers"`
	AccessChangeSummary        string                     `json:"access_change_summary,omitempty"`
}

type TaskContainerRemovalResult struct {
	OperationID   uuid.UUID   `json:"operation_id"`
	Type          string      `json:"type"`
	ID            uuid.UUID   `json:"id"`
	EnvironmentID uuid.UUID   `json:"environment_id"`
	Action        string      `json:"action"`
	Mode          string      `json:"mode"`
	WhiteboardIDs []uuid.UUID `json:"-"`
	Replayed      bool        `json:"-"`
}
