package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/compress"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/helmet"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/gofiber/fiber/v2/middleware/logger"
	fiberRecover "github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/formula"
	"golang.org/x/crypto/bcrypt"
	"github.com/naperu/clarin/internal/kommo"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/internal/whatsapp"
	"github.com/naperu/clarin/internal/ws"
	"github.com/naperu/clarin/pkg/cache"
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
	repos    *repository.Repositories
	hub      *ws.Hub
	pool     *whatsapp.DevicePool
	storage  *storage.Storage
	kommoSync *kommo.SyncService
	cache    *cache.Cache
}

func NewServer(cfg *config.Config, services *service.Services, repos *repository.Repositories, hub *ws.Hub, pool *whatsapp.DevicePool, store *storage.Storage, kommoSyncSvc *kommo.SyncService, c *cache.Cache) *Server {
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
	app.Use(fiberRecover.New())
	app.Use(compress.New(compress.Config{
		Level: compress.LevelBestSpeed,
	}))
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
		repos:    repos,
		hub:      hub,
		pool:     pool,
		storage:  store,
		kommoSync: kommoSyncSvc,
		cache:    c,
	}

	server.setupRoutes()
	return server
}

func (s *Server) setupRoutes() {
	// Health check — deep health probe checking all dependencies
	s.app.Get("/health", s.handleHealthCheck)

	// API routes
	api := s.app.Group("/api")

	// Device health endpoint (protected) — detailed per-device metrics
	// Registered after auth middleware setup below

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

	// Settings routes
	protected.Get("/settings", s.handleGetSettings)
	protected.Put("/settings/profile", s.handleUpdateProfile)
	protected.Put("/settings/account", s.handleUpdateAccount)
	protected.Put("/settings/password", s.handleChangePassword)
	protected.Put("/settings/incoming-stage", s.handleSetIncomingStage)

	// API Key management routes
	protected.Post("/settings/api-keys", s.handleCreateAPIKey)
	protected.Get("/settings/api-keys", s.handleListAPIKeys)
	protected.Delete("/settings/api-keys/:id", s.handleDeleteAPIKey)

	// Device routes
	// GET /devices — list available devices for sending; accessible by any authenticated user
	// (needed by chats, contacts, leads, broadcasts, events, programs pages to populate device pickers)
	protected.Get("/devices", s.handleGetDevices)
	// Device management — requires PermDevices (add, edit, delete, connect, disconnect)
	devices := protected.Group("/devices", s.requirePermission(domain.PermDevices))
	devices.Post("/", s.handleCreateDevice)
	devices.Get("/:id", s.handleGetDevice)
	devices.Put("/:id", s.handleUpdateDevice)
	devices.Post("/:id/connect", s.handleConnectDevice)
	devices.Post("/:id/disconnect", s.handleDisconnectDevice)
	devices.Post("/:id/reset", s.handleResetDevice)
	devices.Delete("/:id", s.handleDeleteDevice)
	devices.Get("/health/all", s.handleDeviceHealth)

	// Chat routes
	chats := protected.Group("/chats", s.requirePermission(domain.PermChats))
	chats.Get("/", s.handleGetChats)
	chats.Get("/find-by-phone/:phone", s.handleFindChatByPhone)
	chats.Post("/new", s.handleCreateNewChat)
	chats.Delete("/batch", s.handleDeleteChatsBatch)
	chats.Get("/:id", s.handleGetChatDetails)
	chats.Get("/:id/messages", s.handleGetMessages)
	chats.Post("/:id/read", s.handleMarkAsRead)
	chats.Post("/:id/sync-history", s.handleRequestHistorySync)
	chats.Delete("/:id", s.handleDeleteChat)

	// Message routes
	messages := protected.Group("/messages", s.requirePermission(domain.PermChats))
	messages.Post("/send", s.handleSendMessage)
	messages.Post("/send-contact", s.handleSendContact)
	messages.Post("/forward", s.handleForwardMessage)
	messages.Post("/react", s.handleSendReaction)
	messages.Post("/poll", s.handleSendPoll)
	messages.Post("/typing", s.handleSendTyping)
	messages.Post("/read-receipt", s.handleSendReadReceipt)
	messages.Post("/delete", s.handleDeleteMessage)
	messages.Post("/edit", s.handleEditMessage)

	// WhatsApp utilities
	protected.Post("/contacts/check-whatsapp", s.requirePermission(domain.PermChats), s.handleCheckWhatsApp)

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
	leads := protected.Group("/leads", s.requirePermission(domain.PermLeads))
	leads.Get("/", s.handleGetLeads)
	leads.Get("/paginated", s.handleGetLeadsPaginated)
	leads.Get("/list-paginated", s.handleGetLeadsListPaginated)
	leads.Get("/by-stage/:stageId", s.handleGetLeadsByStage)
	leads.Post("/", s.handleCreateLead)
	leads.Delete("/batch", s.handleDeleteLeadsBatch)
	leads.Post("/observations/batch", s.handleBatchLeadObservations)
	leads.Get("/:id", s.handleGetLead)
	leads.Put("/:id", s.handleUpdateLead)
	leads.Delete("/:id", s.handleDeleteLead)
	leads.Patch("/:id/status", s.handleUpdateLeadStatus)
	leads.Patch("/:id/stage", s.handleUpdateLeadStage)
	leads.Get("/:id/interactions", s.handleGetLeadInteractions)
	leads.Post("/:id/sync-kommo", s.handleSyncLeadFromKommo)

	// Pipeline routes
	pipelines := protected.Group("/pipelines", s.requirePermission(domain.PermLeads))
	pipelines.Get("/", s.handleGetPipelines)
	pipelines.Post("/", s.handleCreatePipeline)
	pipelines.Put("/:id", s.handleUpdatePipeline)
	pipelines.Delete("/:id", s.handleDeletePipeline)
	pipelines.Post("/:id/stages", s.handleCreatePipelineStage)
	pipelines.Put("/:id/stages/reorder", s.handleReorderPipelineStages)
	pipelines.Put("/:id/stages/:stageId", s.handleUpdatePipelineStage)
	pipelines.Delete("/:id/stages/:stageId", s.handleDeletePipelineStage)

	// Tag routes
	tags := protected.Group("/tags", s.requirePermission(domain.PermTags))
	tags.Get("/", s.handleGetTags)
	tags.Post("/", s.handleCreateTag)
	tags.Put("/:id", s.handleUpdateTag)
	tags.Delete("/batch", s.handleDeleteTagsBatch)
	tags.Delete("/:id", s.handleDeleteTag)
	tags.Post("/assign", s.handleAssignTag)
	tags.Post("/remove", s.handleRemoveTag)
	tags.Get("/entity/:type/:id", s.handleGetEntityTags)

	// Campaign routes
	campaigns := protected.Group("/campaigns", s.requirePermission(domain.PermBroadcasts))
	campaigns.Get("/", s.handleGetCampaigns)
	campaigns.Post("/", s.handleCreateCampaign)
	campaigns.Get("/:id", s.handleGetCampaign)

	// Program routes
	programs := protected.Group("/programs", s.requirePermission(domain.PermPrograms))
	programs.Get("/", s.handleListPrograms)
	programs.Post("/", s.handleCreateProgram)
	programs.Get("/:id", s.handleGetProgram)
	programs.Put("/:id", s.handleUpdateProgram)
	programs.Delete("/:id", s.handleDeleteProgram)

	programs.Get("/:id/participants", s.handleListParticipants)
	programs.Post("/:id/participants", s.handleAddParticipant)
	programs.Delete("/:id/participants/:participantId", s.handleRemoveParticipant)

	programs.Get("/:id/sessions", s.handleListSessions)
	programs.Post("/:id/sessions", s.handleCreateSession)
	programs.Put("/:id/sessions/:sessionId", s.handleUpdateSession)
	programs.Delete("/:id/sessions/:sessionId", s.handleDeleteSession)

	programs.Get("/:id/sessions/:sessionId/attendance", s.handleGetAttendance)
	programs.Post("/:id/sessions/:sessionId/attendance", s.handleMarkAttendance)
	programs.Get("/:id/sessions/:sessionId/attendance/filter", s.handleGetParticipantsByAttendanceStatus)
	programs.Post("/:id/sessions/generate", s.handleGenerateSessions)
	programs.Post("/:id/campaign", s.handleCreateCampaignFromProgram)
	campaigns.Put("/:id", s.handleUpdateCampaign)
	campaigns.Delete("/:id", s.handleDeleteCampaign)
	campaigns.Post("/batch-delete", s.handleBatchDeleteCampaigns)
	campaigns.Post("/:id/recipients", s.handleAddCampaignRecipients)
	campaigns.Post("/:id/recipients/from-leads", s.handleAddCampaignRecipientsFromLeads)
	campaigns.Get("/:id/recipients", s.handleGetCampaignRecipients)
	campaigns.Delete("/:id/recipients/:rid", s.handleDeleteCampaignRecipient)
	campaigns.Put("/:id/recipients/:rid", s.handleUpdateCampaignRecipient)
	campaigns.Post("/:id/start", s.handleStartCampaign)
	campaigns.Post("/:id/pause", s.handlePauseCampaign)
	campaigns.Post("/:id/cancel", s.handleCancelCampaign)
	campaigns.Post("/:id/duplicate", s.handleDuplicateCampaign)
	campaigns.Post("/:id/recipients/:rid/retry", s.handleRetryCampaignRecipient)
	campaigns.Put("/:id/attachments", s.handleUpdateCampaignAttachments)

	// Import CSV route
	protected.Post("/import/csv", s.handleImportCSV)

	// Contact routes
	contacts := protected.Group("/contacts", s.requirePermission(domain.PermContacts))
	contacts.Get("/", s.handleGetContacts)
	contacts.Post("/", s.handleCreateContact)
	contacts.Post("/bulk", s.handleCreateContactsBulk)
	contacts.Get("/duplicates", s.handleGetContactDuplicates)
	contacts.Post("/merge", s.handleMergeContacts)
	contacts.Delete("/batch", s.handleDeleteContactsBatch)
	contacts.Get("/:id", s.handleGetContact)
	contacts.Put("/:id", s.handleUpdateContact)
	contacts.Post("/:id/reset", s.handleResetContactFromDevice)
	contacts.Post("/:id/sync-kommo", s.handleSyncContactFromKommo)
	contacts.Delete("/:id", s.handleDeleteContact)

	// Sync contacts route (under devices)
	devices.Post("/:id/sync-contacts", s.handleSyncDeviceContacts)

	// People unified search (contacts + leads)
	protected.Get("/people/search", s.handleSearchPeople)

	// Event routes
	events := protected.Group("/events", s.requirePermission(domain.PermEvents))
	events.Get("/", s.handleGetEvents)
	events.Post("/", s.handleCreateEvent)
	events.Post("/from-leads", s.handleCreateEventFromLeads)
	events.Get("/upcoming-actions", s.handleGetUpcomingActions)
	// Pipeline routes
	events.Get("/pipelines", s.handleGetEventPipelines)
	events.Post("/pipelines", s.handleCreateEventPipeline)
	events.Get("/pipelines/:pid", s.handleGetEventPipeline)
	events.Put("/pipelines/:pid", s.handleUpdateEventPipeline)
	events.Delete("/pipelines/:pid", s.handleDeleteEventPipeline)
	events.Put("/pipelines/:pid/stages", s.handleReplaceEventPipelineStages)
	// Folder routes — must be declared BEFORE /:id to avoid param collision
	events.Get("/folders", s.handleGetEventFolders)
	events.Post("/folders", s.handleCreateEventFolder)
	events.Put("/folders/:fid", s.handleUpdateEventFolder)
	events.Delete("/folders/:fid", s.handleDeleteEventFolder)
	events.Get("/:id", s.handleGetEvent)
	events.Put("/:id", s.handleUpdateEvent)
	events.Delete("/:id", s.handleDeleteEvent)
	events.Patch("/:id/move-folder", s.handleMoveEventToFolder)
	// Event tag auto-sync
	events.Get("/:id/tags", s.handleGetEventTags)
	events.Put("/:id/tags", s.handleSetEventTags)
	events.Post("/formula/validate", s.handleValidateFormula)
	events.Get("/:id/participants/paginated", s.handleGetEventParticipantsPaginated)
	events.Get("/:id/participants/by-stage/:stageId", s.handleGetEventParticipantsByStage)
	events.Post("/:id/participants/observations/batch", s.handleBatchParticipantObservations)
	events.Get("/:id/participants", s.handleGetEventParticipants)
	events.Post("/:id/participants", s.handleAddEventParticipant)
	events.Post("/:id/participants/bulk", s.handleBulkAddEventParticipants)
	events.Patch("/:id/participants/bulk-status", s.handleBulkUpdateEventParticipantStatus)
	events.Patch("/:id/participants/bulk-stage", s.handleBulkUpdateEventParticipantStage)
	events.Put("/:id/participants/:pid", s.handleUpdateEventParticipant)
	events.Patch("/:id/participants/:pid/status", s.handleUpdateEventParticipantStatus)
	events.Patch("/:id/participants/:pid/stage", s.handleUpdateEventParticipantStage)
	events.Delete("/:id/participants/:pid", s.handleDeleteEventParticipant)
	events.Post("/:id/participants/:pid/check-tag-impact", s.handleCheckTagImpact)
	events.Post("/:id/campaign", s.handleCreateCampaignFromEvent)

	// Event Logbook (Bitácora) routes
	events.Get("/:id/logbooks", s.handleGetEventLogbooks)
	events.Post("/:id/logbooks", s.handleCreateEventLogbook)
	events.Post("/:id/logbooks/auto-create", s.handleAutoCreateLogbooks)
	events.Get("/:id/logbooks/:lid", s.handleGetEventLogbook)
	events.Put("/:id/logbooks/:lid", s.handleUpdateEventLogbook)
	events.Delete("/:id/logbooks/:lid", s.handleDeleteEventLogbook)
	events.Post("/:id/logbooks/:lid/capture", s.handleCaptureLogbookSnapshot)
	events.Get("/:id/logbooks/:lid/preview", s.handleLogbookPreview)
	events.Put("/:id/logbooks/:lid/entries/:eid", s.handleUpdateLogbookEntry)

	// Interaction routes
	interactions := protected.Group("/interactions", s.requirePermission(domain.PermLeads))
	interactions.Post("/", s.handleLogInteraction)
	interactions.Get("/", s.handleGetInteractions)
	interactions.Delete("/:id", s.handleDeleteInteraction)

	// Contact interactions and events
	contacts.Get("/:id/interactions", s.handleGetContactInteractions)
	contacts.Get("/:id/events", s.handleGetContactEvents)

	// Quick replies (canned responses)
	quickReplies := protected.Group("/quick-replies", s.requirePermission(domain.PermChats))
	quickReplies.Get("/", s.handleGetQuickReplies)
	quickReplies.Post("/", s.handleCreateQuickReply)
	quickReplies.Put("/:id", s.handleUpdateQuickReply)
	quickReplies.Delete("/:id", s.handleDeleteQuickReply)

	// Kommo integration routes
	kommoGroup := protected.Group("/kommo", s.requirePermission(domain.PermIntegrations))
	kommoGroup.Get("/status", s.handleKommoStatus)
	kommoGroup.Post("/sync", s.handleKommoSync)
	kommoGroup.Get("/pipelines", s.handleKommoGetPipelines)
	kommoGroup.Get("/connected", s.handleKommoGetConnected)
	kommoGroup.Post("/pipelines/:kommoId/connect", s.handleKommoConnectPipeline)
	kommoGroup.Delete("/pipelines/:kommoId/connect", s.handleKommoDisconnectPipeline)
	kommoGroup.Get("/sync/status", s.handleKommoSyncStatus)
	kommoGroup.Get("/sync/full-status", s.handleKommoFullSyncStatus)

	// WebSocket route
	s.app.Use("/ws", s.wsUpgrade)
	s.app.Get("/ws", websocket.New(s.handleWebSocket))

	// Stats
	protected.Get("/stats", s.handleGetStats)

	// AI Assistant (Eros)
	protected.Get("/ai/config", s.handleGetAIConfig)
	protected.Put("/ai/config", s.handleSetAIConfig)
	protected.Post("/ai/config/validate", s.handleValidateAIConfig)
	protected.Post("/ai/chat", s.handleAIChat)
	protected.Get("/ai/conversations", s.handleListErosConversations)
	protected.Get("/ai/conversations/:id", s.handleGetErosConversation)
	protected.Delete("/ai/conversations/:id", s.handleDeleteErosConversation)

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

	// Role management
	adminRoles := admin.Group("/roles")
	adminRoles.Get("/", s.handleAdminGetRoles)
	adminRoles.Post("/", s.handleAdminCreateRole)
	adminRoles.Put("/:id", s.handleAdminUpdateRole)
	adminRoles.Delete("/:id", s.handleAdminDeleteRole)
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

// requirePermission returns a middleware that checks if the caller has the given module permission.
// Admins and super_admins bypass this check entirely.
func (s *Server) requirePermission(module string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		claims, ok := c.Locals("claims").(*service.JWTClaims)
		if !ok {
			return c.Status(401).JSON(fiber.Map{"success": false, "error": "Unauthorized"})
		}
		// Admins always have full access
		if claims.IsAdmin || claims.IsSuperAdmin {
			return c.Next()
		}
		// Check permissions slice
		for _, p := range claims.Permissions {
			if p == domain.PermAll || p == module {
				return c.Next()
			}
		}
		return c.Status(403).JSON(fiber.Map{
			"success": false,
			"error":   "No tienes permiso para acceder a este módulo",
		})
	}
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

	// Build permissions for response
	permissions := []string{domain.PermAll}
	if !user.IsAdmin && !user.IsSuperAdmin {
		for _, ua := range userAccounts {
			if ua.AccountID == user.AccountID {
				if ua.Permissions != nil {
					permissions = ua.Permissions
				} else {
					permissions = []string{}
				}
				break
			}
		}
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
			"permissions":    permissions,
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

	// Extract permissions from JWT claims (already computed and embedded)
	claims := c.Locals("claims").(*service.JWTClaims)

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
			"permissions":    claims.Permissions,
		},
		"accounts": accountsList,
	})
}

// --- Settings Handlers ---

func (s *Server) handleGetSettings(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)
	accountID := c.Locals("account_id").(uuid.UUID)

	user, err := s.services.Auth.GetUser(c.Context(), userID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "User not found"})
	}

	account, _ := s.services.Account.GetByID(c.Context(), accountID)

	result := fiber.Map{
		"success": true,
		"user": fiber.Map{
			"id":    user.ID,
			"name":  user.DisplayName,
			"email": user.Email,
			"role":  user.Role,
		},
	}

	if account != nil {
		result["account"] = fiber.Map{
			"id":                        account.ID,
			"name":                      account.Name,
			"slug":                      account.Slug,
			"plan":                      account.Plan,
			"created_at":                account.CreatedAt,
			"default_incoming_stage_id": account.DefaultIncomingStageID,
		}
	}

	return c.JSON(result)
}

func (s *Server) handleSetIncomingStage(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		StageID *string `json:"stage_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if req.StageID == nil || *req.StageID == "" {
		// Clear the setting
		_, err := s.repos.DB().Exec(c.Context(), `UPDATE accounts SET default_incoming_stage_id = NULL WHERE id = $1`, accountID)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to update"})
		}
	} else {
		stageID, err := uuid.Parse(*req.StageID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid stage ID"})
		}
		// Verify stage belongs to a pipeline of this account
		var exists bool
		err = s.repos.DB().QueryRow(c.Context(), `
			SELECT EXISTS(
				SELECT 1 FROM pipeline_stages ps
				JOIN pipelines p ON p.id = ps.pipeline_id
				WHERE ps.id = $1 AND p.account_id = $2
			)
		`, stageID, accountID).Scan(&exists)
		if err != nil || !exists {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Stage not found"})
		}
		_, err = s.repos.DB().Exec(c.Context(), `UPDATE accounts SET default_incoming_stage_id = $1 WHERE id = $2`, stageID, accountID)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to update"})
		}
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleUpdateProfile(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	user, err := s.services.Auth.GetUser(c.Context(), userID)
	if err != nil || user == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "User not found"})
	}

	if req.Name != "" {
		user.DisplayName = req.Name
	}
	if req.Email != "" {
		user.Email = req.Email
	}

	if err := s.services.Account.UpdateUser(c.Context(), user); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to update profile"})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleUpdateAccount(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	account, err := s.services.Account.GetByID(c.Context(), accountID)
	if err != nil || account == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Account not found"})
	}

	if req.Name != "" {
		account.Name = req.Name
	}

	if err := s.services.Account.Update(c.Context(), account); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to update account"})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleChangePassword(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if len(req.NewPassword) < 8 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "La contraseña debe tener al menos 8 caracteres"})
	}

	user, err := s.services.Auth.GetUser(c.Context(), userID)
	if err != nil || user == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "User not found"})
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.CurrentPassword)); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Contraseña actual incorrecta"})
	}

	if err := s.services.Account.ResetPassword(c.Context(), userID, req.NewPassword); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to change password"})
	}

	return c.JSON(fiber.Map{"success": true})
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

func (s *Server) handleResetDevice(c *fiber.Ctx) error {
	deviceID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if err := s.services.Device.Reset(c.Context(), deviceID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": "Device reset. Reconnect to generate QR code for re-pairing."})
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

func (s *Server) handleUpdateDevice(c *fiber.Ctx) error {
	deviceID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	if err := s.repos.Device.UpdateName(c.Context(), deviceID, req.Name); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	device, _ := s.services.Device.GetByID(c.Context(), deviceID)
	return c.JSON(fiber.Map{"success": true, "device": device})
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

	// Parse tag_ids filter (same pattern as device_ids)
	tagIDsRaw := c.Context().QueryArgs().PeekMulti("tag_ids")
	for _, raw := range tagIDsRaw {
		for _, idStr := range strings.Split(string(raw), ",") {
			if uid, err := uuid.Parse(strings.TrimSpace(idStr)); err == nil {
				filter.TagIDs = append(filter.TagIDs, uid)
			}
		}
	}

	// Redis cache for default load (no search/filters) — 15s TTL
	isDefaultLoad := filter.Search == "" && !filter.UnreadOnly && !filter.Archived && len(filter.DeviceIDs) == 0 && len(filter.TagIDs) == 0 && filter.Offset == 0
	cacheKey := ""
	if isDefaultLoad && s.cache != nil {
		cacheKey = fmt.Sprintf("chats:%s:%d", accountID.String(), filter.Limit)
		if cached, err := s.cache.Get(c.Context(), cacheKey); err == nil && cached != nil {
			c.Set("Content-Type", "application/json")
			return c.Send(cached)
		}
	}

	chats, total, err := s.services.Chat.GetByAccountIDWithFilters(c.Context(), accountID, filter)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	result := fiber.Map{
		"success": true,
		"chats":   chats,
		"total":   total,
		"limit":   filter.Limit,
		"offset":  filter.Offset,
	}

	// Cache default load result
	if cacheKey != "" && s.cache != nil {
		if data, err := json.Marshal(result); err == nil {
			_ = s.cache.Set(c.Context(), cacheKey, data, 15*time.Second)
		}
	}

	return c.JSON(result)
}

// invalidateChatsCache invalidates the cached chats for an account
func (s *Server) invalidateChatsCache(accountID uuid.UUID) {
	if s.cache != nil {
		_ = s.cache.DelPattern(context.Background(), "chats:"+accountID.String()+":*")
	}
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

	// Load structured tags for contact
	if details.Contact != nil {
		tags, _ := s.services.Tag.GetByEntity(c.Context(), "contact", details.Contact.ID)
		details.Contact.StructuredTags = tags
	}
	if details.Lead != nil {
		tags, _ := s.services.Tag.GetByEntity(c.Context(), "lead", details.Lead.ID)
		details.Lead.StructuredTags = tags
	}

	return c.JSON(fiber.Map{
		"success": true,
		"chat":    details.Chat,
		"contact": details.Contact,
		"lead":    details.Lead,
	})
}

func (s *Server) handleFindChatByPhone(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	phone := c.Params("phone")
	if phone == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Phone is required"})
	}

	// Normalize and build JID
	normalized := kommo.NormalizePhone(phone)
	jid := normalized + "@s.whatsapp.net"

	chat, err := s.services.Chat.FindByJID(c.Context(), accountID, jid)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	if chat == nil {
		return c.JSON(fiber.Map{"success": true, "chat": nil})
	}

	return c.JSON(fiber.Map{"success": true, "chat": chat})
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
			s.invalidateChatsCache(accountID)
			return c.Status(201).JSON(fiber.Map{
				"success": true,
				"chat":    chat,
				"warning": "Chat created but initial message failed to send",
			})
		}
	}

	s.invalidateChatsCache(accountID)
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

	s.invalidateChatsCache(c.Locals("account_id").(uuid.UUID))
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

	s.invalidateChatsCache(c.Locals("account_id").(uuid.UUID))
	return c.JSON(fiber.Map{"success": true, "message": "Chat deleted"})
}

func (s *Server) handleRequestHistorySync(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	chatID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid chat ID"})
	}

	// Get the chat to find its JID and device
	chat, err := s.services.Chat.GetByID(c.Context(), chatID)
	if err != nil || chat == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Chat not found"})
	}

	if chat.DeviceID == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Chat has no associated device"})
	}

	if err := s.services.Chat.RequestHistorySync(c.Context(), accountID, *chat.DeviceID, chatID, chat.JID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "message": "History sync requested"})
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
		s.invalidateChatsCache(accountID)
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

	s.invalidateChatsCache(accountID)
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

func (s *Server) handleSendContact(c *fiber.Ctx) error {
	var req struct {
		DeviceID     string `json:"device_id"`
		To           string `json:"to"`
		ContactName  string `json:"contact_name"`
		ContactPhone string `json:"contact_phone"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if req.ContactName == "" || req.ContactPhone == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "contact_name and contact_phone are required"})
	}

	message, err := s.services.Chat.SendContactMessage(c.Context(), deviceID, req.To, req.ContactName, req.ContactPhone)
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
		TargetFromMe    bool   `json:"target_from_me"`
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

	if err := s.services.Chat.SendReaction(c.Context(), deviceID, req.To, req.TargetMessageID, req.Emoji, req.TargetFromMe); err != nil {
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

func (s *Server) handleSendTyping(c *fiber.Ctx) error {
	var req struct {
		DeviceID  string `json:"device_id"`
		To        string `json:"to"`
		Composing bool   `json:"composing"`
		Media     string `json:"media"` // "" or "audio"
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if err := s.services.Chat.SendChatPresence(c.Context(), deviceID, req.To, req.Composing, req.Media); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleSendReadReceipt(c *fiber.Ctx) error {
	var req struct {
		DeviceID   string   `json:"device_id"`
		ChatJID    string   `json:"chat_jid"`
		SenderJID  string   `json:"sender_jid"`
		MessageIDs []string `json:"message_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if len(req.MessageIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "message_ids is required"})
	}

	if err := s.services.Chat.SendReadReceipt(c.Context(), deviceID, req.ChatJID, req.SenderJID, req.MessageIDs); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleDeleteMessage(c *fiber.Ctx) error {
	var req struct {
		DeviceID  string `json:"device_id"`
		ChatJID   string `json:"chat_jid"`
		SenderJID string `json:"sender_jid"`
		MessageID string `json:"message_id"`
		IsFromMe  bool   `json:"is_from_me"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if req.MessageID == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "message_id is required"})
	}

	if err := s.services.Chat.RevokeMessage(c.Context(), deviceID, req.ChatJID, req.SenderJID, req.MessageID, req.IsFromMe); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Mark as revoked in DB
	accountID := c.Locals("account_id").(uuid.UUID)
	_ = s.repos.Message.MarkAsRevoked(c.Context(), accountID, req.ChatJID, req.MessageID)

	// Broadcast revocation to frontend
	s.hub.BroadcastToAccount(accountID, "message_revoked", map[string]interface{}{
		"chat_jid":   req.ChatJID,
		"message_id": req.MessageID,
		"is_from_me": req.IsFromMe,
	})

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleEditMessage(c *fiber.Ctx) error {
	var req struct {
		DeviceID  string `json:"device_id"`
		ChatJID   string `json:"chat_jid"`
		MessageID string `json:"message_id"`
		NewBody   string `json:"new_body"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if req.MessageID == "" || req.NewBody == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "message_id and new_body are required"})
	}

	if err := s.services.Chat.EditMessage(c.Context(), deviceID, req.ChatJID, req.MessageID, req.NewBody); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Update in DB
	accountID := c.Locals("account_id").(uuid.UUID)
	_ = s.repos.Message.UpdateBody(c.Context(), accountID, req.ChatJID, req.MessageID, req.NewBody)

	// Broadcast to frontend
	s.hub.BroadcastToAccount(accountID, ws.EventMessageEdited, map[string]interface{}{
		"chat_jid":   req.ChatJID,
		"message_id": req.MessageID,
		"new_body":   req.NewBody,
		"is_from_me": true,
	})

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleCheckWhatsApp(c *fiber.Ctx) error {
	var req struct {
		DeviceID string   `json:"device_id"`
		Phones   []string `json:"phones"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	if len(req.Phones) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "phones is required"})
	}

	results, err := s.services.Chat.IsOnWhatsApp(c.Context(), deviceID, req.Phones)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "results": results})
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

	// Parse optional device_ids filter
	deviceIDs := c.Context().QueryArgs().PeekMulti("device_ids")
	var deviceUUIDs []uuid.UUID
	for _, did := range deviceIDs {
		if id, err := uuid.Parse(string(did)); err == nil {
			deviceUUIDs = append(deviceUUIDs, id)
		}
	}

	// Build cache key including device filter
	cacheKey := "leads:" + accountID.String()
	if len(deviceUUIDs) > 0 {
		for _, d := range deviceUUIDs {
			cacheKey += ":" + d.String()
		}
	}

	// Try Redis cache first
	if s.cache != nil {
		if cached, err := s.cache.Get(c.Context(), cacheKey); err == nil && cached != nil {
			c.Set("Content-Type", "application/json")
			return c.Send(cached)
		}
	}

	// --- Parallel: load leads + tags simultaneously ---
	var leads []*domain.Lead
	var leadsErr error
	tagMap := make(map[uuid.UUID][]*domain.Tag)
	var tagsErr error

	var wg sync.WaitGroup
	wg.Add(2)

	// Goroutine 1: load leads (slim — no notes/custom_fields for list)
	go func() {
		defer wg.Done()
		if len(deviceUUIDs) > 0 {
			rows, qErr := s.repos.DB().Query(c.Context(), `
				SELECT l.id, l.account_id, l.contact_id, l.jid, l.name, l.last_name, l.short_name, l.phone, l.email, l.company, l.age, l.dni, l.birth_date, l.status, l.source, l.notes,
				       l.tags, l.custom_fields, l.assigned_to, l.pipeline_id, l.stage_id, l.created_at, l.updated_at,
				       ps.name, ps.color, ps.position, l.kommo_id
				FROM leads l
				LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
				WHERE l.account_id = $1
				  AND l.jid IN (SELECT DISTINCT jid FROM chats WHERE device_id = ANY($2))
				ORDER BY l.created_at DESC
			`, accountID, deviceUUIDs)
			if qErr != nil {
				leadsErr = qErr
				return
			}
			defer rows.Close()
			for rows.Next() {
				lead := &domain.Lead{}
				if scanErr := rows.Scan(
					&lead.ID, &lead.AccountID, &lead.ContactID, &lead.JID, &lead.Name, &lead.LastName, &lead.ShortName, &lead.Phone,
					&lead.Email, &lead.Company, &lead.Age, &lead.DNI, &lead.BirthDate, &lead.Status, &lead.Source, &lead.Notes, &lead.Tags,
					&lead.CustomFields, &lead.AssignedTo, &lead.PipelineID, &lead.StageID, &lead.CreatedAt, &lead.UpdatedAt,
					&lead.StageName, &lead.StageColor, &lead.StagePosition, &lead.KommoID,
				); scanErr != nil {
					leadsErr = scanErr
					return
				}
				leads = append(leads, lead)
			}
		} else {
			leads, leadsErr = s.services.Lead.GetByAccountID(c.Context(), accountID)
		}
	}()

	// Goroutine 2: load all tags for account's leads (fixed: direct JOIN, no subquery)
	go func() {
		defer wg.Done()
		rows, err := s.repos.DB().Query(c.Context(), `
			SELECT lt.lead_id, t.id, t.account_id, t.name, t.color
			FROM lead_tags lt
			JOIN tags t ON t.id = lt.tag_id
			JOIN leads l ON l.id = lt.lead_id
			WHERE l.account_id = $1
			ORDER BY t.name
		`, accountID)
		if err != nil {
			tagsErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			var leadID uuid.UUID
			t := &domain.Tag{}
			if err := rows.Scan(&leadID, &t.ID, &t.AccountID, &t.Name, &t.Color); err != nil {
				continue
			}
			tagMap[leadID] = append(tagMap[leadID], t)
		}
	}()

	wg.Wait()

	if leadsErr != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": leadsErr.Error()})
	}
	// tagsErr is non-fatal — leads still returned without tags
	if tagsErr != nil {
		log.Printf("[LEADS] Warning: failed to load tags: %v", tagsErr)
	}

	// Assign tags to leads
	for _, lead := range leads {
		lead.StructuredTags = tagMap[lead.ID]
	}

	result := fiber.Map{"success": true, "leads": leads}

	// Store in Redis cache (60s TTL — longer to improve hit rate)
	if s.cache != nil {
		if data, err := json.Marshal(result); err == nil {
			_ = s.cache.Set(c.Context(), cacheKey, data, 60*time.Second)
		}
	}

	return c.JSON(result)
}

// invalidateLeadsCache invalidates ALL cached leads keys for an account (base + device-filtered + paginated)
func (s *Server) invalidateLeadsCache(accountID uuid.UUID) {
	if s.cache != nil {
		_ = s.cache.Del(context.Background(), "leads:"+accountID.String())
		_ = s.cache.DelPattern(context.Background(), "leads:"+accountID.String()+":*")
		_ = s.cache.DelPattern(context.Background(), "leads_paged:"+accountID.String()+":*")
		_ = s.cache.DelPattern(context.Background(), "leads_stage:"+accountID.String()+":*")
		_ = s.cache.DelPattern(context.Background(), "leads_list:"+accountID.String()+":*")
	}
}

// ─── Shared filter helpers ──────────────────────────────────────────────────

// addDateFilter parses date_field, date_from, date_to from the query and appends a date range WHERE clause.
// Allowed fields are validated by allowedFields map. tableAlias is the SQL alias (e.g. "l" for leads, "p" for participants).
func addDateFilter(c *fiber.Ctx, tableAlias string, allowedFields map[string]bool, whereClauses *[]string, args *[]interface{}, argIdx *int) {
	dateField := c.Query("date_field")
	dateFrom := c.Query("date_from")
	dateTo := c.Query("date_to")
	if dateField == "" || (dateFrom == "" && dateTo == "") {
		return
	}
	if !allowedFields[dateField] {
		return
	}
	col := tableAlias + "." + dateField
	if dateFrom != "" {
		t, err := time.Parse(time.RFC3339, dateFrom)
		if err == nil {
			*whereClauses = append(*whereClauses, fmt.Sprintf("%s >= $%d", col, *argIdx))
			*args = append(*args, t)
			*argIdx++
		}
	}
	if dateTo != "" {
		t, err := time.Parse(time.RFC3339, dateTo)
		if err == nil {
			*whereClauses = append(*whereClauses, fmt.Sprintf("%s < $%d", col, *argIdx))
			*args = append(*args, t)
			*argIdx++
		}
	}
}

var leadDateFields = map[string]bool{"created_at": true, "updated_at": true}
var participantDateFields = map[string]bool{"created_at": true, "updated_at": true, "invited_at": true, "confirmed_at": true, "attended_at": true}

// buildTagFormulaSQL builds a WHERE sub-clause for formula-based tag filtering.
// Returns the SQL clause, updated args, and updated argIdx.
// Supports tag_mode=AND (leads must have ALL tags), OR (any tag), and exclude_tag_names.
func buildTagFormulaSQL(tagNames []string, excludeTagNames []string, tagMode string, args []interface{}, argIdx int) (string, []interface{}, int) {
	var clauses []string

	if len(tagNames) > 0 {
		if tagMode == "AND" {
			// Lead must have ALL of the specified tag names
			clauses = append(clauses, fmt.Sprintf(
				"l.id IN (SELECT lt.lead_id FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE t.name = ANY($%d) GROUP BY lt.lead_id HAVING COUNT(DISTINCT t.name) = $%d)",
				argIdx, argIdx+1,
			))
			args = append(args, tagNames, len(tagNames))
			argIdx += 2
		} else {
			// OR mode (default): lead has at least one tag
			clauses = append(clauses, fmt.Sprintf(
				"l.id IN (SELECT lt.lead_id FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE t.name = ANY($%d))",
				argIdx,
			))
			args = append(args, tagNames)
			argIdx++
		}
	}

	if len(excludeTagNames) > 0 {
		clauses = append(clauses, fmt.Sprintf(
			"l.id NOT IN (SELECT lt.lead_id FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE t.name = ANY($%d))",
			argIdx,
		))
		args = append(args, excludeTagNames)
		argIdx++
	}

	return strings.Join(clauses, " AND "), args, argIdx
}

// buildAdvancedFormulaSQL builds a WHERE sub-clause from a text formula.
// Returns the SQL clause, updated args, and updated argIdx.
func buildAdvancedFormulaSQL(formulaText string, accountID uuid.UUID, args []interface{}, argIdx int) (string, []interface{}, int, error) {
	ast, err := formula.Parse(formulaText)
	if err != nil {
		return "", args, argIdx, err
	}
	if ast == nil {
		return "", args, argIdx, nil
	}

	// Build the inner query using formula.BuildSQL (which uses $1 for accountID)
	innerSQL, innerArgs, err := formula.BuildSQL(ast, accountID)
	if err != nil {
		return "", args, argIdx, err
	}

	// Rewrite the inner SQL parameter numbers to fit into our arg sequence.
	// The formula SQL uses $1, $2, $3... We need to remap them to $argIdx, $argIdx+1...
	remappedSQL := innerSQL
	for i := len(innerArgs); i >= 1; i-- {
		old := fmt.Sprintf("$%d", i)
		new := fmt.Sprintf("$%d", argIdx+i-1)
		remappedSQL = strings.ReplaceAll(remappedSQL, old, new)
	}

	clause := fmt.Sprintf("l.id IN (%s)", remappedSQL)
	args = append(args, innerArgs...)
	argIdx += len(innerArgs)

	return clause, args, argIdx, nil
}

// handleGetLeadsPaginated returns leads grouped by stage with server-side filtering, first N per stage + total counts.
// This enables instant load for any number of leads (100K+) — only the first page per column is returned.
func (s *Server) handleGetLeadsPaginated(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	// Parse query params
	pipelineID := c.Query("pipeline_id")
	search := strings.TrimSpace(c.Query("search"))
	tagNamesRaw := c.Query("tag_names")
	tagMode := strings.ToUpper(c.Query("tag_mode", "OR"))
	excludeTagNamesRaw := c.Query("exclude_tag_names")
	tagFormulaRaw := c.Query("tag_formula")
	stageIDsRaw := c.Query("stage_ids")
	perStage, _ := strconv.Atoi(c.Query("per_stage", "50"))
	if perStage <= 0 || perStage > 200 {
		perStage = 50
	}

	// Parse device_ids
	deviceIDs := c.Context().QueryArgs().PeekMulti("device_ids")
	var deviceUUIDs []uuid.UUID
	for _, did := range deviceIDs {
		if id, err := uuid.Parse(string(did)); err == nil {
			deviceUUIDs = append(deviceUUIDs, id)
		}
	}

	// Parse tag names
	var tagNames []string
	if tagNamesRaw != "" {
		tagNames = strings.Split(tagNamesRaw, ",")
	}
	var excludeTagNames []string
	if excludeTagNamesRaw != "" {
		excludeTagNames = strings.Split(excludeTagNamesRaw, ",")
	}

	// Parse stage_ids filter
	var stageIDs []string
	if stageIDsRaw != "" {
		stageIDs = strings.Split(stageIDsRaw, ",")
	}

	// Build WHERE clause dynamically
	args := []interface{}{accountID}
	argIdx := 2
	whereClauses := []string{"l.account_id = $1"}

	if pipelineID != "" {
		if pid, err := uuid.Parse(pipelineID); err == nil {
			whereClauses = append(whereClauses, fmt.Sprintf("(l.pipeline_id = $%d OR l.pipeline_id IS NULL)", argIdx))
			args = append(args, pid)
			argIdx++
		}
	}

	if search != "" {
		searchPattern := "%" + strings.ToLower(search) + "%"
		whereClauses = append(whereClauses, fmt.Sprintf(
			"(LOWER(COALESCE(l.name,'')) LIKE $%d OR LOWER(COALESCE(l.phone,'')) LIKE $%d OR LOWER(COALESCE(l.email,'')) LIKE $%d OR LOWER(COALESCE(l.company,'')) LIKE $%d OR LOWER(COALESCE(l.last_name,'')) LIKE $%d)",
			argIdx, argIdx, argIdx, argIdx, argIdx,
		))
		args = append(args, searchPattern)
		argIdx++
	}

	if len(deviceUUIDs) > 0 {
		whereClauses = append(whereClauses, fmt.Sprintf("l.jid IN (SELECT DISTINCT jid FROM chats WHERE device_id = ANY($%d))", argIdx))
		args = append(args, deviceUUIDs)
		argIdx++
	}

	if tagFormulaRaw != "" {
		fSQL, newArgs, newIdx, fErr := buildAdvancedFormulaSQL(tagFormulaRaw, accountID, args, argIdx)
		if fErr == nil && fSQL != "" {
			whereClauses = append(whereClauses, fSQL)
			args = newArgs
			argIdx = newIdx
		}
	} else if len(tagNames) > 0 || len(excludeTagNames) > 0 {
		tagSQL, newArgs, newIdx := buildTagFormulaSQL(tagNames, excludeTagNames, tagMode, args, argIdx)
		if tagSQL != "" {
			whereClauses = append(whereClauses, tagSQL)
			args = newArgs
			argIdx = newIdx
		}
	}

	if len(stageIDs) > 0 {
		var validStageUUIDs []uuid.UUID
		for _, sid := range stageIDs {
			if id, err := uuid.Parse(strings.TrimSpace(sid)); err == nil {
				validStageUUIDs = append(validStageUUIDs, id)
			}
		}
		if len(validStageUUIDs) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.stage_id = ANY($%d)", argIdx))
			args = append(args, validStageUUIDs)
			argIdx++
		}
	}

	addDateFilter(c, "l", leadDateFields, &whereClauses, &args, &argIdx)

	whereSQL := strings.Join(whereClauses, " AND ")

	// --- Run 3 queries in parallel: stages, counts per stage, first N leads per stage + tags ---
	var wg sync.WaitGroup

	// 1. Get pipeline stages
	type stageInfo struct {
		ID         uuid.UUID
		PipelineID uuid.UUID
		Name       string
		Color      string
		Position   int
	}
	var stagesList []stageInfo
	var stagesErr error

	// 2. Counts per stage
	type stageCount struct {
		StageID uuid.UUID
		Count   int
	}
	var counts []stageCount
	var countsErr error

	// 3. First N leads per stage (window function)
	var paginatedLeads []*domain.Lead
	var leadsErr error

	// 4. Tags map
	tagMap := make(map[uuid.UUID][]*domain.Tag)
	var tagsErr error

	// 5. Unassigned count
	var unassignedCount int
	var unassignedErr error

	wg.Add(5)

	// Goroutine 1: pipeline stages
	go func() {
		defer wg.Done()
		if pipelineID == "" {
			return
		}
		pid, err := uuid.Parse(pipelineID)
		if err != nil {
			return
		}
		rows, err := s.repos.DB().Query(c.Context(),
			`SELECT id, pipeline_id, name, color, position FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position`,
			pid,
		)
		if err != nil {
			stagesErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			var si stageInfo
			if err := rows.Scan(&si.ID, &si.PipelineID, &si.Name, &si.Color, &si.Position); err != nil {
				stagesErr = err
				return
			}
			stagesList = append(stagesList, si)
		}
	}()

	// Goroutine 2: count leads per stage
	go func() {
		defer wg.Done()
		q := fmt.Sprintf(`SELECT l.stage_id, COUNT(*) FROM leads l WHERE %s AND l.stage_id IS NOT NULL GROUP BY l.stage_id`, whereSQL)
		rows, err := s.repos.DB().Query(c.Context(), q, args...)
		if err != nil {
			countsErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			var sc stageCount
			if err := rows.Scan(&sc.StageID, &sc.Count); err != nil {
				countsErr = err
				return
			}
			counts = append(counts, sc)
		}
	}()

	// Goroutine 3: first N leads per stage using ROW_NUMBER() window function
	go func() {
		defer wg.Done()
		q := fmt.Sprintf(`
			WITH ranked AS (
				SELECT l.id, l.account_id, l.contact_id, l.jid, l.name, l.last_name, l.short_name,
				       l.phone, l.email, l.company, l.age, l.dni, l.birth_date, l.status, l.source, l.notes,
				       l.tags, l.custom_fields, l.assigned_to, l.pipeline_id, l.stage_id,
				       l.created_at, l.updated_at, l.kommo_id,
				       ps.name AS stage_name, ps.color AS stage_color, ps.position AS stage_position,
				       ROW_NUMBER() OVER (PARTITION BY l.stage_id ORDER BY l.created_at DESC) AS rn
				FROM leads l
				LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
				WHERE %s AND l.stage_id IS NOT NULL
			)
			SELECT id, account_id, contact_id, jid, name, last_name, short_name,
			       phone, email, company, age, dni, birth_date, status, source, notes,
			       tags, custom_fields, assigned_to, pipeline_id, stage_id,
			       created_at, updated_at, kommo_id,
			       stage_name, stage_color, stage_position
			FROM ranked WHERE rn <= %d
			ORDER BY stage_position NULLS LAST, created_at DESC
		`, whereSQL, perStage)
		rows, err := s.repos.DB().Query(c.Context(), q, args...)
		if err != nil {
			leadsErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			lead := &domain.Lead{}
			if err := rows.Scan(
				&lead.ID, &lead.AccountID, &lead.ContactID, &lead.JID, &lead.Name, &lead.LastName, &lead.ShortName,
				&lead.Phone, &lead.Email, &lead.Company, &lead.Age, &lead.DNI, &lead.BirthDate, &lead.Status, &lead.Source, &lead.Notes,
				&lead.Tags, &lead.CustomFields, &lead.AssignedTo, &lead.PipelineID, &lead.StageID,
				&lead.CreatedAt, &lead.UpdatedAt, &lead.KommoID,
				&lead.StageName, &lead.StageColor, &lead.StagePosition,
			); err != nil {
				leadsErr = err
				return
			}
			paginatedLeads = append(paginatedLeads, lead)
		}
	}()

	// Goroutine 4: tags for account leads
	go func() {
		defer wg.Done()
		rows, err := s.repos.DB().Query(c.Context(), `
			SELECT lt.lead_id, t.id, t.account_id, t.name, t.color
			FROM lead_tags lt
			JOIN tags t ON t.id = lt.tag_id
			JOIN leads l ON l.id = lt.lead_id
			WHERE l.account_id = $1
			ORDER BY t.name
		`, accountID)
		if err != nil {
			tagsErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			var leadID uuid.UUID
			t := &domain.Tag{}
			if err := rows.Scan(&leadID, &t.ID, &t.AccountID, &t.Name, &t.Color); err != nil {
				continue
			}
			tagMap[leadID] = append(tagMap[leadID], t)
		}
	}()

	// Goroutine 5: unassigned leads count + first N
	go func() {
		defer wg.Done()
		q := fmt.Sprintf(`SELECT COUNT(*) FROM leads l WHERE %s AND (l.stage_id IS NULL)`, whereSQL)
		err := s.repos.DB().QueryRow(c.Context(), q, args...).Scan(&unassignedCount)
		if err != nil {
			unassignedErr = err
		}
	}()

	wg.Wait()

	if leadsErr != nil {
		log.Printf("[LEADS] Paginated leads error: %v", leadsErr)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": leadsErr.Error()})
	}
	if countsErr != nil {
		log.Printf("[LEADS] Counts error: %v", countsErr)
	}
	if stagesErr != nil {
		log.Printf("[LEADS] Stages error: %v", stagesErr)
	}
	if tagsErr != nil {
		log.Printf("[LEADS] Tags error: %v", tagsErr)
	}
	if unassignedErr != nil {
		log.Printf("[LEADS] Unassigned error: %v", unassignedErr)
	}

	// Assign tags to leads
	for _, lead := range paginatedLeads {
		lead.StructuredTags = tagMap[lead.ID]
	}

	// Build counts map
	countMap := make(map[uuid.UUID]int)
	for _, sc := range counts {
		countMap[sc.StageID] = sc.Count
	}

	// Build stages response with leads grouped
	type stageResponse struct {
		ID         uuid.UUID      `json:"id"`
		PipelineID uuid.UUID      `json:"pipeline_id"`
		Name       string         `json:"name"`
		Color      string         `json:"color"`
		Position   int            `json:"position"`
		TotalCount int            `json:"total_count"`
		Leads      []*domain.Lead `json:"leads"`
		HasMore    bool           `json:"has_more"`
	}

	stagesResp := make([]stageResponse, 0, len(stagesList))
	for _, si := range stagesList {
		sr := stageResponse{
			ID:         si.ID,
			PipelineID: si.PipelineID,
			Name:       si.Name,
			Color:      si.Color,
			Position:   si.Position,
			TotalCount: countMap[si.ID],
			Leads:      make([]*domain.Lead, 0),
		}
		for _, lead := range paginatedLeads {
			if lead.StageID != nil && *lead.StageID == si.ID {
				sr.Leads = append(sr.Leads, lead)
			}
		}
		sr.HasMore = sr.TotalCount > len(sr.Leads)
		stagesResp = append(stagesResp, sr)
	}

	// Unassigned leads (first N)
	unassignedLeads := make([]*domain.Lead, 0)
	for _, lead := range paginatedLeads {
		if lead.StageID == nil {
			unassignedLeads = append(unassignedLeads, lead)
		}
	}
	// If window function didn't catch unassigned (stage_id IS NOT NULL filter), fetch them separately
	if unassignedCount > 0 && len(unassignedLeads) == 0 {
		unassignedQ := fmt.Sprintf(`
			SELECT l.id, l.account_id, l.contact_id, l.jid, l.name, l.last_name, l.short_name,
			       l.phone, l.email, l.company, l.age, l.dni, l.birth_date, l.status, l.source, l.notes,
			       l.tags, l.custom_fields, l.assigned_to, l.pipeline_id, l.stage_id,
			       l.created_at, l.updated_at, l.kommo_id
			FROM leads l
			WHERE %s AND l.stage_id IS NULL
			ORDER BY l.created_at DESC
			LIMIT %d
		`, whereSQL, perStage)
		rows, err := s.repos.DB().Query(c.Context(), unassignedQ, args...)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				lead := &domain.Lead{}
				if err := rows.Scan(
					&lead.ID, &lead.AccountID, &lead.ContactID, &lead.JID, &lead.Name, &lead.LastName, &lead.ShortName,
					&lead.Phone, &lead.Email, &lead.Company, &lead.Age, &lead.DNI, &lead.BirthDate, &lead.Status, &lead.Source, &lead.Notes,
					&lead.Tags, &lead.CustomFields, &lead.AssignedTo, &lead.PipelineID, &lead.StageID,
					&lead.CreatedAt, &lead.UpdatedAt, &lead.KommoID,
				); err == nil {
					lead.StructuredTags = tagMap[lead.ID]
					unassignedLeads = append(unassignedLeads, lead)
				}
			}
		}
	}

	// Collect all unique tags for filter dropdown
	type tagInfo struct {
		Name  string `json:"name"`
		Color string `json:"color"`
		Count int    `json:"count"`
	}
	tagCountMap := make(map[string]*tagInfo)
	for _, tags := range tagMap {
		for _, t := range tags {
			if existing, ok := tagCountMap[t.Name]; ok {
				existing.Count++
			} else {
				tagCountMap[t.Name] = &tagInfo{Name: t.Name, Color: t.Color, Count: 1}
			}
		}
	}
	tagsList := make([]*tagInfo, 0, len(tagCountMap))
	for _, ti := range tagCountMap {
		tagsList = append(tagsList, ti)
	}

	return c.JSON(fiber.Map{
		"success": true,
		"stages":  stagesResp,
		"unassigned": fiber.Map{
			"total_count": unassignedCount,
			"leads":       unassignedLeads,
			"has_more":    unassignedCount > len(unassignedLeads),
		},
		"all_tags": tagsList,
	})
}

// handleGetLeadsByStage returns paginated leads for a single stage (used by infinite scroll)
func (s *Server) handleGetLeadsByStage(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	stageIDParam := c.Params("stageId")

	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	search := strings.TrimSpace(c.Query("search"))
	tagNamesRaw := c.Query("tag_names")
	tagMode := strings.ToUpper(c.Query("tag_mode", "OR"))
	excludeTagNamesRaw := c.Query("exclude_tag_names")
	tagFormulaRaw2 := c.Query("tag_formula")
	pipelineID := c.Query("pipeline_id")

	// Parse device_ids
	deviceIDs := c.Context().QueryArgs().PeekMulti("device_ids")
	var deviceUUIDs []uuid.UUID
	for _, did := range deviceIDs {
		if id, err := uuid.Parse(string(did)); err == nil {
			deviceUUIDs = append(deviceUUIDs, id)
		}
	}

	// Build WHERE
	args := []interface{}{accountID}
	argIdx := 2
	whereClauses := []string{"l.account_id = $1"}

	// Handle stage: "unassigned" or UUID
	isUnassigned := stageIDParam == "unassigned"
	if isUnassigned {
		whereClauses = append(whereClauses, "l.stage_id IS NULL")
	} else {
		if stageUUID, err := uuid.Parse(stageIDParam); err == nil {
			whereClauses = append(whereClauses, fmt.Sprintf("l.stage_id = $%d", argIdx))
			args = append(args, stageUUID)
			argIdx++
		} else {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid stage_id"})
		}
	}

	if pipelineID != "" {
		if pid, err := uuid.Parse(pipelineID); err == nil {
			whereClauses = append(whereClauses, fmt.Sprintf("(l.pipeline_id = $%d OR l.pipeline_id IS NULL)", argIdx))
			args = append(args, pid)
			argIdx++
		}
	}

	if search != "" {
		searchPattern := "%" + strings.ToLower(search) + "%"
		whereClauses = append(whereClauses, fmt.Sprintf(
			"(LOWER(COALESCE(l.name,'')) LIKE $%d OR LOWER(COALESCE(l.phone,'')) LIKE $%d OR LOWER(COALESCE(l.email,'')) LIKE $%d OR LOWER(COALESCE(l.company,'')) LIKE $%d OR LOWER(COALESCE(l.last_name,'')) LIKE $%d)",
			argIdx, argIdx, argIdx, argIdx, argIdx,
		))
		args = append(args, searchPattern)
		argIdx++
	}

	if len(deviceUUIDs) > 0 {
		whereClauses = append(whereClauses, fmt.Sprintf("l.jid IN (SELECT DISTINCT jid FROM chats WHERE device_id = ANY($%d))", argIdx))
		args = append(args, deviceUUIDs)
		argIdx++
	}

	var tagNames []string
	if tagNamesRaw != "" {
		tagNames = strings.Split(tagNamesRaw, ",")
	}
	var excludeTagNames []string
	if excludeTagNamesRaw != "" {
		excludeTagNames = strings.Split(excludeTagNamesRaw, ",")
	}
	if tagFormulaRaw2 != "" {
		fSQL, newArgs, newIdx, fErr := buildAdvancedFormulaSQL(tagFormulaRaw2, accountID, args, argIdx)
		if fErr == nil && fSQL != "" {
			whereClauses = append(whereClauses, fSQL)
			args = newArgs
			argIdx = newIdx
		}
	} else if len(tagNames) > 0 || len(excludeTagNames) > 0 {
		tagSQL, newArgs, newIdx := buildTagFormulaSQL(tagNames, excludeTagNames, tagMode, args, argIdx)
		if tagSQL != "" {
			whereClauses = append(whereClauses, tagSQL)
			args = newArgs
			argIdx = newIdx
		}
	}

	addDateFilter(c, "l", leadDateFields, &whereClauses, &args, &argIdx)

	whereSQL := strings.Join(whereClauses, " AND ")

	// Query leads with OFFSET/LIMIT
	q := fmt.Sprintf(`
		SELECT l.id, l.account_id, l.contact_id, l.jid, l.name, l.last_name, l.short_name,
		       l.phone, l.email, l.company, l.age, l.dni, l.birth_date, l.status, l.source, l.notes,
		       l.tags, l.custom_fields, l.assigned_to, l.pipeline_id, l.stage_id,
		       l.created_at, l.updated_at, l.kommo_id,
		       ps.name, ps.color, ps.position
		FROM leads l
		LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
		WHERE %s
		ORDER BY l.created_at DESC
		LIMIT %d OFFSET %d
	`, whereSQL, limit+1, offset) // +1 to detect has_more

	rows, err := s.repos.DB().Query(c.Context(), q, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	defer rows.Close()

	leads := make([]*domain.Lead, 0)
	for rows.Next() {
		lead := &domain.Lead{}
		if err := rows.Scan(
			&lead.ID, &lead.AccountID, &lead.ContactID, &lead.JID, &lead.Name, &lead.LastName, &lead.ShortName,
			&lead.Phone, &lead.Email, &lead.Company, &lead.Age, &lead.DNI, &lead.BirthDate, &lead.Status, &lead.Source, &lead.Notes,
			&lead.Tags, &lead.CustomFields, &lead.AssignedTo, &lead.PipelineID, &lead.StageID,
			&lead.CreatedAt, &lead.UpdatedAt, &lead.KommoID,
			&lead.StageName, &lead.StageColor, &lead.StagePosition,
		); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		leads = append(leads, lead)
	}

	hasMore := len(leads) > limit
	if hasMore {
		leads = leads[:limit]
	}

	// Load tags for these leads
	if len(leads) > 0 {
		leadIDs := make([]uuid.UUID, len(leads))
		for i, l := range leads {
			leadIDs[i] = l.ID
		}
		tagRows, err := s.repos.DB().Query(c.Context(), `
			SELECT lt.lead_id, t.id, t.account_id, t.name, t.color
			FROM lead_tags lt
			JOIN tags t ON t.id = lt.tag_id
			WHERE lt.lead_id = ANY($1)
			ORDER BY t.name
		`, leadIDs)
		if err == nil {
			defer tagRows.Close()
			tagMap := make(map[uuid.UUID][]*domain.Tag)
			for tagRows.Next() {
				var leadID uuid.UUID
				t := &domain.Tag{}
				if err := tagRows.Scan(&leadID, &t.ID, &t.AccountID, &t.Name, &t.Color); err == nil {
					tagMap[leadID] = append(tagMap[leadID], t)
				}
			}
			for _, lead := range leads {
				lead.StructuredTags = tagMap[lead.ID]
			}
		}
	}

	return c.JSON(fiber.Map{
		"success":  true,
		"leads":    leads,
		"has_more": hasMore,
	})
}

// handleGetLeadsListPaginated returns a flat paginated list of leads for the list view
func (s *Server) handleGetLeadsListPaginated(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	limit, _ := strconv.Atoi(c.Query("limit", "100"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	search := strings.TrimSpace(c.Query("search"))
	tagNamesRaw := c.Query("tag_names")
	tagMode := strings.ToUpper(c.Query("tag_mode", "OR"))
	excludeTagNamesRaw := c.Query("exclude_tag_names")
	tagFormulaRaw3 := c.Query("tag_formula")
	stageIDsRaw := c.Query("stage_ids")
	pipelineID := c.Query("pipeline_id")

	// Parse device_ids
	deviceIDs := c.Context().QueryArgs().PeekMulti("device_ids")
	var deviceUUIDs []uuid.UUID
	for _, did := range deviceIDs {
		if id, err := uuid.Parse(string(did)); err == nil {
			deviceUUIDs = append(deviceUUIDs, id)
		}
	}

	// Build WHERE
	args := []interface{}{accountID}
	argIdx := 2
	whereClauses := []string{"l.account_id = $1"}

	if pipelineID != "" {
		if pid, err := uuid.Parse(pipelineID); err == nil {
			whereClauses = append(whereClauses, fmt.Sprintf("(l.pipeline_id = $%d OR l.pipeline_id IS NULL)", argIdx))
			args = append(args, pid)
			argIdx++
		}
	}
	if search != "" {
		searchPattern := "%" + strings.ToLower(search) + "%"
		whereClauses = append(whereClauses, fmt.Sprintf(
			"(LOWER(COALESCE(l.name,'')) LIKE $%d OR LOWER(COALESCE(l.phone,'')) LIKE $%d OR LOWER(COALESCE(l.email,'')) LIKE $%d OR LOWER(COALESCE(l.company,'')) LIKE $%d OR LOWER(COALESCE(l.last_name,'')) LIKE $%d)",
			argIdx, argIdx, argIdx, argIdx, argIdx,
		))
		args = append(args, searchPattern)
		argIdx++
	}
	if len(deviceUUIDs) > 0 {
		whereClauses = append(whereClauses, fmt.Sprintf("l.jid IN (SELECT DISTINCT jid FROM chats WHERE device_id = ANY($%d))", argIdx))
		args = append(args, deviceUUIDs)
		argIdx++
	}
	var tagNames []string
	if tagNamesRaw != "" {
		tagNames = strings.Split(tagNamesRaw, ",")
	}
	var excludeTagNames []string
	if excludeTagNamesRaw != "" {
		excludeTagNames = strings.Split(excludeTagNamesRaw, ",")
	}
	if tagFormulaRaw3 != "" {
		fSQL, newArgs, newIdx, fErr := buildAdvancedFormulaSQL(tagFormulaRaw3, accountID, args, argIdx)
		if fErr == nil && fSQL != "" {
			whereClauses = append(whereClauses, fSQL)
			args = newArgs
			argIdx = newIdx
		}
	} else if len(tagNames) > 0 || len(excludeTagNames) > 0 {
		tagSQL, newArgs, newIdx := buildTagFormulaSQL(tagNames, excludeTagNames, tagMode, args, argIdx)
		if tagSQL != "" {
			whereClauses = append(whereClauses, tagSQL)
			args = newArgs
			argIdx = newIdx
		}
	}
	if stageIDsRaw != "" {
		var validStageIDs []uuid.UUID
		for _, sid := range strings.Split(stageIDsRaw, ",") {
			if id, err := uuid.Parse(strings.TrimSpace(sid)); err == nil {
				validStageIDs = append(validStageIDs, id)
			}
		}
		if len(validStageIDs) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.stage_id = ANY($%d)", argIdx))
			args = append(args, validStageIDs)
			argIdx++
		}
	}

	addDateFilter(c, "l", leadDateFields, &whereClauses, &args, &argIdx)

	whereSQL := strings.Join(whereClauses, " AND ")

	// Count + fetch in parallel
	var total int
	leads := make([]*domain.Lead, 0)
	var countErr, leadsErr error
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		q := fmt.Sprintf(`SELECT COUNT(*) FROM leads l WHERE %s`, whereSQL)
		countErr = s.repos.DB().QueryRow(c.Context(), q, args...).Scan(&total)
	}()

	go func() {
		defer wg.Done()
		q := fmt.Sprintf(`
			SELECT l.id, l.account_id, l.contact_id, l.jid, l.name, l.last_name, l.short_name,
			       l.phone, l.email, l.company, l.age, l.dni, l.birth_date, l.status, l.source, l.notes,
			       l.tags, l.custom_fields, l.assigned_to, l.pipeline_id, l.stage_id,
			       l.created_at, l.updated_at, l.kommo_id,
			       ps.name, ps.color, ps.position
			FROM leads l
			LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
			WHERE %s
			ORDER BY l.updated_at DESC
			LIMIT %d OFFSET %d
		`, whereSQL, limit, offset)
		rows, err := s.repos.DB().Query(c.Context(), q, args...)
		if err != nil {
			leadsErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			lead := &domain.Lead{}
			if err := rows.Scan(
				&lead.ID, &lead.AccountID, &lead.ContactID, &lead.JID, &lead.Name, &lead.LastName, &lead.ShortName,
				&lead.Phone, &lead.Email, &lead.Company, &lead.Age, &lead.DNI, &lead.BirthDate, &lead.Status, &lead.Source, &lead.Notes,
				&lead.Tags, &lead.CustomFields, &lead.AssignedTo, &lead.PipelineID, &lead.StageID,
				&lead.CreatedAt, &lead.UpdatedAt, &lead.KommoID,
				&lead.StageName, &lead.StageColor, &lead.StagePosition,
			); err != nil {
				leadsErr = err
				return
			}
			leads = append(leads, lead)
		}
	}()

	wg.Wait()

	if leadsErr != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": leadsErr.Error()})
	}
	if countErr != nil {
		log.Printf("[LEADS] List count error: %v", countErr)
	}

	// Load tags
	if len(leads) > 0 {
		leadIDs := make([]uuid.UUID, len(leads))
		for i, l := range leads {
			leadIDs[i] = l.ID
		}
		tagRows, err := s.repos.DB().Query(c.Context(), `
			SELECT lt.lead_id, t.id, t.account_id, t.name, t.color
			FROM lead_tags lt
			JOIN tags t ON t.id = lt.tag_id
			WHERE lt.lead_id = ANY($1)
			ORDER BY t.name
		`, leadIDs)
		if err == nil {
			defer tagRows.Close()
			tagMap := make(map[uuid.UUID][]*domain.Tag)
			for tagRows.Next() {
				var leadID uuid.UUID
				t := &domain.Tag{}
				if err := tagRows.Scan(&leadID, &t.ID, &t.AccountID, &t.Name, &t.Color); err == nil {
					tagMap[leadID] = append(tagMap[leadID], t)
				}
			}
			for _, lead := range leads {
				lead.StructuredTags = tagMap[lead.ID]
			}
		}
	}

	return c.JSON(fiber.Map{
		"success":    true,
		"leads":      leads,
		"total":      total,
		"has_more":   offset+len(leads) < total,
	})
}
func (s *Server) broadcastLeadDelta(accountID uuid.UUID, action string, lead *domain.Lead) {
	if s.hub == nil {
		return
	}
	payload := map[string]interface{}{
		"action": action,
	}
	if lead != nil {
		payload["lead"] = lead
	}
	s.hub.BroadcastToAccount(accountID, ws.EventLeadUpdate, payload)
}

func (s *Server) handleCreateLead(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		Name      string     `json:"name"`
		Phone     string     `json:"phone"`
		Email     string     `json:"email"`
		Source    string     `json:"source"`
		Notes     string     `json:"notes"`
		DNI       string     `json:"dni"`
		BirthDate *string    `json:"birth_date"`
		StageID   *uuid.UUID `json:"stage_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	phone := kommo.NormalizePhone(req.Phone)
	jid := ""
	if phone != "" {
		jid = phone + "@s.whatsapp.net"
		// Check if a lead with this phone already exists
		existingLead, _ := s.services.Lead.GetByJID(c.Context(), accountID, jid)
		if existingLead != nil {
			existingName := ""
			if existingLead.Name != nil {
				existingName = *existingLead.Name
			}
			return c.Status(409).JSON(fiber.Map{
				"success": false,
				"error":   fmt.Sprintf("Ya existe un lead con el teléfono %s (%s)", req.Phone, existingName),
			})
		}
	} else {
		// Leads without phone get a unique JID to avoid conflicts
		jid = fmt.Sprintf("manual_%s@clarin.lead", uuid.New().String()[:8])
	}

	// Parse birth_date if provided
	var birthDate *time.Time
	if req.BirthDate != nil && *req.BirthDate != "" {
		if t, err := time.Parse("2006-01-02", *req.BirthDate); err == nil {
			birthDate = &t
		}
	}

	lead := &domain.Lead{
		AccountID: accountID,
		JID:       jid,
		Name:      strPtr(req.Name),
		Phone:     strPtr(req.Phone),
		Email:     strPtr(req.Email),
		Source:    strPtr(req.Source),
		Notes:     strPtr(req.Notes),
		DNI:       strPtr(req.DNI),
		BirthDate: birthDate,
		Status:    strPtr(domain.LeadStatusNew),
	}

	// Auto-assign default pipeline and stage
	if req.StageID != nil {
		lead.StageID = req.StageID
		// Get the pipeline from the stage
		pipelines, _ := s.services.Pipeline.GetByAccountID(c.Context(), accountID)
		for _, p := range pipelines {
			for _, st := range p.Stages {
				if st.ID == *req.StageID {
					lead.PipelineID = &p.ID
					break
				}
			}
		}
	} else {
		// Assign to default pipeline first stage
		defaultPipeline, _ := s.services.Pipeline.GetDefaultPipeline(c.Context(), accountID)
		if defaultPipeline != nil {
			lead.PipelineID = &defaultPipeline.ID
			if len(defaultPipeline.Stages) > 0 {
				// 1. Check account-configured default incoming stage
				var configured bool
				if acct, _ := s.services.Account.GetByID(c.Context(), accountID); acct != nil && acct.DefaultIncomingStageID != nil {
					for _, st := range defaultPipeline.Stages {
						if st.ID == *acct.DefaultIncomingStageID {
							lead.StageID = &st.ID
							configured = true
							break
						}
					}
				}
				if !configured {
					// 2. Fallback: prefer "Leads Entrantes", then first stage
					lead.StageID = &defaultPipeline.Stages[0].ID
					for _, st := range defaultPipeline.Stages {
						if strings.EqualFold(st.Name, "Leads Entrantes") {
							lead.StageID = &st.ID
							break
						}
					}
				}
			}
		}
	}

	// Auto-link or auto-create contact by JID (only for real phone JIDs)
	isRealPhone := !strings.HasPrefix(jid, "manual_")
	contact, _ := s.repos.Contact.GetByJID(c.Context(), accountID, jid)
	if contact != nil {
		lead.ContactID = &contact.ID
		// Copy contact fields to lead if lead fields are empty
		if lead.Name == nil || *lead.Name == "" {
			dn := contact.DisplayName()
			lead.Name = &dn
		}
		if (lead.Phone == nil || *lead.Phone == "") && contact.Phone != nil {
			lead.Phone = contact.Phone
		}
		if (lead.Email == nil || *lead.Email == "") && contact.Email != nil {
			lead.Email = contact.Email
		}
		if lead.DNI == nil || *lead.DNI == "" {
			lead.DNI = contact.DNI
		}
		if lead.BirthDate == nil {
			lead.BirthDate = contact.BirthDate
		}
		lead.LastName = contact.LastName
		lead.ShortName = contact.ShortName
		lead.Company = contact.Company
		lead.Age = contact.Age

		// Propagate new lead data back to existing contact
		contact.Email = lead.Email
		contact.Notes = lead.Notes
		contact.DNI = lead.DNI
		contact.BirthDate = lead.BirthDate
		if lead.Name != nil && *lead.Name != "" {
			contact.CustomName = lead.Name
		}
		_ = s.repos.Contact.Update(c.Context(), contact)
	} else if isRealPhone {
		// Auto-create contact from lead data
		contact, _ = s.repos.Contact.GetOrCreate(c.Context(), accountID, nil, jid, phone, req.Name, "", false)
		if contact != nil {
			lead.ContactID = &contact.ID
			// Update contact with extra fields from lead
			contact.Email = lead.Email
			contact.Notes = lead.Notes
			contact.Source = strPtr("manual")
			contact.DNI = lead.DNI
			contact.BirthDate = lead.BirthDate
			_ = s.repos.Contact.Update(c.Context(), contact)
			log.Printf("[API] Auto-created contact %s for new lead (phone=%s)", contact.ID, phone)
		}
	}

	if err := s.services.Lead.Create(c.Context(), lead); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Push new lead to Kommo (async, only if pipeline is Kommo-connected)
	if s.kommoSync != nil {
		go s.kommoSync.PushNewLead(accountID, lead.ID)
	}

	s.invalidateLeadsCache(accountID)
	s.broadcastLeadDelta(accountID, "created", lead)
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

	tags, _ := s.services.Tag.GetByEntity(c.Context(), "lead", lead.ID)
	lead.StructuredTags = tags

	return c.JSON(fiber.Map{"success": true, "lead": lead})
}

func (s *Server) handleSyncLeadFromKommo(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid lead ID"})
	}

	if s.kommoSync == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Kommo integration not configured"})
	}

	if err := s.kommoSync.SyncSingleLead(c.Context(), accountID, leadID); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Return the updated lead
	lead, err := s.services.Lead.GetByID(c.Context(), leadID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	tags, _ := s.services.Tag.GetByEntity(c.Context(), "lead", lead.ID)
	lead.StructuredTags = tags

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

	// Track old name for Kommo push (before overwriting)
	var oldName string
	if lead.Name != nil {
		oldName = *lead.Name
	}

	// Parse update request
	var req struct {
		Name         *string                `json:"name"`
		LastName     *string                `json:"last_name"`
		ShortName    *string                `json:"short_name"`
		Phone        *string                `json:"phone"`
		Email        *string                `json:"email"`
		Company      *string                `json:"company"`
		Age          *int                   `json:"age"`
		DNI          *string                `json:"dni"`
		BirthDate    *string                `json:"birth_date"`
		Status       *string                `json:"status"`
		Source       *string                `json:"source"`
		Notes        *string                `json:"notes"`
		Tags         []string               `json:"tags"`
		CustomFields map[string]interface{} `json:"custom_fields"`
		AssignedTo   *string                `json:"assigned_to"`
		StageID      *string                `json:"stage_id"`
		PipelineID   *string                `json:"pipeline_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	// Update fields if provided
	if req.Name != nil {
		lead.Name = req.Name
	}
	if req.LastName != nil {
		lead.LastName = req.LastName
	}
	if req.ShortName != nil {
		lead.ShortName = req.ShortName
	}
	if req.Phone != nil {
		lead.Phone = req.Phone
	}
	if req.Email != nil {
		lead.Email = req.Email
	}
	if req.Company != nil {
		lead.Company = req.Company
	}
	if req.Age != nil {
		lead.Age = req.Age
	}
	if req.DNI != nil {
		lead.DNI = req.DNI
	}
	if req.BirthDate != nil {
		if *req.BirthDate == "" {
			lead.BirthDate = nil
		} else if t, err := time.Parse("2006-01-02", *req.BirthDate); err == nil {
			lead.BirthDate = &t
		}
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
	if req.StageID != nil {
		if *req.StageID == "" {
			lead.StageID = nil
		} else if uid, err := uuid.Parse(*req.StageID); err == nil {
			lead.StageID = &uid
		}
	}
	if req.PipelineID != nil {
		if *req.PipelineID == "" {
			lead.PipelineID = nil
		} else if uid, err := uuid.Parse(*req.PipelineID); err == nil {
			lead.PipelineID = &uid
		}
	}

	if err := s.services.Lead.Update(c.Context(), lead); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Sync shared fields to linked contact
	_ = s.services.Lead.SyncToContact(c.Context(), lead)

	// Kommo Sync
	if s.kommoSync != nil {
		// If lead is not linked to Kommo yet, try to create it there (PushNewLead handles checks)
		if lead.KommoID == nil || *lead.KommoID == 0 {
			go s.kommoSync.PushNewLead(lead.AccountID, lead.ID)
		} else {
			// Already linked, push updates
			if req.Name != nil {
				newName := ""
				if lead.Name != nil {
					newName = *lead.Name
				}
				if newName != oldName {
					go s.kommoSync.PushLeadName(lead.AccountID, lead.ID)
				}
			}
			// Push pipeline/stage change
			if req.PipelineID != nil || req.StageID != nil {
				go s.kommoSync.PushPipelineStageChange(lead.AccountID, lead.ID)
			}
		}
	}

	// Populate structured_tags before responding
	tags, err := s.repos.Tag.GetByLead(c.Context(), lead.ID)
	if err == nil {
		lead.StructuredTags = tags
	}

	s.invalidateLeadsCache(lead.AccountID)
	s.broadcastLeadDelta(lead.AccountID, "updated", lead)
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

	s.invalidateLeadsCache(c.Locals("account_id").(uuid.UUID))
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

	accountID := c.Locals("account_id").(uuid.UUID)
	s.invalidateLeadsCache(accountID)
	// Broadcast delete with just the ID
	deletedLead := &domain.Lead{ID: leadID}
	s.broadcastLeadDelta(accountID, "deleted", deletedLead)
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
		s.invalidateLeadsCache(accountID)
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

	s.invalidateLeadsCache(accountID)
	return c.JSON(fiber.Map{"success": true, "message": fmt.Sprintf("%d leads deleted", len(uuids))})
}

// --- Pipeline Handlers ---

func (s *Server) handleUpdateLeadStage(c *fiber.Ctx) error {
	leadID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid lead ID"})
	}

	var req struct {
		StageID string `json:"stage_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	stageID, err := uuid.Parse(req.StageID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid stage ID"})
	}

	if err := s.services.Lead.UpdateStage(c.Context(), leadID, stageID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Push stage change to Kommo (async, non-blocking)
	accountID := c.Locals("account_id").(uuid.UUID)
	if s.kommoSync != nil {
		go s.kommoSync.PushLeadStageChange(accountID, leadID, stageID)
	}

	s.invalidateLeadsCache(accountID)
	// Broadcast delta with stage info
	s.hub.BroadcastToAccount(accountID, ws.EventLeadUpdate, map[string]interface{}{
		"action":   "stage_changed",
		"lead_id":  leadID.String(),
		"stage_id": stageID.String(),
	})
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleGetPipelines(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	pipelines, err := s.services.Pipeline.GetByAccountID(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "pipelines": pipelines})
}

func (s *Server) handleCreatePipeline(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		Name        string  `json:"name"`
		Description *string `json:"description"`
	}
	if err := c.BodyParser(&req); err != nil || req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	pipeline := &domain.Pipeline{
		AccountID:   accountID,
		Name:        req.Name,
		Description: req.Description,
	}
	if err := s.services.Pipeline.Create(c.Context(), pipeline); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "pipeline": pipeline})
}

func (s *Server) handleUpdatePipeline(c *fiber.Ctx) error {
	pipelineID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid pipeline ID"})
	}
	pipeline, err := s.services.Pipeline.GetByID(c.Context(), pipelineID)
	if err != nil || pipeline == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Pipeline not found"})
	}
	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name != nil {
		pipeline.Name = *req.Name
	}
	if req.Description != nil {
		pipeline.Description = req.Description
	}
	if err := s.services.Pipeline.Update(c.Context(), pipeline); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "pipeline": pipeline})
}

func (s *Server) handleDeletePipeline(c *fiber.Ctx) error {
	pipelineID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid pipeline ID"})
	}
	if err := s.services.Pipeline.Delete(c.Context(), pipelineID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleCreatePipelineStage(c *fiber.Ctx) error {
	pipelineID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid pipeline ID"})
	}
	var req struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := c.BodyParser(&req); err != nil || req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	if req.Color == "" {
		req.Color = "#6366f1"
	}
	stage := &domain.PipelineStage{
		PipelineID: pipelineID,
		Name:       req.Name,
		Color:      req.Color,
	}
	if err := s.services.Pipeline.CreateStage(c.Context(), stage); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "stage": stage})
}

func (s *Server) handleUpdatePipelineStage(c *fiber.Ctx) error {
	stageID, err := uuid.Parse(c.Params("stageId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid stage ID"})
	}
	var req struct {
		Name     *string `json:"name"`
		Color    *string `json:"color"`
		Position *int    `json:"position"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	stage := &domain.PipelineStage{ID: stageID}
	if req.Name != nil {
		stage.Name = *req.Name
	}
	if req.Color != nil {
		stage.Color = *req.Color
	}
	if req.Position != nil {
		stage.Position = *req.Position
	}
	if err := s.services.Pipeline.UpdateStage(c.Context(), stage); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "stage": stage})
}

func (s *Server) handleDeletePipelineStage(c *fiber.Ctx) error {
	stageID, err := uuid.Parse(c.Params("stageId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid stage ID"})
	}
	if err := s.services.Pipeline.DeleteStage(c.Context(), stageID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleReorderPipelineStages(c *fiber.Ctx) error {
	pipelineID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid pipeline ID"})
	}
	var req struct {
		StageIDs []string `json:"stage_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	var stageIDs []uuid.UUID
	for _, s := range req.StageIDs {
		if uid, err := uuid.Parse(s); err == nil {
			stageIDs = append(stageIDs, uid)
		}
	}
	if err := s.services.Pipeline.ReorderStages(c.Context(), pipelineID, stageIDs); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
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

	// Read all content into memory to detect separators
	rawBytes, err := io.ReadAll(f)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Cannot read file content"})
	}
	rawContent := string(rawBytes)
	lines := strings.Split(rawContent, "\n")
	if len(lines) < 2 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "CSV file must have at least a header and one data row"})
	}

	// Detect separator: Kommo uses commas in header, semicolons in data.
	// General approach: check which delimiter produces more columns consistently.
	headerLine := strings.TrimSpace(lines[0])
	dataLine := ""
	for _, l := range lines[1:] {
		trimmed := strings.TrimSpace(l)
		if trimmed != "" {
			dataLine = trimmed
			break
		}
	}

	headerSep := detectCSVSeparator(headerLine)
	dataSep := detectCSVSeparator(dataLine)

	// Parse header with its detected separator
	headerReader := csv.NewReader(strings.NewReader(headerLine))
	headerReader.Comma = headerSep
	headerReader.LazyQuotes = true
	headerReader.TrimLeadingSpace = true
	headers, err := headerReader.Read()
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Cannot parse CSV headers"})
	}

	// Build column mapping (case-insensitive, trimmed)
	colMap := make(map[string]int)
	for i, h := range headers {
		key := strings.ToLower(strings.TrimSpace(h))
		if key != "" {
			colMap[key] = i
		}
	}

	// Find phone column by name
	phoneCol := -1
	for _, key := range []string{"phone", "telefono", "teléfono", "celular", "número", "numero", "movil", "móvil"} {
		if idx, ok := colMap[key]; ok {
			phoneCol = idx
			break
		}
	}

	// If phone column not found by name, scan first data row for phone-like values
	// (Kommo exports have unlabeled phone columns containing '+51XXXXXXXXX)
	if phoneCol == -1 && dataLine != "" {
		dataReader := csv.NewReader(strings.NewReader(dataLine))
		dataReader.Comma = dataSep
		dataReader.LazyQuotes = true
		dataReader.TrimLeadingSpace = true
		if testRow, err := dataReader.Read(); err == nil {
			bestCol := -1
			bestScore := 0
			for i, val := range testRow {
				// Skip columns with known non-phone headers
				if i < len(headers) {
					hdr := strings.ToLower(strings.TrimSpace(headers[i]))
					if hdr == "id" || hdr == "edad" || hdr == "age" || hdr == "dni" || hdr == "dni_ce" {
						continue
					}
				}
				raw := strings.TrimSpace(val)
				cleaned := strings.Trim(raw, "'\"")
				hasPlus := strings.HasPrefix(cleaned, "+")
				hasTick := strings.HasPrefix(raw, "'") || strings.HasPrefix(raw, "\"'")
				cleaned = strings.ReplaceAll(cleaned, " ", "")
				cleaned = strings.ReplaceAll(cleaned, "-", "")
				cleaned = strings.TrimPrefix(cleaned, "+")
				if len(cleaned) < 8 || len(cleaned) > 15 {
					continue
				}
				allDigits := true
				for _, ch := range cleaned {
					if ch < '0' || ch > '9' {
						allDigits = false
						break
					}
				}
				if !allDigits {
					continue
				}
				// Score: prefer values with + prefix or tick marks (phone formatting)
				// and columns with empty headers (unlabeled = likely phone in Kommo)
				score := 1
				if hasPlus || hasTick {
					score += 10
				}
				if i < len(headers) && strings.TrimSpace(headers[i]) == "" {
					score += 5
				}
				if len(cleaned) >= 10 {
					score += 2 // longer numbers more likely phone
				}
				if score > bestScore {
					bestScore = score
					bestCol = i
				}
			}
			phoneCol = bestCol
		}
	}

	if phoneCol == -1 {
		return c.Status(400).JSON(fiber.Map{
			"success": false,
			"error":   "CSV must have a phone/telefono/celular column",
		})
	}

	// Map known columns (supports Kommo naming)
	nameCol := findCol(colMap, "name", "nombre", "nombre_completo", "nombre completo")
	emailCol := findCol(colMap, "email", "correo", "e-mail", "e-mail priv.")
	notesCol := findCol(colMap, "notes", "notas", "observaciones")
	tagsCol := findCol(colMap, "tags", "etiquetas")
	companyCol := findCol(colMap, "company", "empresa")
	lastNameCol := findCol(colMap, "last_name", "apellido", "apellidos")
	stageCol := findCol(colMap, "estatus del lead", "stage", "etapa", "estado lead", "status")
	_ = findCol(colMap, "embudo de ventas", "pipeline", "embudo") // reserved for future multi-pipeline import
	ageCol := findCol(colMap, "edad", "age")

	// Get default pipeline for stage assignment
	defaultPipeline, _ := s.services.Pipeline.GetDefaultPipeline(c.Context(), accountID)

	imported := 0
	skipped := 0
	var importErrors []string

	// Parse data rows using the data separator
	for i := 1; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		rowReader := csv.NewReader(strings.NewReader(line))
		rowReader.Comma = dataSep
		rowReader.LazyQuotes = true
		rowReader.TrimLeadingSpace = true

		row, err := rowReader.Read()
		if err != nil {
			skipped++
			continue
		}

		phone := safeCol(row, phoneCol)
		if phone == "" {
			skipped++
			continue
		}

		// Normalize phone: remove quotes, ticks, spaces, dashes
		phone = strings.Trim(phone, "'\"` ")
		phone = strings.ReplaceAll(phone, " ", "")
		phone = strings.ReplaceAll(phone, "-", "")
		phone = strings.ReplaceAll(phone, "(", "")
		phone = strings.ReplaceAll(phone, ")", "")
		phone = strings.TrimPrefix(phone, "+")
		if phone == "" || len(phone) < 6 {
			skipped++
			continue
		}

		jid := phone + "@s.whatsapp.net"

		name := safeCol(row, nameCol)
		email := safeCol(row, emailCol)
		notes := safeCol(row, notesCol)
		tags := safeCol(row, tagsCol)
		company := safeCol(row, companyCol)
		lastName := safeCol(row, lastNameCol)
		stageName := safeCol(row, stageCol)
		ageStr := safeCol(row, ageCol)

		if importType == "contacts" || importType == "both" {
			contact, err := s.services.Contact.GetOrCreate(c.Context(), accountID, nil, jid, phone, name, "", false)
			if err != nil {
				importErrors = append(importErrors, fmt.Sprintf("row %d contact: %s", i+1, err.Error()))
			} else if contact != nil {
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

			// Assign pipeline stage if available
			if stageName != "" && defaultPipeline != nil && defaultPipeline.Stages != nil {
				for _, st := range defaultPipeline.Stages {
					if strings.EqualFold(st.Name, stageName) {
						lead.PipelineID = &defaultPipeline.ID
						lead.StageID = &st.ID
						break
					}
				}
			}
			// Fallback: assign to default pipeline first stage
			if lead.PipelineID == nil && defaultPipeline != nil && defaultPipeline.Stages != nil && len(defaultPipeline.Stages) > 0 {
				lead.PipelineID = &defaultPipeline.ID
				// 1. Check account-configured default incoming stage
				var configured bool
				if acct, _ := s.services.Account.GetByID(c.Context(), accountID); acct != nil && acct.DefaultIncomingStageID != nil {
					for _, st := range defaultPipeline.Stages {
						if st.ID == *acct.DefaultIncomingStageID {
							lead.StageID = &st.ID
							configured = true
							break
						}
					}
				}
				if !configured {
					// 2. Fallback: prefer "Leads Entrantes", then first stage
					lead.StageID = &defaultPipeline.Stages[0].ID
					for _, st := range defaultPipeline.Stages {
						if strings.EqualFold(st.Name, "Leads Entrantes") {
							lead.StageID = &st.ID
							break
						}
					}
				}
			}

			if tags != "" {
				// Kommo uses ", " as tag separator within the cell
				tagList := strings.Split(tags, ",")
				for j := range tagList {
					tagList[j] = strings.TrimSpace(tagList[j])
				}
				lead.Tags = tagList
			}
			if company != "" {
				lead.Company = strPtr(company)
			}
			if lastName != "" {
				lead.LastName = strPtr(lastName)
			}
			if ageStr != "" {
				if age, err := strconv.Atoi(strings.TrimSpace(ageStr)); err == nil && age > 0 && age < 200 {
					lead.Age = &age
				}
			}
			if err := s.services.Lead.Create(c.Context(), lead); err != nil {
				importErrors = append(importErrors, fmt.Sprintf("row %d lead: %s", i+1, err.Error()))
			} else if len(lead.Tags) > 0 {
				// Populate lead_tags junction table so event formulas can match
				s.repos.Tag.SyncLeadTagsByNames(c.Context(), accountID, lead.ID, lead.Tags)
			}
		}

		imported++
	}

	s.invalidateLeadsCache(accountID)

	// Reconcile event participants after CSV import (new leads with tags)
	if imported > 0 {
		go s.services.Event.ReconcileAllAccountEvents(context.Background(), accountID)
	}

	return c.JSON(fiber.Map{
		"success":  true,
		"imported": imported,
		"skipped":  skipped,
		"errors":   importErrors,
	})
}

// detectCSVSeparator counts commas, semicolons and tabs outside quotes and returns the most frequent one
func detectCSVSeparator(line string) rune {
	counts := map[rune]int{',': 0, ';': 0, '\t': 0}
	inQuote := false
	for _, ch := range line {
		if ch == '"' {
			inQuote = !inQuote
		}
		if !inQuote {
			if _, ok := counts[ch]; ok {
				counts[ch]++
			}
		}
	}
	best := ','
	bestCount := 0
	for sep, cnt := range counts {
		if cnt > bestCount {
			bestCount = cnt
			best = sep
		}
	}
	return best
}

// findCol returns the column index for the first matching key, or -1
func findCol(colMap map[string]int, keys ...string) int {
	for _, key := range keys {
		if idx, ok := colMap[key]; ok {
			return idx
		}
	}
	return -1
}

// safeCol returns the trimmed value at the given index, or "" if out of bounds
func safeCol(row []string, idx int) string {
	if idx >= 0 && idx < len(row) {
		return strings.TrimSpace(row[idx])
	}
	return ""
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

	if tagIDsStr := c.Query("tag_ids"); tagIDsStr != "" {
		for _, tidStr := range strings.Split(tagIDsStr, ",") {
			if tid, err := uuid.Parse(strings.TrimSpace(tidStr)); err == nil {
				filter.TagIDs = append(filter.TagIDs, tid)
			}
		}
	}

	contacts, total, err := s.services.Contact.GetByAccountIDWithFilters(c.Context(), accountID, filter)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Load structured tags for each contact
	for _, contact := range contacts {
		tags, _ := s.services.Tag.GetByEntity(c.Context(), "contact", contact.ID)
		contact.StructuredTags = tags
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

	tags, _ := s.services.Tag.GetByEntity(c.Context(), "contact", contact.ID)
	contact.StructuredTags = tags

	return c.JSON(fiber.Map{"success": true, "contact": contact})
}

func (s *Server) handleSyncContactFromKommo(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid contact ID"})
	}

	if s.kommoSync == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Kommo integration not configured"})
	}

	if err := s.kommoSync.SyncSingleContact(c.Context(), accountID, contactID); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Return the updated contact
	contact, err := s.services.Contact.GetByID(c.Context(), contactID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	tags, _ := s.services.Tag.GetByEntity(c.Context(), "contact", contact.ID)
	contact.StructuredTags = tags

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
		DNI        *string  `json:"dni"`
		BirthDate  *string  `json:"birth_date"`
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
	if body.DNI != nil {
		contact.DNI = body.DNI
	}
	if body.BirthDate != nil {
		if *body.BirthDate == "" {
			contact.BirthDate = nil
		} else {
			if t, err := time.Parse("2006-01-02", *body.BirthDate); err == nil {
				contact.BirthDate = &t
			}
		}
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

	// Sync shared fields to linked lead
	_ = s.services.Contact.SyncToLead(c.Context(), contact)

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
	accountID := c.Locals("account_id").(uuid.UUID)

	var body struct {
		IDs       []uuid.UUID `json:"ids"`
		DeleteAll bool        `json:"delete_all"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid request"})
	}

	if body.DeleteAll {
		if err := s.services.Contact.DeleteAll(c.Context(), accountID); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		return c.JSON(fiber.Map{"success": true, "message": "All contacts deleted"})
	}

	if len(body.IDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "provide ids array or delete_all"})
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

func (s *Server) handleCreateContact(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var body struct {
		Phone     string   `json:"phone"`
		Name      string   `json:"name"`
		LastName  string   `json:"last_name"`
		Email     string   `json:"email"`
		Company   string   `json:"company"`
		Notes     string   `json:"notes"`
		DNI       string   `json:"dni"`
		BirthDate string   `json:"birth_date"`
		Tags      []string `json:"tags"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}

	normalizedPhone := kommo.NormalizePhone(body.Phone)
	if normalizedPhone == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "phone is required"})
	}

	jid := normalizedPhone + "@s.whatsapp.net"

	contact, err := s.services.Contact.GetOrCreate(c.Context(), accountID, nil, jid, normalizedPhone, body.Name, "", false)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	updated := false
	if body.LastName != "" {
		contact.LastName = &body.LastName
		updated = true
	}
	if body.Email != "" {
		contact.Email = &body.Email
		updated = true
	}
	if body.Company != "" {
		contact.Company = &body.Company
		updated = true
	}
	if body.Notes != "" {
		contact.Notes = &body.Notes
		updated = true
	}
	if len(body.Tags) > 0 {
		contact.Tags = body.Tags
		updated = true
	}
	if body.DNI != "" {
		contact.DNI = &body.DNI
		updated = true
	}
	if body.BirthDate != "" {
		if t, err := time.Parse("2006-01-02", body.BirthDate); err == nil {
			contact.BirthDate = &t
			updated = true
		}
	}
	if updated {
		_ = s.services.Contact.Update(c.Context(), contact)
	}

	tags, _ := s.services.Tag.GetByEntity(c.Context(), "contact", contact.ID)
	contact.StructuredTags = tags

	return c.Status(201).JSON(fiber.Map{"success": true, "contact": contact})
}

func (s *Server) handleCreateContactsBulk(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var body struct {
		Contacts []struct {
			Phone     string   `json:"phone"`
			Name      string   `json:"name"`
			LastName  string   `json:"last_name"`
			Email     string   `json:"email"`
			Company   string   `json:"company"`
			Notes     string   `json:"notes"`
			DNI       string   `json:"dni"`
			BirthDate string   `json:"birth_date"`
			Tags      []string `json:"tags"`
		} `json:"contacts"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	if len(body.Contacts) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "contacts array is empty"})
	}

	created := 0
	skipped := 0
	var importErrors []string

	for i, row := range body.Contacts {
		normalizedPhone := kommo.NormalizePhone(row.Phone)
		if normalizedPhone == "" {
			skipped++
			importErrors = append(importErrors, fmt.Sprintf("fila %d: teléfono inválido (%q)", i+1, row.Phone))
			continue
		}

		jid := normalizedPhone + "@s.whatsapp.net"
		contact, err := s.services.Contact.GetOrCreate(c.Context(), accountID, nil, jid, normalizedPhone, row.Name, "", false)
		if err != nil {
			skipped++
			importErrors = append(importErrors, fmt.Sprintf("fila %d: %s", i+1, err.Error()))
			continue
		}

		updated := false
		if row.LastName != "" {
			contact.LastName = &row.LastName
			updated = true
		}
		if row.Email != "" {
			contact.Email = &row.Email
			updated = true
		}
		if row.Company != "" {
			contact.Company = &row.Company
			updated = true
		}
		if row.Notes != "" {
			contact.Notes = &row.Notes
			updated = true
		}
		if len(row.Tags) > 0 {
			contact.Tags = row.Tags
			updated = true
		}
		if row.DNI != "" {
			contact.DNI = &row.DNI
			updated = true
		}
		if row.BirthDate != "" {
			if t, err := time.Parse("2006-01-02", row.BirthDate); err == nil {
				contact.BirthDate = &t
				updated = true
			}
		}
		if updated {
			_ = s.services.Contact.Update(c.Context(), contact)
		}
		created++
	}

	return c.JSON(fiber.Map{
		"success": true,
		"created": created,
		"skipped": skipped,
		"errors":  importErrors,
	})
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

func (s *Server) handleDeleteTagsBatch(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var body struct {
		DeleteAll bool `json:"delete_all"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if body.DeleteAll {
		if err := s.services.Tag.DeleteAll(c.Context(), accountID); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		// Reconcile event participants after bulk tag deletion
		go s.services.Event.ReconcileAllAccountEvents(context.Background(), accountID)
		return c.JSON(fiber.Map{"success": true, "message": "All tags deleted"})
	}

	return c.Status(400).JSON(fiber.Map{"success": false, "error": "provide delete_all: true"})
}

func (s *Server) handleDeleteTag(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid tag ID"})
	}
	if err := s.services.Tag.Delete(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	// Reconcile event participants after tag deletion (lead_tags rows were removed)
	go s.services.Event.ReconcileAllAccountEvents(context.Background(), accountID)
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

	// Push tag change to Kommo (async) — only for leads, NOT contacts
	accountID := c.Locals("account_id").(uuid.UUID)
	if s.kommoSync != nil {
		switch req.EntityType {
		case "lead":
			go s.kommoSync.PushLeadTagsChange(accountID, entityID)
		}
	}

	// Event tag auto-sync: when a tag is assigned to a lead, add to matching events
	if req.EntityType == "lead" {
		go s.services.Event.HandleLeadTagAssigned(context.Background(), accountID, entityID, tagID)
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

	// Push tag change to Kommo (async) — only for leads, NOT contacts
	accountID := c.Locals("account_id").(uuid.UUID)
	if s.kommoSync != nil {
		switch req.EntityType {
		case "lead":
			go s.kommoSync.PushLeadTagsChange(accountID, entityID)
		}
	}

	// Event tag auto-sync: when a tag is removed from a lead, check event membership
	if req.EntityType == "lead" {
		go s.services.Event.HandleLeadTagRemoved(context.Background(), accountID, entityID, tagID)
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
	// Load attachments for each campaign
	for _, camp := range campaigns {
		attachments, _ := s.repos.CampaignAttachment.GetByCampaignID(c.Context(), camp.ID)
		camp.Attachments = attachments
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
		Attachments     []struct {
			MediaURL  string `json:"media_url"`
			MediaType string `json:"media_type"`
			Caption   string `json:"caption"`
			FileName  string `json:"file_name"`
			FileSize  int64  `json:"file_size"`
			Position  int    `json:"position"`
		} `json:"attachments"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" || req.DeviceID == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "name and device_id are required"})
	}
	// At least message or attachments required
	if req.MessageTemplate == "" && len(req.Attachments) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "message_template or attachments required"})
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
	// Set created_by from authenticated user
	if userID, ok := c.Locals("user_id").(uuid.UUID); ok {
		campaign.CreatedBy = &userID
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

	// Save attachments if provided
	if len(req.Attachments) > 0 {
		var attachments []*domain.CampaignAttachment
		for _, a := range req.Attachments {
			attachments = append(attachments, &domain.CampaignAttachment{
				MediaURL:  a.MediaURL,
				MediaType: a.MediaType,
				Caption:   a.Caption,
				FileName:  a.FileName,
				FileSize:  a.FileSize,
				Position:  a.Position,
			})
		}
		if err := s.repos.CampaignAttachment.CreateBatch(c.Context(), campaign.ID, attachments); err != nil {
			log.Printf("[Campaign] Failed to save attachments: %v", err)
		}
		campaign.Attachments = attachments
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
	// Load attachments
	attachments, _ := s.repos.CampaignAttachment.GetByCampaignID(c.Context(), id)
	campaign.Attachments = attachments
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
	// Load attachments for response
	attachments, _ := s.repos.CampaignAttachment.GetByCampaignID(c.Context(), campaign.ID)
	campaign.Attachments = attachments
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

func (s *Server) handleBatchDeleteCampaigns(c *fiber.Ctx) error {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	deleted := 0
	for _, idStr := range req.IDs {
		id, err := uuid.Parse(idStr)
		if err != nil {
			continue
		}
		if err := s.services.Campaign.Delete(c.Context(), id); err == nil {
			deleted++
		}
	}
	return c.JSON(fiber.Map{"success": true, "deleted": deleted})
}

func (s *Server) handleAddCampaignRecipients(c *fiber.Ctx) error {
	campaignID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	acctUUID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		Recipients []struct {
			ContactID *string                `json:"contact_id"`
			JID       string                 `json:"jid"`
			Name      *string                `json:"name"`
			Phone     *string                `json:"phone"`
			Metadata  map[string]interface{} `json:"metadata"`
		} `json:"recipients"`
		SaveAsContacts bool `json:"save_as_contacts"`
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
			Metadata:   r.Metadata,
		}
		if r.ContactID != nil {
			if cid, err := uuid.Parse(*r.ContactID); err == nil {
				rec.ContactID = &cid
			}
		}
		// Optionally create/link as contacts
		if req.SaveAsContacts && rec.ContactID == nil && r.Phone != nil && *r.Phone != "" {
			jid := r.JID
			phone := *r.Phone
			name := ""
			if r.Name != nil {
				name = *r.Name
			}
			contact, err := s.services.Contact.GetOrCreate(c.Context(), acctUUID, nil, jid, phone, name, "", false)
			if err == nil && contact != nil {
				rec.ContactID = &contact.ID
			}
		}
		// Auto-populate nombre_corto from contact's short_name if not already set
		if rec.ContactID != nil {
			if rec.Metadata == nil || rec.Metadata["nombre_corto"] == nil || rec.Metadata["nombre_corto"] == "" {
				ct, _ := s.repos.Contact.GetByID(c.Context(), *rec.ContactID)
				if ct != nil && ct.ShortName != nil && *ct.ShortName != "" {
					if rec.Metadata == nil {
						rec.Metadata = make(map[string]interface{})
					}
					rec.Metadata["nombre_corto"] = *ct.ShortName
				}
			}
		}
		recipients = append(recipients, rec)
	}
	if err := s.services.Campaign.AddRecipients(c.Context(), recipients); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "count": len(recipients)})
}

// handleAddCampaignRecipientsFromLeads adds all leads matching filter criteria
// as campaign recipients server-side. This avoids the client-side pagination
// limitation where only loaded leads (e.g. 50) would be sent.
func (s *Server) handleAddCampaignRecipientsFromLeads(c *fiber.Ctx) error {
	campaignID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)

	// Parse the same filter params used by the leads list endpoint
	search := strings.TrimSpace(c.Query("search"))
	tagNamesRaw := c.Query("tag_names")
	tagMode := strings.ToUpper(c.Query("tag_mode", "OR"))
	excludeTagNamesRaw := c.Query("exclude_tag_names")
	tagFormulaRaw := c.Query("tag_formula")
	stageIDsRaw := c.Query("stage_ids")
	pipelineID := c.Query("pipeline_id")

	// Parse device_ids
	deviceIDs := c.Context().QueryArgs().PeekMulti("device_ids")
	var deviceUUIDs []uuid.UUID
	for _, did := range deviceIDs {
		if id, err := uuid.Parse(string(did)); err == nil {
			deviceUUIDs = append(deviceUUIDs, id)
		}
	}

	// Build WHERE — same logic as handleGetLeadsListPaginated
	args := []interface{}{accountID}
	argIdx := 2
	whereClauses := []string{"l.account_id = $1", "COALESCE(l.phone, '') != ''"}

	if pipelineID != "" {
		if pid, err := uuid.Parse(pipelineID); err == nil {
			whereClauses = append(whereClauses, fmt.Sprintf("(l.pipeline_id = $%d OR l.pipeline_id IS NULL)", argIdx))
			args = append(args, pid)
			argIdx++
		}
	}
	if search != "" {
		searchPattern := "%" + strings.ToLower(search) + "%"
		whereClauses = append(whereClauses, fmt.Sprintf(
			"(LOWER(COALESCE(l.name,'')) LIKE $%d OR LOWER(COALESCE(l.phone,'')) LIKE $%d OR LOWER(COALESCE(l.email,'')) LIKE $%d OR LOWER(COALESCE(l.company,'')) LIKE $%d OR LOWER(COALESCE(l.last_name,'')) LIKE $%d)",
			argIdx, argIdx, argIdx, argIdx, argIdx,
		))
		args = append(args, searchPattern)
		argIdx++
	}
	if len(deviceUUIDs) > 0 {
		whereClauses = append(whereClauses, fmt.Sprintf("l.jid IN (SELECT DISTINCT jid FROM chats WHERE device_id = ANY($%d))", argIdx))
		args = append(args, deviceUUIDs)
		argIdx++
	}
	var tagNames []string
	if tagNamesRaw != "" {
		tagNames = strings.Split(tagNamesRaw, ",")
	}
	var excludeTagNames []string
	if excludeTagNamesRaw != "" {
		excludeTagNames = strings.Split(excludeTagNamesRaw, ",")
	}
	if tagFormulaRaw != "" {
		fSQL, newArgs, newIdx, fErr := buildAdvancedFormulaSQL(tagFormulaRaw, accountID, args, argIdx)
		if fErr == nil && fSQL != "" {
			whereClauses = append(whereClauses, fSQL)
			args = newArgs
			argIdx = newIdx
		}
	} else if len(tagNames) > 0 || len(excludeTagNames) > 0 {
		tagSQL, newArgs, newIdx := buildTagFormulaSQL(tagNames, excludeTagNames, tagMode, args, argIdx)
		if tagSQL != "" {
			whereClauses = append(whereClauses, tagSQL)
			args = newArgs
			argIdx = newIdx
		}
	}
	if stageIDsRaw != "" {
		var validStageIDs []uuid.UUID
		for _, sid := range strings.Split(stageIDsRaw, ",") {
			if id, err := uuid.Parse(strings.TrimSpace(sid)); err == nil {
				validStageIDs = append(validStageIDs, id)
			}
		}
		if len(validStageIDs) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.stage_id = ANY($%d)", argIdx))
			args = append(args, validStageIDs)
			argIdx++
		}
	}

	addDateFilter(c, "l", leadDateFields, &whereClauses, &args, &argIdx)

	whereSQL := strings.Join(whereClauses, " AND ")

	// Query all matching leads with phone — no LIMIT (we need all for the campaign)
	q := fmt.Sprintf(`
		SELECT l.id, COALESCE(l.name,''), COALESCE(l.last_name,''), COALESCE(l.short_name,''),
		       COALESCE(l.phone,''), COALESCE(l.company,''), l.contact_id
		FROM leads l
		WHERE %s
		ORDER BY l.updated_at DESC
	`, whereSQL)

	rows, err := s.repos.DB().Query(c.Context(), q, args...)
	if err != nil {
		log.Printf("[API] Error querying leads for campaign recipients: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to query leads"})
	}
	defer rows.Close()

	var recipients []*domain.CampaignRecipient
	for rows.Next() {
		var id uuid.UUID
		var name, lastName, shortName, phone, company string
		var contactID *uuid.UUID
		if err := rows.Scan(&id, &name, &lastName, &shortName, &phone, &company, &contactID); err != nil {
			continue
		}
		cleanPhone := strings.Map(func(r rune) rune {
			if r >= '0' && r <= '9' {
				return r
			}
			return -1
		}, phone)
		if cleanPhone == "" {
			continue
		}
		jid := cleanPhone + "@s.whatsapp.net"

		meta := make(map[string]interface{})
		if shortName != "" {
			meta["nombre_corto"] = shortName
		}
		if company != "" {
			meta["empresa"] = company
		}

		fullName := name
		if lastName != "" {
			fullName = name + " " + lastName
		}

		rec := &domain.CampaignRecipient{
			CampaignID: campaignID,
			JID:        jid,
			Name:       &fullName,
			Phone:      &cleanPhone,
			ContactID:  contactID,
			Metadata:   meta,
		}
		recipients = append(recipients, rec)
	}

	if len(recipients) == 0 {
		return c.JSON(fiber.Map{"success": true, "count": 0, "message": "No leads with phone found matching filters"})
	}

	if err := s.services.Campaign.AddRecipients(c.Context(), recipients); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	log.Printf("[API] Added %d recipients from leads to campaign %s", len(recipients), campaignID)
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

func (s *Server) handleDeleteCampaignRecipient(c *fiber.Ctx) error {
	campaignID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	recipientID, err := uuid.Parse(c.Params("rid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid recipient ID"})
	}
	if err := s.services.Campaign.DeleteRecipient(c.Context(), campaignID, recipientID); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleUpdateCampaignRecipient(c *fiber.Ctx) error {
	campaignID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	recipientID, err := uuid.Parse(c.Params("rid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid recipient ID"})
	}
	var body struct {
		Name     *string                `json:"name"`
		Phone    *string                `json:"phone"`
		Metadata map[string]interface{} `json:"metadata"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request body"})
	}
	rec, err := s.services.Campaign.UpdateRecipientData(c.Context(), campaignID, recipientID, body.Name, body.Phone, body.Metadata)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "recipient": rec})
}

func (s *Server) handleStartCampaign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	var startedBy *uuid.UUID
	if userID, ok := c.Locals("user_id").(uuid.UUID); ok {
		startedBy = &userID
	}
	if err := s.services.Campaign.Start(c.Context(), id, startedBy); err != nil {
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

func (s *Server) handleCancelCampaign(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	if err := s.services.Campaign.Cancel(c.Context(), id); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "message": "Campaign cancelled"})
}

func (s *Server) handleRetryCampaignRecipient(c *fiber.Ctx) error {
	campaignID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	recipientID, err := uuid.Parse(c.Params("rid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid recipient ID"})
	}
	if err := s.services.Campaign.RetryRecipient(c.Context(), campaignID, recipientID); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "message": "Mensaje reenviado exitosamente"})
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

func (s *Server) handleUpdateCampaignAttachments(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid campaign ID"})
	}
	var req struct {
		Attachments []struct {
			MediaURL  string `json:"media_url"`
			MediaType string `json:"media_type"`
			Caption   string `json:"caption"`
			FileName  string `json:"file_name"`
			FileSize  int64  `json:"file_size"`
			Position  int    `json:"position"`
		} `json:"attachments"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	// Delete existing and re-create
	s.repos.CampaignAttachment.DeleteByCampaignID(c.Context(), id)
	if len(req.Attachments) > 0 {
		var attachments []*domain.CampaignAttachment
		for _, a := range req.Attachments {
			attachments = append(attachments, &domain.CampaignAttachment{
				MediaURL:  a.MediaURL,
				MediaType: a.MediaType,
				Caption:   a.Caption,
				FileName:  a.FileName,
				FileSize:  a.FileSize,
				Position:  a.Position,
			})
		}
		if err := s.repos.CampaignAttachment.CreateBatch(c.Context(), id, attachments); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
	}
	result, _ := s.repos.CampaignAttachment.GetByCampaignID(c.Context(), id)
	return c.JSON(fiber.Map{"success": true, "attachments": result})
}

// --- People Unified Search Handler ---

func (s *Server) handleSearchPeople(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	search := c.Query("search", "")
	sourceType := c.Query("type", "all") // "all", "contact", "lead"
	limit := c.QueryInt("limit", 50)
	offset := c.QueryInt("offset", 0)
	hasPhone := c.QueryBool("has_phone", false)

	if limit > 200 {
		limit = 200
	}

	var tagIDs []uuid.UUID
	if tagIDsStr := c.Query("tag_ids"); tagIDsStr != "" {
		for _, tidStr := range strings.Split(tagIDsStr, ",") {
			if tid, err := uuid.Parse(strings.TrimSpace(tidStr)); err == nil {
				tagIDs = append(tagIDs, tid)
			}
		}
	}

	// Build shared args: $1 = accountID, $2 = search pattern (if any), $3 = tagIDs (if any)
	args := []interface{}{accountID} // $1
	argNum := 2

	searchArgNum := 0
	if search != "" {
		searchArgNum = argNum
		args = append(args, "%"+search+"%")
		argNum++
	}

	tagArgNum := 0
	if len(tagIDs) > 0 {
		tagArgNum = argNum
		args = append(args, tagIDs)
		argNum++
	}

	var parts []string

	// Contacts sub-query
	if sourceType == "all" || sourceType == "contact" {
		q := `SELECT id, COALESCE(custom_name, name, push_name, phone, jid) as display_name,
		             COALESCE(phone, '') as phone, COALESCE(email, '') as email, 'contact'::text as source_type
		      FROM contacts WHERE account_id = $1 AND is_group = false`
		if searchArgNum > 0 {
			q += fmt.Sprintf(` AND (name ILIKE $%d OR custom_name ILIKE $%d OR push_name ILIKE $%d OR phone ILIKE $%d OR email ILIKE $%d)`,
				searchArgNum, searchArgNum, searchArgNum, searchArgNum, searchArgNum)
		}
		if hasPhone {
			q += " AND phone IS NOT NULL AND phone != ''"
		}
		if tagArgNum > 0 {
			q += fmt.Sprintf(` AND id IN (SELECT contact_id FROM contact_tags WHERE tag_id = ANY($%d))`, tagArgNum)
		}
		parts = append(parts, q)
	}

	// Leads sub-query
	if sourceType == "all" || sourceType == "lead" {
		q := `SELECT id, COALESCE(name, phone, '') as display_name,
		             COALESCE(phone, '') as phone, COALESCE(email, '') as email, 'lead'::text as source_type
		      FROM leads WHERE account_id = $1`
		if searchArgNum > 0 {
			q += fmt.Sprintf(` AND (name ILIKE $%d OR last_name ILIKE $%d OR phone ILIKE $%d OR email ILIKE $%d OR company ILIKE $%d)`,
				searchArgNum, searchArgNum, searchArgNum, searchArgNum, searchArgNum)
		}
		if hasPhone {
			q += " AND phone IS NOT NULL AND phone != ''"
		}
		if tagArgNum > 0 {
			q += fmt.Sprintf(` AND id IN (SELECT lead_id FROM lead_tags WHERE tag_id = ANY($%d))`, tagArgNum)
		}
		parts = append(parts, q)
	}

	if len(parts) == 0 {
		return c.JSON(fiber.Map{"success": true, "people": []domain.Person{}, "total": 0, "limit": limit, "offset": offset})
	}

	unionQuery := strings.Join(parts, " UNION ALL ")

	// Count
	var total int
	if err := s.repos.DB().QueryRow(c.Context(), fmt.Sprintf("SELECT COUNT(*) FROM (%s) sub", unionQuery), args...).Scan(&total); err != nil {
		log.Printf("[API] Error counting people search: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "internal error"})
	}

	// Data with pagination
	dataQuery := fmt.Sprintf(
		"SELECT id, display_name, phone, email, source_type FROM (%s) sub ORDER BY display_name ASC LIMIT $%d OFFSET $%d",
		unionQuery, argNum, argNum+1,
	)
	args = append(args, limit, offset)

	rows, err := s.repos.DB().Query(c.Context(), dataQuery, args...)
	if err != nil {
		log.Printf("[API] Error searching people: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "internal error"})
	}
	defer rows.Close()

	people := make([]domain.Person, 0, limit)
	contactIDs := make([]uuid.UUID, 0)
	leadIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var p domain.Person
		if err := rows.Scan(&p.ID, &p.Name, &p.Phone, &p.Email, &p.SourceType); err != nil {
			continue
		}
		people = append(people, p)
		if p.SourceType == "contact" {
			contactIDs = append(contactIDs, p.ID)
		} else {
			leadIDs = append(leadIDs, p.ID)
		}
	}

	// Batch load tags
	tagMap := make(map[uuid.UUID][]*domain.Tag)

	if len(contactIDs) > 0 {
		tagRows, err := s.repos.DB().Query(c.Context(), `
			SELECT ct.contact_id, t.id, t.name, t.color
			FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
			WHERE ct.contact_id = ANY($1) ORDER BY t.name
		`, contactIDs)
		if err == nil {
			defer tagRows.Close()
			for tagRows.Next() {
				var entityID uuid.UUID
				tag := &domain.Tag{}
				if err := tagRows.Scan(&entityID, &tag.ID, &tag.Name, &tag.Color); err == nil {
					tagMap[entityID] = append(tagMap[entityID], tag)
				}
			}
		}
	}

	if len(leadIDs) > 0 {
		tagRows, err := s.repos.DB().Query(c.Context(), `
			SELECT lt.lead_id, t.id, t.name, t.color
			FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
			WHERE lt.lead_id = ANY($1) ORDER BY t.name
		`, leadIDs)
		if err == nil {
			defer tagRows.Close()
			for tagRows.Next() {
				var entityID uuid.UUID
				tag := &domain.Tag{}
				if err := tagRows.Scan(&entityID, &tag.ID, &tag.Name, &tag.Color); err == nil {
					tagMap[entityID] = append(tagMap[entityID], tag)
				}
			}
		}
	}

	for i := range people {
		people[i].Tags = tagMap[people[i].ID]
	}

	return c.JSON(fiber.Map{
		"success": true,
		"people":  people,
		"total":   total,
		"limit":   limit,
		"offset":  offset,
	})
}

// --- Event Handlers ---

func (s *Server) handleGetEvents(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	filter := domain.EventFilter{
		Search:       c.Query("search"),
		Status:       c.Query("status"),
		FolderFilter: c.Query("folder"),
		Limit:        c.QueryInt("limit", 50),
		Offset:       c.QueryInt("offset", 0),
	}
	events, total, err := s.services.Event.GetByAccountID(c.Context(), accountID, filter)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if events == nil {
		events = make([]*domain.Event, 0)
	}
	// Populate tags for each event
	for _, ev := range events {
		ev.Tags, _ = s.services.Event.GetEventTags(c.Context(), ev.ID)
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
		PipelineID  *string    `json:"pipeline_id"`
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
	if req.PipelineID != nil {
		if pid, err := uuid.Parse(*req.PipelineID); err == nil {
			event.PipelineID = &pid
		}
	}
	// If no pipeline specified, assign default
	if event.PipelineID == nil {
		defPipeline, _ := s.services.Event.GetDefaultPipeline(c.Context(), accountID)
		if defPipeline != nil {
			event.PipelineID = &defPipeline.ID
		}
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
	// Populate event tags
	event.Tags, _ = s.services.Event.GetEventTags(c.Context(), event.ID)
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
		PipelineID  *string    `json:"pipeline_id"`
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
	if req.PipelineID != nil {
		if pid, err := uuid.Parse(*req.PipelineID); err == nil {
			event.PipelineID = &pid
		}
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

// handleGetEventTags returns the tags configured for auto-sync on an event (with negate flag and formula mode).
func (s *Server) handleGetEventTags(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	event, err := s.services.Event.GetByID(c.Context(), eventID)
	if err != nil || event == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Event not found"})
	}
	tags, err := s.services.Event.GetEventTags(c.Context(), eventID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if tags == nil {
		tags = make([]*domain.Tag, 0)
	}
	mode := event.TagFormulaMode
	if mode == "" {
		mode = "OR"
	}
	formulaType := event.TagFormulaType
	if formulaType == "" {
		formulaType = "simple"
	}
	return c.JSON(fiber.Map{
		"success":          true,
		"tags":             tags,
		"formula_mode":     mode,
		"tag_formula":      event.TagFormula,
		"tag_formula_type": formulaType,
	})
}

// handleSetEventTags sets the tags for auto-sync on an event with formula support (AND/OR + excludes).
func (s *Server) handleSetEventTags(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	event, err := s.services.Event.GetByID(c.Context(), eventID)
	if err != nil || event == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Event not found"})
	}

	var req struct {
		TagIDs         []string `json:"tag_ids"`           // backward compat (all include, no exclude)
		FormulaMode    string   `json:"formula_mode"`      // "AND" or "OR" (default "OR")
		IncludeTagIDs  []string `json:"include_tag_ids"`
		ExcludeTagIDs  []string `json:"exclude_tag_ids"`
		TagFormula     string   `json:"tag_formula"`       // text-based formula (advanced mode)
		TagFormulaType string   `json:"tag_formula_type"`  // "simple" or "advanced"
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	formulaType := req.TagFormulaType
	if formulaType == "" {
		formulaType = "simple"
	}

	mode := req.FormulaMode
	if mode == "" {
		mode = "OR"
	}

	// Validate advanced formula syntax
	if formulaType == "advanced" && req.TagFormula != "" {
		if err := formula.Validate(req.TagFormula); err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid formula: " + err.Error()})
		}
	}

	// Parse include tag UUIDs — prefer include_tag_ids, fall back to tag_ids
	var includes []uuid.UUID
	srcIDs := req.IncludeTagIDs
	if len(srcIDs) == 0 {
		srcIDs = req.TagIDs
	}
	for _, tidStr := range srcIDs {
		tid, err := uuid.Parse(tidStr)
		if err != nil {
			continue
		}
		includes = append(includes, tid)
	}

	// Parse exclude tag UUIDs
	var excludes []uuid.UUID
	for _, tidStr := range req.ExcludeTagIDs {
		tid, err := uuid.Parse(tidStr)
		if err != nil {
			continue
		}
		excludes = append(excludes, tid)
	}

	// Update formula fields on the event
	event.TagFormulaMode = mode
	event.TagFormula = req.TagFormula
	event.TagFormulaType = formulaType
	if err := s.services.Event.Update(c.Context(), event); err != nil {
		log.Printf("[EVENT-SYNC] Error updating formula for event %s: %v", eventID, err)
	}

	// Save simple-mode tag entries (include/exclude)
	if err := s.services.Event.SetEventTags(c.Context(), eventID, includes, excludes); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Trigger async reconciliation if event is active
	if event.Status == domain.EventStatusActive {
		go func() {
			ctx := context.Background()
			var stageID *uuid.UUID
			if event.PipelineID != nil {
				stages, _ := s.services.Event.GetPipelineStages(ctx, *event.PipelineID)
				if len(stages) > 0 {
					stageID = &stages[0].ID
				}
			}

			var added, removed int
			var reconcileErr error
			if formulaType == "advanced" && req.TagFormula != "" {
				added, removed, reconcileErr = s.services.Event.ReconcileEventParticipantsAdvanced(ctx, eventID, event.AccountID, req.TagFormula, stageID)
			} else if len(includes) > 0 {
				added, removed, reconcileErr = s.services.Event.ReconcileEventParticipants(ctx, eventID, event.AccountID, mode, includes, excludes, stageID)
			}

			if reconcileErr != nil {
				log.Printf("[EVENT-SYNC] Error reconciling after tag config change for event '%s': %v", event.Name, reconcileErr)
				return
			}
			if added > 0 || removed > 0 {
				log.Printf("[EVENT-SYNC] Event '%s' tag config changed (type=%s): +%d added, -%d removed", event.Name, formulaType, added, removed)
			}
			if s.hub != nil {
				s.hub.BroadcastToAccount(event.AccountID, "event_participant_update", map[string]interface{}{
					"event_id": eventID,
					"action":   "tag_sync_reconcile",
					"added":    added,
					"removed":  removed,
				})
			}
		}()
	}

	// Return updated tags
	tags, _ := s.services.Event.GetEventTags(c.Context(), eventID)
	if tags == nil {
		tags = make([]*domain.Tag, 0)
	}
	return c.JSON(fiber.Map{
		"success":          true,
		"tags":             tags,
		"formula_mode":     mode,
		"tag_formula":      req.TagFormula,
		"tag_formula_type": formulaType,
	})
}

// handleValidateFormula validates a text-based tag formula and returns its structure.
func (s *Server) handleValidateFormula(c *fiber.Ctx) error {
	var req struct {
		Formula string `json:"formula"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	ast, err := formula.Parse(req.Formula)
	if err != nil {
		return c.JSON(fiber.Map{"success": true, "valid": false, "error": err.Error()})
	}

	literals := formula.ExtractLiterals(ast)
	if literals == nil {
		literals = []string{}
	}

	return c.JSON(fiber.Map{
		"success":  true,
		"valid":    true,
		"literals": literals,
		"tree":     ast.String(),
	})
}

func (s *Server) handleGetEventParticipants(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}

	// Pagination
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	limit, _ := strconv.Atoi(c.Query("limit", "10000"))
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}

	// Filters — same params as paginated endpoint
	search := strings.TrimSpace(c.Query("search"))
	tagNamesRaw := c.Query("tag_names")
	tagMode := strings.ToUpper(c.Query("tag_mode", "OR"))
	excludeTagNamesRaw := c.Query("exclude_tag_names")
	tagFormulaRaw := c.Query("tag_formula")
	stageIDsRaw := c.Query("stage_ids")
	var hasPhone *bool
	if hp := c.Query("has_phone"); hp == "true" {
		t := true
		hasPhone = &t
	}

	// Build WHERE
	args := []interface{}{eventID}
	argIdx := 2
	whereClauses := []string{"p.event_id = $1"}

	if search != "" {
		searchPattern := "%" + strings.ToLower(search) + "%"
		whereClauses = append(whereClauses, fmt.Sprintf(
			"(LOWER(COALESCE(p.name,'')) LIKE $%d OR LOWER(COALESCE(p.phone,'')) LIKE $%d OR LOWER(COALESCE(p.email,'')) LIKE $%d OR LOWER(COALESCE(p.last_name,'')) LIKE $%d)",
			argIdx, argIdx, argIdx, argIdx,
		))
		args = append(args, searchPattern)
		argIdx++
	}

	var tagNames []string
	if tagNamesRaw != "" {
		tagNames = strings.Split(tagNamesRaw, ",")
	}
	var excludeTagNames []string
	if excludeTagNamesRaw != "" {
		excludeTagNames = strings.Split(excludeTagNamesRaw, ",")
	}

	if tagFormulaRaw != "" {
		ast, parseErr := formula.Parse(tagFormulaRaw)
		if parseErr == nil && ast != nil {
			innerSQL, innerArgs, buildErr := formula.BuildSQLForParticipants(ast, eventID)
			if buildErr == nil && innerSQL != "" {
				remappedSQL := innerSQL
				for i := len(innerArgs); i >= 1; i-- {
					old := fmt.Sprintf("$%d", i)
					nw := fmt.Sprintf("$%d", argIdx+i-1)
					remappedSQL = strings.ReplaceAll(remappedSQL, old, nw)
				}
				whereClauses = append(whereClauses, fmt.Sprintf("p.id IN (%s)", remappedSQL))
				args = append(args, innerArgs...)
				argIdx += len(innerArgs)
			}
		}
	} else if len(tagNames) > 0 || len(excludeTagNames) > 0 {
		if len(tagNames) > 0 {
			if tagMode == "AND" {
				whereClauses = append(whereClauses, fmt.Sprintf(
					"p.id IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d) GROUP BY p2.id HAVING COUNT(DISTINCT t.name) = $%d)",
					argIdx, argIdx+1,
				))
				args = append(args, tagNames, len(tagNames))
				argIdx += 2
			} else {
				whereClauses = append(whereClauses, fmt.Sprintf(
					"p.id IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
					argIdx,
				))
				args = append(args, tagNames)
				argIdx++
			}
		}
		if len(excludeTagNames) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf(
				"p.id NOT IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
				argIdx,
			))
			args = append(args, excludeTagNames)
			argIdx++
		}
	}

	if hasPhone != nil && *hasPhone {
		whereClauses = append(whereClauses, "p.phone IS NOT NULL AND p.phone != ''")
	}

	if stageIDsRaw != "" {
		var validStageIDs []uuid.UUID
		for _, sid := range strings.Split(stageIDsRaw, ",") {
			if id, err := uuid.Parse(strings.TrimSpace(sid)); err == nil {
				validStageIDs = append(validStageIDs, id)
			}
		}
		if len(validStageIDs) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("p.stage_id = ANY($%d)", argIdx))
			args = append(args, validStageIDs)
			argIdx++
		}
	}

	addDateFilter(c, "p", participantDateFields, &whereClauses, &args, &argIdx)

	whereSQL := strings.Join(whereClauses, " AND ")

	// Count total
	var total int
	countQ := fmt.Sprintf("SELECT COUNT(*) FROM event_participants p WHERE %s", whereSQL)
	_ = s.repos.DB().QueryRow(c.Context(), countQ, args...).Scan(&total)

	// Fetch page
	dataQ := fmt.Sprintf(`
		SELECT p.id, p.event_id, p.contact_id, p.lead_id, p.stage_id,
		       p.name, p.last_name, p.short_name, p.phone, p.email, p.age,
		       p.status, p.notes, p.next_action, p.next_action_date,
		       p.invited_at, p.confirmed_at, p.attended_at,
		       p.created_at, p.updated_at,
		       eps.name AS stage_name, eps.color AS stage_color
		FROM event_participants p
		LEFT JOIN event_pipeline_stages eps ON eps.id = p.stage_id
		WHERE %s
		ORDER BY p.next_action_date ASC NULLS LAST, p.name ASC
		OFFSET %d LIMIT %d
	`, whereSQL, offset, limit)

	rows, err := s.repos.DB().Query(c.Context(), dataQ, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	defer rows.Close()

	var participants []*domain.EventParticipant
	for rows.Next() {
		p := &domain.EventParticipant{}
		if err := rows.Scan(
			&p.ID, &p.EventID, &p.ContactID, &p.LeadID, &p.StageID,
			&p.Name, &p.LastName, &p.ShortName, &p.Phone, &p.Email, &p.Age,
			&p.Status, &p.Notes, &p.NextAction, &p.NextActionDate,
			&p.InvitedAt, &p.ConfirmedAt, &p.AttendedAt,
			&p.CreatedAt, &p.UpdatedAt,
			&p.StageName, &p.StageColor,
		); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		participants = append(participants, p)
	}

	// Load tags for each participant
	for _, p := range participants {
		if p.LeadID == nil {
			p.Tags = make([]*domain.Tag, 0)
			continue
		}
		tagRows, err := s.repos.DB().Query(c.Context(), `
			SELECT t.id, t.account_id, t.name, t.color, t.created_at
			FROM tags t JOIN lead_tags lt ON lt.tag_id = t.id
			WHERE lt.lead_id = $1
		`, *p.LeadID)
		if err == nil {
			for tagRows.Next() {
				tag := &domain.Tag{}
				if err := tagRows.Scan(&tag.ID, &tag.AccountID, &tag.Name, &tag.Color, &tag.CreatedAt); err == nil {
					p.Tags = append(p.Tags, tag)
				}
			}
			tagRows.Close()
		}
		if p.Tags == nil {
			p.Tags = make([]*domain.Tag, 0)
		}
	}

	if participants == nil {
		participants = make([]*domain.EventParticipant, 0)
	}
	return c.JSON(fiber.Map{"success": true, "participants": participants, "total": total})
}

// handleGetEventParticipantsPaginated returns first N participants per stage using ROW_NUMBER()
func (s *Server) handleGetEventParticipantsPaginated(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}

	perStage, _ := strconv.Atoi(c.Query("per_stage", "50"))
	if perStage <= 0 || perStage > 200 {
		perStage = 50
	}
	search := strings.TrimSpace(c.Query("search"))
	tagNamesRaw := c.Query("tag_names")
	tagMode := strings.ToUpper(c.Query("tag_mode", "OR"))
	excludeTagNamesRaw := c.Query("exclude_tag_names")
	tagFormulaRaw := c.Query("tag_formula")
	stageIDsRaw := c.Query("stage_ids")
	var hasPhone *bool
	if hp := c.Query("has_phone"); hp == "true" {
		t := true
		hasPhone = &t
	}

	// Build WHERE clause for participants
	args := []interface{}{eventID}
	argIdx := 2
	whereClauses := []string{"p.event_id = $1"}

	if search != "" {
		searchPattern := "%" + strings.ToLower(search) + "%"
		whereClauses = append(whereClauses, fmt.Sprintf(
			"(LOWER(COALESCE(p.name,'')) LIKE $%d OR LOWER(COALESCE(p.phone,'')) LIKE $%d OR LOWER(COALESCE(p.email,'')) LIKE $%d OR LOWER(COALESCE(p.last_name,'')) LIKE $%d)",
			argIdx, argIdx, argIdx, argIdx,
		))
		args = append(args, searchPattern)
		argIdx++
	}

	var tagNames []string
	if tagNamesRaw != "" {
		tagNames = strings.Split(tagNamesRaw, ",")
	}
	var excludeTagNames []string
	if excludeTagNamesRaw != "" {
		excludeTagNames = strings.Split(excludeTagNamesRaw, ",")
	}

	if tagFormulaRaw != "" {
		ast, parseErr := formula.Parse(tagFormulaRaw)
		if parseErr == nil && ast != nil {
			innerSQL, innerArgs, buildErr := formula.BuildSQLForParticipants(ast, eventID)
			if buildErr == nil && innerSQL != "" {
				remappedSQL := innerSQL
				for i := len(innerArgs); i >= 1; i-- {
					old := fmt.Sprintf("$%d", i)
					nw := fmt.Sprintf("$%d", argIdx+i-1)
					remappedSQL = strings.ReplaceAll(remappedSQL, old, nw)
				}
				whereClauses = append(whereClauses, fmt.Sprintf("p.id IN (%s)", remappedSQL))
				args = append(args, innerArgs...)
				argIdx += len(innerArgs)
			}
		}
	} else if len(tagNames) > 0 || len(excludeTagNames) > 0 {
		if len(tagNames) > 0 {
			if tagMode == "AND" {
				whereClauses = append(whereClauses, fmt.Sprintf(
					"p.id IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d) GROUP BY p2.id HAVING COUNT(DISTINCT t.name) = $%d)",
					argIdx, argIdx+1,
				))
				args = append(args, tagNames, len(tagNames))
				argIdx += 2
			} else {
				whereClauses = append(whereClauses, fmt.Sprintf(
					"p.id IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
					argIdx,
				))
				args = append(args, tagNames)
				argIdx++
			}
		}
		if len(excludeTagNames) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf(
				"p.id NOT IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
				argIdx,
			))
			args = append(args, excludeTagNames)
			argIdx++
		}
	}

	if hasPhone != nil && *hasPhone {
		whereClauses = append(whereClauses, "p.phone IS NOT NULL AND p.phone != ''")
	}

	if stageIDsRaw != "" {
		var validStageIDs []uuid.UUID
		for _, sid := range strings.Split(stageIDsRaw, ",") {
			if id, err := uuid.Parse(strings.TrimSpace(sid)); err == nil {
				validStageIDs = append(validStageIDs, id)
			}
		}
		if len(validStageIDs) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("p.stage_id = ANY($%d)", argIdx))
			args = append(args, validStageIDs)
			argIdx++
		}
	}

	addDateFilter(c, "p", participantDateFields, &whereClauses, &args, &argIdx)

	whereSQL := strings.Join(whereClauses, " AND ")

	// Run 5 goroutines in parallel
	type stageInfo struct {
		ID         uuid.UUID
		PipelineID uuid.UUID
		Name       string
		Color      string
		Position   int
	}
	type stageCount struct {
		StageID uuid.UUID
		Count   int
	}

	var (
		stagesList       []stageInfo
		counts           []stageCount
		paginatedParts   []*domain.EventParticipant
		tagMap           = make(map[uuid.UUID][]*domain.Tag)
		unassignedCount  int
		stagesErr, countsErr, partsErr, tagsErr, unassignedErr error
		wg               sync.WaitGroup
	)

	wg.Add(5)

	// Goroutine 1: Fetch pipeline stages for this event
	go func() {
		defer wg.Done()
		rows, err := s.repos.DB().Query(c.Context(), `
			SELECT s.id, s.pipeline_id, s.name, s.color, s.position
			FROM event_pipeline_stages s
			JOIN events e ON e.pipeline_id = s.pipeline_id
			WHERE e.id = $1
			ORDER BY s.position
		`, eventID)
		if err != nil {
			stagesErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			var si stageInfo
			if err := rows.Scan(&si.ID, &si.PipelineID, &si.Name, &si.Color, &si.Position); err != nil {
				stagesErr = err
				return
			}
			stagesList = append(stagesList, si)
		}
	}()

	// Goroutine 2: Count participants per stage
	go func() {
		defer wg.Done()
		q := fmt.Sprintf(`SELECT p.stage_id, COUNT(*) FROM event_participants p WHERE %s AND p.stage_id IS NOT NULL GROUP BY p.stage_id`, whereSQL)
		rows, err := s.repos.DB().Query(c.Context(), q, args...)
		if err != nil {
			countsErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			var sc stageCount
			if err := rows.Scan(&sc.StageID, &sc.Count); err != nil {
				countsErr = err
				return
			}
			counts = append(counts, sc)
		}
	}()

	// Goroutine 3: First N participants per stage using ROW_NUMBER()
	go func() {
		defer wg.Done()
		q := fmt.Sprintf(`
			WITH ranked AS (
				SELECT p.id, p.event_id, p.contact_id, p.lead_id, p.stage_id,
				       p.name, p.last_name, p.short_name, p.phone, p.email, p.age,
				       p.status, p.notes, p.next_action, p.next_action_date,
				       p.invited_at, p.confirmed_at, p.attended_at,
				       p.created_at, p.updated_at,
				       s.name AS stage_name, s.color AS stage_color, s.position AS stage_position,
				       ROW_NUMBER() OVER (PARTITION BY p.stage_id ORDER BY p.created_at DESC) AS rn
				FROM event_participants p
				LEFT JOIN event_pipeline_stages s ON s.id = p.stage_id
				WHERE %s AND p.stage_id IS NOT NULL
			)
			SELECT id, event_id, contact_id, lead_id, stage_id,
			       name, last_name, short_name, phone, email, age,
			       status, notes, next_action, next_action_date,
			       invited_at, confirmed_at, attended_at,
			       created_at, updated_at,
			       stage_name, stage_color, stage_position
			FROM ranked WHERE rn <= %d
			ORDER BY stage_position NULLS LAST, created_at DESC
		`, whereSQL, perStage)
		rows, err := s.repos.DB().Query(c.Context(), q, args...)
		if err != nil {
			partsErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			p := &domain.EventParticipant{}
			var stagePosition *int
			if err := rows.Scan(
				&p.ID, &p.EventID, &p.ContactID, &p.LeadID, &p.StageID,
				&p.Name, &p.LastName, &p.ShortName, &p.Phone, &p.Email, &p.Age,
				&p.Status, &p.Notes, &p.NextAction, &p.NextActionDate,
				&p.InvitedAt, &p.ConfirmedAt, &p.AttendedAt,
				&p.CreatedAt, &p.UpdatedAt,
				&p.StageName, &p.StageColor, &stagePosition,
			); err != nil {
				partsErr = err
				return
			}
			paginatedParts = append(paginatedParts, p)
		}
	}()

	// Goroutine 4: Tags for all event participants (from lead_tags via lead_id)
	go func() {
		defer wg.Done()
		rows, err := s.repos.DB().Query(c.Context(), `
			SELECT p.id, t.id, t.account_id, t.name, t.color
			FROM event_participants p
			JOIN lead_tags lt ON lt.lead_id = p.lead_id
			JOIN tags t ON t.id = lt.tag_id
			WHERE p.event_id = $1 AND p.lead_id IS NOT NULL
			ORDER BY t.name
		`, eventID)
		if err != nil {
			tagsErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			var partID uuid.UUID
			t := &domain.Tag{}
			if err := rows.Scan(&partID, &t.ID, &t.AccountID, &t.Name, &t.Color); err != nil {
				continue
			}
			tagMap[partID] = append(tagMap[partID], t)
		}
	}()

	// Goroutine 5: Unassigned participants count
	go func() {
		defer wg.Done()
		q := fmt.Sprintf(`SELECT COUNT(*) FROM event_participants p WHERE %s AND (p.stage_id IS NULL)`, whereSQL)
		err := s.repos.DB().QueryRow(c.Context(), q, args...).Scan(&unassignedCount)
		if err != nil {
			unassignedErr = err
		}
	}()

	wg.Wait()

	if partsErr != nil {
		log.Printf("[EVENTS] Paginated participants error: %v", partsErr)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": partsErr.Error()})
	}
	if countsErr != nil {
		log.Printf("[EVENTS] Counts error: %v", countsErr)
	}
	if stagesErr != nil {
		log.Printf("[EVENTS] Stages error: %v", stagesErr)
	}
	if tagsErr != nil {
		log.Printf("[EVENTS] Tags error: %v", tagsErr)
	}
	if unassignedErr != nil {
		log.Printf("[EVENTS] Unassigned count error: %v", unassignedErr)
	}

	// Assign tags to participants
	for _, p := range paginatedParts {
		p.Tags = tagMap[p.ID]
	}

	// Build count map
	countMap := make(map[uuid.UUID]int)
	for _, sc := range counts {
		countMap[sc.StageID] = sc.Count
	}

	// Build response stages
	type stageDataResp struct {
		ID         string                        `json:"id"`
		PipelineID string                        `json:"pipeline_id"`
		Name       string                        `json:"name"`
		Color      string                        `json:"color"`
		Position   int                           `json:"position"`
		TotalCount int                           `json:"total_count"`
		Participants []*domain.EventParticipant  `json:"participants"`
		HasMore    bool                          `json:"has_more"`
	}

	stages := make([]stageDataResp, 0, len(stagesList))
	for _, si := range stagesList {
		total := countMap[si.ID]
		var stageParticipants []*domain.EventParticipant
		for _, p := range paginatedParts {
			if p.StageID != nil && *p.StageID == si.ID {
				stageParticipants = append(stageParticipants, p)
			}
		}
		if stageParticipants == nil {
			stageParticipants = make([]*domain.EventParticipant, 0)
		}
		stages = append(stages, stageDataResp{
			ID:           si.ID.String(),
			PipelineID:   si.PipelineID.String(),
			Name:         si.Name,
			Color:        si.Color,
			Position:     si.Position,
			TotalCount:   total,
			Participants: stageParticipants,
			HasMore:      len(stageParticipants) < total,
		})
	}

	// Unassigned participants
	var unassignedParts []*domain.EventParticipant
	for _, p := range paginatedParts {
		if p.StageID == nil {
			unassignedParts = append(unassignedParts, p)
		}
	}
	// Also query unassigned if not already in paginated (they have stage_id IS NULL excluded from ranked)
	if unassignedCount > 0 {
		q := fmt.Sprintf(`
			SELECT p.id, p.event_id, p.contact_id, p.lead_id, p.stage_id,
			       p.name, p.last_name, p.short_name, p.phone, p.email, p.age,
			       p.status, p.notes, p.next_action, p.next_action_date,
			       p.invited_at, p.confirmed_at, p.attended_at,
			       p.created_at, p.updated_at
			FROM event_participants p
			WHERE %s AND p.stage_id IS NULL
			ORDER BY p.created_at DESC
			LIMIT %d
		`, whereSQL, perStage)
		rows, err := s.repos.DB().Query(c.Context(), q, args...)
		if err == nil {
			defer rows.Close()
			unassignedParts = make([]*domain.EventParticipant, 0)
			for rows.Next() {
				p := &domain.EventParticipant{}
				if err := rows.Scan(
					&p.ID, &p.EventID, &p.ContactID, &p.LeadID, &p.StageID,
					&p.Name, &p.LastName, &p.ShortName, &p.Phone, &p.Email, &p.Age,
					&p.Status, &p.Notes, &p.NextAction, &p.NextActionDate,
					&p.InvitedAt, &p.ConfirmedAt, &p.AttendedAt,
					&p.CreatedAt, &p.UpdatedAt,
				); err != nil {
					continue
				}
				p.Tags = tagMap[p.ID]
				unassignedParts = append(unassignedParts, p)
			}
		}
	}
	if unassignedParts == nil {
		unassignedParts = make([]*domain.EventParticipant, 0)
	}

	// All account tags for filter sidebar (from lead_tags via lead_id)
	var allTags []fiber.Map
	tagRows, err := s.repos.DB().Query(c.Context(), `
		SELECT t.name, t.color, COUNT(DISTINCT ep.id) as cnt
		FROM tags t
		JOIN lead_tags lt ON lt.tag_id = t.id
		JOIN event_participants ep ON ep.lead_id = lt.lead_id
		WHERE ep.event_id = $1 AND ep.lead_id IS NOT NULL
		GROUP BY t.name, t.color
		ORDER BY cnt DESC, t.name
	`, eventID)
	if err == nil {
		defer tagRows.Close()
		for tagRows.Next() {
			var name, color string
			var cnt int
			if err := tagRows.Scan(&name, &color, &cnt); err == nil {
				allTags = append(allTags, fiber.Map{"name": name, "color": color, "count": cnt})
			}
		}
	}
	if allTags == nil {
		allTags = make([]fiber.Map, 0)
	}

	return c.JSON(fiber.Map{
		"success": true,
		"stages":  stages,
		"unassigned": fiber.Map{
			"total_count":  unassignedCount,
			"participants": unassignedParts,
			"has_more":     len(unassignedParts) < unassignedCount,
		},
		"all_tags": allTags,
	})
}

// handleGetEventParticipantsByStage returns paginated participants for a single stage (infinite scroll)
func (s *Server) handleGetEventParticipantsByStage(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	stageIDParam := c.Params("stageId")

	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	search := strings.TrimSpace(c.Query("search"))
	tagNamesRaw := c.Query("tag_names")
	tagMode := strings.ToUpper(c.Query("tag_mode", "OR"))
	excludeTagNamesRaw := c.Query("exclude_tag_names")
	tagFormulaRaw := c.Query("tag_formula")
	var hasPhone *bool
	if hp := c.Query("has_phone"); hp == "true" {
		t := true
		hasPhone = &t
	}

	// Build WHERE
	args := []interface{}{eventID}
	argIdx := 2
	whereClauses := []string{"p.event_id = $1"}

	isUnassigned := stageIDParam == "unassigned"
	if isUnassigned {
		whereClauses = append(whereClauses, "p.stage_id IS NULL")
	} else {
		if stageUUID, err := uuid.Parse(stageIDParam); err == nil {
			whereClauses = append(whereClauses, fmt.Sprintf("p.stage_id = $%d", argIdx))
			args = append(args, stageUUID)
			argIdx++
		} else {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid stage_id"})
		}
	}

	if search != "" {
		searchPattern := "%" + strings.ToLower(search) + "%"
		whereClauses = append(whereClauses, fmt.Sprintf(
			"(LOWER(COALESCE(p.name,'')) LIKE $%d OR LOWER(COALESCE(p.phone,'')) LIKE $%d OR LOWER(COALESCE(p.email,'')) LIKE $%d OR LOWER(COALESCE(p.last_name,'')) LIKE $%d)",
			argIdx, argIdx, argIdx, argIdx,
		))
		args = append(args, searchPattern)
		argIdx++
	}

	var tagNames []string
	if tagNamesRaw != "" {
		tagNames = strings.Split(tagNamesRaw, ",")
	}
	var excludeTagNames []string
	if excludeTagNamesRaw != "" {
		excludeTagNames = strings.Split(excludeTagNamesRaw, ",")
	}

	if tagFormulaRaw != "" {
		ast, parseErr := formula.Parse(tagFormulaRaw)
		if parseErr == nil && ast != nil {
			innerSQL, innerArgs, buildErr := formula.BuildSQLForParticipants(ast, eventID)
			if buildErr == nil && innerSQL != "" {
				remappedSQL := innerSQL
				for i := len(innerArgs); i >= 1; i-- {
					old := fmt.Sprintf("$%d", i)
					nw := fmt.Sprintf("$%d", argIdx+i-1)
					remappedSQL = strings.ReplaceAll(remappedSQL, old, nw)
				}
				whereClauses = append(whereClauses, fmt.Sprintf("p.id IN (%s)", remappedSQL))
				args = append(args, innerArgs...)
				argIdx += len(innerArgs)
			}
		}
	} else if len(tagNames) > 0 || len(excludeTagNames) > 0 {
		if len(tagNames) > 0 {
			if tagMode == "AND" {
				whereClauses = append(whereClauses, fmt.Sprintf(
					"p.id IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d) GROUP BY p2.id HAVING COUNT(DISTINCT t.name) = $%d)",
					argIdx, argIdx+1,
				))
				args = append(args, tagNames, len(tagNames))
				argIdx += 2
			} else {
				whereClauses = append(whereClauses, fmt.Sprintf(
					"p.id IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
					argIdx,
				))
				args = append(args, tagNames)
				argIdx++
			}
		}
		if len(excludeTagNames) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf(
				"p.id NOT IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
				argIdx,
			))
			args = append(args, excludeTagNames)
			argIdx++
		}
	}

	if hasPhone != nil && *hasPhone {
		whereClauses = append(whereClauses, "p.phone IS NOT NULL AND p.phone != ''")
	}

	addDateFilter(c, "p", participantDateFields, &whereClauses, &args, &argIdx)

	whereSQL := strings.Join(whereClauses, " AND ")

	// Query with LIMIT+1 OFFSET
	q := fmt.Sprintf(`
		SELECT p.id, p.event_id, p.contact_id, p.lead_id, p.stage_id,
		       p.name, p.last_name, p.short_name, p.phone, p.email, p.age,
		       p.status, p.notes, p.next_action, p.next_action_date,
		       p.invited_at, p.confirmed_at, p.attended_at,
		       p.created_at, p.updated_at,
		       COALESCE(s.name, '') AS stage_name, COALESCE(s.color, '') AS stage_color
		FROM event_participants p
		LEFT JOIN event_pipeline_stages s ON s.id = p.stage_id
		WHERE %s
		ORDER BY p.created_at DESC
		LIMIT %d OFFSET %d
	`, whereSQL, limit+1, offset)

	rows, err := s.repos.DB().Query(c.Context(), q, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	defer rows.Close()

	participants := make([]*domain.EventParticipant, 0)
	for rows.Next() {
		p := &domain.EventParticipant{}
		if err := rows.Scan(
			&p.ID, &p.EventID, &p.ContactID, &p.LeadID, &p.StageID,
			&p.Name, &p.LastName, &p.ShortName, &p.Phone, &p.Email, &p.Age,
			&p.Status, &p.Notes, &p.NextAction, &p.NextActionDate,
			&p.InvitedAt, &p.ConfirmedAt, &p.AttendedAt,
			&p.CreatedAt, &p.UpdatedAt,
			&p.StageName, &p.StageColor,
		); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		participants = append(participants, p)
	}

	hasMore := len(participants) > limit
	if hasMore {
		participants = participants[:limit]
	}

	// Load tags for returned participants (from lead_tags via lead_id)
	if len(participants) > 0 {
		leadIDs := make([]uuid.UUID, 0, len(participants))
		partToLead := make(map[uuid.UUID]uuid.UUID)
		for _, p := range participants {
			if p.LeadID != nil {
				leadIDs = append(leadIDs, *p.LeadID)
				partToLead[p.ID] = *p.LeadID
			}
		}
		if len(leadIDs) > 0 {
			tagRows, err := s.repos.DB().Query(c.Context(), `
				SELECT lt.lead_id, t.id, t.account_id, t.name, t.color
				FROM lead_tags lt
				JOIN tags t ON t.id = lt.tag_id
				WHERE lt.lead_id = ANY($1)
				ORDER BY t.name
			`, leadIDs)
			if err == nil {
				defer tagRows.Close()
				leadTagMap := make(map[uuid.UUID][]*domain.Tag)
				for tagRows.Next() {
					var leadID uuid.UUID
					t := &domain.Tag{}
					if err := tagRows.Scan(&leadID, &t.ID, &t.AccountID, &t.Name, &t.Color); err == nil {
						leadTagMap[leadID] = append(leadTagMap[leadID], t)
					}
				}
				for _, p := range participants {
					if lid, ok := partToLead[p.ID]; ok {
						p.Tags = leadTagMap[lid]
					}
				}
			}
		}
	}

	return c.JSON(fiber.Map{
		"success":      true,
		"participants": participants,
		"has_more":     hasMore,
	})
}

// handleBatchParticipantObservations returns observations for multiple participants
// It searches interactions by participant_id, contact_id, and lead_id
func (s *Server) handleBatchParticipantObservations(c *fiber.Ctx) error {
	var req struct {
		ParticipantIDs []string `json:"participant_ids"`
		Limit          int      `json:"limit"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if len(req.ParticipantIDs) == 0 {
		return c.JSON(fiber.Map{"success": true, "observations": map[string]interface{}{}})
	}
	if req.Limit <= 0 {
		req.Limit = 5
	}
	if req.Limit > 20 {
		req.Limit = 20
	}

	var partUUIDs []uuid.UUID
	for _, id := range req.ParticipantIDs {
		if uid, err := uuid.Parse(id); err == nil {
			partUUIDs = append(partUUIDs, uid)
		}
	}
	if len(partUUIDs) == 0 {
		return c.JSON(fiber.Map{"success": true, "observations": map[string]interface{}{}})
	}

	// Get participant_id → contact_id and lead_id mappings
	mapRows, err := s.repos.DB().Query(c.Context(), `
		SELECT id, contact_id, lead_id FROM event_participants WHERE id = ANY($1)
	`, partUUIDs)
	if err != nil {
		log.Printf("[API] Error querying participant mapping: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	defer mapRows.Close()

	type partMapping struct {
		contactID *uuid.UUID
		leadID    *uuid.UUID
	}
	partMap := make(map[uuid.UUID]partMapping) // participant_id → mapping
	contactToPart := make(map[uuid.UUID]uuid.UUID)
	leadToPart := make(map[uuid.UUID]uuid.UUID)
	contactUUIDs := make([]uuid.UUID, 0)
	leadUUIDs := make([]uuid.UUID, 0)

	for mapRows.Next() {
		var partID uuid.UUID
		var contactID, leadID *uuid.UUID
		if err := mapRows.Scan(&partID, &contactID, &leadID); err == nil {
			partMap[partID] = partMapping{contactID: contactID, leadID: leadID}
			if contactID != nil {
				contactToPart[*contactID] = partID
				contactUUIDs = append(contactUUIDs, *contactID)
			}
			if leadID != nil {
				leadToPart[*leadID] = partID
				leadUUIDs = append(leadUUIDs, *leadID)
			}
		}
	}

	// Query interactions matching participant_id, contact_id, or lead_id using UNION
	// Priority: direct participant_id match first, then contact_id, then lead_id
	rows, err := s.repos.DB().Query(c.Context(), `
		SELECT participant_id, contact_id, lead_id, id, type, direction, outcome, notes, created_by_name, created_at
		FROM (
			SELECT i.participant_id, i.contact_id, i.lead_id, i.id, i.type, i.direction, i.outcome, i.notes,
			       u.display_name as created_by_name, i.created_at,
			       ROW_NUMBER() OVER (
			         PARTITION BY COALESCE(i.participant_id::text, i.contact_id::text, i.lead_id::text)
			         ORDER BY i.created_at DESC
			       ) as rn
			FROM interactions i
			LEFT JOIN users u ON i.created_by = u.id
			WHERE i.participant_id = ANY($1)
			   OR i.contact_id = ANY($2)
			   OR i.lead_id = ANY($3)
		) sub
		WHERE rn <= $4
		ORDER BY created_at DESC
	`, partUUIDs, contactUUIDs, leadUUIDs, req.Limit)
	if err != nil {
		log.Printf("[API] Error querying batch participant observations: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	defer rows.Close()

	// Deduplicate: track which interactions we've already added per participant
	type obsKey struct {
		partID string
		obsID  string
	}
	seen := make(map[obsKey]bool)
	result := make(map[string][]*domain.Interaction)

	for rows.Next() {
		var participantID, contactID, leadID *uuid.UUID
		i := &domain.Interaction{}
		if err := rows.Scan(&participantID, &contactID, &leadID, &i.ID, &i.Type, &i.Direction, &i.Outcome, &i.Notes, &i.CreatedByName, &i.CreatedAt); err != nil {
			log.Printf("[API] Error scanning batch participant observation row: %v", err)
			continue
		}

		// Resolve which participant this interaction belongs to
		var targetPartID string
		if participantID != nil {
			// Direct participant_id match
			pid := *participantID
			if _, ok := partMap[pid]; ok {
				targetPartID = pid.String()
			}
		}
		if targetPartID == "" && contactID != nil {
			if pid, ok := contactToPart[*contactID]; ok {
				targetPartID = pid.String()
			}
		}
		if targetPartID == "" && leadID != nil {
			if pid, ok := leadToPart[*leadID]; ok {
				targetPartID = pid.String()
			}
		}

		if targetPartID == "" {
			continue
		}

		key := obsKey{partID: targetPartID, obsID: i.ID.String()}
		if seen[key] {
			continue
		}
		seen[key] = true
		if len(result[targetPartID]) < req.Limit {
			result[targetPartID] = append(result[targetPartID], i)
		}
	}

	return c.JSON(fiber.Map{"success": true, "observations": result})
}

func (s *Server) handleAddEventParticipant(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	var req struct {
		ContactID *string `json:"contact_id"`
		LeadID    *string `json:"lead_id"`
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
	if req.LeadID != nil {
		if lid, err := uuid.Parse(*req.LeadID); err == nil {
			p.LeadID = &lid
			// If no contact_id provided, look up the lead's contact_id
			if p.ContactID == nil {
				if lead, err := s.services.Lead.GetByID(c.Context(), lid); err == nil && lead != nil && lead.ContactID != nil {
					p.ContactID = lead.ContactID
				}
			}
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
	if ev, err := s.services.Event.GetByID(c.Context(), eventID); err == nil && ev != nil && s.hub != nil {
		s.hub.BroadcastToAccount(ev.AccountID, ws.EventEventParticipantUpdate, map[string]interface{}{"event_id": eventID.String(), "action": "added"})
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
			LeadID    *string `json:"lead_id"`
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
		if r.LeadID != nil {
			if lid, err := uuid.Parse(*r.LeadID); err == nil {
				p.LeadID = &lid
				if p.ContactID == nil {
					if lead, err := s.services.Lead.GetByID(c.Context(), lid); err == nil && lead != nil && lead.ContactID != nil {
						p.ContactID = lead.ContactID
					}
				}
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
	if ev, err := s.services.Event.GetByID(c.Context(), p.EventID); err == nil && ev != nil && s.hub != nil {
		s.hub.BroadcastToAccount(ev.AccountID, ws.EventEventParticipantUpdate, map[string]interface{}{"event_id": p.EventID.String(), "action": "updated"})
	}

	// If participant has no contact_id, try to find and link by phone
	if p.ContactID == nil && p.Phone != nil && *p.Phone != "" {
		// Get account_id from the event
		event, _ := s.services.Event.GetByID(c.Context(), p.EventID)
		if event != nil {
			contact, _ := s.repos.Contact.GetByPhone(c.Context(), event.AccountID, *p.Phone)
			if contact != nil {
				p.ContactID = &contact.ID
				// Update the participant's contact_id in DB
				s.repos.Participant.LinkContact(c.Context(), p.ID, contact.ID)
			}
		}
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

func (s *Server) handleBulkUpdateEventParticipantStatus(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	// Verify event belongs to account
	ev, err := s.services.Event.GetByID(c.Context(), eventID)
	if err != nil || ev == nil || ev.AccountID != accountID {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Event not found"})
	}
	var req struct {
		ParticipantIDs []string `json:"participant_ids"`
		Status         string   `json:"status"`
	}
	if err := c.BodyParser(&req); err != nil || len(req.ParticipantIDs) == 0 || req.Status == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	ids := make([]uuid.UUID, 0, len(req.ParticipantIDs))
	for _, s := range req.ParticipantIDs {
		id, err := uuid.Parse(s)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid participant ID: " + s})
		}
		ids = append(ids, id)
	}
	if err := s.services.Event.BulkUpdateParticipantStatus(c.Context(), ids, req.Status); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "updated": len(ids)})
}

func (s *Server) handleDeleteEventParticipant(c *fiber.Ctx) error {
	pid, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid participant ID"})
	}
	// Get participant's event_id before deleting
	delPart, _ := s.services.Event.GetParticipant(c.Context(), pid)
	if err := s.services.Event.DeleteParticipant(c.Context(), pid); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if delPart != nil {
		if ev, err := s.services.Event.GetByID(c.Context(), delPart.EventID); err == nil && ev != nil && s.hub != nil {
			s.hub.BroadcastToAccount(ev.AccountID, ws.EventEventParticipantUpdate, map[string]interface{}{"event_id": delPart.EventID.String(), "action": "deleted"})
		}
	}
	return c.JSON(fiber.Map{"success": true})
}

// handleCheckTagImpact checks if adding/removing a tag would cause a participant to leave/join the event
func (s *Server) handleCheckTagImpact(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	pid, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid participant ID"})
	}
	var req struct {
		TagID  string `json:"tag_id"`
		Action string `json:"action"` // "assign" or "remove"
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	tagID, err := uuid.Parse(req.TagID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid tag ID"})
	}

	// Get the event to check its formula
	event, err := s.services.Event.GetByID(c.Context(), eventID)
	if err != nil || event == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Event not found"})
	}
	// If no formula, tag changes can't affect membership
	if event.TagFormula == "" {
		return c.JSON(fiber.Map{"success": true, "would_remove": false, "would_add": false})
	}

	// Get the participant to find their lead_id
	participant, err := s.services.Event.GetParticipant(c.Context(), pid)
	if err != nil || participant == nil || participant.LeadID == nil {
		return c.JSON(fiber.Map{"success": true, "would_remove": false, "would_add": false})
	}

	// Get current lead tags
	currentTags, err := s.services.Tag.GetByEntity(c.Context(), "lead", *participant.LeadID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Get the tag name being changed
	tag, err := s.repos.Tag.GetByID(c.Context(), tagID)
	if err != nil || tag == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Tag not found"})
	}

	// Build current tag names (lowercased)
	currentTagNames := make([]string, len(currentTags))
	for i, t := range currentTags {
		currentTagNames[i] = strings.ToLower(t.Name)
	}

	// Simulate tag change
	newTagNames := make([]string, 0, len(currentTagNames)+1)
	tagNameLower := strings.ToLower(tag.Name)
	if req.Action == "assign" {
		newTagNames = append(newTagNames, currentTagNames...)
		// Check if already present
		found := false
		for _, tn := range currentTagNames {
			if tn == tagNameLower {
				found = true
				break
			}
		}
		if !found {
			newTagNames = append(newTagNames, tagNameLower)
		}
	} else {
		// Remove
		for _, tn := range currentTagNames {
			if tn != tagNameLower {
				newTagNames = append(newTagNames, tn)
			}
		}
	}

	// Parse and evaluate formula
	ast, parseErr := formula.Parse(event.TagFormula)
	if parseErr != nil {
		return c.JSON(fiber.Map{"success": true, "would_remove": false, "would_add": false})
	}

	matchesBefore := formula.Evaluate(ast, currentTagNames)
	matchesAfter := formula.Evaluate(ast, newTagNames)

	return c.JSON(fiber.Map{
		"success":      true,
		"would_remove": matchesBefore && !matchesAfter,
		"would_add":    !matchesBefore && matchesAfter,
	})
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
		Attachments     []struct {
			MediaURL  string `json:"media_url"`
			MediaType string `json:"media_type"`
			Caption   string `json:"caption"`
			FileName  string `json:"file_name"`
			FileSize  int64  `json:"file_size"`
			Position  int    `json:"position"`
		} `json:"attachments"`
		// Filters to select participants
		StageIDs        string   `json:"stage_ids"`
		TagNames        []string `json:"tag_names"`
		TagMode         string   `json:"tag_mode"`
		ExcludeTagNames []string `json:"exclude_tag_names"`
		TagFormula      string   `json:"tag_formula"`
		HasPhone        *bool    `json:"has_phone"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" || req.DeviceID == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "name and device_id are required"})
	}
	if req.MessageTemplate == "" && len(req.Attachments) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "message_template or attachments required"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	// Build WHERE clause for participant filtering (same logic as handleGetEventParticipants)
	pArgs := []interface{}{eventID}
	pArgIdx := 2
	pWhere := []string{"p.event_id = $1", "p.phone IS NOT NULL", "p.phone != ''"}

	if req.TagFormula != "" {
		ast, parseErr := formula.Parse(req.TagFormula)
		if parseErr == nil && ast != nil {
			innerSQL, innerArgs, buildErr := formula.BuildSQLForParticipants(ast, eventID)
			if buildErr == nil && innerSQL != "" {
				remappedSQL := innerSQL
				for i := len(innerArgs); i >= 1; i-- {
					old := fmt.Sprintf("$%d", i)
					nw := fmt.Sprintf("$%d", pArgIdx+i-1)
					remappedSQL = strings.ReplaceAll(remappedSQL, old, nw)
				}
				pWhere = append(pWhere, fmt.Sprintf("p.id IN (%s)", remappedSQL))
				pArgs = append(pArgs, innerArgs...)
				pArgIdx += len(innerArgs)
			}
		}
	} else {
		tagMode := strings.ToUpper(req.TagMode)
		if tagMode == "" {
			tagMode = "OR"
		}
		if len(req.TagNames) > 0 {
			if tagMode == "AND" {
				pWhere = append(pWhere, fmt.Sprintf(
					"p.id IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d) GROUP BY p2.id HAVING COUNT(DISTINCT t.name) = $%d)",
					pArgIdx, pArgIdx+1,
				))
				pArgs = append(pArgs, req.TagNames, len(req.TagNames))
				pArgIdx += 2
			} else {
				pWhere = append(pWhere, fmt.Sprintf(
					"p.id IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
					pArgIdx,
				))
				pArgs = append(pArgs, req.TagNames)
				pArgIdx++
			}
		}
		if len(req.ExcludeTagNames) > 0 {
			pWhere = append(pWhere, fmt.Sprintf(
				"p.id NOT IN (SELECT p2.id FROM event_participants p2 JOIN lead_tags lt ON lt.lead_id = p2.lead_id JOIN tags t ON t.id = lt.tag_id WHERE p2.event_id = $1 AND t.name = ANY($%d))",
				pArgIdx,
			))
			pArgs = append(pArgs, req.ExcludeTagNames)
			pArgIdx++
		}
	}

	if req.StageIDs != "" {
		var validStageIDs []uuid.UUID
		for _, sid := range strings.Split(req.StageIDs, ",") {
			if id, err := uuid.Parse(strings.TrimSpace(sid)); err == nil {
				validStageIDs = append(validStageIDs, id)
			}
		}
		if len(validStageIDs) > 0 {
			pWhere = append(pWhere, fmt.Sprintf("p.stage_id = ANY($%d)", pArgIdx))
			pArgs = append(pArgs, validStageIDs)
			pArgIdx++
		}
	}
	_ = pArgIdx // suppress unused

	// Query participants
	whereSQL := strings.Join(pWhere, " AND ")
	dataQ := fmt.Sprintf(`
		SELECT p.id, p.event_id, p.contact_id, p.lead_id, p.stage_id,
		       p.name, p.last_name, p.short_name, p.phone, p.email, p.age,
		       p.status, p.notes, p.next_action, p.next_action_date,
		       p.invited_at, p.confirmed_at, p.attended_at,
		       p.created_at, p.updated_at,
		       eps.name AS stage_name, eps.color AS stage_color
		FROM event_participants p
		LEFT JOIN event_pipeline_stages eps ON eps.id = p.stage_id
		WHERE %s
		ORDER BY p.name ASC
	`, whereSQL)

	rows, err := s.repos.DB().Query(c.Context(), dataQ, pArgs...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	defer rows.Close()

	var participants []*domain.EventParticipant
	for rows.Next() {
		p := &domain.EventParticipant{}
		if err := rows.Scan(
			&p.ID, &p.EventID, &p.ContactID, &p.LeadID, &p.StageID,
			&p.Name, &p.LastName, &p.ShortName, &p.Phone, &p.Email, &p.Age,
			&p.Status, &p.Notes, &p.NextAction, &p.NextActionDate,
			&p.InvitedAt, &p.ConfirmedAt, &p.AttendedAt,
			&p.CreatedAt, &p.UpdatedAt,
			&p.StageName, &p.StageColor,
		); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		participants = append(participants, p)
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
	// Set created_by from authenticated user
	if userID, ok := c.Locals("user_id").(uuid.UUID); ok {
		campaign.CreatedBy = &userID
	}
	if err := s.services.Campaign.Create(c.Context(), campaign); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Save attachments if provided
	if len(req.Attachments) > 0 {
		var attachments []*domain.CampaignAttachment
		for _, a := range req.Attachments {
			attachments = append(attachments, &domain.CampaignAttachment{
				MediaURL:  a.MediaURL,
				MediaType: a.MediaType,
				Caption:   a.Caption,
				FileName:  a.FileName,
				FileSize:  a.FileSize,
				Position:  a.Position,
			})
		}
		if err := s.repos.CampaignAttachment.CreateBatch(c.Context(), campaign.ID, attachments); err != nil {
			log.Printf("[Campaign] Failed to save event campaign attachments: %v", err)
		}
		campaign.Attachments = attachments
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
		rec := &domain.CampaignRecipient{
			CampaignID: campaign.ID,
			ContactID:  p.ContactID,
			JID:        jid,
			Name:       &fullName,
			Phone:      p.Phone,
		}
		// Store participant's short_name in metadata so {{nombre_corto}} resolves
		if p.ShortName != nil && *p.ShortName != "" {
			rec.Metadata = map[string]interface{}{"nombre_corto": *p.ShortName}
		}
		recipients = append(recipients, rec)
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

// --- Event Folder Handlers ---

func (s *Server) handleGetEventFolders(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	folders, err := s.services.Event.GetFolders(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if folders == nil {
		folders = make([]*domain.EventFolder, 0)
	}
	return c.JSON(fiber.Map{"success": true, "folders": folders})
}

func (s *Server) handleCreateEventFolder(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		ParentID *string `json:"parent_id"`
		Name     string  `json:"name"`
		Color    string  `json:"color"`
		Icon     string  `json:"icon"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	folder := &domain.EventFolder{
		AccountID: accountID,
		Name:      req.Name,
		Color:     req.Color,
		Icon:      req.Icon,
	}
	if req.ParentID != nil && *req.ParentID != "" {
		pid, err := uuid.Parse(*req.ParentID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid parent folder ID"})
		}
		folder.ParentID = &pid
	}
	if err := s.services.Event.CreateFolder(c.Context(), folder); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "folder": folder})
}

func (s *Server) handleUpdateEventFolder(c *fiber.Ctx) error {
	fid, err := uuid.Parse(c.Params("fid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid folder ID"})
	}
	folder, err := s.services.Event.GetFolderByID(c.Context(), fid)
	if err != nil || folder == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Folder not found"})
	}
	var req struct {
		Name  *string `json:"name"`
		Color *string `json:"color"`
		Icon  *string `json:"icon"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name != nil {
		folder.Name = *req.Name
	}
	if req.Color != nil {
		folder.Color = *req.Color
	}
	if req.Icon != nil {
		folder.Icon = *req.Icon
	}
	if err := s.services.Event.UpdateFolder(c.Context(), folder); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "folder": folder})
}

func (s *Server) handleDeleteEventFolder(c *fiber.Ctx) error {
	fid, err := uuid.Parse(c.Params("fid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid folder ID"})
	}
	if err := s.services.Event.DeleteFolder(c.Context(), fid); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleMoveEventToFolder(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	var req struct {
		FolderID *string `json:"folder_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	var folderID *uuid.UUID
	if req.FolderID != nil && *req.FolderID != "" {
		fid, err := uuid.Parse(*req.FolderID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid folder ID"})
		}
		folderID = &fid
	}
	if err := s.services.Event.MoveEventToFolder(c.Context(), eventID, folderID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

// --- Event Pipeline Handlers ---

func (s *Server) handleGetEventPipelines(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	pipelines, err := s.services.Event.GetPipelines(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if pipelines == nil {
		pipelines = make([]*domain.EventPipeline, 0)
	}
	return c.JSON(fiber.Map{"success": true, "pipelines": pipelines})
}

func (s *Server) handleCreateEventPipeline(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		Name        string  `json:"name"`
		Description *string `json:"description"`
		Stages      []struct {
			Name     string `json:"name"`
			Color    string `json:"color"`
			Position int    `json:"position"`
		} `json:"stages"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	pipeline := &domain.EventPipeline{
		AccountID:   accountID,
		Name:        req.Name,
		Description: req.Description,
	}
	if err := s.services.Event.CreatePipeline(c.Context(), pipeline); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	// Create stages if provided
	if len(req.Stages) > 0 {
		var stages []*domain.EventPipelineStage
		for _, s := range req.Stages {
			stages = append(stages, &domain.EventPipelineStage{
				PipelineID: pipeline.ID,
				Name:       s.Name,
				Color:      s.Color,
				Position:   s.Position,
			})
		}
		if err := s.services.Event.ReplaceStages(c.Context(), pipeline.ID, stages); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		pipeline.Stages = stages
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "pipeline": pipeline})
}

func (s *Server) handleGetEventPipeline(c *fiber.Ctx) error {
	pid, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid pipeline ID"})
	}
	pipeline, err := s.services.Event.GetPipeline(c.Context(), pid)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Pipeline not found"})
	}
	// Load participant counts per stage
	counts, _, err := s.services.Event.GetParticipantCountsByStage(c.Context(), pid)
	if err == nil && pipeline.Stages != nil {
		for _, stage := range pipeline.Stages {
			if cnt, ok := counts[stage.ID]; ok {
				stage.ParticipantCount = cnt
			}
		}
	}
	return c.JSON(fiber.Map{"success": true, "pipeline": pipeline})
}

func (s *Server) handleUpdateEventPipeline(c *fiber.Ctx) error {
	pid, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid pipeline ID"})
	}
	pipeline, err := s.services.Event.GetPipeline(c.Context(), pid)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Pipeline not found"})
	}
	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name != nil {
		pipeline.Name = *req.Name
	}
	if req.Description != nil {
		pipeline.Description = req.Description
	}
	if err := s.services.Event.UpdatePipeline(c.Context(), pipeline); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "pipeline": pipeline})
}

func (s *Server) handleDeleteEventPipeline(c *fiber.Ctx) error {
	pid, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid pipeline ID"})
	}
	if err := s.services.Event.DeletePipeline(c.Context(), pid); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleReplaceEventPipelineStages(c *fiber.Ctx) error {
	pid, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid pipeline ID"})
	}
	var req struct {
		Stages []struct {
			ID       *string `json:"id"`
			Name     string  `json:"name"`
			Color    string  `json:"color"`
			Position int     `json:"position"`
		} `json:"stages"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	var stages []*domain.EventPipelineStage
	for _, s := range req.Stages {
		stage := &domain.EventPipelineStage{
			PipelineID: pid,
			Name:       s.Name,
			Color:      s.Color,
			Position:   s.Position,
		}
		if s.ID != nil {
			if id, err := uuid.Parse(*s.ID); err == nil {
				stage.ID = id
			}
		}
		stages = append(stages, stage)
	}
	if err := s.services.Event.ReplaceStages(c.Context(), pid, stages); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	// Return updated stages
	updatedStages, _ := s.services.Event.GetPipelineStages(c.Context(), pid)
	return c.JSON(fiber.Map{"success": true, "stages": updatedStages})
}

func (s *Server) handleUpdateEventParticipantStage(c *fiber.Ctx) error {
	pid, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid participant ID"})
	}
	var req struct {
		StageID string `json:"stage_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	stageID, err := uuid.Parse(req.StageID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid stage ID"})
	}
	if err := s.services.Event.UpdateParticipantStage(c.Context(), pid, stageID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if stagePart, err := s.services.Event.GetParticipant(c.Context(), pid); err == nil && stagePart != nil {
		if ev, err := s.services.Event.GetByID(c.Context(), stagePart.EventID); err == nil && ev != nil && s.hub != nil {
			s.hub.BroadcastToAccount(ev.AccountID, ws.EventEventParticipantUpdate, map[string]interface{}{"event_id": stagePart.EventID.String(), "action": "stage_changed"})
		}
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleBulkUpdateEventParticipantStage(c *fiber.Ctx) error {
	var req struct {
		ParticipantIDs []string `json:"participant_ids"`
		StageID        string   `json:"stage_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	stageID, err := uuid.Parse(req.StageID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid stage ID"})
	}
	var ids []uuid.UUID
	for _, idStr := range req.ParticipantIDs {
		if id, err := uuid.Parse(idStr); err == nil {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No valid participant IDs"})
	}
	if err := s.services.Event.BulkUpdateParticipantStage(c.Context(), ids, stageID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	eventID, _ := uuid.Parse(c.Params("id"))
	if ev, err := s.services.Event.GetByID(c.Context(), eventID); err == nil && ev != nil && s.hub != nil {
		s.hub.BroadcastToAccount(ev.AccountID, ws.EventEventParticipantUpdate, map[string]interface{}{"event_id": eventID.String(), "action": "bulk_stage_changed"})
	}
	return c.JSON(fiber.Map{"success": true, "updated": len(ids)})
}

func (s *Server) handleCreateEventFromLeads(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		// Event data
		Name        string     `json:"name"`
		Description *string    `json:"description"`
		EventDate   *time.Time `json:"event_date"`
		EventEnd    *time.Time `json:"event_end"`
		Location    *string    `json:"location"`
		Color       string     `json:"color"`
		PipelineID  *string    `json:"pipeline_id"`
		// Lead filter criteria
		LeadPipelineID *string  `json:"lead_pipeline_id"`
		Search         string   `json:"search"`
		TagNames       []string `json:"tag_names"`
		StageIDs       []string `json:"stage_ids"`
		DeviceIDs      []string `json:"device_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}

	// Build leads filter query
	args := []interface{}{accountID}
	argIdx := 2
	whereClauses := []string{"l.account_id = $1"}

	if req.LeadPipelineID != nil && *req.LeadPipelineID != "" {
		if pid, err := uuid.Parse(*req.LeadPipelineID); err == nil {
			whereClauses = append(whereClauses, fmt.Sprintf("(l.pipeline_id = $%d OR l.pipeline_id IS NULL)", argIdx))
			args = append(args, pid)
			argIdx++
		}
	}
	if req.Search != "" {
		searchPattern := "%" + strings.ToLower(req.Search) + "%"
		whereClauses = append(whereClauses, fmt.Sprintf(
			"(LOWER(COALESCE(l.name,'')) LIKE $%d OR LOWER(COALESCE(l.phone,'')) LIKE $%d OR LOWER(COALESCE(l.email,'')) LIKE $%d OR LOWER(COALESCE(l.company,'')) LIKE $%d OR LOWER(COALESCE(l.last_name,'')) LIKE $%d)",
			argIdx, argIdx, argIdx, argIdx, argIdx,
		))
		args = append(args, searchPattern)
		argIdx++
	}
	if len(req.DeviceIDs) > 0 {
		var deviceUUIDs []uuid.UUID
		for _, did := range req.DeviceIDs {
			if id, err := uuid.Parse(did); err == nil {
				deviceUUIDs = append(deviceUUIDs, id)
			}
		}
		if len(deviceUUIDs) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.jid IN (SELECT DISTINCT jid FROM chats WHERE device_id = ANY($%d))", argIdx))
			args = append(args, deviceUUIDs)
			argIdx++
		}
	}
	if len(req.TagNames) > 0 {
		whereClauses = append(whereClauses, fmt.Sprintf(
			"l.id IN (SELECT lt.lead_id FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE t.name = ANY($%d))",
			argIdx,
		))
		args = append(args, req.TagNames)
		argIdx++
	}
	if len(req.StageIDs) > 0 {
		var validStageUUIDs []uuid.UUID
		for _, sid := range req.StageIDs {
			if id, err := uuid.Parse(strings.TrimSpace(sid)); err == nil {
				validStageUUIDs = append(validStageUUIDs, id)
			}
		}
		if len(validStageUUIDs) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.stage_id = ANY($%d)", argIdx))
			args = append(args, validStageUUIDs)
			argIdx++
		}
	}

	whereSQL := strings.Join(whereClauses, " AND ")
	query := fmt.Sprintf(`SELECT l.id, l.contact_id, COALESCE(l.name,''), COALESCE(l.last_name,''), COALESCE(l.short_name,''), l.phone, l.email, l.age FROM leads l WHERE %s ORDER BY l.created_at DESC`, whereSQL)

	rows, err := s.repos.DB().Query(c.Context(), query, args...)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to query leads: " + err.Error()})
	}
	defer rows.Close()

	type leadRow struct {
		ID        uuid.UUID
		ContactID *uuid.UUID
		Name      string
		LastName  string
		ShortName string
		Phone     *string
		Email     *string
		Age       *int
	}
	var leads []leadRow
	for rows.Next() {
		var lr leadRow
		if err := rows.Scan(&lr.ID, &lr.ContactID, &lr.Name, &lr.LastName, &lr.ShortName, &lr.Phone, &lr.Email, &lr.Age); err != nil {
			continue
		}
		leads = append(leads, lr)
	}
	if len(leads) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No leads match the given filters"})
	}

	// Create the event
	event := &domain.Event{
		AccountID:   accountID,
		Name:        req.Name,
		Description: req.Description,
		EventDate:   req.EventDate,
		EventEnd:    req.EventEnd,
		Location:    req.Location,
		Color:       req.Color,
		Status:      "active",
		CreatedBy:   &userID,
	}
	if req.PipelineID != nil {
		if pid, err := uuid.Parse(*req.PipelineID); err == nil {
			event.PipelineID = &pid
		}
	}
	if event.PipelineID == nil {
		defPipeline, _ := s.services.Event.GetDefaultPipeline(c.Context(), accountID)
		if defPipeline != nil {
			event.PipelineID = &defPipeline.ID
		}
	}
	if err := s.services.Event.Create(c.Context(), event); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to create event: " + err.Error()})
	}

	// Get the first stage of the event pipeline to assign participants
	var firstStageID *uuid.UUID
	if event.PipelineID != nil {
		stages, err := s.services.Event.GetPipelineStages(c.Context(), *event.PipelineID)
		if err == nil && len(stages) > 0 {
			firstStageID = &stages[0].ID
		}
	}

	// Create participants from leads
	added := 0
	for _, lr := range leads {
		p := &domain.EventParticipant{
			EventID: event.ID,
			Name:    lr.Name,
			Phone:   lr.Phone,
			Email:   lr.Email,
			Age:     lr.Age,
			LeadID:  &lr.ID,
			StageID: firstStageID,
		}
		if lr.LastName != "" {
			p.LastName = &lr.LastName
		}
		if lr.ShortName != "" {
			p.ShortName = &lr.ShortName
		}
		if lr.ContactID != nil {
			p.ContactID = lr.ContactID
		}
		if err := s.services.Event.AddParticipant(c.Context(), p); err != nil {
			log.Printf("[EVENT] Failed to add lead %s as participant: %v", lr.ID, err)
			continue
		}
		added++
	}

	return c.Status(201).JSON(fiber.Map{
		"success":      true,
		"event":        event,
		"leads_found":  len(leads),
		"participants_added": added,
	})
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

	// Push call observations to Kommo if this is a call type with a lead
	if s.kommoSync != nil && interaction.Type == "call" && interaction.LeadID != nil {
		go s.kommoSync.PushLeadObservations(accountID, *interaction.LeadID)
	}

	// Broadcast interaction update via WebSocket
	if s.hub != nil {
		leadIDStr := ""
		if interaction.LeadID != nil {
			leadIDStr = interaction.LeadID.String()
		}
		s.hub.BroadcastToAccount(accountID, ws.EventInteractionUpdate, map[string]interface{}{
			"action":  "created",
			"lead_id": leadIDStr,
		})
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

	// Before deleting, capture lead_id and type for Kommo re-push
	accountID := c.Locals("account_id").(uuid.UUID)
	var interactionLeadID *uuid.UUID
	var interactionType string
	_ = s.repos.DB().QueryRow(c.Context(), `SELECT lead_id, type FROM interactions WHERE id = $1`, id).Scan(&interactionLeadID, &interactionType)

	if err := s.services.Interaction.Delete(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Re-push all call observations to Kommo after deletion
	if s.kommoSync != nil && interactionType == "call" && interactionLeadID != nil {
		go s.kommoSync.PushLeadObservations(accountID, *interactionLeadID)
	}

	// Broadcast interaction update via WebSocket
	if s.hub != nil {
		leadIDStr := ""
		if interactionLeadID != nil {
			leadIDStr = interactionLeadID.String()
		}
		s.hub.BroadcastToAccount(accountID, ws.EventInteractionUpdate, map[string]interface{}{
			"action":  "deleted",
			"lead_id": leadIDStr,
		})
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

// handleBatchLeadObservations returns observations for multiple leads in a single request
func (s *Server) handleBatchLeadObservations(c *fiber.Ctx) error {
	var req struct {
		LeadIDs []string `json:"lead_ids"`
		Limit   int      `json:"limit"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if len(req.LeadIDs) == 0 {
		return c.JSON(fiber.Map{"success": true, "observations": map[string]interface{}{}})
	}
	if req.Limit <= 0 {
		req.Limit = 5
	}
	if req.Limit > 20 {
		req.Limit = 20
	}

	var leadUUIDs []uuid.UUID
	for _, id := range req.LeadIDs {
		if uid, err := uuid.Parse(id); err == nil {
			leadUUIDs = append(leadUUIDs, uid)
		}
	}
	if len(leadUUIDs) == 0 {
		return c.JSON(fiber.Map{"success": true, "observations": map[string]interface{}{}})
	}

	// Use a window function to get top N observations per lead in a single query
	rows, err := s.repos.DB().Query(c.Context(), `
		SELECT lead_id, id, type, direction, outcome, notes, created_by_name, created_at
		FROM (
			SELECT i.lead_id, i.id, i.type, i.direction, i.outcome, i.notes,
			       u.display_name as created_by_name, i.created_at,
			       ROW_NUMBER() OVER (PARTITION BY i.lead_id ORDER BY i.created_at DESC) as rn
			FROM interactions i
			LEFT JOIN users u ON i.created_by = u.id
			WHERE i.lead_id = ANY($1)
		) sub
		WHERE rn <= $2
		ORDER BY lead_id, created_at DESC
	`, leadUUIDs, req.Limit)
	if err != nil {
		log.Printf("[API] Error querying batch observations: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	defer rows.Close()

	result := make(map[string][]*domain.Interaction)
	for rows.Next() {
		var leadID uuid.UUID
		i := &domain.Interaction{}
		if err := rows.Scan(&leadID, &i.ID, &i.Type, &i.Direction, &i.Outcome, &i.Notes, &i.CreatedByName, &i.CreatedAt); err != nil {
			log.Printf("[API] Error scanning batch observation row: %v", err)
			continue
		}
		lid := leadID.String()
		result[lid] = append(result[lid], i)
	}

	return c.JSON(fiber.Map{"success": true, "observations": result})
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
	accountID := c.Locals("account_id").(uuid.UUID)

	var leadCount, contactCount int
	_ = s.repos.DB().QueryRow(c.Context(),
		`SELECT COUNT(*) FROM leads WHERE account_id = $1`, accountID).Scan(&leadCount)
	_ = s.repos.DB().QueryRow(c.Context(),
		`SELECT COUNT(*) FROM contacts WHERE account_id = $1`, accountID).Scan(&contactCount)

	return c.JSON(fiber.Map{
		"success": true,
		"stats": fiber.Map{
			"connected_devices": s.pool.GetConnectedCount(),
			"ws_clients":        s.hub.GetClientCount(),
			"leads":             leadCount,
			"contacts":          contactCount,
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

// StartEventTagSyncWorker starts the background worker that periodically reconciles
// event participants based on configured tags. Should be called from main.go.
func (s *Server) StartEventTagSyncWorker(ctx context.Context) {
	go func() {
		log.Println("[EVENT-SYNC] 🏷️ Event tag sync worker started (interval: 60s)")
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()

		// Run initial reconciliation after a short delay
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
			s.runEventTagSync(ctx)
		}

		for {
			select {
			case <-ctx.Done():
				log.Println("[EVENT-SYNC] Worker stopped")
				return
			case <-ticker.C:
				s.runEventTagSync(ctx)
			}
		}
	}()
}

func (s *Server) runEventTagSync(ctx context.Context) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[EVENT-SYNC] ⚠️ PANIC recovered: %v", rec)
		}
	}()

	eventsWithTags, err := s.repos.Event.GetActiveEventsWithTags(ctx)
	if err != nil {
		log.Printf("[EVENT-SYNC] Error fetching events with tags: %v", err)
		return
	}
	if len(eventsWithTags) == 0 {
		return
	}

	for _, ewt := range eventsWithTags {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Get default stage for the event
		var stageID *uuid.UUID
		if ewt.Event.PipelineID != nil {
			stages, _ := s.services.Event.GetPipelineStages(ctx, *ewt.Event.PipelineID)
			if len(stages) > 0 {
				stageID = &stages[0].ID
			}
		}

		var added, removed int
		var reconcileErr error
		if ewt.Event.TagFormulaType == "advanced" && ewt.Event.TagFormula != "" {
			added, removed, reconcileErr = s.services.Event.ReconcileEventParticipantsAdvanced(
				ctx, ewt.Event.ID, ewt.Event.AccountID, ewt.Event.TagFormula, stageID,
			)
		} else {
			added, removed, reconcileErr = s.services.Event.ReconcileEventParticipants(
				ctx, ewt.Event.ID, ewt.Event.AccountID, ewt.Event.TagFormulaMode, ewt.Includes, ewt.Excludes, stageID,
			)
		}
		if reconcileErr != nil {
			log.Printf("[EVENT-SYNC] Error reconciling event '%s': %v", ewt.Event.Name, reconcileErr)
			continue
		}
		if added > 0 || removed > 0 {
			log.Printf("[EVENT-SYNC] Event '%s': +%d added, -%d removed", ewt.Event.Name, added, removed)
			if s.hub != nil {
				s.hub.BroadcastToAccount(ewt.Event.AccountID, "event_participant_update", map[string]interface{}{
					"event_id": ewt.Event.ID,
					"action":   "tag_sync_reconcile",
					"added":    added,
					"removed":  removed,
				})
			}
		}
	}
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
		MCPEnabled bool   `json:"mcp_enabled"`
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
		MCPEnabled: req.MCPEnabled,
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

	// Compute permissions for response
	perms := []string{domain.PermAll}
	if !user.IsAdmin && !user.IsSuperAdmin {
		perms, _ = s.repos.UserAccount.GetUserPermissions(c.Context(), userID, targetAccountID)
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
			"permissions":    perms,
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
			"role_id":      ua.RoleID,
			"role_name":    ua.RoleName,
			"permissions":  ua.Permissions,
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
		AccountID string  `json:"account_id"`
		Role      string  `json:"role"`
		RoleID    *string `json:"role_id"`
		IsDefault bool    `json:"is_default"`
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

	// Parse optional role_id
	if req.RoleID != nil && *req.RoleID != "" {
		parsed, err := uuid.Parse(*req.RoleID)
		if err == nil {
			ua.RoleID = &parsed
		}
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

// --- Quick Reply Handlers ---

func (s *Server) handleGetQuickReplies(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	replies, err := s.services.QuickReply.GetByAccountID(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if replies == nil {
		replies = make([]*domain.QuickReply, 0)
	}
	return c.JSON(fiber.Map{"success": true, "quick_replies": replies})
}

func (s *Server) handleCreateQuickReply(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		Shortcut      string `json:"shortcut"`
		Title         string `json:"title"`
		Body          string `json:"body"`
		MediaURL      string `json:"media_url"`
		MediaType     string `json:"media_type"`
		MediaFilename string `json:"media_filename"`
		Attachments   []struct {
			MediaURL      string `json:"media_url"`
			MediaType     string `json:"media_type"`
			MediaFilename string `json:"media_filename"`
			Caption       string `json:"caption"`
		} `json:"attachments"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Shortcut == "" || (req.Body == "" && req.MediaURL == "" && len(req.Attachments) == 0) {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Shortcut and body or media are required"})
	}
	qr := &domain.QuickReply{AccountID: accountID, Shortcut: req.Shortcut, Title: req.Title, Body: req.Body, MediaURL: req.MediaURL, MediaType: req.MediaType, MediaFilename: req.MediaFilename}
	for i, a := range req.Attachments {
		if i >= 5 {
			break
		}
		qr.Attachments = append(qr.Attachments, domain.QuickReplyAttachment{
			MediaURL: a.MediaURL, MediaType: a.MediaType, MediaFilename: a.MediaFilename, Caption: a.Caption, Position: i,
		})
	}
	if err := s.services.QuickReply.Create(c.Context(), qr); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "quick_reply": qr})
}

func (s *Server) handleUpdateQuickReply(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid quick reply ID"})
	}
	var req struct {
		Shortcut      string `json:"shortcut"`
		Title         string `json:"title"`
		Body          string `json:"body"`
		MediaURL      string `json:"media_url"`
		MediaType     string `json:"media_type"`
		MediaFilename string `json:"media_filename"`
		Attachments   []struct {
			MediaURL      string `json:"media_url"`
			MediaType     string `json:"media_type"`
			MediaFilename string `json:"media_filename"`
			Caption       string `json:"caption"`
		} `json:"attachments"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	qr := &domain.QuickReply{ID: id, Shortcut: req.Shortcut, Title: req.Title, Body: req.Body, MediaURL: req.MediaURL, MediaType: req.MediaType, MediaFilename: req.MediaFilename}
	for i, a := range req.Attachments {
		if i >= 5 {
			break
		}
		qr.Attachments = append(qr.Attachments, domain.QuickReplyAttachment{
			MediaURL: a.MediaURL, MediaType: a.MediaType, MediaFilename: a.MediaFilename, Caption: a.Caption, Position: i,
		})
	}
	if err := s.services.QuickReply.Update(c.Context(), qr); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "quick_reply": qr})
}

func (s *Server) handleDeleteQuickReply(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid quick reply ID"})
	}
	if err := s.services.QuickReply.Delete(c.Context(), id); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

// --- Kommo Handlers ---

func (s *Server) handleKommoStatus(c *fiber.Ctx) error {
	configured := s.cfg.KommoAccessToken != "" && s.cfg.KommoSubdomain != ""
	result := fiber.Map{
		"success":    true,
		"configured": configured,
		"subdomain":  s.cfg.KommoSubdomain,
	}
	if configured && s.kommoSync != nil {
		client := kommo.NewClient(s.cfg.KommoSubdomain, s.cfg.KommoAccessToken)
		acc, err := client.GetAccount()
		if err != nil {
			result["connected"] = false
			result["error"] = err.Error()
		} else {
			result["connected"] = true
			result["account"] = fiber.Map{
				"id":       acc.ID,
				"name":     acc.Name,
				"currency": acc.Currency,
				"country":  acc.Country,
			}
		}
	}
	return c.JSON(result)
}

func (s *Server) handleKommoSync(c *fiber.Ctx) error {
	if s.kommoSync == nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "Kommo not configured"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)

	started := s.kommoSync.StartFullSyncAsync(accountID)
	if !started {
		return c.Status(409).JSON(fiber.Map{
			"success": false,
			"error":   "Ya hay una sincronización en curso para esta cuenta",
		})
	}

	// Invalidate cache when sync starts (will be stale)
	s.invalidateLeadsCache(accountID)

	return c.JSON(fiber.Map{
		"success": true,
		"message": "Sincronización iniciada en segundo plano",
	})
}

func (s *Server) handleKommoFullSyncStatus(c *fiber.Ctx) error {
	if s.kommoSync == nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "Kommo not configured"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	status := s.kommoSync.GetFullSyncStatus(accountID)
	if status == nil {
		return c.JSON(fiber.Map{"success": true, "status": nil})
	}
	return c.JSON(fiber.Map{"success": true, "status": status})
}

func (s *Server) handleKommoGetPipelines(c *fiber.Ctx) error {
	if s.kommoSync == nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "Kommo not configured"})
	}
	client := kommo.NewClient(s.cfg.KommoSubdomain, s.cfg.KommoAccessToken)
	pipelines, err := client.GetPipelines()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Also get connected pipelines to mark status
	accountID := c.Locals("account_id").(uuid.UUID)
	connected, _ := s.kommoSync.GetConnectedPipelines(c.Context(), accountID)
	connectedMap := make(map[int64]bool)
	for _, cp := range connected {
		if cp.Enabled {
			connectedMap[cp.KommoPipelineID] = true
		}
	}

	type pipelineInfo struct {
		ID       int    `json:"id"`
		Name     string `json:"name"`
		IsMain   bool   `json:"is_main"`
		Stages   int    `json:"stages"`
		Connected bool  `json:"connected"`
	}
	var result []pipelineInfo
	for _, p := range pipelines {
		result = append(result, pipelineInfo{
			ID:     p.ID,
			Name:   p.Name,
			IsMain: p.IsMain,
			Stages: len(p.Statuses),
			Connected: connectedMap[int64(p.ID)],
		})
	}

	return c.JSON(fiber.Map{"success": true, "pipelines": result})
}

func (s *Server) handleKommoGetConnected(c *fiber.Ctx) error {
	if s.kommoSync == nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "Kommo not configured"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	connected, err := s.kommoSync.GetConnectedPipelines(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if connected == nil {
		connected = []kommo.ConnectedPipeline{}
	}
	return c.JSON(fiber.Map{"success": true, "connected": connected})
}

func (s *Server) handleKommoConnectPipeline(c *fiber.Ctx) error {
	if s.kommoSync == nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "Kommo not configured"})
	}
	kommoID, err := strconv.Atoi(c.Params("kommoId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid pipeline ID"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	cp, err := s.kommoSync.ConnectPipeline(c.Context(), accountID, kommoID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "connected_pipeline": cp})
}

func (s *Server) handleKommoDisconnectPipeline(c *fiber.Ctx) error {
	if s.kommoSync == nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "Kommo not configured"})
	}
	kommoID, err := strconv.Atoi(c.Params("kommoId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid pipeline ID"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	if err := s.kommoSync.DisconnectPipeline(c.Context(), accountID, kommoID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleKommoSyncStatus(c *fiber.Ctx) error {
	if s.kommoSync == nil {
		return c.Status(503).JSON(fiber.Map{"success": false, "error": "Kommo not configured"})
	}
	status := s.kommoSync.GetStatus()
	return c.JSON(fiber.Map{"success": true, "status": status})
}

// --- Admin Role Handlers ---

func (s *Server) handleAdminGetRoles(c *fiber.Ctx) error {
	roles, err := s.services.Role.GetAll(c.Context())
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if roles == nil {
		roles = make([]*domain.Role, 0)
	}
	return c.JSON(fiber.Map{"success": true, "roles": roles})
}

func (s *Server) handleAdminCreateRole(c *fiber.Ctx) error {
	var req struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Permissions []string `json:"permissions"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	if req.Permissions == nil {
		req.Permissions = []string{}
	}

	role := &domain.Role{
		Name:        req.Name,
		Description: req.Description,
		Permissions: req.Permissions,
	}
	if err := s.services.Role.Create(c.Context(), role); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "role": role})
}

func (s *Server) handleAdminUpdateRole(c *fiber.Ctx) error {
	roleID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid role ID"})
	}

	var req struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Permissions []string `json:"permissions"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	if req.Permissions == nil {
		req.Permissions = []string{}
	}

	role := &domain.Role{
		ID:          roleID,
		Name:        req.Name,
		Description: req.Description,
		Permissions: req.Permissions,
	}
	if err := s.services.Role.Update(c.Context(), role); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "role": role})
}

func (s *Server) handleAdminDeleteRole(c *fiber.Ctx) error {
	roleID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid role ID"})
	}

	if err := s.services.Role.Delete(c.Context(), roleID); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

// ─────────────────────────────────────────────────────────
// Health Check Endpoints
// ─────────────────────────────────────────────────────────

// handleHealthCheck is a deep health probe that checks all dependencies.
// Returns 200 with "healthy" if all systems are operational,
// 503 with "degraded" if some dependencies are down.
func (s *Server) handleHealthCheck(c *fiber.Ctx) error {
	ctx, cancel := context.WithTimeout(c.Context(), 5*time.Second)
	defer cancel()

	status := "healthy"
	httpStatus := 200

	// Check PostgreSQL
	dbOk := true
	if err := s.repos.DB().Ping(ctx); err != nil {
		dbOk = false
		status = "degraded"
		httpStatus = 503
	}

	// Check Redis
	redisOk := true
	if s.cache != nil {
		if err := s.cache.Ping(ctx); err != nil {
			redisOk = false
			status = "degraded"
			httpStatus = 503
		}
	} else {
		redisOk = false
	}

	// WhatsApp devices
	devicesConnected := 0
	devicesTotal := 0
	if s.pool != nil {
		devicesConnected = s.pool.GetConnectedCount()
		devicesTotal = s.pool.GetTotalCount()
	}

	// WebSocket clients
	wsClients := 0
	if s.hub != nil {
		wsClients = s.hub.GetClientCount()
	}

	// Uptime
	var uptime string
	if s.pool != nil {
		uptime = time.Since(s.pool.GetStartTime()).Truncate(time.Second).String()
	}

	return c.Status(httpStatus).JSON(fiber.Map{
		"status": status,
		"time":   time.Now(),
		"uptime": uptime,
		"dependencies": fiber.Map{
			"postgres": fiber.Map{"ok": dbOk},
			"redis":    fiber.Map{"ok": redisOk},
		},
		"whatsapp": fiber.Map{
			"devices_connected": devicesConnected,
			"devices_total":     devicesTotal,
		},
		"websocket": fiber.Map{
			"clients": wsClients,
		},
	})
}

// handleDeviceHealth returns detailed per-device health metrics.
// Protected endpoint — requires PermDevices.
func (s *Server) handleDeviceHealth(c *fiber.Ctx) error {
	if s.pool == nil {
		return c.JSON(fiber.Map{"success": true, "devices": []interface{}{}})
	}
	summaries := s.pool.GetHealthSummary()
	return c.JSON(fiber.Map{"success": true, "devices": summaries})
}

