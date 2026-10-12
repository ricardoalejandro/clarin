package repository

import (
	"fmt"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// Both COUNT and the paged SELECT consume these conditions. Filtering before
// pagination prevents hidden cancelled rows from producing false empty pages.
func eventListConditions(accountID uuid.UUID, filter domain.EventFilter) (string, []any) {
	query := ` FROM events WHERE account_id = $1`
	args := []any{accountID}
	if filter.Status != "" {
		args = append(args, filter.Status)
		query += fmt.Sprintf(" AND status = $%d", len(args))
	} else if filter.ExcludeCancelled {
		query += " AND status <> 'cancelled'"
	}
	if filter.Search != "" {
		args = append(args, "%"+filter.Search+"%")
		query += fmt.Sprintf(" AND (name ILIKE $%d OR description ILIKE $%d OR location ILIKE $%d)", len(args), len(args), len(args))
	}
	if filter.DateFrom != nil {
		args = append(args, *filter.DateFrom)
		query += fmt.Sprintf(" AND event_date >= $%d", len(args))
	}
	if filter.DateTo != nil {
		args = append(args, *filter.DateTo)
		query += fmt.Sprintf(" AND event_date <= $%d", len(args))
	}
	switch filter.FolderFilter {
	case "root":
		query += " AND folder_id IS NULL"
	case "":
	default:
		args = append(args, filter.FolderFilter)
		query += fmt.Sprintf(" AND folder_id = $%d", len(args))
	}
	return query, args
}
