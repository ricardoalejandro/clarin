package repository

import (
	"context"
	"log"
	"time"

	"github.com/naperu/clarin/internal/domain"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// --- Account Google Methods ---

// SaveGoogleTokens stores Google OAuth tokens for an account
func (r *AccountRepository) SaveGoogleTokens(ctx context.Context, accountID uuid.UUID, email, accessToken, refreshToken, contactGroupID string) error {
	now := time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE accounts SET
			google_email = $2, google_access_token = $3, google_refresh_token = $4,
			google_contact_group_id = $5, google_connected_at = $6, updated_at = NOW()
		WHERE id = $1
	`, accountID, email, accessToken, refreshToken, contactGroupID, now)
	return err
}

// UpdateGoogleAccessToken updates only the access token (after refresh)
func (r *AccountRepository) UpdateGoogleAccessToken(ctx context.Context, accountID uuid.UUID, accessToken string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE accounts SET google_access_token = $2, updated_at = NOW() WHERE id = $1
	`, accountID, accessToken)
	return err
}

// DisconnectGoogle removes Google tokens and clears sync status for all contacts
func (r *AccountRepository) DisconnectGoogle(ctx context.Context, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		UPDATE accounts SET
			google_email = NULL, google_access_token = NULL, google_refresh_token = NULL,
			google_contact_group_id = NULL, google_connected_at = NULL, updated_at = NOW()
		WHERE id = $1
	`, accountID)
	if err != nil {
		return err
	}
	// Clear sync flags on all contacts for this account
	_, err = r.db.Exec(ctx, `
		UPDATE contacts SET
			google_sync = FALSE, google_resource_name = NULL, google_synced_at = NULL, google_sync_error = NULL
		WHERE account_id = $1 AND google_sync = TRUE
	`, accountID)
	return err
}

// GetGoogleTokens retrieves Google tokens for an account
func (r *AccountRepository) GetGoogleTokens(ctx context.Context, accountID uuid.UUID) (email, accessToken, refreshToken, groupID string, err error) {
	var pEmail, pAccess, pRefresh, pGroup *string
	err = r.db.QueryRow(ctx, `
		SELECT google_email, google_access_token, google_refresh_token, google_contact_group_id
		FROM accounts WHERE id = $1
	`, accountID).Scan(&pEmail, &pAccess, &pRefresh, &pGroup)
	if err != nil {
		return
	}
	if pEmail != nil {
		email = *pEmail
	}
	if pAccess != nil {
		accessToken = *pAccess
	}
	if pRefresh != nil {
		refreshToken = *pRefresh
	}
	if pGroup != nil {
		groupID = *pGroup
	}
	return
}

// GetGoogleSyncCount returns how many contacts are synced for this account
func (r *AccountRepository) GetGoogleSyncCount(ctx context.Context, accountID uuid.UUID) (int, error) {
	var count int
	err := r.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM contacts WHERE account_id = $1 AND google_sync = TRUE
	`, accountID).Scan(&count)
	return count, err
}

// --- Contact Google Sync Methods ---

// SetGoogleSyncPending marks a contact as google_sync=true without a resource name yet (pre-sync)
func (r *ContactRepository) SetGoogleSyncPending(ctx context.Context, contactID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		UPDATE contacts SET google_sync = TRUE, google_sync_error = NULL, updated_at = NOW() WHERE id = $1
	`, contactID)
	return err
}

// SetGoogleSync marks a contact as synced to Google
func (r *ContactRepository) SetGoogleSync(ctx context.Context, contactID uuid.UUID, resourceName string) error {
	now := time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE contacts SET
			google_sync = TRUE, google_resource_name = $2, google_synced_at = $3, google_sync_error = NULL, updated_at = NOW()
		WHERE id = $1
	`, contactID, resourceName, now)
	return err
}

// SetGoogleSyncError marks an error on a contact's sync
func (r *ContactRepository) SetGoogleSyncError(ctx context.Context, contactID uuid.UUID, syncError string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE contacts SET google_sync_error = $2, updated_at = NOW() WHERE id = $1
	`, contactID, syncError)
	return err
}

// ClearGoogleSync removes sync status from a contact
func (r *ContactRepository) ClearGoogleSync(ctx context.Context, contactID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		UPDATE contacts SET
			google_sync = FALSE, google_resource_name = NULL, google_synced_at = NULL, google_sync_error = NULL, updated_at = NOW()
		WHERE id = $1
	`, contactID)
	return err
}

// GetGoogleSyncedContacts returns all contacts that are synced to Google for an account
func (r *ContactRepository) GetGoogleSyncedContacts(ctx context.Context, accountID uuid.UUID) ([]*domain.Contact, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, jid, phone, name, last_name, short_name, custom_name, push_name,
		       email, company, notes, google_resource_name
		FROM contacts
		WHERE account_id = $1 AND google_sync = TRUE
		ORDER BY updated_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var contacts []*domain.Contact
	for rows.Next() {
		c := &domain.Contact{}
		if err := rows.Scan(
			&c.ID, &c.AccountID, &c.JID, &c.Phone,
			&c.Name, &c.LastName, &c.ShortName, &c.CustomName, &c.PushName,
			&c.Email, &c.Company, &c.Notes, &c.GoogleResourceName,
		); err != nil {
			return nil, err
		}
		contacts = append(contacts, c)
	}
	return contacts, nil
}

// GetContactsByIDs returns contacts by a list of IDs
func (r *ContactRepository) GetContactsByIDs(ctx context.Context, accountID uuid.UUID, ids []uuid.UUID) ([]*domain.Contact, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, device_id, jid, phone, name, last_name, short_name, custom_name, push_name, avatar_url,
		       email, company, age, dni, birth_date, tags, notes, source, is_group,
		       google_sync, google_resource_name, google_synced_at, google_sync_error,
		       created_at, updated_at
		FROM contacts
		WHERE account_id = $1 AND id = ANY($2)
	`, accountID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var contacts []*domain.Contact
	for rows.Next() {
		c := &domain.Contact{}
		if err := rows.Scan(
			&c.ID, &c.AccountID, &c.DeviceID, &c.JID, &c.Phone,
			&c.Name, &c.LastName, &c.ShortName, &c.CustomName, &c.PushName, &c.AvatarURL,
			&c.Email, &c.Company, &c.Age, &c.DNI, &c.BirthDate, &c.Tags, &c.Notes, &c.Source, &c.IsGroup,
			&c.GoogleSync, &c.GoogleResourceName, &c.GoogleSyncedAt, &c.GoogleSyncError,
			&c.CreatedAt, &c.UpdatedAt,
		); err != nil {
			return nil, err
		}
		contacts = append(contacts, c)
	}
	return contacts, nil
}

// --- Contact Phones ---

// GetContactPhones returns extra phone numbers for a contact
func (r *ContactRepository) GetContactPhones(ctx context.Context, contactID uuid.UUID) ([]domain.ContactPhone, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, contact_id, phone, label, created_at
		FROM contact_phones
		WHERE contact_id = $1
		ORDER BY created_at ASC
	`, contactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var phones []domain.ContactPhone
	for rows.Next() {
		var p domain.ContactPhone
		if err := rows.Scan(&p.ID, &p.ContactID, &p.Phone, &p.Label, &p.CreatedAt); err != nil {
			return nil, err
		}
		phones = append(phones, p)
	}
	return phones, nil
}

// SetContactPhones replaces all extra phone numbers for a contact
func (r *ContactRepository) SetContactPhones(ctx context.Context, contactID uuid.UUID, phones []domain.ContactPhone) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `DELETE FROM contact_phones WHERE contact_id = $1`, contactID)
	if err != nil {
		return err
	}

	for _, p := range phones {
		_, err = tx.Exec(ctx, `
			INSERT INTO contact_phones (id, contact_id, phone, label) VALUES ($1, $2, $3, $4)
		`, uuid.New(), contactID, p.Phone, p.Label)
		if err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// FindAccountByGoogleEmail checks if a Google email is already connected to any account
func (r *AccountRepository) FindAccountByGoogleEmail(ctx context.Context, email string) (*domain.Account, error) {
	a := &domain.Account{}
	err := r.db.QueryRow(ctx, `
		SELECT id, name FROM accounts WHERE google_email = $1 LIMIT 1
	`, email).Scan(&a.ID, &a.Name)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return a, nil
}

// GetContactIDsFromLeadIDs fetches the unique contact_ids for a list of lead IDs
func (r *ContactRepository) GetContactIDsFromLeadIDs(ctx context.Context, accountID uuid.UUID, leadIDs []uuid.UUID) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, `
		SELECT DISTINCT contact_id FROM leads
		WHERE account_id = $1 AND id = ANY($2) AND contact_id IS NOT NULL
	`, accountID, leadIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func init() {
	// Suppress unused import warning
	_ = log.Println
}
