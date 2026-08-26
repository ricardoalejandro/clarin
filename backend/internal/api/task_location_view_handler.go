package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

type taskLocationViewCursor struct {
	SortOrder int64     `json:"sort_order"`
	ID        uuid.UUID `json:"id"`
}

func encodeTaskLocationViewCursor(sortOrder int64, id uuid.UUID) string {
	payload, _ := json.Marshal(taskLocationViewCursor{SortOrder: sortOrder, ID: id})
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeTaskLocationViewCursor(raw string) (*int64, *uuid.UUID, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil, nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, nil, repository.ErrTaskLocationViewInvalid
	}
	var cursor taskLocationViewCursor
	if err := json.Unmarshal(payload, &cursor); err != nil || cursor.SortOrder < 0 || cursor.ID == uuid.Nil {
		return nil, nil, repository.ErrTaskLocationViewInvalid
	}
	return &cursor.SortOrder, &cursor.ID, nil
}

func taskLocationViewID(c *fiber.Ctx) (uuid.UUID, error) {
	id, err := uuid.Parse(strings.TrimSpace(c.Params("viewId")))
	if err != nil || id == uuid.Nil {
		return uuid.Nil, repository.ErrTaskLocationViewInvalid
	}
	return id, nil
}

func taskLocationViewError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, repository.ErrTaskLocationViewDisabled):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Las vistas de Pizarra aún no están disponibles", "code": "work_whiteboard_views_disabled"})
	case errors.Is(err, repository.ErrTaskLocationViewNotFound), errors.Is(err, repository.ErrTaskLocationViewParent),
		errors.Is(err, repository.ErrTaskWorkNotFound), errors.Is(err, repository.ErrWhiteboardNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "La vista no está disponible", "code": "location_view_not_found"})
	case errors.Is(err, repository.ErrTaskAccessDenied), errors.Is(err, repository.ErrWhiteboardForbidden):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "No tienes permiso para realizar esta acción", "code": "location_view_forbidden"})
	case errors.Is(err, repository.ErrTaskLocationViewConflict), errors.Is(err, repository.ErrWhiteboardConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La vista cambió en otra sesión; actualiza y reintenta", "code": "location_view_conflict"})
	case errors.Is(err, repository.ErrTaskLocationViewInvalid), errors.Is(err, repository.ErrWhiteboardInvalid),
		errors.Is(err, service.ErrWhiteboardPayloadInvalid):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Los datos de la vista no son válidos", "code": "invalid_location_view"})
	default:
		return whiteboardError(c, err)
	}
}

func (s *Server) workWhiteboardViewsEnabled() bool {
	return s.cfg != nil && s.cfg.WorkWhiteboardViewsEnabled
}

// includeTaskLocationWhiteboardCounts keeps Archive/Trash useful to Work-only
// actors while making contextual whiteboard metadata disappear completely when
// rollout is off or the actor lacks the Whiteboards module. The repository
// receives the decision so it can omit the count subqueries, not merely redact
// the serialized value afterwards.
func (s *Server) includeTaskLocationWhiteboardCounts(c *fiber.Ctx) (bool, error) {
	if !s.workWhiteboardViewsEnabled() {
		return false, nil
	}
	accountID, accountOK := c.Locals("account_id").(uuid.UUID)
	actorID, actorOK := c.Locals("user_id").(uuid.UUID)
	if !accountOK || !actorOK || accountID == uuid.Nil || actorID == uuid.Nil {
		return false, repository.ErrTaskWorkNotFound
	}
	return s.repos.TaskWork.CanUseTaskLocationViews(c.Context(), accountID, actorID)
}

func (s *Server) requireWorkWhiteboardViewsEnabled(c *fiber.Ctx) error {
	if !s.workWhiteboardViewsEnabled() {
		return taskLocationViewError(c, repository.ErrTaskLocationViewDisabled)
	}
	return c.Next()
}

func (s *Server) requireWorkWhiteboardOriginEnabled(c *fiber.Ctx) error {
	if s.workWhiteboardViewsEnabled() {
		return c.Next()
	}
	accountID, accountOK := c.Locals("account_id").(uuid.UUID)
	actorID, actorOK := c.Locals("user_id").(uuid.UUID)
	if !accountOK || !actorOK || accountID == uuid.Nil || actorID == uuid.Nil {
		return fiber.ErrUnauthorized
	}
	boardID, err := uuid.Parse(strings.TrimSpace(c.Params("id")))
	if err != nil || boardID == uuid.Nil {
		return c.Next()
	}
	// Authorization deliberately precedes origin discovery. Otherwise a member
	// could distinguish a hidden contextual board from an unknown UUID while
	// the rollout is disabled. Requiring only Ver preserves the downstream
	// endpoint's own action-specific 403 contract for visible standalone boards.
	if _, err := s.repos.Whiteboard.RequireAccess(c.Context(), accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return whiteboardError(c, err)
	}
	contextual, err := s.repos.Whiteboard.IsWorkOrigin(c.Context(), accountID, boardID)
	if err != nil {
		return whiteboardError(c, err)
	}
	if contextual {
		// Generic routes must be indistinguishable from an unavailable board while
		// the kill switch is off. The contextual API keeps its explicit rollout
		// error because selecting that API already proves knowledge of the feature.
		return whiteboardError(c, repository.ErrWhiteboardNotFound)
	}
	return c.Next()
}

func (s *Server) revokeTaskLocationWhiteboardSockets(accountID uuid.UUID, boardIDs []uuid.UUID) {
	for _, boardID := range boardIDs {
		s.invalidateWorkWhiteboardSockets(accountID, boardID)
	}
	if len(boardIDs) > 0 {
		// Parent archive/Trash/restore calls share this room invalidation path.
		// Redact Work cards pessimistically across instances; the canonical Hub
		// snapshot immediately restores still-visible historical locations.
		s.notifyWhiteboardWorkHubRevoked(accountID)
	}
}

func (s *Server) purgeTaskLocationWhiteboardSockets(accountID uuid.UUID, boardIDs []uuid.UUID) {
	for _, boardID := range boardIDs {
		s.revokeWhiteboardBoardSockets(accountID, boardID)
	}
	if len(boardIDs) > 0 {
		s.notifyWhiteboardWorkHubRevoked(accountID)
	}
}

func (s *Server) notifyTaskLocationWhiteboardAccessChanged(accountID uuid.UUID, boardIDs []uuid.UUID) {
	for _, boardID := range boardIDs {
		s.notifyWhiteboardAccessChanged(accountID, boardID)
	}
	if len(boardIDs) > 0 {
		s.notifyWhiteboardWorkHubRevoked(accountID)
	}
}

func taskLocationMutationHash(payload any) (string, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return service.HashWhiteboardOperationPayload(encoded)
}

type taskLocationCanonicalMutationPayload struct {
	Action          string    `json:"action"`
	Type            string    `json:"type"`
	AccountID       uuid.UUID `json:"account_id"`
	EnvironmentID   uuid.UUID `json:"environment_id"`
	ScopeType       string    `json:"scope_type"`
	ScopeID         uuid.UUID `json:"scope_id"`
	ViewID          uuid.UUID `json:"view_id"`
	Name            string    `json:"name"`
	ExpectedVersion int64     `json:"expected_version"`
}

func taskLocationCanonicalMutationHash(item *domain.TaskLocationView, action, name string, expectedVersion int64) (string, error) {
	if item == nil || item.ID == uuid.Nil || item.AccountID == uuid.Nil || item.EnvironmentID == uuid.Nil || item.Scope == nil ||
		item.Scope.ScopeID == uuid.Nil || item.Type != domain.TaskLocationViewTypeWhiteboard || strings.TrimSpace(action) == "" ||
		strings.TrimSpace(name) == "" || expectedVersion <= 0 {
		return "", repository.ErrTaskLocationViewInvalid
	}
	return taskLocationMutationHash(taskLocationCanonicalMutationPayload{
		Action: action, Type: item.Type, AccountID: item.AccountID, EnvironmentID: item.EnvironmentID,
		ScopeType: item.Scope.ScopeType, ScopeID: item.Scope.ScopeID, ViewID: item.ID,
		Name: strings.TrimSpace(name), ExpectedVersion: expectedVersion,
	})
}

func stableTaskLocationBoardID(accountID, actorID, operationID uuid.UUID) (uuid.UUID, error) {
	actorOperationID := uuid.NewSHA1(actorID, operationID[:])
	return service.StableWhiteboardID(accountID, actorOperationID)
}

func (s *Server) handleListTaskLocationViews(c *fiber.Ctx) error {
	if !s.workWhiteboardViewsEnabled() {
		return c.JSON(fiber.Map{"success": true, "location_views": []*domain.TaskLocationView{}, "next_cursor": "", "feature_enabled": false})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	scopeType := strings.ToLower(strings.TrimSpace(c.Query("scope_type")))
	scopeID, err := uuid.Parse(strings.TrimSpace(c.Query("scope_id")))
	if err != nil {
		return taskLocationViewError(c, repository.ErrTaskLocationViewInvalid)
	}
	afterOrder, afterID, err := decodeTaskLocationViewCursor(c.Query("cursor"))
	if err != nil {
		return taskLocationViewError(c, err)
	}
	limit, _ := strconv.Atoi(strings.TrimSpace(c.Query("limit")))
	includeArchived := strings.EqualFold(strings.TrimSpace(c.Query("lifecycle")), "archive") ||
		strings.EqualFold(strings.TrimSpace(c.Query("lifecycle")), "archived")
	items, hasMore, err := s.repos.TaskLocationView.List(c.Context(), accountID, actorID, repository.TaskLocationViewListOptions{
		ScopeType: scopeType, ScopeID: scopeID, AfterSortOrder: afterOrder, AfterID: afterID, Limit: limit,
		IncludeArchived: includeArchived,
	})
	if err != nil {
		return taskLocationViewError(c, err)
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = encodeTaskLocationViewCursor(last.SortOrder, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "location_views": items, "next_cursor": nextCursor, "feature_enabled": true})
}

func (s *Server) handleGetTaskLocationView(c *fiber.Ctx) error {
	viewID, err := taskLocationViewID(c)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	item, err := s.repos.TaskLocationView.Get(c.Context(), c.Locals("account_id").(uuid.UUID), c.Locals("user_id").(uuid.UUID), viewID)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "location_view": item, "feature_enabled": true})
}

func (s *Server) handleCreateTaskLocationView(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	var request struct {
		Type        string     `json:"type"`
		ScopeType   string     `json:"scope_type"`
		ScopeID     uuid.UUID  `json:"scope_id"`
		Name        string     `json:"name"`
		OperationID *uuid.UUID `json:"operation_id"`
	}
	if err := c.BodyParser(&request); err != nil {
		return taskLocationViewError(c, repository.ErrTaskLocationViewInvalid)
	}
	request.Type = strings.ToLower(strings.TrimSpace(request.Type))
	request.ScopeType = strings.ToLower(strings.TrimSpace(request.ScopeType))
	if request.Type != domain.TaskLocationViewTypeWhiteboard || (request.ScopeType != domain.TaskAccessTargetFolder && request.ScopeType != domain.TaskAccessTargetList) || request.ScopeID == uuid.Nil {
		return taskLocationViewError(c, repository.ErrTaskLocationViewInvalid)
	}
	name, err := service.NormalizeWhiteboardName(request.Name, 200)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	operationID := uuid.New()
	if request.OperationID != nil && *request.OperationID != uuid.Nil {
		operationID = *request.OperationID
	}
	access, environmentID, err := s.repos.TaskWork.ResolveContainerAccess(c.Context(), accountID, actorID, request.ScopeID, request.ScopeType)
	if err != nil || !repository.TaskAccessAllows(access, domain.TaskAccessFull) {
		if err == nil {
			err = repository.ErrTaskAccessDenied
		}
		return taskLocationViewError(c, err)
	}
	payloadHash, err := taskLocationMutationHash(struct {
		Action        string    `json:"action"`
		AccountID     uuid.UUID `json:"account_id"`
		EnvironmentID uuid.UUID `json:"environment_id"`
		Type          string    `json:"type"`
		ScopeType     string    `json:"scope_type"`
		ScopeID       uuid.UUID `json:"scope_id"`
		Name          string    `json:"name"`
	}{"create", accountID, environmentID, request.Type, request.ScopeType, request.ScopeID, name})
	if err != nil {
		return taskLocationViewError(c, err)
	}
	if existing, found, findErr := s.repos.TaskLocationView.FindOperation(c.Context(), accountID, actorID, operationID, "create", payloadHash); findErr != nil {
		return taskLocationViewError(c, findErr)
	} else if found {
		s.notifyWhiteboardHubChanged(accountID)
		return c.JSON(fiber.Map{"success": true, "location_view": existing, "idempotent": true})
	}
	boardID, err := stableTaskLocationBoardID(accountID, actorID, operationID)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	viewID := uuid.NewSHA1(boardID, []byte("clarin-work-location-view"))
	scene, sceneHash, err := service.ValidateAndHashWhiteboardScene(emptyWhiteboardScene)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	if referenced, referenceErr := whiteboardcore.ReferencedFileIDs(scene); referenceErr != nil || len(referenced) != 0 {
		return taskLocationViewError(c, repository.ErrTaskLocationViewInvalid)
	}
	prepared, err := s.prepareAndUploadWhiteboardSnapshot(c.Context(), accountID, boardID, operationID, scene)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	item, idempotent, err := s.repos.TaskLocationView.Create(c.Context(), repository.TaskLocationViewCreateInput{
		ViewID: viewID, BoardID: boardID, AccountID: accountID, ActorID: actorID,
		ScopeType: request.ScopeType, ScopeID: request.ScopeID, Name: name, Scene: scene,
		SceneSchemaVersion: "excalidraw", EditorVersion: whiteboardEditorVersion,
		OperationID: operationID, RequestPayloadHash: payloadHash, ResultSceneHash: sceneHash,
		SnapshotObjectKey: prepared.ObjectKey, SnapshotContentHash: prepared.ContentHash, SnapshotSizeBytes: prepared.SizeBytes,
	})
	if err != nil {
		if prepared.UploadedByRequest {
			_ = s.repos.Whiteboard.MarkRevisionSnapshotFailed(c.Context(), accountID, prepared.ObjectKey, "work location view creation failed")
		}
		return taskLocationViewError(c, err)
	}
	status := fiber.StatusCreated
	if idempotent {
		status = fiber.StatusOK
	}
	s.notifyWhiteboardHubChanged(accountID)
	return c.Status(status).JSON(fiber.Map{"success": true, "location_view": item, "idempotent": idempotent})
}

func (s *Server) handleUpdateTaskLocationView(c *fiber.Ctx) error {
	viewID, err := taskLocationViewID(c)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	var request struct {
		Name            string     `json:"name"`
		ExpectedVersion int64      `json:"expected_version"`
		OperationID     *uuid.UUID `json:"operation_id"`
	}
	if err := c.BodyParser(&request); err != nil || request.OperationID == nil || *request.OperationID == uuid.Nil {
		return taskLocationViewError(c, repository.ErrTaskLocationViewInvalid)
	}
	name, err := service.NormalizeWhiteboardName(request.Name, 200)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	contextItem, err := s.repos.TaskLocationView.GetMutationContext(c.Context(), accountID, actorID, viewID)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	payloadHash, err := taskLocationCanonicalMutationHash(contextItem, "update", name, request.ExpectedVersion)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	item, idempotent, err := s.repos.TaskLocationView.Update(c.Context(), accountID,
		actorID, viewID, repository.TaskLocationViewUpdateInput{Name: name,
			ExpectedVersion: request.ExpectedVersion, OperationID: *request.OperationID, RequestPayloadHash: payloadHash})
	if err != nil {
		return taskLocationViewError(c, err)
	}
	s.notifyWhiteboardHubChanged(accountID)
	return c.JSON(fiber.Map{"success": true, "location_view": item, "idempotent": idempotent})
}

func (s *Server) handleDuplicateTaskLocationView(c *fiber.Ctx) error {
	viewID, err := taskLocationViewID(c)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	var request struct {
		Name            string     `json:"name"`
		ExpectedVersion int64      `json:"expected_version"`
		OperationID     *uuid.UUID `json:"operation_id"`
	}
	if err := c.BodyParser(&request); err != nil || request.ExpectedVersion <= 0 || request.OperationID == nil || *request.OperationID == uuid.Nil {
		return taskLocationViewError(c, repository.ErrTaskLocationViewInvalid)
	}
	source, err := s.repos.TaskLocationView.Get(c.Context(), accountID, actorID, viewID)
	if err != nil || source.Resource.Whiteboard == nil || source.Scope == nil {
		if err == nil {
			err = repository.ErrTaskLocationViewNotFound
		}
		return taskLocationViewError(c, err)
	}
	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = whiteboardCopyName(source.Resource.Whiteboard.Name)
	}
	name, err = service.NormalizeWhiteboardName(name, 200)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	payloadHash, err := taskLocationMutationHash(struct {
		Action          string    `json:"action"`
		Type            string    `json:"type"`
		AccountID       uuid.UUID `json:"account_id"`
		EnvironmentID   uuid.UUID `json:"environment_id"`
		ScopeType       string    `json:"scope_type"`
		ScopeID         uuid.UUID `json:"scope_id"`
		SourceViewID    uuid.UUID `json:"source_view_id"`
		SourceBoardID   uuid.UUID `json:"source_board_id"`
		ExpectedVersion int64     `json:"expected_version"`
		Name            string    `json:"name"`
	}{"duplicate", domain.TaskLocationViewTypeWhiteboard, accountID, source.EnvironmentID,
		source.Scope.ScopeType, source.Scope.ScopeID, viewID, source.Resource.Whiteboard.ID, request.ExpectedVersion, name})
	if err != nil {
		return taskLocationViewError(c, err)
	}
	if existing, found, findErr := s.repos.TaskLocationView.FindOperation(c.Context(), accountID, actorID,
		*request.OperationID, "duplicate", payloadHash); findErr != nil {
		return taskLocationViewError(c, findErr)
	} else if found {
		s.notifyWhiteboardHubChanged(accountID)
		return c.JSON(fiber.Map{"success": true, "location_view": existing, "idempotent": true})
	}
	boardID, err := stableTaskLocationBoardID(accountID, actorID, *request.OperationID)
	if err != nil || boardID == source.Resource.Whiteboard.ID {
		return taskLocationViewError(c, repository.ErrTaskLocationViewInvalid)
	}
	newViewID := uuid.NewSHA1(boardID, []byte("clarin-work-location-view"))
	scene, err := s.repos.Whiteboard.GetScene(c.Context(), accountID, actorID, source.Resource.Whiteboard.ID, domain.WhiteboardAccessView)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	prepared, err := s.prepareAndUploadWhiteboardSnapshot(c.Context(), accountID, boardID, *request.OperationID, scene.Scene)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	item, idempotent, err := s.repos.TaskLocationView.Duplicate(c.Context(), repository.TaskLocationViewDuplicateInput{
		ViewID: newViewID, BoardID: boardID, SourceViewID: viewID, SourceBoardID: source.Resource.Whiteboard.ID,
		AccountID: accountID, ActorID: actorID, Name: name, ExpectedVersion: request.ExpectedVersion,
		Scene: scene.Scene, SceneSchemaVersion: scene.SceneSchemaVersion, EditorVersion: scene.EditorVersion,
		OperationID: *request.OperationID, RequestPayloadHash: payloadHash, ResultSceneHash: prepared.SceneHash,
		SnapshotObjectKey: prepared.ObjectKey, SnapshotContentHash: prepared.ContentHash, SnapshotSizeBytes: prepared.SizeBytes,
	})
	if err != nil {
		if prepared.UploadedByRequest {
			_ = s.repos.Whiteboard.MarkRevisionSnapshotFailed(c.Context(), accountID, prepared.ObjectKey, "work location view duplication failed")
		}
		return taskLocationViewError(c, err)
	}
	status := fiber.StatusCreated
	if idempotent {
		status = fiber.StatusOK
	}
	s.notifyWhiteboardHubChanged(accountID)
	return c.Status(status).JSON(fiber.Map{"success": true, "location_view": item, "idempotent": idempotent})
}

func parseTaskLocationViewMutation(c *fiber.Ctx, item *domain.TaskLocationView, action string) (repository.TaskLocationViewMutationInput, error) {
	var request struct {
		ExpectedVersion int64      `json:"expected_version"`
		OperationID     *uuid.UUID `json:"operation_id"`
	}
	if err := c.BodyParser(&request); err != nil || request.ExpectedVersion <= 0 || request.OperationID == nil || *request.OperationID == uuid.Nil {
		return repository.TaskLocationViewMutationInput{}, repository.ErrTaskLocationViewInvalid
	}
	if item == nil || item.Resource.Whiteboard == nil {
		return repository.TaskLocationViewMutationInput{}, repository.ErrTaskLocationViewInvalid
	}
	hash, err := taskLocationCanonicalMutationHash(item, action, item.Resource.Whiteboard.Name, request.ExpectedVersion)
	if err != nil {
		return repository.TaskLocationViewMutationInput{}, err
	}
	return repository.TaskLocationViewMutationInput{ExpectedVersion: request.ExpectedVersion,
		OperationID: *request.OperationID, RequestPayloadHash: hash}, nil
}

func (s *Server) handleTrashTaskLocationView(c *fiber.Ctx) error {
	viewID, err := taskLocationViewID(c)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	contextItem, err := s.repos.TaskLocationView.GetMutationContext(c.Context(), accountID, actorID, viewID)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	input, err := parseTaskLocationViewMutation(c, contextItem, "trash")
	if err != nil {
		return taskLocationViewError(c, err)
	}
	item, idempotent, err := s.repos.TaskLocationView.Trash(c.Context(), accountID, actorID, viewID, input)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	// The repository has committed the access-revision change at this point.
	// Close the contextual room through the shared Redis revocation path so no
	// local or remote editor can continue under the obsolete parent snapshot.
	if item != nil && item.Resource.Whiteboard != nil {
		s.invalidateArchivedWhiteboardSockets(item.AccountID, item.Resource.Whiteboard.ID)
	}
	s.notifyWhiteboardWorkHubRevoked(accountID)
	return c.JSON(fiber.Map{"success": true, "location_view": item, "idempotent": idempotent})
}

func (s *Server) handleRestoreTaskLocationView(c *fiber.Ctx) error {
	viewID, err := taskLocationViewID(c)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	contextItem, err := s.repos.TaskLocationView.GetMutationContext(c.Context(), accountID, actorID, viewID)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	input, err := parseTaskLocationViewMutation(c, contextItem, "restore")
	if err != nil {
		return taskLocationViewError(c, err)
	}
	item, idempotent, err := s.repos.TaskLocationView.Restore(c.Context(), accountID, actorID, viewID, input)
	if err != nil {
		return taskLocationViewError(c, err)
	}
	s.notifyWhiteboardHubChanged(accountID)
	return c.JSON(fiber.Map{"success": true, "location_view": item, "idempotent": idempotent})
}
