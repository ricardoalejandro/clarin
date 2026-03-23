package api

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/kommo"
	"github.com/naperu/clarin/internal/ws"
)

// ─── Protected Dynamic Handlers ──────────────────────────────────────────────

func (s *Server) handleListDynamics(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamics, err := s.repos.Dynamic.List(c.Context(), accountID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if dynamics == nil {
		dynamics = []*domain.Dynamic{}
	}
	return c.JSON(dynamics)
}

func (s *Server) handleCreateDynamic(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		Name        string              `json:"name"`
		Type        string              `json:"type"`
		Slug        string              `json:"slug"`
		Description string              `json:"description"`
		Config      domain.DynamicConfig `json:"config"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if req.Type == "" {
		req.Type = "scratch_card"
	}

	d := &domain.Dynamic{
		AccountID:   accountID,
		Type:        req.Type,
		Name:        req.Name,
		Slug:        req.Slug,
		Description: req.Description,
		Config:      req.Config,
	}

	if err := s.repos.Dynamic.Create(c.Context(), d); err != nil {
		if strings.Contains(err.Error(), "uq_dynamics_slug") {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "El slug ya está en uso"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(fiber.StatusCreated).JSON(d)
}

func (s *Server) handleGetDynamic(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}

	d, err := s.repos.Dynamic.GetByID(c.Context(), id, accountID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}
	return c.JSON(d)
}

func (s *Server) handleUpdateDynamic(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}

	var req struct {
		Name        string              `json:"name"`
		Slug        string              `json:"slug"`
		Description string              `json:"description"`
		Config      domain.DynamicConfig `json:"config"`
		IsActive    bool                `json:"is_active"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	d := &domain.Dynamic{
		ID:          id,
		AccountID:   accountID,
		Name:        req.Name,
		Slug:        req.Slug,
		Description: req.Description,
		Config:      req.Config,
		IsActive:    req.IsActive,
	}

	if err := s.repos.Dynamic.Update(c.Context(), d); err != nil {
		if strings.Contains(err.Error(), "uq_dynamics_slug") {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "El slug ya está en uso"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(d)
}

func (s *Server) handleDeleteDynamic(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}

	if err := s.repos.Dynamic.Delete(c.Context(), id, accountID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) handleSetDynamicActive(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}

	var req struct {
		IsActive bool `json:"is_active"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if err := s.repos.Dynamic.SetActive(c.Context(), id, accountID, req.IsActive); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleCheckDynamicSlug(c *fiber.Ctx) error {
	var req struct {
		Slug      string     `json:"slug"`
		ExcludeID *uuid.UUID `json:"exclude_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	exists, err := s.repos.Dynamic.SlugExists(c.Context(), req.Slug, req.ExcludeID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"exists": exists})
}

// ─── Dynamic Items ───────────────────────────────────────────────────────────

func (s *Server) handleListDynamicItems(c *fiber.Ctx) error {
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}

	items, err := s.repos.Dynamic.ListItems(c.Context(), dynamicID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if items == nil {
		items = []*domain.DynamicItem{}
	}
	return c.JSON(items)
}

func (s *Server) handleCreateDynamicItem(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}

	// Verify ownership
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	// Handle multipart file upload
	file, err := c.FormFile("image")
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Image file is required"})
	}

	// Validate file type
	ext := strings.ToLower(filepath.Ext(file.Filename))
	allowedExts := map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true}
	if !allowedExts[ext] {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Only image files are allowed (jpg, png, gif, webp)"})
	}

	// Upload to MinIO
	f, err := file.Open()
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to open file"})
	}
	defer f.Close()

	folder := fmt.Sprintf("dynamics/%s", dynamicID.String())
	fileName := fmt.Sprintf("%s%s", uuid.New().String(), ext)
	contentType := file.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/jpeg"
	}

	_, err = s.storage.UploadReader(c.Context(), accountID, folder, fileName, f, file.Size, contentType)
	if err != nil {
		log.Printf("[DYNAMIC] Failed to upload image: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to upload image"})
	}

	// Use proxy URL so images load through the backend media proxy
	proxyURL := fmt.Sprintf("/api/media/file/%s/dynamics/%s/%s", accountID.String(), dynamicID.String(), fileName)

	thoughtText := c.FormValue("thought_text", "")
	author := c.FormValue("author", "")
	tipo := c.FormValue("tipo", "")

	item := &domain.DynamicItem{
		DynamicID:   dynamicID,
		ImageURL:    proxyURL,
		ThoughtText: thoughtText,
		Author:      author,
		Tipo:        tipo,
		FileSize:    file.Size,
		SortOrder:   0,
		IsActive:    true,
		OptionIDs:   []uuid.UUID{},
	}

	if err := s.repos.Dynamic.CreateItem(c.Context(), item); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(fiber.StatusCreated).JSON(item)
}

func (s *Server) handleUpdateDynamicItem(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	itemID, err := uuid.Parse(c.Params("itemId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid item ID"})
	}

	// Verify ownership
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	var req struct {
		ThoughtText string `json:"thought_text"`
		Author      string `json:"author"`
		Tipo        string `json:"tipo"`
		IsActive    bool   `json:"is_active"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	item := &domain.DynamicItem{
		ID:          itemID,
		DynamicID:   dynamicID,
		ThoughtText: req.ThoughtText,
		Author:      req.Author,
		Tipo:        req.Tipo,
		IsActive:    req.IsActive,
	}

	// Keep existing image_url — only update text fields and is_active
	existing, err := s.repos.Dynamic.ListItems(c.Context(), dynamicID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	for _, e := range existing {
		if e.ID == itemID {
			item.ImageURL = e.ImageURL
			item.SortOrder = e.SortOrder
			break
		}
	}

	if err := s.repos.Dynamic.UpdateItem(c.Context(), item); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(item)
}

func (s *Server) handleDeleteDynamicItem(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	itemID, err := uuid.Parse(c.Params("itemId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid item ID"})
	}

	// Verify ownership
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	if err := s.repos.Dynamic.DeleteItem(c.Context(), itemID, dynamicID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) handleBulkDeleteDynamicItems(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}

	// Verify ownership
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	var body struct {
		ItemIDs []uuid.UUID `json:"item_ids"`
	}
	if err := c.BodyParser(&body); err != nil || len(body.ItemIDs) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "item_ids is required"})
	}

	if err := s.repos.Dynamic.DeleteItems(c.Context(), dynamicID, body.ItemIDs); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) handleReorderDynamicItems(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}

	// Verify ownership
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	var req struct {
		ItemIDs []uuid.UUID `json:"item_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if err := s.repos.Dynamic.ReorderItems(c.Context(), dynamicID, req.ItemIDs); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

// ─── Item ↔ Options (many-to-many) ──────────────────────────────────────────

func (s *Server) handleSetItemOptions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	itemID, err := uuid.Parse(c.Params("itemId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid item ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	var req struct {
		OptionIDs []uuid.UUID `json:"option_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	if req.OptionIDs == nil {
		req.OptionIDs = []uuid.UUID{}
	}

	if err := s.repos.Dynamic.SetItemOptions(c.Context(), itemID, req.OptionIDs); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleBulkAssignOption(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	var req struct {
		ItemIDs  []uuid.UUID `json:"item_ids"`
		OptionID uuid.UUID   `json:"option_id"`
		Action   string      `json:"action"` // "add" or "remove"
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	if len(req.ItemIDs) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "item_ids is required"})
	}

	add := req.Action != "remove"
	if err := s.repos.Dynamic.BulkAssignOption(c.Context(), req.ItemIDs, req.OptionID, add); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

// ─── Public Dynamic Handler ──────────────────────────────────────────────────

func (s *Server) handleGetPublicDynamic(c *fiber.Ctx) error {
	slug := c.Params("slug")

	// Try resolving via dynamic_links first
	link, d, err := s.repos.Dynamic.GetLinkBySlug(c.Context(), slug)
	if err != nil {
		// Fallback: try legacy dynamics.slug
		d2, err2 := s.repos.Dynamic.GetBySlug(c.Context(), slug)
		if err2 != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
		}
		d = d2
		link = nil
	}

	items, err := s.repos.Dynamic.ListActiveItems(c.Context(), d.ID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if items == nil {
		items = []*domain.DynamicItem{}
	}

	options, err := s.repos.Dynamic.ListOptions(c.Context(), d.ID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if options == nil {
		options = []*domain.DynamicOption{}
	}

	result := fiber.Map{
		"dynamic": d,
		"items":   items,
		"options": options,
	}
	if link != nil {
		result["link"] = link
	}
	return c.JSON(result)
}

// ─── Dynamic Options Handlers ────────────────────────────────────────────────

func (s *Server) handleListDynamicOptions(c *fiber.Ctx) error {
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}

	options, err := s.repos.Dynamic.ListOptions(c.Context(), dynamicID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if options == nil {
		options = []*domain.DynamicOption{}
	}
	return c.JSON(options)
}

func (s *Server) handleCreateDynamicOption(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	var req struct {
		Name  string `json:"name"`
		Emoji string `json:"emoji"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	opt := &domain.DynamicOption{
		DynamicID: dynamicID,
		Name:      req.Name,
		Emoji:     req.Emoji,
	}
	if err := s.repos.Dynamic.CreateOption(c.Context(), opt); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(fiber.StatusCreated).JSON(opt)
}

func (s *Server) handleUpdateDynamicOption(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	optionID, err := uuid.Parse(c.Params("optionId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid option ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	var req struct {
		Name  string `json:"name"`
		Emoji string `json:"emoji"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	opt := &domain.DynamicOption{
		ID:        optionID,
		DynamicID: dynamicID,
		Name:      req.Name,
		Emoji:     req.Emoji,
	}
	if err := s.repos.Dynamic.UpdateOption(c.Context(), opt); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(opt)
}

func (s *Server) handleDeleteDynamicOption(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	optionID, err := uuid.Parse(c.Params("optionId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid option ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	if err := s.repos.Dynamic.DeleteOption(c.Context(), optionID, dynamicID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) handleReorderDynamicOptions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	var req struct {
		OptionIDs []uuid.UUID `json:"option_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	if err := s.repos.Dynamic.ReorderOptions(c.Context(), dynamicID, req.OptionIDs); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

// ─── Dynamic Links Handlers ──────────────────────────────────────────────────

func (s *Server) handleListDynamicLinks(c *fiber.Ctx) error {
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	links, err := s.repos.Dynamic.ListLinks(c.Context(), dynamicID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if links == nil {
		links = []*domain.DynamicLink{}
	}
	return c.JSON(links)
}

func (s *Server) handleCreateDynamicLink(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	var req struct {
		Slug             string  `json:"slug"`
		WhatsAppEnabled  bool    `json:"whatsapp_enabled"`
		WhatsAppMessage  string  `json:"whatsapp_message"`
		ExtraMessageText string  `json:"extra_message_text"`
		StartsAt         *string `json:"starts_at"`
		EndsAt           *string `json:"ends_at"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	link := &domain.DynamicLink{
		DynamicID:        dynamicID,
		Slug:             req.Slug,
		WhatsAppEnabled:  req.WhatsAppEnabled,
		WhatsAppMessage:  req.WhatsAppMessage,
		ExtraMessageText: req.ExtraMessageText,
		IsActive:         true,
	}
	if req.StartsAt != nil && *req.StartsAt != "" {
		if t, err := time.Parse(time.RFC3339, *req.StartsAt); err == nil {
			link.StartsAt = &t
		}
	}
	if req.EndsAt != nil && *req.EndsAt != "" {
		if t, err := time.Parse(time.RFC3339, *req.EndsAt); err == nil {
			link.EndsAt = &t
		}
	}
	if err := s.repos.Dynamic.CreateLink(c.Context(), link); err != nil {
		if strings.Contains(err.Error(), "uq_dynamic_links_slug") {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "El slug ya está en uso"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(fiber.StatusCreated).JSON(link)
}

func (s *Server) handleUpdateDynamicLink(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	linkID, err := uuid.Parse(c.Params("linkId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid link ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	var req struct {
		Slug             string  `json:"slug"`
		WhatsAppEnabled  bool    `json:"whatsapp_enabled"`
		WhatsAppMessage  string  `json:"whatsapp_message"`
		ExtraMessageText string  `json:"extra_message_text"`
		IsActive         bool    `json:"is_active"`
		StartsAt         *string `json:"starts_at"`
		EndsAt           *string `json:"ends_at"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	// Get current link to preserve media fields
	existing, _, err := s.repos.Dynamic.GetLinkByID(c.Context(), linkID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Link not found"})
	}

	link := &domain.DynamicLink{
		ID:                    linkID,
		DynamicID:             dynamicID,
		Slug:                  req.Slug,
		WhatsAppEnabled:       req.WhatsAppEnabled,
		WhatsAppMessage:       req.WhatsAppMessage,
		ExtraMessageText:      req.ExtraMessageText,
		ExtraMessageMediaURL:  existing.ExtraMessageMediaURL,
		ExtraMessageMediaType: existing.ExtraMessageMediaType,
		IsActive:              req.IsActive,
	}
	if req.StartsAt != nil && *req.StartsAt != "" {
		if t, err := time.Parse(time.RFC3339, *req.StartsAt); err == nil {
			link.StartsAt = &t
		}
	}
	if req.EndsAt != nil && *req.EndsAt != "" {
		if t, err := time.Parse(time.RFC3339, *req.EndsAt); err == nil {
			link.EndsAt = &t
		}
	}
	if err := s.repos.Dynamic.UpdateLink(c.Context(), link); err != nil {
		if strings.Contains(err.Error(), "uq_dynamic_links_slug") {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "El slug ya está en uso"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(link)
}

func (s *Server) handleDeleteDynamicLink(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	linkID, err := uuid.Parse(c.Params("linkId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid link ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	// Don't allow deleting the last link
	count, err := s.repos.Dynamic.CountLinks(c.Context(), dynamicID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if count <= 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "No se puede eliminar el último link"})
	}

	if err := s.repos.Dynamic.DeleteLink(c.Context(), linkID, dynamicID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) handleUploadLinkExtraMedia(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	linkID, err := uuid.Parse(c.Params("linkId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid link ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	file, err := c.FormFile("media")
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Media file is required"})
	}

	ext := strings.ToLower(filepath.Ext(file.Filename))
	allowedExts := map[string]string{
		".jpg": "image", ".jpeg": "image", ".png": "image", ".gif": "image", ".webp": "image",
		".mp4": "video",
	}
	mediaType, ok := allowedExts[ext]
	if !ok {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Solo se permiten imágenes (jpg, png, gif, webp) o videos (mp4)"})
	}

	// Video max 3MB
	if mediaType == "video" && file.Size > 3*1024*1024 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "El video no debe superar los 3MB"})
	}

	f, err := file.Open()
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to open file"})
	}
	defer f.Close()

	folder := fmt.Sprintf("dynamics/%s/extra", dynamicID.String())
	fileName := fmt.Sprintf("%s%s", uuid.New().String(), ext)
	contentType := file.Header.Get("Content-Type")
	if contentType == "" {
		if mediaType == "video" {
			contentType = "video/mp4"
		} else {
			contentType = "image/jpeg"
		}
	}

	_, err = s.storage.UploadReader(c.Context(), accountID, folder, fileName, f, file.Size, contentType)
	if err != nil {
		log.Printf("[DYNAMIC] Failed to upload extra media: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to upload media"})
	}

	proxyURL := fmt.Sprintf("/api/media/file/%s/dynamics/%s/extra/%s", accountID.String(), dynamicID.String(), fileName)

	// Update the link
	link, _, err := s.repos.Dynamic.GetLinkByID(c.Context(), linkID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Link not found"})
	}
	link.ExtraMessageMediaURL = proxyURL
	link.ExtraMessageMediaType = mediaType
	if err := s.repos.Dynamic.UpdateLink(c.Context(), link); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(fiber.Map{"url": proxyURL, "media_type": mediaType})
}

func (s *Server) handleDeleteLinkExtraMedia(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	linkID, err := uuid.Parse(c.Params("linkId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid link ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	link, _, err := s.repos.Dynamic.GetLinkByID(c.Context(), linkID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Link not found"})
	}
	link.ExtraMessageMediaURL = ""
	link.ExtraMessageMediaType = ""
	if err := s.repos.Dynamic.UpdateLink(c.Context(), link); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) handleCheckDynamicLinkSlug(c *fiber.Ctx) error {
	var req struct {
		Slug      string     `json:"slug"`
		ExcludeID *uuid.UUID `json:"exclude_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	exists, err := s.repos.Dynamic.LinkSlugExists(c.Context(), req.Slug, req.ExcludeID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"exists": exists})
}

// ─── Public WhatsApp Send Handler ────────────────────────────────────────────

func (s *Server) handleSendDynamicWhatsApp(c *fiber.Ctx) error {
	var req struct {
		LinkID string `json:"link_id"`
		Phone  string `json:"phone"`
		ItemID string `json:"item_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Datos inválidos"})
	}

	linkID, err := uuid.Parse(req.LinkID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Link inválido"})
	}
	itemID, err := uuid.Parse(req.ItemID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Item inválido"})
	}

	// Normalize phone
	phone := kommo.NormalizePhone(req.Phone)
	if len(phone) < 11 || !strings.HasPrefix(phone, "51") {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Número de teléfono inválido"})
	}

	// Validate link exists and has WhatsApp enabled
	link, d, err := s.repos.Dynamic.GetLinkByID(c.Context(), linkID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Link no encontrado"})
	}
	if !link.WhatsAppEnabled {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "WhatsApp no está habilitado para este link"})
	}

	// Get the item to validate it exists and get image URL
	item, err := s.repos.Dynamic.GetItemByID(c.Context(), itemID)
	if err != nil || item.DynamicID != d.ID {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Item no encontrado"})
	}

	caption := link.WhatsAppMessage
	if caption == "" {
		caption = "¡Aquí tienes tu pensamiento del día! 🌟"
	}

	q := &domain.DynamicWhatsAppQueue{
		DynamicID:      d.ID,
		AccountID:      d.AccountID,
		LinkID:         link.ID,
		Phone:          phone,
		ItemID:         item.ID,
		ImageURL:       item.ImageURL,
		Caption:        caption,
		ExtraText:      link.ExtraMessageText,
		ExtraMediaURL:  link.ExtraMessageMediaURL,
		ExtraMediaType: link.ExtraMessageMediaType,
	}
	if err := s.repos.Dynamic.EnqueueWhatsApp(c.Context(), q); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Error al encolar mensaje"})
	}

	return c.JSON(fiber.Map{"success": true, "message": "¡En breve recibirás tu imagen por WhatsApp!"})
}

// ─── Registration Handlers ───────────────────────────────────────────────────

// handleRegisterOnLink — public endpoint: register on a link + enqueue WhatsApp
func (s *Server) handleRegisterOnLink(c *fiber.Ctx) error {
	var req struct {
		LinkID   string `json:"link_id"`
		FullName string `json:"full_name"`
		Phone    string `json:"phone"`
		Age      int    `json:"age"`
		ItemID   string `json:"item_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Datos inválidos"})
	}

	linkID, err := uuid.Parse(req.LinkID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Link inválido"})
	}
	itemID, err := uuid.Parse(req.ItemID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Item inválido"})
	}

	fullName := strings.TrimSpace(req.FullName)
	if fullName == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "El nombre es obligatorio"})
	}
	if req.Age < 5 || req.Age > 120 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "La edad debe estar entre 5 y 120"})
	}

	// Normalize phone
	phone := kommo.NormalizePhone(req.Phone)
	if len(phone) < 11 || !strings.HasPrefix(phone, "51") {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Número de teléfono inválido"})
	}

	// Validate link
	link, d, err := s.repos.Dynamic.GetLinkByID(c.Context(), linkID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Link no encontrado"})
	}

	// Check schedule
	now := time.Now()
	if link.StartsAt != nil && now.Before(*link.StartsAt) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Este evento aún no ha comenzado"})
	}
	if link.EndsAt != nil && now.After(*link.EndsAt) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Este evento ya finalizó"})
	}

	// Check duplicate
	exists, err := s.repos.Dynamic.RegistrationExistsByPhone(c.Context(), linkID, phone)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Error al verificar registro"})
	}
	if exists {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "Ya registraste tus datos con este número"})
	}

	// Create registration
	reg := &domain.DynamicLinkRegistration{
		LinkID:   linkID,
		FullName: fullName,
		Phone:    phone,
		Age:      req.Age,
	}
	if err := s.repos.Dynamic.CreateRegistration(c.Context(), reg); err != nil {
		if strings.Contains(err.Error(), "uq_link_phone") {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "Ya registraste tus datos con este número"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Error al registrar"})
	}

	// Enqueue WhatsApp if enabled
	if link.WhatsAppEnabled {
		item, err := s.repos.Dynamic.GetItemByID(c.Context(), itemID)
		if err == nil && item.DynamicID == d.ID {
			caption := link.WhatsAppMessage
			if caption == "" {
				caption = "¡Aquí tienes tu pensamiento del día! 🌟"
			}
			q := &domain.DynamicWhatsAppQueue{
				DynamicID:      d.ID,
				AccountID:      d.AccountID,
				LinkID:         link.ID,
				Phone:          phone,
				ItemID:         item.ID,
				ImageURL:       item.ImageURL,
				Caption:        caption,
				ExtraText:      link.ExtraMessageText,
				ExtraMediaURL:  link.ExtraMessageMediaURL,
				ExtraMediaType: link.ExtraMessageMediaType,
			}
			if err := s.repos.Dynamic.EnqueueWhatsApp(c.Context(), q); err != nil {
				log.Printf("[DYNAMIC] Error enqueuing WhatsApp for registration %s: %v", reg.ID, err)
			}
		}
	}

	// Broadcast registration event
	if s.hub != nil {
		s.hub.BroadcastToAccount(d.AccountID, ws.EventDynamicRegistration, map[string]interface{}{
			"action":       "created",
			"link_id":      link.ID,
			"registration": reg,
		})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "registration": reg})
}

// handleCheckRegistration — public: check if phone already registered on a link
func (s *Server) handleCheckRegistration(c *fiber.Ctx) error {
	linkID, err := uuid.Parse(c.Query("link_id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Link inválido"})
	}
	phone := kommo.NormalizePhone(c.Query("phone"))
	if phone == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Teléfono requerido"})
	}
	exists, err := s.repos.Dynamic.RegistrationExistsByPhone(c.Context(), linkID, phone)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Error al verificar"})
	}
	return c.JSON(fiber.Map{"registered": exists})
}

// handleListLinkRegistrations — admin: list registrations for a link
func (s *Server) handleListLinkRegistrations(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	linkID, err := uuid.Parse(c.Params("linkId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid link ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	regs, err := s.repos.Dynamic.ListRegistrationsByLink(c.Context(), linkID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	count, _ := s.repos.Dynamic.CountRegistrationsByLink(c.Context(), linkID)
	return c.JSON(fiber.Map{"registrations": regs, "total": count})
}

// handleDeleteLinkRegistration — admin: delete a registration
func (s *Server) handleDeleteLinkRegistration(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	regID, err := uuid.Parse(c.Params("regId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid registration ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}
	if err := s.repos.Dynamic.DeleteRegistration(c.Context(), regID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	linkID, _ := uuid.Parse(c.Params("linkId"))
	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventDynamicRegistration, map[string]interface{}{
			"action":  "deleted",
			"link_id": linkID,
			"reg_id":  regID,
		})
	}

	return c.JSON(fiber.Map{"success": true})
}

// handleExportLinkRegistrations — admin: export registrations as CSV
func (s *Server) handleExportLinkRegistrations(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	dynamicID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid dynamic ID"})
	}
	linkID, err := uuid.Parse(c.Params("linkId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid link ID"})
	}
	if _, err := s.repos.Dynamic.GetByID(c.Context(), dynamicID, accountID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Dynamic not found"})
	}

	regs, err := s.repos.Dynamic.ListRegistrationsByLink(c.Context(), linkID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	loc, _ := time.LoadLocation("America/Lima")

	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	w.Write([]string{"Nombre", "Teléfono", "Edad", "Fecha de registro"})
	for _, r := range regs {
		w.Write([]string{
			r.FullName,
			r.Phone,
			fmt.Sprintf("%d", r.Age),
			r.CreatedAt.In(loc).Format("02/01/2006 15:04"),
		})
	}
	w.Flush()

	c.Set("Content-Type", "text/csv; charset=utf-8")
	c.Set("Content-Disposition", "attachment; filename=registros.csv")
	return c.Send(buf.Bytes())
}
