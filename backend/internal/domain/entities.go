package domain

import (
	"time"

	"github.com/google/uuid"
)

// Account represents a tenant in the multi-tenant system
type Account struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Slug       string    `json:"slug"`
	Plan       string    `json:"plan"`
	MaxDevices int       `json:"max_devices"`
	IsActive   bool      `json:"is_active"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`

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

// UserAccount represents a user's assignment to an account (many-to-many)
type UserAccount struct {
	ID          uuid.UUID `json:"id"`
	UserID      uuid.UUID `json:"user_id"`
	AccountID   uuid.UUID `json:"account_id"`
	Role        string    `json:"role"`
	IsDefault   bool      `json:"is_default"`
	CreatedAt   time.Time `json:"created_at"`

	// Populated on demand
	AccountName string `json:"account_name,omitempty"`
	AccountSlug string `json:"account_slug,omitempty"`
}

// Device represents a WhatsApp connection
type Device struct {
	ID         uuid.UUID  `json:"id"`
	AccountID  uuid.UUID  `json:"account_id"`
	Name       *string    `json:"name,omitempty"`
	Phone      *string    `json:"phone,omitempty"`
	JID        *string    `json:"jid,omitempty"`
	Status     *string    `json:"status,omitempty"` // disconnected, connecting, connected, logged_out
	QRCode     *string    `json:"qr_code,omitempty"`
	LastSeenAt *time.Time `json:"last_seen_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
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
	Tags       []string   `json:"tags,omitempty"`
	Notes      *string    `json:"notes,omitempty"`
	Source     *string    `json:"source,omitempty"`
	IsGroup    bool       `json:"is_group"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`

	// Relations (populated on demand)
	DeviceNames []ContactDeviceName `json:"device_names,omitempty"`
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
	DeviceName  *string `json:"device_name,omitempty"`
	DevicePhone *string `json:"device_phone,omitempty"`

	// Contact info (populated via JOIN)
	ContactPhone      *string `json:"contact_phone,omitempty"`
	ContactAvatarURL  *string `json:"contact_avatar_url,omitempty"`
	ContactCustomName *string `json:"contact_custom_name,omitempty"`
	ContactName       *string `json:"contact_name,omitempty"`

	// Relations (populated on demand)
	Contact  *Contact   `json:"contact,omitempty"`
	Messages []*Message `json:"messages,omitempty"`
}

// ChatFilter defines filter options for listing chats
type ChatFilter struct {
	DeviceIDs  []uuid.UUID
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
	MessageType   *string    `json:"message_type,omitempty"` // text, image, video, audio, document, sticker
	MediaURL      *string    `json:"media_url,omitempty"`
	MediaMimetype *string    `json:"media_mimetype,omitempty"`
	MediaFilename *string    `json:"media_filename,omitempty"`
	MediaSize     *int64     `json:"media_size,omitempty"`
	IsFromMe      bool       `json:"is_from_me"`
	IsRead        bool       `json:"is_read"`
	Status        *string    `json:"status,omitempty"` // sent, delivered, read, failed
	Timestamp     time.Time  `json:"timestamp"`
	CreatedAt     time.Time  `json:"created_at"`

	// Quoted/reply fields
	QuotedMessageID *string `json:"quoted_message_id,omitempty"`
	QuotedBody      *string `json:"quoted_body,omitempty"`
	QuotedSender    *string `json:"quoted_sender,omitempty"`

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
	Phone        *string                `json:"phone,omitempty"`
	Email        *string                `json:"email,omitempty"`
	Status       *string                `json:"status,omitempty"` // new, contacted, qualified, proposal, won, lost
	Source       *string                `json:"source,omitempty"`
	Notes        *string                `json:"notes,omitempty"`
	Tags         []string               `json:"tags,omitempty"`
	CustomFields map[string]interface{} `json:"custom_fields,omitempty"`
	AssignedTo   *uuid.UUID             `json:"assigned_to,omitempty"`
	CreatedAt    time.Time              `json:"created_at"`
	UpdatedAt    time.Time              `json:"updated_at"`

	// Relations
	Contact *Contact `json:"contact,omitempty"`
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
	CreatedAt  time.Time `json:"created_at"`
}

// Tag represents a global label with color
type Tag struct {
	ID        uuid.UUID `json:"id"`
	AccountID uuid.UUID `json:"account_id"`
	Name      string    `json:"name"`
	Color     string    `json:"color"`
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
	CreatedAt       time.Time              `json:"created_at"`
	UpdatedAt       time.Time              `json:"updated_at"`

	// Populated on demand
	DeviceName  *string               `json:"device_name,omitempty"`
	Attachments []*CampaignAttachment `json:"attachments,omitempty"`
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
	ID           uuid.UUID  `json:"id"`
	CampaignID   uuid.UUID  `json:"campaign_id"`
	ContactID    *uuid.UUID `json:"contact_id,omitempty"`
	JID          string     `json:"jid"`
	Name         *string    `json:"name,omitempty"`
	Phone        *string    `json:"phone,omitempty"`
	Status       string     `json:"status"` // pending, sent, delivered, failed, skipped
	SentAt       *time.Time `json:"sent_at,omitempty"`
	ErrorMessage *string    `json:"error_message,omitempty"`
	WaitTimeMs   *int       `json:"wait_time_ms,omitempty"`
}

// Campaign status constants
const (
	CampaignStatusDraft     = "draft"
	CampaignStatusScheduled = "scheduled"
	CampaignStatusRunning   = "running"
	CampaignStatusPaused    = "paused"
	CampaignStatusCompleted = "completed"
	CampaignStatusFailed    = "failed"
)

// Event represents an activity/event to track contact interactions
type Event struct {
	ID          uuid.UUID  `json:"id"`
	AccountID   uuid.UUID  `json:"account_id"`
	Name        string     `json:"name"`
	Description *string    `json:"description,omitempty"`
	EventDate   *time.Time `json:"event_date,omitempty"`
	EventEnd    *time.Time `json:"event_end,omitempty"`
	Location    *string    `json:"location,omitempty"`
	Status      string     `json:"status"` // draft, active, completed, cancelled
	Color       string     `json:"color"`
	CreatedBy   *uuid.UUID `json:"created_by,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`

	// Populated on demand
	ParticipantCounts map[string]int `json:"participant_counts,omitempty"`
	TotalParticipants int            `json:"total_participants"`
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
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`

	// Populated on demand
	LastInteraction *Interaction `json:"last_interaction,omitempty"`
	Tags            []*Tag       `json:"tags,omitempty"`
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
	Search   string
	Status   string
	DateFrom *time.Time
	DateTo   *time.Time
	Limit    int
	Offset   int
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
