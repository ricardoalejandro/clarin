package repository

import (
	"context"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// canonicalAccountMembershipUserIDs returns one stable lock order for every
// account-scoped mutation that can insert a row backed by the user_accounts
// composite foreign key. UUID ordering prevents two multi-user ACL writes from
// taking the same memberships in opposite orders.
func canonicalAccountMembershipUserIDs(userIDs []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(userIDs))
	canonical := make([]uuid.UUID, 0, len(userIDs))
	for _, userID := range userIDs {
		if userID == uuid.Nil {
			continue
		}
		if _, duplicate := seen[userID]; duplicate {
			continue
		}
		seen[userID] = struct{}{}
		canonical = append(canonical, userID)
	}
	sort.Slice(canonical, func(i, j int) bool { return canonical[i].String() < canonical[j].String() })
	return canonical
}

// lockAccountMembershipsKeyShareTx must run before locking any resource that
// will receive or replace account-scoped grants. Membership removal locks the
// same row first and then the affected resources; taking KEY SHARE here in the
// same order both protects the composite FK and eliminates resource ->
// membership / membership -> resource deadlocks.
func lockAccountMembershipsKeyShareTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, userIDs []uuid.UUID) (map[uuid.UUID]struct{}, error) {
	canonical := canonicalAccountMembershipUserIDs(userIDs)
	locked := make(map[uuid.UUID]struct{}, len(canonical))
	if len(canonical) == 0 {
		return locked, nil
	}
	rows, err := tx.Query(ctx, `SELECT user_id FROM user_accounts
		WHERE account_id=$1 AND user_id=ANY($2::uuid[])
		ORDER BY user_id FOR KEY SHARE`, accountID, canonical)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var userID uuid.UUID
		if err := rows.Scan(&userID); err != nil {
			return nil, err
		}
		locked[userID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return locked, nil
}
