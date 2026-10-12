package repository

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrManualLeadDuplicate = errors.New("manual lead already exists")

// CreateManualWithTags commits Contact identity, additive tags and Lead together.
// A present tagIDs collection is authoritative over legacy tag names.
func (r *LeadRepository) CreateManualWithTags(ctx context.Context, lead *domain.Lead, phone string, tagIDs *[]uuid.UUID, names []string, canCreate bool) (*domain.Contact, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = requireLeadPolicyTx(ctx, tx, lead.AccountID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, lead.AccountID); err != nil {
		return nil, err
	}
	var duplicate bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM leads WHERE account_id=$1 AND jid=$2)`, lead.AccountID, lead.JID).Scan(&duplicate); err != nil {
		return nil, err
	}
	if duplicate {
		return nil, ErrManualLeadDuplicate
	}
	profile := NewContactProfileRepository(r.db)
	patch := ContactProfilePatch{NotesSet: lead.Notes != nil, Notes: lead.Notes}
	present := func(value *string) bool { return value != nil && strings.TrimSpace(*value) != "" }
	if present(lead.Name) {
		patch.CustomNameSet = true
		patch.CustomName = lead.Name
	}
	if phone != "" {
		patch.PhoneSet = true
		patch.Phone = &phone
	}
	if present(lead.Email) {
		patch.EmailSet = true
		patch.Email = lead.Email
	}
	if present(lead.DNI) {
		patch.DNISet = true
		patch.DNI = lead.DNI
	}
	if lead.BirthDate != nil {
		patch.BirthDateSet = true
		patch.BirthDate = lead.BirthDate
	}
	if present(lead.Address) {
		patch.AddressSet = true
		patch.Address = lead.Address
	}
	if present(lead.Distrito) {
		patch.DistritoSet = true
		patch.Distrito = lead.Distrito
	}
	if present(lead.Ocupacion) {
		patch.OcupacionSet = true
		patch.Ocupacion = lead.Ocupacion
	}
	contact, err := profile.createManualTx(ctx, tx, lead.AccountID, lead.JID, phone, patch, nil, false, false)
	if err != nil {
		return nil, err
	}
	var additions []uuid.UUID
	if tagIDs != nil {
		additions, _, err = profile.validateTagIDsTx(ctx, tx, lead.AccountID, *tagIDs)
	} else {
		additions, err = resolveContactTagNamesTx(ctx, tx, lead.AccountID, names, canCreate)
	}
	if err != nil {
		return nil, err
	}
	if len(additions) > 0 {
		merged := make([]uuid.UUID, 0, len(contact.StructuredTags)+len(additions))
		for _, tag := range contact.StructuredTags {
			merged = append(merged, tag.ID)
		}
		merged = append(merged, additions...)
		contact, err = profile.UpdateTx(ctx, tx, lead.AccountID, contact.ID, ContactProfilePatch{TagIDsSet: true, TagIDs: merged})
		if err != nil {
			return nil, err
		}
	}
	lead.ContactID = &contact.ID
	displayName := contact.DisplayName()
	lead.Name = &displayName
	lead.Phone = contact.Phone
	lead.Email = contact.Email
	lead.LastName = contact.LastName
	lead.ShortName = contact.ShortName
	lead.Company = contact.Company
	lead.Age = contact.Age
	lead.DNI = contact.DNI
	lead.BirthDate = contact.BirthDate
	lead.Address = contact.Address
	lead.Distrito = contact.Distrito
	lead.Ocupacion = contact.Ocupacion
	lead.Tags = contact.Tags
	lead.StructuredTags = contact.StructuredTags
	if lead.StructuredTags == nil {
		lead.StructuredTags = make([]*domain.Tag, 0)
	}
	if err = r.createLeadWith(ctx, tx, lead); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return contact, nil
}

// GetByIDsForAccount hydrates only the bounded selected catalog entries.
func (r *TagRepository) GetByIDsForAccount(ctx context.Context, accountID uuid.UUID, ids []uuid.UUID) ([]*domain.Tag, error) {
	rows, err := r.db.Query(ctx, `SELECT id,account_id,name,color,created_at FROM tags WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY name,id`, accountID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := make([]*domain.Tag, 0, len(ids))
	for rows.Next() {
		tag := &domain.Tag{}
		if err = rows.Scan(&tag.ID, &tag.AccountID, &tag.Name, &tag.Color, &tag.CreatedAt); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}

// MutateLeadTagForAccount binds background automation to its execution tenant.
func (r *TagRepository) MutateLeadTagForAccount(ctx context.Context, accountID, leadID, tagID uuid.UUID, assign bool) (*uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = requireLeadPolicyTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return nil, err
	}
	var contact uuid.UUID
	err = tx.QueryRow(ctx, `SELECT contact_id FROM leads WHERE account_id=$1 AND id=$2 AND contact_id IS NOT NULL AND deleted_at IS NULL`, accountID, leadID).Scan(&contact)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrCRMNotFound
	}
	if err != nil {
		return nil, err
	}
	contactID := &contact
	var valid bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tags WHERE account_id=$1 AND id=$2)`, accountID, tagID).Scan(&valid); err != nil {
		return nil, err
	}
	if !valid {
		return nil, ErrCRMNotFound
	}
	if assign {
		_, err = tx.Exec(ctx, `INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, *contactID, tagID)
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM contact_tags WHERE contact_id=$1 AND tag_id=$2`, *contactID, tagID)
	}
	if err != nil {
		return nil, err
	}
	// Keep the canonical compatibility projection and updated_at in sync too.
	profile := NewContactProfileRepository(r.db)
	rows, err := tx.Query(ctx, `SELECT tag_id FROM contact_tags WHERE contact_id=$1 ORDER BY tag_id`, *contactID)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if _, err = profile.UpdateTx(ctx, tx, accountID, *contactID, ContactProfilePatch{TagIDsSet: true, TagIDs: ids}); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return contactID, nil
}
