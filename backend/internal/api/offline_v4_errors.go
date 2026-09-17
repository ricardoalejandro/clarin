package api

import (
	"errors"
	"log"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/repository"
)

func offlineV4RepositoryError(c *fiber.Ctx, err error) error {
	if errors.Is(err, repository.ErrOfflineV4QuotaExceeded) {
		return offlineV3Error(c, 422, "offline_quota_exceeded")
	}
	if errors.Is(err, repository.ErrOfflineSnapshotTooLarge) {
		return offlineV3Error(c, 422, "offline_resource_too_large")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return offlineV3Error(c, 409, "offline_state_conflict")
		case "40001", "40P01":
			return offlineV3Error(c, 409, "offline_retry_required")
		case "23503", "23514":
			return offlineV3Error(c, 400, "invalid_offline_request")
		}
	}
	for _, known := range []error{repository.ErrOfflineV3Invalid, repository.ErrOfflineV3NotFound, repository.ErrOfflineV3AccessDenied, repository.ErrOfflineV3Conflict, repository.ErrOfflineV3KeyExists, repository.ErrOfflineV3DependencyPending, repository.ErrOfflineV3Replay, repository.ErrOfflineV3ReceiptReuse} {
		if errors.Is(err, known) {
			return offlineV3RepositoryError(c, err)
		}
	}
	log.Printf("[OFFLINE_V4] request failed: error_type=%T", err)
	return offlineV3Error(c, 500, "offline_request_failed")
}

func offlineV5RepositoryError(c *fiber.Ctx, err error) error {
	if errors.Is(err, repository.ErrOfflineV3KeyExists) {
		return offlineV3Error(c, fiber.StatusConflict, "offline_key_already_registered")
	}
	return offlineV4RepositoryError(c, err)
}

func offlineV4EffectiveActions(approved []string, writes bool) []string {
	result := make([]string, 0, len(approved))
	for _, action := range approved {
		if !writes && (action == "tasks.create" || action == "tasks.complete") {
			continue
		}
		result = append(result, action)
	}
	return result
}
