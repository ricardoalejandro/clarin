package api

import (
	"context"
	"errors"
	"log"
	"path"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

func validTaskPurgeObjectKey(job *domain.TaskMediaGCJob) bool {
	raw := strings.TrimSpace(job.ObjectKey)
	if raw == "" || strings.HasPrefix(raw, "/") || path.Clean(raw) != raw || !strings.HasPrefix(raw, job.AccountID.String()+"/") {
		return false
	}
	return !storage.IsAccountStatusObjectKey(job.AccountID, raw) && !storage.IsAccountPrivateAvatarObjectKey(job.AccountID, raw)
}

func (s *Server) runTaskMediaGC(ctx context.Context) {
	if s.storage == nil || s.repos == nil || s.repos.TaskWork == nil {
		return
	}
	for processed := 0; processed < 50; processed++ {
		job, err := s.repos.TaskWork.ClaimTaskMediaGCJob(ctx)
		if errors.Is(err, pgx.ErrNoRows) || ctx.Err() != nil {
			return
		}
		if err != nil {
			log.Printf("[TaskMediaGC] claim failed: %v", err)
			return
		}
		if !validTaskPurgeObjectKey(job) {
			if err := s.repos.TaskWork.CompleteTaskMediaGCJob(ctx, job, false); err != nil {
				log.Printf("[TaskMediaGC] release protected asset failed: %v", err)
			}
			continue
		}
		prepared, err := s.repos.TaskWork.PrepareTaskMediaGCDeletion(ctx, job)
		if err != nil {
			_ = s.repos.TaskWork.RetryTaskMediaGCJob(ctx, job, err)
			continue
		}
		if !prepared {
			if err := s.repos.TaskWork.CompleteTaskMediaGCJob(ctx, job, false); err != nil {
				log.Printf("[TaskMediaGC] release referenced asset failed: %v", err)
			}
			continue
		}
		if err := s.storage.DeleteFile(ctx, job.ObjectKey); err != nil {
			_ = s.repos.TaskWork.RetryTaskMediaGCJob(ctx, job, err)
			continue
		}
		if err := s.repos.TaskWork.CompleteTaskMediaGCJob(ctx, job, true); err != nil {
			log.Printf("[TaskMediaGC] finalize failed for %s: %v", job.ID, err)
		}
	}
}

func (s *Server) startTaskMediaGCWorker() {
	if s.storage == nil || s.repos == nil || s.repos.TaskWork == nil {
		return
	}
	go func() {
		timer := time.NewTimer(12 * time.Second)
		defer timer.Stop()
		<-timer.C
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			s.runTaskMediaGC(ctx)
			cancel()
			timer.Reset(time.Minute)
			<-timer.C
		}
	}()
}
