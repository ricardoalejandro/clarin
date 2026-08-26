package domain

import "github.com/google/uuid"

const (
	WhiteboardOriginStandalone = "standalone"
	WhiteboardOriginWork       = "work"

	WhiteboardWorkLifecycleActive   = "active"
	WhiteboardWorkLifecycleArchived = "location_archived"
	WhiteboardWorkLifecycleTrash    = "trash"
)

// WhiteboardWorkBreadcrumbItem is deliberately limited to an authorized
// hierarchy projection. Repositories must omit inaccessible parents rather
// than exposing their names or IDs through the Pizarras Hub.
type WhiteboardWorkBreadcrumbItem struct {
	Type string    `json:"type"`
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

// WhiteboardWorkLocation identifies the Clarin Work location that owns a
// contextual whiteboard. The scene remains canonical in Whiteboard; this is
// provenance and navigation metadata, never a second copy of the document.
type WhiteboardWorkLocation struct {
	TaskViewID    uuid.UUID                      `json:"task_view_id"`
	EnvironmentID uuid.UUID                      `json:"environment_id"`
	ScopeType     string                         `json:"scope_type"`
	ScopeID       uuid.UUID                      `json:"scope_id"`
	ScopeName     string                         `json:"scope_name"`
	Breadcrumb    []WhiteboardWorkBreadcrumbItem `json:"breadcrumb,omitempty"`
	Lifecycle     string                         `json:"lifecycle"`
}
