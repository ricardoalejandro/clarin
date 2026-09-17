package api

import (
	"context"
	"log"
	"time"
)

func (s *Server) startOfflineMaintenance() {
	if s.repos == nil || s.repos.Offline == nil {
		return
	}
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		run := func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if err := s.repos.Offline.CleanupExpiredControlData(ctx); err != nil {
				log.Printf("[OFFLINE] maintenance failed: %v", err)
			}
		}
		run()
		for range ticker.C {
			run()
		}
	}()
}
