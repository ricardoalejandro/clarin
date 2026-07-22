package domain

import (
	"time"

	"github.com/google/uuid"
)

// SurveyTemplate is a reusable definition. It never owns a public slug or
// receives answers directly; answers always belong to a Survey application.
type SurveyTemplate struct {
	ID                  uuid.UUID      `json:"id"`
	AccountID           uuid.UUID      `json:"account_id"`
	Name                string         `json:"name"`
	Description         string         `json:"description"`
	Status              string         `json:"status"`
	WelcomeTitle        string         `json:"welcome_title"`
	WelcomeDescription  string         `json:"welcome_description"`
	ThankYouTitle       string         `json:"thank_you_title"`
	ThankYouMessage     string         `json:"thank_you_message"`
	ThankYouRedirectURL string         `json:"thank_you_redirect_url"`
	Branding            SurveyBranding `json:"branding"`
	Revision            int            `json:"revision"`
	SystemKey           *string        `json:"system_key,omitempty"`
	LegacySurveyID      *uuid.UUID     `json:"legacy_survey_id,omitempty"`
	CreatedBy           *uuid.UUID     `json:"created_by,omitempty"`
	CreatedAt           time.Time      `json:"created_at"`
	UpdatedAt           time.Time      `json:"updated_at"`
	QuestionCount       int            `json:"question_count"`
	InstanceCount       int            `json:"instance_count"`
	ResponseCount       int            `json:"response_count"`
}

type SurveyTemplateQuestion struct {
	ID          uuid.UUID            `json:"id"`
	AccountID   uuid.UUID            `json:"account_id"`
	TemplateID  uuid.UUID            `json:"template_id"`
	OrderIndex  int                  `json:"order_index"`
	Type        string               `json:"type"`
	Title       string               `json:"title"`
	Description string               `json:"description"`
	Required    bool                 `json:"required"`
	Config      SurveyQuestionConfig `json:"config"`
	LogicRules  []SurveyLogicRule    `json:"logic_rules"`
	IsActive    bool                 `json:"is_active"`
	CreatedAt   time.Time            `json:"created_at"`
	UpdatedAt   time.Time            `json:"updated_at"`
}

// SurveyInstanceSummary describes one application of a template. The legacy
// surveys table remains its persistence source for backwards compatibility.
type SurveyInstanceSummary struct {
	ID               uuid.UUID  `json:"id"`
	AccountID        uuid.UUID  `json:"account_id"`
	TemplateID       uuid.UUID  `json:"template_id"`
	TemplateRevision int        `json:"template_revision"`
	ProgramID        *uuid.UUID `json:"program_id,omitempty"`
	OriginType       string     `json:"origin_type"`
	OriginLabel      string     `json:"origin_label"`
	Name             string     `json:"name"`
	Slug             string     `json:"slug"`
	Status           string     `json:"status"`
	AudienceMode     string     `json:"audience_mode"`
	OpensAt          *time.Time `json:"opens_at,omitempty"`
	ClosesAt         *time.Time `json:"closes_at,omitempty"`
	LegacyInstance   bool       `json:"legacy_instance"`
	QuestionCount    int        `json:"question_count"`
	RecipientCount   int        `json:"recipient_count"`
	ResponseCount    int        `json:"response_count"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type CreateSurveyInstanceInput struct {
	TemplateID   uuid.UUID
	AccountID    uuid.UUID
	ProgramID    *uuid.UUID
	Name         string
	Slug         string
	Status       string
	AudienceMode string
	OpensAt      *time.Time
	ClosesAt     *time.Time
	CreatedBy    *uuid.UUID
}

type SurveyInstanceRecipient struct {
	ID                   uuid.UUID  `json:"id"`
	AccountID            uuid.UUID  `json:"account_id"`
	SurveyID             uuid.UUID  `json:"survey_id"`
	ProgramID            *uuid.UUID `json:"program_id,omitempty"`
	ProgramParticipantID *uuid.UUID `json:"program_participant_id,omitempty"`
	ContactID            *uuid.UUID `json:"contact_id,omitempty"`
	ContactName          string     `json:"contact_name,omitempty"`
	AccessToken          uuid.UUID  `json:"-"`
	Status               string     `json:"status"`
	OpenedAt             *time.Time `json:"opened_at,omitempty"`
	CompletedAt          *time.Time `json:"completed_at,omitempty"`
}
