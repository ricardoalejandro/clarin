package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/ws"
)

type taskAccessGrantRequest struct {
	UserID          string `json:"user_id"`
	AccessLevel     string `json:"access_level"`
	CanManageAccess bool   `json:"can_manage_access"`
}

type replaceTaskAccessRequest struct {
	AccessMode             *string                  `json:"access_mode"`
	Grants                 []taskAccessGrantRequest `json:"grants"`
	ExpectedAccessRevision int64                    `json:"expected_access_revision"`
	OperationID            string                   `json:"operation_id"`
}

func (s *Server) canCreateTaskEnvironment(c *fiber.Ctx, accountID, userID uuid.UUID) bool {
	if s.isAccountAdmin(c, accountID, userID) {
		return true
	}
	if claims, ok := c.Locals("claims").(*service.JWTClaims); ok {
		for _, permission := range claims.Permissions {
			if permission == domain.PermAll || permission == domain.PermTaskEnvironmentsCreate {
				return true
			}
		}
	}
	permissions, _ := s.repos.UserAccount.GetUserPermissions(c.Context(), userID, accountID)
	for _, permission := range permissions {
		if permission == domain.PermAll || permission == domain.PermTaskEnvironmentsCreate {
			return true
		}
	}
	return false
}

func parseTaskEnvironmentID(c *fiber.Ctx) (uuid.UUID, error) {
	return uuid.Parse(strings.TrimSpace(c.Params("environmentId")))
}

func (s *Server) resolveRequestedTaskEnvironment(c *fiber.Ctx, raw string, required string) (uuid.UUID, error) {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	var environmentID uuid.UUID
	var err error
	if strings.TrimSpace(raw) == "" {
		environmentID, err = s.repos.TaskWork.DefaultEnvironmentID(c.Context(), accountID)
	} else {
		environmentID, err = uuid.Parse(strings.TrimSpace(raw))
	}
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := s.repos.TaskWork.RequireActiveEnvironmentAccess(c.Context(), accountID, userID, environmentID, required); err != nil {
		return uuid.Nil, err
	}
	return environmentID, nil
}

func validTaskEnvironmentVisibility(value string) bool {
	return value == "account" || value == "restricted"
}

func validateTaskEnvironment(environment *domain.TaskEnvironment) error {
	environment.Name = strings.TrimSpace(environment.Name)
	environment.Description = strings.TrimSpace(environment.Description)
	environment.Icon = strings.TrimSpace(environment.Icon)
	if environment.Name == "" || len([]rune(environment.Name)) > 120 || len([]rune(environment.Description)) > 4000 {
		return errors.New("invalid environment text")
	}
	if environment.Icon == "" {
		environment.Icon = "layers"
	}
	if !validTaskContainerIcon(environment.Icon) {
		return errors.New("invalid environment icon")
	}
	color, err := normalizeTaskColor(environment.Color, "#6366F1")
	if err != nil {
		return err
	}
	environment.Color = color
	if environment.Visibility == "" {
		environment.Visibility = "restricted"
	}
	if !validTaskEnvironmentVisibility(environment.Visibility) {
		return errors.New("invalid environment visibility")
	}
	if environment.DefaultAccessLevel == "" {
		environment.DefaultAccessLevel = domain.TaskAccessNone
	}
	if !validTaskAccessLevelRequest(environment.DefaultAccessLevel) {
		return errors.New("invalid environment access")
	}
	return nil
}

func validTaskAccessLevelRequest(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case domain.TaskAccessNone, domain.TaskAccessView, domain.TaskAccessComment, domain.TaskAccessEdit, domain.TaskAccessFull:
		return true
	default:
		return false
	}
}

func (s *Server) handleListTaskEnvironments(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	includeArchived := strings.EqualFold(strings.TrimSpace(c.Query("include_archived")), "true")
	cursorContext := taskStructurePageContext(accountID, "environments:"+strconv.FormatBool(includeArchived), c.Query("search"))
	limit, cursor, err := parseTaskEnvironmentPage(c, cursorContext)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Paginación inválida"})
	}
	items, next, err := s.repos.TaskWork.ListEnvironments(c.Context(), accountID, userID, limit, cursor, c.Query("search"), includeArchived)
	if err != nil {
		return taskWorkError(c, err)
	}
	response, err := taskEnvironmentPageResponse("environments", items, next, cursorContext)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo paginar los entornos"})
	}
	response["can_create"] = s.canCreateTaskEnvironment(c, accountID, userID)
	return c.JSON(response)
}

func (s *Server) handleCreateTaskEnvironment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	if !s.canCreateTaskEnvironment(c, accountID, userID) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "No tienes permiso para crear entornos", "code": "environment_create_denied"})
	}
	var req struct {
		Name               string `json:"name"`
		Description        string `json:"description"`
		Color              string `json:"color"`
		Icon               string `json:"icon"`
		Visibility         string `json:"visibility"`
		DefaultAccessLevel string `json:"default_access_level"`
		OperationID        string `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	operationID, operationIDText, err := optionalTaskOperationID(req.OperationID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	environment := &domain.TaskEnvironment{AccountID: accountID, Name: req.Name, Description: req.Description, Color: req.Color,
		Icon: req.Icon, Visibility: "restricted", DefaultAccessLevel: domain.TaskAccessNone}
	if err := validateTaskEnvironment(environment); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Datos del entorno inválidos"})
	}
	if err := s.repos.TaskWork.CreateEnvironment(c.Context(), environment, userID, operationID); err != nil {
		return taskWorkError(c, err)
	}
	created, err := s.repos.TaskWork.GetEnvironment(c.Context(), accountID, userID, environment.ID)
	if err == nil {
		environment = created
	}
	if s.hub != nil {
		s.hub.BroadcastToAccountUsersWithPermission(accountID, []uuid.UUID{userID}, domain.PermTasks, ws.EventTaskUpdate,
			fiber.Map{"action": "environment_created", "environment": environment, "operation_id": operationIDText})
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "environment": environment, "operation_id": operationIDText})
}

func (s *Server) handleGetTaskEnvironment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := parseTaskEnvironmentID(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	environment, err := s.repos.TaskWork.GetEnvironment(c.Context(), accountID, userID, environmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "environment": environment})
}

func (s *Server) handleUpdateTaskEnvironment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := parseTaskEnvironmentID(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	current, err := s.repos.TaskWork.GetEnvironment(c.Context(), accountID, userID, environmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	beforeViewers, _ := s.repos.TaskWork.EnvironmentViewerUserIDs(c.Context(), accountID, environmentID)
	previousVisibility, previousDefaultAccess := current.Visibility, current.DefaultAccessLevel
	var req struct {
		Name                   *string `json:"name"`
		Description            *string `json:"description"`
		Color                  *string `json:"color"`
		Icon                   *string `json:"icon"`
		Visibility             *string `json:"visibility"`
		DefaultAccessLevel     *string `json:"default_access_level"`
		Version                *int64  `json:"version"`
		ExpectedAccessRevision *int64  `json:"expected_access_revision"`
		OperationID            string  `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil || req.Version == nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Versión obligatoria"})
	}
	operationID, operationIDText, err := optionalTaskOperationID(req.OperationID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	current.Version = *req.Version
	if req.Name != nil {
		current.Name = *req.Name
	}
	if req.Description != nil {
		current.Description = *req.Description
	}
	if req.Color != nil {
		current.Color = *req.Color
	}
	if req.Icon != nil {
		current.Icon = *req.Icon
	}
	if req.Visibility != nil {
		current.Visibility = strings.ToLower(strings.TrimSpace(*req.Visibility))
	}
	if req.DefaultAccessLevel != nil {
		current.DefaultAccessLevel = strings.ToLower(strings.TrimSpace(*req.DefaultAccessLevel))
	}
	privacyChanged := previousVisibility != current.Visibility || previousDefaultAccess != current.DefaultAccessLevel
	if privacyChanged && req.ExpectedAccessRevision == nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "expected_access_revision es obligatorio para cambiar privacidad"})
	}
	if err := validateTaskEnvironment(current); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Datos del entorno inválidos"})
	}
	if err := s.repos.TaskWork.UpdateEnvironment(c.Context(), accountID, userID, current, req.ExpectedAccessRevision, operationID); err != nil {
		return taskWorkError(c, err)
	}
	updated, err := s.repos.TaskWork.GetEnvironment(c.Context(), accountID, userID, environmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	afterViewers, _ := s.repos.TaskWork.EnvironmentViewerUserIDs(c.Context(), accountID, environmentID)
	if s.hub != nil {
		s.hub.BroadcastToAccountUsersWithPermission(accountID, afterViewers, domain.PermTasks, ws.EventTaskUpdate,
			fiber.Map{"action": "environment_updated", "environment": updated, "operation_id": operationIDText})
		revoked := subtractTaskAccessRecipients(beforeViewers, afterViewers)
		if len(revoked) > 0 {
			s.hub.BroadcastToAccountUsersWithPermission(accountID, revoked, domain.PermTasks, ws.EventTaskUpdate,
				fiber.Map{"action": "access_revoked", "target_type": domain.TaskAccessTargetEnvironment,
					"target_id": environmentID, "operation_id": operationIDText})
		}
	}
	return c.JSON(fiber.Map{"success": true, "environment": updated, "operation_id": operationIDText})
}

func optionalTaskOperationID(raw string) (*uuid.UUID, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, "", nil
	}
	parsed, err := uuid.Parse(raw)
	if err != nil {
		return nil, "", err
	}
	return &parsed, parsed.String(), nil
}

func parseTaskEnvironmentVersion(c *fiber.Ctx) (int64, string, error) {
	var req struct {
		Version     int64  `json:"version"`
		OperationID string `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil || req.Version < 1 {
		return 0, "", errors.New("invalid version")
	}
	_, operationIDText, err := optionalTaskOperationID(req.OperationID)
	return req.Version, operationIDText, err
}

func (s *Server) handleArchiveTaskEnvironment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := parseTaskEnvironmentID(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	version, operationID, err := parseTaskEnvironmentVersion(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Versión obligatoria"})
	}
	viewers, _ := s.repos.TaskWork.EnvironmentViewerUserIDs(c.Context(), accountID, environmentID)
	if err := s.repos.TaskWork.ArchiveEnvironment(c.Context(), accountID, userID, environmentID, version); err != nil {
		return taskWorkError(c, err)
	}
	updated, err := s.repos.TaskWork.GetEnvironment(c.Context(), accountID, userID, environmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	if s.hub != nil {
		s.hub.BroadcastToAccountUsersWithPermission(accountID, viewers, domain.PermTasks, ws.EventTaskUpdate,
			fiber.Map{"action": "environment_archived", "environment": updated, "operation_id": operationID})
	}
	return c.JSON(fiber.Map{"success": true, "environment": updated, "operation_id": operationID})
}

func (s *Server) handleRestoreTaskEnvironment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := parseTaskEnvironmentID(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	version, operationID, err := parseTaskEnvironmentVersion(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Versión obligatoria"})
	}
	if err := s.repos.TaskWork.RestoreEnvironment(c.Context(), accountID, userID, environmentID, version); err != nil {
		return taskWorkError(c, err)
	}
	updated, err := s.repos.TaskWork.GetEnvironment(c.Context(), accountID, userID, environmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.broadcastTaskEnvironment(c.Context(), accountID, environmentID, "environment_restored", fiber.Map{"environment": updated, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "environment": updated, "operation_id": operationID})
}

func (s *Server) handleGetTaskEnvironmentHierarchy(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := parseTaskEnvironmentID(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	if _, err := s.repos.TaskWork.RequireActiveEnvironmentAccess(c.Context(), accountID, userID, environmentID, domain.TaskAccessView); err != nil {
		return taskWorkError(c, err)
	}
	folders, roots, err := s.repos.TaskWork.ListFoldersForActor(c.Context(), accountID, userID, &environmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	counts, err := s.repos.TaskWork.HierarchyCountsForActor(c.Context(), accountID, userID, &environmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(putTaskHierarchyCounts(fiber.Map{"success": true, "environment_id": environmentID, "folders": folders, "root_lists": roots}, counts))
}

type taskStructurePageCursorPayload struct {
	Version   int    `json:"v"`
	Context   string `json:"context"`
	SortOrder int    `json:"sort_order"`
	ID        string `json:"id"`
}

func taskStructurePageContext(accountID uuid.UUID, collection, search string) string {
	digest := sha256.Sum256([]byte(accountID.String() + "\x00" + collection + "\x00" + strings.TrimSpace(search)))
	return hex.EncodeToString(digest[:])
}

func encodeTaskStructurePageCursor(cursor *repository.TaskStructurePageCursor, contextKey string) (string, error) {
	if cursor == nil {
		return "", nil
	}
	payload, err := json.Marshal(taskStructurePageCursorPayload{
		Version: 1, Context: contextKey, SortOrder: cursor.SortOrder, ID: cursor.ID.String(),
	})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func decodeTaskStructurePageCursor(raw, contextKey string) (*repository.TaskStructurePageCursor, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if len(raw) > 2048 {
		return nil, errors.New("task structure cursor too long")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	var payload taskStructurePageCursorPayload
	if err := json.Unmarshal(decoded, &payload); err != nil {
		return nil, err
	}
	id, err := uuid.Parse(payload.ID)
	if err != nil || id == uuid.Nil || payload.Version != 1 || payload.Context != contextKey {
		return nil, errors.New("invalid task structure cursor")
	}
	return &repository.TaskStructurePageCursor{SortOrder: payload.SortOrder, ID: id}, nil
}

func parseTaskEnvironmentPage(c *fiber.Ctx, contextKey string) (int, *repository.TaskStructurePageCursor, error) {
	limit, err := strconv.Atoi(c.Query("limit", "50"))
	if err != nil || limit < 1 || limit > 200 {
		return 0, nil, errors.New("invalid page")
	}
	cursor, err := decodeTaskStructurePageCursor(c.Query("cursor"), contextKey)
	if err != nil {
		return 0, nil, err
	}
	return limit, cursor, nil
}

func taskEnvironmentPageResponse(key string, items any, next *repository.TaskStructurePageCursor, contextKey string) (fiber.Map, error) {
	encoded, err := encodeTaskStructurePageCursor(next, contextKey)
	if err != nil {
		return nil, err
	}
	var nextCursor any
	if encoded != "" {
		nextCursor = encoded
	}
	return fiber.Map{"success": true, key: items, "next_cursor": nextCursor}, nil
}

func parseTaskEnvironmentListScope(raw string, hasFolder bool) (bool, error) {
	scope := strings.ToLower(strings.TrimSpace(raw))
	if scope != "" && scope != "root" && scope != "all" {
		return false, errors.New("invalid task environment list scope")
	}
	if scope == "all" && hasFolder {
		return false, errors.New("all task environment lists cannot be folder-scoped")
	}
	return scope == "all", nil
}

func (s *Server) handleListTaskEnvironmentFolders(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := parseTaskEnvironmentID(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	cursorContext := taskStructurePageContext(accountID, "folders:"+environmentID.String(), c.Query("search"))
	limit, cursor, err := parseTaskEnvironmentPage(c, cursorContext)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Paginación inválida"})
	}
	items, next, err := s.repos.TaskWork.ListEnvironmentFolders(c.Context(), accountID, userID, environmentID, limit, cursor, c.Query("search"))
	if err != nil {
		return taskWorkError(c, err)
	}
	response, err := taskEnvironmentPageResponse("folders", items, next, cursorContext)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo paginar las carpetas"})
	}
	return c.JSON(response)
}

func (s *Server) handleListTaskEnvironmentLists(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := parseTaskEnvironmentID(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	var folderID *uuid.UUID
	rawFolderID := strings.TrimSpace(c.Query("folder_id"))
	all, scopeErr := parseTaskEnvironmentListScope(c.Query("scope"), rawFolderID != "")
	if scopeErr != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Alcance de listas inválido"})
	}
	if raw := rawFolderID; raw != "" {
		parsed, parseErr := uuid.Parse(raw)
		if parseErr != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
		}
		folderID = &parsed
	}
	listScope := "root"
	if all {
		listScope = "all"
	} else if folderID != nil {
		listScope = "folder:" + folderID.String()
	}
	cursorContext := taskStructurePageContext(accountID, "lists:"+environmentID.String()+":"+listScope, c.Query("search"))
	limit, cursor, err := parseTaskEnvironmentPage(c, cursorContext)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Paginación inválida"})
	}
	items, next, err := s.repos.TaskWork.ListEnvironmentLists(c.Context(), accountID, userID, environmentID, folderID, all, limit, cursor, c.Query("search"))
	if err != nil {
		return taskWorkError(c, err)
	}
	response, err := taskEnvironmentPageResponse("lists", items, next, cursorContext)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo paginar las listas"})
	}
	return c.JSON(response)
}

type taskSharedResourceCursorPayload struct {
	EnvironmentID string `json:"environment_id"`
	Type          string `json:"type"`
	Name          string `json:"name"`
	ID            string `json:"id"`
}

func parseTaskSharedResourceCursor(raw string, environmentID uuid.UUID) (*repository.TaskSharedResourceCursor, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	var payload taskSharedResourceCursorPayload
	if err := json.Unmarshal(decoded, &payload); err != nil || payload.EnvironmentID != environmentID.String() {
		return nil, errors.New("invalid shared resource cursor")
	}
	id, err := uuid.Parse(payload.ID)
	if err != nil || payload.Type == "" || strings.TrimSpace(payload.Name) == "" {
		return nil, errors.New("invalid shared resource cursor")
	}
	return &repository.TaskSharedResourceCursor{Type: payload.Type, Name: payload.Name, ID: id}, nil
}

func encodeTaskSharedResourceCursor(cursor *repository.TaskSharedResourceCursor, environmentID uuid.UUID) (string, error) {
	if cursor == nil {
		return "", nil
	}
	raw, err := json.Marshal(taskSharedResourceCursorPayload{EnvironmentID: environmentID.String(), Type: cursor.Type, Name: cursor.Name, ID: cursor.ID.String()})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (s *Server) handleListTaskEnvironmentSharedResources(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := parseTaskEnvironmentID(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	limit, err := strconv.Atoi(strings.TrimSpace(c.Query("limit", "50")))
	if err != nil || limit < 1 || limit > 200 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Límite inválido"})
	}
	cursor, err := parseTaskSharedResourceCursor(c.Query("cursor"), environmentID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Cursor inválido"})
	}
	items, next, err := s.repos.TaskWork.ListDirectSharedResources(c.Context(), accountID, userID, environmentID, limit, cursor)
	if err != nil {
		return taskWorkError(c, err)
	}
	nextCursor, err := encodeTaskSharedResourceCursor(next, environmentID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo paginar los recursos compartidos"})
	}
	var encodedNext any
	if nextCursor != "" {
		encodedNext = nextCursor
	}
	return c.JSON(fiber.Map{"success": true, "items": items, "next_cursor": encodedNext})
}

func parseTaskAccessInputs(raw []taskAccessGrantRequest) ([]repository.TaskAccessGrantInput, error) {
	result := make([]repository.TaskAccessGrantInput, 0, len(raw))
	for _, item := range raw {
		userID, err := uuid.Parse(strings.TrimSpace(item.UserID))
		level := strings.ToLower(strings.TrimSpace(item.AccessLevel))
		if err != nil || !validTaskAccessLevelRequest(level) {
			return nil, repository.ErrTaskAccessInvalid
		}
		result = append(result, repository.TaskAccessGrantInput{UserID: userID, AccessLevel: level, CanManageAccess: item.CanManageAccess})
	}
	return result, nil
}

func unionTaskAccessRecipients(groups ...[]uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{})
	result := make([]uuid.UUID, 0)
	for _, group := range groups {
		for _, id := range group {
			if _, exists := seen[id]; exists {
				continue
			}
			seen[id] = struct{}{}
			result = append(result, id)
		}
	}
	return result
}

func subtractTaskAccessRecipients(source, keep []uuid.UUID) []uuid.UUID {
	kept := make(map[uuid.UUID]struct{}, len(keep))
	for _, id := range keep {
		kept[id] = struct{}{}
	}
	result := make([]uuid.UUID, 0)
	for _, id := range source {
		if _, exists := kept[id]; !exists {
			result = append(result, id)
		}
	}
	return result
}

func taskGrantUserIDs(grants []*domain.TaskAccessGrant) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(grants))
	for _, grant := range grants {
		if grant != nil {
			result = append(result, grant.UserID)
		}
	}
	return result
}

func (s *Server) getTaskAccessPayload(c *fiber.Ctx, targetType string, requestedID uuid.UUID) (fiber.Map, error) {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	targetID := requestedID
	environmentID := requestedID
	var access *domain.TaskEffectiveAccess
	var err error
	if targetType == domain.TaskAccessTargetTask {
		targetID, environmentID, _, err = s.repos.TaskWork.CanonicalTaskAccessTarget(c.Context(), accountID, requestedID)
		if err == nil {
			access, err = s.repos.TaskWork.ResolveTaskAccess(c.Context(), accountID, userID, requestedID)
		}
	} else if targetType == domain.TaskAccessTargetFolder || targetType == domain.TaskAccessTargetList {
		access, environmentID, err = s.repos.TaskWork.ResolveContainerAccess(c.Context(), accountID, userID, requestedID, targetType)
	} else {
		access, err = s.repos.TaskWork.ResolveEnvironmentAccess(c.Context(), accountID, userID, requestedID)
	}
	if err != nil {
		return nil, err
	}
	if !access.CanManageAccess {
		if !access.CanView {
			return nil, repository.ErrTaskWorkNotFound
		}
		return nil, repository.ErrTaskAccessDenied
	}
	grants, accessMode, revision, err := s.repos.TaskWork.ListAccessGrants(c.Context(), accountID, targetType, targetID)
	if err != nil {
		return nil, err
	}
	payload := fiber.Map{"success": true, "grants": grants, "effective_access": access, "access_revision": revision}
	if eligibleUserIDs, viewerErr := s.repos.TaskWork.EnvironmentViewerUserIDs(c.Context(), accountID, environmentID); viewerErr == nil {
		payload["eligible_user_ids"] = eligibleUserIDs
	}
	if targetType == domain.TaskAccessTargetTask {
		payload["target_task_id"] = targetID
		payload["access_mode"] = accessMode
	} else if targetType == domain.TaskAccessTargetFolder || targetType == domain.TaskAccessTargetList {
		payload["target_id"] = targetID
		payload["target_type"] = targetType
		payload["access_mode"] = accessMode
	} else {
		payload["environment_id"] = targetID
	}
	return payload, nil
}

func (s *Server) handleGetTaskEnvironmentAccess(c *fiber.Ctx) error {
	environmentID, err := parseTaskEnvironmentID(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	payload, err := s.getTaskAccessPayload(c, domain.TaskAccessTargetEnvironment, environmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(payload)
}

func (s *Server) handleGetTaskAccess(c *fiber.Ctx) error {
	taskID, err := uuid.Parse(strings.TrimSpace(c.Params("id")))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	payload, err := s.getTaskAccessPayload(c, domain.TaskAccessTargetTask, taskID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(payload)
}

func (s *Server) handleGetTaskContainerAccess(c *fiber.Ctx, targetType, param string) error {
	targetID, err := uuid.Parse(strings.TrimSpace(c.Params(param)))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Recurso de Work inválido"})
	}
	payload, err := s.getTaskAccessPayload(c, targetType, targetID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(payload)
}

func (s *Server) handleGetTaskFolderAccess(c *fiber.Ctx) error {
	return s.handleGetTaskContainerAccess(c, domain.TaskAccessTargetFolder, "folderId")
}

func (s *Server) handleGetTaskListAccess(c *fiber.Ctx) error {
	return s.handleGetTaskContainerAccess(c, domain.TaskAccessTargetList, "listId")
}

func (s *Server) replaceTaskAccess(c *fiber.Ctx, targetType string, requestedID uuid.UUID) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	var req replaceTaskAccessRequest
	if err := c.BodyParser(&req); err != nil || req.ExpectedAccessRevision < 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud o revisión inválida"})
	}
	inputs, err := parseTaskAccessInputs(req.Grants)
	if err != nil {
		return taskWorkError(c, err)
	}
	operationID, err := taskStructureOperationID(req.OperationID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	targetID := requestedID
	if targetType == domain.TaskAccessTargetTask {
		targetID, _, _, err = s.repos.TaskWork.CanonicalTaskAccessTarget(c.Context(), accountID, requestedID)
		if err != nil {
			return taskWorkError(c, err)
		}
	} else if targetType == domain.TaskAccessTargetFolder || targetType == domain.TaskAccessTargetList {
		if _, err = s.repos.TaskWork.RequireContainerAccess(c.Context(), accountID, userID, requestedID, targetType, domain.TaskAccessView); err != nil {
			return taskWorkError(c, err)
		}
	} else if _, err = s.repos.TaskWork.RequireActiveEnvironmentAccess(c.Context(), accountID, userID, requestedID, domain.TaskAccessView); err != nil {
		return taskWorkError(c, err)
	}
	var beforeViewers []uuid.UUID
	if targetType == domain.TaskAccessTargetTask {
		beforeViewers, err = s.repos.TaskWork.TaskViewerUserIDs(c.Context(), accountID, targetID)
	} else if targetType == domain.TaskAccessTargetFolder || targetType == domain.TaskAccessTargetList {
		beforeViewers, err = s.repos.TaskWork.ContainerViewerUserIDs(c.Context(), accountID, targetID, targetType)
	} else {
		beforeViewers, err = s.repos.TaskWork.EnvironmentViewerUserIDs(c.Context(), accountID, targetID)
	}
	if err != nil {
		return taskWorkError(c, err)
	}
	_, accessMode, revision, err := s.repos.TaskWork.ReplaceAccessGrants(c.Context(), accountID, userID, targetType,
		targetID, req.AccessMode, inputs, req.ExpectedAccessRevision, operationID)
	if err != nil {
		return taskWorkError(c, err)
	}
	var afterViewers []uuid.UUID
	if targetType == domain.TaskAccessTargetTask {
		afterViewers, err = s.repos.TaskWork.TaskViewerUserIDs(c.Context(), accountID, targetID)
	} else if targetType == domain.TaskAccessTargetFolder || targetType == domain.TaskAccessTargetList {
		afterViewers, err = s.repos.TaskWork.ContainerViewerUserIDs(c.Context(), accountID, targetID, targetType)
	} else {
		afterViewers, err = s.repos.TaskWork.EnvironmentViewerUserIDs(c.Context(), accountID, targetID)
	}
	if err != nil {
		return taskWorkError(c, err)
	}
	if s.hub != nil {
		retained := afterViewers
		s.hub.BroadcastToAccountUsersWithPermission(accountID, retained, domain.PermTasks, ws.EventTaskUpdate, fiber.Map{
			"action": "access_changed", "target_type": targetType, "target_id": targetID,
			"access_revision": revision, "operation_id": operationID,
		})
		revoked := subtractTaskAccessRecipients(beforeViewers, retained)
		if len(revoked) > 0 {
			s.hub.BroadcastToAccountUsersWithPermission(accountID, revoked, domain.PermTasks, ws.EventTaskUpdate, fiber.Map{
				"action": "access_revoked", "target_type": targetType, "target_id": targetID,
				"access_revision": revision, "operation_id": operationID,
			})
		}
	}
	payload, payloadErr := s.getTaskAccessPayload(c, targetType, requestedID)
	if payloadErr != nil {
		// A caller may intentionally remove its own access. The mutation is already
		// committed, so return the canonical non-sensitive revision instead.
		return c.JSON(fiber.Map{"success": true, "target_id": targetID, "access_mode": accessMode,
			"access_revision": revision, "operation_id": operationID})
	}
	payload["operation_id"] = operationID
	return c.JSON(payload)
}

func (s *Server) handlePutTaskEnvironmentAccess(c *fiber.Ctx) error {
	environmentID, err := parseTaskEnvironmentID(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	return s.replaceTaskAccess(c, domain.TaskAccessTargetEnvironment, environmentID)
}

func (s *Server) handlePutTaskAccess(c *fiber.Ctx) error {
	taskID, err := uuid.Parse(strings.TrimSpace(c.Params("id")))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	return s.replaceTaskAccess(c, domain.TaskAccessTargetTask, taskID)
}

func (s *Server) handlePutTaskContainerAccess(c *fiber.Ctx, targetType, param string) error {
	targetID, err := uuid.Parse(strings.TrimSpace(c.Params(param)))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Recurso de Work inválido"})
	}
	return s.replaceTaskAccess(c, targetType, targetID)
}

func (s *Server) handlePutTaskFolderAccess(c *fiber.Ctx) error {
	return s.handlePutTaskContainerAccess(c, domain.TaskAccessTargetFolder, "folderId")
}

func (s *Server) handlePutTaskListAccess(c *fiber.Ctx) error {
	return s.handlePutTaskContainerAccess(c, domain.TaskAccessTargetList, "listId")
}

func (s *Server) broadcastTaskEnvironment(ctx context.Context, accountID, environmentID uuid.UUID, action string, payload fiber.Map) {
	viewers, _ := s.repos.TaskWork.EnvironmentViewerUserIDs(ctx, accountID, environmentID)
	payload["action"] = action
	if s.hub != nil {
		s.hub.BroadcastToAccountUsersWithPermission(accountID, viewers, domain.PermTasks, ws.EventTaskUpdate, payload)
	}
}
