package main

import (
	"context"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/api"
	"github.com/naperu/clarin/internal/domain"
	googleclient "github.com/naperu/clarin/internal/google"
	"github.com/naperu/clarin/internal/kommo"
	clarinMCP "github.com/naperu/clarin/internal/mcp"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/internal/whatsapp"
	"github.com/naperu/clarin/internal/ws"
	"github.com/naperu/clarin/pkg/cache"
	"github.com/naperu/clarin/pkg/config"
	"github.com/naperu/clarin/pkg/database"
)

// Version and BuildTime are set via ldflags at build time
var (
	Version   = "dev"
	BuildTime = "unknown"
)

func main() {
	log.Printf("🚀 Clarin CRM v%s (built %s)", Version, BuildTime)
	// Load configuration
	cfg := config.Load()
	cfg.Validate()

	// Initialize database
	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Run migrations
	if err := database.Migrate(db); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}

	// Seed admin user
	if err := database.SeedAdmin(db, cfg); err != nil {
		log.Printf("Warning: Failed to seed admin: %v", err)
	}

	// Migrate event pipelines (one-time backfill for existing accounts)
	if err := database.MigrateEventPipelines(db); err != nil {
		log.Printf("Warning: Failed to migrate event pipelines: %v", err)
	}

	// Seed template surveys for all accounts
	if err := database.SeedTemplateSurveys(db); err != nil {
		log.Printf("Warning: Failed to seed template surveys: %v", err)
	}

	// Initialize storage (MinIO)
	var store *storage.Storage
	if cfg.MinioEndpoint != "" {
		store, err = storage.New(storage.Config{
			Endpoint:  cfg.MinioEndpoint,
			AccessKey: cfg.MinioAccessKey,
			SecretKey: cfg.MinioSecretKey,
			Bucket:    cfg.MinioBucket,
			UseSSL:    cfg.MinioUseSSL,
			PublicURL: cfg.MinioPublicURL,
		})
		if err != nil {
			log.Printf("Warning: Failed to initialize storage: %v (media features will be disabled)", err)
		} else {
			log.Printf("✅ MinIO storage initialized at %s", cfg.MinioEndpoint)
		}
	}

	// Initialize repositories
	repos := repository.NewRepositories(db)

	// Initialize WebSocket hub
	hub := ws.NewHub()
	go hub.Run()

	// Initialize WhatsApp device pool
	devicePool, err := whatsapp.NewDevicePool(cfg, repos, hub)
	if err != nil {
		log.Fatalf("Failed to initialize WhatsApp device pool: %v", err)
	}

	// Set storage on device pool for media handling
	if store != nil {
		devicePool.SetStorage(store)
	}

	// Load existing devices
	ctx := context.Background()
	if err := devicePool.LoadExistingDevices(ctx); err != nil {
		log.Printf("Warning: Failed to load existing devices: %v", err)
	}

	// Initialize services
	services := service.NewServices(repos, devicePool, hub)

	// Initialize Redis cache
	var redisCache *cache.Cache
	if cfg.RedisURL != "" {
		redisCache, err = cache.New(cfg.RedisURL)
		if err != nil {
			log.Printf("Warning: Failed to initialize Redis cache: %v (caching disabled)", err)
		} else {
			log.Printf("✅ Redis cache initialized")
		}
	}

	// Set Redis cache on device pool for lead cache invalidation
	if redisCache != nil {
		devicePool.SetCache(redisCache)
	}

	// Inject Redis cache into automation service and start the engine
	if redisCache != nil {
		services.Automation.SetCache(redisCache)
		services.Auth.SetCache(redisCache)
	}
	services.Automation.Start()
	log.Printf("✅ Automation engine started (50 workers, 500/hr rate limit)")

	// Initialize Kommo integration (optional)
	var kommoSyncSvc *kommo.SyncService
	if cfg.KommoSubdomain != "" && cfg.KommoAccessToken != "" {
		kommoClient := kommo.NewClient(cfg.KommoSubdomain, cfg.KommoAccessToken)
		kommoSyncSvc = kommo.NewSyncService(kommoClient, db, hub)
		kommoSyncSvc.WebhookSecret = cfg.KommoWebhookSecret
		kommoSyncSvc.PublicURL = cfg.PublicURL
		// Wire event reconciliation callback — called after each Kommo sync cycle
		kommoSyncSvc.OnLeadTagsChanged = services.Event.ReconcileAllAccountEvents
		kommoSyncSvc.Start() // Start background sync worker + poller
		log.Printf("✅ Kommo integration configured for %s.kommo.com", cfg.KommoSubdomain)
	}

	// Initialize Google Contacts client (optional)
	var googleClient *googleclient.Client
	if cfg.GoogleClientID != "" && cfg.GoogleClientSecret != "" {
		googleClient = googleclient.NewClient(cfg.GoogleClientID, cfg.GoogleClientSecret, cfg.GoogleRedirectURI)
		log.Printf("✅ Google Contacts integration configured")
	}

	// Initialize API server
	server := api.NewServer(cfg, services, repos, hub, devicePool, store, kommoSyncSvc, redisCache, googleClient, Version)

	// Initialize and start MCP server (Model Context Protocol) for ChatGPT/Claude/Copilot integration
	mcpServer := clarinMCP.New(repos, services, cfg.JWTSecret)
	mcpServer.Start("8081")

	// Start event tag auto-sync worker
	eventSyncCtx, eventSyncCancel := context.WithCancel(context.Background())
	server.StartEventTagSyncWorker(eventSyncCtx)

	// Start task reminder and overdue workers
	taskCtx, taskCancel := context.WithCancel(context.Background())
	go func() {
		for {
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[Task Worker] ⚠️ PANIC recovered: %v — restarting in 10s", r)
						select {
						case <-taskCtx.Done():
							return
						case <-time.After(10 * time.Second):
						}
					}
				}()

				log.Println("📋 Task reminder/overdue worker started")
				reminderTicker := time.NewTicker(30 * time.Second)
				overdueTicker := time.NewTicker(60 * time.Second)
				defer reminderTicker.Stop()
				defer overdueTicker.Stop()
				for {
					select {
					case <-taskCtx.Done():
						log.Println("[Task Worker] Shutting down")
						return
					case <-reminderTicker.C:
						services.Task.ProcessReminders(taskCtx)
					case <-overdueTicker.C:
						services.Task.ProcessOverdueTasks(taskCtx)
					}
				}
			}()
			if taskCtx.Err() != nil {
				return
			}
		}
	}()

	// Recover orphaned campaigns that were running when the process last died.
	// Mark them as paused so they can be reviewed/restarted manually.
	go func() {
		orphaned, err := services.Campaign.GetRunningCampaigns(context.Background())
		if err != nil {
			log.Printf("[Campaign Recovery] Failed to check orphaned campaigns: %v", err)
			return
		}
		for _, c := range orphaned {
			if c.Status == "running" {
				if pauseErr := services.Campaign.Pause(context.Background(), c.ID); pauseErr != nil {
					log.Printf("[Campaign Recovery] Failed to pause orphaned campaign %s: %v", c.ID, pauseErr)
				} else {
					log.Printf("[Campaign Recovery] ⏸️ Paused orphaned campaign %s (was running when process died)", c.ID)
				}
			}
		}
	}()

	// Start parallel campaign scheduler — one goroutine per active campaign.
	// The scheduler polls for running/scheduled campaigns every 5s and spawns
	// a dedicated goroutine for each one. Each goroutine owns its campaign's
	// lifecycle (batching, delays, pauses) and terminates when the campaign
	// completes, is paused, or the process shuts down.
	campaignCtx, campaignCancel := context.WithCancel(context.Background())
	var activeCampaigns sync.Map // map[uuid.UUID]context.CancelFunc

	// campaignWorker runs in its own goroutine for a single campaign.
	campaignWorker := func(cCtx context.Context, campaignID uuid.UUID) {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[Campaign %s] ⚠️ PANIC recovered in worker: %v", campaignID, r)
			}
			activeCampaigns.Delete(campaignID)
			log.Printf("[Campaign %s] Worker stopped", campaignID)
		}()

		log.Printf("[Campaign %s] Worker started", campaignID)

		for {
			// Re-fetch campaign to get fresh status and settings each cycle
			campaigns, err := services.Campaign.GetRunningCampaigns(cCtx)
			if err != nil {
				log.Printf("[Campaign %s] ⚠️ Failed to fetch campaign: %v", campaignID, err)
				return
			}
			var campaign *domain.Campaign
			for _, c := range campaigns {
				if c.ID == campaignID {
					campaign = c
					break
				}
			}
			if campaign == nil {
				// Campaign no longer running/scheduled — exit
				return
			}

			// Handle scheduled: auto-start when time arrives
			if campaign.Status == "scheduled" {
				if campaign.ScheduledAt != nil && time.Now().Before(*campaign.ScheduledAt) {
					// Not yet time — wait and retry
					select {
					case <-cCtx.Done():
						return
					case <-time.After(10 * time.Second):
					}
					continue
				}
				if err := services.Campaign.Start(cCtx, campaign.ID, nil); err != nil {
					log.Printf("[Campaign %s] Failed to auto-start scheduled: %v", campaignID, err)
					return
				}
				log.Printf("[Campaign %s] Auto-started scheduled campaign", campaignID)
				campaign.Status = "running"
			}

			// Read settings
			settings := campaign.Settings
			minDelay := 8
			maxDelay := 15
			batchSize := 25
			batchPauseMin := 2

			readInt := func(keys []string, def int) int {
				for _, key := range keys {
					if v, ok := settings[key]; ok {
						if f, ok := v.(float64); ok {
							return int(f)
						}
					}
				}
				return def
			}

			minDelay = readInt([]string{"min_delay_seconds", "min_delay"}, minDelay)
			maxDelay = readInt([]string{"max_delay_seconds", "max_delay"}, maxDelay)
			batchSize = readInt([]string{"batch_size"}, batchSize)
			batchPauseMin = readInt([]string{"batch_pause_minutes", "batch_pause"}, batchPauseMin)
			if minDelay > maxDelay {
				minDelay = maxDelay
			}

			// Verify device is connected
			if !devicePool.IsDeviceConnected(campaign.DeviceID) {
				log.Printf("[Campaign %s] ⚠️ Device %s not connected, retrying in 30s", campaignID, campaign.DeviceID)
				select {
				case <-cCtx.Done():
					return
				case <-time.After(30 * time.Second):
				}
				continue
			}

			// Process one batch
			sentInBatch := 0
			var lastSendTime time.Time
			for i := 0; i < batchSize; i++ {
				select {
				case <-cCtx.Done():
					return
				default:
				}
				var waitTimeMs *int
				if !lastSendTime.IsZero() {
					w := int(time.Since(lastSendTime).Milliseconds())
					waitTimeMs = &w
				}
				hasMore, sendErr := services.Campaign.ProcessNextRecipient(cCtx, campaignID, waitTimeMs)
				if !hasMore {
					if i == 0 && sendErr != nil {
						log.Printf("[Campaign %s] ⚠️ ProcessNextRecipient failed: %v", campaignID, sendErr)
					}
					break
				}
				lastSendTime = time.Now()
				sentInBatch++
				delayRange := maxDelay - minDelay
				if delayRange < 0 {
					delayRange = 0
				}
				delay := time.Duration(minDelay+rand.Intn(delayRange+1)) * time.Second
				if sendErr != nil {
					log.Printf("[Campaign %s] ❌ Failed msg %d: %v, waiting %v", campaignID, sentInBatch, sendErr, delay)
				} else {
					log.Printf("[Campaign %s] ✅ Sent msg %d, waiting %v", campaignID, sentInBatch, delay)
				}
				select {
				case <-cCtx.Done():
					return
				case <-time.After(delay):
				}
			}

			if sentInBatch == 0 {
				// No messages were sent (campaign completed or no pending recipients)
				return
			}

			// Pause between batches
			if batchPauseMin > 0 {
				log.Printf("[Campaign %s] Batch done: %d sent, pausing %d min", campaignID, sentInBatch, batchPauseMin)
				select {
				case <-cCtx.Done():
					return
				case <-time.After(time.Duration(batchPauseMin) * time.Minute):
				}
			}
		}
	}

	// Scheduler goroutine: polls for campaigns and spawns workers
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[Campaign Scheduler] ⚠️ PANIC recovered: %v", r)
			}
		}()

		log.Println("📢 Campaign scheduler started (parallel mode)")
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-campaignCtx.Done():
				log.Println("[Campaign Scheduler] Shutting down")
				return
			case <-ticker.C:
				campaigns, err := services.Campaign.GetRunningCampaigns(campaignCtx)
				if err != nil || len(campaigns) == 0 {
					continue
				}
				for _, c := range campaigns {
					if _, loaded := activeCampaigns.Load(c.ID); loaded {
						continue // Already has a worker
					}
					// Spawn a new worker for this campaign
					workerCtx, workerCancel := context.WithCancel(campaignCtx)
					activeCampaigns.Store(c.ID, workerCancel)
					go campaignWorker(workerCtx, c.ID)
				}
			}
		}
	}()

	// Start dynamic WhatsApp queue worker
	dynamicWACtx, dynamicWACancel := context.WithCancel(context.Background())
	go func() {
		for {
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[DynamicWA Worker] ⚠️ PANIC recovered: %v — restarting in 10s", r)
						select {
						case <-dynamicWACtx.Done():
							return
						case <-time.After(10 * time.Second):
						}
					}
				}()

				log.Println("📱 Dynamic WhatsApp queue worker started")
				ticker := time.NewTicker(5 * time.Second)
				defer ticker.Stop()
				for {
					select {
					case <-dynamicWACtx.Done():
						log.Println("[DynamicWA Worker] Shutting down")
						return
					case <-ticker.C:
						pending, err := repos.Dynamic.GetPendingWhatsApp(dynamicWACtx, 25)
						if err != nil || len(pending) == 0 {
							continue
						}
						sentInBatch := 0
						for _, q := range pending {
							select {
							case <-dynamicWACtx.Done():
								return
							default:
							}
							deviceID, err := devicePool.GetFirstConnectedDeviceForAccount(q.AccountID)
							if err != nil {
								log.Printf("[DynamicWA] ❌ No device for account %s: %v", q.AccountID, err)
								_ = repos.Dynamic.UpdateWhatsAppStatus(dynamicWACtx, q.ID, "failed", err.Error())
								continue
							}
							phone := q.Phone + "@s.whatsapp.net"
							_, sendErr := devicePool.SendMediaMessage(dynamicWACtx, deviceID, phone, q.Caption, q.ImageURL, "image")
							if sendErr != nil {
								errMsg := sendErr.Error()
								log.Printf("[DynamicWA] ❌ Failed to send to %s: %v", q.Phone, sendErr)
								_ = repos.Dynamic.UpdateWhatsAppStatus(dynamicWACtx, q.ID, "failed", errMsg)
							} else {
								log.Printf("[DynamicWA] ✅ Sent image to %s", q.Phone)
								// Send second message if configured
								if q.ExtraMediaURL != "" {
									time.Sleep(2 * time.Second)
									_, extraErr := devicePool.SendMediaMessage(dynamicWACtx, deviceID, phone, q.ExtraText, q.ExtraMediaURL, q.ExtraMediaType)
									if extraErr != nil {
										log.Printf("[DynamicWA] ⚠️ Failed to send extra media to %s: %v", q.Phone, extraErr)
									} else {
										log.Printf("[DynamicWA] ✅ Sent extra %s to %s", q.ExtraMediaType, q.Phone)
									}
								} else if q.ExtraText != "" {
									time.Sleep(2 * time.Second)
									_, extraErr := devicePool.SendMessage(dynamicWACtx, deviceID, phone, q.ExtraText)
									if extraErr != nil {
										log.Printf("[DynamicWA] ⚠️ Failed to send extra text to %s: %v", q.Phone, extraErr)
									} else {
										log.Printf("[DynamicWA] ✅ Sent extra text to %s", q.Phone)
									}
								}
								_ = repos.Dynamic.UpdateWhatsAppStatus(dynamicWACtx, q.ID, "sent", "")
							}
							sentInBatch++
							// Rate limit: 10s between sends
							select {
							case <-dynamicWACtx.Done():
								return
							case <-time.After(10 * time.Second):
							}
							// Batch pause: 60s after 25 messages
							if sentInBatch >= 25 {
								log.Printf("[DynamicWA] Batch done: %d sent, pausing 60s", sentInBatch)
								select {
								case <-dynamicWACtx.Done():
									return
								case <-time.After(60 * time.Second):
								}
								sentInBatch = 0
							}
						}
					}
				}
			}()
			if dynamicWACtx.Err() != nil {
				return
			}
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		log.Println("Shutting down server...")

		// Stop automation engine
		services.Automation.Stop()

		// Stop campaign worker
		campaignCancel()

		// Stop dynamic WhatsApp queue worker
		dynamicWACancel()

		// Stop event tag sync worker
		eventSyncCancel()

		// Stop task worker
		taskCancel()

		// Stop Kommo sync worker
		if kommoSyncSvc != nil {
			kommoSyncSvc.Stop()
		}

		// Close all WhatsApp connections
		devicePool.Shutdown()

		// Shutdown server
		if err := server.Shutdown(); err != nil {
			log.Printf("Server shutdown error: %v", err)
		}
	}()

	// Start server
	log.Printf("🚀 Clarin server starting on port %s", cfg.Port)
	if err := server.Listen(":" + cfg.Port); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
