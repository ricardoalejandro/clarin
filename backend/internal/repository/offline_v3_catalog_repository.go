package repository

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type OfflineV3ResourceCandidate struct {
	SelectionID  *uuid.UUID `json:"selection_id,omitempty"`
	ResourceID   uuid.UUID  `json:"resource_id"`
	Module       string     `json:"module"`
	ResourceType string     `json:"resource_type"`
	Label        string     `json:"label"`
	Readiness    string     `json:"readiness"`
	HeadVersion  int64      `json:"head_version"`
	ItemCount    int64      `json:"item_count"`
	ByteSize     int64      `json:"byte_size"`
}

// ListResourceCandidates is actor-aware and grant/account bound. It deliberately
// loads a bounded candidate window and applies the canonical resource ACL to
// every returned row; account ownership alone is never treated as visibility.
func (r *OfflineV3Repository) ListResourceCandidates(ctx context.Context, grantID, userID uuid.UUID, module, query string, after uuid.UUID, limit int) ([]OfflineV3ResourceCandidate, *uuid.UUID, error) {
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
	var rows pgx.Rows
	switch module {
	case domain.OfflineModuleTasks:
		rows, err = tx.Query(ctx, `SELECT list.id,list.name FROM task_lists list
			WHERE list.account_id=$1 AND list.deleted_at IS NULL AND list.archived_at IS NULL AND list.id>$2
			  AND LOWER(list.name) LIKE $3 ORDER BY list.id LIMIT $4`, record.AccountID, after, search, window)
	case domain.OfflineModuleContacts:
		rows, err = tx.Query(ctx, `SELECT contact.id,COALESCE(NULLIF(BTRIM(contact.custom_name),''),NULLIF(BTRIM(contact.name),''),contact.phone,'Contacto')
			FROM contacts contact WHERE contact.account_id=$1 AND contact.is_group=FALSE AND contact.id>$2
			  AND LOWER(COALESCE(contact.custom_name,contact.name,contact.phone,'')) LIKE $3 ORDER BY contact.id LIMIT $4`, record.AccountID, after, search, window)
	case domain.OfflineModulePrograms:
		rows, err = tx.Query(ctx, `SELECT program.id,program.name FROM programs program
			WHERE program.account_id=$1 AND COALESCE(program.type,'course')='course' AND program.id>$2
			  AND LOWER(program.name) LIKE $3 ORDER BY program.id LIMIT $4`, record.AccountID, after, search, window)
	case domain.OfflineModuleWhiteboards:
		rows, err = tx.Query(ctx, `SELECT board.id,board.name FROM whiteboards board
			WHERE board.account_id=$1 AND board.deleted_at IS NULL AND board.id>$2
			  AND LOWER(board.name) LIKE $3 ORDER BY board.id LIMIT $4`, record.AccountID, after, search, window)
	}
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
	for _, bareItem := range bareItems {
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
		err := tx.QueryRow(ctx, `SELECT selection.id,head.head_version FROM offline_v3_selections selection
			JOIN offline_v3_resource_heads head ON head.selection_id=selection.id AND head.grant_id=selection.grant_id AND head.account_id=selection.account_id
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
	if len(bareItems) < window {
		lastScanned = nil
	}
	return out, lastScanned, nil
}
