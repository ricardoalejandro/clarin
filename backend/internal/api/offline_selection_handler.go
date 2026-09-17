package api

import (
	"errors"
	"sort"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type replaceOfflineSelectionsRequest struct {
	Selections []domain.OfflineResourceSelection `json:"selections"`
}

func (s *Server) requireOfflineControl(c *fiber.Ctx) error {
	if s.cfg == nil || !s.cfg.OfflineEnabled || !s.cfg.OfflineControlEnabled {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "offline control plane is disabled"})
	}
	return c.Next()
}

func (s *Server) handleUserOfflineGrants(c *fiber.Ctx) error {
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok {
		return c.SendStatus(fiber.StatusUnauthorized)
	}
	grants, err := s.repos.Offline.ListUserOfflineGrants(c.Context(), userID)
	if err != nil {
		return err
	}
	available, filename, checksum := s.offlineInstallerMetadata()
	return c.JSON(fiber.Map{"success": true, "grants": grants, "installer_available": available, "installer_filename": filename, "installer_sha256": checksum})
}

func (s *Server) userOfflineGrant(c *fiber.Ctx) (*domain.OfflineGrant, error) {
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok {
		return nil, fiber.ErrUnauthorized
	}
	grantID, err := uuid.Parse(c.Params("grantId"))
	if err != nil {
		return nil, fiber.ErrBadRequest
	}
	grants, err := s.repos.Offline.ListUserOfflineGrants(c.Context(), userID)
	if err != nil {
		return nil, err
	}
	for i := range grants {
		if grants[i].ID == grantID {
			return &grants[i], nil
		}
	}
	return nil, fiber.ErrNotFound
}

func (s *Server) handleUserOfflineSelections(c *fiber.Ctx) error {
	grant, err := s.userOfflineGrant(c)
	if err != nil {
		return err
	}
	items, err := s.repos.Offline.ListSelections(c.Context(), grant.ID, grant.UserID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "selection_revision": grant.SelectionRevision, "selections": items})
}

func (s *Server) handleReplaceUserOfflineSelections(c *fiber.Ctx) error {
	grant, err := s.userOfflineGrant(c)
	if err != nil {
		return err
	}
	var req replaceOfflineSelectionsRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid selection request"})
	}
	if len(req.Selections) > 20 {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{"success": false, "error": "at most 20 resources may be selected per account grant"})
	}
	for _, selection := range req.Selections {
		if err := s.requireOfflineSelectionAccess(c, grant, selection); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
	}
	revision, err := s.repos.Offline.ReplaceSelections(c.Context(), grant.ID, grant.UserID, req.Selections)
	if errors.Is(err, repository.ErrOfflineResourceInvalid) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "one or more resources are invalid or no longer available"})
	}
	if err != nil {
		return err
	}
	items, err := s.repos.Offline.ListSelections(c.Context(), grant.ID, grant.UserID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "selection_revision": revision, "selections": items})
}

func (s *Server) requireOfflineSelectionAccess(c *fiber.Ctx, grant *domain.OfflineGrant, selection domain.OfflineResourceSelection) error {
	expectedModule, valid := domain.OfflineModuleForResourceType(selection.ResourceType)
	if !valid || expectedModule != selection.Module || selection.ResourceID == uuid.Nil || !stringSliceContains(grant.Modules, selection.Module) {
		return errors.New("resource type does not match an approved module")
	}
	allowed, err := s.repos.Offline.UserHasAccountModule(c.Context(), grant.UserID, grant.AccountID, selection.Module)
	if err != nil {
		return err
	}
	if !allowed {
		return errors.New("module access has been revoked")
	}
	switch selection.ResourceType {
	case domain.OfflineResourceWhiteboard:
		if _, err := s.repos.Whiteboard.RequireAccess(c.Context(), grant.AccountID, grant.UserID, selection.ResourceID, domain.WhiteboardAccessView); err != nil {
			return errors.New("whiteboard is not accessible")
		}
	case domain.OfflineResourceTaskList:
		if _, err := s.repos.TaskWork.RequireContainerAccess(c.Context(), grant.AccountID, grant.UserID, selection.ResourceID, domain.TaskAccessTargetList, domain.TaskAccessView); err != nil {
			return errors.New("task list is not accessible")
		}
	case domain.OfflineResourceContact:
		var exists bool
		if err := s.repos.DB().QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM contacts WHERE account_id=$1 AND id=$2 AND is_group=FALSE)`, grant.AccountID, selection.ResourceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errors.New("contact is not accessible")
		}
	case domain.OfflineResourceProgram:
		var exists bool
		if err := s.repos.DB().QueryRow(c.Context(), `SELECT EXISTS(SELECT 1 FROM programs WHERE account_id=$1 AND id=$2)`, grant.AccountID, selection.ResourceID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errors.New("program is not accessible")
		}
	}
	return nil
}

func (s *Server) handleUserOfflineResourceCandidates(c *fiber.Ctx) error {
	grant, err := s.userOfflineGrant(c)
	if err != nil {
		return err
	}
	module := strings.TrimSpace(c.Query("module"))
	query := strings.TrimSpace(c.Query("q"))
	if len(query) > 160 || !stringSliceContains(grant.Modules, module) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid module or search"})
	}
	allowed, err := s.repos.Offline.UserHasAccountModule(c.Context(), grant.UserID, grant.AccountID, module)
	if err != nil {
		return err
	}
	if !allowed {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "module not available"})
	}
	items, err := s.offlineResourceCandidates(c, grant, module, query)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "items": items})
}

func (s *Server) offlineResourceCandidates(c *fiber.Ctx, grant *domain.OfflineGrant, module, query string) ([]offlineResourceCandidate, error) {
	items := make([]offlineResourceCandidate, 0, 50)
	switch module {
	case domain.OfflineModuleWhiteboards:
		boards, _, err := s.repos.Whiteboard.ListBoards(c.Context(), grant.AccountID, grant.UserID, repository.WhiteboardListOptions{Query: query, Scope: repository.WhiteboardScopeAll, IncludeWork: true, Limit: 50})
		if err != nil {
			return nil, err
		}
		for _, board := range boards {
			items = append(items, offlineResourceCandidate{ID: board.ID, Type: domain.OfflineResourceWhiteboard, Label: board.Name, Subtitle: board.Description})
		}
	case domain.OfflineModuleTasks:
		lists, err := s.repos.TaskWork.ListsForActor(c.Context(), grant.AccountID, grant.UserID, nil)
		if err != nil {
			return nil, err
		}
		needle := strings.ToLower(query)
		for _, list := range lists {
			if needle != "" && !strings.Contains(strings.ToLower(list.Name+" "+list.Description), needle) {
				continue
			}
			items = append(items, offlineResourceCandidate{ID: list.ID, Type: domain.OfflineResourceTaskList, Label: list.Name, Subtitle: list.Description})
		}
		sort.SliceStable(items, func(i, j int) bool { return strings.ToLower(items[i].Label) < strings.ToLower(items[j].Label) })
		if len(items) > 50 {
			items = items[:50]
		}
	case domain.OfflineModuleContacts:
		rows, err := s.repos.DB().Query(c.Context(), `SELECT id,COALESCE(NULLIF(BTRIM(custom_name),''),NULLIF(BTRIM(name),''),NULLIF(BTRIM(push_name),''),phone,'Sin nombre'),COALESCE(phone,email,'') FROM contacts WHERE account_id=$1 AND is_group=FALSE AND ($2='' OR CONCAT_WS(' ',custom_name,name,last_name,push_name,phone,email) ILIKE '%'||$2||'%') ORDER BY updated_at DESC,id LIMIT 50`, grant.AccountID, query)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var item offlineResourceCandidate
			item.Type = domain.OfflineResourceContact
			if err := rows.Scan(&item.ID, &item.Label, &item.Subtitle); err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		return items, rows.Err()
	case domain.OfflineModulePrograms:
		rows, err := s.repos.DB().Query(c.Context(), `SELECT id,name,COALESCE(status,'') FROM programs WHERE account_id=$1 AND ($2='' OR name ILIKE '%'||$2||'%' OR description ILIKE '%'||$2||'%') ORDER BY updated_at DESC,id LIMIT 50`, grant.AccountID, query)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var item offlineResourceCandidate
			item.Type = domain.OfflineResourceProgram
			if err := rows.Scan(&item.ID, &item.Label, &item.Subtitle); err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		return items, rows.Err()
	default:
		return nil, errors.New("unsupported module")
	}
	return items, nil
}

func stringSliceContains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
