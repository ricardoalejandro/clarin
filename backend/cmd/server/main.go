package main

import (
	"context"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/naperu/clarin/internal/api"
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

func main() {
	// Load configuration
	cfg := config.Load()

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

	// Initialize Kommo integration (optional)
	var kommoSyncSvc *kommo.SyncService
	if cfg.KommoSubdomain != "" && cfg.KommoAccessToken != "" {
		kommoClient := kommo.NewClient(cfg.KommoSubdomain, cfg.KommoAccessToken)
		kommoSyncSvc = kommo.NewSyncService(kommoClient, db, hub)
		// Wire event reconciliation callback — called after each Kommo sync cycle
		kommoSyncSvc.OnLeadTagsChanged = services.Event.ReconcileAllAccountEvents
		kommoSyncSvc.Start() // Start background sync worker + poller
		log.Printf("✅ Kommo integration configured for %s.kommo.com", cfg.KommoSubdomain)
	}

	// Initialize API server
	server := api.NewServer(cfg, services, repos, hub, devicePool, store, kommoSyncSvc, redisCache)

	// Initialize and start MCP server (Model Context Protocol) for ChatGPT/Claude/Copilot integration
	mcpServer := clarinMCP.New(repos, services, cfg.JWTSecret)
	mcpServer.Start("8081")

	// Start event tag auto-sync worker
	eventSyncCtx, eventSyncCancel := context.WithCancel(context.Background())
	server.StartEventTagSyncWorker(eventSyncCtx)

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

	// Start campaign worker with proper context, panic recovery, and cancellable sleeps.
	campaignCtx, campaignCancel := context.WithCancel(context.Background())
	go func() {
		for {
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[Campaign Worker] ⚠️ PANIC recovered: %v — restarting in 10s", r)
						select {
						case <-campaignCtx.Done():
							return
						case <-time.After(10 * time.Second):
						}
					}
				}()

				log.Println("📢 Campaign worker started")
				ticker := time.NewTicker(10 * time.Second)
				defer ticker.Stop()
				for {
					select {
					case <-campaignCtx.Done():
						log.Println("[Campaign Worker] Shutting down")
						return
					case <-ticker.C:
						campaigns, err := services.Campaign.GetRunningCampaigns(campaignCtx)
						if err != nil || len(campaigns) == 0 {
							continue
						}
						for _, c := range campaigns {
							// Check for shutdown between campaigns
							select {
							case <-campaignCtx.Done():
								return
							default:
							}

							// Handle scheduled campaigns: auto-start when time arrives
							if c.Status == "scheduled" {
								if c.ScheduledAt != nil && time.Now().Before(*c.ScheduledAt) {
									continue // Not yet time
								}
								if err := services.Campaign.Start(campaignCtx, c.ID, nil); err != nil {
									log.Printf("[Campaign %s] Failed to auto-start scheduled: %v", c.ID, err)
									continue
								}
								log.Printf("[Campaign %s] Auto-started scheduled campaign", c.ID)
								c.Status = "running"
							}
							settings := c.Settings
							minDelay := 8
							maxDelay := 15
							batchSize := 25
							batchPauseMin := 2

							// Helper to read int from settings (handles both key variants)
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

							// Process one batch for this campaign
							sentInBatch := 0
							var lastSendTime time.Time
							for i := 0; i < batchSize; i++ {
								// Check for shutdown between messages
								select {
								case <-campaignCtx.Done():
									return
								default:
								}
								var waitTimeMs *int
								if !lastSendTime.IsZero() {
									w := int(time.Since(lastSendTime).Milliseconds())
									waitTimeMs = &w
								}
								hasMore, sendErr := services.Campaign.ProcessNextRecipient(campaignCtx, c.ID, waitTimeMs)
								if !hasMore {
									break
								}
								lastSendTime = time.Now()
								sentInBatch++
								// Random delay between messages (cancellable)
								delayRange := maxDelay - minDelay
								if delayRange < 0 {
									delayRange = 0
								}
								delay := time.Duration(minDelay+rand.Intn(delayRange+1)) * time.Second
								if sendErr != nil {
									log.Printf("[Campaign %s] ❌ Failed msg %d: %v, waiting %v", c.ID, sentInBatch, sendErr, delay)
								} else {
									log.Printf("[Campaign %s] ✅ Sent msg %d, waiting %v", c.ID, sentInBatch, delay)
								}
								select {
								case <-campaignCtx.Done():
									return
								case <-time.After(delay):
								}
							}
							// Pause between batches to avoid detection (cancellable)
							if sentInBatch > 0 && batchPauseMin > 0 {
								log.Printf("[Campaign %s] Batch done: %d sent, pausing %d min", c.ID, sentInBatch, batchPauseMin)
								select {
								case <-campaignCtx.Done():
									return
								case <-time.After(time.Duration(batchPauseMin) * time.Minute):
								}
							}
						}
					}
				}
			}()
			// If we get here without a panic, context was cancelled
			if campaignCtx.Err() != nil {
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

		// Stop campaign worker
		campaignCancel()

		// Stop event tag sync worker
		eventSyncCancel()

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
