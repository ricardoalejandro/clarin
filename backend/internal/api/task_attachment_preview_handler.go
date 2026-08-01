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
	s.setTaskAttachmentCommentPermissions(c, accountID, userID, items)
	return c.JSON(fiber.Map{"success": true, "comments": items})
}

func (s *Server) setTaskAttachmentCommentPermissions(c *fiber.Ctx, accountID, userID uuid.UUID, items []*domain.TaskAttachmentComment) {
	setTaskAttachmentCommentPermissions(items, userID, s.isAccountAdmin(c, accountID, userID))
}

func setTaskAttachmentCommentPermissions(items []*domain.TaskAttachmentComment, userID uuid.UUID, admin bool) {
	resolvedRoots := make(map[uuid.UUID]bool, len(items))
	for _, item := range items {
		if item.ParentID == nil {
			resolvedRoots[item.ID] = item.ResolvedAt != nil
		}
	}
	for _, item := range items {
		threadResolved := item.ResolvedAt != nil
		if item.ParentID != nil {
			threadResolved = resolvedRoots[*item.ParentID]
		}
		item.CanEdit = !item.Deleted && !threadResolved && (admin || item.AuthorID == userID)
		item.CanDelete = item.CanEdit
		item.CanResolve = !item.Deleted && item.ParentID == nil
	}
}

func attachmentCommentForRealtime(item *domain.TaskAttachmentComment) *domain.TaskAttachmentComment {
	if item == nil {
		return nil
	}
	copy := *item
	copy.CanEdit = false
	copy.CanDelete = false
	copy.CanResolve = !copy.Deleted && copy.ParentID == nil
	return &copy
}

func findTaskAttachmentComment(items []*domain.TaskAttachmentComment, commentID uuid.UUID) *domain.TaskAttachmentComment {
	for _, item := range items {
		if item.ID == commentID {
			return item
		}
	}
	return nil
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
	s.setTaskAttachmentCommentPermissions(c, accountID, userID, items)
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "attachment_comment_added", fiber.Map{"attachment_id": attachmentID, "comment_id": item.ID})
	s.broadcastTaskWork(accountID, "attachment_comment_added", fiber.Map{"task_id": taskID, "attachment_id": attachmentID, "comment": attachmentCommentForRealtime(item)})
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
		Resolved    bool   `json:"resolved"`
		Version     int64  `json:"version"`
		OperationID string `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil || req.Version < 1 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Versión inválida"})
	}
	operationID, err := taskStructureOperationID(req.OperationID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Identificador de operación inválido"})
	}
	if err := s.repos.TaskWork.SetAttachmentCommentResolved(c.Context(), accountID, taskID, attachmentID, commentID, userID, req.Resolved, req.Version, operationID); err != nil {
		return taskWorkError(c, err)
	}
	items, err := s.repos.TaskWork.ListAttachmentComments(c.Context(), accountID, taskID, attachmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.setTaskAttachmentCommentPermissions(c, accountID, userID, items)
	item := findTaskAttachmentComment(items, commentID)
	if item != nil {
		action := "attachment_comment_reopened"
		if req.Resolved {
			action = "attachment_comment_resolved"
		}
		s.broadcastTaskWork(accountID, action, fiber.Map{"task_id": taskID, "attachment_id": attachmentID, "comment_id": commentID, "comment": attachmentCommentForRealtime(item), "operation_id": operationID})
		return c.JSON(fiber.Map{"success": true, "comment": item, "operation_id": operationID})
	}
	return c.SendStatus(404)
}

func (s *Server) handleUpdateTaskAttachmentComment(c *fiber.Ctx) error {
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
		Body             string   `json:"body"`
		MentionedUserIDs []string `json:"mentioned_user_ids"`
		Version          int64    `json:"version"`
		OperationID      string   `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Body) == "" || req.Version < 1 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Comentario o versión inválidos"})
	}
	mentionIDs, err := parseTaskUUIDList(req.MentionedUserIDs)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Mención inválida"})
	}
	operationID, err := taskStructureOperationID(req.OperationID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Identificador de operación inválido"})
	}
	if err := s.repos.TaskWork.UpdateAttachmentComment(c.Context(), accountID, taskID, attachmentID, commentID, userID, s.isAccountAdmin(c, accountID, userID), req.Body, mentionIDs, req.Version, operationID); err != nil {
		return taskWorkError(c, err)
	}
	items, err := s.repos.TaskWork.ListAttachmentComments(c.Context(), accountID, taskID, attachmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.setTaskAttachmentCommentPermissions(c, accountID, userID, items)
	item := findTaskAttachmentComment(items, commentID)
	if item == nil {
		return c.SendStatus(404)
	}
	s.broadcastTaskWork(accountID, "attachment_comment_updated", fiber.Map{"task_id": taskID, "attachment_id": attachmentID, "comment_id": commentID, "comment": attachmentCommentForRealtime(item), "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "comment": item, "operation_id": operationID})
}

func (s *Server) handleDeleteTaskAttachmentComment(c *fiber.Ctx) error {
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
		Version     int64  `json:"version"`
		OperationID string `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil || req.Version < 1 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Versión inválida"})
	}
	operationID, err := taskStructureOperationID(req.OperationID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Identificador de operación inválido"})
	}
	if err := s.repos.TaskWork.DeleteAttachmentComment(c.Context(), accountID, taskID, attachmentID, commentID, userID, s.isAccountAdmin(c, accountID, userID), req.Version, operationID); err != nil {
		return taskWorkError(c, err)
	}
	items, err := s.repos.TaskWork.ListAttachmentComments(c.Context(), accountID, taskID, attachmentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.setTaskAttachmentCommentPermissions(c, accountID, userID, items)
	item := findTaskAttachmentComment(items, commentID)
	s.broadcastTaskWork(accountID, "attachment_comment_deleted", fiber.Map{"task_id": taskID, "attachment_id": attachmentID, "comment_id": commentID, "comment": attachmentCommentForRealtime(item), "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "comment": item, "deleted_comment_id": commentID, "operation_id": operationID})
}
