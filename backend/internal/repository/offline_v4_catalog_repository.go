package repository

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// Keep lifecycle predicates tied to the canonical module schema. Whiteboards
// use archived_at for their trash lifecycle; they have no deleted_at column.
func offlineV4CatalogStatement(module string) string {
	switch module {
	case domain.OfflineModuleTasks:
		return `SELECT list.id,list.name FROM task_lists list
			WHERE list.account_id=$1 AND list.deleted_at IS NULL AND list.archived_at IS NULL AND list.id>$2
			  AND LOWER(list.name) LIKE $3 ORDER BY list.id LIMIT $4`
	case domain.OfflineModuleContacts:
		const label = `COALESCE(NULLIF(BTRIM(contact.custom_name),''),NULLIF(BTRIM(contact.name),''),NULLIF(BTRIM(contact.push_name),''),contact.phone,'Contacto')`
		return `SELECT contact.id,` + label + ` FROM contacts contact
			WHERE contact.account_id=$1 AND contact.is_group=FALSE AND contact.id>$2
			  AND LOWER(` + label + `) LIKE $3 ORDER BY contact.id LIMIT $4`
	case domain.OfflineModulePrograms:
		return `SELECT program.id,program.name FROM programs program
			WHERE program.account_id=$1 AND COALESCE(program.type,'course')='course' AND program.id>$2
			  AND LOWER(program.name) LIKE $3 ORDER BY program.id LIMIT $4`
	case domain.OfflineModuleWhiteboards:
		return `SELECT board.id,board.name FROM whiteboards board
			WHERE board.account_id=$1 AND board.archived_at IS NULL AND board.id>$2
			  AND LOWER(board.name) LIKE $3 ORDER BY board.id LIMIT $4`
	default:
		return ""
	}
}

// ListResourceCandidates is actor-aware and grant/account bound. It deliberately
// loads a bounded candidate window and applies the canonical resource ACL to
// every returned row; account ownership alone is never treated as visibility.
func (r *OfflineV4Repository) ListResourceCandidates(ctx context.Context, grantID, userID uuid.UUID, module, query string, after uuid.UUID, limit int) ([]OfflineV3ResourceCandidate, *uuid.UUID, error) {
	action, resourceType := "", ""
	switch module {
	case domain.OfflineModuleTasks:
		action, resourceType = domain.OfflineV3ActionTasksRead, domain.OfflineResourceTaskList
	case domain.OfflineModuleContacts:
		action, resourceType = domain.OfflineV3ActionContactsRead, domain.OfflineResourceContact
	case domain.OfflineModulePrograms:
		action, resourceType = domain.OfflineV3ActionProgramsRead, domain.OfflineResourceProgram
	case domain.OfflineModuleWhiteboards:
		action, resourceType = domain.OfflineV3ActionWhiteboardsRead, domain.OfflineResourceWhiteboard
	default:
		return nil, nil, ErrOfflineV3Invalid
	}
	if limit < 1 || limit > 100 || len(query) > 160 {
		return nil, nil, ErrOfflineV3Invalid
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	record, err := r.LockActiveGrantTx(ctx, tx, grantID, action)
	if err != nil {
		return nil, nil, err
	}
	if record.UserID != userID {
		return nil, nil, ErrOfflineV3NotFound
	}
	search := "%" + strings.ToLower(strings.TrimSpace(query)) + "%"
	window := limit * 5
	if window > 500 {
		window = 500
	}
	rows, err := tx.Query(ctx, offlineV4CatalogStatement(module), record.AccountID, after, search, window)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	type bare struct {
		id    uuid.UUID
		label string
	}
	bareItems := make([]bare, 0, window)
	for rows.Next() {
		var item bare
		if err := rows.Scan(&item.id, &item.label); err != nil {
			return nil, nil, err
		}
		bareItems = append(bareItems, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	rows.Close()
	out := make([]OfflineV3ResourceCandidate, 0, limit)
	var lastScanned *uuid.UUID
	scanned := 0
	for _, bareItem := range bareItems {
		scanned++
		id := bareItem.id
		lastScanned = &id
		selection := domain.OfflineV3Selection{GrantID: grantID, AccountID: record.AccountID, Module: module, ResourceType: resourceType, ResourceID: bareItem.id}
		if err := validateOfflineV3ResourceAccess(ctx, tx, userID, record.AccountID, selection, domain.TaskAccessView); err != nil {
			if errors.Is(err, ErrOfflineV3AccessDenied) {
				continue
			}
			return nil, nil, err
		}
		candidate := OfflineV3ResourceCandidate{ResourceID: bareItem.id, Module: module, ResourceType: resourceType, Label: bareItem.label, Readiness: "not_selected"}
		var selectionID uuid.UUID
		var head int64
		err := tx.QueryRow(ctx, `SELECT selection.id,selection.head_version FROM offline_v4_selections selection
			WHERE selection.grant_id=$1 AND selection.account_id=$2 AND selection.module=$3 AND selection.resource_type=$4 AND selection.resource_id=$5`,
			grantID, record.AccountID, module, resourceType, bareItem.id).Scan(&selectionID, &head)
		if err == nil {
			candidate.SelectionID, candidate.HeadVersion, candidate.Readiness = &selectionID, head, "selected"
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, err
		}
		out = append(out, candidate)
		if len(out) == limit {
			break
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	if scanned == len(bareItems) && len(bareItems) < window {
		lastScanned = nil
	}
	return out, lastScanned, nil
}
