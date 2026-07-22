package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrContactProfileNotFound           = errors.New("contact profile not found")
	ErrContactProfileContextNotFound    = errors.New("contact profile context not found")
	ErrContactProfileCollectionInvalid  = errors.New("contact profile collection is invalid")
	ErrAttendanceObservationProtected   = errors.New("attendance observation is protected")
	ErrContactProfileObservationLocked  = errors.New("contact profile interaction is not a deletable note")
	ErrContactProfileObservationMissing = errors.New("contact profile observation not found")
)

type ContactProfileExtraPhonePatch struct {
	ID    *uuid.UUID
	Phone string
	Label string
}

type ContactProfileCustomFieldPatch struct {
	FieldID     uuid.UUID
	ValueText   *string
	ValueNumber *float64
	ValueDate   *time.Time
	ValueBool   *bool
	ValueJSON   json.RawMessage
}

// ContactProfilePatch preserves the distinction between an omitted field and
// an explicit JSON null. Handlers set <Field>Set only when the key was sent.
type ContactProfilePatch struct {
	NameSet              bool
	Name                 *string
	CustomNameSet        bool
	CustomName           *string
	LastNameSet          bool
	LastName             *string
	ShortNameSet         bool
	ShortName            *string
	PhoneSet             bool
	Phone                *string
	EmailSet             bool
	Email                *string
	CompanySet           bool
	Company              *string
	AgeSet               bool
	Age                  *int
	DNISet               bool
	DNI                  *string
	BirthDateSet         bool
	BirthDate            *time.Time
	AddressSet           bool
	Address              *string
	DistritoSet          bool
	Distrito             *string
	OcupacionSet         bool
	Ocupacion            *string
	NotesSet             bool
	Notes                *string
	TagIDsSet            bool
	TagIDs               []uuid.UUID
	ExtraPhonesSet       bool
	ExtraPhones          []ContactProfileExtraPhonePatch
	CustomFieldValuesSet bool
	CustomFieldValues    []ContactProfileCustomFieldPatch
}

type ContactProfileRepository struct {
	db *pgxpool.Pool
}

func NewContactProfileRepository(db *pgxpool.Pool) *ContactProfileRepository {
	return &ContactProfileRepository{db: db}
}

func scanContactProfile(row pgx.Row) (*domain.Contact, error) {
	contact := &domain.Contact{}
	err := row.Scan(
		&contact.ID, &contact.AccountID, &contact.DeviceID, &contact.JID, &contact.Phone,
		&contact.Name, &contact.LastName, &contact.ShortName, &contact.CustomName, &contact.PushName,
		&contact.AvatarURL, &contact.AvatarCheckedAt, &contact.AvatarMediaAssetID, &contact.AvatarSource,
		&contact.AvatarUpdatedAt, &contact.AvatarRevision,
		&contact.Email, &contact.Company, &contact.Age, &contact.DNI, &contact.BirthDate,
		&contact.Address, &contact.Distrito, &contact.Ocupacion, &contact.Tags, &contact.Notes,
		&contact.Source, &contact.IsGroup, &contact.CreatedAt, &contact.UpdatedAt,
		&contact.GoogleSync, &contact.GoogleResourceName, &contact.GoogleSyncedAt, &contact.GoogleSyncError,
		&contact.DoNotContact, &contact.DoNotContactAt, &contact.DoNotContactBy, &contact.DoNotContactReason,
		&contact.LeadCount,
	)
	if err == pgx.ErrNoRows {
		return nil, ErrContactProfileNotFound
	}
	return contact, err
}

const contactProfileSelect = `
	SELECT c.id,c.account_id,c.device_id,c.jid,c.phone,
	       c.name,c.last_name,c.short_name,c.custom_name,c.push_name,
	       c.avatar_url,c.avatar_checked_at,c.avatar_media_asset_id,c.avatar_source,
	       c.avatar_updated_at,COALESCE(c.avatar_revision,0),
	       c.email,c.company,c.age,c.dni,c.birth_date,
	       c.address,c.distrito,c.ocupacion,c.tags,c.notes,
	       c.source,c.is_group,c.created_at,c.updated_at,
	       COALESCE(c.google_sync,FALSE),c.google_resource_name,c.google_synced_at,c.google_sync_error,
	       COALESCE(c.do_not_contact,FALSE),c.do_not_contact_at,c.do_not_contact_by,COALESCE(c.do_not_contact_reason,''),
	       (SELECT COUNT(*) FROM leads l WHERE l.account_id=c.account_id AND l.contact_id=c.id)
	FROM contacts c
	WHERE c.account_id=$1 AND c.id=$2`

func (r *ContactProfileRepository) Get(ctx context.Context, accountID, contactID uuid.UUID) (*domain.Contact, error) {
	contact, err := scanContactProfile(r.db.QueryRow(ctx, contactProfileSelect, accountID, contactID))
	if err != nil {
		return nil, err
	}
	if err := r.hydrate(ctx, r.db, accountID, contact); err != nil {
		return nil, err
	}
	return contact, nil
}

type contactProfileQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func (r *ContactProfileRepository) hydrate(ctx context.Context, querier contactProfileQuerier, accountID uuid.UUID, contact *domain.Contact) error {
	contact.StructuredTags = make([]*domain.Tag, 0)
	tagRows, err := querier.Query(ctx, `
		SELECT t.id,t.account_id,t.name,t.color,t.kommo_id,t.created_at,t.updated_at
		FROM contact_tags ct
		JOIN contacts c ON c.id=ct.contact_id AND c.account_id=$1
		JOIN tags t ON t.id=ct.tag_id AND t.account_id=c.account_id
		WHERE ct.contact_id=$2
		ORDER BY LOWER(t.name),t.id
	`, accountID, contact.ID)
	if err != nil {
		return err
	}
	for tagRows.Next() {
		tag := &domain.Tag{}
		if err := tagRows.Scan(&tag.ID, &tag.AccountID, &tag.Name, &tag.Color, &tag.KommoID, &tag.CreatedAt, &tag.UpdatedAt); err != nil {
			tagRows.Close()
			return err
		}
		contact.StructuredTags = append(contact.StructuredTags, tag)
	}
	err = tagRows.Err()
	tagRows.Close()
	if err != nil {
		return err
	}

	contact.ExtraPhones = make([]domain.ContactPhone, 0)
	phoneRows, err := querier.Query(ctx, `
		SELECT cp.id,cp.contact_id,cp.phone,COALESCE(cp.label,'mobile'),cp.created_at
		FROM contact_phones cp
		JOIN contacts c ON c.id=cp.contact_id AND c.account_id=$1
		WHERE cp.contact_id=$2
		ORDER BY cp.created_at,cp.id
	`, accountID, contact.ID)
	if err != nil {
		return err
	}
	for phoneRows.Next() {
		phone := domain.ContactPhone{}
		if err := phoneRows.Scan(&phone.ID, &phone.ContactID, &phone.Phone, &phone.Label, &phone.CreatedAt); err != nil {
			phoneRows.Close()
			return err
		}
		contact.ExtraPhones = append(contact.ExtraPhones, phone)
	}
	err = phoneRows.Err()
	phoneRows.Close()
	if err != nil {
		return err
	}

	contact.CustomFieldValues = make([]*domain.CustomFieldValue, 0)
	fieldRows, err := querier.Query(ctx, `
		SELECT v.id,v.field_id,v.contact_id,v.value_text,v.value_number,v.value_date,v.value_bool,v.value_json,
		       v.created_at,v.updated_at,d.name,d.slug,d.field_type
		FROM custom_field_values v
		JOIN contacts c ON c.id=v.contact_id AND c.account_id=$1
		JOIN custom_field_definitions d ON d.id=v.field_id AND d.account_id=c.account_id
		WHERE v.contact_id=$2
		ORDER BY d.sort_order,d.id
	`, accountID, contact.ID)
	if err != nil {
		return err
	}
	for fieldRows.Next() {
		value := &domain.CustomFieldValue{}
		if err := fieldRows.Scan(
			&value.ID, &value.FieldID, &value.ContactID, &value.ValueText, &value.ValueNumber,
			&value.ValueDate, &value.ValueBool, &value.ValueJSON, &value.CreatedAt, &value.UpdatedAt,
			&value.FieldName, &value.FieldSlug, &value.FieldType,
		); err != nil {
			fieldRows.Close()
			return err
		}
		contact.CustomFieldValues = append(contact.CustomFieldValues, value)
	}
	err = fieldRows.Err()
	fieldRows.Close()
	if err != nil {
		return err
	}

	contact.DeviceNames = make([]domain.ContactDeviceName, 0)
	nameRows, err := querier.Query(ctx, `
		SELECT cdn.id,cdn.contact_id,cdn.device_id,cdn.name,cdn.push_name,cdn.business_name,cdn.synced_at,d.name
		FROM contact_device_names cdn
		JOIN contacts c ON c.id=cdn.contact_id AND c.account_id=$1
		JOIN devices d ON d.id=cdn.device_id AND d.account_id=c.account_id
		WHERE cdn.contact_id=$2
		ORDER BY cdn.synced_at DESC,cdn.id
	`, accountID, contact.ID)
	if err != nil {
		return err
	}
	for nameRows.Next() {
		name := domain.ContactDeviceName{}
		if err := nameRows.Scan(&name.ID, &name.ContactID, &name.DeviceID, &name.Name, &name.PushName, &name.BusinessName, &name.SyncedAt, &name.DeviceName); err != nil {
			nameRows.Close()
			return err
		}
		contact.DeviceNames = append(contact.DeviceNames, name)
	}
	err = nameRows.Err()
	nameRows.Close()
	return err
}

func applyContactProfilePatch(contact *domain.Contact, patch ContactProfilePatch) {
	if patch.NameSet {
		contact.Name = patch.Name
	}
	if patch.CustomNameSet {
		contact.CustomName = patch.CustomName
	}
	if patch.LastNameSet {
		contact.LastName = patch.LastName
	}
	if patch.ShortNameSet {
		contact.ShortName = patch.ShortName
	}
	if patch.PhoneSet {
		contact.Phone = patch.Phone
	}
	if patch.EmailSet {
		contact.Email = patch.Email
	}
	if patch.CompanySet {
		contact.Company = patch.Company
	}
	if patch.AgeSet {
		contact.Age = patch.Age
	}
	if patch.DNISet {
		contact.DNI = patch.DNI
	}
	if patch.BirthDateSet {
		contact.BirthDate = patch.BirthDate
	}
	if patch.AddressSet {
		contact.Address = patch.Address
	}
	if patch.DistritoSet {
		contact.Distrito = patch.Distrito
	}
	if patch.OcupacionSet {
		contact.Ocupacion = patch.Ocupacion
	}
	if patch.NotesSet {
		contact.Notes = patch.Notes
	}
}

func dedupeContactProfileUUIDs(ids []uuid.UUID) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(ids))
	seen := make(map[uuid.UUID]struct{}, len(ids))
	for _, id := range ids {
		if id == uuid.Nil {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func normalizeContactProfilePhone(value string) (string, error) {
	normalized := normalizeAliasValue("phone", value)
	if len(normalized) < 6 || len(normalized) > 15 {
		return "", fmt.Errorf("%w: invalid phone", ErrContactProfileCollectionInvalid)
	}
	return normalized, nil
}

func (r *ContactProfileRepository) validateTagIDsTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, ids []uuid.UUID) ([]uuid.UUID, []string, error) {
	ids = dedupeContactProfileUUIDs(ids)
	if len(ids) == 0 {
		return ids, make([]string, 0), nil
	}
	rows, err := tx.Query(ctx, `SELECT id,name FROM tags WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, ids)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	namesByID := make(map[uuid.UUID]string, len(ids))
	for rows.Next() {
		var id uuid.UUID
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, nil, err
		}
		namesByID[id] = name
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if len(namesByID) != len(ids) {
		return nil, nil, fmt.Errorf("%w: tag does not belong to account", ErrContactProfileCollectionInvalid)
	}
	names := make([]string, 0, len(ids))
	for _, id := range ids {
		names = append(names, namesByID[id])
	}
	return ids, names, nil
}

func validateProfileCustomFieldValue(fieldType string, config json.RawMessage, value *ContactProfileCustomFieldPatch) (bool, error) {
	count := 0
	if value.ValueText != nil {
		count++
	}
	if value.ValueNumber != nil {
		count++
	}
	if value.ValueDate != nil {
		count++
	}
	if value.ValueBool != nil {
		count++
	}
	if len(value.ValueJSON) > 0 && string(value.ValueJSON) != "null" {
		count++
	}
	if count == 0 {
		// The collection is a full replacement. A field with every value null is
		// intentionally omitted from the replacement and therefore deleted.
		return false, nil
	}
	if count != 1 {
		return false, fmt.Errorf("%w: each custom field needs exactly one typed value", ErrContactProfileCollectionInvalid)
	}

	switch fieldType {
	case "text", "email", "phone", "url", "select":
		if value.ValueText == nil {
			return false, fmt.Errorf("%w: custom field type mismatch", ErrContactProfileCollectionInvalid)
		}
		text := strings.TrimSpace(*value.ValueText)
		if text == "" {
			return false, fmt.Errorf("%w: custom field value is empty", ErrContactProfileCollectionInvalid)
		}
		switch fieldType {
		case "text":
			var limits struct {
				MaxLength int `json:"max_length"`
			}
			if len(config) > 0 && json.Unmarshal(config, &limits) == nil && limits.MaxLength > 0 && len([]rune(text)) > limits.MaxLength {
				return false, fmt.Errorf("%w: text exceeds configured length", ErrContactProfileCollectionInvalid)
			}
		case "email":
			parsed, err := mail.ParseAddress(text)
			if err != nil || parsed.Address != text {
				return false, fmt.Errorf("%w: invalid email", ErrContactProfileCollectionInvalid)
			}
		case "phone":
			normalized, err := normalizeContactProfilePhone(text)
			if err != nil {
				return false, err
			}
			text = normalized
		case "url":
			parsed, err := url.ParseRequestURI(text)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
				return false, fmt.Errorf("%w: invalid url", ErrContactProfileCollectionInvalid)
			}
		case "select":
			var selection struct {
				Options []struct {
					Value string `json:"value"`
				} `json:"options"`
			}
			if len(config) > 0 && json.Unmarshal(config, &selection) == nil && len(selection.Options) > 0 {
				valid := false
				for _, option := range selection.Options {
					if option.Value == text {
						valid = true
						break
					}
				}
				if !valid {
					return false, fmt.Errorf("%w: invalid select option", ErrContactProfileCollectionInvalid)
				}
			}
		}
		value.ValueText = &text
	case "number", "currency":
		if value.ValueNumber == nil {
			return false, fmt.Errorf("%w: custom field type mismatch", ErrContactProfileCollectionInvalid)
		}
		var limits struct {
			Min *float64 `json:"min"`
			Max *float64 `json:"max"`
		}
		if len(config) > 0 && json.Unmarshal(config, &limits) == nil {
			if limits.Min != nil && *value.ValueNumber < *limits.Min {
				return false, fmt.Errorf("%w: number below configured minimum", ErrContactProfileCollectionInvalid)
			}
			if limits.Max != nil && *value.ValueNumber > *limits.Max {
				return false, fmt.Errorf("%w: number above configured maximum", ErrContactProfileCollectionInvalid)
			}
		}
	case "date":
		if value.ValueDate == nil {
			return false, fmt.Errorf("%w: custom field type mismatch", ErrContactProfileCollectionInvalid)
		}
	case "checkbox":
		if value.ValueBool == nil {
			return false, fmt.Errorf("%w: custom field type mismatch", ErrContactProfileCollectionInvalid)
		}
	case "multi_select":
		if len(value.ValueJSON) == 0 || string(value.ValueJSON) == "null" {
			return false, fmt.Errorf("%w: custom field type mismatch", ErrContactProfileCollectionInvalid)
		}
		var selections []string
		if err := json.Unmarshal(value.ValueJSON, &selections); err != nil {
			return false, fmt.Errorf("%w: multi-select must be a string array", ErrContactProfileCollectionInvalid)
		}
		var selection struct {
			Options []struct {
				Value string `json:"value"`
			} `json:"options"`
		}
		if len(config) > 0 && json.Unmarshal(config, &selection) == nil && len(selection.Options) > 0 {
			validOptions := make(map[string]struct{}, len(selection.Options))
			for _, option := range selection.Options {
				validOptions[option.Value] = struct{}{}
			}
			for _, selected := range selections {
				if _, valid := validOptions[selected]; !valid {
					return false, fmt.Errorf("%w: invalid multi-select option", ErrContactProfileCollectionInvalid)
				}
			}
		}
		encoded, err := json.Marshal(selections)
		if err != nil {
			return false, err
		}
		value.ValueJSON = encoded
	default:
		return false, fmt.Errorf("%w: unsupported custom field type", ErrContactProfileCollectionInvalid)
	}
	return true, nil
}

func (r *ContactProfileRepository) validateCustomFieldsTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, values []ContactProfileCustomFieldPatch) ([]ContactProfileCustomFieldPatch, error) {
	if len(values) == 0 {
		return make([]ContactProfileCustomFieldPatch, 0), nil
	}
	ids := make([]uuid.UUID, 0, len(values))
	seen := make(map[uuid.UUID]struct{}, len(values))
	for _, value := range values {
		if value.FieldID == uuid.Nil {
			return nil, fmt.Errorf("%w: invalid custom field", ErrContactProfileCollectionInvalid)
		}
		if _, duplicate := seen[value.FieldID]; duplicate {
			return nil, fmt.Errorf("%w: duplicate custom field", ErrContactProfileCollectionInvalid)
		}
		seen[value.FieldID] = struct{}{}
		ids = append(ids, value.FieldID)
	}
	type definition struct {
		fieldType string
		config    json.RawMessage
	}
	definitions := make(map[uuid.UUID]definition, len(ids))
	rows, err := tx.Query(ctx, `SELECT id,field_type,config FROM custom_field_definitions WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var fieldType string
		var config json.RawMessage
		if err := rows.Scan(&id, &fieldType, &config); err != nil {
			return nil, err
		}
		definitions[id] = definition{fieldType: fieldType, config: config}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(definitions) != len(ids) {
		return nil, fmt.Errorf("%w: custom field does not belong to account", ErrContactProfileCollectionInvalid)
	}
	validated := make([]ContactProfileCustomFieldPatch, 0, len(values))
	for index := range values {
		value := values[index]
		definition := definitions[value.FieldID]
		keep, err := validateProfileCustomFieldValue(definition.fieldType, definition.config, &value)
		if err != nil {
			return nil, err
		}
		if keep {
			validated = append(validated, value)
		}
	}
	return validated, nil
}

func (r *ContactProfileRepository) validateExtraPhoneIDsTx(ctx context.Context, tx pgx.Tx, accountID, contactID uuid.UUID, values []ContactProfileExtraPhonePatch) error {
	ids := make([]uuid.UUID, 0, len(values))
	seen := make(map[uuid.UUID]struct{}, len(values))
	for _, value := range values {
		if value.ID == nil {
			continue
		}
		if *value.ID == uuid.Nil {
			return fmt.Errorf("%w: invalid extra phone id", ErrContactProfileCollectionInvalid)
		}
		if _, duplicate := seen[*value.ID]; duplicate {
			return fmt.Errorf("%w: duplicate extra phone id", ErrContactProfileCollectionInvalid)
		}
		seen[*value.ID] = struct{}{}
		ids = append(ids, *value.ID)
	}
	if len(ids) == 0 {
		return nil
	}
	var count int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM contact_phones cp
		JOIN contacts c ON c.id=cp.contact_id AND c.account_id=$1
		WHERE cp.contact_id=$2 AND cp.id=ANY($3::uuid[])
	`, accountID, contactID, ids).Scan(&count); err != nil {
		return err
	}
	if count != len(ids) {
		return fmt.Errorf("%w: extra phone does not belong to contact", ErrContactProfileCollectionInvalid)
	}
	return nil
}

func prepareContactProfilePhones(primary *string, values []ContactProfileExtraPhonePatch) (*string, []ContactProfileExtraPhonePatch, []string, error) {
	seen := make(map[string]struct{}, len(values)+1)
	aliases := make([]string, 0, len(values)+1)
	if primary != nil {
		normalized, err := normalizeContactProfilePhone(*primary)
		if err != nil {
			return nil, nil, nil, err
		}
		primary = &normalized
		seen[normalized] = struct{}{}
		aliases = append(aliases, normalized)
	}
	prepared := make([]ContactProfileExtraPhonePatch, 0, len(values))
	for _, value := range values {
		normalized, err := normalizeContactProfilePhone(value.Phone)
		if err != nil {
			return nil, nil, nil, err
		}
		if _, duplicate := seen[normalized]; duplicate {
			continue
		}
		seen[normalized] = struct{}{}
		label := strings.TrimSpace(value.Label)
		if label == "" {
			label = "mobile"
		}
		if len([]rune(label)) > 50 {
			return nil, nil, nil, fmt.Errorf("%w: phone label is too long", ErrContactProfileCollectionInvalid)
		}
		value.Phone = normalized
		value.Label = label
		prepared = append(prepared, value)
		aliases = append(aliases, normalized)
	}
	return primary, prepared, aliases, nil
}

func ensureContactProfilePhoneOwnershipTx(ctx context.Context, tx pgx.Tx, accountID, contactID uuid.UUID, phones []string) error {
	if len(phones) == 0 {
		return nil
	}
	var conflict bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM contacts c
			WHERE c.account_id=$1 AND c.id<>$2
			  AND CASE WHEN LENGTH(REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g'))=9
			                AND REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g') LIKE '9%'
			           THEN '51'||REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g')
			           ELSE REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g') END = ANY($3::text[])
			UNION ALL
			SELECT 1 FROM contact_phones cp JOIN contacts c ON c.id=cp.contact_id
			WHERE c.account_id=$1 AND c.id<>$2
			  AND CASE WHEN LENGTH(REGEXP_REPLACE(cp.phone,'[^0-9]','','g'))=9
			                AND REGEXP_REPLACE(cp.phone,'[^0-9]','','g') LIKE '9%'
			           THEN '51'||REGEXP_REPLACE(cp.phone,'[^0-9]','','g')
			           ELSE REGEXP_REPLACE(cp.phone,'[^0-9]','','g') END = ANY($3::text[])
			UNION ALL
			SELECT 1 FROM contact_aliases ca
			WHERE ca.account_id=$1 AND ca.contact_id<>$2 AND ca.alias_type='phone' AND ca.normalized_value=ANY($3::text[])
		)
	`, accountID, contactID, phones).Scan(&conflict); err != nil {
		return err
	}
	if conflict {
		return ErrContactIdentityConflict
	}
	// Aliases are an append-only identity safety net. Replacing or clearing a
	// visible phone removes it from contacts/contact_phones but deliberately
	// keeps the alias assigned to this Contact, so a later inbound message on an
	// old number cannot create a duplicate parent or attach to another Contact.
	for _, phone := range phones {
		var ownerID uuid.UUID
		err := tx.QueryRow(ctx, `
			INSERT INTO contact_aliases (account_id,contact_id,alias_type,alias_value,normalized_value)
			VALUES ($1,$2,'phone',$3,$3)
			ON CONFLICT (account_id,alias_type,normalized_value) DO UPDATE
			SET alias_value=EXCLUDED.alias_value
			WHERE contact_aliases.contact_id=EXCLUDED.contact_id
			RETURNING contact_id
		`, accountID, contactID, phone).Scan(&ownerID)
		if err == pgx.ErrNoRows || (err == nil && ownerID != contactID) {
			return ErrContactIdentityConflict
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// Update applies the canonical scalar profile and every compatibility snapshot
// in one account-scoped transaction. Legacy Lead personal columns are cleared
// so an explicitly removed Contact value cannot reappear through a fallback.
func (r *ContactProfileRepository) Update(ctx context.Context, accountID, contactID uuid.UUID, patch ContactProfilePatch) (*domain.Contact, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return nil, err
	}

	contact, err := scanContactProfile(tx.QueryRow(ctx, contactProfileSelect+` FOR UPDATE`, accountID, contactID))
	if err != nil {
		return nil, err
	}
	applyContactProfilePatch(contact, patch)

	tagIDs := make([]uuid.UUID, 0)
	if patch.TagIDsSet {
		var tagNames []string
		tagIDs, tagNames, err = r.validateTagIDsTx(ctx, tx, accountID, patch.TagIDs)
		if err != nil {
			return nil, err
		}
		contact.Tags = tagNames
	}

	customFields := make([]ContactProfileCustomFieldPatch, 0)
	if patch.CustomFieldValuesSet {
		customFields, err = r.validateCustomFieldsTx(ctx, tx, accountID, patch.CustomFieldValues)
		if err != nil {
			return nil, err
		}
	}

	extraPhones := make([]ContactProfileExtraPhonePatch, 0)
	phoneAliases := make([]string, 0)
	if patch.ExtraPhonesSet {
		if err := r.validateExtraPhoneIDsTx(ctx, tx, accountID, contactID, patch.ExtraPhones); err != nil {
			return nil, err
		}
		preparedPrimary, preparedExtras, aliases, err := prepareContactProfilePhones(contact.Phone, patch.ExtraPhones)
		if err != nil {
			return nil, err
		}
		if patch.PhoneSet {
			contact.Phone = preparedPrimary
		}
		extraPhones = preparedExtras
		phoneAliases = aliases
	} else if patch.PhoneSet && contact.Phone != nil {
		normalized, err := normalizeContactProfilePhone(*contact.Phone)
		if err != nil {
			return nil, err
		}
		contact.Phone = &normalized
		phoneAliases = append(phoneAliases, normalized)
	}
	if err := ensureContactProfilePhoneOwnershipTx(ctx, tx, accountID, contactID, phoneAliases); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE contacts SET
			name=$3,custom_name=$4,last_name=$5,short_name=$6,phone=$7,email=$8,
			company=$9,age=$10,dni=$11,birth_date=$12,address=$13,distrito=$14,
			ocupacion=$15,notes=$16,tags=$17,updated_at=NOW()
		WHERE account_id=$1 AND id=$2
	`, accountID, contactID, contact.Name, contact.CustomName, contact.LastName, contact.ShortName,
		contact.Phone, contact.Email, contact.Company, contact.Age, contact.DNI, contact.BirthDate,
		contact.Address, contact.Distrito, contact.Ocupacion, contact.Notes, contact.Tags); err != nil {
		return nil, err
	}

	if patch.TagIDsSet {
		if _, err := tx.Exec(ctx, `DELETE FROM contact_tags ct USING contacts c WHERE ct.contact_id=c.id AND c.account_id=$1 AND c.id=$2`, accountID, contactID); err != nil {
			return nil, err
		}
		for _, tagID := range tagIDs {
			if _, err := tx.Exec(ctx, `INSERT INTO contact_tags (contact_id,tag_id) VALUES ($1,$2)`, contactID, tagID); err != nil {
				return nil, err
			}
		}
	}

	if patch.ExtraPhonesSet {
		finalIDs := make([]uuid.UUID, 0, len(extraPhones))
		for index := range extraPhones {
			if extraPhones[index].ID == nil {
				id := uuid.New()
				extraPhones[index].ID = &id
			}
			finalIDs = append(finalIDs, *extraPhones[index].ID)
		}
		if len(finalIDs) == 0 {
			if _, err := tx.Exec(ctx, `DELETE FROM contact_phones cp USING contacts c WHERE cp.contact_id=c.id AND c.account_id=$1 AND c.id=$2`, accountID, contactID); err != nil {
				return nil, err
			}
		} else {
			if _, err := tx.Exec(ctx, `
				DELETE FROM contact_phones cp USING contacts c
				WHERE cp.contact_id=c.id AND c.account_id=$1 AND c.id=$2 AND NOT (cp.id=ANY($3::uuid[]))
			`, accountID, contactID, finalIDs); err != nil {
				return nil, err
			}
		}
		for _, phone := range extraPhones {
			if _, err := tx.Exec(ctx, `
				INSERT INTO contact_phones (id,contact_id,phone,label) VALUES ($1,$2,$3,$4)
				ON CONFLICT (id) DO UPDATE SET phone=EXCLUDED.phone,label=EXCLUDED.label
				WHERE contact_phones.contact_id=EXCLUDED.contact_id
			`, *phone.ID, contactID, phone.Phone, phone.Label); err != nil {
				return nil, err
			}
		}
	}

	if patch.CustomFieldValuesSet {
		if _, err := tx.Exec(ctx, `
			DELETE FROM custom_field_values v USING contacts c
			WHERE v.contact_id=c.id AND c.account_id=$1 AND c.id=$2
		`, accountID, contactID); err != nil {
			return nil, err
		}
		for _, value := range customFields {
			if _, err := tx.Exec(ctx, `
				INSERT INTO custom_field_values (
					id,field_id,contact_id,value_text,value_number,value_date,value_bool,value_json,created_at,updated_at
				) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
			`, uuid.New(), value.FieldID, contactID, value.ValueText, value.ValueNumber, value.ValueDate, value.ValueBool, value.ValueJSON); err != nil {
				return nil, err
			}
		}
	}

	displayName := contact.DisplayName()
	if _, err := tx.Exec(ctx, `
		UPDATE event_participants ep SET
			name=$3,last_name=$4,short_name=$5,phone=$6,email=$7,age=$8,company=$9,
			dni=$10,birth_date=$11,address=$12,distrito=$13,ocupacion=$14,updated_at=NOW()
		FROM events e
		WHERE e.id=ep.event_id AND e.account_id=$1 AND (
			ep.contact_id=$2 OR EXISTS(
				SELECT 1 FROM leads l
				WHERE l.account_id=e.account_id AND l.id=ep.lead_id AND l.contact_id=$2
			)
		)
	`, accountID, contactID, displayName, contact.LastName, contact.ShortName, contact.Phone,
		contact.Email, contact.Age, contact.Company, contact.DNI, contact.BirthDate,
		contact.Address, contact.Distrito, contact.Ocupacion); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE campaign_recipients cr SET name=$3,phone=$4,jid=$5
		FROM campaigns campaign
		WHERE campaign.id=cr.campaign_id AND campaign.account_id=$1 AND cr.contact_id=$2
	`, accountID, contactID, displayName, contact.Phone, contact.JID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE leads SET
			name=NULL,last_name=NULL,short_name=NULL,phone=NULL,email=NULL,company=NULL,age=NULL,
			dni=NULL,birth_date=NULL,address=NULL,distrito=NULL,ocupacion=NULL,updated_at=NOW()
		WHERE account_id=$1 AND contact_id=$2
	`, accountID, contactID); err != nil {
		return nil, err
	}
	if _, err := applyDurableSuppressionToContact(ctx, tx, accountID, contactID); err != nil {
		return nil, err
	}
	contact, err = scanContactProfile(tx.QueryRow(ctx, contactProfileSelect, accountID, contactID))
	if err != nil {
		return nil, err
	}
	if err := r.hydrate(ctx, tx, accountID, contact); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return contact, nil
}

func (r *ContactProfileRepository) ContextExists(ctx context.Context, accountID, contactID uuid.UUID, contextType string, contextID uuid.UUID) (bool, error) {
	var query string
	switch contextType {
	case "contact":
		if contextID != contactID {
			return false, nil
		}
		query = `SELECT EXISTS(SELECT 1 FROM contacts WHERE account_id=$1 AND id=$2)`
	case "lead":
		query = `SELECT EXISTS(SELECT 1 FROM leads WHERE account_id=$1 AND id=$3 AND contact_id=$2)`
	case "chat":
		query = `SELECT EXISTS(SELECT 1 FROM chats WHERE account_id=$1 AND id=$3 AND contact_id=$2)`
	case "event_participant":
		query = `SELECT EXISTS(
			SELECT 1 FROM event_participants ep
			JOIN events e ON e.id=ep.event_id
			LEFT JOIN leads l ON l.id=ep.lead_id AND l.account_id=e.account_id
			WHERE e.account_id=$1 AND COALESCE(ep.contact_id,l.contact_id)=$2 AND ep.id=$3
		)`
	case "program_participant":
		query = `SELECT EXISTS(SELECT 1 FROM program_participants pp JOIN programs p ON p.id=pp.program_id WHERE p.account_id=$1 AND pp.contact_id=$2 AND pp.id=$3)`
	default:
		return false, fmt.Errorf("unknown contact context %q", contextType)
	}
	var exists bool
	args := []any{accountID, contactID}
	if contextType != "contact" {
		args = append(args, contextID)
	}
	err := r.db.QueryRow(ctx, query, args...).Scan(&exists)
	return exists, err
}

func (r *ContactProfileRepository) ListObservations(ctx context.Context, accountID, contactID uuid.UUID, limit, offset int) ([]*domain.Interaction, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}
	rows, err := r.db.Query(ctx, `
		SELECT i.id,i.account_id,i.contact_id,i.lead_id,i.event_id,i.participant_id,
		       i.program_id,i.program_session_id,i.program_participant_id,COALESCE(i.source_label,''),
		       i.type,i.direction,i.outcome,i.notes,i.next_action,i.next_action_date,
		       i.created_by,i.created_at,u.display_name,e.name
		FROM interactions i
		LEFT JOIN users u ON u.id=i.created_by AND u.account_id=i.account_id
		LEFT JOIN events e ON e.id=i.event_id AND e.account_id=i.account_id
		WHERE i.account_id=$1 AND (
			i.contact_id=$2
			OR EXISTS(SELECT 1 FROM leads l WHERE l.account_id=$1 AND l.contact_id=$2 AND l.id=i.lead_id)
			OR EXISTS(
				SELECT 1 FROM event_participants ep
				JOIN events ev ON ev.id=ep.event_id AND ev.account_id=$1
				LEFT JOIN leads l ON l.id=ep.lead_id AND l.account_id=ev.account_id
				WHERE COALESCE(ep.contact_id,l.contact_id)=$2 AND ep.id=i.participant_id
			)
			OR EXISTS(SELECT 1 FROM program_participants pp JOIN programs p ON p.id=pp.program_id AND p.account_id=$1 WHERE pp.contact_id=$2 AND pp.id=i.program_participant_id)
		)
		ORDER BY i.created_at DESC,i.id DESC
		LIMIT $3 OFFSET $4
	`, accountID, contactID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	observations := make([]*domain.Interaction, 0)
	for rows.Next() {
		item := &domain.Interaction{}
		if err := rows.Scan(
			&item.ID, &item.AccountID, &item.ContactID, &item.LeadID, &item.EventID, &item.ParticipantID,
			&item.ProgramID, &item.ProgramSessionID, &item.ProgramParticipantID, &item.SourceLabel,
			&item.Type, &item.Direction, &item.Outcome, &item.Notes, &item.NextAction, &item.NextActionDate,
			&item.CreatedBy, &item.CreatedAt, &item.CreatedByName, &item.EventName,
		); err != nil {
			return nil, err
		}
		observations = append(observations, item)
	}
	return observations, rows.Err()
}

func (r *ContactProfileRepository) CountObservations(ctx context.Context, accountID, contactID uuid.UUID) (int, error) {
	var total int
	err := r.db.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM interactions i
		WHERE i.account_id=$1 AND (
			i.contact_id=$2
			OR EXISTS(SELECT 1 FROM leads l WHERE l.account_id=$1 AND l.contact_id=$2 AND l.id=i.lead_id)
			OR EXISTS(
				SELECT 1 FROM event_participants ep
				JOIN events ev ON ev.id=ep.event_id AND ev.account_id=$1
				LEFT JOIN leads l ON l.id=ep.lead_id AND l.account_id=ev.account_id
				WHERE COALESCE(ep.contact_id,l.contact_id)=$2 AND ep.id=i.participant_id
			)
			OR EXISTS(SELECT 1 FROM program_participants pp JOIN programs p ON p.id=pp.program_id AND p.account_id=$1 WHERE pp.contact_id=$2 AND pp.id=i.program_participant_id)
		)
	`, accountID, contactID).Scan(&total)
	return total, err
}

func (r *ContactProfileRepository) CreateObservation(ctx context.Context, accountID, userID, contactID uuid.UUID, contextType string, contextID uuid.UUID, notes string) (*domain.Interaction, error) {
	notes = strings.TrimSpace(notes)
	if notes == "" {
		return nil, fmt.Errorf("notes are required")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	interaction := &domain.Interaction{
		ID: uuid.New(), AccountID: accountID, ContactID: &contactID,
		Type: domain.InteractionTypeNote, Notes: &notes, CreatedBy: &userID,
	}
	sourceLabel := "Contacto"
	switch contextType {
	case "contact":
		if contextID != contactID {
			return nil, ErrContactProfileContextNotFound
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM contacts WHERE account_id=$1 AND id=$2)`, accountID, contactID).Scan(&exists); err != nil || !exists {
			if err != nil {
				return nil, err
			}
			return nil, ErrContactProfileContextNotFound
		}
	case "lead":
		var title string
		if err := tx.QueryRow(ctx, `SELECT title FROM leads WHERE account_id=$1 AND id=$2 AND contact_id=$3`, accountID, contextID, contactID).Scan(&title); err != nil {
			if err == pgx.ErrNoRows {
				return nil, ErrContactProfileContextNotFound
			}
			return nil, err
		}
		interaction.LeadID = &contextID
		sourceLabel = "Oportunidad · " + title
	case "chat":
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM chats WHERE account_id=$1 AND id=$2 AND contact_id=$3)`, accountID, contextID, contactID).Scan(&exists); err != nil || !exists {
			if err != nil {
				return nil, err
			}
			return nil, ErrContactProfileContextNotFound
		}
		sourceLabel = "Chat"
	case "event_participant":
		var eventID uuid.UUID
		var eventName string
		if err := tx.QueryRow(ctx, `
			SELECT e.id,e.name
			FROM event_participants ep
			JOIN events e ON e.id=ep.event_id
			LEFT JOIN leads l ON l.id=ep.lead_id AND l.account_id=e.account_id
			WHERE e.account_id=$1 AND ep.id=$2 AND COALESCE(ep.contact_id,l.contact_id)=$3
		`, accountID, contextID, contactID).Scan(&eventID, &eventName); err != nil {
			if err == pgx.ErrNoRows {
				return nil, ErrContactProfileContextNotFound
			}
			return nil, err
		}
		interaction.EventID = &eventID
		interaction.ParticipantID = &contextID
		sourceLabel = "Evento · " + eventName
	case "program_participant":
		var programID uuid.UUID
		var programName string
		if err := tx.QueryRow(ctx, `
			SELECT p.id,p.name FROM program_participants pp JOIN programs p ON p.id=pp.program_id
			WHERE p.account_id=$1 AND pp.id=$2 AND pp.contact_id=$3
		`, accountID, contextID, contactID).Scan(&programID, &programName); err != nil {
			if err == pgx.ErrNoRows {
				return nil, ErrContactProfileContextNotFound
			}
			return nil, err
		}
		interaction.ProgramID = &programID
		interaction.ProgramParticipantID = &contextID
		sourceLabel = "Programa · " + programName
	default:
		return nil, ErrContactProfileContextNotFound
	}
	interaction.SourceLabel = sourceLabel

	err = tx.QueryRow(ctx, `
		WITH inserted AS (
			INSERT INTO interactions (
				id,account_id,contact_id,lead_id,event_id,participant_id,program_id,program_session_id,
				program_participant_id,source_label,type,direction,outcome,notes,next_action,next_action_date,created_by,created_at
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
			RETURNING id,account_id,contact_id,lead_id,event_id,participant_id,program_id,program_session_id,
			          program_participant_id,source_label,type,direction,outcome,notes,next_action,next_action_date,created_by,created_at
		)
		SELECT i.id,i.account_id,i.contact_id,i.lead_id,i.event_id,i.participant_id,
		       i.program_id,i.program_session_id,i.program_participant_id,i.source_label,
		       i.type,i.direction,i.outcome,i.notes,i.next_action,i.next_action_date,
		       i.created_by,i.created_at,u.display_name
		FROM inserted i LEFT JOIN users u ON u.id=i.created_by AND u.account_id=i.account_id
	`, interaction.ID, interaction.AccountID, interaction.ContactID, interaction.LeadID,
		interaction.EventID, interaction.ParticipantID, interaction.ProgramID, interaction.ProgramSessionID,
		interaction.ProgramParticipantID, interaction.SourceLabel, interaction.Type, interaction.Direction,
		interaction.Outcome, interaction.Notes, interaction.NextAction, interaction.NextActionDate, interaction.CreatedBy,
	).Scan(
		&interaction.ID, &interaction.AccountID, &interaction.ContactID, &interaction.LeadID,
		&interaction.EventID, &interaction.ParticipantID, &interaction.ProgramID, &interaction.ProgramSessionID,
		&interaction.ProgramParticipantID, &interaction.SourceLabel, &interaction.Type, &interaction.Direction,
		&interaction.Outcome, &interaction.Notes, &interaction.NextAction, &interaction.NextActionDate,
		&interaction.CreatedBy, &interaction.CreatedAt, &interaction.CreatedByName,
	)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return interaction, nil
}

func (r *ContactProfileRepository) DeleteObservation(ctx context.Context, accountID, contactID, observationID uuid.UUID) error {
	var interactionType string
	var deleted bool
	err := r.db.QueryRow(ctx, `
		WITH target AS (
			SELECT i.id,i.type
			FROM interactions i
			WHERE i.account_id=$1 AND i.id=$3 AND (
				i.contact_id=$2
				OR EXISTS(SELECT 1 FROM leads l WHERE l.account_id=$1 AND l.contact_id=$2 AND l.id=i.lead_id)
				OR EXISTS(
					SELECT 1 FROM event_participants ep
					JOIN events e ON e.id=ep.event_id AND e.account_id=$1
					LEFT JOIN leads l ON l.id=ep.lead_id AND l.account_id=e.account_id
					WHERE COALESCE(ep.contact_id,l.contact_id)=$2 AND ep.id=i.participant_id
				)
				OR EXISTS(SELECT 1 FROM program_participants pp JOIN programs p ON p.id=pp.program_id AND p.account_id=$1 WHERE pp.contact_id=$2 AND pp.id=i.program_participant_id)
			)
			FOR UPDATE OF i
		), deleted AS (
			DELETE FROM interactions i USING target
			WHERE i.account_id=$1 AND i.id=target.id AND target.type=$4
			RETURNING i.id
		)
		SELECT target.type,EXISTS(SELECT 1 FROM deleted) FROM target
	`, accountID, contactID, observationID, domain.InteractionTypeNote).Scan(&interactionType, &deleted)
	if err == pgx.ErrNoRows {
		return ErrContactProfileObservationMissing
	}
	if err != nil {
		return err
	}
	if deleted {
		return nil
	}
	if interactionType == domain.InteractionTypeAttendance {
		return ErrAttendanceObservationProtected
	}
	return ErrContactProfileObservationLocked
}
