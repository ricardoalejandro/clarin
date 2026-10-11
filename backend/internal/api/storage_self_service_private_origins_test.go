package api

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

type storageRecoveryErrorQuerier struct{ err error }

func (q storageRecoveryErrorQuerier) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("recovery authorization must not enumerate private resources")
}
func (q storageRecoveryErrorQuerier) QueryRow(context.Context, string, ...any) pgx.Row {
	return q
}
func (q storageRecoveryErrorQuerier) Scan(...any) error { return q.err }

func TestStoragePrivateRecoveryRevocationIsNotAnInfrastructureFailure(t *testing.T) {
	account, user := uuid.New(), uuid.New()
	actor := storageUseActor{AccountID: account, UserID: user, Claims: &service.JWTClaims{AccountID: account, UserID: user, Role: "member", Permissions: []string{domain.PermTasks, domain.PermSettings}}}
	snapshot := storageUseSnapshot{AccountID: account, Adapter: "private_work", ParentID: uuid.New(), SourceID: uuid.New()}
	// The real Work ACL query intentionally hides a revoked resource by
	// returning no rows. Exercise its repository-to-adapter-to-review mapping.
	for _, queryErr := range []error{pgx.ErrNoRows, fmt.Errorf("wrapped: %w", pgx.ErrNoRows)} {
		err := (storagePrivateUseAdapter{}).AuthorizeRecovery(context.Background(), nil, storageRecoveryErrorQuerier{queryErr}, actor, snapshot, "restore")
		if !errors.Is(err, errStorageUseProtected) || !storageUseSelectionConflict(err) {
			t.Fatalf("revoked Work recovery must be rejected as protected, got %v", err)
		}
	}
	for _, queryErr := range []error{context.DeadlineExceeded, errors.New("database unavailable: no rows in result set")} {
		err := (storagePrivateUseAdapter{}).AuthorizeRecovery(context.Background(), nil, storageRecoveryErrorQuerier{queryErr}, actor, snapshot, "restore")
		if !errors.Is(err, queryErr) || storageUseSelectionConflict(err) {
			t.Fatal("database failure was reclassified as a revoked resource")
		}
	}
}

func TestStoragePrivateDomainConflictsRemainDistinctFromInfrastructure(t *testing.T) {
	for _, err := range []error{repository.ErrTaskAccessDenied, repository.ErrWhiteboardForbidden, repository.ErrTaskWorkNotFound, repository.ErrWhiteboardNotFound} {
		mapped := storagePrivateUseError(fmt.Errorf("wrapped: %w", err))
		if !errors.Is(mapped, errStorageUseProtected) || !storageUseSelectionConflict(mapped) {
			t.Fatalf("hidden or forbidden resource was treated as infrastructure: %v", err)
		}
	}
	for _, err := range []error{repository.ErrTaskAccessRevisionConflict, repository.ErrWhiteboardConflict} {
		mapped := storagePrivateUseError(fmt.Errorf("wrapped: %w", err))
		if !errors.Is(mapped, errStorageUseRestoreConflict) || !storageUseSelectionConflict(mapped) {
			t.Fatalf("domain revision conflict was treated as infrastructure: %v", err)
		}
	}
}
