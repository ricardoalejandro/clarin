package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func whiteboardActorMembershipAllows(role string, permissions []string, active, globalSuperAdmin bool) bool {
	return active && (domain.HasAccountAdminAuthority(role, globalSuperAdmin) ||
		whiteboardPermissionSetAllows(permissions, domain.PermWhiteboards))
}

// lockWhiteboardActorMembershipsTx is the first actor-scoped lock taken by an
// authenticated Whiteboards mutation. Membership removal and role changes lock
// the same rows before advancing location-view/board access revisions, so this
// lock makes the durable order membership -> Work parent -> view -> board.
//
// The per-user authority advisory lock also serializes user activation/default
// account normalization, which cannot be protected by a user_accounts row lock
// alone. UUIDs are canonicalized before either lock so multi-actor callers can
// never acquire the same set in a different order.
func lockWhiteboardActorMembershipsTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID uuid.UUID,
	relatedMembershipIDs ...uuid.UUID,
) error {
	if accountID == uuid.Nil || actorID == uuid.Nil {
		return ErrWhiteboardInvalid
	}
	requested := append([]uuid.UUID{actorID}, relatedMembershipIDs...)
	for _, userID := range requested {
		if userID == uuid.Nil {
			return ErrWhiteboardInvalid
		}
	}
	actors := canonicalAccountMembershipUserIDs(requested)
	for _, userID := range actors {
		if err := lockUserAuthorityTx(ctx, tx, userID); err != nil {
			return err
		}
	}

	locked, err := lockAccountMembershipsKeyShareTx(ctx, tx, accountID, actors)
	if err != nil {
		return err
	}
	if len(locked) != len(actors) {
		return ErrWhiteboardNotFound
	}
	for _, actorID := range actors {
		if _, ok := locked[actorID]; !ok {
			return ErrWhiteboardNotFound
		}
	}

	// Re-read authority only after the advisory and membership locks. If a user
	// deactivation, membership-role change or role-permission update committed
	// first, this statement sees the revoked state and rejects the write. If this
	// mutation acquired the locks first, that authority change waits and becomes
	// ordered after the mutation. Do not take the account authority barrier here:
	// contextual callers must retain Work parent -> barrier -> view -> board.
	var active, globalSuperAdmin bool
	var role string
	var permissions []string
	err = tx.QueryRow(ctx, `SELECT account_user.is_active,COALESCE(account_user.is_super_admin,FALSE),
		membership.role,COALESCE(role_item.permissions,'{}'::text[])
		FROM user_accounts membership
		JOIN users account_user ON account_user.id=membership.user_id
		LEFT JOIN roles role_item ON role_item.id=membership.role_id
		WHERE membership.account_id=$1 AND membership.user_id=$2`, accountID, actorID).
		Scan(&active, &globalSuperAdmin, &role, &permissions)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrWhiteboardNotFound
	}
	if err != nil {
		return err
	}
	if !whiteboardActorMembershipAllows(role, permissions, active, globalSuperAdmin) {
		return ErrWhiteboardNotFound
	}
	return nil
}

func lockTaskLocationViewActorMembershipTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID uuid.UUID,
	relatedMembershipIDs ...uuid.UUID,
) error {
	err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID, relatedMembershipIDs...)
	if errors.Is(err, ErrWhiteboardNotFound) {
		return ErrTaskWorkNotFound
	}
	if errors.Is(err, ErrWhiteboardInvalid) {
		return ErrTaskLocationViewInvalid
	}
	return err
}
