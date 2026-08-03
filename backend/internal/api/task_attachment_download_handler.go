package api

import (
	"mime"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func (s *Server) handleDownloadTaskAttachment(c *fiber.Ctx) error {
	return s.serveTaskAttachmentDownload(c, false)
}

func (s *Server) handleDownloadTaskAttachmentPreview(c *fiber.Ctx) error {
	return s.serveTaskAttachmentDownload(c, true)
}

func (s *Server) serveTaskAttachmentDownload(c *fiber.Ctx, preview bool) error {
	accountID, ok := c.Locals("account_id").(uuid.UUID)
	if !ok || accountID == uuid.Nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "Unauthorized"})
	}
	taskID, attachmentID, err := taskAttachmentPathIDs(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Adjunto inválido"})
	}
	item, err := s.repos.TaskWork.ResolveAttachmentDownload(c.Context(), accountID, taskID, attachmentID, preview)
	if err != nil {
		return taskWorkError(c, err)
	}
	if contentType := strings.TrimSpace(item.ContentType); contentType != "" {
		c.Set(fiber.HeaderContentType, contentType)
	}
	dispositionType := "attachment"
	if preview {
		dispositionType = "inline"
	}
	if disposition := mime.FormatMediaType(dispositionType, map[string]string{"filename": item.Filename}); disposition != "" {
		c.Set(fiber.HeaderContentDisposition, disposition)
	}
	c.Set(fiber.HeaderXContentTypeOptions, "nosniff")
	return s.serveStorageObject(c, item.ObjectKey, "private, no-store, max-age=0")
}
