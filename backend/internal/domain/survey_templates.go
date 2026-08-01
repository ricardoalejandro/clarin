package domain

import (
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// CleanSurveyInstanceName keeps the displayed name human-readable while
// removing invisible differences that would otherwise create confusing
// duplicates. The comparison key additionally applies Unicode case folding.
func CleanSurveyInstanceName(value string) string {
	return strings.Join(strings.Fields(norm.NFKC.String(value)), " ")
}

func SurveyInstanceNameKey(value string) string {
	return cases.Fold().String(CleanSurveyInstanceName(value))
}

// SurveyTemplate is a reusable definition. It never owns a public slug or
// receives answers directly; answers always belong to a Survey application.
type SurveyTemplate struct {
	ID                  uuid.UUID               `json:"id"`
	AccountID           uuid.UUID               `json:"account_id"`
	Name                string                  `json:"name"`
	Description         string                  `json:"description"`
	Status              string                  `json:"status"`
	WelcomeTitle        string                  `json:"welcome_title"`
	WelcomeDescription  string                  `json:"welcome_description"`
	ThankYouTitle       string                  `json:"thank_you_title"`
	ThankYouMessage     string                  `json:"thank_you_message"`
	ThankYouRedirectURL string                  `json:"thank_you_redirect_url"`
	Branding            SurveyBranding          `json:"branding"`
	MeasurementConfig   SurveyMeasurementConfig `json:"measurement_config"`
	Revision            int                     `json:"revision"`
	SystemKey           *string                 `json:"system_key,omitempty"`
	LegacySurveyID      *uuid.UUID              `json:"legacy_survey_id,omitempty"`
	CreatedBy           *uuid.UUID              `json:"created_by,omitempty"`
	CreatedAt           time.Time               `json:"created_at"`
	UpdatedAt           time.Time               `json:"updated_at"`
	QuestionCount       int                     `json:"question_count"`
	InstanceCount       int                     `json:"instance_count"`
	ResponseCount       int                     `json:"response_count"`
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
	ID                         uuid.UUID  `json:"id"`
	AccountID                  uuid.UUID  `json:"account_id"`
	TemplateID                 uuid.UUID  `json:"template_id"`
	TemplateRevision           int        `json:"template_revision"`
	ProgramID                  *uuid.UUID `json:"program_id,omitempty"`
	OriginType                 string     `json:"origin_type"`
	OriginLabel                string     `json:"origin_label"`
	Name                       string     `json:"name"`
	Slug                       string     `json:"slug"`
	Status                     string     `json:"status"`
	AudienceMode               string     `json:"audience_mode"`
	OpensAt                    *time.Time `json:"opens_at,omitempty"`
	ClosesAt                   *time.Time `json:"closes_at,omitempty"`
	LegacyInstance             bool       `json:"legacy_instance"`
	MeasurementSignature       string     `json:"measurement_signature,omitempty"`
	AnalyticsTrackingStartedAt time.Time  `json:"analytics_tracking_started_at"`
	QuestionCount              int        `json:"question_count"`
	RecipientCount             int        `json:"recipient_count"`
	ResponseCount              int        `json:"response_count"`
	CreatedAt                  time.Time  `json:"created_at"`
	UpdatedAt                  time.Time  `json:"updated_at"`
}

type SurveyInstanceNameSuggestion struct {
	Available     bool   `json:"available"`
	SuggestedName string `json:"suggested_name"`
}

type SurveySessionPhase string

const (
	SurveySessionOpened   SurveySessionPhase = "opened"
	SurveySessionStarted  SurveySessionPhase = "started"
	SurveySessionReached  SurveySessionPhase = "reached"
	SurveySessionAnswered SurveySessionPhase = "answered"
)

type SurveySessionEvent struct {
	SurveyID        uuid.UUID
	AccountID       uuid.UUID
	RecipientID     *uuid.UUID
	RespondentToken uuid.UUID
	Source          string
	Phase           SurveySessionPhase
	QuestionID      *uuid.UUID
}

type SurveyMeasurementQuestionInput struct {
	QuestionID  uuid.UUID                  `json:"question_id"`
	Measurement *SurveyQuestionMeasurement `json:"measurement"`
}

type SurveyMeasurementMutation struct {
	Dimensions []SurveyMeasurementDimension     `json:"dimensions"`
	Questions  []SurveyMeasurementQuestionInput `json:"questions"`
}

type SurveyMeasurementApplicationPoint struct {
	SurveyID      uuid.UUID                         `json:"survey_id"`
	Name          string                            `json:"name"`
	CreatedAt     time.Time                         `json:"created_at"`
	ResponseCount int                               `json:"response_count"`
	Dimensions    []SurveyMeasurementDimensionStats `json:"dimensions"`
}

type SurveyParticipantMeasurementPoint struct {
	ProgramParticipantID uuid.UUID          `json:"program_participant_id"`
	ContactName          string             `json:"contact_name"`
	SurveyID             uuid.UUID          `json:"survey_id"`
	SurveyName           string             `json:"survey_name"`
	CreatedAt            time.Time          `json:"created_at"`
	Scores               map[string]float64 `json:"scores"`
}

type SurveyPairedMeasurementChange struct {
	DimensionKey string   `json:"dimension_key"`
	SampleSize   int      `json:"sample_size"`
	Baseline     *float64 `json:"baseline,omitempty"`
	Followup     *float64 `json:"followup,omitempty"`
	Delta        *float64 `json:"delta,omitempty"`
}

type SurveyMeasurementSeries struct {
	TemplateID           uuid.UUID                           `json:"template_id"`
	ProgramID            uuid.UUID                           `json:"program_id"`
	Signature            string                              `json:"signature"`
	ExcludedApplications int                                 `json:"excluded_applications"`
	Applications         []SurveyMeasurementApplicationPoint `json:"applications"`
	Participants         []SurveyParticipantMeasurementPoint `json:"participants"`
	PairedChanges        []SurveyPairedMeasurementChange     `json:"paired_changes"`
}

type CreateSurveyInstanceInput struct {
	TemplateID           uuid.UUID
	AccountID            uuid.UUID
	ProgramID            *uuid.UUID
	Name                 string
	Slug                 string
	Status               string
	AudienceMode         string
	OpensAt              *time.Time
	ClosesAt             *time.Time
	CreatedBy            *uuid.UUID
	MeasurementConfig    SurveyMeasurementConfig
	MeasurementSignature string
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
