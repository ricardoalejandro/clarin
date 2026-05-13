package api

import (
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/database"
)

type registerRequest struct {
	AccountName string `json:"account_name"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	Password    string `json:"password"`
	PlanCode    string `json:"plan_code"`
}

func (s *Server) handleRegister(c *fiber.Ctx) error {
	var req registerRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	result, err := s.services.Auth.RegisterAccount(c.Context(), service.RegisterAccountInput{
		AccountName: req.AccountName,
		DisplayName: req.DisplayName,
		Email:       req.Email,
		Password:    req.Password,
		PlanCode:    req.PlanCode,
	})
	if err != nil {
		status := fiber.StatusBadRequest
		if strings.Contains(err.Error(), "ya existe") {
			status = fiber.StatusConflict
		}
		return c.Status(status).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	if result != nil && result.Account != nil {
		if err := database.SeedTemplateSurveysForAccount(s.repos.DB(), result.Account.ID.String()); err != nil {
			log.Printf("[API] Warning: failed to seed template surveys for signup account %s: %v", result.Account.ID, err)
		}
	}

	token, refreshToken, user, userAccounts, err := s.services.Auth.Login(c.Context(), strings.TrimSpace(req.Email), req.Password, s.cfg.JWTSecret)
	if err != nil {
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "account": result.Account, "requires_login": true})
	}
	s.setAuthCookies(c, token, refreshToken)

	accountsList := make([]fiber.Map, 0, len(userAccounts))
	for _, userAccount := range userAccounts {
		accountsList = append(accountsList, fiber.Map{
			"account_id":   userAccount.AccountID,
			"account_name": userAccount.AccountName,
			"account_slug": userAccount.AccountSlug,
			"role":         userAccount.Role,
			"is_default":   userAccount.IsDefault,
		})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"success":      true,
		"token":        token,
		"account":      result.Account,
		"subscription": result.Subscription,
		"user": fiber.Map{
			"id":                  user.ID,
			"username":            user.Username,
			"email":               user.Email,
			"display_name":        user.DisplayName,
			"is_admin":            true,
			"is_super_admin":      false,
			"role":                domain.RoleAdmin,
			"account_id":          user.AccountID,
			"account_name":        user.AccountName,
			"plan":                result.Subscription.PlanCode,
			"subscription_status": result.Subscription.Status,
			"permissions":         []string{domain.PermAll},
		},
		"accounts": accountsList,
	})
}

func (s *Server) setAuthCookies(c *fiber.Ctx, token string, refreshToken string) {
	c.Cookie(&fiber.Cookie{
		Name:     "auth-token",
		Value:    token,
		Expires:  time.Now().Add(1 * time.Hour),
		HTTPOnly: true,
		Secure:   s.cfg.IsProduction(),
		SameSite: "Lax",
		Path:     "/",
	})
	c.Cookie(&fiber.Cookie{
		Name:     "refresh-token",
		Value:    refreshToken,
		Expires:  time.Now().Add(7 * 24 * time.Hour),
		HTTPOnly: true,
		Secure:   s.cfg.IsProduction(),
		SameSite: "Strict",
		Path:     "/api/auth",
	})
}
