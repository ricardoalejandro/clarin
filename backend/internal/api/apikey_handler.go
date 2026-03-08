package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// generateAPIKey creates a cryptographically random API key string.
// Format: clarin_<32 random hex chars> (e.g. clarin_a1b2c3d4...)
func generateAPIKey() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "clarin_" + hex.EncodeToString(b), nil
}

// hashAPIKey produces a SHA-256 hex digest of the raw key.
func hashAPIKey(key string) string {
	h := sha256.Sum256([]byte(key))
	return hex.EncodeToString(h[:])
}

// handleCreateAPIKey creates a new API key for the current account.
// POST /api/settings/api-keys  { "name": "ChatGPT MCP" }
// Returns the plaintext key ONCE — it is never stored or shown again.
func (s *Server) handleCreateAPIKey(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var body struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	if body.Name == "" {
		body.Name = "API Key"
	}

	rawKey, err := generateAPIKey()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to generate key"})
	}

	now := time.Now()
	apiKey := &domain.APIKey{
		ID:          uuid.New(),
		AccountID:   accountID,
		Name:        body.Name,
		KeyHash:     hashAPIKey(rawKey),
		KeyPrefix:   rawKey[:15] + "...", // "clarin_a1b2c3d..." — visible identifier
		Permissions: "read",
		IsActive:    true,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := s.repos.APIKey.Create(c.Context(), apiKey); err != nil {
		log.Printf("[API-KEY] Error creating API key: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to create API key"})
	}

	return c.JSON(fiber.Map{
		"success": true,
		"key":     rawKey, // shown ONLY once
		"api_key": apiKey,
	})
}

// handleListAPIKeys lists all API keys for the current account.
// GET /api/settings/api-keys
func (s *Server) handleListAPIKeys(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	keys, err := s.repos.APIKey.ListByAccountID(c.Context(), accountID)
	if err != nil {
		log.Printf("[API-KEY] Error listing API keys: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to list API keys"})
	}
	if keys == nil {
		keys = []*domain.APIKey{}
	}
	return c.JSON(fiber.Map{"success": true, "api_keys": keys})
}

// handleDeleteAPIKey revokes (deletes) an API key.
// DELETE /api/settings/api-keys/:id
func (s *Server) handleDeleteAPIKey(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}
	if err := s.repos.APIKey.Delete(c.Context(), id, accountID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to delete API key"})
	}
	return c.JSON(fiber.Map{"success": true})
}
