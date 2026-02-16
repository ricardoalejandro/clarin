package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type Repositories struct {
	db                *pgxpool.Pool
	User              *UserRepository
	UserAccount       *UserAccountRepository
	Account           *AccountRepository
	Device            *DeviceRepository
	Chat              *ChatRepository
	Message           *MessageRepository
	Contact           *ContactRepository
	ContactDeviceName *ContactDeviceNameRepository
	Lead              *LeadRepository
	Pipeline          *PipelineRepository
	Tag               *TagRepository
	Campaign          *CampaignRepository
	Event             *EventRepository
	Participant       *ParticipantRepository
	Interaction       *InteractionRepository
	SavedSticker      *SavedStickerRepository
	Reaction          *ReactionRepository
	Poll              *PollRepository
	CampaignAttachment *CampaignAttachmentRepository
	QuickReply         *QuickReplyRepository
}

func NewRepositories(db *pgxpool.Pool) *Repositories {
	return &Repositories{
		db:                db,
		User:              &UserRepository{db: db},
		UserAccount:       &UserAccountRepository{db: db},
		Account:           &AccountRepository{db: db},
		Device:            &DeviceRepository{db: db},
		Chat:              &ChatRepository{db: db},
		Message:           &MessageRepository{db: db},
		Contact:           &ContactRepository{db: db},
		ContactDeviceName: &ContactDeviceNameRepository{db: db},
		Lead:              &LeadRepository{db: db},
		Pipeline:          &PipelineRepository{db: db},
		Tag:               &TagRepository{db: db},
		Campaign:          &CampaignRepository{db: db},
		Event:             &EventRepository{db: db},
		Participant:       &ParticipantRepository{db: db},
		Interaction:       &InteractionRepository{db: db},
		SavedSticker:      &SavedStickerRepository{db: db},
		Reaction:          &ReactionRepository{db: db},
		Poll:              &PollRepository{db: db},
		CampaignAttachment: &CampaignAttachmentRepository{db: db},
		QuickReply:         &QuickReplyRepository{db: db},
	}
}

// DB returns the underlying database pool.
func (r *Repositories) DB() *pgxpool.Pool {
	return r.db
}

// UserRepository handles user data access
type UserRepository struct {
	db *pgxpool.Pool
}

func (r *UserRepository) GetByUsername(ctx context.Context, username string) (*domain.User, error) {
	user := &domain.User{}
	err := r.db.QueryRow(ctx, `
		SELECT u.id, u.account_id, u.username, u.email, u.password_hash, u.display_name, u.is_admin, u.is_active, u.is_super_admin, u.role, u.created_at, u.updated_at, a.name
		FROM users u JOIN accounts a ON a.id = u.account_id
		WHERE u.username = $1 AND u.is_active = TRUE
	`, username).Scan(
		&user.ID, &user.AccountID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.IsAdmin, &user.IsActive, &user.IsSuperAdmin, &user.Role, &user.CreatedAt, &user.UpdatedAt, &user.AccountName,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return user, err
}

func (r *UserRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.User, error) {
	user := &domain.User{}
	err := r.db.QueryRow(ctx, `
		SELECT u.id, u.account_id, u.username, u.email, u.password_hash, u.display_name, u.is_admin, u.is_active, u.is_super_admin, u.role, u.created_at, u.updated_at, a.name
		FROM users u JOIN accounts a ON a.id = u.account_id
		WHERE u.id = $1
	`, id).Scan(
		&user.ID, &user.AccountID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.IsAdmin, &user.IsActive, &user.IsSuperAdmin, &user.Role, &user.CreatedAt, &user.UpdatedAt, &user.AccountName,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return user, err
}

func (r *UserRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.User, error) {
	rows, err := r.db.Query(ctx, `
		SELECT u.id, u.account_id, u.username, u.email, u.password_hash, u.display_name, u.is_admin, u.is_active, u.is_super_admin, u.role, u.created_at, u.updated_at, a.name
		FROM users u JOIN accounts a ON a.id = u.account_id
		WHERE u.account_id = $1 ORDER BY u.created_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*domain.User
	for rows.Next() {
		user := &domain.User{}
		if err := rows.Scan(
			&user.ID, &user.AccountID, &user.Username, &user.Email, &user.PasswordHash,
			&user.DisplayName, &user.IsAdmin, &user.IsActive, &user.IsSuperAdmin, &user.Role, &user.CreatedAt, &user.UpdatedAt, &user.AccountName,
		); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, nil
}

func (r *UserRepository) GetAll(ctx context.Context) ([]*domain.User, error) {
	rows, err := r.db.Query(ctx, `
		SELECT u.id, u.account_id, u.username, u.email, u.password_hash, u.display_name, u.is_admin, u.is_active, u.is_super_admin, u.role, u.created_at, u.updated_at, a.name
		FROM users u JOIN accounts a ON a.id = u.account_id
		ORDER BY u.created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*domain.User
	for rows.Next() {
		user := &domain.User{}
		if err := rows.Scan(
			&user.ID, &user.AccountID, &user.Username, &user.Email, &user.PasswordHash,
			&user.DisplayName, &user.IsAdmin, &user.IsActive, &user.IsSuperAdmin, &user.Role, &user.CreatedAt, &user.UpdatedAt, &user.AccountName,
		); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, nil
}

func (r *UserRepository) Create(ctx context.Context, user *domain.User) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO users (account_id, username, email, password_hash, display_name, is_admin, is_super_admin, role)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, is_active, created_at, updated_at
	`, user.AccountID, user.Username, user.Email, user.PasswordHash, user.DisplayName, user.IsAdmin, user.IsSuperAdmin, user.Role).Scan(
		&user.ID, &user.IsActive, &user.CreatedAt, &user.UpdatedAt,
	)
}

func (r *UserRepository) Update(ctx context.Context, user *domain.User) error {
	_, err := r.db.Exec(ctx, `
		UPDATE users SET username = $2, email = $3, display_name = $4, is_admin = $5, role = $6, updated_at = NOW()
		WHERE id = $1
	`, user.ID, user.Username, user.Email, user.DisplayName, user.IsAdmin, user.Role)
	return err
}

func (r *UserRepository) UpdatePassword(ctx context.Context, userID uuid.UUID, passwordHash string) error {
	_, err := r.db.Exec(ctx, `UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, userID, passwordHash)
	return err
}

func (r *UserRepository) ToggleActive(ctx context.Context, userID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `UPDATE users SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1`, userID)
	return err
}

func (r *UserRepository) Delete(ctx context.Context, userID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
	return err
}

// UserAccountRepository handles user-account assignments (many-to-many)
type UserAccountRepository struct {
	db *pgxpool.Pool
}

func (r *UserAccountRepository) GetByUserID(ctx context.Context, userID uuid.UUID) ([]*domain.UserAccount, error) {
	rows, err := r.db.Query(ctx, `
		SELECT ua.id, ua.user_id, ua.account_id, ua.role, ua.is_default, ua.created_at,
		       a.name, COALESCE(a.slug, '')
		FROM user_accounts ua
		JOIN accounts a ON a.id = ua.account_id
		WHERE ua.user_id = $1
		ORDER BY ua.is_default DESC, a.name ASC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []*domain.UserAccount
	for rows.Next() {
		ua := &domain.UserAccount{}
		if err := rows.Scan(&ua.ID, &ua.UserID, &ua.AccountID, &ua.Role, &ua.IsDefault, &ua.CreatedAt,
			&ua.AccountName, &ua.AccountSlug); err != nil {
			return nil, err
		}
		accounts = append(accounts, ua)
	}
	return accounts, nil
}

func (r *UserAccountRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.UserAccount, error) {
	rows, err := r.db.Query(ctx, `
		SELECT ua.id, ua.user_id, ua.account_id, ua.role, ua.is_default, ua.created_at,
		       a.name, COALESCE(a.slug, '')
		FROM user_accounts ua
		JOIN accounts a ON a.id = ua.account_id
		WHERE ua.account_id = $1
		ORDER BY ua.created_at ASC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []*domain.UserAccount
	for rows.Next() {
		ua := &domain.UserAccount{}
		if err := rows.Scan(&ua.ID, &ua.UserID, &ua.AccountID, &ua.Role, &ua.IsDefault, &ua.CreatedAt,
			&ua.AccountName, &ua.AccountSlug); err != nil {
			return nil, err
		}
		accounts = append(accounts, ua)
	}
	return accounts, nil
}

func (r *UserAccountRepository) Exists(ctx context.Context, userID, accountID uuid.UUID) (bool, error) {
	var count int
	err := r.db.QueryRow(ctx, `SELECT COUNT(*) FROM user_accounts WHERE user_id = $1 AND account_id = $2`, userID, accountID).Scan(&count)
	return count > 0, err
}

func (r *UserAccountRepository) Assign(ctx context.Context, ua *domain.UserAccount) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO user_accounts (user_id, account_id, role, is_default)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id, account_id) DO UPDATE SET role = EXCLUDED.role
		RETURNING id, created_at
	`, ua.UserID, ua.AccountID, ua.Role, ua.IsDefault).Scan(&ua.ID, &ua.CreatedAt)
}

func (r *UserAccountRepository) UpdateRole(ctx context.Context, userID, accountID uuid.UUID, role string) error {
	_, err := r.db.Exec(ctx, `UPDATE user_accounts SET role = $3 WHERE user_id = $1 AND account_id = $2`, userID, accountID, role)
	return err
}

func (r *UserAccountRepository) Remove(ctx context.Context, userID, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM user_accounts WHERE user_id = $1 AND account_id = $2`, userID, accountID)
	return err
}

func (r *UserAccountRepository) SetDefault(ctx context.Context, userID, accountID uuid.UUID) error {
	// Unset all defaults for this user, then set the new one
	_, err := r.db.Exec(ctx, `UPDATE user_accounts SET is_default = FALSE WHERE user_id = $1`, userID)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `UPDATE user_accounts SET is_default = TRUE WHERE user_id = $1 AND account_id = $2`, userID, accountID)
	return err
}

// AccountRepository handles account data access
type AccountRepository struct {
	db *pgxpool.Pool
}

func (r *AccountRepository) GetAll(ctx context.Context) ([]*domain.Account, error) {
	rows, err := r.db.Query(ctx, `
		SELECT a.id, a.name, COALESCE(a.slug, ''), a.plan, a.max_devices, COALESCE(a.is_active, true), a.created_at, a.updated_at,
			(SELECT COUNT(*) FROM users WHERE account_id = a.id) as user_count,
			(SELECT COUNT(*) FROM devices WHERE account_id = a.id) as device_count,
			(SELECT COUNT(*) FROM chats WHERE account_id = a.id) as chat_count
		FROM accounts a ORDER BY a.created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []*domain.Account
	for rows.Next() {
		a := &domain.Account{}
		if err := rows.Scan(&a.ID, &a.Name, &a.Slug, &a.Plan, &a.MaxDevices, &a.IsActive, &a.CreatedAt, &a.UpdatedAt,
			&a.UserCount, &a.DeviceCount, &a.ChatCount); err != nil {
			return nil, err
		}
		accounts = append(accounts, a)
	}
	return accounts, nil
}

func (r *AccountRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Account, error) {
	a := &domain.Account{}
	err := r.db.QueryRow(ctx, `
		SELECT a.id, a.name, COALESCE(a.slug, ''), a.plan, a.max_devices, COALESCE(a.is_active, true), a.created_at, a.updated_at,
			(SELECT COUNT(*) FROM users WHERE account_id = a.id) as user_count,
			(SELECT COUNT(*) FROM devices WHERE account_id = a.id) as device_count,
			(SELECT COUNT(*) FROM chats WHERE account_id = a.id) as chat_count
		FROM accounts a WHERE a.id = $1
	`, id).Scan(&a.ID, &a.Name, &a.Slug, &a.Plan, &a.MaxDevices, &a.IsActive, &a.CreatedAt, &a.UpdatedAt,
		&a.UserCount, &a.DeviceCount, &a.ChatCount)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return a, err
}

func (r *AccountRepository) Create(ctx context.Context, a *domain.Account) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO accounts (name, slug, plan, max_devices, is_active)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at, updated_at
	`, a.Name, a.Slug, a.Plan, a.MaxDevices, a.IsActive).Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt)
}

func (r *AccountRepository) Update(ctx context.Context, a *domain.Account) error {
	_, err := r.db.Exec(ctx, `
		UPDATE accounts SET name = $2, slug = $3, plan = $4, max_devices = $5, updated_at = NOW()
		WHERE id = $1
	`, a.ID, a.Name, a.Slug, a.Plan, a.MaxDevices)
	return err
}

func (r *AccountRepository) ToggleActive(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `UPDATE accounts SET is_active = NOT COALESCE(is_active, true), updated_at = NOW() WHERE id = $1`, id)
	return err
}

func (r *AccountRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM accounts WHERE id = $1`, id)
	return err
}

// DeviceRepository handles device data access
type DeviceRepository struct {
	db *pgxpool.Pool
}

func (r *DeviceRepository) Create(ctx context.Context, device *domain.Device) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO devices (account_id, name, status)
		VALUES ($1, $2, $3)
		RETURNING id, created_at, updated_at
	`, device.AccountID, device.Name, domain.DeviceStatusDisconnected).Scan(
		&device.ID, &device.CreatedAt, &device.UpdatedAt,
	)
}

func (r *DeviceRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Device, error) {
	device := &domain.Device{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, phone, jid, status, qr_code, last_seen_at, created_at, updated_at
		FROM devices WHERE id = $1
	`, id).Scan(
		&device.ID, &device.AccountID, &device.Name, &device.Phone, &device.JID,
		&device.Status, &device.QRCode, &device.LastSeenAt, &device.CreatedAt, &device.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return device, err
}

func (r *DeviceRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Device, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, name, phone, jid, status, qr_code, last_seen_at, created_at, updated_at
		FROM devices WHERE account_id = $1 ORDER BY created_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []*domain.Device
	for rows.Next() {
		device := &domain.Device{}
		if err := rows.Scan(
			&device.ID, &device.AccountID, &device.Name, &device.Phone, &device.JID,
			&device.Status, &device.QRCode, &device.LastSeenAt, &device.CreatedAt, &device.UpdatedAt,
		); err != nil {
			return nil, err
		}
		devices = append(devices, device)
	}
	return devices, nil
}

func (r *DeviceRepository) GetAll(ctx context.Context) ([]*domain.Device, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, name, phone, jid, status, qr_code, last_seen_at, created_at, updated_at
		FROM devices ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []*domain.Device
	for rows.Next() {
		device := &domain.Device{}
		if err := rows.Scan(
			&device.ID, &device.AccountID, &device.Name, &device.Phone, &device.JID,
			&device.Status, &device.QRCode, &device.LastSeenAt, &device.CreatedAt, &device.UpdatedAt,
		); err != nil {
			return nil, err
		}
		devices = append(devices, device)
	}
	return devices, nil
}

func (r *DeviceRepository) UpdateStatus(ctx context.Context, id uuid.UUID, status string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE devices SET status = $1, updated_at = NOW() WHERE id = $2
	`, status, id)
	return err
}

func (r *DeviceRepository) UpdateJID(ctx context.Context, id uuid.UUID, jid, phone string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE devices SET jid = $1, phone = $2, status = $3, last_seen_at = NOW(), updated_at = NOW() WHERE id = $4
	`, jid, phone, domain.DeviceStatusConnected, id)
	return err
}

func (r *DeviceRepository) UpdateName(ctx context.Context, id uuid.UUID, name string) error {
	_, err := r.db.Exec(ctx, `UPDATE devices SET name = $1, updated_at = NOW() WHERE id = $2`, name, id)
	return err
}

func (r *DeviceRepository) UpdateQRCode(ctx context.Context, id uuid.UUID, qrCode string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE devices SET qr_code = $1, status = $2, updated_at = NOW() WHERE id = $3
	`, qrCode, domain.DeviceStatusConnecting, id)
	return err
}

func (r *DeviceRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM devices WHERE id = $1`, id)
	return err
}

// ChatRepository handles chat data access
type ChatRepository struct {
	db *pgxpool.Pool
}

func (r *ChatRepository) GetOrCreate(ctx context.Context, accountID, deviceID uuid.UUID, jid, name string) (*domain.Chat, error) {
	chat := &domain.Chat{}
	err := r.db.QueryRow(ctx, `
		INSERT INTO chats (account_id, device_id, jid, name)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (account_id, jid) DO UPDATE SET
			device_id = EXCLUDED.device_id,
			name = CASE WHEN EXCLUDED.name != '' AND EXCLUDED.name IS NOT NULL THEN EXCLUDED.name ELSE chats.name END
		RETURNING id, account_id, device_id, contact_id, jid, name, last_message, last_message_at,
		          unread_count, is_archived, is_pinned, created_at, updated_at
	`, accountID, deviceID, jid, name).Scan(
		&chat.ID, &chat.AccountID, &chat.DeviceID, &chat.ContactID, &chat.JID, &chat.Name,
		&chat.LastMessage, &chat.LastMessageAt, &chat.UnreadCount, &chat.IsArchived,
		&chat.IsPinned, &chat.CreatedAt, &chat.UpdatedAt,
	)
	return chat, err
}

func (r *ChatRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Chat, error) {
	chat := &domain.Chat{}
	err := r.db.QueryRow(ctx, `
		SELECT c.id, c.account_id, c.device_id, c.contact_id, c.jid, c.name, c.last_message, c.last_message_at,
		       c.unread_count, c.is_archived, c.is_pinned, c.created_at, c.updated_at,
		       d.name, d.phone,
		       ctc.phone, ctc.avatar_url, ctc.custom_name, ctc.name
		FROM chats c
		LEFT JOIN devices d ON c.device_id = d.id
		LEFT JOIN contacts ctc ON ctc.account_id = c.account_id AND ctc.jid = c.jid
		WHERE c.id = $1
	`, id).Scan(
		&chat.ID, &chat.AccountID, &chat.DeviceID, &chat.ContactID, &chat.JID, &chat.Name,
		&chat.LastMessage, &chat.LastMessageAt, &chat.UnreadCount, &chat.IsArchived,
		&chat.IsPinned, &chat.CreatedAt, &chat.UpdatedAt,
		&chat.DeviceName, &chat.DevicePhone,
		&chat.ContactPhone, &chat.ContactAvatarURL, &chat.ContactCustomName, &chat.ContactName,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return chat, err
}

func (r *ChatRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Chat, error) {
	rows, err := r.db.Query(ctx, `
		SELECT c.id, c.account_id, c.device_id, c.contact_id, c.jid, c.name, c.last_message, c.last_message_at,
		       c.unread_count, c.is_archived, c.is_pinned, c.created_at, c.updated_at,
		       d.name, d.phone,
		       ctc.phone, ctc.avatar_url, ctc.custom_name, ctc.name
		FROM chats c
		LEFT JOIN devices d ON c.device_id = d.id
		LEFT JOIN contacts ctc ON ctc.account_id = c.account_id AND ctc.jid = c.jid
		WHERE c.account_id = $1 AND c.jid NOT LIKE '%@g.us' AND c.jid NOT LIKE '%@newsletter' AND c.jid NOT LIKE '%@broadcast' AND c.jid NOT LIKE '%@lid'
		ORDER BY c.is_pinned DESC, c.last_message_at DESC NULLS LAST
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var chats []*domain.Chat
	for rows.Next() {
		chat := &domain.Chat{}
		if err := rows.Scan(
			&chat.ID, &chat.AccountID, &chat.DeviceID, &chat.ContactID, &chat.JID, &chat.Name,
			&chat.LastMessage, &chat.LastMessageAt, &chat.UnreadCount, &chat.IsArchived,
			&chat.IsPinned, &chat.CreatedAt, &chat.UpdatedAt,
			&chat.DeviceName, &chat.DevicePhone,
			&chat.ContactPhone, &chat.ContactAvatarURL, &chat.ContactCustomName, &chat.ContactName,
		); err != nil {
			return nil, err
		}
		chats = append(chats, chat)
	}
	return chats, nil
}

func (r *ChatRepository) GetByAccountIDWithFilters(ctx context.Context, accountID uuid.UUID, filter domain.ChatFilter) ([]*domain.Chat, int, error) {
	// Build dynamic query
	baseQuery := `
		FROM chats c
		LEFT JOIN devices d ON c.device_id = d.id
		LEFT JOIN contacts ctc ON ctc.account_id = c.account_id AND ctc.jid = c.jid
		WHERE c.account_id = $1 AND c.jid NOT LIKE '%@g.us' AND c.jid NOT LIKE '%@newsletter' AND c.jid NOT LIKE '%@broadcast' AND c.jid NOT LIKE '%@lid'
	`
	args := []interface{}{accountID}
	argNum := 2

	// Device filter
	if len(filter.DeviceIDs) > 0 {
		baseQuery += fmt.Sprintf(" AND c.device_id = ANY($%d)", argNum)
		args = append(args, filter.DeviceIDs)
		argNum++
	}

	// Tag filter (filter by contact tags)
	if len(filter.TagIDs) > 0 {
		baseQuery += fmt.Sprintf(" AND ctc.id IN (SELECT contact_id FROM contact_tags WHERE tag_id = ANY($%d))", argNum)
		args = append(args, filter.TagIDs)
		argNum++
	}

	// Unread filter
	if filter.UnreadOnly {
		baseQuery += " AND c.unread_count > 0"
	}

	// Archived filter
	if !filter.Archived {
		baseQuery += " AND c.is_archived = FALSE"
	}

	// Search filter
	if filter.Search != "" {
		baseQuery += fmt.Sprintf(" AND (c.name ILIKE $%d OR c.jid ILIKE $%d OR ctc.custom_name ILIKE $%d OR ctc.name ILIKE $%d OR ctc.push_name ILIKE $%d OR ctc.phone ILIKE $%d)", argNum, argNum, argNum, argNum, argNum, argNum)
		args = append(args, "%"+filter.Search+"%")
		argNum++
	}

	// Count total
	var total int
	countQuery := "SELECT COUNT(*) " + baseQuery
	if err := r.db.QueryRow(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	// Get data
	selectQuery := `
		SELECT c.id, c.account_id, c.device_id, c.contact_id, c.jid, c.name, c.last_message, c.last_message_at,
		       c.unread_count, c.is_archived, c.is_pinned, c.created_at, c.updated_at,
		       d.name, d.phone,
		       ctc.phone, ctc.avatar_url, ctc.custom_name, ctc.name
	` + baseQuery + " ORDER BY c.is_pinned DESC, c.last_message_at DESC NULLS LAST"

	// Apply pagination
	if filter.Limit > 0 {
		selectQuery += fmt.Sprintf(" LIMIT %d", filter.Limit)
		if filter.Offset > 0 {
			selectQuery += fmt.Sprintf(" OFFSET %d", filter.Offset)
		}
	}

	rows, err := r.db.Query(ctx, selectQuery, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var chats []*domain.Chat
	for rows.Next() {
		chat := &domain.Chat{}
		if err := rows.Scan(
			&chat.ID, &chat.AccountID, &chat.DeviceID, &chat.ContactID, &chat.JID, &chat.Name,
			&chat.LastMessage, &chat.LastMessageAt, &chat.UnreadCount, &chat.IsArchived,
			&chat.IsPinned, &chat.CreatedAt, &chat.UpdatedAt,
			&chat.DeviceName, &chat.DevicePhone,
			&chat.ContactPhone, &chat.ContactAvatarURL, &chat.ContactCustomName, &chat.ContactName,
		); err != nil {
			return nil, 0, err
		}
		chats = append(chats, chat)
	}

	return chats, total, nil
}

func (r *ChatRepository) UpdateLastMessage(ctx context.Context, chatID uuid.UUID, message string, timestamp time.Time, incrementUnread bool) error {
	query := `
		UPDATE chats SET last_message = $1, last_message_at = $2, updated_at = NOW()
	`
	if incrementUnread {
		query += `, unread_count = unread_count + 1`
	}
	query += ` WHERE id = $3`
	_, err := r.db.Exec(ctx, query, message, timestamp, chatID)
	return err
}

func (r *ChatRepository) MarkAsRead(ctx context.Context, chatID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `UPDATE chats SET unread_count = 0, updated_at = NOW() WHERE id = $1`, chatID)
	return err
}

func (r *ChatRepository) Delete(ctx context.Context, id uuid.UUID) error {
	// First delete all messages in the chat
	_, err := r.db.Exec(ctx, `DELETE FROM messages WHERE chat_id = $1`, id)
	if err != nil {
		return err
	}
	// Then delete the chat
	_, err = r.db.Exec(ctx, `DELETE FROM chats WHERE id = $1`, id)
	return err
}

func (r *ChatRepository) DeleteBatch(ctx context.Context, ids []uuid.UUID) error {
	// First delete all messages in the chats
	_, err := r.db.Exec(ctx, `DELETE FROM messages WHERE chat_id = ANY($1)`, ids)
	if err != nil {
		return err
	}
	// Then delete the chats
	_, err = r.db.Exec(ctx, `DELETE FROM chats WHERE id = ANY($1)`, ids)
	return err
}

func (r *ChatRepository) DeleteAll(ctx context.Context, accountID uuid.UUID) error {
	// First delete all messages for the account
	_, err := r.db.Exec(ctx, `DELETE FROM messages WHERE account_id = $1`, accountID)
	if err != nil {
		return err
	}
	// Then delete all chats
	_, err = r.db.Exec(ctx, `DELETE FROM chats WHERE account_id = $1`, accountID)
	return err
}

// MessageRepository handles message data access
type MessageRepository struct {
	db *pgxpool.Pool
}

func (r *MessageRepository) Create(ctx context.Context, msg *domain.Message) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO messages (account_id, device_id, chat_id, message_id, from_jid, from_name, body,
		                      message_type, media_url, media_mimetype, media_filename, media_size,
		                      is_from_me, is_read, status, timestamp,
		                      quoted_message_id, quoted_body, quoted_sender,
		                      poll_question, poll_max_selections)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
		ON CONFLICT (account_id, device_id, message_id) DO NOTHING
		RETURNING id, created_at
	`, msg.AccountID, msg.DeviceID, msg.ChatID, msg.MessageID, msg.FromJID, msg.FromName, msg.Body,
		msg.MessageType, msg.MediaURL, msg.MediaMimetype, msg.MediaFilename, msg.MediaSize,
		msg.IsFromMe, msg.IsRead, msg.Status, msg.Timestamp,
		msg.QuotedMessageID, msg.QuotedBody, msg.QuotedSender,
		msg.PollQuestion, msg.PollMaxSelections,
	).Scan(&msg.ID, &msg.CreatedAt)
}

func (r *MessageRepository) GetByChatID(ctx context.Context, chatID uuid.UUID, limit, offset int) ([]*domain.Message, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, device_id, chat_id, message_id, from_jid, from_name, body,
		       message_type, media_url, media_mimetype, media_filename, media_size,
		       is_from_me, is_read, status, timestamp, created_at,
		       quoted_message_id, quoted_body, quoted_sender
		FROM messages WHERE chat_id = $1
		ORDER BY timestamp DESC
		LIMIT $2 OFFSET $3
	`, chatID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []*domain.Message
	for rows.Next() {
		msg := &domain.Message{}
		if err := rows.Scan(
			&msg.ID, &msg.AccountID, &msg.DeviceID, &msg.ChatID, &msg.MessageID, &msg.FromJID,
			&msg.FromName, &msg.Body, &msg.MessageType, &msg.MediaURL, &msg.MediaMimetype,
			&msg.MediaFilename, &msg.MediaSize, &msg.IsFromMe, &msg.IsRead, &msg.Status,
			&msg.Timestamp, &msg.CreatedAt,
			&msg.QuotedMessageID, &msg.QuotedBody, &msg.QuotedSender,
		); err != nil {
			return nil, err
		}
		messages = append(messages, msg)
	}
	return messages, nil
}

// GetByMessageID finds a message by its WhatsApp message_id within a chat
func (r *MessageRepository) GetByMessageID(ctx context.Context, chatID uuid.UUID, messageID string) (*domain.Message, error) {
	msg := &domain.Message{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, device_id, chat_id, message_id, from_jid, from_name, body,
		       message_type, media_url, media_mimetype, media_filename, media_size,
		       is_from_me, is_read, status, timestamp, created_at,
		       quoted_message_id, quoted_body, quoted_sender
		FROM messages WHERE chat_id = $1 AND message_id = $2
		LIMIT 1
	`, chatID, messageID).Scan(
		&msg.ID, &msg.AccountID, &msg.DeviceID, &msg.ChatID, &msg.MessageID, &msg.FromJID,
		&msg.FromName, &msg.Body, &msg.MessageType, &msg.MediaURL, &msg.MediaMimetype,
		&msg.MediaFilename, &msg.MediaSize, &msg.IsFromMe, &msg.IsRead, &msg.Status,
		&msg.Timestamp, &msg.CreatedAt,
		&msg.QuotedMessageID, &msg.QuotedBody, &msg.QuotedSender,
	)
	if err != nil {
		return nil, err
	}
	return msg, nil
}

// ContactRepository handles contact data access
type ContactRepository struct {
	db *pgxpool.Pool
}

func (r *MessageRepository) GetRecentStickers(ctx context.Context, accountID uuid.UUID, limit int) ([]string, error) {
	rows, err := r.db.Query(ctx, `
		SELECT DISTINCT media_url FROM messages
		WHERE account_id = $1 AND message_type = 'sticker' AND media_url IS NOT NULL AND media_url != ''
		ORDER BY media_url DESC
		LIMIT $2
	`, accountID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var urls []string
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			return nil, err
		}
		urls = append(urls, url)
	}
	return urls, nil
}

func (r *ContactRepository) GetOrCreate(ctx context.Context, accountID uuid.UUID, deviceID *uuid.UUID, jid, phone, name, pushName string, isGroup bool) (*domain.Contact, error) {
	contact := &domain.Contact{}
	err := r.db.QueryRow(ctx, `
		INSERT INTO contacts (account_id, device_id, jid, phone, name, push_name, is_group)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (account_id, jid) DO UPDATE SET
			name = COALESCE(NULLIF(EXCLUDED.name, ''), contacts.name),
			push_name = COALESCE(NULLIF(EXCLUDED.push_name, ''), contacts.push_name),
			phone = COALESCE(NULLIF(EXCLUDED.phone, ''), contacts.phone),
			updated_at = NOW()
		RETURNING id, account_id, device_id, jid, phone, name, last_name, short_name, custom_name, push_name, avatar_url,
		          email, company, age, tags, notes, source, is_group, created_at, updated_at
	`, accountID, deviceID, jid, phone, name, pushName, isGroup).Scan(
		&contact.ID, &contact.AccountID, &contact.DeviceID, &contact.JID, &contact.Phone,
		&contact.Name, &contact.LastName, &contact.ShortName, &contact.CustomName, &contact.PushName, &contact.AvatarURL,
		&contact.Email, &contact.Company, &contact.Age, &contact.Tags, &contact.Notes, &contact.Source,
		&contact.IsGroup, &contact.CreatedAt, &contact.UpdatedAt,
	)
	return contact, err
}

func (r *ContactRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Contact, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, device_id, jid, phone, name, last_name, short_name, custom_name, push_name, avatar_url,
		       email, company, age, tags, notes, source, is_group, created_at, updated_at
		FROM contacts WHERE account_id = $1 ORDER BY COALESCE(custom_name, name, push_name, phone) ASC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var contacts []*domain.Contact
	for rows.Next() {
		contact := &domain.Contact{}
		if err := rows.Scan(
			&contact.ID, &contact.AccountID, &contact.DeviceID, &contact.JID, &contact.Phone,
			&contact.Name, &contact.LastName, &contact.ShortName, &contact.CustomName, &contact.PushName, &contact.AvatarURL,
			&contact.Email, &contact.Company, &contact.Age, &contact.Tags, &contact.Notes, &contact.Source,
			&contact.IsGroup, &contact.CreatedAt, &contact.UpdatedAt,
		); err != nil {
			return nil, err
		}
		contacts = append(contacts, contact)
	}
	return contacts, nil
}

func (r *ContactRepository) GetByAccountIDWithFilters(ctx context.Context, accountID uuid.UUID, filter domain.ContactFilter) ([]*domain.Contact, int, error) {
	baseQuery := `
		FROM contacts
		WHERE account_id = $1 AND is_group = $2
	`
	args := []interface{}{accountID, filter.IsGroup}
	argNum := 3

	if filter.Search != "" {
		baseQuery += fmt.Sprintf(` AND (
			name ILIKE $%d OR last_name ILIKE $%d OR short_name ILIKE $%d OR custom_name ILIKE $%d OR push_name ILIKE $%d OR
			phone ILIKE $%d OR jid ILIKE $%d OR email ILIKE $%d OR company ILIKE $%d
		)`, argNum, argNum, argNum, argNum, argNum, argNum, argNum, argNum, argNum)
		args = append(args, "%"+filter.Search+"%")
		argNum++
	}

	if filter.DeviceID != nil {
		baseQuery += fmt.Sprintf(" AND device_id = $%d", argNum)
		args = append(args, *filter.DeviceID)
		argNum++
	}

	if filter.HasPhone {
		baseQuery += " AND phone IS NOT NULL AND phone != ''"
	}

	if len(filter.Tags) > 0 {
		baseQuery += fmt.Sprintf(" AND tags && $%d", argNum)
		args = append(args, filter.Tags)
		argNum++
	}

	if len(filter.TagIDs) > 0 {
		baseQuery += fmt.Sprintf(" AND id IN (SELECT contact_id FROM contact_tags WHERE tag_id = ANY($%d))", argNum)
		args = append(args, filter.TagIDs)
		argNum++
	}

	// Count
	var total int
	if err := r.db.QueryRow(ctx, "SELECT COUNT(*) "+baseQuery, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	// Select
	selectQuery := `
		SELECT id, account_id, device_id, jid, phone, name, last_name, short_name, custom_name, push_name, avatar_url,
		       email, company, age, tags, notes, source, is_group, created_at, updated_at
	` + baseQuery + " ORDER BY COALESCE(custom_name, name, push_name, phone) ASC NULLS LAST"

	if filter.Limit > 0 {
		selectQuery += fmt.Sprintf(" LIMIT %d", filter.Limit)
		if filter.Offset > 0 {
			selectQuery += fmt.Sprintf(" OFFSET %d", filter.Offset)
		}
	}

	rows, err := r.db.Query(ctx, selectQuery, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var contacts []*domain.Contact
	for rows.Next() {
		contact := &domain.Contact{}
		if err := rows.Scan(
			&contact.ID, &contact.AccountID, &contact.DeviceID, &contact.JID, &contact.Phone,
			&contact.Name, &contact.LastName, &contact.ShortName, &contact.CustomName, &contact.PushName, &contact.AvatarURL,
			&contact.Email, &contact.Company, &contact.Age, &contact.Tags, &contact.Notes, &contact.Source,
			&contact.IsGroup, &contact.CreatedAt, &contact.UpdatedAt,
		); err != nil {
			return nil, 0, err
		}
		contacts = append(contacts, contact)
	}
	return contacts, total, nil
}

func (r *ContactRepository) GetByJID(ctx context.Context, accountID uuid.UUID, jid string) (*domain.Contact, error) {
	contact := &domain.Contact{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, device_id, jid, phone, name, last_name, short_name, custom_name, push_name, avatar_url,
		       email, company, age, tags, notes, source, is_group, created_at, updated_at
		FROM contacts WHERE account_id = $1 AND jid = $2
	`, accountID, jid).Scan(
		&contact.ID, &contact.AccountID, &contact.DeviceID, &contact.JID, &contact.Phone,
		&contact.Name, &contact.LastName, &contact.ShortName, &contact.CustomName, &contact.PushName, &contact.AvatarURL,
		&contact.Email, &contact.Company, &contact.Age, &contact.Tags, &contact.Notes, &contact.Source,
		&contact.IsGroup, &contact.CreatedAt, &contact.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return contact, err
}

func (r *ContactRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Contact, error) {
	contact := &domain.Contact{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, device_id, jid, phone, name, last_name, short_name, custom_name, push_name, avatar_url,
		       email, company, age, tags, notes, source, is_group, created_at, updated_at
		FROM contacts WHERE id = $1
	`, id).Scan(
		&contact.ID, &contact.AccountID, &contact.DeviceID, &contact.JID, &contact.Phone,
		&contact.Name, &contact.LastName, &contact.ShortName, &contact.CustomName, &contact.PushName, &contact.AvatarURL,
		&contact.Email, &contact.Company, &contact.Age, &contact.Tags, &contact.Notes, &contact.Source,
		&contact.IsGroup, &contact.CreatedAt, &contact.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return contact, err
}

func (r *ContactRepository) Update(ctx context.Context, contact *domain.Contact) error {
	_, err := r.db.Exec(ctx, `
		UPDATE contacts SET
			name = $1, last_name = $2, short_name = $3, custom_name = $4, push_name = $5,
			email = $6, company = $7, age = $8,
			tags = $9, notes = $10, phone = $11, updated_at = NOW()
		WHERE id = $12
	`, contact.Name, contact.LastName, contact.ShortName, contact.CustomName, contact.PushName, contact.Email, contact.Company,
		contact.Age, contact.Tags, contact.Notes, contact.Phone, contact.ID)
	return err
}

// SyncToParticipants propagates shared contact fields to all linked event_participants
func (r *ContactRepository) SyncToParticipants(ctx context.Context, contact *domain.Contact) error {
	_, err := r.db.Exec(ctx, `
		UPDATE event_participants SET
			name = COALESCE($1, name), last_name = $2, short_name = $3, phone = $4, email = $5, age = $6, updated_at = NOW()
		WHERE contact_id = $7
	`, contact.Name, contact.LastName, contact.ShortName, contact.Phone, contact.Email, contact.Age, contact.ID)
	return err
}

// SyncToLead propagates shared contact fields to the linked lead
func (r *ContactRepository) SyncToLead(ctx context.Context, contact *domain.Contact) error {
	displayName := contact.DisplayName()
	_, err := r.db.Exec(ctx, `
		UPDATE leads SET
			name = COALESCE($1, name),
			last_name = COALESCE($2, last_name),
			short_name = COALESCE($3, short_name),
			phone = COALESCE($4, phone),
			email = COALESCE($5, email),
			company = COALESCE($6, company),
			age = COALESCE($7, age),
			notes = COALESCE($8, notes),
			updated_at = NOW()
		WHERE account_id = $9 AND jid = $10
	`, &displayName, contact.LastName, contact.ShortName, contact.Phone, contact.Email, contact.Company, contact.Age, contact.Notes, contact.AccountID, contact.JID)
	return err
}

func (r *ContactRepository) UpdateAvatarURL(ctx context.Context, accountID uuid.UUID, jid, avatarURL string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE contacts SET avatar_url = $1, updated_at = NOW()
		WHERE account_id = $2 AND jid = $3
	`, avatarURL, accountID, jid)
	return err
}

func (r *ContactRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM contacts WHERE id = $1`, id)
	return err
}

func (r *ContactRepository) DeleteBatch(ctx context.Context, ids []uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM contacts WHERE id = ANY($1)`, ids)
	return err
}

func (r *ContactRepository) DeleteAll(ctx context.Context, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM contacts WHERE account_id = $1`, accountID)
	return err
}

func (r *ContactRepository) FindDuplicates(ctx context.Context, accountID uuid.UUID) ([][]*domain.Contact, error) {
	// Find contacts with the same phone number
	rows, err := r.db.Query(ctx, `
		SELECT c.id, c.account_id, c.device_id, c.jid, c.phone, c.name, c.last_name, c.short_name, c.custom_name, c.push_name,
		       c.avatar_url, c.email, c.company, c.age, c.tags, c.notes, c.source, c.is_group, c.created_at, c.updated_at
		FROM contacts c
		INNER JOIN (
			SELECT phone FROM contacts
			WHERE account_id = $1 AND phone IS NOT NULL AND phone != '' AND is_group = FALSE
			GROUP BY phone HAVING COUNT(*) > 1
		) dup ON c.phone = dup.phone
		WHERE c.account_id = $1 AND c.is_group = FALSE
		ORDER BY c.phone, c.updated_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	grouped := make(map[string][]*domain.Contact)
	var order []string
	for rows.Next() {
		contact := &domain.Contact{}
		if err := rows.Scan(
			&contact.ID, &contact.AccountID, &contact.DeviceID, &contact.JID, &contact.Phone,
			&contact.Name, &contact.LastName, &contact.ShortName, &contact.CustomName, &contact.PushName, &contact.AvatarURL,
			&contact.Email, &contact.Company, &contact.Age, &contact.Tags, &contact.Notes, &contact.Source,
			&contact.IsGroup, &contact.CreatedAt, &contact.UpdatedAt,
		); err != nil {
			return nil, err
		}
		phone := ""
		if contact.Phone != nil {
			phone = *contact.Phone
		}
		if _, exists := grouped[phone]; !exists {
			order = append(order, phone)
		}
		grouped[phone] = append(grouped[phone], contact)
	}

	var result [][]*domain.Contact
	for _, phone := range order {
		result = append(result, grouped[phone])
	}
	return result, nil
}

func (r *ContactRepository) MergeContacts(ctx context.Context, keepID uuid.UUID, mergeIDs []uuid.UUID) error {
	// Update chats to point to the kept contact's JID
	keepContact, err := r.GetByID(ctx, keepID)
	if err != nil || keepContact == nil {
		return fmt.Errorf("contact to keep not found")
	}

	for _, mergeID := range mergeIDs {
		mergeContact, err := r.GetByID(ctx, mergeID)
		if err != nil || mergeContact == nil {
			continue
		}
		// Update chats JID references
		_, _ = r.db.Exec(ctx, `
			UPDATE chats SET jid = $1, updated_at = NOW()
			WHERE account_id = $2 AND jid = $3
		`, keepContact.JID, keepContact.AccountID, mergeContact.JID)

		// Update leads JID references
		_, _ = r.db.Exec(ctx, `
			UPDATE leads SET jid = $1, updated_at = NOW()
			WHERE account_id = $2 AND jid = $3
		`, keepContact.JID, keepContact.AccountID, mergeContact.JID)

		// Move device names to the kept contact
		// First delete any rows that would conflict (same device already has a name for keepID)
		_, _ = r.db.Exec(ctx, `
			DELETE FROM contact_device_names WHERE contact_id = $1
			AND device_id IN (SELECT device_id FROM contact_device_names WHERE contact_id = $2)
		`, mergeID, keepID)
		// Then move remaining device names
		_, _ = r.db.Exec(ctx, `
			UPDATE contact_device_names SET contact_id = $1 WHERE contact_id = $2
		`, keepID, mergeID)

		// Delete merged contact
		_, _ = r.db.Exec(ctx, `DELETE FROM contacts WHERE id = $1`, mergeID)
	}
	return nil
}

// ContactDeviceNameRepository handles per-device contact names
type ContactDeviceNameRepository struct {
	db *pgxpool.Pool
}

func (r *ContactDeviceNameRepository) Upsert(ctx context.Context, cdn *domain.ContactDeviceName) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO contact_device_names (contact_id, device_id, name, push_name, business_name)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (contact_id, device_id) DO UPDATE SET
			name = COALESCE(EXCLUDED.name, contact_device_names.name),
			push_name = COALESCE(EXCLUDED.push_name, contact_device_names.push_name),
			business_name = COALESCE(EXCLUDED.business_name, contact_device_names.business_name),
			synced_at = NOW()
		RETURNING id, synced_at
	`, cdn.ContactID, cdn.DeviceID, cdn.Name, cdn.PushName, cdn.BusinessName).Scan(&cdn.ID, &cdn.SyncedAt)
}

func (r *ContactDeviceNameRepository) GetByContactID(ctx context.Context, contactID uuid.UUID) ([]domain.ContactDeviceName, error) {
	rows, err := r.db.Query(ctx, `
		SELECT cdn.id, cdn.contact_id, cdn.device_id, cdn.name, cdn.push_name, cdn.business_name, cdn.synced_at,
		       d.name as device_name
		FROM contact_device_names cdn
		LEFT JOIN devices d ON d.id = cdn.device_id
		WHERE cdn.contact_id = $1
		ORDER BY cdn.synced_at DESC
	`, contactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var names []domain.ContactDeviceName
	for rows.Next() {
		cdn := domain.ContactDeviceName{}
		if err := rows.Scan(
			&cdn.ID, &cdn.ContactID, &cdn.DeviceID, &cdn.Name, &cdn.PushName,
			&cdn.BusinessName, &cdn.SyncedAt, &cdn.DeviceName,
		); err != nil {
			return nil, err
		}
		names = append(names, cdn)
	}
	return names, nil
}

// LeadRepository handles lead data access
type LeadRepository struct {
	db *pgxpool.Pool
}

func (r *LeadRepository) Create(ctx context.Context, lead *domain.Lead) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO leads (account_id, contact_id, jid, name, last_name, short_name, phone, email, company, age, status, source, notes, pipeline_id, stage_id, tags)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
		ON CONFLICT (account_id, jid) DO UPDATE SET
			name = COALESCE(EXCLUDED.name, leads.name),
			phone = COALESCE(EXCLUDED.phone, leads.phone),
			tags = COALESCE(EXCLUDED.tags, leads.tags),
			updated_at = NOW()
		RETURNING id, created_at, updated_at
	`, lead.AccountID, lead.ContactID, lead.JID, lead.Name, lead.LastName, lead.ShortName, lead.Phone,
		lead.Email, lead.Company, lead.Age, lead.Status, lead.Source, lead.Notes, lead.PipelineID, lead.StageID, lead.Tags,
	).Scan(&lead.ID, &lead.CreatedAt, &lead.UpdatedAt)
}

func (r *LeadRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Lead, error) {
	rows, err := r.db.Query(ctx, `
		SELECT l.id, l.account_id, l.contact_id, l.jid, l.name, l.last_name, l.short_name, l.phone, l.email, l.company, l.age, l.status, l.source, l.notes,
		       l.tags, l.custom_fields, l.assigned_to, l.pipeline_id, l.stage_id, l.created_at, l.updated_at,
		       ps.name, ps.color, ps.position
		FROM leads l
		LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
		WHERE l.account_id = $1 ORDER BY l.created_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var leads []*domain.Lead
	for rows.Next() {
		lead := &domain.Lead{}
		if err := rows.Scan(
			&lead.ID, &lead.AccountID, &lead.ContactID, &lead.JID, &lead.Name, &lead.LastName, &lead.ShortName, &lead.Phone,
			&lead.Email, &lead.Company, &lead.Age, &lead.Status, &lead.Source, &lead.Notes, &lead.Tags,
			&lead.CustomFields, &lead.AssignedTo, &lead.PipelineID, &lead.StageID, &lead.CreatedAt, &lead.UpdatedAt,
			&lead.StageName, &lead.StageColor, &lead.StagePosition,
		); err != nil {
			return nil, err
		}
		leads = append(leads, lead)
	}
	return leads, nil
}

func (r *LeadRepository) GetByJID(ctx context.Context, accountID uuid.UUID, jid string) (*domain.Lead, error) {
	lead := &domain.Lead{}
	err := r.db.QueryRow(ctx, `
		SELECT l.id, l.account_id, l.contact_id, l.jid, l.name, l.last_name, l.short_name, l.phone, l.email, l.company, l.age, l.status, l.source, l.notes,
		       l.tags, l.custom_fields, l.assigned_to, l.pipeline_id, l.stage_id, l.created_at, l.updated_at,
		       ps.name, ps.color, ps.position
		FROM leads l
		LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
		WHERE l.account_id = $1 AND l.jid = $2
	`, accountID, jid).Scan(
		&lead.ID, &lead.AccountID, &lead.ContactID, &lead.JID, &lead.Name, &lead.LastName, &lead.ShortName, &lead.Phone,
		&lead.Email, &lead.Company, &lead.Age, &lead.Status, &lead.Source, &lead.Notes, &lead.Tags,
		&lead.CustomFields, &lead.AssignedTo, &lead.PipelineID, &lead.StageID, &lead.CreatedAt, &lead.UpdatedAt,
		&lead.StageName, &lead.StageColor, &lead.StagePosition,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return lead, err
}

func (r *LeadRepository) UpdateStatus(ctx context.Context, id uuid.UUID, status string) error {
	_, err := r.db.Exec(ctx, `UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2`, status, id)
	return err
}

func (r *LeadRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Lead, error) {
	lead := &domain.Lead{}
	err := r.db.QueryRow(ctx, `
		SELECT l.id, l.account_id, l.contact_id, l.jid, l.name, l.last_name, l.short_name, l.phone, l.email, l.company, l.age, l.status, l.source, l.notes,
		       l.tags, l.custom_fields, l.assigned_to, l.pipeline_id, l.stage_id, l.created_at, l.updated_at,
		       ps.name, ps.color, ps.position
		FROM leads l
		LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
		WHERE l.id = $1
	`, id).Scan(
		&lead.ID, &lead.AccountID, &lead.ContactID, &lead.JID, &lead.Name, &lead.LastName, &lead.ShortName, &lead.Phone,
		&lead.Email, &lead.Company, &lead.Age, &lead.Status, &lead.Source, &lead.Notes, &lead.Tags,
		&lead.CustomFields, &lead.AssignedTo, &lead.PipelineID, &lead.StageID, &lead.CreatedAt, &lead.UpdatedAt,
		&lead.StageName, &lead.StageColor, &lead.StagePosition,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return lead, err
}

func (r *LeadRepository) Update(ctx context.Context, lead *domain.Lead) error {
	_, err := r.db.Exec(ctx, `
		UPDATE leads SET
			name = $1, last_name = $2, short_name = $3, phone = $4, email = $5, company = $6, age = $7,
			status = $8, source = $9, notes = $10, tags = $11, custom_fields = $12, assigned_to = $13,
			pipeline_id = $14, stage_id = $15, updated_at = NOW()
		WHERE id = $16
	`, lead.Name, lead.LastName, lead.ShortName, lead.Phone, lead.Email, lead.Company, lead.Age,
		lead.Status, lead.Source, lead.Notes, lead.Tags, lead.CustomFields, lead.AssignedTo,
		lead.PipelineID, lead.StageID, lead.ID)
	return err
}

// UpdateStage moves a lead to a different pipeline stage
func (r *LeadRepository) UpdateStage(ctx context.Context, id uuid.UUID, stageID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `UPDATE leads SET stage_id = $1, updated_at = NOW() WHERE id = $2`, stageID, id)
	return err
}

// SyncToContact propagates shared lead fields to the linked contact
func (r *LeadRepository) SyncToContact(ctx context.Context, lead *domain.Lead) error {
	if lead.ContactID == nil {
		return nil
	}
	_, err := r.db.Exec(ctx, `
		UPDATE contacts SET
			custom_name = COALESCE($1, custom_name),
			last_name = COALESCE($2, last_name),
			short_name = COALESCE($3, short_name),
			phone = COALESCE($4, phone),
			email = COALESCE($5, email),
			company = COALESCE($6, company),
			age = COALESCE($7, age),
			notes = COALESCE($8, notes),
			updated_at = NOW()
		WHERE id = $9
	`, lead.Name, lead.LastName, lead.ShortName, lead.Phone, lead.Email, lead.Company, lead.Age, lead.Notes, *lead.ContactID)
	return err
}

// GetByContactID finds a lead linked to a specific contact
func (r *LeadRepository) GetByContactID(ctx context.Context, contactID uuid.UUID) (*domain.Lead, error) {
	lead := &domain.Lead{}
	err := r.db.QueryRow(ctx, `
		SELECT l.id, l.account_id, l.contact_id, l.jid, l.name, l.last_name, l.short_name, l.phone, l.email, l.company, l.age, l.status, l.source, l.notes,
		       l.tags, l.custom_fields, l.assigned_to, l.pipeline_id, l.stage_id, l.created_at, l.updated_at,
		       ps.name, ps.color, ps.position
		FROM leads l
		LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
		WHERE l.contact_id = $1
	`, contactID).Scan(
		&lead.ID, &lead.AccountID, &lead.ContactID, &lead.JID, &lead.Name, &lead.LastName, &lead.ShortName, &lead.Phone,
		&lead.Email, &lead.Company, &lead.Age, &lead.Status, &lead.Source, &lead.Notes, &lead.Tags,
		&lead.CustomFields, &lead.AssignedTo, &lead.PipelineID, &lead.StageID, &lead.CreatedAt, &lead.UpdatedAt,
		&lead.StageName, &lead.StageColor, &lead.StagePosition,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return lead, err
}

func (r *LeadRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM leads WHERE id = $1`, id)
	return err
}

func (r *LeadRepository) DeleteBatch(ctx context.Context, ids []uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM leads WHERE id = ANY($1)`, ids)
	return err
}

func (r *LeadRepository) DeleteAll(ctx context.Context, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM leads WHERE account_id = $1`, accountID)
	return err
}

// PipelineRepository handles pipeline data access
type PipelineRepository struct {
	db *pgxpool.Pool
}

func (r *PipelineRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Pipeline, error) {
	rows, err := r.db.Query(ctx, `
		SELECT p.id, p.account_id, p.name, p.description, p.is_default, p.kommo_id, p.created_at, p.updated_at
		FROM pipelines p WHERE p.account_id = $1 ORDER BY p.created_at
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pipelines []*domain.Pipeline
	for rows.Next() {
		pipeline := &domain.Pipeline{}
		if err := rows.Scan(
			&pipeline.ID, &pipeline.AccountID, &pipeline.Name, &pipeline.Description,
			&pipeline.IsDefault, &pipeline.KommoID, &pipeline.CreatedAt, &pipeline.UpdatedAt,
		); err != nil {
			return nil, err
		}

		// Get stages for this pipeline
		stages, err := r.GetStages(ctx, pipeline.ID)
		if err != nil {
			return nil, fmt.Errorf("failed to get stages for pipeline %s: %w", pipeline.ID, err)
		}
		pipeline.Stages = stages

		pipelines = append(pipelines, pipeline)
	}
	return pipelines, nil
}

func (r *PipelineRepository) GetStages(ctx context.Context, pipelineID uuid.UUID) ([]*domain.PipelineStage, error) {
	rows, err := r.db.Query(ctx, `
		SELECT ps.id, ps.pipeline_id, ps.name, ps.color, ps.position, ps.created_at,
		       (SELECT COUNT(*) FROM leads WHERE stage_id = ps.id) as lead_count
		FROM pipeline_stages ps WHERE ps.pipeline_id = $1 ORDER BY ps.position
	`, pipelineID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stages []*domain.PipelineStage
	for rows.Next() {
		stage := &domain.PipelineStage{}
		if err := rows.Scan(
			&stage.ID, &stage.PipelineID, &stage.Name, &stage.Color,
			&stage.Position, &stage.CreatedAt, &stage.LeadCount,
		); err != nil {
			return nil, err
		}
		stages = append(stages, stage)
	}
	return stages, nil
}

func (r *PipelineRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Pipeline, error) {
	pipeline := &domain.Pipeline{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, description, is_default, created_at, updated_at
		FROM pipelines WHERE id = $1
	`, id).Scan(
		&pipeline.ID, &pipeline.AccountID, &pipeline.Name, &pipeline.Description,
		&pipeline.IsDefault, &pipeline.CreatedAt, &pipeline.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	stages, err := r.GetStages(ctx, pipeline.ID)
	if err != nil {
		return nil, err
	}
	pipeline.Stages = stages
	return pipeline, nil
}

func (r *PipelineRepository) Create(ctx context.Context, pipeline *domain.Pipeline) error {
	pipeline.ID = uuid.New()
	now := time.Now()
	pipeline.CreatedAt = now
	pipeline.UpdatedAt = now
	_, err := r.db.Exec(ctx, `
		INSERT INTO pipelines (id, account_id, name, description, is_default, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, pipeline.ID, pipeline.AccountID, pipeline.Name, pipeline.Description, pipeline.IsDefault, pipeline.CreatedAt, pipeline.UpdatedAt)
	return err
}

func (r *PipelineRepository) Update(ctx context.Context, pipeline *domain.Pipeline) error {
	pipeline.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE pipelines SET name = $1, description = $2, updated_at = $3 WHERE id = $4
	`, pipeline.Name, pipeline.Description, pipeline.UpdatedAt, pipeline.ID)
	return err
}

func (r *PipelineRepository) Delete(ctx context.Context, id uuid.UUID) error {
	// Unlink leads from this pipeline's stages first
	_, _ = r.db.Exec(ctx, `UPDATE leads SET pipeline_id = NULL, stage_id = NULL WHERE pipeline_id = $1`, id)
	// Delete stages (FK cascade would also do it)
	_, _ = r.db.Exec(ctx, `DELETE FROM pipeline_stages WHERE pipeline_id = $1`, id)
	_, err := r.db.Exec(ctx, `DELETE FROM pipelines WHERE id = $1`, id)
	return err
}

func (r *PipelineRepository) CreateStage(ctx context.Context, stage *domain.PipelineStage) error {
	stage.ID = uuid.New()
	stage.CreatedAt = time.Now()
	// Auto-set position to the end
	if stage.Position == 0 {
		var maxPos *int
		r.db.QueryRow(ctx, `SELECT MAX(position) FROM pipeline_stages WHERE pipeline_id = $1`, stage.PipelineID).Scan(&maxPos)
		if maxPos != nil {
			stage.Position = *maxPos + 1
		}
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO pipeline_stages (id, pipeline_id, name, color, position, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, stage.ID, stage.PipelineID, stage.Name, stage.Color, stage.Position, stage.CreatedAt)
	return err
}

func (r *PipelineRepository) UpdateStage(ctx context.Context, stage *domain.PipelineStage) error {
	_, err := r.db.Exec(ctx, `
		UPDATE pipeline_stages SET name = $1, color = $2, position = $3 WHERE id = $4
	`, stage.Name, stage.Color, stage.Position, stage.ID)
	return err
}

func (r *PipelineRepository) DeleteStage(ctx context.Context, id uuid.UUID) error {
	// Move leads in this stage to no stage
	_, _ = r.db.Exec(ctx, `UPDATE leads SET stage_id = NULL WHERE stage_id = $1`, id)
	_, err := r.db.Exec(ctx, `DELETE FROM pipeline_stages WHERE id = $1`, id)
	return err
}

func (r *PipelineRepository) ReorderStages(ctx context.Context, pipelineID uuid.UUID, stageIDs []uuid.UUID) error {
	for i, stageID := range stageIDs {
		_, err := r.db.Exec(ctx, `UPDATE pipeline_stages SET position = $1 WHERE id = $2 AND pipeline_id = $3`, i, stageID, pipelineID)
		if err != nil {
			return err
		}
	}
	return nil
}

func (r *PipelineRepository) GetDefaultPipeline(ctx context.Context, accountID uuid.UUID) (*domain.Pipeline, error) {
	pipeline := &domain.Pipeline{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, description, is_default, created_at, updated_at
		FROM pipelines WHERE account_id = $1 AND is_default = TRUE LIMIT 1
	`, accountID).Scan(
		&pipeline.ID, &pipeline.AccountID, &pipeline.Name, &pipeline.Description,
		&pipeline.IsDefault, &pipeline.CreatedAt, &pipeline.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	stages, err := r.GetStages(ctx, pipeline.ID)
	if err != nil {
		return nil, err
	}
	pipeline.Stages = stages
	return pipeline, nil
}

// GetActivePipeline returns the pipeline connected to Kommo (enabled=TRUE), falling back to is_default, then any pipeline.
func (r *PipelineRepository) GetActivePipeline(ctx context.Context, accountID uuid.UUID) (*domain.Pipeline, error) {
	// 1. Try the Kommo-connected pipeline
	var pipelineID uuid.UUID
	err := r.db.QueryRow(ctx, `
		SELECT pipeline_id FROM kommo_connected_pipelines
		WHERE account_id = $1 AND enabled = TRUE AND pipeline_id IS NOT NULL LIMIT 1
	`, accountID).Scan(&pipelineID)
	if err == nil {
		return r.GetByID(ctx, pipelineID)
	}
	// 2. Fallback to default pipeline
	return r.GetDefaultPipeline(ctx, accountID)
}

// TagRepository handles tag data access
type TagRepository struct {
	db *pgxpool.Pool
}

func (r *TagRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Tag, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, name, color, created_at, updated_at
		FROM tags WHERE account_id = $1 ORDER BY name
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tags []*domain.Tag
	for rows.Next() {
		t := &domain.Tag{}
		if err := rows.Scan(&t.ID, &t.AccountID, &t.Name, &t.Color, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, nil
}

func (r *TagRepository) Create(ctx context.Context, tag *domain.Tag) error {
	tag.ID = uuid.New()
	now := time.Now()
	tag.CreatedAt = now
	tag.UpdatedAt = now
	_, err := r.db.Exec(ctx, `
		INSERT INTO tags (id, account_id, name, color, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, tag.ID, tag.AccountID, tag.Name, tag.Color, tag.CreatedAt, tag.UpdatedAt)
	return err
}

func (r *TagRepository) Update(ctx context.Context, tag *domain.Tag) error {
	tag.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE tags SET name = $1, color = $2, updated_at = $3 WHERE id = $4
	`, tag.Name, tag.Color, tag.UpdatedAt, tag.ID)
	return err
}

func (r *TagRepository) Delete(ctx context.Context, id uuid.UUID) error {
	// Delete associations first
	r.db.Exec(ctx, `DELETE FROM contact_tags WHERE tag_id = $1`, id)
	r.db.Exec(ctx, `DELETE FROM lead_tags WHERE tag_id = $1`, id)
	r.db.Exec(ctx, `DELETE FROM chat_tags WHERE tag_id = $1`, id)
	_, err := r.db.Exec(ctx, `DELETE FROM tags WHERE id = $1`, id)
	return err
}

func (r *TagRepository) AssignToContact(ctx context.Context, contactID, tagID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
	`, contactID, tagID)
	return err
}

func (r *TagRepository) RemoveFromContact(ctx context.Context, contactID, tagID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = $2`, contactID, tagID)
	return err
}

func (r *TagRepository) AssignToLead(ctx context.Context, leadID, tagID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
	`, leadID, tagID)
	return err
}

func (r *TagRepository) RemoveFromLead(ctx context.Context, leadID, tagID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM lead_tags WHERE lead_id = $1 AND tag_id = $2`, leadID, tagID)
	return err
}

func (r *TagRepository) AssignToChat(ctx context.Context, chatID, tagID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO chat_tags (chat_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
	`, chatID, tagID)
	return err
}

func (r *TagRepository) RemoveFromChat(ctx context.Context, chatID, tagID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM chat_tags WHERE chat_id = $1 AND tag_id = $2`, chatID, tagID)
	return err
}

func (r *TagRepository) GetByContact(ctx context.Context, contactID uuid.UUID) ([]*domain.Tag, error) {
	rows, err := r.db.Query(ctx, `
		SELECT t.id, t.account_id, t.name, t.color, t.created_at, t.updated_at
		FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id
		WHERE ct.contact_id = $1 ORDER BY t.name
	`, contactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tags []*domain.Tag
	for rows.Next() {
		t := &domain.Tag{}
		if err := rows.Scan(&t.ID, &t.AccountID, &t.Name, &t.Color, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, nil
}

func (r *TagRepository) GetByLead(ctx context.Context, leadID uuid.UUID) ([]*domain.Tag, error) {
	rows, err := r.db.Query(ctx, `
		SELECT t.id, t.account_id, t.name, t.color, t.created_at, t.updated_at
		FROM tags t JOIN lead_tags lt ON lt.tag_id = t.id
		WHERE lt.lead_id = $1 ORDER BY t.name
	`, leadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tags []*domain.Tag
	for rows.Next() {
		t := &domain.Tag{}
		if err := rows.Scan(&t.ID, &t.AccountID, &t.Name, &t.Color, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, nil
}

func (r *TagRepository) GetByChat(ctx context.Context, chatID uuid.UUID) ([]*domain.Tag, error) {
	rows, err := r.db.Query(ctx, `
		SELECT t.id, t.account_id, t.name, t.color, t.created_at, t.updated_at
		FROM tags t JOIN chat_tags cht ON cht.tag_id = t.id
		WHERE cht.chat_id = $1 ORDER BY t.name
	`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tags []*domain.Tag
	for rows.Next() {
		t := &domain.Tag{}
		if err := rows.Scan(&t.ID, &t.AccountID, &t.Name, &t.Color, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, nil
}

func (r *TagRepository) AssignToParticipant(ctx context.Context, participantID, tagID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO participant_tags (participant_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
	`, participantID, tagID)
	return err
}

func (r *TagRepository) RemoveFromParticipant(ctx context.Context, participantID, tagID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM participant_tags WHERE participant_id = $1 AND tag_id = $2`, participantID, tagID)
	return err
}

func (r *TagRepository) GetByParticipant(ctx context.Context, participantID uuid.UUID) ([]*domain.Tag, error) {
	rows, err := r.db.Query(ctx, `
		SELECT t.id, t.account_id, t.name, t.color, t.created_at, t.updated_at
		FROM tags t JOIN participant_tags pt ON pt.tag_id = t.id
		WHERE pt.participant_id = $1 ORDER BY t.name
	`, participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tags []*domain.Tag
	for rows.Next() {
		t := &domain.Tag{}
		if err := rows.Scan(&t.ID, &t.AccountID, &t.Name, &t.Color, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, nil
}

// CampaignRepository handles campaign data access
type CampaignRepository struct {
	db *pgxpool.Pool
}

func (r *CampaignRepository) Create(ctx context.Context, c *domain.Campaign) error {
	c.ID = uuid.New()
	now := time.Now()
	c.CreatedAt = now
	c.UpdatedAt = now
	if c.Status == "" {
		c.Status = domain.CampaignStatusDraft
	}
	if c.Settings == nil {
		c.Settings = domain.DefaultCampaignSettings()
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO campaigns (id, account_id, device_id, name, message_template, media_url, media_type, status, scheduled_at, settings, total_recipients, sent_count, failed_count, event_id, source, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
	`, c.ID, c.AccountID, c.DeviceID, c.Name, c.MessageTemplate, c.MediaURL, c.MediaType,
		c.Status, c.ScheduledAt, c.Settings, c.TotalRecipients, c.SentCount, c.FailedCount, c.EventID, c.Source, c.CreatedAt, c.UpdatedAt)
	return err
}

func (r *CampaignRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Campaign, error) {
	rows, err := r.db.Query(ctx, `
		SELECT c.id, c.account_id, c.device_id, c.name, c.message_template, c.media_url, c.media_type,
			c.status, c.scheduled_at, c.started_at, c.completed_at, c.total_recipients, c.sent_count, c.failed_count,
			c.settings, c.event_id, c.source, c.created_at, c.updated_at, d.name as device_name
		FROM campaigns c
		LEFT JOIN devices d ON d.id = c.device_id
		WHERE c.account_id = $1
		ORDER BY c.created_at DESC
		LIMIT 100
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var campaigns []*domain.Campaign
	for rows.Next() {
		camp := &domain.Campaign{}
		if err := rows.Scan(
			&camp.ID, &camp.AccountID, &camp.DeviceID, &camp.Name, &camp.MessageTemplate,
			&camp.MediaURL, &camp.MediaType, &camp.Status, &camp.ScheduledAt, &camp.StartedAt,
			&camp.CompletedAt, &camp.TotalRecipients, &camp.SentCount, &camp.FailedCount,
			&camp.Settings, &camp.EventID, &camp.Source, &camp.CreatedAt, &camp.UpdatedAt, &camp.DeviceName,
		); err != nil {
			return nil, err
		}
		campaigns = append(campaigns, camp)
	}
	return campaigns, nil
}

func (r *CampaignRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Campaign, error) {
	camp := &domain.Campaign{}
	err := r.db.QueryRow(ctx, `
		SELECT c.id, c.account_id, c.device_id, c.name, c.message_template, c.media_url, c.media_type,
			c.status, c.scheduled_at, c.started_at, c.completed_at, c.total_recipients, c.sent_count, c.failed_count,
			c.settings, c.event_id, c.source, c.created_at, c.updated_at, d.name as device_name
		FROM campaigns c
		LEFT JOIN devices d ON d.id = c.device_id
		WHERE c.id = $1
	`, id).Scan(
		&camp.ID, &camp.AccountID, &camp.DeviceID, &camp.Name, &camp.MessageTemplate,
		&camp.MediaURL, &camp.MediaType, &camp.Status, &camp.ScheduledAt, &camp.StartedAt,
		&camp.CompletedAt, &camp.TotalRecipients, &camp.SentCount, &camp.FailedCount,
		&camp.Settings, &camp.EventID, &camp.Source, &camp.CreatedAt, &camp.UpdatedAt, &camp.DeviceName,
	)
	if err != nil {
		return nil, err
	}
	return camp, nil
}

func (r *CampaignRepository) Update(ctx context.Context, c *domain.Campaign) error {
	c.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE campaigns SET name=$1, message_template=$2, media_url=$3, media_type=$4, status=$5,
			scheduled_at=$6, started_at=$7, completed_at=$8, total_recipients=$9, sent_count=$10,
			failed_count=$11, settings=$12, device_id=$13, updated_at=$14
		WHERE id=$15
	`, c.Name, c.MessageTemplate, c.MediaURL, c.MediaType, c.Status,
		c.ScheduledAt, c.StartedAt, c.CompletedAt, c.TotalRecipients, c.SentCount,
		c.FailedCount, c.Settings, c.DeviceID, c.UpdatedAt, c.ID)
	return err
}

func (r *CampaignRepository) Delete(ctx context.Context, id uuid.UUID) error {
	r.db.Exec(ctx, `DELETE FROM campaign_recipients WHERE campaign_id = $1`, id)
	_, err := r.db.Exec(ctx, `DELETE FROM campaigns WHERE id = $1`, id)
	return err
}

func (r *CampaignRepository) AddRecipients(ctx context.Context, recipients []*domain.CampaignRecipient) error {
	if len(recipients) == 0 {
		return nil
	}
	for _, rec := range recipients {
		rec.ID = uuid.New()
		if rec.Status == "" {
			rec.Status = "pending"
		}
		metaJSON := []byte("{}")
		if rec.Metadata != nil {
			if b, err := json.Marshal(rec.Metadata); err == nil {
				metaJSON = b
			}
		}
		_, err := r.db.Exec(ctx, `
			INSERT INTO campaign_recipients (id, campaign_id, contact_id, jid, name, phone, status, metadata)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT DO NOTHING
		`, rec.ID, rec.CampaignID, rec.ContactID, rec.JID, rec.Name, rec.Phone, rec.Status, metaJSON)
		if err != nil {
			return err
		}
	}
	// Update total count
	_, err := r.db.Exec(ctx, `
		UPDATE campaigns SET total_recipients = (SELECT count(*) FROM campaign_recipients WHERE campaign_id = $1), updated_at = NOW()
		WHERE id = $1
	`, recipients[0].CampaignID)
	return err
}

func (r *CampaignRepository) GetRecipients(ctx context.Context, campaignID uuid.UUID) ([]*domain.CampaignRecipient, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, campaign_id, contact_id, jid, name, phone, status, sent_at, error_message, wait_time_ms, COALESCE(metadata, '{}')
		FROM campaign_recipients WHERE campaign_id = $1 ORDER BY sent_at ASC NULLS LAST, id
	`, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var recipients []*domain.CampaignRecipient
	for rows.Next() {
		rec := &domain.CampaignRecipient{}
		var metaJSON []byte
		if err := rows.Scan(&rec.ID, &rec.CampaignID, &rec.ContactID, &rec.JID, &rec.Name, &rec.Phone, &rec.Status, &rec.SentAt, &rec.ErrorMessage, &rec.WaitTimeMs, &metaJSON); err != nil {
			return nil, err
		}
		if len(metaJSON) > 2 {
			json.Unmarshal(metaJSON, &rec.Metadata)
		}
		recipients = append(recipients, rec)
	}
	return recipients, nil
}

func (r *CampaignRepository) GetNextPendingRecipient(ctx context.Context, campaignID uuid.UUID) (*domain.CampaignRecipient, error) {
	rec := &domain.CampaignRecipient{}
	var metaJSON []byte
	err := r.db.QueryRow(ctx, `
		SELECT id, campaign_id, contact_id, jid, name, phone, status, sent_at, error_message, wait_time_ms, COALESCE(metadata, '{}')
		FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'
		ORDER BY id LIMIT 1
	`, campaignID).Scan(&rec.ID, &rec.CampaignID, &rec.ContactID, &rec.JID, &rec.Name, &rec.Phone, &rec.Status, &rec.SentAt, &rec.ErrorMessage, &rec.WaitTimeMs, &metaJSON)
	if err != nil {
		return nil, err
	}
	if len(metaJSON) > 2 {
		json.Unmarshal(metaJSON, &rec.Metadata)
	}
	return rec, nil
}

func (r *CampaignRepository) UpdateRecipientStatus(ctx context.Context, id uuid.UUID, status string, errMsg *string, waitTimeMs *int) error {
	if status == "sent" {
		now := time.Now()
		_, err := r.db.Exec(ctx, `
			UPDATE campaign_recipients SET status = $1, sent_at = $2, error_message = $3, wait_time_ms = $4 WHERE id = $5
		`, status, now, errMsg, waitTimeMs, id)
		return err
	}
	_, err := r.db.Exec(ctx, `
		UPDATE campaign_recipients SET status = $1, error_message = $2, wait_time_ms = $3 WHERE id = $4
	`, status, errMsg, waitTimeMs, id)
	return err
}

func (r *CampaignRepository) IncrementSentCount(ctx context.Context, campaignID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `UPDATE campaigns SET sent_count = sent_count + 1, updated_at = NOW() WHERE id = $1`, campaignID)
	return err
}

func (r *CampaignRepository) IncrementFailedCount(ctx context.Context, campaignID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `UPDATE campaigns SET failed_count = failed_count + 1, updated_at = NOW() WHERE id = $1`, campaignID)
	return err
}

func (r *CampaignRepository) DeleteRecipient(ctx context.Context, campaignID, recipientID uuid.UUID) error {
	result, err := r.db.Exec(ctx, `
		DELETE FROM campaign_recipients WHERE id = $1 AND campaign_id = $2 AND status = 'pending'
	`, recipientID, campaignID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("recipient not found or already processed")
	}
	_, err = r.db.Exec(ctx, `
		UPDATE campaigns SET total_recipients = (SELECT count(*) FROM campaign_recipients WHERE campaign_id = $1), updated_at = NOW()
		WHERE id = $1
	`, campaignID)
	return err
}

func (r *CampaignRepository) GetRunningCampaigns(ctx context.Context) ([]*domain.Campaign, error) {
	rows, err := r.db.Query(ctx, `
		SELECT c.id, c.account_id, c.device_id, c.name, c.message_template, c.media_url, c.media_type,
			c.status, c.scheduled_at, c.started_at, c.completed_at, c.total_recipients, c.sent_count, c.failed_count,
			c.settings, c.created_at, c.updated_at
		FROM campaigns c
		WHERE c.status IN ('running', 'scheduled')
		ORDER BY c.created_at
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var campaigns []*domain.Campaign
	for rows.Next() {
		camp := &domain.Campaign{}
		var deviceName *string
		if err := rows.Scan(
			&camp.ID, &camp.AccountID, &camp.DeviceID, &camp.Name, &camp.MessageTemplate,
			&camp.MediaURL, &camp.MediaType, &camp.Status, &camp.ScheduledAt, &camp.StartedAt,
			&camp.CompletedAt, &camp.TotalRecipients, &camp.SentCount, &camp.FailedCount,
			&camp.Settings, &camp.CreatedAt, &camp.UpdatedAt,
		); err != nil {
			return nil, err
		}
		camp.DeviceName = deviceName
		campaigns = append(campaigns, camp)
	}
	return campaigns, nil
}

// ============================================================
// EventRepository handles event data access
// ============================================================

type EventRepository struct {
	db *pgxpool.Pool
}

func (r *EventRepository) Create(ctx context.Context, e *domain.Event) error {
	e.ID = uuid.New()
	now := time.Now()
	e.CreatedAt = now
	e.UpdatedAt = now
	if e.Status == "" {
		e.Status = domain.EventStatusActive
	}
	if e.Color == "" {
		e.Color = "#3b82f6"
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO events (id, account_id, name, description, event_date, event_end, location, status, color, created_by, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
	`, e.ID, e.AccountID, e.Name, e.Description, e.EventDate, e.EventEnd, e.Location, e.Status, e.Color, e.CreatedBy, e.CreatedAt, e.UpdatedAt)
	return err
}

func (r *EventRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID, filter domain.EventFilter) ([]*domain.Event, int, error) {
	baseQuery := ` FROM events WHERE account_id = $1`
	args := []interface{}{accountID}
	argNum := 2

	if filter.Status != "" {
		baseQuery += fmt.Sprintf(" AND status = $%d", argNum)
		args = append(args, filter.Status)
		argNum++
	}
	if filter.Search != "" {
		baseQuery += fmt.Sprintf(" AND (name ILIKE $%d OR description ILIKE $%d OR location ILIKE $%d)", argNum, argNum, argNum)
		args = append(args, "%"+filter.Search+"%")
		argNum++
	}
	if filter.DateFrom != nil {
		baseQuery += fmt.Sprintf(" AND event_date >= $%d", argNum)
		args = append(args, *filter.DateFrom)
		argNum++
	}
	if filter.DateTo != nil {
		baseQuery += fmt.Sprintf(" AND event_date <= $%d", argNum)
		args = append(args, *filter.DateTo)
		argNum++
	}

	var total int
	if err := r.db.QueryRow(ctx, "SELECT COUNT(*) "+baseQuery, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	selectQuery := `SELECT id, account_id, name, description, event_date, event_end, location, status, color, created_by, created_at, updated_at` + baseQuery + ` ORDER BY COALESCE(event_date, created_at) DESC`
	if filter.Limit > 0 {
		selectQuery += fmt.Sprintf(" LIMIT %d", filter.Limit)
		if filter.Offset > 0 {
			selectQuery += fmt.Sprintf(" OFFSET %d", filter.Offset)
		}
	}

	rows, err := r.db.Query(ctx, selectQuery, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var events []*domain.Event
	for rows.Next() {
		ev := &domain.Event{}
		if err := rows.Scan(&ev.ID, &ev.AccountID, &ev.Name, &ev.Description, &ev.EventDate, &ev.EventEnd, &ev.Location, &ev.Status, &ev.Color, &ev.CreatedBy, &ev.CreatedAt, &ev.UpdatedAt); err != nil {
			return nil, 0, err
		}
		events = append(events, ev)
	}

	// Load participant counts for each event
	for _, ev := range events {
		counts, total, _ := r.GetParticipantCounts(ctx, ev.ID)
		ev.ParticipantCounts = counts
		ev.TotalParticipants = total
	}

	return events, total, nil
}

func (r *EventRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Event, error) {
	ev := &domain.Event{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, description, event_date, event_end, location, status, color, created_by, created_at, updated_at
		FROM events WHERE id = $1
	`, id).Scan(&ev.ID, &ev.AccountID, &ev.Name, &ev.Description, &ev.EventDate, &ev.EventEnd, &ev.Location, &ev.Status, &ev.Color, &ev.CreatedBy, &ev.CreatedAt, &ev.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	counts, total, _ := r.GetParticipantCounts(ctx, ev.ID)
	ev.ParticipantCounts = counts
	ev.TotalParticipants = total
	return ev, nil
}

func (r *EventRepository) Update(ctx context.Context, e *domain.Event) error {
	e.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE events SET name=$1, description=$2, event_date=$3, event_end=$4, location=$5, status=$6, color=$7, updated_at=$8
		WHERE id=$9
	`, e.Name, e.Description, e.EventDate, e.EventEnd, e.Location, e.Status, e.Color, e.UpdatedAt, e.ID)
	return err
}

func (r *EventRepository) Delete(ctx context.Context, id uuid.UUID) error {
	// Cascade deletes participants and interactions via FK
	_, err := r.db.Exec(ctx, `DELETE FROM interactions WHERE event_id = $1`, id)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `DELETE FROM event_participants WHERE event_id = $1`, id)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `DELETE FROM events WHERE id = $1`, id)
	return err
}

func (r *EventRepository) GetParticipantCounts(ctx context.Context, eventID uuid.UUID) (map[string]int, int, error) {
	rows, err := r.db.Query(ctx, `
		SELECT status, COUNT(*) FROM event_participants WHERE event_id = $1 GROUP BY status
	`, eventID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	counts := make(map[string]int)
	total := 0
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, 0, err
		}
		counts[status] = count
		total += count
	}
	return counts, total, nil
}

func (r *EventRepository) GetByContactID(ctx context.Context, accountID, contactID uuid.UUID) ([]*domain.Event, error) {
	rows, err := r.db.Query(ctx, `
		SELECT DISTINCT e.id, e.account_id, e.name, e.description, e.event_date, e.event_end, e.location, e.status, e.color, e.created_by, e.created_at, e.updated_at
		FROM events e
		JOIN event_participants ep ON ep.event_id = e.id
		WHERE e.account_id = $1 AND ep.contact_id = $2
		ORDER BY COALESCE(e.event_date, e.created_at) DESC
	`, accountID, contactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []*domain.Event
	for rows.Next() {
		ev := &domain.Event{}
		if err := rows.Scan(&ev.ID, &ev.AccountID, &ev.Name, &ev.Description, &ev.EventDate, &ev.EventEnd, &ev.Location, &ev.Status, &ev.Color, &ev.CreatedBy, &ev.CreatedAt, &ev.UpdatedAt); err != nil {
			return nil, err
		}
		events = append(events, ev)
	}
	return events, nil
}

// ============================================================
// ParticipantRepository handles event participant data access
// ============================================================

type ParticipantRepository struct {
	db *pgxpool.Pool
}

func (r *ParticipantRepository) Add(ctx context.Context, p *domain.EventParticipant) error {
	p.ID = uuid.New()
	now := time.Now()
	p.CreatedAt = now
	p.UpdatedAt = now
	if p.Status == "" {
		p.Status = domain.ParticipantStatusInvited
	}
	p.InvitedAt = &now
	return r.db.QueryRow(ctx, `
		INSERT INTO event_participants (id, event_id, contact_id, name, last_name, short_name, phone, email, age, status, notes, next_action, next_action_date, invited_at, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		RETURNING id
	`, p.ID, p.EventID, p.ContactID, p.Name, p.LastName, p.ShortName, p.Phone, p.Email, p.Age, p.Status, p.Notes, p.NextAction, p.NextActionDate, p.InvitedAt, p.CreatedAt, p.UpdatedAt).Scan(&p.ID)
}

func (r *ParticipantRepository) BulkAdd(ctx context.Context, eventID uuid.UUID, participants []*domain.EventParticipant) error {
	for _, p := range participants {
		p.EventID = eventID
		if err := r.Add(ctx, p); err != nil {
			return err
		}
	}
	return nil
}

func (r *ParticipantRepository) GetByEventID(ctx context.Context, eventID uuid.UUID, search, statusFilter string, tagIDs []uuid.UUID, hasPhone *bool) ([]*domain.EventParticipant, error) {
	useDistinct := len(tagIDs) > 0
	selectClause := `SELECT p.id, p.event_id, p.contact_id, p.name, p.last_name, p.short_name, p.phone, p.email, p.age, p.status, p.notes, p.next_action, p.next_action_date, p.invited_at, p.confirmed_at, p.attended_at, p.created_at, p.updated_at`
	if useDistinct {
		selectClause = `SELECT DISTINCT p.id, p.event_id, p.contact_id, p.name, p.last_name, p.short_name, p.phone, p.email, p.age, p.status, p.notes, p.next_action, p.next_action_date, p.invited_at, p.confirmed_at, p.attended_at, p.created_at, p.updated_at`
	}
	query := selectClause + ` FROM event_participants p`
	args := []interface{}{eventID}
	argNum := 2

	if useDistinct {
		query += ` JOIN participant_tags pt ON pt.participant_id = p.id`
	}
	query += ` WHERE p.event_id = $1`

	if statusFilter != "" {
		query += fmt.Sprintf(" AND p.status = $%d", argNum)
		args = append(args, statusFilter)
		argNum++
	}
	if search != "" {
		query += fmt.Sprintf(" AND (p.name ILIKE $%d OR p.last_name ILIKE $%d OR p.phone ILIKE $%d OR p.email ILIKE $%d)", argNum, argNum, argNum, argNum)
		args = append(args, "%"+search+"%")
		argNum++
	}
	if useDistinct {
		placeholders := ""
		for i, tid := range tagIDs {
			if i > 0 {
				placeholders += ","
			}
			placeholders += fmt.Sprintf("$%d", argNum)
			args = append(args, tid)
			argNum++
		}
		query += fmt.Sprintf(" AND pt.tag_id IN (%s)", placeholders)
	}
	if hasPhone != nil && *hasPhone {
		query += " AND p.phone IS NOT NULL AND p.phone != ''"
	}
	query += " ORDER BY p.next_action_date ASC NULLS LAST, p.name ASC"

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var participants []*domain.EventParticipant
	for rows.Next() {
		p := &domain.EventParticipant{}
		if err := rows.Scan(&p.ID, &p.EventID, &p.ContactID, &p.Name, &p.LastName, &p.ShortName, &p.Phone, &p.Email, &p.Age, &p.Status, &p.Notes, &p.NextAction, &p.NextActionDate, &p.InvitedAt, &p.ConfirmedAt, &p.AttendedAt, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		participants = append(participants, p)
	}

	// Load tags for each participant
	for _, p := range participants {
		tags, err := r.db.Query(ctx, `
			SELECT t.id, t.account_id, t.name, t.color, t.created_at
			FROM tags t
			JOIN participant_tags pt ON pt.tag_id = t.id
			WHERE pt.participant_id = $1
		`, p.ID)
		if err == nil {
			defer tags.Close()
			for tags.Next() {
				tag := &domain.Tag{}
				if err := tags.Scan(&tag.ID, &tag.AccountID, &tag.Name, &tag.Color, &tag.CreatedAt); err == nil {
					p.Tags = append(p.Tags, tag)
				}
			}
		}
		if p.Tags == nil {
			p.Tags = make([]*domain.Tag, 0)
		}
	}

	return participants, nil
}

func (r *ParticipantRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.EventParticipant, error) {
	p := &domain.EventParticipant{}
	err := r.db.QueryRow(ctx, `
		SELECT id, event_id, contact_id, name, last_name, short_name, phone, email, age, status, notes, next_action, next_action_date, invited_at, confirmed_at, attended_at, created_at, updated_at
		FROM event_participants WHERE id = $1
	`, id).Scan(&p.ID, &p.EventID, &p.ContactID, &p.Name, &p.LastName, &p.ShortName, &p.Phone, &p.Email, &p.Age, &p.Status, &p.Notes, &p.NextAction, &p.NextActionDate, &p.InvitedAt, &p.ConfirmedAt, &p.AttendedAt, &p.CreatedAt, &p.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return p, err
}

func (r *ParticipantRepository) UpdateStatus(ctx context.Context, id uuid.UUID, status string) error {
	now := time.Now()
	query := `UPDATE event_participants SET status = $1, updated_at = $2`
	args := []interface{}{status, now}
	argNum := 3

	switch status {
	case domain.ParticipantStatusConfirmed:
		query += fmt.Sprintf(", confirmed_at = $%d", argNum)
		args = append(args, now)
		argNum++
	case domain.ParticipantStatusAttended:
		query += fmt.Sprintf(", attended_at = $%d", argNum)
		args = append(args, now)
		argNum++
	}
	query += fmt.Sprintf(" WHERE id = $%d", argNum)
	args = append(args, id)

	_, err := r.db.Exec(ctx, query, args...)
	return err
}

func (r *ParticipantRepository) Update(ctx context.Context, p *domain.EventParticipant) error {
	p.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE event_participants SET name=$1, last_name=$2, short_name=$3, phone=$4, email=$5, age=$6, notes=$7, next_action=$8, next_action_date=$9, updated_at=$10
		WHERE id=$11
	`, p.Name, p.LastName, p.ShortName, p.Phone, p.Email, p.Age, p.Notes, p.NextAction, p.NextActionDate, p.UpdatedAt, p.ID)
	return err
}

// SyncToContact propagates shared participant fields back to the linked contact
func (r *ParticipantRepository) SyncToContact(ctx context.Context, p *domain.EventParticipant) error {
	if p.ContactID == nil {
		return nil
	}
	_, err := r.db.Exec(ctx, `
		UPDATE contacts SET
			name = COALESCE($1, name), last_name = $2, short_name = $3, phone = COALESCE($4, phone), email = $5, age = $6, updated_at = NOW()
		WHERE id = $7
	`, p.Name, p.LastName, p.ShortName, p.Phone, p.Email, p.Age, *p.ContactID)
	return err
}

func (r *ParticipantRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, _ = r.db.Exec(ctx, `DELETE FROM interactions WHERE participant_id = $1`, id)
	_, err := r.db.Exec(ctx, `DELETE FROM event_participants WHERE id = $1`, id)
	return err
}

func (r *ParticipantRepository) GetUpcomingActions(ctx context.Context, accountID uuid.UUID, limit int) ([]*domain.EventParticipant, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := r.db.Query(ctx, `
		SELECT ep.id, ep.event_id, ep.contact_id, ep.name, ep.last_name, ep.short_name, ep.phone, ep.email, ep.age, ep.status, ep.notes, ep.next_action, ep.next_action_date, ep.invited_at, ep.confirmed_at, ep.attended_at, ep.created_at, ep.updated_at
		FROM event_participants ep
		JOIN events e ON e.id = ep.event_id
		WHERE e.account_id = $1 AND ep.next_action_date IS NOT NULL AND ep.status NOT IN ('attended','no_show','declined')
		ORDER BY ep.next_action_date ASC
		LIMIT $2
	`, accountID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var participants []*domain.EventParticipant
	for rows.Next() {
		p := &domain.EventParticipant{}
		if err := rows.Scan(&p.ID, &p.EventID, &p.ContactID, &p.Name, &p.LastName, &p.ShortName, &p.Phone, &p.Email, &p.Age, &p.Status, &p.Notes, &p.NextAction, &p.NextActionDate, &p.InvitedAt, &p.ConfirmedAt, &p.AttendedAt, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		participants = append(participants, p)
	}
	return participants, nil
}

// ============================================================
// InteractionRepository handles interaction data access
// ============================================================

type InteractionRepository struct {
	db *pgxpool.Pool
}

func (r *InteractionRepository) Create(ctx context.Context, i *domain.Interaction) error {
	i.ID = uuid.New()
	i.CreatedAt = time.Now()
	return r.db.QueryRow(ctx, `
		INSERT INTO interactions (id, account_id, contact_id, lead_id, event_id, participant_id, type, direction, outcome, notes, next_action, next_action_date, created_by, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		RETURNING id
	`, i.ID, i.AccountID, i.ContactID, i.LeadID, i.EventID, i.ParticipantID, i.Type, i.Direction, i.Outcome, i.Notes, i.NextAction, i.NextActionDate, i.CreatedBy, i.CreatedAt).Scan(&i.ID)
}

func (r *InteractionRepository) GetByParticipantID(ctx context.Context, participantID uuid.UUID) ([]*domain.Interaction, error) {
	rows, err := r.db.Query(ctx, `
		SELECT i.id, i.account_id, i.contact_id, i.lead_id, i.event_id, i.participant_id, i.type, i.direction, i.outcome, i.notes, i.next_action, i.next_action_date, i.created_by, i.created_at,
		       u.display_name as created_by_name
		FROM interactions i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.participant_id = $1
		ORDER BY i.created_at DESC
	`, participantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var interactions []*domain.Interaction
	for rows.Next() {
		it := &domain.Interaction{}
		if err := rows.Scan(&it.ID, &it.AccountID, &it.ContactID, &it.LeadID, &it.EventID, &it.ParticipantID, &it.Type, &it.Direction, &it.Outcome, &it.Notes, &it.NextAction, &it.NextActionDate, &it.CreatedBy, &it.CreatedAt, &it.CreatedByName); err != nil {
			return nil, err
		}
		interactions = append(interactions, it)
	}
	return interactions, nil
}

func (r *InteractionRepository) GetByContactID(ctx context.Context, contactID uuid.UUID, limit, offset int) ([]*domain.Interaction, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := r.db.Query(ctx, `
		SELECT i.id, i.account_id, i.contact_id, i.lead_id, i.event_id, i.participant_id, i.type, i.direction, i.outcome, i.notes, i.next_action, i.next_action_date, i.created_by, i.created_at,
		       u.display_name as created_by_name, e.name as event_name
		FROM interactions i
		LEFT JOIN users u ON u.id = i.created_by
		LEFT JOIN events e ON e.id = i.event_id
		WHERE i.contact_id = $1
		ORDER BY i.created_at DESC
		LIMIT $2 OFFSET $3
	`, contactID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var interactions []*domain.Interaction
	for rows.Next() {
		it := &domain.Interaction{}
		if err := rows.Scan(&it.ID, &it.AccountID, &it.ContactID, &it.LeadID, &it.EventID, &it.ParticipantID, &it.Type, &it.Direction, &it.Outcome, &it.Notes, &it.NextAction, &it.NextActionDate, &it.CreatedBy, &it.CreatedAt, &it.CreatedByName, &it.EventName); err != nil {
			return nil, err
		}
		interactions = append(interactions, it)
	}
	return interactions, nil
}

func (r *InteractionRepository) GetByEventID(ctx context.Context, eventID uuid.UUID, limit, offset int) ([]*domain.Interaction, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := r.db.Query(ctx, `
		SELECT i.id, i.account_id, i.contact_id, i.lead_id, i.event_id, i.participant_id, i.type, i.direction, i.outcome, i.notes, i.next_action, i.next_action_date, i.created_by, i.created_at,
		       u.display_name as created_by_name
		FROM interactions i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.event_id = $1
		ORDER BY i.created_at DESC
		LIMIT $2 OFFSET $3
	`, eventID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var interactions []*domain.Interaction
	for rows.Next() {
		it := &domain.Interaction{}
		if err := rows.Scan(&it.ID, &it.AccountID, &it.ContactID, &it.LeadID, &it.EventID, &it.ParticipantID, &it.Type, &it.Direction, &it.Outcome, &it.Notes, &it.NextAction, &it.NextActionDate, &it.CreatedBy, &it.CreatedAt, &it.CreatedByName); err != nil {
			return nil, err
		}
		interactions = append(interactions, it)
	}
	return interactions, nil
}

func (r *InteractionRepository) GetLastByParticipantID(ctx context.Context, participantID uuid.UUID) (*domain.Interaction, error) {
	it := &domain.Interaction{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, contact_id, lead_id, event_id, participant_id, type, direction, outcome, notes, next_action, next_action_date, created_by, created_at
		FROM interactions WHERE participant_id = $1
		ORDER BY created_at DESC LIMIT 1
	`, participantID).Scan(&it.ID, &it.AccountID, &it.ContactID, &it.LeadID, &it.EventID, &it.ParticipantID, &it.Type, &it.Direction, &it.Outcome, &it.Notes, &it.NextAction, &it.NextActionDate, &it.CreatedBy, &it.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return it, err
}

func (r *InteractionRepository) GetByLeadID(ctx context.Context, leadID uuid.UUID, limit, offset int) ([]*domain.Interaction, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := r.db.Query(ctx, `
		SELECT i.id, i.account_id, i.contact_id, i.lead_id, i.event_id, i.participant_id, i.type, i.direction, i.outcome, i.notes, i.next_action, i.next_action_date, i.created_by, i.created_at,
		       u.display_name as created_by_name
		FROM interactions i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.lead_id = $1
		ORDER BY i.created_at DESC
		LIMIT $2 OFFSET $3
	`, leadID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var interactions []*domain.Interaction
	for rows.Next() {
		it := &domain.Interaction{}
		if err := rows.Scan(&it.ID, &it.AccountID, &it.ContactID, &it.LeadID, &it.EventID, &it.ParticipantID, &it.Type, &it.Direction, &it.Outcome, &it.Notes, &it.NextAction, &it.NextActionDate, &it.CreatedBy, &it.CreatedAt, &it.CreatedByName); err != nil {
			return nil, err
		}
		interactions = append(interactions, it)
	}
	return interactions, nil
}

func (r *InteractionRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM interactions WHERE id = $1`, id)
	return err
}

// GetCallsByLeadID returns all call-type interactions for a lead, ordered by created_at ASC.
func (r *InteractionRepository) GetCallsByLeadID(ctx context.Context, leadID uuid.UUID) ([]*domain.Interaction, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, contact_id, lead_id, event_id, participant_id, type, direction, outcome, notes,
		       next_action, next_action_date, created_by, created_at, kommo_call_slot
		FROM interactions
		WHERE lead_id = $1 AND type = 'call'
		ORDER BY created_at ASC
	`, leadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var interactions []*domain.Interaction
	for rows.Next() {
		it := &domain.Interaction{}
		if err := rows.Scan(&it.ID, &it.AccountID, &it.ContactID, &it.LeadID, &it.EventID, &it.ParticipantID,
			&it.Type, &it.Direction, &it.Outcome, &it.Notes, &it.NextAction, &it.NextActionDate,
			&it.CreatedBy, &it.CreatedAt, &it.KommoCallSlot); err != nil {
			return nil, err
		}
		interactions = append(interactions, it)
	}
	return interactions, nil
}

// SavedStickerRepository handles saved sticker data access
type SavedStickerRepository struct {
	db *pgxpool.Pool
}

func (r *SavedStickerRepository) GetAll(ctx context.Context, accountID uuid.UUID) ([]string, error) {
	rows, err := r.db.Query(ctx, `
		SELECT media_url FROM saved_stickers
		WHERE account_id = $1
		ORDER BY created_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var urls []string
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			return nil, err
		}
		urls = append(urls, url)
	}
	return urls, nil
}

func (r *SavedStickerRepository) Save(ctx context.Context, accountID uuid.UUID, mediaURL string) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO saved_stickers (account_id, media_url)
		VALUES ($1, $2)
		ON CONFLICT (account_id, media_url) DO NOTHING
	`, accountID, mediaURL)
	return err
}

func (r *SavedStickerRepository) Delete(ctx context.Context, accountID uuid.UUID, mediaURL string) error {
	_, err := r.db.Exec(ctx, `
		DELETE FROM saved_stickers
		WHERE account_id = $1 AND media_url = $2
	`, accountID, mediaURL)
	return err
}

// ReactionRepository handles message reaction data access
type ReactionRepository struct {
	db *pgxpool.Pool
}

func (r *ReactionRepository) Upsert(ctx context.Context, reaction *domain.MessageReaction) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO message_reactions (account_id, chat_id, target_message_id, sender_jid, sender_name, emoji, is_from_me, timestamp)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (chat_id, target_message_id, sender_jid) DO UPDATE SET
			emoji = EXCLUDED.emoji, sender_name = EXCLUDED.sender_name, timestamp = EXCLUDED.timestamp
		RETURNING id, created_at
	`, reaction.AccountID, reaction.ChatID, reaction.TargetMessageID, reaction.SenderJID, reaction.SenderName, reaction.Emoji, reaction.IsFromMe, reaction.Timestamp,
	).Scan(&reaction.ID, &reaction.CreatedAt)
}

func (r *ReactionRepository) Delete(ctx context.Context, chatID uuid.UUID, targetMessageID, senderJID string) error {
	_, err := r.db.Exec(ctx, `
		DELETE FROM message_reactions WHERE chat_id = $1 AND target_message_id = $2 AND sender_jid = $3
	`, chatID, targetMessageID, senderJID)
	return err
}

func (r *ReactionRepository) GetByChatID(ctx context.Context, chatID uuid.UUID) ([]*domain.MessageReaction, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, chat_id, target_message_id, sender_jid, sender_name, emoji, is_from_me, timestamp, created_at
		FROM message_reactions WHERE chat_id = $1
		ORDER BY timestamp ASC
	`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reactions []*domain.MessageReaction
	for rows.Next() {
		r := &domain.MessageReaction{}
		if err := rows.Scan(&r.ID, &r.AccountID, &r.ChatID, &r.TargetMessageID, &r.SenderJID, &r.SenderName, &r.Emoji, &r.IsFromMe, &r.Timestamp, &r.CreatedAt); err != nil {
			return nil, err
		}
		reactions = append(reactions, r)
	}
	return reactions, nil
}

// PollRepository handles poll data access
type PollRepository struct {
	db *pgxpool.Pool
}

func (r *PollRepository) CreateOptions(ctx context.Context, messageID uuid.UUID, options []string) error {
	for _, opt := range options {
		_, err := r.db.Exec(ctx, `
			INSERT INTO poll_options (message_id, name) VALUES ($1, $2)
		`, messageID, opt)
		if err != nil {
			return err
		}
	}
	return nil
}

func (r *PollRepository) GetOptions(ctx context.Context, messageID uuid.UUID) ([]*domain.PollOption, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, message_id, name, vote_count FROM poll_options WHERE message_id = $1 ORDER BY id
	`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var options []*domain.PollOption
	for rows.Next() {
		o := &domain.PollOption{}
		if err := rows.Scan(&o.ID, &o.MessageID, &o.Name, &o.VoteCount); err != nil {
			return nil, err
		}
		options = append(options, o)
	}
	return options, nil
}

func (r *PollRepository) UpsertVote(ctx context.Context, vote *domain.PollVote) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO poll_votes (message_id, voter_jid, selected_names, timestamp)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (message_id, voter_jid) DO UPDATE SET
			selected_names = EXCLUDED.selected_names, timestamp = EXCLUDED.timestamp
		RETURNING id
	`, vote.MessageID, vote.VoterJID, vote.SelectedNames, vote.Timestamp).Scan(&vote.ID)
}

func (r *PollRepository) RecalculateVoteCounts(ctx context.Context, messageID uuid.UUID) error {
	// Reset all counts to 0, then recalculate from votes
	_, err := r.db.Exec(ctx, `UPDATE poll_options SET vote_count = 0 WHERE message_id = $1`, messageID)
	if err != nil {
		return err
	}

	// For each vote, increment the count of selected options
	rows, err := r.db.Query(ctx, `SELECT selected_names FROM poll_votes WHERE message_id = $1`, messageID)
	if err != nil {
		return err
	}
	defer rows.Close()

	countMap := make(map[string]int)
	for rows.Next() {
		var names []string
		if err := rows.Scan(&names); err != nil {
			return err
		}
		for _, n := range names {
			countMap[n]++
		}
	}
	for name, count := range countMap {
		_, _ = r.db.Exec(ctx, `UPDATE poll_options SET vote_count = $1 WHERE message_id = $2 AND name = $3`, count, messageID, name)
	}
	return nil
}

func (r *PollRepository) GetVotes(ctx context.Context, messageID uuid.UUID) ([]*domain.PollVote, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, message_id, voter_jid, selected_names, timestamp FROM poll_votes WHERE message_id = $1 ORDER BY timestamp
	`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var votes []*domain.PollVote
	for rows.Next() {
		v := &domain.PollVote{}
		if err := rows.Scan(&v.ID, &v.MessageID, &v.VoterJID, &v.SelectedNames, &v.Timestamp); err != nil {
			return nil, err
		}
		votes = append(votes, v)
	}
	return votes, nil
}

// CampaignAttachmentRepository handles campaign attachment operations
type CampaignAttachmentRepository struct {
	db *pgxpool.Pool
}

func (r *CampaignAttachmentRepository) CreateBatch(ctx context.Context, campaignID uuid.UUID, attachments []*domain.CampaignAttachment) error {
	if len(attachments) == 0 {
		return nil
	}
	for i, a := range attachments {
		a.ID = uuid.New()
		a.CampaignID = campaignID
		if a.Position == 0 {
			a.Position = i
		}
		a.CreatedAt = time.Now()
		_, err := r.db.Exec(ctx, `
			INSERT INTO campaign_attachments (id, campaign_id, media_url, media_type, caption, file_name, file_size, position, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		`, a.ID, a.CampaignID, a.MediaURL, a.MediaType, a.Caption, a.FileName, a.FileSize, a.Position, a.CreatedAt)
		if err != nil {
			return err
		}
	}
	return nil
}

func (r *CampaignAttachmentRepository) GetByCampaignID(ctx context.Context, campaignID uuid.UUID) ([]*domain.CampaignAttachment, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, campaign_id, media_url, media_type, caption, file_name, file_size, position, created_at
		FROM campaign_attachments WHERE campaign_id = $1 ORDER BY position
	`, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var attachments []*domain.CampaignAttachment
	for rows.Next() {
		a := &domain.CampaignAttachment{}
		if err := rows.Scan(&a.ID, &a.CampaignID, &a.MediaURL, &a.MediaType, &a.Caption, &a.FileName, &a.FileSize, &a.Position, &a.CreatedAt); err != nil {
			return nil, err
		}
		attachments = append(attachments, a)
	}
	return attachments, nil
}

func (r *CampaignAttachmentRepository) DeleteByCampaignID(ctx context.Context, campaignID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM campaign_attachments WHERE campaign_id = $1`, campaignID)
	return err
}

// ============================================================
// QuickReplyRepository handles quick reply (canned response) data access
// ============================================================

type QuickReplyRepository struct {
	db *pgxpool.Pool
}

func (r *QuickReplyRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.QuickReply, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, shortcut, title, body, created_at, updated_at
		FROM quick_replies WHERE account_id = $1 ORDER BY shortcut
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var replies []*domain.QuickReply
	for rows.Next() {
		qr := &domain.QuickReply{}
		if err := rows.Scan(&qr.ID, &qr.AccountID, &qr.Shortcut, &qr.Title, &qr.Body, &qr.CreatedAt, &qr.UpdatedAt); err != nil {
			return nil, err
		}
		replies = append(replies, qr)
	}
	return replies, nil
}

func (r *QuickReplyRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.QuickReply, error) {
	qr := &domain.QuickReply{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, shortcut, title, body, created_at, updated_at
		FROM quick_replies WHERE id = $1
	`, id).Scan(&qr.ID, &qr.AccountID, &qr.Shortcut, &qr.Title, &qr.Body, &qr.CreatedAt, &qr.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return qr, err
}

func (r *QuickReplyRepository) Create(ctx context.Context, qr *domain.QuickReply) error {
	qr.ID = uuid.New()
	now := time.Now()
	qr.CreatedAt = now
	qr.UpdatedAt = now
	_, err := r.db.Exec(ctx, `
		INSERT INTO quick_replies (id, account_id, shortcut, title, body, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, qr.ID, qr.AccountID, qr.Shortcut, qr.Title, qr.Body, qr.CreatedAt, qr.UpdatedAt)
	return err
}

func (r *QuickReplyRepository) Update(ctx context.Context, qr *domain.QuickReply) error {
	qr.UpdatedAt = time.Now()
	_, err := r.db.Exec(ctx, `
		UPDATE quick_replies SET shortcut = $1, title = $2, body = $3, updated_at = $4
		WHERE id = $5
	`, qr.Shortcut, qr.Title, qr.Body, qr.UpdatedAt, qr.ID)
	return err
}

func (r *QuickReplyRepository) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM quick_replies WHERE id = $1`, id)
	return err
}
