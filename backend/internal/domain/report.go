package domain

import (
	"time"

	"github.com/google/uuid"
)

const (
	ReportCoverageActiveManagement = "active_management"
	ReportCoverageHistoricalOnly   = "historical_only"
	ReportCoverageContactOnly      = "contact_only"
	ReportCoverageNotRegistered    = "not_registered"
	ReportCoverageUnidentifiable   = "unidentifiable"
	ReportCoverageAmbiguous        = "ambiguous"
)

type WhatsAppGroupOption struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	ParticipantCount int    `json:"participant_count"`
	Kind             string `json:"kind"`
	Suspended        bool   `json:"suspended"`
}

type WhatsAppGroupReportIdentity struct {
	Ordinal       int     `json:"-"`
	WhatsAppName  string  `json:"whatsapp_name"`
	Phone         *string `json:"phone"`
	RedactedPhone *string `json:"redacted_phone"`
	PhoneJID      string  `json:"-"`
	LID           string  `json:"-"`
	Role          string  `json:"role"`
	IsSelf        bool    `json:"is_self"`
}

type WhatsAppGroupSnapshot struct {
	ID               string                        `json:"id"`
	Name             string                        `json:"name"`
	ParticipantCount int                           `json:"participant_count"`
	Kind             string                        `json:"kind"`
	Suspended        bool                          `json:"suspended"`
	Members          []WhatsAppGroupReportIdentity `json:"-"`
}

type WhatsAppReportTag struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Color string    `json:"color"`
}

type WhatsAppReportLead struct {
	ID             uuid.UUID `json:"id"`
	Title          string    `json:"title"`
	PipelineName   string    `json:"pipeline_name"`
	StageName      string    `json:"stage_name"`
	StageColor     string    `json:"stage_color"`
	AssignedToName string    `json:"assigned_to_name"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type WhatsAppReportContact struct {
	ID                   uuid.UUID            `json:"id"`
	DisplayName          string               `json:"display_name"`
	Source               string               `json:"source"`
	DoNotContact         bool                 `json:"do_not_contact"`
	LastDirectActivityAt *time.Time           `json:"last_direct_activity_at"`
	Tags                 []WhatsAppReportTag  `json:"tags"`
	ActiveLeads          []WhatsAppReportLead `json:"active_leads"`
	HistoricalLeadCount  int                  `json:"historical_lead_count"`
}

type WhatsAppGroupCoverageMember struct {
	WhatsAppName        string                 `json:"whatsapp_name"`
	Phone               *string                `json:"phone"`
	RedactedPhone       *string                `json:"redacted_phone"`
	Role                string                 `json:"role"`
	IsSelf              bool                   `json:"is_self"`
	ExistsInClarin      *bool                  `json:"exists_in_clarin"`
	CoverageStatus      string                 `json:"coverage_status"`
	MatchedContactCount int                    `json:"matched_contact_count"`
	Contact             *WhatsAppReportContact `json:"contact,omitempty"`
}

type WhatsAppGroupCoverageSummary struct {
	TotalGroupMembers           int      `json:"total_group_members"`
	EvaluatedMembers            int      `json:"evaluated_members"`
	EligibleMembers             int      `json:"eligible_members"`
	RegisteredMembers           int      `json:"registered_members"`
	ActiveManagementMembers     int      `json:"active_management_members"`
	HistoricalOnlyMembers       int      `json:"historical_only_members"`
	ContactOnlyMembers          int      `json:"contact_only_members"`
	NotRegisteredMembers        int      `json:"not_registered_members"`
	UnidentifiableMembers       int      `json:"unidentifiable_members"`
	AmbiguousMembers            int      `json:"ambiguous_members"`
	DoNotContactMembers         int      `json:"do_not_contact_members"`
	RegistrationCoveragePercent *float64 `json:"registration_coverage_percent"`
	ManagementCoveragePercent   *float64 `json:"management_coverage_percent"`
}

type WhatsAppGroupCoverageReport struct {
	GeneratedAt time.Time `json:"generated_at"`
	Device      struct {
		ID    uuid.UUID `json:"id"`
		Name  string    `json:"name"`
		Phone string    `json:"phone"`
	} `json:"device"`
	Group struct {
		ID               string `json:"id"`
		Name             string `json:"name"`
		ParticipantCount int    `json:"participant_count"`
		Kind             string `json:"kind"`
		Suspended        bool   `json:"suspended"`
	} `json:"group"`
	Summary WhatsAppGroupCoverageSummary  `json:"summary"`
	Members []WhatsAppGroupCoverageMember `json:"members"`
}
