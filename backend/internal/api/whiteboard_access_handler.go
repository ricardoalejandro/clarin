package api

import (
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

func (s *Server) handleGetWhiteboardAccess(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	policy, err := s.repos.Whiteboard.GetBoardAccessPolicy(c.Context(), accountID, actorID, boardID)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "access": policy})
}

func (s *Server) handlePutWhiteboardAccess(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		AccessMode             string                            `json:"access_mode"`
		Grants                 []repository.WhiteboardGrantInput `json:"grants"`
		ExpectedAccessRevision int64                             `json:"expected_access_revision"`
		OperationID            *uuid.UUID                        `json:"operation_id"`
	}
	if err := c.BodyParser(&request); err != nil || request.ExpectedAccessRevision <= 0 {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	request.AccessMode = strings.ToLower(strings.TrimSpace(request.AccessMode))
	operationID := uuid.New()
	if request.OperationID != nil && *request.OperationID != uuid.Nil {
		operationID = *request.OperationID
	}
	policy, err := s.repos.Whiteboard.ReplaceBoardAccess(c.Context(), accountID, actorID, boardID,
		request.AccessMode, request.Grants, request.ExpectedAccessRevision, operationID)
	if err != nil {
		return whiteboardError(c, err)
	}
	// Re-evaluate every account member after the atomic ACL replacement. This
	// also covers access_mode account -> private, where affected viewers may not
	// have appeared in the old direct-grant list. Revocation is propagated to
	// every application instance through the whiteboard Redis channel.
	if users, listErr := s.repos.User.GetByAccountID(c.Context(), accountID); listErr == nil {
		for _, user := range users {
			if user == nil {
				continue
			}
			_, accessErr := s.repos.Whiteboard.RequireAccess(c.Context(), accountID, user.ID, boardID, "view")
			if errors.Is(accessErr, repository.ErrWhiteboardNotFound) || errors.Is(accessErr, repository.ErrWhiteboardForbidden) {
				s.revokeWhiteboardUserSockets(accountID, boardID, user.ID)
			}
		}
	}
	return c.JSON(fiber.Map{"success": true, "access": policy, "operation_id": operationID})
}
