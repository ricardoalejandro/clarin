package repository

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrAccountPurgeConfirmation = errors.New("account purge confirmation changed")

type accountPurgeReplacement struct {
	UserID    uuid.UUID
	AccountID uuid.UUID
	Role      string
}

type accountPurgeTableDependency struct {
	Child  string
	Parent string
}

// orderAccountPurgeTables returns a deterministic child-before-parent order.
// Account purge intentionally does not rely on PostgreSQL choosing a favorable
// order between independent ON DELETE cascades: provenance and hierarchy FKs
// use RESTRICT so that ordinary deletes cannot silently erase history.
func orderAccountPurgeTables(tables []string, dependencies []accountPurgeTableDependency) ([]string, error) {
	tableSet := make(map[string]struct{}, len(tables))
	for _, table := range tables {
		table = strings.TrimSpace(table)
		if table == "" {
			continue
		}
		tableSet[table] = struct{}{}
	}

	childrenByParent := make(map[string]map[string]struct{}, len(tableSet))
	parentsByChild := make(map[string]map[string]struct{}, len(tableSet))
	for _, dependency := range dependencies {
		if dependency.Child == dependency.Parent {
			continue
		}
		if _, ok := tableSet[dependency.Child]; !ok {
			continue
		}
		if _, ok := tableSet[dependency.Parent]; !ok {
			continue
		}
		if childrenByParent[dependency.Parent] == nil {
			childrenByParent[dependency.Parent] = make(map[string]struct{})
		}
		if _, exists := childrenByParent[dependency.Parent][dependency.Child]; exists {
			continue
		}
		childrenByParent[dependency.Parent][dependency.Child] = struct{}{}
		if parentsByChild[dependency.Child] == nil {
			parentsByChild[dependency.Child] = make(map[string]struct{})
		}
		parentsByChild[dependency.Child][dependency.Parent] = struct{}{}
	}

	remainingChildren := make(map[string]int, len(tableSet))
	ready := make([]string, 0, len(tableSet))
	for table := range tableSet {
		remainingChildren[table] = len(childrenByParent[table])
		if remainingChildren[table] == 0 {
			ready = append(ready, table)
		}
	}
	sort.Strings(ready)

	ordered := make([]string, 0, len(tableSet))
	for len(ready) > 0 {
		table := ready[0]
		ready = ready[1:]
		ordered = append(ordered, table)

		parents := make([]string, 0, len(parentsByChild[table]))
		for parent := range parentsByChild[table] {
			parents = append(parents, parent)
		}
		sort.Strings(parents)
		for _, parent := range parents {
			remainingChildren[parent]--
			if remainingChildren[parent] == 0 {
				ready = append(ready, parent)
				sort.Strings(ready)
			}
		}
	}
	if len(ordered) != len(tableSet) {
		blocked := make([]string, 0, len(tableSet)-len(ordered))
		for table, count := range remainingChildren {
			if count > 0 {
				blocked = append(blocked, table)
			}
		}
		sort.Strings(blocked)
		return nil, fmt.Errorf("account purge table dependency cycle: %s", strings.Join(blocked, ","))
	}
	return ordered, nil
}

// purgeAccountScopedRowsTx removes the complete tenant tree explicitly before
// memberships, exclusive users and the account row. The table inventory comes
// from PostgreSQL's own schema and every mutation is still bounded by the same
// UUID account_id. This makes additive account-scoped migrations fail closed
// instead of depending on incidental cascade order.
func purgeAccountScopedRowsTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	// survey_answers intentionally has no account_id. Remove it through its
	// canonical survey before the account-scoped upload/response rows because
	// attached uploads use RESTRICT to protect live answers.
	if _, err := tx.Exec(ctx, `DELETE FROM survey_answers answer
		USING surveys survey
		WHERE answer.survey_id=survey.id AND survey.account_id=$1`, accountID); err != nil {
		return fmt.Errorf("purge account survey answers: %w", err)
	}
	// The folder self-FK is RESTRICT for normal hierarchy safety. The entire
	// account is already locked for irreversible purge, so detach only this
	// account's parents before deleting its folder rows.
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_folders SET parent_id=NULL
		WHERE account_id=$1 AND parent_id IS NOT NULL`, accountID); err != nil {
		return fmt.Errorf("detach account whiteboard folder hierarchy: %w", err)
	}

	rows, err := tx.Query(ctx, `SELECT table_class.relname
		FROM pg_class table_class
		JOIN pg_namespace table_schema ON table_schema.oid=table_class.relnamespace
		JOIN pg_attribute account_column ON account_column.attrelid=table_class.oid
			AND account_column.attname='account_id' AND NOT account_column.attisdropped
		WHERE table_schema.nspname='public'
		  AND table_class.relkind IN ('r','p')
		  AND table_class.relname NOT IN ('accounts','users','user_accounts')
		ORDER BY table_class.relname`)
	if err != nil {
		return fmt.Errorf("enumerate account purge tables: %w", err)
	}
	tables := make([]string, 0, 128)
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			rows.Close()
			return fmt.Errorf("scan account purge table: %w", err)
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("enumerate account purge tables: %w", err)
	}
	rows.Close()

	dependencyRows, err := tx.Query(ctx, `WITH account_tables AS (
			SELECT table_class.oid,table_class.relname
			FROM pg_class table_class
			JOIN pg_namespace table_schema ON table_schema.oid=table_class.relnamespace
			JOIN pg_attribute account_column ON account_column.attrelid=table_class.oid
				AND account_column.attname='account_id' AND NOT account_column.attisdropped
			WHERE table_schema.nspname='public'
			  AND table_class.relkind IN ('r','p')
			  AND table_class.relname NOT IN ('accounts','users','user_accounts')
		)
		SELECT DISTINCT child.relname,parent.relname
		FROM pg_constraint dependency
		JOIN account_tables child ON child.oid=dependency.conrelid
		JOIN account_tables parent ON parent.oid=dependency.confrelid
		WHERE dependency.contype='f' AND child.oid<>parent.oid
		ORDER BY child.relname,parent.relname`)
	if err != nil {
		return fmt.Errorf("enumerate account purge dependencies: %w", err)
	}
	dependencies := make([]accountPurgeTableDependency, 0, 256)
	for dependencyRows.Next() {
		var dependency accountPurgeTableDependency
		if err := dependencyRows.Scan(&dependency.Child, &dependency.Parent); err != nil {
			dependencyRows.Close()
			return fmt.Errorf("scan account purge dependency: %w", err)
		}
		dependencies = append(dependencies, dependency)
	}
	if err := dependencyRows.Err(); err != nil {
		dependencyRows.Close()
		return fmt.Errorf("enumerate account purge dependencies: %w", err)
	}
	dependencyRows.Close()

	ordered, err := orderAccountPurgeTables(tables, dependencies)
	if err != nil {
		return err
	}
	for _, table := range ordered {
		query := `DELETE FROM ` + pgx.Identifier{table}.Sanitize() + ` WHERE account_id=$1`
		if _, err := tx.Exec(ctx, query, accountID); err != nil {
			return fmt.Errorf("purge account table %s: %w", table, err)
		}
	}
	return nil
}

// PurgeWithAuthorityImpact deletes an account while atomically relocating the
// legacy default-account mirror for users who retain other memberships. It
// captures all affected users/accounts under the same transaction, advances
// authorization revisions before changing global user rows, and returns the
// exact post-commit scope that callers must use for session/socket revocation.
func (r *AccountRepository) PurgeWithAuthorityImpact(ctx context.Context, accountID uuid.UUID, expectedName string) (*WhiteboardAuthorityMutationEffect, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var lockedAccountID uuid.UUID
	var lockedAccountName string
	if err := tx.QueryRow(ctx, `SELECT id,name FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(&lockedAccountID, &lockedAccountName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &WhiteboardAuthorityMutationEffect{}, nil
		}
		return nil, err
	}
	if lockedAccountName != expectedName {
		return nil, ErrAccountPurgeConfirmation
	}

	rows, err := tx.Query(ctx, `SELECT affected.user_id FROM (
		SELECT membership.user_id FROM user_accounts membership WHERE membership.account_id=$1
		UNION
		SELECT account_user.id FROM users account_user WHERE account_user.account_id=$1
	) affected ORDER BY affected.user_id`, accountID)
	if err != nil {
		return nil, err
	}
	userIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var userID uuid.UUID
		if err := rows.Scan(&userID); err != nil {
			rows.Close()
			return nil, err
		}
		userIDs = append(userIDs, userID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for _, userID := range userIDs {
		if err := lockUserAuthorityTx(ctx, tx, userID); err != nil {
			return nil, err
		}
	}

	accountIDs := []uuid.UUID{accountID}
	replacements := make([]accountPurgeReplacement, 0, len(userIDs))
	exclusiveUserIDs := make([]uuid.UUID, 0, len(userIDs))
	for _, userID := range userIDs {
		membershipRows, err := tx.Query(ctx, `SELECT membership.account_id,membership.role,membership.is_default,
			membership.created_at,membership.id
			FROM user_accounts membership
			WHERE membership.user_id=$1
			ORDER BY membership.account_id FOR UPDATE`, userID)
		if err != nil {
			return nil, err
		}
		type membershipState struct {
			AccountID uuid.UUID
			Role      string
			IsDefault bool
			CreatedAt time.Time
			ID        uuid.UUID
		}
		memberships := make([]membershipState, 0)
		for membershipRows.Next() {
			var item membershipState
			if err := membershipRows.Scan(&item.AccountID, &item.Role, &item.IsDefault, &item.CreatedAt, &item.ID); err != nil {
				membershipRows.Close()
				return nil, err
			}
			memberships = append(memberships, item)
		}
		if err := membershipRows.Err(); err != nil {
			membershipRows.Close()
			return nil, err
		}
		membershipRows.Close()

		remaining := make([]membershipState, 0, len(memberships))
		for _, membership := range memberships {
			if membership.AccountID == accountID {
				continue
			}
			accountIDs = append(accountIDs, membership.AccountID)
			remaining = append(remaining, membership)
		}
		sort.SliceStable(remaining, func(i, j int) bool {
			if remaining[i].IsDefault != remaining[j].IsDefault {
				return remaining[i].IsDefault
			}
			if !remaining[i].CreatedAt.Equal(remaining[j].CreatedAt) {
				return remaining[i].CreatedAt.Before(remaining[j].CreatedAt)
			}
			return remaining[i].ID.String() < remaining[j].ID.String()
		})
		if len(remaining) > 0 {
			replacements = append(replacements, accountPurgeReplacement{
				UserID: userID, AccountID: remaining[0].AccountID, Role: remaining[0].Role,
			})
		} else {
			exclusiveUserIDs = append(exclusiveUserIDs, userID)
		}
	}

	// Keep the soon-to-be-purged memberships until the explicit tenant tree has
	// been removed. Whiteboards, Work events and other provenance rows
	// intentionally reference these memberships with RESTRICT/NO ACTION;
	// deleting membership authority before its account data would be unsafe.
	// Clearing its default bit is sufficient to promote a replacement without
	// violating the one-default-per-user constraint.
	if _, err := tx.Exec(ctx, `UPDATE user_accounts SET is_default=FALSE
		WHERE account_id=$1 AND is_default`, accountID); err != nil {
		return nil, err
	}
	for _, replacement := range replacements {
		if _, err := tx.Exec(ctx, `UPDATE user_accounts SET is_default=(account_id=$2)
			WHERE user_id=$1`, replacement.UserID, replacement.AccountID); err != nil {
			return nil, err
		}
	}

	accountIDs = canonicalAuthorityUUIDs(accountIDs)
	for _, affectedAccountID := range accountIDs {
		if err := bumpAllWhiteboardAccessRevisionTx(ctx, tx, affectedAccountID); err != nil {
			return nil, err
		}
	}

	// Follow the established board-before-user lock order used by all global
	// authority mutations. The legacy flags remain mirrors only.
	for _, replacement := range replacements {
		if _, err := tx.Exec(ctx, `UPDATE users SET account_id=$2,role=$3::varchar,
			is_admin=(is_super_admin OR $3::varchar IN ('admin','super_admin')),
			updated_at=NOW()
			WHERE id=$1`, replacement.UserID, replacement.AccountID, replacement.Role); err != nil {
			return nil, err
		}
	}

	if err := purgeAccountScopedRowsTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_accounts WHERE account_id=$1`, accountID); err != nil {
		return nil, err
	}
	if len(exclusiveUserIDs) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM users WHERE id=ANY($1::uuid[])`, exclusiveUserIDs); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM accounts WHERE id=$1`, accountID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	sort.Slice(userIDs, func(i, j int) bool { return userIDs[i].String() < userIDs[j].String() })
	return &WhiteboardAuthorityMutationEffect{AccountIDs: accountIDs, UserIDs: userIDs}, nil
}
