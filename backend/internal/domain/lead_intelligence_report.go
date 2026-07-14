package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

const (
	LeadIntelligenceReportType = "lead_intelligence"

	LeadIntelligenceRunQueued                = "queued"
	LeadIntelligenceRunRunning               = "running"
	LeadIntelligenceRunCompleted             = "completed"
	LeadIntelligenceRunCompletedWithWarnings = "completed_with_warnings"
	LeadIntelligenceRunFailed                = "failed"
	LeadIntelligenceRunCancelled             = "cancelled"
)

type LeadIntelligenceReportRun struct {
	ID                   uuid.UUID       `json:"id"`
	AccountID            uuid.UUID       `json:"-"`
	UserID               uuid.UUID       `json:"-"`
	ReportType           string          `json:"report_type"`
	Parameters           json.RawMessage `json:"parameters,omitempty"`
	Status               string          `json:"status"`
	Phase                string          `json:"phase"`
	SelectedReasoning    string          `json:"selected_reasoning"`
	RecommendedReasoning string          `json:"recommended_reasoning"`
	TotalItems           int             `json:"total_items"`
	ProcessedItems       int             `json:"processed_items"`
	AICandidateCount     int             `json:"ai_candidate_count"`
	AIProcessedCount     int             `json:"ai_processed_count"`
	Warnings             json.RawMessage `json:"warnings,omitempty"`
	Summary              json.RawMessage `json:"summary,omitempty"`
	IdempotencyKey       uuid.UUID       `json:"-"`
	CancelRequested      bool            `json:"cancel_requested"`
	ErrorCode            string          `json:"error_code,omitempty"`
	SafeError            string          `json:"safe_error,omitempty"`
	AttemptCount         int             `json:"attempt_count"`
	HeartbeatAt          *time.Time      `json:"-"`
	CreatedAt            time.Time       `json:"created_at"`
	StartedAt            *time.Time      `json:"started_at,omitempty"`
	CompletedAt          *time.Time      `json:"completed_at,omitempty"`
	ExpiresAt            time.Time       `json:"expires_at"`
	UpdatedAt            time.Time       `json:"updated_at"`
}

type LeadIntelligenceReportItem struct {
	RunID      uuid.UUID       `json:"-"`
	AccountID  uuid.UUID       `json:"-"`
	LeadID     uuid.UUID       `json:"lead_id"`
	Position   int             `json:"position"`
	AIAnalyzed bool            `json:"ai_analyzed"`
	RowData    json.RawMessage `json:"row_data"`
}
