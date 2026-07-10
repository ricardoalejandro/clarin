package api

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

const sharedBrowserControlTTL = 30 * time.Minute

type sharedBrowserDomain struct {
	ID        string    `json:"id"`
	Domain    string    `json:"domain"`
	IsActive  bool      `json:"is_active"`
	CreatedAt time.Time `json:"created_at"`
}

type sharedBrowserSession struct {
	ID                    string     `json:"id"`
	Status                string     `json:"status"`
	CurrentURL            string     `json:"current_url"`
	CurrentDomain         string     `json:"current_domain"`
	ControllerUserID      string     `json:"controller_user_id,omitempty"`
	ControllerDisplayName string     `json:"controller_display_name,omitempty"`
	ControlExpiresAt      *time.Time `json:"control_expires_at,omitempty"`
	GatewaySessionID      string     `json:"gateway_session_id"`
	LastError             string     `json:"last_error,omitempty"`
	LastActivityAt        *time.Time `json:"last_activity_at,omitempty"`
	CreatedAt             time.Time  `json:"created_at"`
	UpdatedAt             time.Time  `json:"updated_at"`
}

func (s *Server) handleSharedBrowserStatus(c *fiber.Ctx) error {
	accountID, userID, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	session, err := s.ensureSharedBrowserSession(c.Context(), accountID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar la sesión"})
	}
	domains, err := s.listSharedBrowserDomains(c.Context(), accountID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar dominios"})
	}
	isAdmin := s.isAccountAdmin(c, accountID, userID)
	return c.JSON(fiber.Map{
		"success":           true,
		"session":           s.decorateSharedBrowserSession(session, userID, isAdmin),
		"allowed_domains":   domains,
		"is_admin":          isAdmin,
		"gateway_available": s.sharedBrowserGatewayAvailable(c.Context()),
	})
}

func (s *Server) handleSharedBrowserAllowedDomains(c *fiber.Ctx) error {
	accountID, _, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	domains, err := s.listSharedBrowserDomains(c.Context(), accountID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar dominios"})
	}
	return c.JSON(fiber.Map{"success": true, "allowed_domains": domains})
}

func (s *Server) handleSharedBrowserAddAllowedDomain(c *fiber.Ctx) error {
	accountID, userID, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	if !s.isAccountAdmin(c, accountID, userID) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "Solo administradores pueden aprobar dominios"})
	}
	var req struct {
		Domain string `json:"domain"`
		URL    string `json:"url"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	domainValue := strings.TrimSpace(req.Domain)
	if domainValue == "" {
		_, domainFromURL, err := normalizeSharedBrowserURL(req.URL)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		domainValue = domainFromURL
	}
	domainValue, err := normalizeSharedBrowserDomain(domainValue)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if err := s.upsertSharedBrowserDomain(c.Context(), accountID, userID, domainValue); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo aprobar el dominio"})
	}
	s.recordSharedBrowserAudit(c.Context(), accountID, userID, "domain_approved", "", domainValue, nil)
	domains, _ := s.listSharedBrowserDomains(c.Context(), accountID)
	return c.JSON(fiber.Map{"success": true, "domain": domainValue, "allowed_domains": domains})
}

func (s *Server) handleSharedBrowserOpen(c *fiber.Ctx) error {
	accountID, userID, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	var req struct {
		URL           string `json:"url"`
		ApproveDomain bool   `json:"approve_domain"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	targetURL, domainName, err := normalizeSharedBrowserURL(req.URL)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	isAdmin := s.isAccountAdmin(c, accountID, userID)
	if req.ApproveDomain {
		if !isAdmin {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "Solo administradores pueden aprobar dominios"})
		}
		if err := s.upsertSharedBrowserDomain(c.Context(), accountID, userID, domainName); err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo aprobar el dominio"})
		}
		s.recordSharedBrowserAudit(c.Context(), accountID, userID, "domain_approved", targetURL, domainName, nil)
	}
	allowed, domains, err := s.sharedBrowserDomainAllowed(c.Context(), accountID, domainName)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo validar el dominio"})
	}
	if !allowed {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"success": false,
			"error":   "Este dominio no está habilitado para esta cuenta.",
			"code":    "domain_not_allowed",
			"domain":  domainName,
		})
	}
	session, err := s.ensureSharedBrowserController(c.Context(), accountID, userID, isAdmin, false)
	if err != nil {
		if err == errSharedBrowserControlled {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "Otro usuario tiene el control del navegador"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo tomar control"})
	}
	body := fiber.Map{
		"account_id":        accountID.String(),
		"url":               targetURL,
		"allowed_domains":   domains,
		"block_private_net": true,
	}
	if _, _, status, err := s.callSharedBrowserGateway(c.Context(), http.MethodPost, fmt.Sprintf("/sessions/%s/open", accountID), body); err != nil || status >= 400 {
		msg := "El servicio interno del navegador no está disponible"
		if err == nil {
			msg = fmt.Sprintf("El navegador respondió con error %d", status)
		}
		_ = s.updateSharedBrowserError(c.Context(), accountID, msg)
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": msg})
	}
	if err := s.updateSharedBrowserOpened(c.Context(), accountID, userID, targetURL, domainName); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo guardar la sesión"})
	}
	s.recordSharedBrowserAudit(c.Context(), accountID, userID, "open_url", targetURL, domainName, nil)
	session, _ = s.ensureSharedBrowserSession(c.Context(), accountID)
	return c.JSON(fiber.Map{"success": true, "session": s.decorateSharedBrowserSession(session, userID, isAdmin)})
}

func (s *Server) handleSharedBrowserRequestControl(c *fiber.Ctx) error {
	accountID, userID, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	var req struct {
		Force bool `json:"force"`
	}
	_ = c.BodyParser(&req)
	isAdmin := s.isAccountAdmin(c, accountID, userID)
	session, err := s.ensureSharedBrowserController(c.Context(), accountID, userID, isAdmin, req.Force)
	if err != nil {
		if err == errSharedBrowserControlled {
			current, _ := s.ensureSharedBrowserSession(c.Context(), accountID)
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"success": false,
				"error":   "Otro usuario tiene el control del navegador",
				"session": s.decorateSharedBrowserSession(current, userID, isAdmin),
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo tomar control"})
	}
	s.recordSharedBrowserAudit(c.Context(), accountID, userID, "control_acquired", session.CurrentURL, session.CurrentDomain, fiber.Map{"forced": req.Force && isAdmin})
	return c.JSON(fiber.Map{"success": true, "session": s.decorateSharedBrowserSession(session, userID, isAdmin)})
}

func (s *Server) handleSharedBrowserReleaseControl(c *fiber.Ctx) error {
	accountID, userID, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	isAdmin := s.isAccountAdmin(c, accountID, userID)
	session, err := s.ensureSharedBrowserSession(c.Context(), accountID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar la sesión"})
	}
	if session.ControllerUserID != "" && session.ControllerUserID != userID.String() && !isAdmin {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "No tienes el control del navegador"})
	}
	if err := s.releaseSharedBrowserController(c.Context(), accountID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo liberar control"})
	}
	s.recordSharedBrowserAudit(c.Context(), accountID, userID, "control_released", session.CurrentURL, session.CurrentDomain, nil)
	session, _ = s.ensureSharedBrowserSession(c.Context(), accountID)
	return c.JSON(fiber.Map{"success": true, "session": s.decorateSharedBrowserSession(session, userID, isAdmin)})
}

func (s *Server) handleSharedBrowserReload(c *fiber.Ctx) error {
	accountID, userID, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	isAdmin := s.isAccountAdmin(c, accountID, userID)
	session, err := s.requireSharedBrowserControl(c.Context(), accountID, userID, isAdmin)
	if err != nil {
		return sharedBrowserControlError(c, err)
	}
	if _, _, status, err := s.callSharedBrowserGateway(c.Context(), http.MethodPost, fmt.Sprintf("/sessions/%s/reload", accountID), nil); err != nil || status >= 400 {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": "No se pudo recargar el navegador"})
	}
	_ = s.touchSharedBrowserSession(c.Context(), accountID, userID)
	s.recordSharedBrowserAudit(c.Context(), accountID, userID, "reload", session.CurrentURL, session.CurrentDomain, nil)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleSharedBrowserRestart(c *fiber.Ctx) error {
	accountID, userID, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	isAdmin := s.isAccountAdmin(c, accountID, userID)
	session, err := s.requireSharedBrowserControl(c.Context(), accountID, userID, isAdmin)
	if err != nil {
		return sharedBrowserControlError(c, err)
	}
	if _, _, status, err := s.callSharedBrowserGateway(c.Context(), http.MethodPost, fmt.Sprintf("/sessions/%s/restart", accountID), nil); err != nil || status >= 400 {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": "No se pudo reiniciar el navegador"})
	}
	if err := s.resetSharedBrowserSession(c.Context(), accountID, userID); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo limpiar la sesión"})
	}
	s.recordSharedBrowserAudit(c.Context(), accountID, userID, "restart", session.CurrentURL, session.CurrentDomain, nil)
	session, _ = s.ensureSharedBrowserSession(c.Context(), accountID)
	return c.JSON(fiber.Map{"success": true, "session": s.decorateSharedBrowserSession(session, userID, isAdmin)})
}

func (s *Server) handleSharedBrowserScreenshot(c *fiber.Ctx) error {
	accountID, _, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	payload, contentType, status, err := s.callSharedBrowserGateway(c.Context(), http.MethodGet, fmt.Sprintf("/sessions/%s/screenshot", accountID), nil)
	if (err == nil && status == fiber.StatusNotFound) || err != nil {
		if reviveErr := s.reviveSharedBrowserGatewaySession(c.Context(), accountID); reviveErr == nil {
			payload, contentType, status, err = s.callSharedBrowserGateway(c.Context(), http.MethodGet, fmt.Sprintf("/sessions/%s/screenshot", accountID), nil)
		}
	}
	if err != nil || status >= 400 {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": "No se pudo cargar la vista del navegador"})
	}
	if contentType == "" {
		contentType = "image/png"
	}
	c.Set("Content-Type", contentType)
	c.Set("Cache-Control", "no-store, private, max-age=0")
	c.Set("X-Content-Type-Options", "nosniff")
	return c.Send(payload)
}

func (s *Server) handleSharedBrowserClick(c *fiber.Ctx) error {
	accountID, userID, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	isAdmin := s.isAccountAdmin(c, accountID, userID)
	if _, err := s.requireSharedBrowserControl(c.Context(), accountID, userID, isAdmin); err != nil {
		return sharedBrowserControlError(c, err)
	}
	var req struct {
		X      float64 `json:"x"`
		Y      float64 `json:"y"`
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if _, _, status, err := s.callSharedBrowserGateway(c.Context(), http.MethodPost, fmt.Sprintf("/sessions/%s/click", accountID), req); err != nil || status >= 400 {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": "No se pudo enviar el click"})
	}
	_ = s.touchSharedBrowserSession(c.Context(), accountID, userID)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleSharedBrowserKey(c *fiber.Ctx) error {
	accountID, userID, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	isAdmin := s.isAccountAdmin(c, accountID, userID)
	if _, err := s.requireSharedBrowserControl(c.Context(), accountID, userID, isAdmin); err != nil {
		return sharedBrowserControlError(c, err)
	}
	var req struct {
		Key  string `json:"key"`
		Text string `json:"text"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if strings.TrimSpace(req.Key) == "" && req.Text == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Tecla requerida"})
	}
	if _, _, status, err := s.callSharedBrowserGateway(c.Context(), http.MethodPost, fmt.Sprintf("/sessions/%s/key", accountID), req); err != nil || status >= 400 {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": "No se pudo enviar la tecla"})
	}
	_ = s.touchSharedBrowserSession(c.Context(), accountID, userID)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleSharedBrowserScroll(c *fiber.Ctx) error {
	accountID, userID, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	isAdmin := s.isAccountAdmin(c, accountID, userID)
	if _, err := s.requireSharedBrowserControl(c.Context(), accountID, userID, isAdmin); err != nil {
		return sharedBrowserControlError(c, err)
	}
	var req struct {
		DeltaY float64 `json:"delta_y"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if _, _, status, err := s.callSharedBrowserGateway(c.Context(), http.MethodPost, fmt.Sprintf("/sessions/%s/scroll", accountID), req); err != nil || status >= 400 {
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": "No se pudo enviar el scroll"})
	}
	_ = s.touchSharedBrowserSession(c.Context(), accountID, userID)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleSharedBrowserStream(c *fiber.Ctx) error {
	accountID, _, ok := sharedBrowserContext(c)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	session, err := s.ensureSharedBrowserSession(c.Context(), accountID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar la sesión"})
	}
	if session.Status != "connected" {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "El navegador aún no está conectado"})
	}

	const boundary = "clarin-browser-frame"
	c.Set("Content-Type", "multipart/x-mixed-replace; boundary="+boundary)
	c.Set("Cache-Control", "no-store, private, max-age=0")
	c.Set("Pragma", "no-cache")
	c.Set("X-Content-Type-Options", "nosniff")
	c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			frameCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			payload, contentType, status, err := s.callSharedBrowserGateway(frameCtx, http.MethodGet, fmt.Sprintf("/sessions/%s/screenshot", accountID), nil)
			cancel()
			if err == nil && status >= 200 && status < 300 && len(payload) > 0 {
				if contentType == "" {
					contentType = "image/png"
				}
				if _, err := fmt.Fprintf(w, "--%s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\n\r\n", boundary, contentType, len(payload)); err != nil {
					return
				}
				if _, err := w.Write(payload); err != nil {
					return
				}
				if _, err := fmt.Fprint(w, "\r\n"); err != nil {
					return
				}
				if err := w.Flush(); err != nil {
					return
				}
			}
			<-ticker.C
		}
	})
	return nil
}

func (s *Server) handleSharedBrowserVNC(c *websocket.Conn) {
	accountID, aok := c.Locals("account_id").(uuid.UUID)
	userID, uok := c.Locals("user_id").(uuid.UUID)
	if !aok || !uok || accountID == uuid.Nil || userID == uuid.Nil {
		_ = c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "unauthorized"))
		return
	}

	session, err := s.ensureSharedBrowserSession(context.Background(), accountID)
	controlExpired := session != nil && session.ControlExpiresAt != nil && time.Now().After(*session.ControlExpiresAt)
	if err != nil || session.Status != "connected" || controlExpired || session.ControllerUserID != userID.String() {
		if controlExpired {
			_ = s.releaseSharedBrowserController(context.Background(), accountID)
		}
		_ = c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "No tienes el control del navegador"))
		return
	}

	info, err := s.getSharedBrowserVNCInfo(context.Background(), accountID)
	if err != nil {
		_ = c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "No se pudo conectar al navegador"))
		return
	}
	tcpConn, err := s.dialSharedBrowserVNC(info.VNCPort)
	if err != nil {
		_ = c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "Navegador no disponible"))
		return
	}
	defer tcpConn.Close()
	defer c.Close()

	_ = s.touchSharedBrowserSession(context.Background(), accountID, userID)
	done := make(chan struct{})
	defer close(done)
	var writeMu sync.Mutex
	writeWS := func(messageType int, payload []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return c.WriteMessage(messageType, payload)
	}

	go s.monitorSharedBrowserVNCControl(done, writeWS, tcpConn, accountID, userID)
	go func() {
		buffer := make([]byte, 32*1024)
		for {
			n, readErr := tcpConn.Read(buffer)
			if readErr != nil {
				_ = writeWS(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
			}
			if writeErr := writeWS(websocket.BinaryMessage, buffer[:n]); writeErr != nil {
				return
			}
		}
	}()

	for {
		messageType, payload, readErr := c.ReadMessage()
		if readErr != nil {
			return
		}
		if messageType != websocket.BinaryMessage && messageType != websocket.TextMessage {
			continue
		}
		if _, writeErr := tcpConn.Write(payload); writeErr != nil {
			return
		}
		_ = s.touchSharedBrowserSession(context.Background(), accountID, userID)
	}
}

type sharedBrowserVNCInfo struct {
	Success bool `json:"success"`
	VNCPort int  `json:"vnc_port"`
}

func (s *Server) getSharedBrowserVNCInfo(ctx context.Context, accountID uuid.UUID) (*sharedBrowserVNCInfo, error) {
	payload, _, status, err := s.callSharedBrowserGateway(ctx, http.MethodGet, fmt.Sprintf("/sessions/%s/vnc-info", accountID), nil)
	if (err == nil && status == fiber.StatusNotFound) || err != nil {
		if reviveErr := s.reviveSharedBrowserGatewaySession(ctx, accountID); reviveErr == nil {
			payload, _, status, err = s.callSharedBrowserGateway(ctx, http.MethodGet, fmt.Sprintf("/sessions/%s/vnc-info", accountID), nil)
		}
	}
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("shared browser vnc-info returned %d", status)
	}
	var info sharedBrowserVNCInfo
	if err := json.Unmarshal(payload, &info); err != nil {
		return nil, err
	}
	if !info.Success || info.VNCPort <= 0 {
		return nil, fmt.Errorf("shared browser vnc endpoint unavailable")
	}
	return &info, nil
}

func (s *Server) reviveSharedBrowserGatewaySession(ctx context.Context, accountID uuid.UUID) error {
	session, err := s.getSharedBrowserSession(ctx, accountID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(session.CurrentURL) == "" || session.Status != "connected" {
		return fmt.Errorf("shared browser session has no URL to revive")
	}
	_, domains, err := s.sharedBrowserDomainAllowed(ctx, accountID, session.CurrentDomain)
	if err != nil {
		return err
	}
	body := fiber.Map{
		"account_id":        accountID.String(),
		"url":               session.CurrentURL,
		"allowed_domains":   domains,
		"block_private_net": true,
	}
	_, _, status, err := s.callSharedBrowserGateway(ctx, http.MethodPost, fmt.Sprintf("/sessions/%s/open", accountID), body)
	if err != nil || status < 200 || status >= 300 {
		if err == nil {
			err = fmt.Errorf("shared browser revive returned %d", status)
		}
		_ = s.updateSharedBrowserError(ctx, accountID, err.Error())
		return err
	}
	return nil
}

func (s *Server) dialSharedBrowserVNC(port int) (net.Conn, error) {
	base, err := url.Parse(strings.TrimSpace(s.cfg.SharedBrowserGatewayURL))
	if err != nil {
		return nil, err
	}
	host := base.Hostname()
	if host == "" {
		return nil, fmt.Errorf("shared browser gateway host unavailable")
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))
	dialer := net.Dialer{Timeout: 10 * time.Second}
	return dialer.Dial("tcp", address)
}

func (s *Server) monitorSharedBrowserVNCControl(done <-chan struct{}, writeWS func(int, []byte) error, tcpConn net.Conn, accountID, userID uuid.UUID) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			session, err := s.getSharedBrowserSession(context.Background(), accountID)
			if err != nil || session.ControllerUserID != userID.String() || session.ControlExpiresAt == nil || time.Now().After(*session.ControlExpiresAt) {
				_ = writeWS(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "Control liberado"))
				_ = tcpConn.Close()
				return
			}
		}
	}
}

var errSharedBrowserControlled = fmt.Errorf("shared browser already controlled")
var errSharedBrowserForbidden = fmt.Errorf("shared browser control forbidden")

func sharedBrowserContext(c *fiber.Ctx) (uuid.UUID, uuid.UUID, bool) {
	accountID, aok := c.Locals("account_id").(uuid.UUID)
	userID, uok := c.Locals("user_id").(uuid.UUID)
	return accountID, userID, aok && uok && accountID != uuid.Nil && userID != uuid.Nil
}

func sharedBrowserControlError(c *fiber.Ctx, err error) error {
	if err == errSharedBrowserControlled || err == errSharedBrowserForbidden {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "No tienes el control del navegador"})
	}
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo validar control"})
}

func (s *Server) isAccountAdmin(c *fiber.Ctx, accountID, userID uuid.UUID) bool {
	if claims, ok := c.Locals("claims").(*service.JWTClaims); ok {
		if claims.IsAdmin || claims.IsSuperAdmin || claims.Role == domain.RoleAdmin || claims.Role == domain.RoleSuperAdmin {
			return true
		}
	}
	var role string
	err := s.repos.DB().QueryRow(c.Context(), `SELECT role FROM user_accounts WHERE user_id = $1 AND account_id = $2`, userID, accountID).Scan(&role)
	return err == nil && (role == domain.RoleAdmin || role == domain.RoleSuperAdmin)
}

func (s *Server) ensureSharedBrowserSession(ctx context.Context, accountID uuid.UUID) (*sharedBrowserSession, error) {
	_, err := s.repos.DB().Exec(ctx, `
		INSERT INTO shared_browser_sessions (account_id, status)
		VALUES ($1, 'idle')
		ON CONFLICT (account_id) DO NOTHING
	`, accountID)
	if err != nil {
		return nil, err
	}
	return s.getSharedBrowserSession(ctx, accountID)
}

func (s *Server) getSharedBrowserSession(ctx context.Context, accountID uuid.UUID) (*sharedBrowserSession, error) {
	var session sharedBrowserSession
	var controllerID sql.NullString
	var controllerName sql.NullString
	var controlExpires sql.NullTime
	var lastActivity sql.NullTime
	err := s.repos.DB().QueryRow(ctx, `
		SELECT s.id::text, s.status, s.current_url, s.current_domain,
		       COALESCE(s.controller_user_id::text, ''), COALESCE(u.display_name, ''),
		       s.control_expires_at, s.gateway_session_id, s.last_error, s.last_activity_at,
		       s.created_at, s.updated_at
		FROM shared_browser_sessions s
		LEFT JOIN users u ON u.id = s.controller_user_id
		WHERE s.account_id = $1
	`, accountID).Scan(
		&session.ID, &session.Status, &session.CurrentURL, &session.CurrentDomain,
		&controllerID, &controllerName, &controlExpires, &session.GatewaySessionID,
		&session.LastError, &lastActivity, &session.CreatedAt, &session.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if controllerID.Valid {
		session.ControllerUserID = controllerID.String
	}
	if controllerName.Valid {
		session.ControllerDisplayName = controllerName.String
	}
	if controlExpires.Valid {
		session.ControlExpiresAt = &controlExpires.Time
	}
	if lastActivity.Valid {
		session.LastActivityAt = &lastActivity.Time
	}
	return &session, nil
}

func (s *Server) decorateSharedBrowserSession(session *sharedBrowserSession, userID uuid.UUID, isAdmin bool) fiber.Map {
	hasControl := session.ControllerUserID == userID.String()
	controlExpired := session.ControlExpiresAt != nil && time.Now().After(*session.ControlExpiresAt)
	return fiber.Map{
		"id":                      session.ID,
		"status":                  session.Status,
		"current_url":             session.CurrentURL,
		"current_domain":          session.CurrentDomain,
		"controller_user_id":      session.ControllerUserID,
		"controller_display_name": session.ControllerDisplayName,
		"control_expires_at":      session.ControlExpiresAt,
		"gateway_session_id":      session.GatewaySessionID,
		"last_error":              session.LastError,
		"last_activity_at":        session.LastActivityAt,
		"created_at":              session.CreatedAt,
		"updated_at":              session.UpdatedAt,
		"has_control":             hasControl && !controlExpired,
		"can_request_control":     session.ControllerUserID == "" || controlExpired || hasControl || isAdmin,
		"can_force_control":       isAdmin && session.ControllerUserID != "" && !hasControl,
	}
}

func (s *Server) ensureSharedBrowserController(ctx context.Context, accountID, userID uuid.UUID, isAdmin, force bool) (*sharedBrowserSession, error) {
	session, err := s.ensureSharedBrowserSession(ctx, accountID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	expired := session.ControlExpiresAt != nil && now.After(*session.ControlExpiresAt)
	if session.ControllerUserID != "" && session.ControllerUserID != userID.String() && !expired && !(isAdmin && force) {
		return session, errSharedBrowserControlled
	}
	expires := now.Add(sharedBrowserControlTTL)
	_, err = s.repos.DB().Exec(ctx, `
		UPDATE shared_browser_sessions
		SET controller_user_id = $2,
		    control_expires_at = $3,
		    last_activity_at = NOW(),
		    updated_at = NOW()
		WHERE account_id = $1
	`, accountID, userID, expires)
	if err != nil {
		return nil, err
	}
	return s.getSharedBrowserSession(ctx, accountID)
}

func (s *Server) requireSharedBrowserControl(ctx context.Context, accountID, userID uuid.UUID, isAdmin bool) (*sharedBrowserSession, error) {
	session, err := s.ensureSharedBrowserSession(ctx, accountID)
	if err != nil {
		return nil, err
	}
	if session.ControlExpiresAt != nil && time.Now().After(*session.ControlExpiresAt) {
		_ = s.releaseSharedBrowserController(ctx, accountID)
		return session, errSharedBrowserForbidden
	}
	if session.ControllerUserID == userID.String() || isAdmin {
		return session, nil
	}
	return session, errSharedBrowserForbidden
}

func (s *Server) releaseSharedBrowserController(ctx context.Context, accountID uuid.UUID) error {
	_, err := s.repos.DB().Exec(ctx, `
		UPDATE shared_browser_sessions
		SET controller_user_id = NULL,
		    control_expires_at = NULL,
		    updated_at = NOW()
		WHERE account_id = $1
	`, accountID)
	return err
}

func (s *Server) updateSharedBrowserOpened(ctx context.Context, accountID, userID uuid.UUID, targetURL, domainName string) error {
	expires := time.Now().Add(sharedBrowserControlTTL)
	_, err := s.repos.DB().Exec(ctx, `
		UPDATE shared_browser_sessions
		SET status = 'connected',
		    current_url = $2,
		    current_domain = $3,
		    controller_user_id = $4,
		    control_expires_at = $5,
		    gateway_session_id = $1::text,
		    last_error = '',
		    last_activity_at = NOW(),
		    updated_at = NOW()
		WHERE account_id = $1
	`, accountID, targetURL, domainName, userID, expires)
	return err
}

func (s *Server) updateSharedBrowserError(ctx context.Context, accountID uuid.UUID, msg string) error {
	_, err := s.repos.DB().Exec(ctx, `
		UPDATE shared_browser_sessions
		SET status = 'error', last_error = $2, updated_at = NOW()
		WHERE account_id = $1
	`, accountID, msg)
	return err
}

func (s *Server) touchSharedBrowserSession(ctx context.Context, accountID, userID uuid.UUID) error {
	expires := time.Now().Add(sharedBrowserControlTTL)
	_, err := s.repos.DB().Exec(ctx, `
		UPDATE shared_browser_sessions
		SET last_activity_at = NOW(),
		    control_expires_at = CASE WHEN controller_user_id = $2 THEN $3 ELSE control_expires_at END,
		    updated_at = NOW()
		WHERE account_id = $1
	`, accountID, userID, expires)
	return err
}

func (s *Server) resetSharedBrowserSession(ctx context.Context, accountID, userID uuid.UUID) error {
	expires := time.Now().Add(sharedBrowserControlTTL)
	_, err := s.repos.DB().Exec(ctx, `
		UPDATE shared_browser_sessions
		SET status = 'idle',
		    current_url = '',
		    current_domain = '',
		    controller_user_id = $2,
		    control_expires_at = $3,
		    gateway_session_id = $1::text,
		    last_error = '',
		    last_activity_at = NOW(),
		    updated_at = NOW()
		WHERE account_id = $1
	`, accountID, userID, expires)
	return err
}

func (s *Server) listSharedBrowserDomains(ctx context.Context, accountID uuid.UUID) ([]sharedBrowserDomain, error) {
	rows, err := s.repos.DB().Query(ctx, `
		SELECT id::text, domain, is_active, created_at
		FROM shared_browser_allowed_domains
		WHERE account_id = $1 AND is_active = TRUE
		ORDER BY domain ASC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []sharedBrowserDomain{}
	for rows.Next() {
		var item sharedBrowserDomain
		if err := rows.Scan(&item.ID, &item.Domain, &item.IsActive, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Server) upsertSharedBrowserDomain(ctx context.Context, accountID, userID uuid.UUID, domainName string) error {
	_, err := s.repos.DB().Exec(ctx, `
		INSERT INTO shared_browser_allowed_domains (account_id, domain, is_active, created_by_user_id)
		VALUES ($1, $2, TRUE, $3)
		ON CONFLICT (account_id, domain) DO UPDATE
		SET is_active = TRUE,
		    created_by_user_id = EXCLUDED.created_by_user_id,
		    updated_at = NOW()
	`, accountID, domainName, userID)
	return err
}

func (s *Server) sharedBrowserDomainAllowed(ctx context.Context, accountID uuid.UUID, domainName string) (bool, []string, error) {
	items, err := s.listSharedBrowserDomains(ctx, accountID)
	if err != nil {
		return false, nil, err
	}
	domains := make([]string, 0, len(items))
	for _, item := range items {
		domains = append(domains, item.Domain)
		if domainMatchesSharedBrowserAllowed(domainName, item.Domain) {
			return true, domains, nil
		}
	}
	return false, domains, nil
}

func domainMatchesSharedBrowserAllowed(host, allowed string) bool {
	host = strings.ToLower(strings.Trim(host, ". "))
	allowed = strings.ToLower(strings.Trim(allowed, ". "))
	return host == allowed || strings.HasSuffix(host, "."+allowed)
}

func (s *Server) recordSharedBrowserAudit(ctx context.Context, accountID, userID uuid.UUID, eventType, targetURL, domainName string, metadata any) {
	spec := []byte("{}")
	if metadata != nil {
		if raw, err := json.Marshal(metadata); err == nil {
			spec = raw
		}
	}
	_, _ = s.repos.DB().Exec(ctx, `
		INSERT INTO shared_browser_audit_events (account_id, user_id, event_type, url, domain, metadata)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb)
	`, accountID, userID, eventType, targetURL, domainName, spec)
}

func normalizeSharedBrowserURL(raw string) (string, string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", "", fmt.Errorf("URL requerida")
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", "", fmt.Errorf("URL inválida")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", "", fmt.Errorf("Solo se permiten URLs http o https")
	}
	host := strings.ToLower(strings.Trim(parsed.Hostname(), ". "))
	domainName, err := normalizeSharedBrowserDomain(host)
	if err != nil {
		return "", "", err
	}
	parsed.Fragment = ""
	return parsed.String(), domainName, nil
}

func normalizeSharedBrowserDomain(raw string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.TrimPrefix(value, "http://")
	value = strings.TrimPrefix(value, "https://")
	if strings.Contains(value, "/") {
		parsed, err := url.Parse("https://" + value)
		if err == nil && parsed.Hostname() != "" {
			value = parsed.Hostname()
		}
	}
	value = strings.Trim(strings.TrimSpace(value), ".")
	if value == "" {
		return "", fmt.Errorf("Dominio requerido")
	}
	if isBlockedSharedBrowserHost(value) {
		return "", fmt.Errorf("Ese dominio o red no está permitido")
	}
	if value == "kommo.com" || strings.HasSuffix(value, ".kommo.com") {
		return "kommo.com", nil
	}
	return value, nil
}

func isBlockedSharedBrowserHost(host string) bool {
	host = strings.ToLower(strings.Trim(host, ". "))
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if host == "metadata.google.internal" || strings.Contains(host, "metadata") {
		return true
	}
	if strings.Contains(host, "_") {
		return true
	}
	blockedNames := map[string]bool{
		"clarin-backend":        true,
		"clarin-frontend":       true,
		"clarin-postgres":       true,
		"clarin-redis":          true,
		"clarin-minio":          true,
		"clarin-codex-bridge":   true,
		"clarin-shared-browser": true,
	}
	if blockedNames[host] {
		return true
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		return addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsMulticast() || addr.IsUnspecified()
	}
	if ip := net.ParseIP(host); ip != nil {
		return true
	}
	// Single-label hostnames are usually Docker/internal service names.
	return !strings.Contains(host, ".")
}

func (s *Server) sharedBrowserGatewayAvailable(ctx context.Context) bool {
	if strings.TrimSpace(s.cfg.SharedBrowserGatewayURL) == "" {
		return false
	}
	healthCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, _, status, err := s.callSharedBrowserGateway(healthCtx, http.MethodGet, "/health", nil)
	return err == nil && status >= 200 && status < 300
}

func (s *Server) callSharedBrowserGateway(ctx context.Context, method, path string, body any) ([]byte, string, int, error) {
	base := strings.TrimRight(strings.TrimSpace(s.cfg.SharedBrowserGatewayURL), "/")
	if base == "" {
		return nil, "", 0, fmt.Errorf("shared browser gateway url not configured")
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, "", 0, err
		}
		reader = bytes.NewReader(raw)
	}
	timeout := s.cfg.SharedBrowserTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, method, base+path, reader)
	if err != nil {
		return nil, "", 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", 0, err
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(res.Body, 12*1024*1024))
	if err != nil {
		return nil, "", res.StatusCode, err
	}
	return payload, res.Header.Get("Content-Type"), res.StatusCode, nil
}
