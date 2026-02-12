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
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/internal/whatsapp"
	"github.com/naperu/clarin/internal/ws"
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

	// Initialize API server
	server := api.NewServer(cfg, services, hub, devicePool, store)

	// Start campaign worker
	campaignDone := make(chan struct{})
	go func() {
		defer close(campaignDone)
		log.Println("📢 Campaign worker started")
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-campaignDone:
				return
			case <-ticker.C:
				campaigns, err := services.Campaign.GetRunningCampaigns(context.Background())
				if err != nil || len(campaigns) == 0 {
					continue
				}
				for _, c := range campaigns {
					settings := c.Settings
					minDelay := 30
					maxDelay := 60
					batchSize := 10
					batchPauseMin := 15
					if v, ok := settings["min_delay_seconds"]; ok {
						if f, ok := v.(float64); ok {
							minDelay = int(f)
						}
					}
					if v, ok := settings["max_delay_seconds"]; ok {
						if f, ok := v.(float64); ok {
							maxDelay = int(f)
						}
					}
					if v, ok := settings["batch_size"]; ok {
						if f, ok := v.(float64); ok {
							batchSize = int(f)
						}
					}
					if v, ok := settings["batch_pause_minutes"]; ok {
						if f, ok := v.(float64); ok {
							batchPauseMin = int(f)
						}
					}

					// Process one batch for this campaign
					sentInBatch := 0
					for i := 0; i < batchSize; i++ {
						hasMore, err := services.Campaign.ProcessNextRecipient(context.Background(), c.ID)
						if err != nil || !hasMore {
							break
						}
						sentInBatch++
						// Random delay between messages
						delay := time.Duration(minDelay+rand.Intn(maxDelay-minDelay+1)) * time.Second
						time.Sleep(delay)
					}
					// Pause between batches to avoid detection
					if sentInBatch > 0 && batchPauseMin > 0 {
						log.Printf("[Campaign %s] Batch done: %d sent, pausing %d min", c.ID, sentInBatch, batchPauseMin)
						time.Sleep(time.Duration(batchPauseMin) * time.Minute)
					}
				}
			}
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		log.Println("Shutting down server...")

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
