package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// Runs after authentication/permission checks. Only the authenticated actor can
// supply identity; the composer may supply an idempotency key and read boundary.
func (s *Server) messageActorMiddleware(c *fiber.Ctx) error {
	accountID, ok := c.Locals("account_id").(uuid.UUID)
	if !ok {
		return fiber.ErrUnauthorized
	}
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok {
		return fiber.ErrUnauthorized
	}
	user, err := s.repos.User.GetByID(c.Context(), userID)
	if err != nil || user == nil {
		return fiber.ErrUnauthorized
	}
	name := user.DisplayName
	if name == "" {
		name = user.Username
	}
	var req struct {
		ChatID     string `json:"chat_id"`
		To         string `json:"to"`
		Through    string `json:"attention_through_message_id"`
		Operation  string `json:"client_operation_id"`
		QuickReply bool   `json:"quick_reply"`
		Defer      bool   `json:"defer_attention"`
	}
	_ = c.BodyParser(&req)
	value := domain.MessageSendContext{AccountID: accountID, Sender: domain.MessageSender{UserID: &userID, Name: name, Origin: "manual"}, DeferAttention: req.Defer}
	if req.QuickReply {
		value.Sender.Origin = "quick_reply"
	}
	var target *domain.Chat
	if req.ChatID != "" {
		id, parseErr := uuid.Parse(req.ChatID)
		if parseErr != nil {
			return fiber.ErrBadRequest
		}
		target, err = s.repos.Chat.GetByID(c.Context(), id)
		if err != nil || target == nil || target.AccountID != accountID {
			return fiber.ErrNotFound
		}
	} else if req.To != "" {
		target, err = s.repos.Chat.FindByJID(c.Context(), accountID, req.To)
		if err != nil {
			return fiber.ErrInternalServerError
		}
	}
	if target != nil {
		value.ChatID = target.ID
		value.ThroughAt, value.ThroughID, err = s.repos.Chat.IncomingBoundary(c.Context(), accountID, target.ID, req.Through)
		if err != nil {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "El mensaje al que respondes ya no está disponible."})
		}
	}
	var operationID uuid.UUID
	if req.Operation != "" {
		operationID, err = uuid.Parse(req.Operation)
		if err != nil {
			return fiber.ErrBadRequest
		}
		value.OperationID = &operationID
		hash := sha256.Sum256(append([]byte(c.Path()+":"), c.Body()...))
		digest := hex.EncodeToString(hash[:])
		result, dbErr := s.repos.DB().Exec(c.Context(), `INSERT INTO chat_send_operations(account_id,id,user_id,request_hash) VALUES($1,$2,$3,$4)
		 ON CONFLICT(account_id,id) DO NOTHING`, accountID, operationID, userID, digest)
		if dbErr != nil {
			return fiber.ErrInternalServerError
		}
		if result.RowsAffected() == 0 {
			var savedHash, state string
			var actor uuid.UUID
			var response []byte
			err = s.repos.DB().QueryRow(c.Context(), `SELECT request_hash,state,user_id,response FROM chat_send_operations WHERE account_id=$1 AND id=$2`, accountID, operationID).Scan(&savedHash, &state, &actor, &response)
			if err != nil {
				return fiber.ErrInternalServerError
			}
			if savedHash != digest || actor != userID {
				return c.Status(409).JSON(fiber.Map{"success": false, "code": "send_operation_conflict", "error": "Este envío ya tiene otro contenido. Prepara un nuevo mensaje."})
			}
			if state == "sent" && len(response) > 0 {
				c.Type("json")
				return c.Send(response)
			}
			// Recover a lost HTTP response from the message persisted with this operation.
			var chatID uuid.UUID
			var messageID string
			if e := s.repos.DB().QueryRow(c.Context(), `SELECT chat_id,message_id FROM messages WHERE account_id=$1 AND send_operation_id=$2 LIMIT 1`, accountID, operationID).Scan(&chatID, &messageID); e == nil {
				message, e := s.repos.Message.GetByMessageID(c.Context(), chatID, messageID)
				if e == nil {
					return c.JSON(fiber.Map{"success": true, "message": message})
				}
			}
			if state != "failed" {
				return c.Status(409).JSON(fiber.Map{"success": false, "code": "send_outcome_pending", "error": "El envío aún no está confirmado. Reintenta para comprobar su estado; no se enviará otra copia."})
			}
			claim, e := s.repos.DB().Exec(c.Context(), `UPDATE chat_send_operations SET state='sending',updated_at=NOW() WHERE account_id=$1 AND id=$2 AND state='failed'`, accountID, operationID)
			if e != nil || claim.RowsAffected() == 0 {
				return fiber.ErrConflict
			}
		}
	}
	c.Context().SetUserValue(domain.MessageSendContextKey, value)
	err = c.Next()
	if value.OperationID != nil {
		state := "uncertain"
		var response struct {
			Success bool `json:"success"`
		}
		_ = json.Unmarshal(c.Response().Body(), &response)
		if err == nil && c.Response().StatusCode() < 300 && response.Success {
			state = "sent"
		} else if err == nil && c.Response().StatusCode() < 500 {
			state = "failed"
		}
		// Timeouts/server errors stay uncertain; replay checks persistence rather than sending again.
		_, _ = s.repos.DB().Exec(c.Context(), `UPDATE chat_send_operations SET state=$3,response=$4::jsonb,updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, operationID, state, json.RawMessage(validResponseJSON(c.Response().Body())))
	}
	return err
}

func validResponseJSON(body []byte) []byte {
	if json.Valid(body) {
		return body
	}
	return []byte(`{}`)
}

func (s *Server) handleAcknowledgeChat(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	chatID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.ErrBadRequest
	}
	var req struct {
		Through string `json:"through_message_id"`
	}
	if c.BodyParser(&req) != nil || strings.TrimSpace(req.Through) == "" {
		return c.Status(422).JSON(fiber.Map{"success": false, "error": "Abre la conversación antes de marcarla atendida."})
	}
	if err = s.repos.Chat.AcknowledgeAttention(c.Context(), accountID, chatID, req.Through); err != nil {
		if err == pgx.ErrNoRows {
			return fiber.ErrNotFound
		}
		return fiber.ErrInternalServerError
	}
	s.invalidateChatCaches(accountID, &chatID)
	state, err := s.repos.Chat.State(c.Context(), accountID, chatID)
	if err != nil {
		return fiber.ErrInternalServerError
	}
	return c.JSON(fiber.Map{"success": true, "chat_state": state})
}
