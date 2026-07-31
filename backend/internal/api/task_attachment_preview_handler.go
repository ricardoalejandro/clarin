package api

import (
	"encoding/json"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func taskAttachmentPathIDs(c *fiber.Ctx) (uuid.UUID, uuid.UUID, error) {
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	attachmentID, err := uuid.Parse(c.Params("attachmentId"))
	return taskID, attachmentID, err
}

func (s *Server) handleGetTaskAttachmentPreview(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, attachmentID, err := taskAttachmentPathIDs(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Adjunto inválido"})
	}
	preview, err := s.repos.TaskWork.EnsureAttachmentPreview(c.Context(), accountID, taskID, attachmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	if (preview.Kind == "image" || preview.Kind == "pdf" || preview.Kind == "text") && preview.URL == "" {
		attachments, listErr := s.repos.TaskWork.ListAttachments(c.Context(), accountID, taskID)
		if listErr == nil {
			for _, item := range attachments {
				if item.ID == attachmentID {
					preview.URL = item.URL
					break
				}
			}
		}
	}
	return c.JSON(fiber.Map{"success": true, "preview": preview})
}

func (s *Server) handleRetryTaskAttachmentPreview(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, attachmentID, err := taskAttachmentPathIDs(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Adjunto inválido"})
	}
	var req struct {
		OperationID string `json:"operation_id"`
	}
	if len(c.Body()) > 0 {
		if err := c.BodyParser(&req); err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
		}
	}
	operationID, err := taskStructureOperationID(req.OperationID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Identificador de operación inválido"})
	}
	preview, requeued, err := s.repos.TaskWork.RetryAttachmentPreview(c.Context(), accountID, taskID, attachmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	if requeued {
		s.broadcastTaskWork(accountID, "attachment_preview_retried", fiber.Map{"task_id": taskID, "attachment_id": attachmentID, "preview": preview, "operation_id": operationID})
	}
	return c.JSON(fiber.Map{"success": true, "preview": preview, "requeued": requeued, "operation_id": operationID})
}

func (s *Server) handleGetTaskAttachmentComments(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, attachmentID, err := taskAttachmentPathIDs(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Adjunto inválido"})
	}
	items, err := s.repos.TaskWork.ListAttachmentComments(c.Context(), accountID, taskID, attachmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	admin := s.isAccountAdmin(c, accountID, userID)
	for _, item := range items {
		item.CanEdit = admin || item.AuthorID == userID
		item.CanResolve = true
	}
	return c.JSON(fiber.Map{"success": true, "comments": items})
}

func (s *Server) handleCreateTaskAttachmentComment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, attachmentID, err := taskAttachmentPathIDs(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Adjunto inválido"})
	}
	var req struct {
		Body             string          `json:"body"`
		ParentID         *string         `json:"parent_id"`
		Anchor           json.RawMessage `json:"anchor"`
		MentionedUserIDs []string        `json:"mentioned_user_ids"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Body) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El comentario es obligatorio"})
	}
	if len(req.Anchor) == 0 {
		req.Anchor = json.RawMessage(`{}`)
	}
	item := &domain.TaskAttachmentComment{AccountID: accountID, TaskID: taskID, AttachmentID: attachmentID, AuthorID: userID, Body: req.Body, Anchor: req.Anchor}
	if req.ParentID != nil && strings.TrimSpace(*req.ParentID) != "" {
		id, parseErr := uuid.Parse(*req.ParentID)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Respuesta inválida"})
		}
		item.ParentID = &id
	}
	mentions, parseErr := parseTaskUUIDList(req.MentionedUserIDs)
	if parseErr != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Mención inválida"})
	}
	if err := s.repos.TaskWork.CreateAttachmentComment(c.Context(), item, mentions); err != nil {
		return taskWorkError(c, err)
	}
	items, err := s.repos.TaskWork.ListAttachmentComments(c.Context(), accountID, taskID, attachmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	for _, candidate := range items {
		if candidate.ID == item.ID {
			item = candidate
			break
		}
	}
	item.CanEdit = true
	item.CanResolve = true
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "attachment_comment_added", fiber.Map{"attachment_id": attachmentID, "comment_id": item.ID})
	s.broadcastTaskWork(accountID, "attachment_comment_added", fiber.Map{"task_id": taskID, "attachment_id": attachmentID, "comment": item})
	return c.JSON(fiber.Map{"success": true, "comment": item})
}

func (s *Server) handleResolveTaskAttachmentComment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, attachmentID, err := taskAttachmentPathIDs(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Adjunto inválido"})
	}
	commentID, err := uuid.Parse(c.Params("commentId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Comentario inválido"})
	}
	var req struct {
		Resolved bool  `json:"resolved"`
		Version  int64 `json:"version"`
	}
	if err := c.BodyParser(&req); err != nil || req.Version < 1 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Versión inválida"})
	}
	if err := s.repos.TaskWork.SetAttachmentCommentResolved(c.Context(), accountID, taskID, attachmentID, commentID, userID, req.Resolved, req.Version); err != nil {
		return taskWorkError(c, err)
	}
	items, err := s.repos.TaskWork.ListAttachmentComments(c.Context(), accountID, taskID, attachmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	for _, item := range items {
		if item.ID == commentID {
			item.CanEdit = item.AuthorID == userID || s.isAccountAdmin(c, accountID, userID)
			item.CanResolve = true
			return c.JSON(fiber.Map{"success": true, "comment": item})
		}
	}
	return c.SendStatus(404)
}
