package api

import (
	"context"
	"log"
	"time"
)

// This worker transports already-committed task effects only. It cannot run an
// offline mutation or create a receipt; disabling v4 pauses it without deleting
// pending events. Safe error codes avoid logging task descriptions or payloads.
func (s *Server) runOfflineV4TaskOutbox(ctx context.Context) {
	if s.cfg == nil || !s.cfg.OfflineV4Enabled {
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		batchCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
		effects, err := s.repos.OfflineV4.ClaimTaskEffects(batchCtx, 20)
		if err != nil {
			log.Print("[OFFLINE_V4] task_effect_claim_failed")
			cancel()
			continue
		}
		for _, effect := range effects {
			err := s.services.Task.ApplyOfflineV3TaskEffect(batchCtx, effect)
			if err != nil {
				log.Print("[OFFLINE_V4] task_effect_retry")
			}
			if err == nil {
				s.invalidateTasksCache(effect.AccountID)
			}
			if finishErr := s.repos.OfflineV4.FinishTaskEffect(batchCtx, effect, err == nil); finishErr != nil {
				log.Print("[OFFLINE_V4] task_effect_ack_failed")
			}
		}
		cancel()
	}
}
