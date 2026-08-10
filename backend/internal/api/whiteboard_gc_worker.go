package api

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/storage"
)

const (
	whiteboardGCStartDelay = 18 * time.Second
	whiteboardGCInterval   = time.Minute
	whiteboardGCRunTimeout = 45 * time.Second
	whiteboardGCDrainLimit = 50
)

func validWhiteboardGCObjectKey(accountID uuid.UUID, objectKey string) bool {
	return storage.IsAccountWhiteboardObjectKey(accountID, objectKey)
}

func (s *Server) runWhiteboardSnapshotGC(ctx context.Context) {
	for processed := 0; processed < whiteboardGCDrainLimit; processed++ {
		job, err := s.repos.Whiteboard.ClaimWhiteboardSnapshotGCJob(ctx)
		if errors.Is(err, pgx.ErrNoRows) || ctx.Err() != nil {
			return
		}
		if err != nil {
			log.Printf("[WhiteboardGC] snapshot claim failed: %v", err)
			return
		}
		if !validWhiteboardGCObjectKey(job.AccountID, job.ObjectKey) {
			if err := s.repos.Whiteboard.CompleteWhiteboardSnapshotGCJob(ctx, job, false); err != nil {
				log.Printf("[WhiteboardGC] protected snapshot release failed: %v", err)
			}
			continue
		}
		prepared, err := s.repos.Whiteboard.PrepareWhiteboardSnapshotGCDeletion(ctx, job)
		if err != nil {
			if retryErr := s.repos.Whiteboard.RetryWhiteboardSnapshotGCJob(ctx, job, err); retryErr != nil {
				log.Printf("[WhiteboardGC] snapshot retry scheduling failed: %v", retryErr)
			}
			continue
		}
		if !prepared {
			if err := s.repos.Whiteboard.CompleteWhiteboardSnapshotGCJob(ctx, job, false); err != nil {
				log.Printf("[WhiteboardGC] referenced snapshot release failed: %v", err)
			}
			continue
		}
		if err := s.storage.DeleteFile(ctx, job.ObjectKey); err != nil {
			if retryErr := s.repos.Whiteboard.RetryWhiteboardSnapshotGCJob(ctx, job, err); retryErr != nil {
				log.Printf("[WhiteboardGC] snapshot delete retry failed: %v", retryErr)
			}
			continue
		}
		if err := s.repos.Whiteboard.CompleteWhiteboardSnapshotGCJob(ctx, job, true); err != nil {
			// The processing lease makes this recoverable. A repeated MinIO delete
			// is idempotent and the next worker will finish the inventory update.
			log.Printf("[WhiteboardGC] snapshot finalize failed: %v", err)
		}
	}
}

func (s *Server) runWhiteboardMediaGC(ctx context.Context) {
	for processed := 0; processed < whiteboardGCDrainLimit; processed++ {
		job, err := s.repos.Whiteboard.ClaimWhiteboardMediaGCJob(ctx)
		if errors.Is(err, pgx.ErrNoRows) || ctx.Err() != nil {
			return
		}
		if err != nil {
			log.Printf("[WhiteboardGC] media claim failed: %v", err)
			return
		}
		if !validWhiteboardGCObjectKey(job.AccountID, job.ObjectKey) {
			if err := s.repos.Whiteboard.CompleteWhiteboardMediaGCJob(ctx, job, false); err != nil {
				log.Printf("[WhiteboardGC] protected media release failed: %v", err)
			}
			continue
		}
		prepared, err := s.repos.Whiteboard.PrepareWhiteboardMediaGCDeletion(ctx, job)
		if err != nil {
			if retryErr := s.repos.Whiteboard.RetryWhiteboardMediaGCJob(ctx, job, err); retryErr != nil {
				log.Printf("[WhiteboardGC] media retry scheduling failed: %v", retryErr)
			}
			continue
		}
		if !prepared {
			if err := s.repos.Whiteboard.CompleteWhiteboardMediaGCJob(ctx, job, false); err != nil {
				log.Printf("[WhiteboardGC] referenced media release failed: %v", err)
			}
			continue
		}
		if err := s.storage.DeleteFile(ctx, job.ObjectKey); err != nil {
			if retryErr := s.repos.Whiteboard.RetryWhiteboardMediaGCJob(ctx, job, err); retryErr != nil {
				log.Printf("[WhiteboardGC] media delete retry failed: %v", retryErr)
			}
			continue
		}
		if err := s.repos.Whiteboard.CompleteWhiteboardMediaGCJob(ctx, job, true); err != nil {
			log.Printf("[WhiteboardGC] media finalize failed: %v", err)
		}
	}
}

func (s *Server) runWhiteboardRetentionGC(ctx context.Context) {
	if s.storage == nil || s.repos == nil || s.repos.Whiteboard == nil {
		return
	}
	if count, err := s.repos.Whiteboard.EnqueueExpiredWhiteboardRevisions(ctx, 100); err != nil {
		log.Printf("[WhiteboardGC] revision retention sweep failed: %v", err)
		return
	} else if count > 0 {
		log.Printf("[WhiteboardGC] enqueued %d expired automatic revisions", count)
	}
	if count, err := s.repos.Whiteboard.EnqueueUnreferencedWhiteboardAssetLinks(ctx, 100); err != nil {
		log.Printf("[WhiteboardGC] abandoned asset-link sweep failed: %v", err)
		return
	} else if count > 0 {
		log.Printf("[WhiteboardGC] released %d abandoned asset links", count)
	}
	s.runWhiteboardSnapshotGC(ctx)
	s.runWhiteboardMediaGC(ctx)
}

func (s *Server) startWhiteboardRetentionGCWorker() {
	if s.storage == nil || s.repos == nil || s.repos.Whiteboard == nil {
		return
	}
	go func() {
		timer := time.NewTimer(whiteboardGCStartDelay)
		defer timer.Stop()
		<-timer.C
		for {
			ctx, cancel := context.WithTimeout(context.Background(), whiteboardGCRunTimeout)
			s.runWhiteboardRetentionGC(ctx)
			cancel()
			timer.Reset(whiteboardGCInterval)
			<-timer.C
		}
	}()
}
