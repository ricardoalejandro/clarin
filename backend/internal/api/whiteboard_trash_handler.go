package api

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

func (s *Server) handleGetWhiteboardTrashPolicy(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	days, err := s.repos.Whiteboard.GetTrashRetentionDays(c.Context(), accountID)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{
		"success": true, "retention_days": days,
		"can_manage": s.isAccountAdmin(c, accountID, actorID),
	})
}

func (s *Server) handlePutWhiteboardTrashPolicy(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	if !s.isAccountAdmin(c, accountID, actorID) {
		return whiteboardError(c, repository.ErrWhiteboardForbidden)
	}
	var request struct {
		RetentionDays int `json:"retention_days"`
	}
	if err := c.BodyParser(&request); err != nil || request.RetentionDays < 7 || request.RetentionDays > 365 {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	if err := s.repos.Whiteboard.UpdateTrashRetentionDays(c.Context(), accountID, actorID, request.RetentionDays); err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "retention_days": request.RetentionDays, "can_manage": true})
}

func (s *Server) handlePurgeWhiteboard(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	if !s.isAccountAdmin(c, accountID, actorID) {
		return whiteboardError(c, repository.ErrWhiteboardForbidden)
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		ConfirmationName string    `json:"confirmation_name"`
		OperationID      uuid.UUID `json:"operation_id"`
	}
	if err := c.BodyParser(&request); err != nil || request.ConfirmationName == "" || request.OperationID == uuid.Nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	workOrigin, err := s.repos.Whiteboard.IsWorkOrigin(c.Context(), accountID, boardID)
	if err != nil {
		return whiteboardError(c, err)
	}
	result, err := s.repos.Whiteboard.PurgeBoard(c.Context(), accountID, actorID, boardID, request.ConfirmationName, time.Now().UTC())
	if err != nil {
		return whiteboardError(c, err)
	}
	s.revokeWhiteboardBoardSockets(accountID, boardID)
	if workOrigin {
		s.notifyWhiteboardWorkHubRevoked(accountID)
	} else {
		s.notifyWhiteboardHubChanged(accountID)
	}
	return c.JSON(fiber.Map{"success": true, "operation_id": request.OperationID, "purged": result})
}
