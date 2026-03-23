package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Account represents a tenant in the multi-tenant system
type Account struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	Slug       string     `json:"slug"`
	Plan       string     `json:"plan"`
	MaxDevices int        `json:"max_devices"`
	IsActive   bool       `json:"is_active"`
	MCPEnabled bool       `json:"mcp_enabled"`
	DefaultIncomingStageID *uuid.UUID `json:"default_incoming_stage_id,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`

	// Populated on demand
	UserCount   int `json:"user_count,omitempty"`
	DeviceCount int `json:"device_count,omitempty"`
	ChatCount   int `json:"chat_count,omitempty"`
}

// User represents a user in the system
type User struct {
	ID           uuid.UUID `json:"id"`
	AccountID    uuid.UUID `json:"account_id"`
	Username     string    `json:"username"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	DisplayName  string    `json:"display_name"`
	Role         string    `json:"role"` // super_admin, admin, agent
	IsAdmin      bool      `json:"is_admin"`
	IsSuperAdmin bool      `json:"is_super_admin"`
	IsActive     bool      `json:"is_active"`
	GroqAPIKey   string    `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`

	// Populated on demand
	AccountName string `json:"account_name,omitempty"`
}

// User role constants
const (
	RoleSuperAdmin = "super_admin"
	RoleAdmin      = "admin"
	RoleAgent      = "agent"
)

// Permission module constants
const (
	PermChats      = "chats"
	PermContacts   = "contacts"
	PermPrograms   = "programs"
	PermDevices    = "devices"
	PermLeads      = "leads"
	PermEvents     = "events"
	PermBroadcasts = "broadcasts"
	PermTags       = "tags"
	PermSettings     = "settings"
	PermIntegrations = "integrations"
	PermSurveys      = "surveys"
	PermDynamics     = "dynamics"
	PermAll          = "*"
)

// AllPermissions contains all available permission modules in display order
var AllPermissions = []string{
	PermChats, PermContacts, PermLeads, PermPrograms,
	PermDevices, PermEvents, PermBroadcasts, PermTags, PermSettings, PermIntegrations, PermSurveys, PermDynamics,
}

// Role represents a named set of module permissions
type Role struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	IsSystem    bool      `json:"is_system"`
	Permissions []string  `json:"permissions"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// UserAccount represents a user's assignment to an account (many-to-many)
type UserAccount struct {
	ID        uuid.UUID  `json:"id"`
	UserID    uuid.UUID  `json:"user_id"`
	AccountID uuid.UUID  `json:"account_id"`
	Role      string     `json:"role"`
	RoleID    *uuid.UUID `json:"role_id,omitempty"`
	IsDefault bool       `json:"is_default"`
	CreatedAt time.Time  `json:"created_at"`

	// Populated on demand
	AccountName       string   `json:"account_name,omitempty"`
	AccountSlug       string   `json:"account_slug,omitempty"`
	AccountMCPEnabled bool     `json:"account_mcp_enabled,omitempty"`
	RoleName          string   `json:"role_name,omitempty"`
	Permissions       []string `json:"permissions,omitempty"`
}

// Device represents a WhatsApp connection
type Device struct {
	ID              uuid.UUID  `json:"id"`
	AccountID       uuid.UUID  `json:"account_id"`
	Name            *string    `json:"name,omitempty"`
	Phone           *string    `json:"phone,omitempty"`
	JID             *string    `json:"jid,omitempty"`
	Status          *string    `json:"status,omitempty"` // disconnected, connecting, connected, logged_out
	QRCode          *string    `json:"qr_code,omitempty"`
	ReceiveMessages bool       `json:"receive_messages"`
	LastSeenAt      *time.Time `json:"last_seen_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

// DeviceStatus constants
const (
	DeviceStatusDisconnected = "disconnected"
	DeviceStatusConnecting   = "connecting"
	DeviceStatusConnected    = "connected"
	DeviceStatusLoggedOut    = "logged_out"
)

// Contact represents a WhatsApp contact
type Contact struct {
	ID         uuid.UUID  `json:"id"`
	AccountID  uuid.UUID  `json:"account_id"`
	DeviceID   *uuid.UUID `json:"device_id,omitempty"`
	JID        string     `json:"jid"`
	Phone      *string    `json:"phone,omitempty"`
	Name       *string    `json:"name,omitempty"`
	LastName   *string    `json:"last_name,omitempty"`
	ShortName  *string    `json:"short_name,omitempty"`
	CustomName *string    `json:"custom_name,omitempty"`
	PushName   *string    `json:"push_name,omitempty"`
	AvatarURL  *string    `json:"avatar_url,omitempty"`
	Email      *string    `json:"email,omitempty"`
	Company    *string    `json:"company,omitempty"`
	Age        *int       `json:"age,omitempty"`
	DNI        *string    `json:"dni,omitempty"`
	BirthDate  *time.Time `json:"birth_date,omitempty"`
	Tags       []string   `json:"tags,omitempty"`
	Notes      *string    `json:"notes,omitempty"`
	Source     *string    `json:"source,omitempty"`
	IsGroup    bool       `json:"is_group"`
	KommoID      *int64     `json:"kommo_id,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	LastActivity *time.Time `json:"last_activity,omitempty"`

	// Relations (populated on demand)
	DeviceNames    []ContactDeviceName `json:"device_names,omitempty"`
	StructuredTags []*Tag              `json:"structured_tags,omitempty"`
}

// DisplayName returns the best available name for the contact
func (c *Contact) DisplayName() string {
	if c.CustomName != nil && *c.CustomName != "" {
		return *c.CustomName
	}
	if c.Name != nil && *c.Name != "" {
		return *c.Name
	}
	if c.PushName != nil && *c.PushName != "" {
		return *c.PushName
	}
	if c.Phone != nil && *c.Phone != "" {
		return *c.Phone
	}
	return c.JID
}

// ContactDeviceName stores the name a device has for a contact
type ContactDeviceName struct {
	ID           uuid.UUID `json:"id"`
	ContactID    uuid.UUID `json:"contact_id"`
	DeviceID     uuid.UUID `json:"device_id"`
	Name         *string   `json:"name,omitempty"`
	PushName     *string   `json:"push_name,omitempty"`
	BusinessName *string   `json:"business_name,omitempty"`
	SyncedAt     time.Time `json:"synced_at"`

	// Populated on demand
	DeviceName *string `json:"device_name,omitempty"`
}

// ContactFilter defines filter options for listing contacts
type ContactFilter struct {
	Search   string
	DeviceID *uuid.UUID
	HasPhone bool
	IsGroup  bool
	Tags     []string
	TagIDs   []uuid.UUID
	Limit    int
	Offset   int
}

// Chat represents a conversation
type Chat struct {
	ID            uuid.UUID  `json:"id"`
	AccountID     uuid.UUID  `json:"account_id"`
	DeviceID      *uuid.UUID `json:"device_id,omitempty"`
	ContactID     *uuid.UUID `json:"contact_id,omitempty"`
	JID           string     `json:"jid"`
	Name          *string    `json:"name,omitempty"`
	LastMessage   *string    `json:"last_message,omitempty"`
	LastMessageAt *time.Time `json:"last_message_at,omitempty"`
	UnreadCount   int        `json:"unread_count"`
	IsArchived    bool       `json:"is_archived"`
	IsPinned      bool       `json:"is_pinned"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`

	// Device info (populated on demand)
	DeviceName   *string `json:"device_name,omitempty"`
	DevicePhone  *string `json:"device_phone,omitempty"`
	DeviceStatus *string `json:"device_status,omitempty"`

	// Contact info (populated via JOIN)
	ContactPhone      *string `json:"contact_phone,omitempty"`
	ContactAvatarURL  *string `json:"contact_avatar_url,omitempty"`
	ContactCustomName *string `json:"contact_custom_name,omitempty"`
	ContactName       *string `json:"contact_name,omitempty"`

	// Lead blocked status (populated via JOIN on JID)
	LeadIsBlocked bool `json:"lead_is_blocked"`

	// Relations (populated on demand)
	Contact  *Contact   `json:"contact,omitempty"`
	Messages []*Message `json:"messages,omitempty"`
}

// ChatFilter defines filter options for listing chats
type ChatFilter struct {
	DeviceIDs  []uuid.UUID
	TagIDs     []uuid.UUID
	UnreadOnly bool
	Archived   bool
	Search     string
	Limit      int
	Offset     int
}

// ChatDetails contains full chat information with related data
type ChatDetails struct {
	Chat    *Chat    `json:"chat"`
	Contact *Contact `json:"contact,omitempty"`
	Lead    *Lead    `json:"lead,omitempty"`
}

// Message represents a WhatsApp message
type Message struct {
	ID            uuid.UUID  `json:"id"`
	AccountID     uuid.UUID  `json:"account_id"`
	DeviceID      *uuid.UUID `json:"device_id,omitempty"`
	ChatID        uuid.UUID  `json:"chat_id"`
	MessageID     string     `json:"message_id"`
	FromJID       *string    `json:"from_jid,omitempty"`
	FromName      *string    `json:"from_name,omitempty"`
	Body          *string    `json:"body,omitempty"`
	MessageType   *string    `json:"message_type,omitempty"` // text, image, video, audio, document, sticker, location, contact
	MediaURL      *string    `json:"media_url,omitempty"`
	MediaMimetype *string    `json:"media_mimetype,omitempty"`
	MediaFilename *string    `json:"media_filename,omitempty"`
	MediaSize     *int64     `json:"media_size,omitempty"`
	IsFromMe      bool       `json:"is_from_me"`
	IsRead        bool       `json:"is_read"`
	IsRevoked     bool       `json:"is_revoked"`
	IsEdited      bool       `json:"is_edited"`
	IsViewOnce    bool       `json:"is_view_once"`
	Status        *string    `json:"status,omitempty"` // sent, delivered, read, failed
	Timestamp     time.Time  `json:"timestamp"`
	CreatedAt     time.Time  `json:"created_at"`

	// Quoted/reply fields
	QuotedMessageID *string `json:"quoted_message_id,omitempty"`
	QuotedBody      *string `json:"quoted_body,omitempty"`
	QuotedSender    *string `json:"quoted_sender,omitempty"`

	// Location data (when message_type = location)
	Latitude  *float64 `json:"latitude,omitempty"`
	Longitude *float64 `json:"longitude,omitempty"`

	// Contact card data (when message_type = contact)
	ContactName  *string `json:"contact_name,omitempty"`
	ContactPhone *string `json:"contact_phone,omitempty"`
	ContactVCard *string `json:"contact_vcard,omitempty"`

	// Reactions (populated on demand)
	Reactions []*MessageReaction `json:"reactions,omitempty"`

	// Poll data (populated when message_type = poll)
	PollQuestion     *string       `json:"poll_question,omitempty"`
	PollOptions      []*PollOption  `json:"poll_options,omitempty"`
	PollVotes        []*PollVote    `json:"poll_votes,omitempty"`
	PollMaxSelections int           `json:"poll_max_selections,omitempty"`
}

// MessageType constants
const (
	MessageTypeText     = "text"
	MessageTypeImage    = "image"
	MessageTypeVideo    = "video"
	MessageTypeAudio    = "audio"
	MessageTypeDocument = "document"
	MessageTypeSticker  = "sticker"
	MessageTypeLocation = "location"
	MessageTypeContact  = "contact"
	MessageTypePoll     = "poll"
	MessageTypeReaction = "reaction"
)

// MessageReaction represents an emoji reaction on a message
type MessageReaction struct {
	ID              uuid.UUID `json:"id"`
	AccountID       uuid.UUID `json:"account_id"`
	ChatID          uuid.UUID `json:"chat_id"`
	TargetMessageID string    `json:"target_message_id"` // WhatsApp stanza ID of the reacted message
	SenderJID       string    `json:"sender_jid"`
	SenderName      *string   `json:"sender_name,omitempty"`
	Emoji           string    `json:"emoji"`
	IsFromMe        bool      `json:"is_from_me"`
	Timestamp       time.Time `json:"timestamp"`
	CreatedAt       time.Time `json:"created_at"`
}

// PollOption represents one option in a poll message
type PollOption struct {
	ID        uuid.UUID `json:"id"`
	MessageID uuid.UUID `json:"message_id"` // DB ID of the poll message
	Name      string    `json:"name"`
	VoteCount int       `json:"vote_count"`
}

// PollVote represents a user's vote on a poll
type PollVote struct {
	ID            uuid.UUID `json:"id"`
	MessageID     uuid.UUID `json:"message_id"` // DB ID of the poll message
	VoterJID      string    `json:"voter_jid"`
	SelectedNames []string  `json:"selected_names"` // Option names selected
	Timestamp     time.Time `json:"timestamp"`
}

// Lead represents a potential customer
type Lead struct {
	ID           uuid.UUID              `json:"id"`
	AccountID    uuid.UUID              `json:"account_id"`
	ContactID    *uuid.UUID             `json:"contact_id,omitempty"`
	JID          string                 `json:"jid"`
	Name         *string                `json:"name,omitempty"`
	LastName     *string                `json:"last_name,omitempty"`
	ShortName    *string                `json:"short_name,omitempty"`
	Phone        *string                `json:"phone,omitempty"`
	Email        *string                `json:"email,omitempty"`
	Company      *string                `json:"company,omitempty"`
	Age          *int                   `json:"age,omitempty"`
	DNI          *string                `json:"dni,omitempty"`
	BirthDate    *time.Time             `json:"birth_date,omitempty"`
	Status       *string                `json:"status,omitempty"` // legacy, kept for backward compat
	PipelineID   *uuid.UUID             `json:"pipeline_id,omitempty"`
	StageID      *uuid.UUID             `json:"stage_id,omitempty"`
	Source       *string                `json:"source,omitempty"`
	Notes        *string                `json:"notes,omitempty"`
	Tags         []string               `json:"tags,omitempty"`
	CustomFields map[string]interface{} `json:"custom_fields,omitempty"`
	AssignedTo   *uuid.UUID             `json:"assigned_to,omitempty"`
	KommoID      *int64                 `json:"kommo_id,omitempty"`
	IsArchived   bool                   `json:"is_archived"`
	ArchivedAt   *time.Time             `json:"archived_at,omitempty"`
	IsBlocked    bool                   `json:"is_blocked"`
	BlockedAt    *time.Time             `json:"blocked_at,omitempty"`
	BlockReason  string                 `json:"block_reason,omitempty"`
	CreatedAt    time.Time              `json:"created_at"`
	UpdatedAt    time.Time              `json:"updated_at"`

	// Relations (populated on demand)
	Contact        *Contact `json:"contact,omitempty"`
	StructuredTags []*Tag   `json:"structured_tags,omitempty"`
	StageName      *string  `json:"stage_name,omitempty"`
	StageColor     *string  `json:"stage_color,omitempty"`
	StagePosition  *int     `json:"stage_position,omitempty"`
}

// LeadStatus constants
const (
	LeadStatusNew       = "new"
	LeadStatusContacted = "contacted"
	LeadStatusQualified = "qualified"
	LeadStatusProposal  = "proposal"
	LeadStatusWon       = "won"
	LeadStatusLost      = "lost"
)

// Pipeline represents a sales pipeline
type Pipeline struct {
	ID          uuid.UUID        `json:"id"`
	AccountID   uuid.UUID        `json:"account_id"`
	Name        string           `json:"name"`
	Description *string          `json:"description,omitempty"`
	IsDefault   bool             `json:"is_default"`
	KommoID     *int64           `json:"kommo_id,omitempty"`
	Stages      []*PipelineStage `json:"stages,omitempty"`
	CreatedAt   time.Time        `json:"created_at"`
	UpdatedAt   time.Time        `json:"updated_at"`
}

// PipelineStage represents a stage in a pipeline
type PipelineStage struct {
	ID         uuid.UUID `json:"id"`
	PipelineID uuid.UUID `json:"pipeline_id"`
	Name       string    `json:"name"`
	Color      string    `json:"color"`
	Position   int       `json:"position"`
	KommoID    *int64    `json:"kommo_id,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	LeadCount  int       `json:"lead_count,omitempty"`
}

// LeadFilter defines filter options for listing leads
type LeadFilter struct {
	Search     string
	PipelineID *uuid.UUID
	StageID    *uuid.UUID
	TagIDs     []uuid.UUID
	Limit      int
	Offset     int
}

// Person represents a unified search result from contacts and leads
type Person struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Phone      string    `json:"phone,omitempty"`
	Email      string    `json:"email,omitempty"`
	SourceType string    `json:"source_type"` // "contact" or "lead"
	Tags       []*Tag    `json:"tags,omitempty"`
}

// Tag represents a global label with color
type Tag struct {
	ID        uuid.UUID `json:"id"`
	AccountID uuid.UUID `json:"account_id"`
	Name      string    `json:"name"`
	Color     string    `json:"color"`
	KommoID   *int64    `json:"kommo_id,omitempty"`
	Negate    bool      `json:"negate,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Campaign represents a mass messaging campaign
type Campaign struct {
	ID              uuid.UUID              `json:"id"`
	AccountID       uuid.UUID              `json:"account_id"`
	DeviceID        uuid.UUID              `json:"device_id"`
	EventID         *uuid.UUID             `json:"event_id,omitempty"`
	Source          *string                `json:"source,omitempty"` // contacts, event
	Name            string                 `json:"name"`
	MessageTemplate string                 `json:"message_template"`
	MediaURL        *string                `json:"media_url,omitempty"`
	MediaType       *string                `json:"media_type,omitempty"` // text, image, video, document, audio
	Status          string                 `json:"status"`              // draft, scheduled, running, paused, completed, failed
	ScheduledAt     *time.Time             `json:"scheduled_at,omitempty"`
	StartedAt       *time.Time             `json:"started_at,omitempty"`
	CompletedAt     *time.Time             `json:"completed_at,omitempty"`
	TotalRecipients int                    `json:"total_recipients"`
	SentCount       int                    `json:"sent_count"`
	FailedCount     int                    `json:"failed_count"`
	Settings        map[string]interface{} `json:"settings"`
	CreatedBy       *uuid.UUID             `json:"created_by,omitempty"`
	StartedBy       *uuid.UUID             `json:"started_by,omitempty"`
	CreatedAt       time.Time              `json:"created_at"`
	UpdatedAt       time.Time              `json:"updated_at"`

	// Populated on demand
	DeviceName     *string               `json:"device_name,omitempty"`
	CreatedByName  *string               `json:"created_by_name,omitempty"`
	StartedByName  *string               `json:"started_by_name,omitempty"`
	Attachments    []*CampaignAttachment `json:"attachments,omitempty"`
}

// CampaignAttachment represents a media file attached to a campaign
type CampaignAttachment struct {
	ID         uuid.UUID `json:"id"`
	CampaignID uuid.UUID `json:"campaign_id"`
	MediaURL   string    `json:"media_url"`
	MediaType  string    `json:"media_type"` // image, video, audio, document
	Caption    string    `json:"caption"`
	FileName   string    `json:"file_name"`
	FileSize   int64     `json:"file_size"`
	Position   int       `json:"position"`
	CreatedAt  time.Time `json:"created_at"`
}

// CampaignRecipient represents a single recipient in a campaign
type CampaignRecipient struct {
	ID           uuid.UUID              `json:"id"`
	CampaignID   uuid.UUID              `json:"campaign_id"`
	ContactID    *uuid.UUID             `json:"contact_id,omitempty"`
	JID          string                 `json:"jid"`
	Name         *string                `json:"name,omitempty"`
	Phone        *string                `json:"phone,omitempty"`
	Status       string                 `json:"status"` // pending, sent, delivered, failed, skipped
	SentAt       *time.Time             `json:"sent_at,omitempty"`
	ErrorMessage *string                `json:"error_message,omitempty"`
	WaitTimeMs   *int                   `json:"wait_time_ms,omitempty"`
	Metadata     map[string]interface{} `json:"metadata,omitempty"`
}

// Campaign status constants
const (
	CampaignStatusDraft     = "draft"
	CampaignStatusScheduled = "scheduled"
	CampaignStatusRunning   = "running"
	CampaignStatusPaused    = "paused"
	CampaignStatusCompleted = "completed"
	CampaignStatusCancelled = "cancelled"
	CampaignStatusFailed    = "failed"
)

// EventPipeline represents a pipeline for tracking event participant progression
type EventPipeline struct {
	ID          uuid.UUID              `json:"id"`
	AccountID   uuid.UUID              `json:"account_id"`
	Name        string                 `json:"name"`
	Description *string                `json:"description,omitempty"`
	IsDefault   bool                   `json:"is_default"`
	Stages      []*EventPipelineStage  `json:"stages,omitempty"`
	CreatedAt   time.Time              `json:"created_at"`
	UpdatedAt   time.Time              `json:"updated_at"`
}

// EventPipelineStage represents a stage in an event pipeline
type EventPipelineStage struct {
	ID               uuid.UUID `json:"id"`
	PipelineID       uuid.UUID `json:"pipeline_id"`
	Name             string    `json:"name"`
	Color            string    `json:"color"`
	Position         int       `json:"position"`
	CreatedAt        time.Time `json:"created_at"`
	ParticipantCount int       `json:"participant_count,omitempty"`
}

// Event represents an activity/event to track contact interactions
type Event struct {
	ID              uuid.UUID  `json:"id"`
	AccountID       uuid.UUID  `json:"account_id"`
	FolderID        *uuid.UUID `json:"folder_id,omitempty"`
	PipelineID      *uuid.UUID `json:"pipeline_id,omitempty"`
	Name            string     `json:"name"`
	Description     *string    `json:"description,omitempty"`
	EventDate       *time.Time `json:"event_date,omitempty"`
	EventEnd        *time.Time `json:"event_end,omitempty"`
	Location        *string    `json:"location,omitempty"`
	Status          string     `json:"status"` // draft, active, completed, cancelled
	Color           string     `json:"color"`
	TagFormulaMode  string     `json:"tag_formula_mode"`  // OR, AND (used in simple mode)
	TagFormula      string     `json:"tag_formula"`       // text-based formula (advanced mode)
	TagFormulaType  string     `json:"tag_formula_type"`  // simple, advanced
	CreatedBy       *uuid.UUID `json:"created_by,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`

	// Populated on demand
	ParticipantCounts map[string]int `json:"participant_counts,omitempty"`
	StageCounts       map[string]int `json:"stage_counts,omitempty"`
	TotalParticipants int            `json:"total_participants"`
	PipelineName      *string        `json:"pipeline_name,omitempty"`
	Tags              []*Tag         `json:"tags,omitempty"`
}

// EventFolder represents a folder for organising events (Windows Explorer style)
type EventFolder struct {
	ID        uuid.UUID  `json:"id"`
	AccountID uuid.UUID  `json:"account_id"`
	ParentID  *uuid.UUID `json:"parent_id,omitempty"`
	Name      string     `json:"name"`
	Color     string     `json:"color"`
	Icon      string     `json:"icon"`
	Position  int        `json:"position"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`

	// Populated on demand
	EventCount int `json:"event_count,omitempty"`
}

// Event status constants
const (
	EventStatusDraft     = "draft"
	EventStatusActive    = "active"
	EventStatusCompleted = "completed"
	EventStatusCancelled = "cancelled"
)

// EventParticipant represents a contact participating in an event
type EventParticipant struct {
	ID             uuid.UUID  `json:"id"`
	EventID        uuid.UUID  `json:"event_id"`
	ContactID      *uuid.UUID `json:"contact_id,omitempty"`
	LeadID         *uuid.UUID `json:"lead_id,omitempty"`
	StageID        *uuid.UUID `json:"stage_id,omitempty"`
	Name           string     `json:"name"`
	LastName       *string    `json:"last_name,omitempty"`
	ShortName      *string    `json:"short_name,omitempty"`
	Phone          *string    `json:"phone,omitempty"`
	Email          *string    `json:"email,omitempty"`
	Age            *int       `json:"age,omitempty"`
	Status         string     `json:"status"` // invited, contacted, confirmed, declined, attended, no_show
	Notes          *string    `json:"notes,omitempty"`
	NextAction     *string    `json:"next_action,omitempty"`
	NextActionDate *time.Time `json:"next_action_date,omitempty"`
	InvitedAt      *time.Time `json:"invited_at,omitempty"`
	ConfirmedAt    *time.Time `json:"confirmed_at,omitempty"`
	AttendedAt     *time.Time `json:"attended_at,omitempty"`
	AutoTagSync    bool       `json:"auto_tag_sync"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`

	// Populated on demand
	LastInteraction *Interaction `json:"last_interaction,omitempty"`
	Tags            []*Tag       `json:"tags,omitempty"`
	StageName       *string      `json:"stage_name,omitempty"`
	StageColor      *string      `json:"stage_color,omitempty"`
	// Lead pipeline info (populated on demand)
	LeadPipelineID *uuid.UUID `json:"lead_pipeline_id,omitempty"`
	LeadStageID    *uuid.UUID `json:"lead_stage_id,omitempty"`
	LeadStageName  *string    `json:"lead_stage_name,omitempty"`
	LeadStageColor *string    `json:"lead_stage_color,omitempty"`
}

// Participant status constants
const (
	ParticipantStatusInvited   = "invited"
	ParticipantStatusContacted = "contacted"
	ParticipantStatusConfirmed = "confirmed"
	ParticipantStatusDeclined  = "declined"
	ParticipantStatusAttended  = "attended"
	ParticipantStatusNoShow    = "no_show"
)

// Interaction represents a communication log entry with a contact
type Interaction struct {
	ID             uuid.UUID  `json:"id"`
	AccountID      uuid.UUID  `json:"account_id"`
	ContactID      *uuid.UUID `json:"contact_id,omitempty"`
	LeadID         *uuid.UUID `json:"lead_id,omitempty"`
	EventID        *uuid.UUID `json:"event_id,omitempty"`
	ParticipantID  *uuid.UUID `json:"participant_id,omitempty"`
	Type           string     `json:"type"`      // call, whatsapp, note, email, meeting
	Direction      *string    `json:"direction,omitempty"` // inbound, outbound
	Outcome        *string    `json:"outcome,omitempty"`   // answered, no_answer, voicemail, busy, confirmed, declined, rescheduled, callback
	Notes          *string    `json:"notes,omitempty"`
	NextAction     *string    `json:"next_action,omitempty"`
	NextActionDate *time.Time `json:"next_action_date,omitempty"`
	CreatedBy      *uuid.UUID `json:"created_by,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	KommoCallSlot  *int       `json:"kommo_call_slot,omitempty"`

	// Populated on demand
	CreatedByName *string `json:"created_by_name,omitempty"`
	EventName     *string `json:"event_name,omitempty"`
}

// Interaction type constants
const (
	InteractionTypeCall     = "call"
	InteractionTypeWhatsApp = "whatsapp"
	InteractionTypeNote     = "note"
	InteractionTypeEmail    = "email"
	InteractionTypeMeeting  = "meeting"
)

// Interaction outcome constants
const (
	InteractionOutcomeAnswered    = "answered"
	InteractionOutcomeNoAnswer    = "no_answer"
	InteractionOutcomeVoicemail   = "voicemail"
	InteractionOutcomeBusy        = "busy"
	InteractionOutcomeConfirmed   = "confirmed"
	InteractionOutcomeDeclined    = "declined"
	InteractionOutcomeRescheduled = "rescheduled"
	InteractionOutcomeCallback    = "callback"
)

// EventFilter defines filter options for listing events
type EventFilter struct {
	Search       string
	Status       string
	FolderFilter string // "": all events, "root": folder_id IS NULL, "<uuid>": specific folder
	DateFrom     *time.Time
	DateTo       *time.Time
	Limit        int
	Offset       int
}

// InteractionFilter defines filter options for listing interactions
type InteractionFilter struct {
	ContactID     *uuid.UUID
	EventID       *uuid.UUID
	ParticipantID *uuid.UUID
	Type          string
	Limit         int
	Offset        int
}

// QuickReply represents a canned/predefined response
type QuickReply struct {
	ID            uuid.UUID             `json:"id"`
	AccountID     uuid.UUID             `json:"account_id"`
	Shortcut      string                `json:"shortcut"`
	Title         string                `json:"title"`
	Body          string                `json:"body"`
	MediaURL      string                `json:"media_url"`
	MediaType     string                `json:"media_type"`
	MediaFilename string                `json:"media_filename"`
	Attachments   []QuickReplyAttachment `json:"attachments"`
	CreatedAt     time.Time             `json:"created_at"`
	UpdatedAt     time.Time             `json:"updated_at"`
}

// QuickReplyAttachment represents a media attachment for a quick reply (up to 5)
type QuickReplyAttachment struct {
	ID            uuid.UUID `json:"id"`
	QuickReplyID  uuid.UUID `json:"quick_reply_id"`
	MediaURL      string    `json:"media_url"`
	MediaType     string    `json:"media_type"`
	MediaFilename string    `json:"media_filename"`
	Caption       string    `json:"caption"`
	Position      int       `json:"position"`
}

// Default campaign settings (anti-ban)
func DefaultCampaignSettings() map[string]interface{} {
	return map[string]interface{}{
		"min_delay_seconds":    8,
		"max_delay_seconds":    15,
		"batch_size":           25,
		"batch_pause_minutes":  2,
		"daily_limit":          1000,
		"active_hours_start":   "07:00",
		"active_hours_end":     "22:00",
		"randomize_message":    true,
		"simulate_typing":      true,
	}
}

// --- Programs (Courses, Workshops, etc.) ---

// ProgramFolder represents a folder for organising programs
type ProgramFolder struct {
	ID        uuid.UUID  `json:"id"`
	AccountID uuid.UUID  `json:"account_id"`
	ParentID  *uuid.UUID `json:"parent_id,omitempty"`
	Name      string     `json:"name"`
	Color     string     `json:"color"`
	Icon      string     `json:"icon"`
	Position  int        `json:"position"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`

	// Populated on demand
	ProgramCount int `json:"program_count,omitempty"`
}

// Program represents an educational program, course, or workshop
type Program struct {
	ID          uuid.UUID  `json:"id"`
	AccountID   uuid.UUID  `json:"account_id"`
	FolderID    *uuid.UUID `json:"folder_id,omitempty"`
	Name        string     `json:"name"`
	Description *string    `json:"description,omitempty"`
	Status      string     `json:"status"` // active, completed, archived
	Color       string     `json:"color"`
	CreatedBy   *uuid.UUID `json:"created_by,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`

	// Schedule fields for recurring sessions
	ScheduleStartDate *time.Time `json:"schedule_start_date,omitempty"`
	ScheduleEndDate   *time.Time `json:"schedule_end_date,omitempty"`
	ScheduleDays      []int      `json:"schedule_days,omitempty"`      // 0=Sun, 1=Mon, ..., 6=Sat
	ScheduleStartTime *string    `json:"schedule_start_time,omitempty"` // "HH:MM" format
	ScheduleEndTime   *string    `json:"schedule_end_time,omitempty"`   // "HH:MM" format

	// Populated on demand
	ParticipantCount int `json:"participant_count"`
	SessionCount     int `json:"session_count"`
}

// ProgramParticipant represents a contact enrolled in a program
type ProgramParticipant struct {
	ID         uuid.UUID  `json:"id"`
	ProgramID  uuid.UUID  `json:"program_id"`
	ContactID  uuid.UUID  `json:"contact_id"`
	LeadID     *uuid.UUID `json:"lead_id,omitempty"`
	Status     string     `json:"status"` // active, dropped, completed
	EnrolledAt time.Time  `json:"enrolled_at"`

	// Populated on demand
	ContactName  string  `json:"contact_name,omitempty"`
	ContactPhone *string `json:"contact_phone,omitempty"`
}

// ProgramSession represents a single class or session within a program
type ProgramSession struct {
	ID        uuid.UUID  `json:"id"`
	ProgramID uuid.UUID  `json:"program_id"`
	Date      time.Time  `json:"date"`
	Topic     *string    `json:"topic,omitempty"`
	StartTime *string    `json:"start_time,omitempty"` // "HH:MM" format
	EndTime   *string    `json:"end_time,omitempty"`   // "HH:MM" format
	Location  *string    `json:"location,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`

	// Populated on demand
	AttendanceStats map[string]int `json:"attendance_stats,omitempty"`
}

// ProgramAttendance represents a participant's attendance record for a session
type ProgramAttendance struct {
	ID            uuid.UUID `json:"id"`
	SessionID     uuid.UUID `json:"session_id"`
	ParticipantID uuid.UUID `json:"participant_id"`
	Status        string    `json:"status"` // present, absent, late, excused
	Notes         *string   `json:"notes,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`

	// Populated on demand
	ParticipantName  string  `json:"participant_name,omitempty"`
	ParticipantPhone *string `json:"participant_phone,omitempty"`
}

// Attendance status constants
const (
	AttendanceStatusPresent = "present"
	AttendanceStatusAbsent  = "absent"
	AttendanceStatusLate    = "late"
	AttendanceStatusExcused = "excused"
)

// WhatsAppCheckResult represents the result of checking if a phone is on WhatsApp
type WhatsAppCheckResult struct {
	Phone        string `json:"phone"`
	IsOnWhatsApp bool   `json:"is_on_whatsapp"`
	JID          string `json:"jid,omitempty"`
}

// ── Event Logbooks (Bitácora) ──────────────────────────────────────────

// EventLogbook represents a snapshot of an event's state on a specific date
type EventLogbook struct {
	ID                uuid.UUID              `json:"id"`
	EventID           uuid.UUID              `json:"event_id"`
	AccountID         uuid.UUID              `json:"account_id"`
	Date              time.Time              `json:"date"`
	Title             string                 `json:"title"`
	Status            string                 `json:"status"` // pending, completed
	GeneralNotes      string                 `json:"general_notes"`
	StageSnapshot     map[string]interface{} `json:"stage_snapshot"`
	TotalParticipants int                    `json:"total_participants"`
	CapturedAt        *time.Time             `json:"captured_at,omitempty"`
	CreatedBy         *uuid.UUID             `json:"created_by,omitempty"`
	SavedFilter       json.RawMessage        `json:"saved_filter,omitempty"`
	CreatedAt         time.Time              `json:"created_at"`
	UpdatedAt         time.Time              `json:"updated_at"`

	// Populated on demand
	Entries       []*EventLogbookEntry `json:"entries,omitempty"`
	CreatedByName *string              `json:"created_by_name,omitempty"`
}

// EventLogbookEntry represents a participant's state snapshot in a logbook
type EventLogbookEntry struct {
	ID            uuid.UUID  `json:"id"`
	LogbookID     uuid.UUID  `json:"logbook_id"`
	ParticipantID uuid.UUID  `json:"participant_id"`
	StageID       *uuid.UUID `json:"stage_id,omitempty"`
	StageName     string     `json:"stage_name"`
	StageColor    string     `json:"stage_color"`
	Notes         string     `json:"notes"`
	CreatedAt     time.Time  `json:"created_at"`

	// Populated on demand
	ParticipantName  string  `json:"participant_name,omitempty"`
	ParticipantPhone *string `json:"participant_phone,omitempty"`
}

// Logbook status constants
const (
	LogbookStatusPending   = "pending"
	LogbookStatusCompleted = "completed"
)

// APIKey represents an API key for MCP / external integrations
type APIKey struct {
	ID          uuid.UUID  `json:"id"`
	AccountID   uuid.UUID  `json:"account_id"`
	Name        string     `json:"name"`
	KeyHash     string     `json:"-"`
	KeyPrefix   string     `json:"key_prefix"`
	Permissions string     `json:"permissions"`
	IsActive    bool       `json:"is_active"`
	LastUsedAt  *time.Time `json:"last_used_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// ErosConversation represents a persistent chat conversation with Eros AI
type ErosConversation struct {
	ID        uuid.UUID `json:"id"`
	AccountID uuid.UUID `json:"account_id"`
	UserID    uuid.UUID `json:"user_id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// Populated on demand
	Messages []ErosMessage `json:"messages,omitempty"`
}

// ErosMessage represents a single message in an Eros conversation
type ErosMessage struct {
	ID             uuid.UUID `json:"id"`
	ConversationID uuid.UUID `json:"conversation_id"`
	Role           string    `json:"role"` // "user" or "assistant"
	Content        string    `json:"content"`
	CreatedAt      time.Time `json:"created_at"`
}

// AITokenLog represents a log of AI tokens consumed by a user
type AITokenLog struct {
	ID            uuid.UUID `json:"id"`
	AccountID     uuid.UUID `json:"account_id"`
	UserID        uuid.UUID `json:"user_id"`
	APIKeyPreview string    `json:"api_key_preview"`
	Model         string    `json:"model"`
	InputTokens   int       `json:"input_tokens"`
	OutputTokens  int       `json:"output_tokens"`
	TotalTokens   int       `json:"total_tokens"`
	CreatedAt     time.Time `json:"created_at"`
}

// ── Automations ───────────────────────────────────────────────────────────

// Automation trigger type constants
const (
	AutoTriggerLeadCreated      = "lead_created"
	AutoTriggerLeadStageChanged = "lead_stage_changed"
	AutoTriggerTagAssigned      = "tag_assigned"
	AutoTriggerTagRemoved       = "tag_removed"
	AutoTriggerMessageReceived  = "message_received"
	AutoTriggerManual           = "manual"
)

// Automation node type constants
const (
	AutoNodeSendWhatsApp = "send_whatsapp"
	AutoNodeChangeStage  = "change_stage"
	AutoNodeAssignTag    = "assign_tag"
	AutoNodeRemoveTag    = "remove_tag"
	AutoNodeDelay        = "delay"
	AutoNodeCondition    = "condition"
)

// Automation execution status constants
const (
	AutoExecPending   = "pending"
	AutoExecRunning   = "running"
	AutoExecPaused    = "paused"
	AutoExecCompleted = "completed"
	AutoExecFailed    = "failed"
)

// AutomationGraph is the ReactFlow-compatible graph stored as JSONB
type AutomationGraph struct {
	Nodes []AutomationNode `json:"nodes"`
	Edges []AutomationEdge `json:"edges"`
}

// AutomationNode represents a single node in the automation graph (ReactFlow format)
type AutomationNode struct {
	ID       string                 `json:"id"`
	Type     string                 `json:"type"`      // trigger, action, condition, delay
	Position map[string]float64     `json:"position"`  // {x, y}
	Data     map[string]interface{} `json:"data"`      // node config: {nodeType, label, config}
}

// AutomationEdge represents a connection between nodes (ReactFlow format)
type AutomationEdge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	Target       string `json:"target"`
	SourceHandle string `json:"sourceHandle,omitempty"` // "true" or "false" for condition nodes
}

// Automation represents a workflow automation definition
type Automation struct {
	ID              uuid.UUID              `json:"id"`
	AccountID       uuid.UUID              `json:"account_id"`
	Name            string                 `json:"name"`
	Description     string                 `json:"description"`
	TriggerType     string                 `json:"trigger"`
	TriggerConfig   map[string]interface{} `json:"trigger_config"`
	Config          AutomationGraph        `json:"graph"`
	IsActive        bool                   `json:"is_active"`
	ExecutionCount  int                    `json:"execution_count"`
	LastTriggeredAt *time.Time             `json:"last_triggered_at,omitempty"`
	CreatedAt       time.Time              `json:"created_at"`
	UpdatedAt       time.Time              `json:"updated_at"`
}

// AutomationExecution represents a single run of an automation for a lead
type AutomationExecution struct {
	ID             uuid.UUID              `json:"id"`
	AutomationID   uuid.UUID              `json:"automation_id"`
	AccountID      uuid.UUID              `json:"account_id"`
	LeadID         *uuid.UUID             `json:"lead_id,omitempty"`
	Status         string                 `json:"status"`
	CurrentNodeID  string                 `json:"current_node_id"`
	NextNodeID     string                 `json:"next_node_id,omitempty"`
	ResumeAt       *time.Time             `json:"resume_at,omitempty"`
	ConfigSnapshot *AutomationGraph       `json:"config_snapshot,omitempty"`
	ContextData    map[string]interface{} `json:"context_data"`
	ErrorMessage   string                 `json:"error_message,omitempty"`
	StartedAt      time.Time              `json:"started_at"`
	CompletedAt    *time.Time             `json:"completed_at,omitempty"`
	CreatedAt      time.Time              `json:"created_at"`

	// Populated on demand
	AutomationName string `json:"automation_name,omitempty"`
}

// AutomationExecutionLog records the result of each node execution
type AutomationExecutionLog struct {
	ID          uuid.UUID `json:"id"`
	ExecutionID uuid.UUID `json:"execution_id"`
	NodeID      string    `json:"node_id"`
	NodeType    string    `json:"node_type"`
	Status      string    `json:"status"` // success, failed, skipped
	DurationMs  int       `json:"duration_ms"`
	Error       string    `json:"error,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

// AutomationStats summarizes an automation's execution history
type AutomationStats struct {
	TotalExecutions     int `json:"total_executions"`
	CompletedExecutions int `json:"completed"`
	FailedExecutions    int `json:"failed"`
	ActiveExecutions    int `json:"active"`
}

// ─── Surveys / Forms ──────────────────────────────────────────────────────────

// SurveyBranding holds visual customization for the public form
type SurveyBranding struct {
	LogoURL       string `json:"logo_url,omitempty"`
	BgColor       string `json:"bg_color,omitempty"`
	AccentColor   string `json:"accent_color,omitempty"`
	BgImageURL    string `json:"bg_image_url,omitempty"`
	FontFamily    string `json:"font_family,omitempty"`    // Inter, Poppins, Playfair Display, etc.
	TitleSize     string `json:"title_size,omitempty"`     // sm, md, lg, xl
	TextColor     string `json:"text_color,omitempty"`     // custom text color for titles
	ButtonStyle   string `json:"button_style,omitempty"`   // rounded, pill, square
	BgOverlay     string `json:"bg_overlay,omitempty"`     // overlay opacity: 0, 0.2, 0.4, 0.6
	QuestionAlign string `json:"question_align,omitempty"` // left, center
}

// Survey represents a form/survey that can be shared via a public link
type Survey struct {
	ID                  uuid.UUID       `json:"id"`
	AccountID           uuid.UUID       `json:"account_id"`
	Name                string          `json:"name"`
	Description         string          `json:"description"`
	Slug                string          `json:"slug"`
	Status              string          `json:"status"` // draft, active, closed
	WelcomeTitle        string          `json:"welcome_title"`
	WelcomeDescription  string          `json:"welcome_description"`
	ThankYouTitle       string          `json:"thank_you_title"`
	ThankYouMessage     string          `json:"thank_you_message"`
	ThankYouRedirectURL string          `json:"thank_you_redirect_url"`
	Branding            SurveyBranding  `json:"branding"`
	IsTemplate          bool            `json:"is_template"`
	CreatedBy           *uuid.UUID      `json:"created_by,omitempty"`
	CreatedAt           time.Time       `json:"created_at"`
	UpdatedAt           time.Time       `json:"updated_at"`
	// Populated on demand
	QuestionCount int `json:"question_count,omitempty"`
	ResponseCount int `json:"response_count,omitempty"`
}

// SurveyQuestionConfig holds type-specific configuration for a question
type SurveyQuestionConfig struct {
	Options     []string `json:"options,omitempty"`      // single_choice, multiple_choice
	MaxRating   int      `json:"max_rating,omitempty"`   // rating (default 5)
	LikertScale int      `json:"likert_scale,omitempty"` // likert scale points (default 5)
	LikertMin   string   `json:"likert_min,omitempty"`   // likert min label
	LikertMax   string   `json:"likert_max,omitempty"`   // likert max label
	AllowedTypes []string `json:"allowed_types,omitempty"` // file_upload mime types
	MaxSizeMB   int      `json:"max_size_mb,omitempty"`  // file_upload max size
	Placeholder string   `json:"placeholder,omitempty"`  // text input placeholder
}

// SurveyLogicRule defines a conditional jump based on an answer value
type SurveyLogicRule struct {
	Value      string    `json:"value"`                  // answer value to match
	Operator   string    `json:"operator,omitempty"`     // eq, neq, contains, gt, lt (default: eq)
	JumpTo     uuid.UUID `json:"jump_to"`                // question ID to jump to
}

// SurveyQuestion represents a single question in a survey
type SurveyQuestion struct {
	ID          uuid.UUID             `json:"id"`
	SurveyID    uuid.UUID             `json:"survey_id"`
	OrderIndex  int                   `json:"order_index"`
	Type        string                `json:"type"` // short_text, long_text, single_choice, multiple_choice, rating, likert, date, email, phone, file_upload
	Title       string                `json:"title"`
	Description string                `json:"description"`
	Required    bool                  `json:"required"`
	Config      SurveyQuestionConfig  `json:"config"`
	LogicRules  []SurveyLogicRule     `json:"logic_rules"`
	CreatedAt   time.Time             `json:"created_at"`
	UpdatedAt   time.Time             `json:"updated_at"`
}

// SurveyResponse represents a complete submission by one respondent
type SurveyResponse struct {
	ID              uuid.UUID  `json:"id"`
	SurveyID        uuid.UUID  `json:"survey_id"`
	AccountID       uuid.UUID  `json:"account_id"`
	RespondentToken string     `json:"respondent_token"`
	LeadID          *uuid.UUID `json:"lead_id,omitempty"`
	Source          string     `json:"source,omitempty"` // direct, ws, ig, email, qr
	IPAddress       string     `json:"-"`
	UserAgent       string     `json:"-"`
	StartedAt       time.Time  `json:"started_at"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	// Populated on demand
	Answers []SurveyAnswer `json:"answers,omitempty"`
}

// SurveyAnswer represents the answer to a single question within a response
type SurveyAnswer struct {
	ID         uuid.UUID `json:"id"`
	ResponseID uuid.UUID `json:"response_id"`
	QuestionID uuid.UUID `json:"question_id"`
	Value      string    `json:"value"`
	FileURL    string    `json:"file_url,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// SurveyAnalytics holds aggregated data for a survey's results
type SurveyAnalytics struct {
	TotalResponses    int                          `json:"total_responses"`
	CompletionRate    float64                      `json:"completion_rate"`
	AvgCompletionSec  float64                      `json:"avg_completion_seconds"`
	QuestionStats     []SurveyQuestionStats        `json:"question_stats"`
}

// SurveyQuestionStats holds per-question aggregated stats
type SurveyQuestionStats struct {
	QuestionID   uuid.UUID          `json:"question_id"`
	QuestionType string             `json:"question_type"`
	Title        string             `json:"title"`
	TotalAnswers int                `json:"total_answers"`
	// For choice-based questions
	OptionCounts map[string]int     `json:"option_counts,omitempty"`
	// For numeric questions (rating, likert)
	Average      *float64           `json:"average,omitempty"`
	Distribution map[string]int     `json:"distribution,omitempty"`
}

// ─── Dynamics (Interactive Activities) ────────────────────────────────────────

// DynamicConfig holds visual configuration for a dynamic activity
type DynamicConfig struct {
	Title            string  `json:"title"`
	ScratchColor     string  `json:"scratch_color"`
	ScratchThreshold int     `json:"scratch_threshold"`
	ScratchSound     bool    `json:"scratch_sound"`
	ShowConfetti     bool    `json:"show_confetti"`
	VictorySound     bool    `json:"victory_sound"`
	OverlayImageURL  string  `json:"overlay_image_url"`
	BgColor          string  `json:"bg_color"`
}

// Dynamic represents an interactive activity (e.g. scratch card)
type Dynamic struct {
	ID          uuid.UUID     `json:"id"`
	AccountID   uuid.UUID     `json:"account_id"`
	Type        string        `json:"type"`
	Name        string        `json:"name"`
	Slug        string        `json:"slug"`
	Description string        `json:"description"`
	Config      DynamicConfig `json:"config"`
	IsActive    bool          `json:"is_active"`
	ItemCount   int           `json:"item_count"`
	CreatedAt   time.Time     `json:"created_at"`
	UpdatedAt   time.Time     `json:"updated_at"`
}

// DynamicItem represents a single item within a dynamic activity
type DynamicItem struct {
	ID          uuid.UUID   `json:"id"`
	DynamicID   uuid.UUID   `json:"dynamic_id"`
	OptionIDs   []uuid.UUID `json:"option_ids"`
	ImageURL    string      `json:"image_url"`
	ThoughtText string      `json:"thought_text"`
	Author      string      `json:"author"`
	Tipo        string      `json:"tipo"`
	FileSize    int64       `json:"file_size"`
	SortOrder   int         `json:"sort_order"`
	IsActive    bool        `json:"is_active"`
	CreatedAt   time.Time   `json:"created_at"`
}

// DynamicOption represents a selectable category for items within a dynamic
type DynamicOption struct {
	ID        uuid.UUID `json:"id"`
	DynamicID uuid.UUID `json:"dynamic_id"`
	Name      string    `json:"name"`
	Emoji     string    `json:"emoji"`
	SortOrder int       `json:"sort_order"`
	ItemCount int       `json:"item_count"`
	CreatedAt time.Time `json:"created_at"`
}

// DynamicLink represents a public link for a dynamic with its own WhatsApp config
type DynamicLink struct {
	ID                    uuid.UUID  `json:"id"`
	DynamicID             uuid.UUID  `json:"dynamic_id"`
	Slug                  string     `json:"slug"`
	WhatsAppEnabled       bool       `json:"whatsapp_enabled"`
	WhatsAppMessage       string     `json:"whatsapp_message"`
	ExtraMessageText      string     `json:"extra_message_text"`
	ExtraMessageMediaURL  string     `json:"extra_message_media_url"`
	ExtraMessageMediaType string     `json:"extra_message_media_type"`
	StartsAt              *time.Time `json:"starts_at"`
	EndsAt                *time.Time `json:"ends_at"`
	IsActive              bool       `json:"is_active"`
	CreatedAt             time.Time  `json:"created_at"`
}

// DynamicLinkRegistration represents a participant registration on a public link
type DynamicLinkRegistration struct {
	ID        uuid.UUID `json:"id"`
	LinkID    uuid.UUID `json:"link_id"`
	FullName  string    `json:"full_name"`
	Phone     string    `json:"phone"`
	Age       int       `json:"age"`
	CreatedAt time.Time `json:"created_at"`
}

// DynamicWhatsAppQueue represents a queued WhatsApp message for a dynamic
type DynamicWhatsAppQueue struct {
	ID             uuid.UUID  `json:"id"`
	DynamicID      uuid.UUID  `json:"dynamic_id"`
	AccountID      uuid.UUID  `json:"account_id"`
	LinkID         uuid.UUID  `json:"link_id"`
	Phone          string     `json:"phone"`
	ItemID         uuid.UUID  `json:"item_id"`
	ImageURL       string     `json:"image_url"`
	Caption        string     `json:"caption"`
	ExtraText      string     `json:"extra_text"`
	ExtraMediaURL  string     `json:"extra_media_url"`
	ExtraMediaType string     `json:"extra_media_type"`
	Status         string     `json:"status"`
	ErrorMsg       string     `json:"error_msg"`
	CreatedAt      time.Time  `json:"created_at"`
	SentAt         *time.Time `json:"sent_at"`
}

