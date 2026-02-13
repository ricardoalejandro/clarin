package api

import (
	"encoding/csv"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/helmet"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/internal/whatsapp"
	"github.com/naperu/clarin/internal/ws"
	"github.com/naperu/clarin/pkg/config"
)

// strPtr returns a pointer to a string
func strPtr(s string) *string {
	return &s
}

type Server struct {
	app      *fiber.App
	cfg      *config.Config
	services *service.Services
	hub      *ws.Hub
	pool     *whatsapp.DevicePool
	storage  *storage.Storage
}

func NewServer(cfg *config.Config, services *service.Services, hub *ws.Hub, pool *whatsapp.DevicePool, store *storage.Storage) *Server {
	app := fiber.New(fiber.Config{
		AppName:               "Clarin CRM",
		BodyLimit:             32 * 1024 * 1024, // 32MB max upload
		DisableStartupMessage: false,
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			code := fiber.StatusInternalServerError
			if e, ok := err.(*fiber.Error); ok {
				code = e.Code
			}
			return c.Status(code).JSON(fiber.Map{
				"success": false,
				"error":   err.Error(),
			})
		},
	})

	// Middleware
	app.Use(recover.New())
	app.Use(logger.New(logger.Config{
		Format:     "${time} | ${status} | ${latency} | ${method} ${path}\n",
		TimeFormat: "15:04:05",
	}))

	// Security Headers (Helmet)
	app.Use(helmet.New(helmet.Config{
		XSSProtection:         "1; mode=block",
		ContentTypeNosniff:    "nosniff",
		XFrameOptions:         "DENY",
		ReferrerPolicy:        "strict-origin-when-cross-origin",
		CrossOriginEmbedderPolicy: "require-corp",
		CrossOriginOpenerPolicy:   "same-origin",
		CrossOriginResourcePolicy: "same-origin",
		PermissionPolicy:          "geolocation=(), microphone=(), camera=()",
	}))

	// Rate Limiting - 500 requests per minute per IP (skip media file serving)
	app.Use(limiter.New(limiter.Config{
		Max:        500,
		Expiration: 1 * time.Minute,
		KeyGenerator: func(c *fiber.Ctx) string {
			return c.IP()
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(fiber.StatusTooManyRequests).JSON(fiber.Map{
				"success": false,
				"error":   "too many requests, please slow down",
			})
		},
		SkipFailedRequests: false,
		SkipSuccessfulRequests: false,
		Next: func(c *fiber.Ctx) bool {
			// Skip rate limiting for media file endpoints and websocket
			path := c.Path()
			return strings.HasPrefix(path, "/api/media/file/") || strings.HasPrefix(path, "/ws")
		},
	}))
	
	// CORS Configuration
	corsOrigins := "http://localhost:3000,http://localhost:8080"
	if cfg.IsProduction() && len(cfg.CORSOrigins) > 0 {
		corsOrigins = strings.Join(cfg.CORSOrigins, ",")
	}
	app.Use(cors.New(cors.Config{
		AllowOrigins:     corsOrigins,
		AllowMethods:     "GET,POST,PUT,DELETE,OPTIONS,PATCH",
		AllowHeaders:     "Origin,Content-Type,Accept,Authorization,Upgrade,Connection",
		AllowCredentials: true,
	}))

	server := &Server{
		app:      app,
		cfg:      cfg,
		services: services,
		hub:      hub,
		pool:     pool,
		storage:  store,
	}

	server.setupRoutes()
	return server
}

func (s *Server) setupRoutes() {
	// Health check
	s.app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"status": "ok",
			"time":   time.Now(),
		})
	})

	// API routes
	api := s.app.Group("/api")

	// Media proxy - public access for displaying images/videos in chat
	// MUST be registered before protected group to avoid auth middleware
	api.Get("/media/file/*", s.handleMediaProxy)

	// Auth routes (no auth required)
	auth := api.Group("/auth")
	auth.Post("/login", s.handleLogin)

	// Protected routes
	protected := api.Group("", s.authMiddleware)

	// User routes
	protected.Get("/me", s.handleGetMe)
	protected.Get("/me/accounts", s.handleGetMyAccounts)
	protected.Post("/auth/logout", s.handleLogout)
	protected.Post("/auth/switch-account", s.handleSwitchAccount)

	// Device routes
	devices := protected.Group("/devices")
	devices.Get("/", s.handleGetDevices)
	devices.Post("/", s.handleCreateDevice)
	devices.Get("/:id", s.handleGetDevice)
	devices.Post("/:id/connect", s.handleConnectDevice)
	devices.Post("/:id/disconnect", s.handleDisconnectDevice)
	devices.Delete("/:id", s.handleDeleteDevice)

	// Chat routes
	chats := protected.Group("/chats")
	chats.Get("/", s.handleGetChats)
	chats.Post("/new", s.handleCreateNewChat)
	chats.Delete("/batch", s.handleDeleteChatsBatch)
	chats.Get("/:id", s.handleGetChatDetails)
	chats.Get("/:id/messages", s.handleGetMessages)
	chats.Post("/:id/read", s.handleMarkAsRead)
	chats.Delete("/:id", s.handleDeleteChat)

	// Message routes
	messages := protected.Group("/messages")
	messages.Post("/send", s.handleSendMessage)
	messages.Post("/forward", s.handleForwardMessage)
	messages.Post("/react", s.handleSendReaction)
	messages.Post("/poll", s.handleSendPoll)

	// Sticker routes
	protected.Get("/stickers/recent", s.handleGetRecentStickers)
	protected.Get("/stickers/saved", s.handleGetSavedStickers)
	protected.Post("/stickers/saved", s.handleSaveSticker)
	protected.Delete("/stickers/saved", s.handleDeleteSavedSticker)

	// Media routes (upload requires auth)
	media := protected.Group("/media")
	media.Get("/upload-url", s.handleGetUploadURL)
	media.Post("/upload", s.handleDirectUpload)

	// Lead routes
	leads := protected.Group("/leads")
	leads.Get("/", s.handleGetLeads)
	leads.Post("/", s.handleCreateLead)
	leads.Delete("/batch", s.handleDeleteLeadsBatch)
	leads.Get("/:id", s.handleGetLead)
	leads.Put("/:id", s.handleUpdateLead)
	leads.Delete("/:id", s.handleDeleteLead)
	leads.Patch("/:id/status", s.handleUpdateLeadStatus)
	leads.Get("/:id/interactions", s.handleGetLeadInteractions)

	// Pipeline routes
	pipelines := protected.Group("/pipelines")
	pipelines.Get("/", s.handleGetPipelines)

	// Tag routes
	tags := protected.Group("/tags")
	tags.Get("/", s.handleGetTags)
	tags.Post("/", s.handleCreateTag)
	tags.Put("/:id", s.handleUpdateTag)
	tags.Delete("/:id", s.handleDeleteTag)
	tags.Post("/assign", s.handleAssignTag)
	tags.Post("/remove", s.handleRemoveTag)
	tags.Get("/entity/:type/:id", s.handleGetEntityTags)

	// Campaign routes
	campaigns := protected.Group("/campaigns")
	campaigns.Get("/", s.handleGetCampaigns)
	campaigns.Post("/", s.handleCreateCampaign)
	campaigns.Get("/:id", s.handleGetCampaign)
	campaigns.Put("/:id", s.handleUpdateCampaign)
	campaigns.Delete("/:id", s.handleDeleteCampaign)
	campaigns.Post("/:id/recipients", s.handleAddCampaignRecipients)
	campaigns.Get("/:id/recipients", s.handleGetCampaignRecipients)
	campaigns.Post("/:id/start", s.handleStartCampaign)
	campaigns.Post("/:id/pause", s.handlePauseCampaign)
	campaigns.Post("/:id/duplicate", s.handleDuplicateCampaign)

	// Import CSV route
	protected.Post("/import/csv", s.handleImportCSV)

	// Contact routes
	contacts := protected.Group("/contacts")
	contacts.Get("/", s.handleGetContacts)
	contacts.Get("/duplicates", s.handleGetContactDuplicates)
	contacts.Post("/merge", s.handleMergeContacts)
	contacts.Delete("/batch", s.handleDeleteContactsBatch)
	contacts.Get("/:id", s.handleGetContact)
	contacts.Put("/:id", s.handleUpdateContact)
	contacts.Post("/:id/reset", s.handleResetContactFromDevice)
	contacts.Delete("/:id", s.handleDeleteContact)

	// Sync contacts route (under devices)
	devices.Post("/:id/sync-contacts", s.handleSyncDeviceContacts)

	// Event routes
	events := protected.Group("/events")
	events.Get("/", s.handleGetEvents)
	events.Post("/", s.handleCreateEvent)
	events.Get("/upcoming-actions", s.handleGetUpcomingActions)
	events.Get("/:id", s.handleGetEvent)
	events.Put("/:id", s.handleUpdateEvent)
	events.Delete("/:id", s.handleDeleteEvent)
	events.Get("/:id/participants", s.handleGetEventParticipants)
	events.Post("/:id/participants", s.handleAddEventParticipant)
	events.Post("/:id/participants/bulk", s.handleBulkAddEventParticipants)
	events.Put("/:id/participants/:pid", s.handleUpdateEventParticipant)
	events.Patch("/:id/participants/:pid/status", s.handleUpdateEventParticipantStatus)
	events.Delete("/:id/participants/:pid", s.handleDeleteEventParticipant)
	events.Post("/:id/campaign", s.handleCreateCampaignFromEvent)

	// Interaction routes
	interactions := protected.Group("/interactions")
	interactions.Post("/", s.handleLogInteraction)
	interactions.Get("/", s.handleGetInteractions)
	interactions.Delete("/:id", s.handleDeleteInteraction)

	// Contact interactions and events
	contacts.Get("/:id/interactions", s.handleGetContactInteractions)
	contacts.Get("/:id/events", s.handleGetContactEvents)

	// WebSocket route
	s.app.Use("/ws", s.wsUpgrade)
	s.app.Get("/ws", websocket.New(s.handleWebSocket))

	// Stats
	protected.Get("/stats", s.handleGetStats)

	// Super Admin routes
	admin := protected.Group("/admin", s.superAdminMiddleware)
	
	// Account management
	adminAccounts := admin.Group("/accounts")
	adminAccounts.Get("/", s.handleAdminGetAccounts)
	adminAccounts.Post("/", s.handleAdminCreateAccount)
	adminAccounts.Get("/:id", s.handleAdminGetAccount)
	adminAccounts.Put("/:id", s.handleAdminUpdateAccount)
	adminAccounts.Patch("/:id/toggle", s.handleAdminToggleAccount)
	adminAccounts.Delete("/:id", s.handleAdminDeleteAccount)

	// User management
	adminUsers := admin.Group("/users")
	adminUsers.Get("/", s.handleAdminGetUsers)
	adminUsers.Post("/", s.handleAdminCreateUser)
	adminUsers.Put("/:id", s.handleAdminUpdateUser)
	adminUsers.Patch("/:id/toggle", s.handleAdminToggleUser)
	adminUsers.Patch("/:id/password", s.handleAdminResetPassword)
	adminUsers.Delete("/:id", s.handleAdminDeleteUser)

	// User-Account assignments
	adminUsers.Get("/:id/accounts", s.handleAdminGetUserAccounts)
	adminUsers.Post("/:id/accounts", s.handleAdminAssignUserAccount)
	adminUsers.Delete("/:id/accounts/:account_id", s.handleAdminRemoveUserAccount)
}

// Auth middleware
func (s *Server) authMiddleware(c *fiber.Ctx) error {
	authHeader := c.Get("Authorization")
	if authHeader == "" {
		// Try cookie
		authHeader = c.Cookies("auth-token")
	}

	token := strings.TrimPrefix(authHeader, "Bearer ")
	if token == "" {
		return c.Status(401).JSON(fiber.Map{
			"success": false,
			"error":   "Unauthorized",
		})
	}

	claims, err := s.services.Auth.ValidateToken(token, s.cfg.JWTSecret)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{
			"success": false,
			"error":   "Invalid token",
		})
	}

	c.Locals("claims", claims)
	c.Locals("user_id", claims.UserID)
	c.Locals("account_id", claims.AccountID)
	return c.Next()
}

// Super admin middleware
func (s *Server) superAdminMiddleware(c *fiber.Ctx) error {
	claims := c.Locals("claims").(*service.JWTClaims)
	if !claims.IsSuperAdmin {
		return c.Status(403).JSON(fiber.Map{
			"success": false,
			"error":   "Forbidden: super admin access required",
		})
	}
	return c.Next()
}

// WebSocket upgrade middleware
func (s *Server) wsUpgrade(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		// Validate token from query param
		token := c.Query("token")
		if token == "" {
			return c.Status(401).JSON(fiber.Map{"error": "Missing token"})
		}

		claims, err := s.services.Auth.ValidateToken(token, s.cfg.JWTSecret)
		if err != nil {
			return c.Status(401).JSON(fiber.Map{"error": "Invalid token"})
		}

		c.Locals("claims", claims)
		return c.Next()
	}
	return fiber.ErrUpgradeRequired
}

// --- Auth Handlers ---

func (s *Server) handleLogin(c *fiber.Ctx) error {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	token, user, userAccounts, err := s.services.Auth.Login(c.Context(), req.Username, req.Password, s.cfg.JWTSecret)
	if err != nil {
		return c.Status(401).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Set cookie
	c.Cookie(&fiber.Cookie{
		Name:     "auth-token",
		Value:    token,
		Expires:  time.Now().Add(24 * 7 * time.Hour),
		HTTPOnly: true,
		Secure:   s.cfg.IsProduction(),
		SameSite: "Lax",
	})

	// Build accounts list for response
	accountsList := make([]fiber.Map, 0)
	for _, ua := range userAccounts {
		accountsList = append(accountsList, fiber.Map{
			"account_id":   ua.AccountID,
			"account_name": ua.AccountName,
			"account_slug": ua.AccountSlug,
			"role":         ua.Role,
			"is_default":   ua.IsDefault,
		})
	}

	return c.JSON(fiber.Map{
		"success": true,
		"token":   token,
		"user": fiber.Map{
			"id":             user.ID,
			"username":       user.Username,
			"email":          user.Email,
			"display_name":   user.DisplayName,
			"is_admin":       user.IsAdmin,
			"is_super_admin": user.IsSuperAdmin,
			"role":           user.Role,
			"account_id":     user.AccountID,
			"account_name":   user.AccountName,
		},
		"accounts": accountsList,
	})
}

func (s *Server) handleLogout(c *fiber.Ctx) error {
	c.Cookie(&fiber.Cookie{
		Name:    "auth-token",
		Value:   "",
		Expires: time.Now().Add(-time.Hour),
	})
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleGetMe(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	accountID := c.Locals("account_id").(uuid.UUID)
	user, err := s.services.Auth.GetUser(c.Context(), userID)
	if err != nil || user == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "User not found"})
	}

	// Get user's accounts
	userAccounts, _ := s.services.Auth.GetUserAccounts(c.Context(), userID)
	accountsList := make([]fiber.Map, 0)
	activeAccountName := user.AccountName
	for _, ua := range userAccounts {
		accountsList = append(accountsList, fiber.Map{
			"account_id":   ua.AccountID,
			"account_name": ua.AccountName,
			"account_slug": ua.AccountSlug,
			"role":         ua.Role,
			"is_default":   ua.IsDefault,
		})
		if ua.AccountID == accountID {
			activeAccountName = ua.AccountName
		}
	}

	return c.JSON(fiber.Map{
		"success": true,
		"user": fiber.Map{
			"id":             user.ID,
			"username":       user.Username,
			"email":          user.Email,
			"display_name":   user.DisplayName,
			"is_admin":       user.IsAdmin,
			"is_super_admin": user.IsSuperAdmin,
			"role":           user.Role,
			"account_id":     accountID,
			"account_name":   activeAccountName,
		},
		"accounts": accountsList,
	})
}

// --- Device Handlers ---

func (s *Server) handleGetDevices(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	devices, err := s.services.Device.GetByAccountID(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "devices": devices})
}

func (s *Server) handleCreateDevice(c *fiber.Ctx) error {
	var req struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	accountID := c.Locals("account_id").(uuid.UUID)
	device, err := s.services.Device.Create(c.Context(), accountID, req.Name)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.Status(201).JSON(fiber.Map{"success": true, "device": device})
}

func (s *Server) handleGetDevice(c *fiber.Ctx) error {
	deviceID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	device, err := s.services.Device.GetByID(c.Context(), deviceID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if device == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Device not found"})
	}

	return c.JSON(fiber.Map{"success": true, "device": device})
}

func (s *Server) handleConnectDevice(c *fiber.Ctx) error {
	deviceID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if err := s.services.Device.Connect(c.Context(), deviceID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": "Connecting device..."})
}

func (s *Server) handleDisconnectDevice(c *fiber.Ctx) error {
	deviceID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if err := s.services.Device.Disconnect(c.Context(), deviceID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": "Device disconnected"})
}

func (s *Server) handleDeleteDevice(c *fiber.Ctx) error {
	deviceID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if err := s.services.Device.Delete(c.Context(), deviceID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": "Device deleted"})
}

// --- Chat Handlers ---

func (s *Server) handleGetChats(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	// Parse filters
	filter := domain.ChatFilter{
		UnreadOnly: c.QueryBool("unread_only", false),
		Archived:   c.QueryBool("archived", false),
		Search:     c.Query("search", ""),
		Limit:      c.QueryInt("limit", 50),
		Offset:     c.QueryInt("offset", 0),
	}

	// Parse device_ids filter (supports both comma-separated and repeated params)
	deviceIDsRaw := c.Context().QueryArgs().PeekMulti("device_ids")
	for _, raw := range deviceIDsRaw {
		for _, idStr := range strings.Split(string(raw), ",") {
			if uid, err := uuid.Parse(strings.TrimSpace(idStr)); err == nil {
				filter.DeviceIDs = append(filter.DeviceIDs, uid)
			}
		}
	}

	chats, total, err := s.services.Chat.GetByAccountIDWithFilters(c.Context(), accountID, filter)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{
		"success": true,
		"chats":   chats,
		"total":   total,
		"limit":   filter.Limit,
		"offset":  filter.Offset,
	})
}

func (s *Server) handleGetChatDetails(c *fiber.Ctx) error {
	chatID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid chat ID"})
	}

	details, err := s.services.Chat.GetChatDetails(c.Context(), chatID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if details == nil || details.Chat == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Chat not found"})
	}

	return c.JSON(fiber.Map{
		"success": true,
		"chat":    details.Chat,
		"contact": details.Contact,
		"lead":    details.Lead,
	})
}

func (s *Server) handleCreateNewChat(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		DeviceID       string `json:"device_id"`
		Phone          string `json:"phone"`
		InitialMessage string `json:"initial_message,omitempty"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if req.Phone == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Phone number is required"})
	}

	// Create chat
	chat, err := s.services.Chat.CreateNewChat(c.Context(), accountID, deviceID, req.Phone)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Send initial message if provided
	if req.InitialMessage != "" {
		_, err := s.services.Chat.SendMessage(c.Context(), deviceID, chat.JID, req.InitialMessage)
		if err != nil {
			// Chat created but message failed - still return chat
			return c.Status(201).JSON(fiber.Map{
				"success": true,
				"chat":    chat,
				"warning": "Chat created but initial message failed to send",
			})
		}
	}

	return c.Status(201).JSON(fiber.Map{"success": true, "chat": chat})
}

func (s *Server) handleGetMessages(c *fiber.Ctx) error {
	chatID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid chat ID"})
	}

	limit := c.QueryInt("limit", 50)
	offset := c.QueryInt("offset", 0)

	messages, err := s.services.Chat.GetMessages(c.Context(), chatID, limit, offset)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Load reactions for this chat
	reactions, _ := s.services.Chat.GetReactions(c.Context(), chatID)
	reactionsByMsg := make(map[string][]*domain.MessageReaction)
	for _, r := range reactions {
		reactionsByMsg[r.TargetMessageID] = append(reactionsByMsg[r.TargetMessageID], r)
	}

	// Attach reactions and poll data to messages
	for _, msg := range messages {
		if rxns, ok := reactionsByMsg[msg.MessageID]; ok {
			msg.Reactions = rxns
		}
		if msg.MessageType != nil && *msg.MessageType == domain.MessageTypePoll {
			options, votes, _ := s.services.Chat.GetPollData(c.Context(), msg.ID)
			msg.PollOptions = options
			msg.PollVotes = votes
		}
	}

	return c.JSON(fiber.Map{"success": true, "messages": messages})
}

func (s *Server) handleMarkAsRead(c *fiber.Ctx) error {
	chatID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid chat ID"})
	}

	if err := s.services.Chat.MarkAsRead(c.Context(), chatID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleDeleteChat(c *fiber.Ctx) error {
	chatID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid chat ID"})
	}

	if err := s.services.Chat.Delete(c.Context(), chatID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": "Chat deleted"})
}

func (s *Server) handleDeleteChatsBatch(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		IDs       []string `json:"ids"`
		DeleteAll bool     `json:"delete_all"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if req.DeleteAll {
		if err := s.services.Chat.DeleteAll(c.Context(), accountID); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		return c.JSON(fiber.Map{"success": true, "message": "All chats deleted"})
	}

	if len(req.IDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No IDs provided"})
	}

	var uuids []uuid.UUID
	for _, id := range req.IDs {
		if uid, err := uuid.Parse(id); err == nil {
			uuids = append(uuids, uid)
		}
	}

	if len(uuids) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No valid IDs provided"})
	}

	if err := s.services.Chat.DeleteBatch(c.Context(), uuids); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": fmt.Sprintf("%d chats deleted", len(uuids))})
}

func (s *Server) handleSendMessage(c *fiber.Ctx) error {
	var req struct {
		DeviceID        string `json:"device_id"`
		To              string `json:"to"`
		Body            string `json:"body"`
		MediaURL        string `json:"media_url,omitempty"`
		MediaType       string `json:"media_type,omitempty"` // image, video, audio, document
		QuotedMessageID string `json:"quoted_message_id,omitempty"`
		QuotedBody      string `json:"quoted_body,omitempty"`
		QuotedSender    string `json:"quoted_sender,omitempty"`
		QuotedIsFromMe  bool   `json:"quoted_is_from_me,omitempty"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	var message *domain.Message

	if req.MediaURL != "" && req.MediaType != "" {
		// Send media message
		message, err = s.services.Chat.SendMediaMessage(c.Context(), deviceID, req.To, req.Body, req.MediaURL, req.MediaType)
	} else if req.QuotedMessageID != "" {
		// Send reply message
		message, err = s.services.Chat.SendReplyMessage(c.Context(), deviceID, req.To, req.Body, req.QuotedMessageID, req.QuotedBody, req.QuotedSender, req.QuotedIsFromMe)
	} else {
		// Send text message
		message, err = s.services.Chat.SendMessage(c.Context(), deviceID, req.To, req.Body)
	}

	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": message})
}

func (s *Server) handleForwardMessage(c *fiber.Ctx) error {
	var req struct {
		DeviceID  string `json:"device_id"`
		To        string `json:"to"`  // target chat JID
		ChatID    string `json:"chat_id"` // source chat UUID
		MessageID string `json:"message_id"` // WhatsApp message_id of the original message
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	chatID, err := uuid.Parse(req.ChatID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid chat ID"})
	}

	// Get original message
	originalMsg, err := s.services.Chat.GetMessageByID(c.Context(), chatID, req.MessageID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Original message not found"})
	}

	// Forward it
	message, err := s.services.Chat.ForwardMessage(c.Context(), deviceID, req.To, originalMsg)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": message})
}

func (s *Server) handleSendReaction(c *fiber.Ctx) error {
	var req struct {
		DeviceID        string `json:"device_id"`
		To              string `json:"to"`
		TargetMessageID string `json:"target_message_id"`
		Emoji           string `json:"emoji"` // empty to remove
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if req.TargetMessageID == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "target_message_id is required"})
	}

	if err := s.services.Chat.SendReaction(c.Context(), deviceID, req.To, req.TargetMessageID, req.Emoji); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleSendPoll(c *fiber.Ctx) error {
	var req struct {
		DeviceID      string   `json:"device_id"`
		To            string   `json:"to"`
		Question      string   `json:"question"`
		Options       []string `json:"options"`
		MaxSelections int      `json:"max_selections"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if req.Question == "" || len(req.Options) < 2 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Question and at least 2 options are required"})
	}

	if len(req.Options) > 12 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Maximum 12 options allowed"})
	}

	message, err := s.services.Chat.SendPoll(c.Context(), deviceID, req.To, req.Question, req.Options, req.MaxSelections)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": message})
}

// --- Media Handlers ---

func (s *Server) handleGetUploadURL(c *fiber.Ctx) error {
	if s.storage == nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "Storage not configured"})
	}

	accountID := c.Locals("account_id").(uuid.UUID)

	filename := c.Query("filename", "")
	folder := c.Query("folder", "uploads")

	if filename == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Filename is required"})
	}

	// Generate unique filename to avoid collisions
	uniqueFilename := uuid.New().String() + "_" + filename

	uploadURL, err := s.storage.GetPresignedUploadURL(c.Context(), accountID, folder, uniqueFilename)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Generate the public URL for the file after upload
	publicURL := s.storage.GetPublicURL(accountID.String() + "/" + folder + "/" + uniqueFilename)

	return c.JSON(fiber.Map{
		"success":    true,
		"upload_url": uploadURL,
		"public_url": publicURL,
		"filename":   uniqueFilename,
	})
}

// handleDirectUpload handles direct file upload through the backend
func (s *Server) handleDirectUpload(c *fiber.Ctx) error {
	if s.storage == nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "Storage not configured"})
	}

	accountID := c.Locals("account_id").(uuid.UUID)

	// Get the file from form
	file, err := c.FormFile("file")
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No file provided"})
	}

	folder := c.FormValue("folder", "uploads")

	// Validate file size (max 50MB)
	if file.Size > 50*1024*1024 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "File too large (max 50MB)"})
	}

	// Open the file
	src, err := file.Open()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to read file"})
	}
	defer src.Close()

	// Generate unique filename
	uniqueFilename := uuid.New().String() + "_" + file.Filename

	// Detect content type
	contentType := file.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Upload to storage
	publicURL, err := s.storage.UploadReader(c.Context(), accountID, folder, uniqueFilename, src, file.Size, contentType)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to upload: " + err.Error()})
	}

	// Return proxy URL instead of direct MinIO URL
	proxyURL := fmt.Sprintf("/api/media/file/%s/%s/%s", accountID.String(), folder, uniqueFilename)

	return c.JSON(fiber.Map{
		"success":    true,
		"public_url": publicURL,
		"proxy_url":  proxyURL,
		"filename":   uniqueFilename,
	})
}

// handleMediaProxy serves files from MinIO through the backend
func (s *Server) handleMediaProxy(c *fiber.Ctx) error {
	if s.storage == nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "Storage not configured"})
	}

	// Get the path after /file/ and URL-decode it
	objectKey := c.Params("*")
	if objectKey == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid path"})
	}
	// Fiber returns URL-encoded path for wildcard params, decode for MinIO lookup
	if decoded, err := url.PathUnescape(objectKey); err == nil {
		objectKey = decoded
	}

	// Detect content type from extension
	contentType := "application/octet-stream"
	if dotIdx := strings.LastIndex(objectKey, "."); dotIdx >= 0 {
		ext := strings.ToLower(objectKey[dotIdx:])
		switch ext {
		case ".jpg", ".jpeg":
			contentType = "image/jpeg"
		case ".png":
			contentType = "image/png"
		case ".gif":
			contentType = "image/gif"
		case ".webp":
			contentType = "image/webp"
		case ".mp4":
			contentType = "video/mp4"
		case ".webm":
			contentType = "video/webm"
		case ".mp3":
			contentType = "audio/mpeg"
		case ".ogg":
			contentType = "audio/ogg"
		case ".pdf":
			contentType = "application/pdf"
		}
	}

	// Check for Range header (needed for video streaming)
	rangeHeader := c.Get("Range")
	if rangeHeader != "" {
		// Get file info for total size
		info, err := s.storage.GetFileInfo(c.Context(), objectKey)
		if err != nil {
			return c.Status(404).JSON(fiber.Map{"success": false, "error": "File not found"})
		}
		totalSize := info.Size

		// Parse range header: "bytes=start-end"
		rangeHeader = strings.TrimPrefix(rangeHeader, "bytes=")
		parts := strings.SplitN(rangeHeader, "-", 2)
		var start, end int64
		if parts[0] != "" {
			fmt.Sscanf(parts[0], "%d", &start)
		}
		if len(parts) > 1 && parts[1] != "" {
			fmt.Sscanf(parts[1], "%d", &end)
		} else {
			// Serve chunks of 1MB max for streaming
			end = start + 1024*1024 - 1
			if end >= totalSize {
				end = totalSize - 1
			}
		}
		if end >= totalSize {
			end = totalSize - 1
		}

		length := end - start + 1
		data, err := s.storage.GetFileRange(c.Context(), objectKey, start, length)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to read file"})
		}

		c.Set("Content-Type", contentType)
		c.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, totalSize))
		c.Set("Accept-Ranges", "bytes")
		c.Set("Content-Length", fmt.Sprintf("%d", len(data)))
		c.Set("Cache-Control", "public, max-age=31536000")
		return c.Status(206).Send(data)
	}

	// Full file download
	data, err := s.storage.GetFile(c.Context(), objectKey)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "File not found"})
	}

	c.Set("Content-Type", contentType)
	c.Set("Accept-Ranges", "bytes")
	c.Set("Content-Length", fmt.Sprintf("%d", len(data)))
	c.Set("Cache-Control", "public, max-age=31536000")
	return c.Send(data)
}

// --- Lead Handlers ---

func (s *Server) handleGetLeads(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	leads, err := s.services.Lead.GetByAccountID(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "leads": leads})
}

func (s *Server) handleCreateLead(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		Name   string `json:"name"`
		Phone  string `json:"phone"`
		Email  string `json:"email"`
		Source string `json:"source"`
		Notes  string `json:"notes"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	lead := &domain.Lead{
		AccountID: accountID,
		JID:       req.Phone + "@s.whatsapp.net",
		Name:      strPtr(req.Name),
		Phone:     strPtr(req.Phone),
		Email:     strPtr(req.Email),
		Source:    strPtr(req.Source),
		Notes:     strPtr(req.Notes),
		Status:    strPtr(domain.LeadStatusNew),
	}

	if err := s.services.Lead.Create(c.Context(), lead); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.Status(201).JSON(fiber.Map{"success": true, "lead": lead})
}

func (s *Server) handleGetLead(c *fiber.Ctx) error {
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid lead ID"})
	}

	lead, err := s.services.Lead.GetByID(c.Context(), leadID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if lead == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Lead not found"})
	}

	return c.JSON(fiber.Map{"success": true, "lead": lead})
}

func (s *Server) handleUpdateLead(c *fiber.Ctx) error {
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid lead ID"})
	}

	// Get existing lead
	lead, err := s.services.Lead.GetByID(c.Context(), leadID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if lead == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Lead not found"})
	}

	// Parse update request
	var req struct {
		Name         *string                `json:"name"`
		Phone        *string                `json:"phone"`
		Email        *string                `json:"email"`
		Status       *string                `json:"status"`
		Source       *string                `json:"source"`
		Notes        *string                `json:"notes"`
		Tags         []string               `json:"tags"`
		CustomFields map[string]interface{} `json:"custom_fields"`
		AssignedTo   *string                `json:"assigned_to"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	// Update fields if provided
	if req.Name != nil {
		lead.Name = req.Name
	}
	if req.Phone != nil {
		lead.Phone = req.Phone
	}
	if req.Email != nil {
		lead.Email = req.Email
	}
	if req.Status != nil {
		lead.Status = req.Status
	}
	if req.Source != nil {
		lead.Source = req.Source
	}
	if req.Notes != nil {
		lead.Notes = req.Notes
	}
	if req.Tags != nil {
		lead.Tags = req.Tags
	}
	if req.CustomFields != nil {
		lead.CustomFields = req.CustomFields
	}
	if req.AssignedTo != nil {
		if *req.AssignedTo == "" {
			lead.AssignedTo = nil
		} else if uid, err := uuid.Parse(*req.AssignedTo); err == nil {
			lead.AssignedTo = &uid
		}
	}

	if err := s.services.Lead.Update(c.Context(), lead); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "lead": lead})
}

func (s *Server) handleUpdateLeadStatus(c *fiber.Ctx) error {
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid lead ID"})
	}

	var req struct {
		Status string `json:"status"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if err := s.services.Lead.UpdateStatus(c.Context(), leadID, req.Status); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleDeleteLead(c *fiber.Ctx) error {
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid lead ID"})
	}

	if err := s.services.Lead.Delete(c.Context(), leadID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": "Lead deleted"})
}

func (s *Server) handleDeleteLeadsBatch(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		IDs       []string `json:"ids"`
		DeleteAll bool     `json:"delete_all"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if req.DeleteAll {
		if err := s.services.Lead.DeleteAll(c.Context(), accountID); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		return c.JSON(fiber.Map{"success": true, "message": "All leads deleted"})
	}

	if len(req.IDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No IDs provided"})
	}

	var uuids []uuid.UUID
	for _, id := range req.IDs {
		if uid, err := uuid.Parse(id); err == nil {
			uuids = append(uuids, uid)
		}
	}

	if len(uuids) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No valid IDs provided"})
	}

	if err := s.services.Lead.DeleteBatch(c.Context(), uuids); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": fmt.Sprintf("%d leads deleted", len(uuids))})
}

// --- Pipeline Handlers ---

func (s *Server) handleGetPipelines(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	pipelines, err := s.services.Pipeline.GetByAccountID(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "pipelines": pipelines})
}

// --- Import CSV Handler ---

func (s *Server) handleImportCSV(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	importType := c.FormValue("import_type") // "leads", "contacts", "both"
	if importType == "" {
		importType = "leads"
	}
	if importType != "leads" && importType != "contacts" && importType != "both" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "import_type must be 'leads', 'contacts', or 'both'"})
	}

	file, err := c.FormFile("file")
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "CSV file is required"})
	}

	f, err := file.Open()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Cannot read file"})
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.LazyQuotes = true
	reader.TrimLeadingSpace = true

	// Read header
	headers, err := reader.Read()
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Cannot read CSV headers"})
	}

	// Map header columns (case-insensitive)
	colMap := make(map[string]int)
	for i, h := range headers {
		colMap[strings.ToLower(strings.TrimSpace(h))] = i
	}

	// Check required columns
	phoneCol := -1
	for _, key := range []string{"phone", "telefono", "celular", "número", "numero"} {
		if idx, ok := colMap[key]; ok {
			phoneCol = idx
			break
		}
	}
	if phoneCol == -1 {
		return c.Status(400).JSON(fiber.Map{
			"success": false,
			"error":   "CSV must have a phone/telefono/celular column",
		})
	}

	nameCol := -1
	for _, key := range []string{"name", "nombre", "nombre_completo"} {
		if idx, ok := colMap[key]; ok {
			nameCol = idx
			break
		}
	}
	emailCol := -1
	if idx, ok := colMap["email"]; ok {
		emailCol = idx
	} else if idx, ok := colMap["correo"]; ok {
		emailCol = idx
	}
	notesCol := -1
	if idx, ok := colMap["notes"]; ok {
		notesCol = idx
	} else if idx, ok := colMap["notas"]; ok {
		notesCol = idx
	}
	tagsCol := -1
	if idx, ok := colMap["tags"]; ok {
		tagsCol = idx
	} else if idx, ok := colMap["etiquetas"]; ok {
		tagsCol = idx
	}
	companyCol := -1
	if idx, ok := colMap["company"]; ok {
		companyCol = idx
	} else if idx, ok := colMap["empresa"]; ok {
		companyCol = idx
	}
	lastNameCol := -1
	for _, key := range []string{"last_name", "apellido", "apellidos"} {
		if idx, ok := colMap[key]; ok {
			lastNameCol = idx
			break
		}
	}

	imported := 0
	skipped := 0
	var errors []string

	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			skipped++
			continue
		}

		phone := strings.TrimSpace(row[phoneCol])
		if phone == "" {
			skipped++
			continue
		}

		// Normalize phone: remove spaces, dashes, ensure digits
		phone = strings.ReplaceAll(phone, " ", "")
		phone = strings.ReplaceAll(phone, "-", "")
		phone = strings.ReplaceAll(phone, "(", "")
		phone = strings.ReplaceAll(phone, ")", "")
		phone = strings.TrimPrefix(phone, "+")

		jid := phone + "@s.whatsapp.net"

		name := ""
		if nameCol >= 0 && nameCol < len(row) {
			name = strings.TrimSpace(row[nameCol])
		}
		email := ""
		if emailCol >= 0 && emailCol < len(row) {
			email = strings.TrimSpace(row[emailCol])
		}
		notes := ""
		if notesCol >= 0 && notesCol < len(row) {
			notes = strings.TrimSpace(row[notesCol])
		}
		tags := ""
		if tagsCol >= 0 && tagsCol < len(row) {
			tags = strings.TrimSpace(row[tagsCol])
		}
		company := ""
		if companyCol >= 0 && companyCol < len(row) {
			company = strings.TrimSpace(row[companyCol])
		}
		lastName := ""
		if lastNameCol >= 0 && lastNameCol < len(row) {
			lastName = strings.TrimSpace(row[lastNameCol])
		}

		if importType == "contacts" || importType == "both" {
			contact, err := s.services.Contact.GetOrCreate(c.Context(), accountID, nil, jid, phone, name, "", false)
			if err != nil {
				errors = append(errors, fmt.Sprintf("row %d contact: %s", imported+skipped+1, err.Error()))
			} else if contact != nil {
				// Update extra fields if provided
				needUpdate := false
				if email != "" && (contact.Email == nil || *contact.Email == "") {
					contact.Email = &email
					needUpdate = true
				}
				if company != "" && (contact.Company == nil || *contact.Company == "") {
					contact.Company = &company
					needUpdate = true
				}
				if lastName != "" && (contact.LastName == nil || *contact.LastName == "") {
					contact.LastName = &lastName
					needUpdate = true
				}
				if notes != "" && (contact.Notes == nil || *contact.Notes == "") {
					contact.Notes = &notes
					needUpdate = true
				}
				if needUpdate {
					s.services.Contact.Update(c.Context(), contact)
				}
			}
		}
		if importType == "leads" || importType == "both" {
			lead := &domain.Lead{
				AccountID: accountID,
				JID:       jid,
				Name:      strPtr(name),
				Phone:     strPtr(phone),
				Email:     strPtr(email),
				Notes:     strPtr(notes),
				Source:    strPtr("csv_import"),
				Status:    strPtr(domain.LeadStatusNew),
			}
			if tags != "" {
				tagList := strings.Split(tags, ",")
				for i := range tagList {
					tagList[i] = strings.TrimSpace(tagList[i])
				}
				lead.Tags = tagList
			}
			if err := s.services.Lead.Create(c.Context(), lead); err != nil {
				errors = append(errors, fmt.Sprintf("row %d lead: %s", imported+skipped+1, err.Error()))
			}
		}

		imported++
	}

	return c.JSON(fiber.Map{
		"success":  true,
		"imported": imported,
		"skipped":  skipped,
		"errors":   errors,
	})
}

// --- Contact Handlers ---

func (s *Server) handleGetContacts(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	// Parse filters
	filter := domain.ContactFilter{
		Search:  c.Query("search"),
		Limit:   c.QueryInt("limit", 50),
		Offset:  c.QueryInt("offset", 0),
		IsGroup: c.QueryBool("is_group", false),
	}

	if deviceIDStr := c.Query("device_id"); deviceIDStr != "" {
		if did, err := uuid.Parse(deviceIDStr); err == nil {
			filter.DeviceID = &did
		}
	}

	if c.QueryBool("has_phone", false) {
		filter.HasPhone = true
	}

	if tagsStr := c.Query("tags"); tagsStr != "" {
		filter.Tags = strings.Split(tagsStr, ",")
	}

	contacts, total, err := s.services.Contact.GetByAccountIDWithFilters(c.Context(), accountID, filter)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{
		"success":  true,
		"contacts": contacts,
		"total":    total,
		"limit":    filter.Limit,
		"offset":   filter.Offset,
	})
}

func (s *Server) handleGetContact(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}

	contact, err := s.services.Contact.GetByID(c.Context(), id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if contact == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "contact not found"})
	}
	return c.JSON(fiber.Map{"success": true, "contact": contact})
}

func (s *Server) handleUpdateContact(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}

	contact, err := s.services.Contact.GetByID(c.Context(), id)
	if err != nil || contact == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "contact not found"})
	}

	var body struct {
		CustomName *string  `json:"custom_name"`
		LastName   *string  `json:"last_name"`
		ShortName  *string  `json:"short_name"`
		Phone      *string  `json:"phone"`
		Email      *string  `json:"email"`
		Company    *string  `json:"company"`
		Age        *int     `json:"age"`
		Tags       []string `json:"tags"`
		Notes      *string  `json:"notes"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}

	if body.CustomName != nil {
		contact.CustomName = body.CustomName
	}
	if body.LastName != nil {
		contact.LastName = body.LastName
	}
	if body.ShortName != nil {
		contact.ShortName = body.ShortName
	}
	if body.Phone != nil {
		contact.Phone = body.Phone
	}
	if body.Email != nil {
		contact.Email = body.Email
	}
	if body.Company != nil {
		contact.Company = body.Company
	}
	if body.Age != nil {
		contact.Age = body.Age
	}
	if body.Tags != nil {
		contact.Tags = body.Tags
	}
	if body.Notes != nil {
		contact.Notes = body.Notes
	}

	if err := s.services.Contact.Update(c.Context(), contact); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Sync shared fields to all linked event_participants
	_ = s.services.Contact.SyncToParticipants(c.Context(), contact)

	return c.JSON(fiber.Map{"success": true, "contact": contact})
}

func (s *Server) handleResetContactFromDevice(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}

	if err := s.services.Contact.ResetFromDevice(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Return updated contact
	contact, _ := s.services.Contact.GetByID(c.Context(), id)
	return c.JSON(fiber.Map{"success": true, "contact": contact})
}

func (s *Server) handleDeleteContact(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}

	if err := s.services.Contact.Delete(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleDeleteContactsBatch(c *fiber.Ctx) error {
	var body struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := c.BodyParser(&body); err != nil || len(body.IDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "provide ids array"})
	}

	if err := s.services.Contact.DeleteBatch(c.Context(), body.IDs); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleGetContactDuplicates(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	groups, err := s.services.Contact.FindDuplicates(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "duplicates": groups})
}

func (s *Server) handleMergeContacts(c *fiber.Ctx) error {
	var body struct {
		KeepID   uuid.UUID   `json:"keep_id"`
		MergeIDs []uuid.UUID `json:"merge_ids"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	if len(body.MergeIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "provide merge_ids"})
	}

	if err := s.services.Contact.MergeContacts(c.Context(), body.KeepID, body.MergeIDs); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleSyncDeviceContacts(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid device id"})
	}

	if err := s.services.Contact.SyncDevice(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "message": "sync started"})
}

// --- Tag Handlers ---

func (s *Server) handleGetTags(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	tags, err := s.services.Tag.GetByAccountID(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if tags == nil {
		tags = make([]*domain.Tag, 0)
	}
	return c.JSON(fiber.Map{"success": true, "tags": tags})
}

func (s *Server) handleCreateTag(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	if req.Color == "" {
		req.Color = "#6366f1"
	}
	tag := &domain.Tag{AccountID: accountID, Name: req.Name, Color: req.Color}
	if err := s.services.Tag.Create(c.Context(), tag); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "tag": tag})
}

func (s *Server) handleUpdateTag(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid tag ID"})
	}
	var req struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	tag := &domain.Tag{ID: id, Name: req.Name, Color: req.Color}
	if err := s.services.Tag.Update(c.Context(), tag); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "tag": tag})
}

func (s *Server) handleDeleteTag(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid tag ID"})
	}
	if err := s.services.Tag.Delete(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleAssignTag(c *fiber.Ctx) error {
	var req struct {
		EntityType string `json:"entity_type"` // contact, lead, chat
		EntityID   string `json:"entity_id"`
		TagID      string `json:"tag_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	entityID, err := uuid.Parse(req.EntityID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid entity ID"})
	}
	tagID, err := uuid.Parse(req.TagID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid tag ID"})
	}
	if err := s.services.Tag.Assign(c.Context(), req.EntityType, entityID, tagID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleRemoveTag(c *fiber.Ctx) error {
	var req struct {
		EntityType string `json:"entity_type"`
		EntityID   string `json:"entity_id"`
		TagID      string `json:"tag_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	entityID, err := uuid.Parse(req.EntityID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid entity ID"})
	}
	tagID, err := uuid.Parse(req.TagID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid tag ID"})
	}
	if err := s.services.Tag.Remove(c.Context(), req.EntityType, entityID, tagID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleGetEntityTags(c *fiber.Ctx) error {
	entityType := c.Params("type")
	entityID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}
	tags, err := s.services.Tag.GetByEntity(c.Context(), entityType, entityID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if tags == nil {
		tags = make([]*domain.Tag, 0)
	}
	return c.JSON(fiber.Map{"success": true, "tags": tags})
}

// --- Campaign Handlers ---

func (s *Server) handleGetCampaigns(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	campaigns, err := s.services.Campaign.GetByAccountID(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if campaigns == nil {
		campaigns = make([]*domain.Campaign, 0)
	}
	return c.JSON(fiber.Map{"success": true, "campaigns": campaigns})
}

func (s *Server) handleCreateCampaign(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		Name            string                 `json:"name"`
		DeviceID        string                 `json:"device_id"`
		MessageTemplate string                 `json:"message_template"`
		MediaURL        *string                `json:"media_url"`
		MediaType       *string                `json:"media_type"`
		ScheduledAt     *time.Time             `json:"scheduled_at"`
		Settings        map[string]interface{} `json:"settings"`
		EventID         *string                `json:"event_id"`
		Source          *string                `json:"source"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" || req.DeviceID == "" || req.MessageTemplate == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "name, device_id and message_template are required"})
	}
	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}
	campaign := &domain.Campaign{
		AccountID:       accountID,
		DeviceID:        deviceID,
		Name:            req.Name,
		MessageTemplate: req.MessageTemplate,
		MediaURL:        req.MediaURL,
		MediaType:       req.MediaType,
		ScheduledAt:     req.ScheduledAt,
		Settings:        req.Settings,
	}
	if req.EventID != nil {
		eid, err := uuid.Parse(*req.EventID)
		if err == nil {
			campaign.EventID = &eid
		}
	}
	if req.Source != nil {
		campaign.Source = req.Source
	}
	if err := s.services.Campaign.Create(c.Context(), campaign); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "campaign": campaign})
}

func (s *Server) handleGetCampaign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	campaign, err := s.services.Campaign.GetByID(c.Context(), id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "campaign": campaign})
}

func (s *Server) handleUpdateCampaign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	campaign, err := s.services.Campaign.GetByID(c.Context(), id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	var req struct {
		Name            *string                `json:"name"`
		DeviceID        *string                `json:"device_id"`
		MessageTemplate *string                `json:"message_template"`
		MediaURL        *string                `json:"media_url"`
		MediaType       *string                `json:"media_type"`
		ScheduledAt     *time.Time             `json:"scheduled_at"`
		Status          *string                `json:"status"`
		Settings        map[string]interface{} `json:"settings"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name != nil {
		campaign.Name = *req.Name
	}
	if req.DeviceID != nil {
		if did, err := uuid.Parse(*req.DeviceID); err == nil {
			campaign.DeviceID = did
		}
	}
	if req.MessageTemplate != nil {
		campaign.MessageTemplate = *req.MessageTemplate
	}
	if req.MediaURL != nil {
		campaign.MediaURL = req.MediaURL
	}
	if req.MediaType != nil {
		campaign.MediaType = req.MediaType
	}
	if req.ScheduledAt != nil {
		campaign.ScheduledAt = req.ScheduledAt
	}
	if req.Status != nil && (*req.Status == domain.CampaignStatusScheduled || *req.Status == domain.CampaignStatusDraft) {
		campaign.Status = *req.Status
	}
	if req.Settings != nil {
		campaign.Settings = req.Settings
	}
	if err := s.services.Campaign.Update(c.Context(), campaign); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "campaign": campaign})
}

func (s *Server) handleDeleteCampaign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	if err := s.services.Campaign.Delete(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleAddCampaignRecipients(c *fiber.Ctx) error {
	campaignID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	var req struct {
		Recipients []struct {
			ContactID *string `json:"contact_id"`
			JID       string  `json:"jid"`
			Name      *string `json:"name"`
			Phone     *string `json:"phone"`
		} `json:"recipients"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	var recipients []*domain.CampaignRecipient
	for _, r := range req.Recipients {
		rec := &domain.CampaignRecipient{
			CampaignID: campaignID,
			JID:        r.JID,
			Name:       r.Name,
			Phone:      r.Phone,
		}
		if r.ContactID != nil {
			if cid, err := uuid.Parse(*r.ContactID); err == nil {
				rec.ContactID = &cid
			}
		}
		recipients = append(recipients, rec)
	}
	if err := s.services.Campaign.AddRecipients(c.Context(), recipients); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "count": len(recipients)})
}

func (s *Server) handleGetCampaignRecipients(c *fiber.Ctx) error {
	campaignID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	recipients, err := s.services.Campaign.GetRecipients(c.Context(), campaignID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if recipients == nil {
		recipients = make([]*domain.CampaignRecipient, 0)
	}
	return c.JSON(fiber.Map{"success": true, "recipients": recipients})
}

func (s *Server) handleStartCampaign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	if err := s.services.Campaign.Start(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "message": "Campaign started"})
}

func (s *Server) handlePauseCampaign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	if err := s.services.Campaign.Pause(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "message": "Campaign paused"})
}

func (s *Server) handleDuplicateCampaign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	var req struct {
		MessageTemplate *string `json:"message_template"`
	}
	c.BodyParser(&req)
	newCampaign, err := s.services.Campaign.Duplicate(c.Context(), id, req.MessageTemplate)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "campaign": newCampaign})
}

// --- Event Handlers ---

func (s *Server) handleGetEvents(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	filter := domain.EventFilter{
		Search: c.Query("search"),
		Status: c.Query("status"),
		Limit:  c.QueryInt("limit", 50),
		Offset: c.QueryInt("offset", 0),
	}
	events, total, err := s.services.Event.GetByAccountID(c.Context(), accountID, filter)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if events == nil {
		events = make([]*domain.Event, 0)
	}
	return c.JSON(fiber.Map{"success": true, "events": events, "total": total})
}

func (s *Server) handleCreateEvent(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	var req struct {
		Name        string     `json:"name"`
		Description *string    `json:"description"`
		EventDate   *time.Time `json:"event_date"`
		EventEnd    *time.Time `json:"event_end"`
		Location    *string    `json:"location"`
		Color       string     `json:"color"`
		Status      string     `json:"status"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	event := &domain.Event{
		AccountID:   accountID,
		Name:        req.Name,
		Description: req.Description,
		EventDate:   req.EventDate,
		EventEnd:    req.EventEnd,
		Location:    req.Location,
		Color:       req.Color,
		Status:      req.Status,
		CreatedBy:   &userID,
	}
	if err := s.services.Event.Create(c.Context(), event); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "event": event})
}

func (s *Server) handleGetEvent(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	event, err := s.services.Event.GetByID(c.Context(), id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if event == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Event not found"})
	}
	return c.JSON(fiber.Map{"success": true, "event": event})
}

func (s *Server) handleUpdateEvent(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	event, err := s.services.Event.GetByID(c.Context(), id)
	if err != nil || event == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Event not found"})
	}
	var req struct {
		Name        *string    `json:"name"`
		Description *string    `json:"description"`
		EventDate   *time.Time `json:"event_date"`
		EventEnd    *time.Time `json:"event_end"`
		Location    *string    `json:"location"`
		Color       *string    `json:"color"`
		Status      *string    `json:"status"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name != nil {
		event.Name = *req.Name
	}
	if req.Description != nil {
		event.Description = req.Description
	}
	if req.EventDate != nil {
		event.EventDate = req.EventDate
	}
	if req.EventEnd != nil {
		event.EventEnd = req.EventEnd
	}
	if req.Location != nil {
		event.Location = req.Location
	}
	if req.Color != nil {
		event.Color = *req.Color
	}
	if req.Status != nil {
		event.Status = *req.Status
	}
	if err := s.services.Event.Update(c.Context(), event); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "event": event})
}

func (s *Server) handleDeleteEvent(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	if err := s.services.Event.Delete(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleGetEventParticipants(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	search := c.Query("search")
	status := c.Query("status")

	// Parse tag IDs filter
	var tagIDs []uuid.UUID
	if tagsParam := c.Query("tags"); tagsParam != "" {
		for _, tidStr := range strings.Split(tagsParam, ",") {
			tid, err := uuid.Parse(strings.TrimSpace(tidStr))
			if err == nil {
				tagIDs = append(tagIDs, tid)
			}
		}
	}

	// Parse has_phone filter
	var hasPhone *bool
	if hp := c.Query("has_phone"); hp == "true" {
		t := true
		hasPhone = &t
	}

	participants, err := s.services.Event.GetParticipants(c.Context(), eventID, search, status, tagIDs, hasPhone)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if participants == nil {
		participants = make([]*domain.EventParticipant, 0)
	}
	return c.JSON(fiber.Map{"success": true, "participants": participants})
}

func (s *Server) handleAddEventParticipant(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	var req struct {
		ContactID *string `json:"contact_id"`
		Name      string  `json:"name"`
		LastName  *string `json:"last_name"`
		ShortName *string `json:"short_name"`
		Phone     *string `json:"phone"`
		Email     *string `json:"email"`
		Age       *int    `json:"age"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	p := &domain.EventParticipant{
		EventID:   eventID,
		Name:      req.Name,
		LastName:  req.LastName,
		ShortName: req.ShortName,
		Phone:     req.Phone,
		Email:     req.Email,
		Age:       req.Age,
	}
	if req.ContactID != nil {
		if cid, err := uuid.Parse(*req.ContactID); err == nil {
			p.ContactID = &cid
		}
	}
	if err := s.services.Event.AddParticipant(c.Context(), p); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "idx_event_participants_unique_phone") {
			return c.Status(409).JSON(fiber.Map{"success": false, "error": "Ya existe un participante con ese teléfono en este evento"})
		}
		if strings.Contains(errMsg, "idx_event_participants_unique_email") {
			return c.Status(409).JSON(fiber.Map{"success": false, "error": "Ya existe un participante con ese email en este evento"})
		}
		if strings.Contains(errMsg, "idx_event_participants_unique_contact") {
			return c.Status(409).JSON(fiber.Map{"success": false, "error": "Este contacto ya está registrado en este evento"})
		}
		return c.Status(500).JSON(fiber.Map{"success": false, "error": errMsg})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "participant": p})
}

func (s *Server) handleBulkAddEventParticipants(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	var req struct {
		Participants []struct {
			ContactID *string `json:"contact_id"`
			Name      string  `json:"name"`
			LastName  *string `json:"last_name"`
			ShortName *string `json:"short_name"`
			Phone     *string `json:"phone"`
			Email     *string `json:"email"`
			Age       *int    `json:"age"`
		} `json:"participants"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	var participants []*domain.EventParticipant
	for _, r := range req.Participants {
		p := &domain.EventParticipant{
			Name:      r.Name,
			LastName:  r.LastName,
			ShortName: r.ShortName,
			Phone:     r.Phone,
			Email:     r.Email,
			Age:       r.Age,
		}
		if r.ContactID != nil {
			if cid, err := uuid.Parse(*r.ContactID); err == nil {
				p.ContactID = &cid
			}
		}
		participants = append(participants, p)
	}
	if err := s.services.Event.BulkAddParticipants(c.Context(), eventID, participants); err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "idx_event_participants_unique") {
			return c.Status(409).JSON(fiber.Map{"success": false, "error": "Uno o más participantes ya están registrados en este evento"})
		}
		return c.Status(500).JSON(fiber.Map{"success": false, "error": errMsg})
	}
	return c.JSON(fiber.Map{"success": true, "count": len(participants)})
}

func (s *Server) handleUpdateEventParticipant(c *fiber.Ctx) error {
	pid, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid participant ID"})
	}
	p, err := s.services.Event.GetParticipant(c.Context(), pid)
	if err != nil || p == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Participant not found"})
	}
	var req struct {
		Name           *string    `json:"name"`
		LastName       *string    `json:"last_name"`
		ShortName      *string    `json:"short_name"`
		Phone          *string    `json:"phone"`
		Email          *string    `json:"email"`
		Age            *int       `json:"age"`
		Notes          *string    `json:"notes"`
		NextAction     *string    `json:"next_action"`
		NextActionDate *time.Time `json:"next_action_date"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name != nil {
		p.Name = *req.Name
	}
	if req.LastName != nil {
		p.LastName = req.LastName
	}
	if req.ShortName != nil {
		p.ShortName = req.ShortName
	}
	if req.Phone != nil {
		p.Phone = req.Phone
	}
	if req.Email != nil {
		p.Email = req.Email
	}
	if req.Age != nil {
		p.Age = req.Age
	}
	if req.Notes != nil {
		p.Notes = req.Notes
	}
	if req.NextAction != nil {
		p.NextAction = req.NextAction
	}
	if req.NextActionDate != nil {
		p.NextActionDate = req.NextActionDate
	}
	if err := s.services.Event.UpdateParticipant(c.Context(), p); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Sync shared fields back to the linked contact
	if p.ContactID != nil {
		_ = s.services.Event.SyncParticipantToContact(c.Context(), p)
	}

	return c.JSON(fiber.Map{"success": true, "participant": p})
}

func (s *Server) handleUpdateEventParticipantStatus(c *fiber.Ctx) error {
	pid, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid participant ID"})
	}
	var req struct {
		Status string `json:"status"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if err := s.services.Event.UpdateParticipantStatus(c.Context(), pid, req.Status); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleDeleteEventParticipant(c *fiber.Ctx) error {
	pid, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid participant ID"})
	}
	if err := s.services.Event.DeleteParticipant(c.Context(), pid); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleCreateCampaignFromEvent(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}

	var req struct {
		Name            string                 `json:"name"`
		DeviceID        string                 `json:"device_id"`
		MessageTemplate string                 `json:"message_template"`
		MediaURL        *string                `json:"media_url"`
		MediaType       *string                `json:"media_type"`
		ScheduledAt     *time.Time             `json:"scheduled_at"`
		Settings        map[string]interface{} `json:"settings"`
		// Filters to select participants
		Status   string   `json:"status"`
		TagIDs   []string `json:"tag_ids"`
		HasPhone *bool    `json:"has_phone"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" || req.DeviceID == "" || req.MessageTemplate == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "name, device_id and message_template are required"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	// Parse tag IDs
	var tagIDs []uuid.UUID
	for _, tidStr := range req.TagIDs {
		tid, err := uuid.Parse(tidStr)
		if err == nil {
			tagIDs = append(tagIDs, tid)
		}
	}

	// Get filtered participants (always require phone)
	hasPhone := true
	participants, err := s.services.Event.GetParticipants(c.Context(), eventID, "", req.Status, tagIDs, &hasPhone)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	if len(participants) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No hay participantes con teléfono que coincidan con los filtros"})
	}

	// Create campaign
	source := "event"
	campaign := &domain.Campaign{
		AccountID:       accountID,
		DeviceID:        deviceID,
		Name:            req.Name,
		MessageTemplate: req.MessageTemplate,
		MediaURL:        req.MediaURL,
		MediaType:       req.MediaType,
		ScheduledAt:     req.ScheduledAt,
		Settings:        req.Settings,
		EventID:         &eventID,
		Source:          &source,
	}
	if err := s.services.Campaign.Create(c.Context(), campaign); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Add participants as recipients
	var recipients []*domain.CampaignRecipient
	for _, p := range participants {
		if p.Phone == nil || *p.Phone == "" {
			continue
		}
		phone := strings.TrimPrefix(*p.Phone, "+")
		jid := phone + "@s.whatsapp.net"
		fullName := p.Name
		if p.LastName != nil && *p.LastName != "" {
			fullName += " " + *p.LastName
		}
		recipients = append(recipients, &domain.CampaignRecipient{
			CampaignID: campaign.ID,
			JID:        jid,
			Name:       &fullName,
			Phone:      p.Phone,
		})
	}

	if len(recipients) > 0 {
		if err := s.services.Campaign.AddRecipients(c.Context(), recipients); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
	}

	return c.Status(201).JSON(fiber.Map{
		"success":          true,
		"campaign":         campaign,
		"recipients_count": len(recipients),
	})
}

func (s *Server) handleGetUpcomingActions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	limit := c.QueryInt("limit", 20)
	actions, err := s.services.Event.GetUpcomingActions(c.Context(), accountID, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if actions == nil {
		actions = make([]*domain.EventParticipant, 0)
	}
	return c.JSON(fiber.Map{"success": true, "actions": actions})
}

// --- Interaction Handlers ---

func (s *Server) handleLogInteraction(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	var req struct {
		ContactID      *string    `json:"contact_id"`
		LeadID         *string    `json:"lead_id"`
		EventID        *string    `json:"event_id"`
		ParticipantID  *string    `json:"participant_id"`
		Type           string     `json:"type"`
		Direction      *string    `json:"direction"`
		Outcome        *string    `json:"outcome"`
		Notes          *string    `json:"notes"`
		NextAction     *string    `json:"next_action"`
		NextActionDate *time.Time `json:"next_action_date"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Type == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Type is required"})
	}
	interaction := &domain.Interaction{
		AccountID:      accountID,
		Type:           req.Type,
		Direction:      req.Direction,
		Outcome:        req.Outcome,
		Notes:          req.Notes,
		NextAction:     req.NextAction,
		NextActionDate: req.NextActionDate,
		CreatedBy:      &userID,
	}
	if req.ContactID != nil {
		if cid, err := uuid.Parse(*req.ContactID); err == nil {
			interaction.ContactID = &cid
		}
	}
	if req.LeadID != nil {
		if lid, err := uuid.Parse(*req.LeadID); err == nil {
			interaction.LeadID = &lid
		}
	}
	if req.EventID != nil {
		if eid, err := uuid.Parse(*req.EventID); err == nil {
			interaction.EventID = &eid
		}
	}
	if req.ParticipantID != nil {
		if pid, err := uuid.Parse(*req.ParticipantID); err == nil {
			interaction.ParticipantID = &pid
		}
	}
	if err := s.services.Interaction.LogInteraction(c.Context(), interaction); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "interaction": interaction})
}

func (s *Server) handleGetInteractions(c *fiber.Ctx) error {
	limit := c.QueryInt("limit", 50)
	offset := c.QueryInt("offset", 0)

	if participantID := c.Query("participant_id"); participantID != "" {
		if pid, err := uuid.Parse(participantID); err == nil {
			interactions, err := s.services.Interaction.GetByParticipantID(c.Context(), pid)
			if err != nil {
				return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
			}
			if interactions == nil {
				interactions = make([]*domain.Interaction, 0)
			}
			return c.JSON(fiber.Map{"success": true, "interactions": interactions})
		}
	}
	if eventID := c.Query("event_id"); eventID != "" {
		if eid, err := uuid.Parse(eventID); err == nil {
			interactions, err := s.services.Interaction.GetByEventID(c.Context(), eid, limit, offset)
			if err != nil {
				return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
			}
			if interactions == nil {
				interactions = make([]*domain.Interaction, 0)
			}
			return c.JSON(fiber.Map{"success": true, "interactions": interactions})
		}
	}
	if contactID := c.Query("contact_id"); contactID != "" {
		if cid, err := uuid.Parse(contactID); err == nil {
			interactions, err := s.services.Interaction.GetByContactID(c.Context(), cid, limit, offset)
			if err != nil {
				return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
			}
			if interactions == nil {
				interactions = make([]*domain.Interaction, 0)
			}
			return c.JSON(fiber.Map{"success": true, "interactions": interactions})
		}
	}
	if leadID := c.Query("lead_id"); leadID != "" {
		if lid, err := uuid.Parse(leadID); err == nil {
			interactions, err := s.services.Interaction.GetByLeadID(c.Context(), lid, limit, offset)
			if err != nil {
				return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
			}
			if interactions == nil {
				interactions = make([]*domain.Interaction, 0)
			}
			return c.JSON(fiber.Map{"success": true, "interactions": interactions})
		}
	}
	return c.Status(400).JSON(fiber.Map{"success": false, "error": "Provide participant_id, event_id, contact_id, or lead_id query parameter"})
}

func (s *Server) handleDeleteInteraction(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid interaction ID"})
	}
	if err := s.services.Interaction.Delete(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleGetContactInteractions(c *fiber.Ctx) error {
	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid contact ID"})
	}
	limit := c.QueryInt("limit", 50)
	offset := c.QueryInt("offset", 0)
	interactions, err := s.services.Interaction.GetByContactID(c.Context(), contactID, limit, offset)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if interactions == nil {
		interactions = make([]*domain.Interaction, 0)
	}
	return c.JSON(fiber.Map{"success": true, "interactions": interactions})
}

func (s *Server) handleGetLeadInteractions(c *fiber.Ctx) error {
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid lead ID"})
	}
	limit := c.QueryInt("limit", 50)
	offset := c.QueryInt("offset", 0)
	interactions, err := s.services.Interaction.GetByLeadID(c.Context(), leadID, limit, offset)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if interactions == nil {
		interactions = make([]*domain.Interaction, 0)
	}
	return c.JSON(fiber.Map{"success": true, "interactions": interactions})
}

func (s *Server) handleGetContactEvents(c *fiber.Ctx) error {
	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid contact ID"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	events, err := s.services.Event.GetByContactID(c.Context(), accountID, contactID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if events == nil {
		events = make([]*domain.Event, 0)
	}
	return c.JSON(fiber.Map{"success": true, "events": events})
}

// --- Stats Handler ---

func (s *Server) handleGetStats(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"success": true,
		"stats": fiber.Map{
			"connected_devices": s.pool.GetConnectedCount(),
			"ws_clients":        s.hub.GetClientCount(),
		},
	})
}

// --- WebSocket Handler ---

func (s *Server) handleWebSocket(c *websocket.Conn) {
	claims := c.Locals("claims").(*service.JWTClaims)

	client := &ws.Client{
		ID:        uuid.New().String(),
		AccountID: claims.AccountID,
		UserID:    claims.UserID,
		Conn:      c,
		Send:      make(chan []byte, 256),
		Hub:       s.hub,
	}

	s.hub.Register(client)

	go client.WritePump()
	client.ReadPump()
}

func (s *Server) Listen(addr string) error {
	return s.app.Listen(addr)
}

func (s *Server) Shutdown() error {
	return s.app.Shutdown()
}

func (s *Server) handleGetRecentStickers(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	urls, err := s.services.Chat.GetRecentStickers(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	if urls == nil {
		urls = []string{}
	}

	return c.JSON(fiber.Map{"success": true, "stickers": urls})
}

func (s *Server) handleGetSavedStickers(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	urls, err := s.services.Chat.GetSavedStickers(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if urls == nil {
		urls = []string{}
	}
	return c.JSON(fiber.Map{"success": true, "stickers": urls})
}

func (s *Server) handleSaveSticker(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		MediaURL string `json:"media_url"`
	}
	if err := c.BodyParser(&req); err != nil || req.MediaURL == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "media_url is required"})
	}

	if err := s.services.Chat.SaveSticker(c.Context(), accountID, req.MediaURL); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleDeleteSavedSticker(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		MediaURL string `json:"media_url"`
	}
	if err := c.BodyParser(&req); err != nil || req.MediaURL == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "media_url is required"})
	}

	if err := s.services.Chat.DeleteSavedSticker(c.Context(), accountID, req.MediaURL); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

// --- Super Admin Handlers ---

func (s *Server) handleAdminGetAccounts(c *fiber.Ctx) error {
	accounts, err := s.services.Account.GetAll(c.Context())
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if accounts == nil {
		accounts = []*domain.Account{}
	}
	return c.JSON(fiber.Map{"success": true, "accounts": accounts})
}

func (s *Server) handleAdminCreateAccount(c *fiber.Ctx) error {
	var req struct {
		Name       string `json:"name"`
		Slug       string `json:"slug"`
		Plan       string `json:"plan"`
		MaxDevices int    `json:"max_devices"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	if req.Plan == "" {
		req.Plan = "basic"
	}
	if req.MaxDevices <= 0 {
		req.MaxDevices = 5
	}

	account := &domain.Account{
		Name:       req.Name,
		Slug:       req.Slug,
		Plan:       req.Plan,
		MaxDevices: req.MaxDevices,
		IsActive:   true,
	}

	if err := s.services.Account.Create(c.Context(), account); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.Status(201).JSON(fiber.Map{"success": true, "account": account})
}

func (s *Server) handleAdminGetAccount(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}

	account, err := s.services.Account.GetByID(c.Context(), id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if account == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Account not found"})
	}

	return c.JSON(fiber.Map{"success": true, "account": account})
}

func (s *Server) handleAdminUpdateAccount(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}

	var req struct {
		Name       string `json:"name"`
		Slug       string `json:"slug"`
		Plan       string `json:"plan"`
		MaxDevices int    `json:"max_devices"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	account := &domain.Account{
		ID:         id,
		Name:       req.Name,
		Slug:       req.Slug,
		Plan:       req.Plan,
		MaxDevices: req.MaxDevices,
	}

	if err := s.services.Account.Update(c.Context(), account); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "account": account})
}

func (s *Server) handleAdminToggleAccount(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}

	if err := s.services.Account.ToggleActive(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleAdminDeleteAccount(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}

	// Safety: prevent deleting account that has devices, chats, or contacts
	account, err := s.services.Account.GetByID(c.Context(), id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if account == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Account not found"})
	}
	if account.DeviceCount > 0 || account.ChatCount > 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No se puede eliminar una cuenta que tiene dispositivos o chats. Elimine primero los dispositivos."})
	}
	if account.UserCount > 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No se puede eliminar una cuenta que tiene usuarios. Elimine primero los usuarios."})
	}

	if err := s.services.Account.Delete(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleAdminGetUsers(c *fiber.Ctx) error {
	var accountID *uuid.UUID
	if aid := c.Query("account_id"); aid != "" {
		parsed, err := uuid.Parse(aid)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid account_id"})
		}
		accountID = &parsed
	}

	users, err := s.services.Account.GetUsers(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if users == nil {
		users = []*domain.User{}
	}

	return c.JSON(fiber.Map{"success": true, "users": users})
}

func (s *Server) handleAdminCreateUser(c *fiber.Ctx) error {
	var req struct {
		AccountID   string `json:"account_id"`
		Username    string `json:"username"`
		Email       string `json:"email"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
		Role        string `json:"role"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if req.Username == "" || req.Email == "" || req.Password == "" || req.AccountID == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "username, email, password, and account_id are required"})
	}

	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid account_id"})
	}

	if req.Role == "" {
		req.Role = domain.RoleAgent
	}

	user := &domain.User{
		AccountID:   accountID,
		Username:    req.Username,
		Email:       req.Email,
		DisplayName: req.DisplayName,
		Role:        req.Role,
		IsAdmin:     req.Role == domain.RoleAdmin || req.Role == domain.RoleSuperAdmin,
	}

	if err := s.services.Account.CreateUser(c.Context(), user, req.Password); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.Status(201).JSON(fiber.Map{"success": true, "user": fiber.Map{
		"id":           user.ID,
		"account_id":   user.AccountID,
		"username":     user.Username,
		"email":        user.Email,
		"display_name": user.DisplayName,
		"role":         user.Role,
		"is_admin":     user.IsAdmin,
		"is_active":    user.IsActive,
		"created_at":   user.CreatedAt,
	}})
}

func (s *Server) handleAdminUpdateUser(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}

	var req struct {
		Username    string `json:"username"`
		Email       string `json:"email"`
		DisplayName string `json:"display_name"`
		Role        string `json:"role"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	user := &domain.User{
		ID:          id,
		Username:    req.Username,
		Email:       req.Email,
		DisplayName: req.DisplayName,
		Role:        req.Role,
		IsAdmin:     req.Role == domain.RoleAdmin || req.Role == domain.RoleSuperAdmin,
	}

	if err := s.services.Account.UpdateUser(c.Context(), user); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleAdminToggleUser(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}

	if err := s.services.Account.ToggleUserActive(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleAdminResetPassword(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}

	var req struct {
		Password string `json:"password"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Password == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Password is required"})
	}

	if err := s.services.Account.ResetPassword(c.Context(), id, req.Password); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleAdminDeleteUser(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}

	// Safety: cannot delete yourself
	claims := c.Locals("claims").(*service.JWTClaims)
	if claims.UserID == id {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No puedes eliminar tu propia cuenta de usuario"})
	}

	// Safety: cannot delete a super admin
	user, err := s.services.Auth.GetUser(c.Context(), id)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if user != nil && user.IsSuperAdmin {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No se puede eliminar un super administrador"})
	}

	if err := s.services.Account.DeleteUser(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

// --- Switch Account Handler ---

func (s *Server) handleSwitchAccount(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		AccountID string `json:"account_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	targetAccountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid account_id"})
	}

	token, user, err := s.services.Auth.SwitchAccount(c.Context(), userID, targetAccountID, s.cfg.JWTSecret)
	if err != nil {
		return c.Status(403).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Set cookie
	c.Cookie(&fiber.Cookie{
		Name:     "auth-token",
		Value:    token,
		Expires:  time.Now().Add(24 * 7 * time.Hour),
		HTTPOnly: true,
		Secure:   s.cfg.IsProduction(),
		SameSite: "Lax",
	})

	return c.JSON(fiber.Map{
		"success": true,
		"token":   token,
		"user": fiber.Map{
			"id":             user.ID,
			"username":       user.Username,
			"email":          user.Email,
			"display_name":   user.DisplayName,
			"is_admin":       user.IsAdmin,
			"is_super_admin": user.IsSuperAdmin,
			"role":           user.Role,
			"account_id":     user.AccountID,
			"account_name":   user.AccountName,
		},
	})
}

func (s *Server) handleGetMyAccounts(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)

	userAccounts, err := s.services.Auth.GetUserAccounts(c.Context(), userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	accountsList := make([]fiber.Map, 0)
	for _, ua := range userAccounts {
		accountsList = append(accountsList, fiber.Map{
			"account_id":   ua.AccountID,
			"account_name": ua.AccountName,
			"account_slug": ua.AccountSlug,
			"role":         ua.Role,
			"is_default":   ua.IsDefault,
		})
	}

	return c.JSON(fiber.Map{"success": true, "accounts": accountsList})
}

// --- Admin User-Account Assignment Handlers ---

func (s *Server) handleAdminGetUserAccounts(c *fiber.Ctx) error {
	userID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid user ID"})
	}

	userAccounts, err := s.services.Auth.GetUserAccounts(c.Context(), userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	accountsList := make([]fiber.Map, 0)
	for _, ua := range userAccounts {
		accountsList = append(accountsList, fiber.Map{
			"id":           ua.ID,
			"account_id":   ua.AccountID,
			"account_name": ua.AccountName,
			"role":         ua.Role,
			"is_default":   ua.IsDefault,
		})
	}

	return c.JSON(fiber.Map{"success": true, "accounts": accountsList})
}

func (s *Server) handleAdminAssignUserAccount(c *fiber.Ctx) error {
	userID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid user ID"})
	}

	var req struct {
		AccountID string `json:"account_id"`
		Role      string `json:"role"`
		IsDefault bool   `json:"is_default"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid account_id"})
	}

	if req.Role == "" {
		req.Role = domain.RoleAgent
	}

	ua := &domain.UserAccount{
		UserID:    userID,
		AccountID: accountID,
		Role:      req.Role,
		IsDefault: req.IsDefault,
	}

	if err := s.services.Account.AssignUserAccount(c.Context(), ua); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleAdminRemoveUserAccount(c *fiber.Ctx) error {
	userID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid user ID"})
	}

	accountID, err := uuid.Parse(c.Params("account_id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid account_id"})
	}

	if err := s.services.Account.RemoveUserAccount(c.Context(), userID, accountID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}
