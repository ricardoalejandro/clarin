package repository

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrGlobalTagCreationForbidden = errors.New("global tag creation requires tags permission")

// resolveContactTagNamesTx never creates catalog entries on behalf of a caller
// who can only assign existing tags. Resolution and profile mutation commit together.
func resolveContactTagNamesTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, names []string, canCreate bool) ([]uuid.UUID, error) {
	ids := make([]uuid.UUID, 0, len(names))
	seen := make(map[string]bool, len(names))
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		var id uuid.UUID
		err := tx.QueryRow(ctx, `SELECT id FROM tags WHERE account_id=$1 AND name=$2 FOR KEY SHARE`, accountID, name).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			if !canCreate {
				return nil, ErrGlobalTagCreationForbidden
			}
			err = tx.QueryRow(ctx, `INSERT INTO tags (id,account_id,name,color) VALUES ($1,$2,$3,'#6366f1')
    ON CONFLICT (account_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, uuid.New(), accountID, name).Scan(&id)
		}
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func (r *ContactProfileRepository) UpdateWithTagNames(ctx context.Context, accountID, contactID uuid.UUID, patch ContactProfilePatch, names []string, canCreate bool) (*domain.Contact, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return nil, err
	}
	if patch.TagIDsSet {
		patch.TagIDs, err = resolveContactTagNamesTx(ctx, tx, accountID, names, canCreate)
		if err != nil {
			return nil, err
		}
	}
	contact, err := r.UpdateTx(ctx, tx, accountID, contactID, patch)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return contact, nil
}

// CreateManual commits identity, all supplied metadata and tag assignments as
// one canonical mutation. Invalid metadata cannot leave a partial Contact behind.
func (r *ContactProfileRepository) CreateManual(ctx context.Context, accountID uuid.UUID, jid, phone string, patch ContactProfilePatch, names []string, canCreate bool) (*domain.Contact, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return nil, err
	}
	owner, err := findContactAliasID(ctx, tx, accountID, jid, phone)
	if err != nil {
		return nil, err
	}
	var id uuid.UUID
	if owner != nil {
		id = *owner
		conflict, checkErr := contactIdentityConflictsWithOwner(ctx, tx, accountID, id, jid, phone)
		if checkErr != nil {
			return nil, checkErr
		}
		if conflict {
			return nil, ErrContactIdentityConflict
		}
	} else {
		err = tx.QueryRow(ctx, `INSERT INTO contacts (account_id,jid,phone,is_group,source)
   VALUES ($1,$2,NULLIF($3,''),FALSE,'manual')
   ON CONFLICT (account_id,jid) DO UPDATE SET updated_at=NOW() RETURNING id`, accountID, jid, phone).Scan(&id)
		if err != nil {
			return nil, err
		}
	}
	if owner != nil && patch.PhoneSet {
		var primary *string
		if err = tx.QueryRow(ctx, `SELECT phone FROM contacts WHERE account_id=$1 AND id=$2`, accountID, id).Scan(&primary); err != nil {
			return nil, err
		}
		if primary != nil && strings.TrimSpace(*primary) != "" {
			patch.PhoneSet = false
		}
	}
	if patch.TagIDsSet {
		patch.TagIDs, err = resolveContactTagNamesTx(ctx, tx, accountID, names, canCreate)
		if err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE contacts SET source='manual' WHERE account_id=$1 AND id=$2`, accountID, id); err != nil {
		return nil, err
	}
	contact, err := r.UpdateTx(ctx, tx, accountID, id, patch)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return contact, nil
}
