package api

import (
	"context"
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

const whiteboardSessionCookieName = "whiteboard-session-token"

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

	token, refreshToken, user, accountCount, authorityEffect, err := s.services.Auth.Login(c.Context(), strings.TrimSpace(req.Email), req.Password, s.cfg.JWTSecret)
	s.notifyWhiteboardAuthorityEffect(authorityEffect)
	if err != nil {
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "account": result.Account, "requires_login": true})
	}
	s.setAuthCookies(c, token, refreshToken)

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
		"account_count": accountCount,
	})
}

func authTokenCookie(token string, now time.Time, secure bool) *fiber.Cookie {
	return &fiber.Cookie{
		Name:     "auth-token",
		Value:    token,
		Expires:  now.Add(time.Hour),
		HTTPOnly: true,
		Secure:   secure,
		SameSite: "Lax",
		Path:     "/",
	}
}

func refreshTokenCookie(refreshToken string, now time.Time, secure bool) *fiber.Cookie {
	return &fiber.Cookie{
		Name:     "refresh-token",
		Value:    refreshToken,
		Expires:  now.Add(service.AuthSessionAbsoluteLifetime),
		HTTPOnly: true,
		Secure:   secure,
		SameSite: "Strict",
		Path:     "/api/auth",
	}
}

func whiteboardSessionCookie(refreshToken string, now time.Time, secure bool) *fiber.Cookie {
	return &fiber.Cookie{
		Name:     whiteboardSessionCookieName,
		Value:    refreshToken,
		Expires:  now.Add(service.AuthSessionAbsoluteLifetime),
		HTTPOnly: true,
		Secure:   secure,
		SameSite: fiber.CookieSameSiteStrictMode,
		Path:     "/api/whiteboards",
	}
}

func clearWhiteboardSessionCookie(now time.Time, secure bool) *fiber.Cookie {
	return &fiber.Cookie{
		Name:     whiteboardSessionCookieName,
		Value:    "",
		Expires:  now.Add(-time.Hour),
		MaxAge:   -1,
		HTTPOnly: true,
		Secure:   secure,
		SameSite: fiber.CookieSameSiteStrictMode,
		Path:     "/api/whiteboards",
	}
}

func (s *Server) setAuthCookies(c *fiber.Ctx, token string, refreshToken string) {
	now := time.Now()
	secure := s.cfg.IsProduction()
	c.Cookie(authTokenCookie(token, now, secure))
	c.Cookie(refreshTokenCookie(refreshToken, now, secure))
	c.Cookie(whiteboardSessionCookie(refreshToken, now, secure))
}

type whiteboardSessionBootstrapValidator func(context.Context, string) (*service.AuthSessionIdentity, error)

func bootstrapWhiteboardSessionCookie(c *fiber.Ctx, secure bool, validate whiteboardSessionBootstrapValidator) error {
	refreshToken := strings.TrimSpace(c.Cookies("refresh-token"))
	if refreshToken == "" || validate == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success": false, "error": "Session expired", "code": "session_expired",
		})
	}
	identity, err := validate(c.Context(), refreshToken)
	if err != nil {
		disposition := classifyAuthFailure(err)
		if disposition.Status == fiber.StatusServiceUnavailable {
			return c.Status(disposition.Status).JSON(fiber.Map{
				"success": false, "error": "Authentication is temporarily unavailable", "code": disposition.Code,
			})
		}
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success": false, "error": "Session expired", "code": "session_expired",
		})
	}
	if identity == nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success": false, "error": "Session expired", "code": "session_expired",
		})
	}
	c.Cookie(whiteboardSessionCookie(refreshToken, time.Now(), secure))
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) handleBootstrapWhiteboardSession(c *fiber.Ctx) error {
	return bootstrapWhiteboardSessionCookie(c, s.cfg.IsProduction(), s.services.Auth.ValidateRefreshTokenReadOnly)
}
