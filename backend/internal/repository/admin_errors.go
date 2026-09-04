package repository

import (
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrUserNotFound  = errors.New("user not found")
	ErrRoleNotFound  = errors.New("role not found")
	ErrRoleNameTaken = errors.New("role name already exists")
)

func normalizeRoleWriteError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		constraint := strings.ToLower(pgErr.ConstraintName)
		if constraint == "roles_name_key" || constraint == "uq_roles_name_normalized" {
			return fmt.Errorf("%w: %v", ErrRoleNameTaken, err)
		}
	}
	return err
}
