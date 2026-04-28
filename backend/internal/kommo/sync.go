package kommo

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/ws"
)

// --- Kommo Call Custom Field IDs ---
// Each call slot has 3 fields: Responsable (text), Fecha (date_time), Resultado (textarea).
// There are 10 slots total. Slot indexes are 0-based in the arrays below.

// KommoCallSlotCount is the number of call slots in Kommo.
const KommoCallSlotCount = 10

// KommoCallFieldResponsable holds the field_id for "Responsable" in each call slot (1-10).
var KommoCallFieldResponsable = [KommoCallSlotCount]int{
	1405896, 1405898, 1405900, 1405902, 1405904,
	1405906, 1405908, 1405910, 1405912, 1405914,
}

// KommoCallFieldFecha holds the field_id for "Fecha" in each call slot (1-10).
var KommoCallFieldFecha = [KommoCallSlotCount]int{
	1405890, 1405892, 1405918, 1405920, 1405922,
	1405928, 1405930, 1405932, 1405934, 1405936,
}

// KommoCallFieldResultado holds the field_id for "Resultado" in each call slot (1-10).
var KommoCallFieldResultado = [KommoCallSlotCount]int{
	1405888, 1405894, 1405938, 1405940, 1405942,
	1405944, 1405946, 1405948, 1405950, 1405952,
}

// KommoCallFieldOtrasLlamadas is the field_id for "Otras llamadas" (overflow, textarea).
const KommoCallFieldOtrasLlamadas = 1405916

const (
	KommoContactFieldAge       = 1404526
	KommoContactFieldDNI       = 1408795
	KommoContactFieldBirthDate = 1408797
	KommoContactFieldPosition  = 1109264
)

// SyncResult holds the results of a sync operation.
type SyncResult struct {
	Pipelines int       `json:"pipelines"`
	Stages    int       `json:"stages"`
	Tags      int       `json:"tags"`
	Leads     int       `json:"leads"`
	Contacts  int       `json:"contacts"`
	Errors    []string  `json:"errors,omitempty"`
	Duration  string    `json:"duration"`
	SyncedAt  time.Time `json:"synced_at"`
}

// ConnectedPipeline represents a Kommo pipeline connected for real-time sync.
type ConnectedPipeline struct {
	ID              uuid.UUID  `json:"id"`
	AccountID       uuid.UUID  `json:"account_id"`
	KommoPipelineID int64      `json:"kommo_pipeline_id"`
	PipelineID      *uuid.UUID `json:"pipeline_id,omitempty"`
	PipelineName    string     `json:"pipeline_name,omitempty"`
	Enabled         bool       `json:"enabled"`
	LastSyncedAt    *time.Time `json:"last_synced_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
}

// SyncTask represents a unit of work for the sync queue.
type SyncTask struct {
	AccountID       uuid.UUID
	KommoPipelineID int
	UpdatedSince    int64 // unix timestamp; 0 = full sync
}

// WorkerStatus reports the real-time status of the background sync worker.
// SyncMonitorEntry represents a single log entry in the sync monitor.
type SyncMonitorEntry struct {
	ID                    int64                  `json:"id"`
	IntegrationInstanceID *uuid.UUID             `json:"integration_instance_id,omitempty"`
	AccountID             string                 `json:"account_id,omitempty"`
	AccountName           string                 `json:"account_name,omitempty"`
	AccountSlug           string                 `json:"account_slug,omitempty"`
	Time                  time.Time              `json:"time"`
	Source                string                 `json:"source"` // "webhook", "events_poller", "push", "reconcile"
	Message               string                 `json:"message"`
	Level                 string                 `json:"level"` // "info", "error"
	EntityType            string                 `json:"entity_type,omitempty"`
	EntityID              string                 `json:"entity_id,omitempty"`
	KommoEntityID         int64                  `json:"kommo_entity_id,omitempty"`
	Operation             string                 `json:"operation,omitempty"`
	Status                string                 `json:"status,omitempty"`
	Direction             string                 `json:"direction,omitempty"`
	DurationMS            int64                  `json:"duration_ms,omitempty"`
	RequestCount          int                    `json:"request_count,omitempty"`
	BatchSize             int                    `json:"batch_size,omitempty"`
	Details               map[string]interface{} `json:"details,omitempty"`
}

type SyncMonitorEvent struct {
	Source        string
	Message       string
	Level         string
	AccountID     *uuid.UUID
	EntityType    string
	EntityID      *uuid.UUID
	KommoEntityID int64
	Operation     string
	Status        string
	Direction     string
	DurationMS    int64
	RequestCount  int
	BatchSize     int
	Details       map[string]interface{}
}

// SyncMonitor tracks real-time sync activity persisted in PostgreSQL (24h retention).
type SyncMonitor struct {
	db         *pgxpool.Pool
	instanceID *uuid.UUID
	stopCh     chan struct{}
}

func NewSyncMonitor(db *pgxpool.Pool) *SyncMonitor {
	return NewSyncMonitorForInstance(db, nil)
}

func NewSyncMonitorForInstance(db *pgxpool.Pool, instanceID *uuid.UUID) *SyncMonitor {
	m := &SyncMonitor{db: db, instanceID: instanceID, stopCh: make(chan struct{})}
	go m.cleanupLoop()
	return m
}

// Stop signals the cleanup goroutine to exit.
func (m *SyncMonitor) Stop() {
	close(m.stopCh)
}

// Log inserts a sync monitor entry into the database.
func (m *SyncMonitor) Log(source, message, level string) {
	m.LogEvent(SyncMonitorEvent{Source: source, Message: message, Level: level})
}

func (m *SyncMonitor) LogEvent(event SyncMonitorEvent) {
	if event.Level == "" {
		event.Level = "info"
	}
	if event.Status == "" {
		if event.Level == "error" {
			event.Status = "error"
		} else {
			event.Status = "ok"
		}
	}
	details := []byte(`{}`)
	if event.Details != nil {
		if data, err := json.Marshal(event.Details); err == nil {
			details = data
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := m.db.Exec(ctx,
		`INSERT INTO sync_monitor_entries (
			integration_instance_id, account_id, source, message, level, entity_type, entity_id,
			kommo_entity_id, operation, status, direction, duration_ms, request_count, batch_size, details
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
		m.instanceID, event.AccountID, event.Source, event.Message, event.Level, event.EntityType, event.EntityID,
		nullableInt64(event.KommoEntityID), event.Operation, event.Status, event.Direction, event.DurationMS, event.RequestCount, event.BatchSize, details,
	)
	if err != nil {
		log.Printf("[SyncMonitor] Failed to insert entry: %v", err)
	}
}

func nullableInt64(value int64) interface{} {
	if value == 0 {
		return nil
	}
	return value
}

// cleanupLoop deletes entries older than 24 hours every hour.
func (m *SyncMonitor) cleanupLoop() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-m.stopCh:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			result, err := m.db.Exec(ctx, `DELETE FROM sync_monitor_entries WHERE created_at < NOW() - INTERVAL '24 hours'`)
			if err != nil {
				log.Printf("[SyncMonitor] Cleanup error: %v", err)
			} else if result.RowsAffected() > 0 {
				log.Printf("[SyncMonitor] Cleaned up %d old entries", result.RowsAffected())
			}
			cancel()
		}
	}
}

// GetData returns the monitor data for the API (last 24h entries + per-subsystem stats).
func (m *SyncMonitor) GetData() map[string]interface{} {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Fetch last 200 entries (newest first)
	where := `sme.created_at > NOW() - INTERVAL '24 hours'`
	args := []interface{}{}
	if m.instanceID != nil {
		where += ` AND sme.integration_instance_id = $1`
		args = append(args, *m.instanceID)
	}
	rows, err := m.db.Query(ctx,
		`SELECT sme.id, sme.integration_instance_id, COALESCE(sme.account_id::text, ''), COALESCE(a.name, ''), COALESCE(a.slug, ''),
		        sme.source, sme.message, sme.level, sme.created_at, sme.entity_type, COALESCE(sme.entity_id::text, ''),
		        COALESCE(sme.kommo_entity_id, 0), sme.operation, sme.status, sme.direction, sme.duration_ms,
		        sme.request_count, sme.batch_size, sme.details
		 FROM sync_monitor_entries sme
		 LEFT JOIN accounts a ON a.id = sme.account_id
		 WHERE `+where+`
		 ORDER BY sme.created_at DESC LIMIT 200`, args...)
	if err != nil {
		log.Printf("[SyncMonitor] GetData query error: %v", err)
		return map[string]interface{}{"entries": []SyncMonitorEntry{}, "stats": map[string]interface{}{}}
	}
	defer rows.Close()

	var entries []SyncMonitorEntry
	for rows.Next() {
		var e SyncMonitorEntry
		var detailsRaw []byte
		if err := rows.Scan(&e.ID, &e.IntegrationInstanceID, &e.AccountID, &e.AccountName, &e.AccountSlug, &e.Source, &e.Message, &e.Level, &e.Time,
			&e.EntityType, &e.EntityID, &e.KommoEntityID, &e.Operation, &e.Status, &e.Direction, &e.DurationMS, &e.RequestCount, &e.BatchSize, &detailsRaw); err != nil {
			continue
		}
		if len(detailsRaw) > 0 && string(detailsRaw) != "{}" {
			_ = json.Unmarshal(detailsRaw, &e.Details)
		}
		entries = append(entries, e)
	}
	if entries == nil {
		entries = []SyncMonitorEntry{}
	}

	// Per-subsystem aggregate stats from the last 24h
	type subsystemStat struct {
		Count   int64   `json:"count"`
		LastAt  *string `json:"last_at"`
		LastMsg string  `json:"last_msg"`
	}
	stats := map[string]*subsystemStat{
		"webhook": {}, "events_poller": {},
		"push": {}, "reconcile": {},
	}

	statQuery := `
		SELECT source, COUNT(*),
		       MAX(created_at),
		       (SELECT message FROM sync_monitor_entries e2 WHERE e2.source = e1.source AND e2.created_at > NOW() - INTERVAL '24 hours'`
	if m.instanceID != nil {
		statQuery += ` AND e2.integration_instance_id = $1`
	}
	statQuery += ` ORDER BY e2.created_at DESC LIMIT 1)
		FROM sync_monitor_entries e1
		WHERE created_at > NOW() - INTERVAL '24 hours'`
	if m.instanceID != nil {
		statQuery += ` AND integration_instance_id = $1`
	}
	statQuery += `
		GROUP BY source
	`
	statRows, err := m.db.Query(ctx, statQuery, args...)
	if err == nil {
		defer statRows.Close()
		for statRows.Next() {
			var source string
			var count int64
			var lastAt time.Time
			var lastMsg *string
			if err := statRows.Scan(&source, &count, &lastAt, &lastMsg); err != nil {
				continue
			}
			if s, ok := stats[source]; ok {
				s.Count = count
				t := lastAt.Format(time.RFC3339)
				s.LastAt = &t
				if lastMsg != nil {
					s.LastMsg = *lastMsg
				}
			}
		}
	}

	return map[string]interface{}{
		"entries": entries,
		"stats":   stats,
	}
}

type WorkerStatus struct {
	Running            bool       `json:"running"`
	ActiveAccounts     int        `json:"active_accounts"` // accounts being synced right now
	LastCheck          *time.Time `json:"last_check,omitempty"`
	LastSyncedPipeline string     `json:"last_synced_pipeline,omitempty"`
	ConnectedCount     int        `json:"connected_count"`
}

// FullSyncStatus tracks the progress of a background full sync.
type FullSyncStatus struct {
	Running   bool        `json:"running"`
	Progress  string      `json:"progress"`
	Result    *SyncResult `json:"result,omitempty"`
	Error     string      `json:"error,omitempty"`
	StartedAt time.Time   `json:"started_at"`
	DoneAt    *time.Time  `json:"done_at,omitempty"`
}

// SyncService handles one-way sync from Kommo → Clarin.
type SyncService struct {
	InstanceID   *uuid.UUID
	InstanceName string
	client       *Client
	db           *pgxpool.Pool
	hub          *ws.Hub
	stopCh       chan struct{}
	wg           sync.WaitGroup // tracks active per-account sync goroutines
	mu           sync.RWMutex
	status       WorkerStatus
	running      bool
	fullSyncMu   sync.RWMutex
	fullSync     map[uuid.UUID]*FullSyncStatus
	// Per-account busy tracking: prevents concurrent syncs for the same account.
	busyAccounts map[uuid.UUID]bool
	busyMu       sync.Mutex
	// Cache of unsorted lead IDs that failed to sync (no phone on contact).
	// Prevents wasting API calls every cycle on leads that can never sync.
	unsortedSkipCache   map[int]int64 // kommo lead ID → timestamp when cached
	unsortedSkipCacheMu sync.Mutex
	// OnLeadTagsChanged is called after lead tags are synced for an account.
	// Used to trigger event participant reconciliation without tight coupling.
	OnLeadTagsChanged func(ctx context.Context, accountID uuid.UUID)
	// WebhookSecret is the secret used to validate incoming webhook requests.
	// Set from KOMMO_WEBHOOK_SECRET env var. If empty, webhooks are disabled.
	WebhookSecret string
	// PublicURL is the public base URL of the Clarin backend (e.g., https://clarin.naperu.cloud).
	// Used for webhook auto-registration with Kommo.
	PublicURL string
	// Events poller state: tracks the last poll timestamp and stats for the Events API poller.
	eventsPollerMu      sync.Mutex
	lastEventPoll       int64     // Unix timestamp of the last successful events poll cursor
	lastEventPollAt     time.Time // Wall clock time of the last poll completion
	lastEventPollEvents int       // Number of events found in the last poll
	lastEventPollLeads  int       // Number of leads synced in the last poll
	// Sync monitor: ring buffer + stats for the monitor panel.
	Monitor *SyncMonitor
	// Outbox: batched push worker. Nil when disabled. Handlers enqueue via
	// EnqueuePush* helpers which coalesce by (entity, operation) and let the
	// worker flush in bulk PATCH /leads / PATCH /contacts calls.
	Outbox *Outbox
}

// NewSyncService creates a new sync service with per-account parallel workers.
func NewSyncService(client *Client, db *pgxpool.Pool, hub *ws.Hub) *SyncService {
	return NewSyncServiceForInstance(client, db, hub, nil, "")
}

func NewSyncServiceForInstance(client *Client, db *pgxpool.Pool, hub *ws.Hub, instanceID *uuid.UUID, instanceName string) *SyncService {
	return &SyncService{
		InstanceID:        instanceID,
		InstanceName:      instanceName,
		client:            client,
		db:                db,
		hub:               hub,
		stopCh:            make(chan struct{}),
		fullSync:          make(map[uuid.UUID]*FullSyncStatus),
		unsortedSkipCache: make(map[int]int64),
		busyAccounts:      make(map[uuid.UUID]bool),
		lastEventPoll:     time.Now().Unix() - 60, // Start looking 60s back
		Monitor:           NewSyncMonitorForInstance(db, instanceID),
	}
}

type syncAccount struct {
	ID   uuid.UUID
	Name string
	Slug string
}

func (s *SyncService) instanceArg() interface{} {
	if s.InstanceID == nil {
		return nil
	}
	return *s.InstanceID
}

func (s *SyncService) assignedAccounts(ctx context.Context) ([]syncAccount, error) {
	if s.InstanceID == nil {
		rows, err := s.db.Query(ctx, `SELECT id, name, COALESCE(slug, '') FROM accounts WHERE kommo_enabled = TRUE`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		accounts := []syncAccount{}
		for rows.Next() {
			var account syncAccount
			if err := rows.Scan(&account.ID, &account.Name, &account.Slug); err == nil {
				accounts = append(accounts, account)
			}
		}
		return accounts, rows.Err()
	}

	rows, err := s.db.Query(ctx, `
		SELECT a.id, a.name, COALESCE(a.slug, '')
		FROM integration_instance_accounts ia
		JOIN accounts a ON a.id = ia.account_id
		WHERE ia.integration_instance_id = $1 AND ia.enabled = TRUE AND COALESCE(a.is_active, TRUE) = TRUE
		ORDER BY a.name ASC
	`, *s.InstanceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accounts := []syncAccount{}
	for rows.Next() {
		var account syncAccount
		if err := rows.Scan(&account.ID, &account.Name, &account.Slug); err == nil {
			accounts = append(accounts, account)
		}
	}
	return accounts, rows.Err()
}

func (s *SyncService) upsertConnectedPipeline(ctx context.Context, accountID uuid.UUID, kommoPipelineID int64, pipelineID uuid.UUID, enabled bool) error {
	result, err := s.db.Exec(ctx, `
		UPDATE kommo_connected_pipelines
		SET pipeline_id = $3, enabled = $4, integration_instance_id = $5
		WHERE account_id = $1 AND kommo_pipeline_id = $2 AND integration_instance_id IS NOT DISTINCT FROM $5
	`, accountID, kommoPipelineID, pipelineID, enabled, s.instanceArg())
	if err != nil {
		return err
	}
	if result.RowsAffected() > 0 {
		return nil
	}
	_, err = s.db.Exec(ctx, `
		INSERT INTO kommo_connected_pipelines (id, integration_instance_id, account_id, kommo_pipeline_id, pipeline_id, enabled)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, uuid.New(), s.instanceArg(), accountID, kommoPipelineID, pipelineID, enabled)
	return err
}

// GetClient returns the Kommo API client for direct operations.
func (s *SyncService) GetClient() *Client {
	return s.client
}

// StartFullSyncAsync starts a full sync in the background for the given account.
// Returns false if a sync is already running for this account.
func (s *SyncService) StartFullSyncAsync(accountID uuid.UUID) bool {
	s.fullSyncMu.Lock()
	if st, ok := s.fullSync[accountID]; ok && st.Running {
		s.fullSyncMu.Unlock()
		return false
	}
	s.fullSync[accountID] = &FullSyncStatus{
		Running:   true,
		Progress:  "Iniciando sincronización...",
		StartedAt: time.Now(),
	}
	s.fullSyncMu.Unlock()

	go func() {
		ctx := context.Background()

		// Update progress helper
		setProgress := func(msg string) {
			s.fullSyncMu.Lock()
			if st, ok := s.fullSync[accountID]; ok {
				st.Progress = msg
			}
			s.fullSyncMu.Unlock()
		}

		setProgress("Sincronizando pipelines y etapas...")
		result, err := s.SyncAll(ctx, accountID)

		if err != nil {
			now := time.Now()
			s.fullSyncMu.Lock()
			if st, ok := s.fullSync[accountID]; ok {
				st.Running = false
				st.DoneAt = &now
				st.Error = err.Error()
			}
			s.fullSyncMu.Unlock()
			log.Printf("[Kommo Sync] Background full sync failed for %s: %v", accountID, err)
			return
		}

		// Run full reconciliation (stale + reverse) without batch limits
		setProgress("Reconciliando leads (stale + faltantes)...")
		log.Printf("[Kommo Sync] Running full reconciliation (unlimited) for %s", accountID)
		s.reconcileAccount(ctx, accountID, true)

		now := time.Now()
		s.fullSyncMu.Lock()
		if st, ok := s.fullSync[accountID]; ok {
			st.Running = false
			st.DoneAt = &now
			st.Result = result
			st.Progress = "Completado"
		}
		s.fullSyncMu.Unlock()
		log.Printf("[Kommo Sync] Background full sync completed for %s in %s", accountID, result.Duration)
	}()
	return true
}

// GetFullSyncStatus returns the current status of a full sync for the given account.
func (s *SyncService) GetFullSyncStatus(accountID uuid.UUID) *FullSyncStatus {
	s.fullSyncMu.RLock()
	defer s.fullSyncMu.RUnlock()
	if st, ok := s.fullSync[accountID]; ok {
		copy := *st
		return &copy
	}
	return nil
}

// Start begins the background sync worker.
// If a webhook secret is configured, it registers the webhook with Kommo on startup.
// Polling is replaced by webhooks — only reconciliation runs periodically.
func (s *SyncService) Start() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.status.Running = true
	s.mu.Unlock()

	// Espejo total: auto-connect ALL Kommo pipelines to ALL accounts on startup
	go func() {
		time.Sleep(3 * time.Second) // Let DB connections settle
		s.syncAllKommoPipelines()

		// After pipelines are synced, register webhook
		if s.WebhookSecret != "" {
			s.autoRegisterWebhook()
		} else {
			log.Println("[Kommo Sync] KOMMO_WEBHOOK_SECRET not set — webhook auto-registration disabled")
		}

		// Events API poller: catches ALL changes including UI tag edits that webhooks miss
		go s.eventsPoller()
	}()

	// Reconciliation: periodic full check of all synced pipelines against Kommo
	go s.reconcileLoop()

	// Outbox flush worker (batched pushes). Nil if disabled.
	if s.Outbox != nil {
		s.Outbox.Start()
	}

	log.Println("[Kommo Sync] Background reconciliation started (1h interval)")
}

// Stop gracefully shuts down the sync worker.
func (s *SyncService) Stop() {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	s.running = false
	s.mu.Unlock()
	close(s.stopCh)
	s.wg.Wait() // wait for all per-account sync goroutines to finish
	if s.Outbox != nil {
		s.Outbox.Stop()
	}
	s.Monitor.Stop()
	log.Println("[Kommo Sync] Background worker stopped")
}

// isKommoEnabled checks if an account has Kommo integration enabled.
func (s *SyncService) isKommoEnabled(ctx context.Context, accountID uuid.UUID) bool {
	if s.InstanceID != nil {
		var enabled bool
		err := s.db.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM integration_instance_accounts
				WHERE integration_instance_id = $1 AND account_id = $2 AND enabled = TRUE
			)
		`, *s.InstanceID, accountID).Scan(&enabled)
		return err == nil && enabled
	}
	var enabled bool
	err := s.db.QueryRow(ctx, `SELECT COALESCE(kommo_enabled, false) FROM accounts WHERE id = $1`, accountID).Scan(&enabled)
	return err == nil && enabled
}

// ProcessWebhookLead fetches a lead from Kommo and syncs it to ALL accounts
// that have Kommo integration enabled (espejo model: all accounts see all Kommo data).
func (s *SyncService) ProcessWebhookLead(ctx context.Context, kommoLeadID int) {
	start := time.Now()
	// Fetch the full lead from Kommo API
	kl, err := s.client.GetLeadByID(kommoLeadID)
	if err != nil {
		log.Printf("[WEBHOOK] Failed to fetch lead %d from Kommo: %v", kommoLeadID, err)
		s.Monitor.LogEvent(SyncMonitorEvent{
			Source:        "webhook",
			Message:       fmt.Sprintf("Error fetching lead %d: %v", kommoLeadID, err),
			Level:         "error",
			EntityType:    "lead",
			KommoEntityID: int64(kommoLeadID),
			Operation:     "fetch_lead",
			Direction:     "inbound",
			DurationMS:    time.Since(start).Milliseconds(),
			RequestCount:  1,
			Details:       map[string]interface{}{"error": err.Error()},
		})
		return
	}

	// Espejo total within this Kommo instance: all explicitly assigned accounts.
	accounts, err := s.assignedAccounts(ctx)
	if err != nil {
		log.Printf("[WEBHOOK] Failed to query accounts: %v", err)
		return
	}
	if len(accounts) == 0 {
		s.Monitor.LogEvent(SyncMonitorEvent{
			Source:        "webhook",
			Message:       fmt.Sprintf("Lead %d recibido sin cuentas asignadas", kommoLeadID),
			EntityType:    "lead",
			KommoEntityID: int64(kommoLeadID),
			Operation:     "sync_lead",
			Status:        "skipped",
			Direction:     "inbound",
			DurationMS:    time.Since(start).Milliseconds(),
			RequestCount:  1,
		})
		return
	}

	// Ensure the lead's pipeline exists for each account (auto-create if Kommo added a new pipeline)
	pipelineKommoID := int64(kl.PipelineID)
	for _, account := range accounts {
		var exists bool
		_ = s.db.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM kommo_connected_pipelines WHERE account_id = $1 AND kommo_pipeline_id = $2 AND enabled = TRUE AND integration_instance_id IS NOT DISTINCT FROM $3)
		`, account.ID, pipelineKommoID, s.instanceArg()).Scan(&exists)
		if !exists {
			// Pipeline not connected yet for this account — auto-create it
			kp := KommoPipeline{ID: kl.PipelineID, Name: fmt.Sprintf("Pipeline_%d", kl.PipelineID)}
			// Try to get full pipeline info (name + stages) from Kommo
			if pipelines, err := s.client.GetPipelines(); err == nil {
				for _, p := range pipelines {
					if p.ID == kl.PipelineID {
						kp = p
						break
					}
				}
			}
			pid, _ := s.ensurePipelineForAccount(ctx, account.ID, kp)
			if pid != nil {
				_ = s.upsertConnectedPipeline(ctx, account.ID, pipelineKommoID, *pid, true)
				log.Printf("[WEBHOOK] Auto-connected pipeline %d for account %s", kl.PipelineID, account.ID)
			}
		}
	}

	// Sync to each account
	changedAccounts := 0
	affectedAccounts := make([]map[string]string, 0, len(accounts))
	for _, account := range accounts {
		changed, err := s.upsertLead(ctx, account.ID, *kl, nil)
		if err != nil {
			log.Printf("[WEBHOOK] Lead %d → account %s error: %v", kommoLeadID, account.ID, err)
			s.Monitor.LogEvent(SyncMonitorEvent{
				Source:        "webhook",
				Message:       fmt.Sprintf("Lead %d → %s error: %v", kommoLeadID, account.Name, err),
				Level:         "error",
				AccountID:     &account.ID,
				EntityType:    "lead",
				KommoEntityID: int64(kommoLeadID),
				Operation:     "sync_lead",
				Direction:     "inbound",
				DurationMS:    time.Since(start).Milliseconds(),
				RequestCount:  1,
				Details:       map[string]interface{}{"account_name": account.Name, "error": err.Error()},
			})
			continue
		}
		if changed {
			changedAccounts++
			affectedAccounts = append(affectedAccounts, map[string]string{"id": account.ID.String(), "name": account.Name, "slug": account.Slug})
			s.Monitor.LogEvent(SyncMonitorEvent{
				Source:        "webhook",
				Message:       fmt.Sprintf("Lead %d actualizado en %s", kommoLeadID, account.Name),
				AccountID:     &account.ID,
				EntityType:    "lead",
				KommoEntityID: int64(kommoLeadID),
				Operation:     "sync_lead",
				Status:        "updated",
				Direction:     "inbound",
				DurationMS:    time.Since(start).Milliseconds(),
				RequestCount:  1,
				Details:       map[string]interface{}{"account_name": account.Name},
			})
			if s.hub != nil {
				s.hub.BroadcastToAccount(account.ID, ws.EventLeadUpdate, map[string]interface{}{"action": "updated"})
			}
		}
	}

	// Trigger event reconciliation for accounts that had changes
	if s.OnLeadTagsChanged != nil && changedAccounts > 0 {
		for _, account := range accounts {
			s.OnLeadTagsChanged(ctx, account.ID)
		}
	}

	if changedAccounts > 0 {
		log.Printf("[WEBHOOK] Lead %d synced to %d/%d accounts", kommoLeadID, changedAccounts, len(accounts))
		s.Monitor.LogEvent(SyncMonitorEvent{
			Source:        "webhook",
			Message:       fmt.Sprintf("Lead %d sincronizado a %d/%d cuentas", kommoLeadID, changedAccounts, len(accounts)),
			EntityType:    "lead",
			KommoEntityID: int64(kommoLeadID),
			Operation:     "sync_lead",
			Status:        "updated",
			Direction:     "inbound",
			DurationMS:    time.Since(start).Milliseconds(),
			RequestCount:  1,
			BatchSize:     len(accounts),
			Details:       map[string]interface{}{"changed_accounts": affectedAccounts, "assigned_accounts": len(accounts)},
		})
	}
}

// autoRegisterWebhook checks if a webhook is already registered with Kommo,
// and registers one if needed. Runs once on startup.
func (s *SyncService) autoRegisterWebhook() {
	if s.WebhookSecret == "" || s.PublicURL == "" {
		log.Println("[WEBHOOK] Cannot auto-register: KOMMO_WEBHOOK_SECRET or PUBLIC_URL not set")
		return
	}

	// Wait a few seconds for the HTTP server to start
	time.Sleep(5 * time.Second)

	webhookURL := fmt.Sprintf("%s/api/kommo/webhook/%s", strings.TrimRight(s.PublicURL, "/"), s.WebhookSecret)

	// Check existing webhooks
	existing, err := s.client.ListWebhooks()
	if err != nil {
		log.Printf("[WEBHOOK] Failed to list existing webhooks: %v", err)
		log.Println("[WEBHOOK] Will retry auto-registration on next restart")
		return
	}

	// Check if our webhook is already registered
	for _, wh := range existing {
		if wh.Destination == webhookURL {
			log.Printf("[WEBHOOK] Already registered (ID %d) → %s", wh.ID, webhookURL)
			return
		}
	}

	// Register new webhook
	events := []string{"update_lead", "add_lead", "status_lead", "delete_lead"}
	if err := s.client.RegisterWebhook(webhookURL, events); err != nil {
		log.Printf("[WEBHOOK] Failed to register webhook: %v", err)
		return
	}

	log.Printf("[WEBHOOK] Successfully registered webhook → %s", webhookURL)
}

// syncAllKommoPipelines implements the "espejo total" model:
// fetches ALL pipelines from Kommo and ensures every account has
// a local copy with stages and a kommo_connected_pipelines record (enabled).
func (s *SyncService) syncAllKommoPipelines() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// 1. Fetch all pipelines from Kommo (single API call)
	kommoPipelines, err := s.client.GetPipelines()
	if err != nil {
		log.Printf("[ESPEJO] Failed to fetch Kommo pipelines: %v", err)
		return
	}

	// 2. Get all accounts assigned to this Kommo instance
	accounts, err := s.assignedAccounts(ctx)
	if err != nil {
		log.Printf("[ESPEJO] Failed to query accounts: %v", err)
		return
	}

	// 3. For each account × each pipeline: ensure pipeline + stages + connection exist
	created := 0
	for _, account := range accounts {
		for _, kp := range kommoPipelines {
			pipelineID, isNew := s.ensurePipelineForAccount(ctx, account.ID, kp)
			if pipelineID == nil {
				continue
			}
			// Ensure kommo_connected_pipelines record
			_ = s.upsertConnectedPipeline(ctx, account.ID, int64(kp.ID), *pipelineID, true)
			if isNew {
				created++
			}
		}
	}

	log.Printf("[ESPEJO] Pipeline sync complete: %d accounts × %d Kommo pipelines, %d new pipelines created",
		len(accounts), len(kommoPipelines), created)
}

// ensurePipelineForAccount creates or updates a local pipeline + stages for the given
// Kommo pipeline data, without making additional API calls. Returns the pipeline UUID
// and whether it was newly created.
func (s *SyncService) ensurePipelineForAccount(ctx context.Context, accountID uuid.UUID, kp KommoPipeline) (*uuid.UUID, bool) {
	kommoID := int64(kp.ID)
	var pipelineID uuid.UUID
	isNew := false

	err := s.db.QueryRow(ctx, `SELECT id FROM pipelines WHERE account_id = $1 AND kommo_id = $2`, accountID, kommoID).Scan(&pipelineID)
	if err != nil {
		// Create new pipeline
		pipelineID = uuid.New()
		isNew = true
		_, err = s.db.Exec(ctx, `
			INSERT INTO pipelines (id, account_id, name, is_default, kommo_id, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
		`, pipelineID, accountID, kp.Name, kp.IsMain, kommoID)
		if err != nil {
			log.Printf("[ESPEJO] Failed to create pipeline %q for account %s: %v", kp.Name, accountID, err)
			return nil, false
		}
	} else {
		// Update name if changed
		_, _ = s.db.Exec(ctx, `UPDATE pipelines SET name = $1, is_default = $2, updated_at = NOW() WHERE id = $3`,
			kp.Name, kp.IsMain, pipelineID)
	}

	// Sync stages
	for i, ks := range kp.Statuses {
		stageKommoID := int64(ks.ID)
		color := kommoColorToHex(ks.Color)
		var existingStageID uuid.UUID
		err := s.db.QueryRow(ctx, `SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND kommo_id = $2`, pipelineID, stageKommoID).Scan(&existingStageID)
		if err != nil {
			_, _ = s.db.Exec(ctx, `
				INSERT INTO pipeline_stages (id, pipeline_id, name, color, position, kommo_id, created_at)
				VALUES ($1, $2, $3, $4, $5, $6, NOW())
			`, uuid.New(), pipelineID, ks.Name, color, i, stageKommoID)
		} else {
			_, _ = s.db.Exec(ctx, `UPDATE pipeline_stages SET name = $1, color = $2, position = $3 WHERE id = $4`,
				ks.Name, color, i, existingStageID)
		}
	}

	return &pipelineID, isNew
}

// GetStatus returns the current worker status.
func (s *SyncService) GetStatus() WorkerStatus {
	s.busyMu.Lock()
	active := len(s.busyAccounts)
	s.busyMu.Unlock()
	s.mu.RLock()
	st := s.status
	s.mu.RUnlock()
	st.ActiveAccounts = active
	return st
}

// spawnAccountSync spawns a goroutine to sync an account if not already running.
// Returns true if spawned, false if a sync for this account is already in progress (skip-if-busy).
func (s *SyncService) spawnAccountSync(accountID uuid.UUID, updatedSince int64) bool {
	s.busyMu.Lock()
	if s.busyAccounts[accountID] {
		s.busyMu.Unlock()
		return false
	}
	s.busyAccounts[accountID] = true
	s.busyMu.Unlock()

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer func() {
			s.busyMu.Lock()
			delete(s.busyAccounts, accountID)
			s.busyMu.Unlock()
		}()

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		count, err := s.syncGlobalLeads(ctx, accountID, updatedSince)
		if err != nil {
			if !strings.Contains(err.Error(), "204") && !strings.Contains(err.Error(), "No content") {
				log.Printf("[Kommo Sync] Account %s sync error: %v", accountID, err)
			}
		} else if count > 0 {
			log.Printf("[Kommo Sync] Account %s: synced %d leads", accountID, count)
		}

		_, _ = s.db.Exec(context.Background(),
			`UPDATE kommo_connected_pipelines SET last_synced_at = NOW() WHERE account_id = $1 AND enabled = TRUE AND integration_instance_id IS NOT DISTINCT FROM $2`,
			accountID, s.instanceArg())

		// Only trigger event reconciliation if leads were actually synced
		// (avoids running expensive reconciliation every 5s when nothing changed)
		if s.OnLeadTagsChanged != nil && count > 0 {
			log.Printf("[Kommo Sync] Triggering event reconciliation for account %s", accountID)
			s.OnLeadTagsChanged(context.Background(), accountID)
		}

		s.mu.Lock()
		now := time.Now()
		s.status.LastCheck = &now
		s.status.LastSyncedPipeline = accountID.String()[:8]
		s.mu.Unlock()
	}()
	return true
}

// poller periodically checks for updates in connected pipelines.
func (s *SyncService) poller() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.pollConnectedPipelines()
		}
	}
}

// pollConnectedPipelines finds all connected pipelines and enqueues sync tasks.
func (s *SyncService) pollConnectedPipelines() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 1. Get distinct accounts that have at least one enabled pipeline in this instance.
	rows, err := s.db.Query(ctx, `SELECT DISTINCT account_id FROM kommo_connected_pipelines WHERE enabled = TRUE AND integration_instance_id IS NOT DISTINCT FROM $1`, s.instanceArg())
	if err != nil {
		log.Printf("[Kommo Sync] Poll error: %v", err)
		return
	}
	defer rows.Close()

	// 2. Collect all account IDs first, then compute a GLOBAL cursor.
	// Since all accounts share the same Kommo API/token, they all see the same leads.
	// Using a per-account cursor based on local MAX(updated_at) is wrong because
	// an account with newer local leads would skip leads that are new TO IT but
	// older in Kommo. The global cursor = MIN across all accounts ensures every
	// account sees every lead that changed since the slowest account's last sync.
	var accountIDs []uuid.UUID
	for rows.Next() {
		var accountID uuid.UUID
		if err := rows.Scan(&accountID); err != nil {
			continue
		}
		accountIDs = append(accountIDs, accountID)
	}
	rows.Close()

	if len(accountIDs) == 0 {
		return
	}

	// Global cursor: the MINIMUM last_synced_at across all enabled pipelines.
	// This guarantees every account gets every lead updated since the slowest sync.
	var globalSince int64
	_ = s.db.QueryRow(ctx, `
		SELECT COALESCE(EXTRACT(EPOCH FROM MIN(last_synced_at))::bigint, 0)
		FROM kommo_connected_pipelines
		WHERE enabled = TRUE AND last_synced_at IS NOT NULL AND integration_instance_id IS NOT DISTINCT FROM $1
	`, s.instanceArg()).Scan(&globalSince)

	if globalSince > 0 {
		// Subtract 5 minutes buffer for safety (API timestamp drift, slow processing)
		globalSince = globalSince - 300
		if globalSince < 0 {
			globalSince = 0
		}
	}

	count := 0
	for _, accountID := range accountIDs {
		s.spawnAccountSync(accountID, globalSince)
		count++
	}

	s.mu.Lock()
	s.status.ConnectedCount = count
	now := time.Now()
	s.status.LastCheck = &now
	s.mu.Unlock()
}

// --- Connected Pipeline Management ---

// GetConnectedPipelines returns all connected pipelines for an account.
func (s *SyncService) GetConnectedPipelines(ctx context.Context, accountID uuid.UUID) ([]ConnectedPipeline, error) {
	rows, err := s.db.Query(ctx, `
		SELECT kcp.id, kcp.account_id, kcp.kommo_pipeline_id, kcp.pipeline_id, kcp.enabled, kcp.last_synced_at, kcp.created_at,
		COALESCE(p.name, '') as pipeline_name
		FROM kommo_connected_pipelines kcp
		LEFT JOIN pipelines p ON kcp.pipeline_id = p.id
		WHERE kcp.account_id = $1 AND kcp.integration_instance_id IS NOT DISTINCT FROM $2
		ORDER BY kcp.created_at
	`, accountID, s.instanceArg())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []ConnectedPipeline
	for rows.Next() {
		var cp ConnectedPipeline
		if err := rows.Scan(&cp.ID, &cp.AccountID, &cp.KommoPipelineID, &cp.PipelineID, &cp.Enabled, &cp.LastSyncedAt, &cp.CreatedAt, &cp.PipelineName); err != nil {
			continue
		}
		result = append(result, cp)
	}
	return result, nil
}

// ConnectPipeline connects a Kommo pipeline for real-time sync.
// Multiple pipelines can be active per account simultaneously.
func (s *SyncService) ConnectPipeline(ctx context.Context, accountID uuid.UUID, kommoPipelineID int) (*ConnectedPipeline, error) {
	// Multiple pipelines can be connected simultaneously — no auto-disconnect

	// Sync this pipeline's metadata (pipeline + stages) from Kommo
	pipelineID, err := s.syncSinglePipeline(ctx, accountID, kommoPipelineID)
	if err != nil {
		return nil, fmt.Errorf("failed to sync pipeline metadata: %w", err)
	}
	if pipelineID == nil {
		return nil, fmt.Errorf("failed to sync pipeline metadata: local pipeline was not created")
	}

	// Sync tags (needed for leads)
	_, _ = s.syncTags(ctx, accountID)

	// Push local tags to Kommo
	_, _ = s.pushMissingTagsToKommo(ctx, accountID)

	// Insert or update the connected pipeline record
	if err := s.upsertConnectedPipeline(ctx, accountID, int64(kommoPipelineID), *pipelineID, true); err != nil {
		return nil, err
	}
	var cp ConnectedPipeline
	err = s.db.QueryRow(ctx, `
		SELECT id, account_id, kommo_pipeline_id, pipeline_id, enabled, last_synced_at, created_at
		FROM kommo_connected_pipelines
		WHERE account_id = $1 AND kommo_pipeline_id = $2 AND integration_instance_id IS NOT DISTINCT FROM $3
		LIMIT 1
	`, accountID, kommoPipelineID, s.instanceArg()).Scan(&cp.ID, &cp.AccountID, &cp.KommoPipelineID, &cp.PipelineID, &cp.Enabled, &cp.LastSyncedAt, &cp.CreatedAt)
	if err != nil {
		return nil, err
	}

	// Launch a full sync for this pipeline in background (bypass queue to avoid drops)
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		count, err := s.syncPipelineLeads(bgCtx, accountID, kommoPipelineID, 0)
		if err != nil {
			log.Printf("[Kommo Sync] Initial sync error for pipeline %d: %v", kommoPipelineID, err)
		} else {
			log.Printf("[Kommo Sync] Initial sync for pipeline %d: synced %d leads", kommoPipelineID, count)
		}
		_, _ = s.db.Exec(context.Background(),
			`UPDATE kommo_connected_pipelines SET last_synced_at = NOW() WHERE account_id = $1 AND kommo_pipeline_id = $2 AND integration_instance_id IS NOT DISTINCT FROM $3`,
			accountID, kommoPipelineID, s.instanceArg())
		if s.hub != nil && count > 0 {
			s.hub.BroadcastToAccount(accountID, ws.EventLeadUpdate, map[string]interface{}{
				"action": "initial_sync",
			})
		}
	}()

	return &cp, nil
}

// DisconnectPipeline disconnects a Kommo pipeline from real-time sync.
func (s *SyncService) DisconnectPipeline(ctx context.Context, accountID uuid.UUID, kommoPipelineID int) error {
	_, err := s.db.Exec(ctx,
		`UPDATE kommo_connected_pipelines SET enabled = FALSE WHERE account_id = $1 AND kommo_pipeline_id = $2 AND integration_instance_id IS NOT DISTINCT FROM $3`,
		accountID, kommoPipelineID, s.instanceArg())
	return err
}

// --- Sync Operations ---

// SyncAll performs a full one-way sync from Kommo into the given Clarin account (all pipelines).
func (s *SyncService) SyncAll(ctx context.Context, accountID uuid.UUID) (*SyncResult, error) {
	start := time.Now()
	result := &SyncResult{}

	// Progress update helper
	setProgress := func(msg string) {
		s.fullSyncMu.Lock()
		if st, ok := s.fullSync[accountID]; ok {
			st.Progress = msg
		}
		s.fullSyncMu.Unlock()
	}

	// Get connected pipelines - only sync those
	connected, err := s.GetConnectedPipelines(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("failed to get connected pipelines: %w", err)
	}

	// Filter to enabled connected pipelines
	var activePipelines []ConnectedPipeline
	for _, cp := range connected {
		if cp.Enabled {
			activePipelines = append(activePipelines, cp)
		}
	}

	// Sync pipeline metadata + stages with a SINGLE API call to Kommo
	setProgress(fmt.Sprintf("Sincronizando %d pipeline(s)...", len(activePipelines)))
	log.Printf("[SYNC] Account %s: syncing %d pipeline metadata...", accountID, len(activePipelines))
	kommoPipelines, err := s.client.GetPipelines()
	if err != nil {
		result.Errors = append(result.Errors, fmt.Sprintf("fetch pipelines: %v", err))
	} else {
		// Build lookup by Kommo ID
		kpMap := make(map[int]KommoPipeline)
		for _, kp := range kommoPipelines {
			kpMap[kp.ID] = kp
		}
		pCount := 0
		for _, cp := range activePipelines {
			if kp, ok := kpMap[int(cp.KommoPipelineID)]; ok {
				_, _ = s.ensurePipelineForAccount(ctx, accountID, kp)
				pCount++
			}
		}
		result.Pipelines = pCount
	}

	// Only sync tags if the account has at least one active pipeline.
	if len(activePipelines) > 0 {
		setProgress("Sincronizando etiquetas...")
		tCount, err := s.syncTags(ctx, accountID)
		if err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("tags: %v", err))
		}
		result.Tags = tCount

		// Push Clarin-only tags to Kommo (bidirectional sync)
		setProgress("Sincronizando etiquetas locales a Kommo...")
		pushedTags, pushErr := s.pushMissingTagsToKommo(ctx, accountID)
		if pushErr != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("push tags: %v", pushErr))
		}
		if pushedTags > 0 {
			log.Printf("[SYNC] Pushed %d local tags to Kommo for account %s", pushedTags, accountID)
		}
	} else {
		log.Printf("[SYNC] Skipping tag sync for account %s — no active pipelines", accountID)
	}

	// Sync leads from connected pipelines with detailed progress logging
	lCount := 0
	for i, cp := range activePipelines {
		pName := fmt.Sprintf("pipeline %d", cp.KommoPipelineID)
		// Try to get pipeline name for better logging
		var pn string
		if s.db.QueryRow(ctx, `SELECT name FROM pipelines WHERE id = $1`, cp.PipelineID).Scan(&pn) == nil && pn != "" {
			pName = pn
		}
		progress := fmt.Sprintf("Sincronizando leads: %s (%d/%d)...", pName, i+1, len(activePipelines))
		setProgress(progress)
		log.Printf("[SYNC] Account %s: %s", accountID, progress)

		count, err := s.syncPipelineLeads(ctx, accountID, int(cp.KommoPipelineID), 0)
		if err != nil {
			log.Printf("[SYNC] Account %s: pipeline %s error: %v", accountID, pName, err)
			result.Errors = append(result.Errors, fmt.Sprintf("leads %s: %v", pName, err))
			continue
		}
		lCount += count
		if count > 0 {
			log.Printf("[SYNC] Account %s: pipeline %s → %d leads synced", accountID, pName, count)
		}
	}
	result.Leads = lCount

	// Count contacts that were synced (those with kommo_id linked to this account)
	var contactCount int
	_ = s.db.QueryRow(ctx, `SELECT COUNT(*) FROM contacts WHERE account_id = $1 AND kommo_id IS NOT NULL`, accountID).Scan(&contactCount)
	result.Contacts = contactCount

	result.Duration = time.Since(start).Round(time.Millisecond).String()
	result.SyncedAt = time.Now()

	log.Printf("[Kommo Sync] Done for account %s: %d pipelines, %d tags, %d contacts, %d leads in %s",
		accountID, result.Pipelines, result.Tags, result.Contacts, result.Leads, result.Duration)

	// Trigger event participant reconciliation after full sync
	if s.OnLeadTagsChanged != nil && result.Leads > 0 {
		log.Printf("[Kommo Sync] Triggering event reconciliation after full sync for account %s", accountID)
		s.OnLeadTagsChanged(ctx, accountID)
	}

	return result, nil
}

// syncSinglePipeline syncs a single Kommo pipeline and its stages, returns the local pipeline UUID.
func (s *SyncService) syncSinglePipeline(ctx context.Context, accountID uuid.UUID, kommoPipelineID int) (*uuid.UUID, error) {
	kommoPipelines, err := s.client.GetPipelines()
	if err != nil {
		return nil, err
	}

	for _, kp := range kommoPipelines {
		if kp.ID != kommoPipelineID {
			continue
		}
		kommoID := int64(kp.ID)
		var pipelineID uuid.UUID
		err := s.db.QueryRow(ctx, `SELECT id FROM pipelines WHERE account_id = $1 AND kommo_id = $2`, accountID, kommoID).Scan(&pipelineID)
		if err != nil {
			pipelineID = uuid.New()
			_, err = s.db.Exec(ctx, `
				INSERT INTO pipelines (id, account_id, name, is_default, kommo_id, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
			`, pipelineID, accountID, kp.Name, kp.IsMain, kommoID)
		} else {
			_, err = s.db.Exec(ctx, `
				UPDATE pipelines SET name = $1, is_default = $2, updated_at = NOW() WHERE id = $3
			`, kp.Name, kp.IsMain, pipelineID)
		}
		if err != nil {
			return nil, err
		}

		for i, ks := range kp.Statuses {
			stageKommoID := int64(ks.ID)
			color := kommoColorToHex(ks.Color)
			var existingStageID uuid.UUID
			err := s.db.QueryRow(ctx, `SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND kommo_id = $2`, pipelineID, stageKommoID).Scan(&existingStageID)
			if err != nil {
				_, _ = s.db.Exec(ctx, `
					INSERT INTO pipeline_stages (id, pipeline_id, name, color, position, kommo_id, created_at)
					VALUES ($1, $2, $3, $4, $5, $6, NOW())
				`, uuid.New(), pipelineID, ks.Name, color, i, stageKommoID)
			} else {
				_, _ = s.db.Exec(ctx, `
					UPDATE pipeline_stages SET name = $1, color = $2, position = $3 WHERE id = $4
				`, ks.Name, color, i, existingStageID)
			}
		}
		return &pipelineID, nil
	}
	return nil, fmt.Errorf("pipeline %d not found in Kommo", kommoPipelineID)
}

// syncGlobalLeads syncs all leads for an account (no pipeline filter).
func (s *SyncService) syncGlobalLeads(ctx context.Context, accountID uuid.UUID, updatedSince int64) (int, error) {
	count := 0
	page := 1

	for {
		leads, hasMore, err := s.client.GetLeads(page, updatedSince)
		if err != nil {
			if strings.Contains(err.Error(), "204") || strings.Contains(err.Error(), "No content") {
				break
			}
			return count, err
		}

		// Batch-fetch contacts for this page of leads
		contactMap := s.batchFetchContacts(leads)

		for _, kl := range leads {
			var prefetched *KommoContact
			if kl.Embedded != nil && len(kl.Embedded.Contacts) > 0 {
				if c, ok := contactMap[kl.Embedded.Contacts[0].ID]; ok {
					prefetched = &c
				}
			}
			changed, err := s.upsertLead(ctx, accountID, kl, prefetched)
			if err != nil {
				log.Printf("[Kommo Sync] lead %d error: %v", kl.ID, err)
				continue
			}
			if changed {
				count++
			}
		}

		if !hasMore || len(leads) == 0 {
			break
		}
		page++
	}

	// Also sync unsorted (incoming) leads — these are NOT returned by /leads endpoint.
	// Only fetch first 2 pages (up to 500 leads) ordered by newest first.
	unsortedCount, err := s.syncUnsortedLeads(ctx, accountID)
	if err != nil {
		log.Printf("[Kommo Sync] unsorted leads error: %v", err)
	} else {
		count += unsortedCount
	}

	return count, nil
}

// syncUnsortedLeads fetches leads from Kommo's "Incoming" bucket (unsorted)
// and syncs them. These leads have status_id = first status of the pipeline
// and are invisible to the standard /leads endpoint.
// Only processes first page (newest first) and skips leads older than 24h
// to avoid re-processing historical duplicates every cycle.
func (s *SyncService) syncUnsortedLeads(ctx context.Context, accountID uuid.UUID) (int, error) {
	// Get connected pipeline IDs for this account
	connected, err := s.GetConnectedPipelines(ctx, accountID)
	if err != nil {
		return 0, err
	}
	enabledPipelines := make(map[int64]bool)
	for _, cp := range connected {
		if cp.Enabled {
			enabledPipelines[cp.KommoPipelineID] = true
		}
	}
	if len(enabledPipelines) == 0 {
		return 0, nil
	}

	count := 0
	// Cutoff: only process unsorted leads created in the last 24 hours
	cutoff := time.Now().Unix() - 86400

	unsorted, _, err := s.client.GetUnsortedLeads(1, 250)
	if err != nil {
		if strings.Contains(err.Error(), "204") || strings.Contains(err.Error(), "No content") {
			return 0, nil
		}
		return 0, err
	}

	for _, ul := range unsorted {
		// Results are ordered by created_at desc; stop when we hit old leads
		if ul.CreatedAt < cutoff {
			break
		}

		// Only process unsorted leads from enabled pipelines
		if !enabledPipelines[int64(ul.PipelineID)] {
			continue
		}

		// Extract lead ID from embedded
		if ul.Embedded == nil || len(ul.Embedded.Leads) == 0 {
			continue
		}
		leadID := ul.Embedded.Leads[0].ID

		// Skip leads we already know can't be synced (e.g., contact has no phone)
		// Cache expires after 1 hour to allow retry if contact gets a phone later
		s.unsortedSkipCacheMu.Lock()
		if cachedAt, ok := s.unsortedSkipCache[leadID]; ok && time.Now().Unix()-cachedAt < 3600 {
			s.unsortedSkipCacheMu.Unlock()
			continue
		}
		s.unsortedSkipCacheMu.Unlock()

		// Check if we already have this lead synced (by kommo_id)
		var exists bool
		_ = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM leads WHERE account_id = $1 AND kommo_id = $2)`,
			accountID, int64(leadID)).Scan(&exists)
		if exists {
			continue // Already synced
		}

		// Fetch full lead details via individual endpoint
		kl, err := s.client.GetLeadByID(leadID)
		if err != nil {
			log.Printf("[Kommo Sync] unsorted lead %d fetch error: %v", leadID, err)
			continue
		}

		if _, err := s.upsertLead(ctx, accountID, *kl, nil); err != nil {
			log.Printf("[Kommo Sync] unsorted lead %d upsert error: %v", leadID, err)
			continue
		}

		// Verify the lead was actually created/linked (upsertLead may return nil for skipped leads)
		var synced bool
		_ = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM leads WHERE account_id = $1 AND kommo_id = $2)`,
			accountID, int64(leadID)).Scan(&synced)
		if synced {
			count++
		} else {
			// Lead couldn't be synced (likely contact has no phone) — cache to avoid retrying
			s.unsortedSkipCacheMu.Lock()
			s.unsortedSkipCache[leadID] = time.Now().Unix()
			s.unsortedSkipCacheMu.Unlock()
		}
	}

	if count > 0 {
		log.Printf("[Kommo Sync] Synced %d unsorted (incoming) leads for account %s", count, accountID)
	}
	return count, nil
}

// syncPipelineLeads syncs leads for a specific pipeline.
// NOTE: Now mainly used when user manually triggers a pipeline sync or on initial connection.
func (s *SyncService) syncPipelineLeads(ctx context.Context, accountID uuid.UUID, kommoPipelineID int, updatedSince int64) (int, error) {
	// If kommoPipelineID is 0, treat as Global Sync
	if kommoPipelineID == 0 {
		return s.syncGlobalLeads(ctx, accountID, updatedSince)
	}

	count := 0
	page := 1

	for {
		leads, hasMore, err := s.client.GetLeadsForPipeline(kommoPipelineID, updatedSince, page)
		if err != nil {
			if strings.Contains(err.Error(), "204") || strings.Contains(err.Error(), "No content") {
				break
			}
			return count, err
		}

		// Batch-fetch contacts for this page of leads
		contactMap := s.batchFetchContacts(leads)

		for _, kl := range leads {
			var prefetched *KommoContact
			if kl.Embedded != nil && len(kl.Embedded.Contacts) > 0 {
				if c, ok := contactMap[kl.Embedded.Contacts[0].ID]; ok {
					prefetched = &c
				}
			}
			if _, err := s.upsertLead(ctx, accountID, kl, prefetched); err != nil {
				log.Printf("[Kommo Sync] lead %d error: %v", kl.ID, err)
				continue
			}
			count++
		}

		if !hasMore || len(leads) == 0 {
			break
		}
		page++
	}

	// Won/lost leads (status 142/143) are intentionally NOT synced.
	// They are handled by upsertLead() when detected via reconciliation:
	// existing active leads that transition to won/lost are auto-blocked.

	return count, nil
}

// batchFetchContacts collects all unique contact IDs from a page of leads and
// fetches them in a single batch API call. Returns a map of contactID → KommoContact.
func (s *SyncService) batchFetchContacts(leads []KommoLead) map[int]KommoContact {
	idSet := make(map[int]struct{})
	for _, kl := range leads {
		if kl.Embedded != nil {
			for _, c := range kl.Embedded.Contacts {
				idSet[c.ID] = struct{}{}
			}
		}
	}
	if len(idSet) == 0 {
		return nil
	}
	ids := make([]int, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	contactMap, err := s.client.GetContactsByIDs(ids)
	if err != nil {
		log.Printf("[Kommo Sync] batch contact fetch error (%d contacts): %v", len(ids), err)
		return nil // upsertLead will fall back to individual fetches
	}
	return contactMap
}

// upsertLead inserts or updates a single lead and its associated contact.
// upsertLead syncs a Kommo lead into the local DB. Returns true if data was actually changed.
// If prefetchedContact is non-nil, it is used directly instead of calling the API individually.
func (s *SyncService) upsertLead(ctx context.Context, accountID uuid.UUID, kl KommoLead, prefetchedContact *KommoContact) (bool, error) {
	kommoID := int64(kl.ID)
	pipelineKommoID := int64(kl.PipelineID)
	statusKommoID := int64(kl.StatusID)

	var pipelineID, stageID *uuid.UUID

	// 1. Check if this pipeline is connected AND enabled
	var pid uuid.UUID
	// Join with kommo_connected_pipelines to ensure it's enabled
	err := s.db.QueryRow(ctx, `
		SELECT p.id
		FROM pipelines p
		JOIN kommo_connected_pipelines kcp ON kcp.pipeline_id = p.id
		WHERE p.account_id = $1 AND p.kommo_id = $2 AND kcp.enabled = TRUE AND kcp.integration_instance_id IS NOT DISTINCT FROM $3
	`, accountID, pipelineKommoID, s.instanceArg()).Scan(&pid)

	pipelineSynced := false
	if err == nil {
		// Pipeline is synced
		pipelineSynced = true
		pipelineID = &pid
		var sid uuid.UUID
		err = s.db.QueryRow(ctx, `SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND kommo_id = $2`, pid, statusKommoID).Scan(&sid)
		if err == nil {
			stageID = &sid
		}
	} else {
		// Pipeline is NOT synced (or not found) -> "Leads Entrantes" (Unassigned)
		pipelineID = nil
		stageID = nil
	}

	// ─── Won/Lost Detection (status 142=Won, 143=Lost) ───
	// Won/lost leads are NOT imported into Clarin. If an existing active lead
	// transitions to won/lost in Kommo, it's auto-blocked and desynced.
	if statusKommoID == 142 || statusKommoID == 143 {
		var existingLeadID uuid.UUID
		var alreadyDesynced bool
		err := s.db.QueryRow(ctx,
			`SELECT id, (kommo_deleted_at IS NOT NULL) FROM leads WHERE account_id = $1 AND kommo_id = $2`,
			accountID, kommoID).Scan(&existingLeadID, &alreadyDesynced)
		if err != nil {
			// Lead doesn't exist in Clarin → skip, don't import won/lost
			return false, nil
		}
		if alreadyDesynced {
			// Already desynced from Kommo → nothing to do
			return false, nil
		}
		// Lead transitioning to won/lost → block (if not already) + desync + add observation
		statusLabel := "GANADO"
		emoji := "🏆"
		blockReason := "Ganado en Kommo"
		if statusKommoID == 143 {
			statusLabel = "PERDIDO"
			emoji = "❌"
			blockReason = "Perdido en Kommo"
		}
		_, _ = s.db.Exec(ctx, `
			UPDATE leads SET is_blocked = true, blocked_at = COALESCE(blocked_at, NOW()), block_reason = $2,
				kommo_deleted_at = NOW(), updated_at = NOW()
			WHERE id = $1
		`, existingLeadID, blockReason)
		// Create observation explaining what happened
		obsNotes := fmt.Sprintf("%s Lead marcado como %s en Kommo. Bloqueado automáticamente y desvinculado de la sincronización. Si deseas eliminarlo, puedes hacerlo sin afectar Kommo.", emoji, statusLabel)
		_, _ = s.db.Exec(ctx, `
			INSERT INTO interactions (id, account_id, lead_id, contact_id, type, notes, created_at)
			VALUES (gen_random_uuid(), $1, $2, (SELECT contact_id FROM leads WHERE id = $2), 'note', $3, NOW())
		`, accountID, existingLeadID, obsNotes)
		log.Printf("[Kommo Sync] Lead %s (Kommo %d) transitioned to %s → auto-blocked and desynced", existingLeadID, kommoID, statusLabel)
		// Broadcast updates
		if s.hub != nil {
			s.hub.BroadcastToAccount(accountID, ws.EventLeadUpdate, map[string]interface{}{"action": "updated"})
			s.hub.BroadcastToAccount(accountID, ws.EventInteractionUpdate, map[string]interface{}{
				"action":  "created",
				"lead_id": existingLeadID.String(),
			})
		}
		return true, nil
	}

	// Early check: if the pipeline is NOT synced and the lead doesn't already exist
	// in this account, skip entirely to avoid creating orphan contacts.
	if !pipelineSynced {
		var existsInAccount bool
		_ = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM leads WHERE account_id = $1 AND kommo_id = $2)`,
			accountID, kommoID).Scan(&existsInAccount)
		if !existsInAccount {
			return false, nil // Lead not in a synced pipeline and doesn't exist → skip completely
		}
	}

	var contactID *uuid.UUID
	contactChanged := false
	var phone, email string
	if kl.Embedded != nil && len(kl.Embedded.Contacts) > 0 {
		// Use pre-fetched contact if available (batch mode), otherwise fetch individually
		var contact *KommoContact
		if prefetchedContact != nil {
			contact = prefetchedContact
		} else {
			fetched, fetchErr := s.client.GetContactByID(kl.Embedded.Contacts[0].ID)
			if fetchErr == nil {
				contact = fetched
			}
		}

		if contact != nil {
			syncedID, syncedContactChanged := s.upsertContact(ctx, accountID, *contact)
			if syncedID != nil {
				contactID = syncedID
				s.db.QueryRow(ctx, `SELECT COALESCE(phone, ''), COALESCE(email, '') FROM contacts WHERE id = $1`, *syncedID).Scan(&phone, &email)
			}
			if syncedContactChanged {
				contactChanged = true
				defer func() {
					if s.hub != nil && contactID != nil {
						s.hub.BroadcastToAccount(accountID, ws.EventContactUpdate, map[string]interface{}{
							"action":     "updated",
							"contact_id": contactID.String(),
						})
					}
				}()
			}
		} else {
			// Fallback: use existing contact if API call fails
			firstContactKommoID := int64(kl.Embedded.Contacts[0].ID)
			var cid uuid.UUID
			if err := s.db.QueryRow(ctx, `SELECT id FROM contacts WHERE account_id = $1 AND kommo_id = $2`, accountID, firstContactKommoID).Scan(&cid); err == nil {
				contactID = &cid
				s.db.QueryRow(ctx, `SELECT COALESCE(phone, ''), COALESCE(email, '') FROM contacts WHERE id = $1`, cid).Scan(&phone, &email)
			}
		}
	}

	jid := ""
	if phone != "" {
		jid = normalizePhone(phone) + "@s.whatsapp.net"
	}
	if jid == "" {
		jid = fmt.Sprintf("kommo_%d@kommo.lead", kl.ID)
	}

	var tagNames []string
	if kl.Embedded != nil {
		for _, t := range kl.Embedded.Tags {
			tagNames = append(tagNames, t.Name)
		}
	}

	// Lead name is managed via contacts table (not stored in leads)

	var leadID uuid.UUID
	foundByKommoID := false
	err = s.db.QueryRow(ctx, `SELECT id FROM leads WHERE account_id = $1 AND kommo_id = $2`, accountID, kommoID).Scan(&leadID)
	if err == nil {
		foundByKommoID = true
	} else if jid != "" {
		// Try to find an unlinked WhatsApp-created lead (no kommo_id) to attach this Kommo lead to.
		// We deliberately skip leads that already have a kommo_id — since the UNIQUE(account_id,jid)
		// constraint was removed, there can now be multiple leads per phone; each deserves its own row.
		var existingKommoID *int64
		err = s.db.QueryRow(ctx,
			`SELECT id, kommo_id FROM leads WHERE account_id = $1 AND jid = $2 AND kommo_id IS NULL LIMIT 1`,
			accountID, jid).Scan(&leadID, &existingKommoID)
	}
	if err != nil {
		// NEW lead — only import if it belongs to a synced pipeline.
		// Leads from non-synced pipelines are completely ignored.
		if pipelineID == nil {
			log.Printf("[Kommo Sync] lead %d SKIPPED: pipeline %d not synced in Clarin", kl.ID, pipelineKommoID)
			return false, nil
		}
		if jid == "" {
			log.Printf("[Kommo Sync] lead %d SKIPPED: no JID could be resolved", kl.ID)
			return false, nil
		}

		leadID = uuid.New()
		_, err = s.db.Exec(ctx, `
			INSERT INTO leads (id, account_id, contact_id, jid, name, status, source,
					pipeline_id, stage_id, tags, kommo_synced_tags, kommo_id, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5, 'new', 'kommo', $6, $7, $8, $8, $9, NOW(), NOW())
		`, leadID, accountID, contactID, jid,
			nilIfEmpty(cleanQuotes(kl.Name)), pipelineID, stageID, tagNames, kommoID)
		if err != nil {
			return false, err
		}
		// New lead inserted — sync tags and calls
		if len(tagNames) > 0 {
			s.syncLeadTags(ctx, accountID, leadID, tagNames)
		}
		s.syncCallsFromKommo(ctx, accountID, leadID, contactID, kl.CustomFields)
		return true, nil
	}

	// Anti-loop: skip update if this is an echo of our own push
	// (The three-way merge makes the old 2-min cooldown unnecessary — this cheap
	// timestamp check still avoids wasted DB writes for our own push echoes.)
	var lastPushedAt int64
	_ = s.db.QueryRow(ctx, `SELECT COALESCE(kommo_last_pushed_at, 0) FROM leads WHERE id = $1`, leadID).Scan(&lastPushedAt)
	if lastPushedAt > 0 && lastPushedAt == kl.UpdatedAt {
		// This update was caused by our own push — reset and skip
		_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = 0 WHERE id = $1`, leadID)
		return false, nil
	}

	// Lead moved to a non-synced pipeline in Kommo.
	// Remove it from its current pipeline in Clarin (move to "Leads Entrantes").
	if pipelineID == nil {
		var curPipelineID *uuid.UUID
		_ = s.db.QueryRow(ctx, `SELECT pipeline_id FROM leads WHERE id = $1`, leadID).Scan(&curPipelineID)
		if curPipelineID != nil {
			_, _ = s.db.Exec(ctx, `UPDATE leads SET pipeline_id = NULL, stage_id = NULL, updated_at = NOW() WHERE id = $1`, leadID)
			log.Printf("[Kommo Sync] Lead %s (Kommo %d) moved to non-synced pipeline %d in Kommo → removed from Clarin pipeline", leadID, kommoID, pipelineKommoID)
			if s.hub != nil {
				s.hub.BroadcastToAccount(accountID, ws.EventLeadUpdate, map[string]interface{}{"action": "updated"})
			}
			return true, nil
		}
		return false, nil
	}

	// Check if data actually changed before updating (avoid unnecessary writes + broadcasts)
	var curPipelineID, curStageID *uuid.UUID
	var curLeadName *string
	var curTags []string
	_ = s.db.QueryRow(ctx, `SELECT pipeline_id, stage_id, tags, name FROM leads WHERE id = $1`, leadID).Scan(&curPipelineID, &curStageID, &curTags, &curLeadName)
	tagsSame := len(curTags) == len(tagNames)
	if tagsSame {
		curTagSet := make(map[string]bool, len(curTags))
		for _, t := range curTags {
			curTagSet[t] = true
		}
		for _, t := range tagNames {
			if !curTagSet[t] {
				tagsSame = false
				break
			}
		}
	}
	pipelineSame := (curPipelineID != nil && pipelineID != nil && *curPipelineID == *pipelineID) || (curPipelineID == nil && pipelineID == nil)
	stageSame := (curStageID != nil && stageID != nil && *curStageID == *stageID) || (curStageID == nil && stageID == nil)
	leadName := nilIfEmpty(cleanQuotes(kl.Name))
	leadNameSame := leadName == nil || (curLeadName != nil && *curLeadName == *leadName)

	// Ensure tagNames is never nil (nil would be stored as SQL NULL)
	if tagNames == nil {
		tagNames = []string{}
	}

	if foundByKommoID && pipelineSame && stageSame && tagsSame && leadNameSame && !contactChanged {
		// Lead fields unchanged — still reconcile contact_tags junction (may be out of sync)
		s.syncLeadTags(ctx, accountID, leadID, tagNames)
		return false, nil
	}

	if foundByKommoID {
		// Already linked — sync CRM fields from Kommo (personal data lives on contacts)
		_, err = s.db.Exec(ctx, `
			UPDATE leads SET
				name = COALESCE($1, name),
				contact_id = COALESCE($2, contact_id),
				pipeline_id = $3,
				stage_id = $4,
				tags = $5,
				kommo_deleted_at = NULL,
				updated_at = NOW()
			WHERE id = $6
		`, leadName, contactID, pipelineID, stageID, tagNames, leadID)
	} else {
		// First-time linking (found by JID) — Clarin keeps name/phone/email,
		// only link kommo_id and sync CRM fields (pipeline, stage, tags)
		_, err = s.db.Exec(ctx, `
			UPDATE leads SET
				kommo_id = $1,
				name = COALESCE($2, name),
				contact_id = COALESCE($3, contact_id),
				pipeline_id = $4,
				stage_id = $5,
				tags = $6,
				kommo_deleted_at = NULL,
				updated_at = NOW()
			WHERE id = $7
		`, kommoID, leadName, contactID, pipelineID, stageID, tagNames, leadID)
		log.Printf("[Kommo Sync] Linked existing Clarin lead %s to Kommo ID %d (preserved Clarin name/phone/email)", leadID, kommoID)
	}
	if err != nil {
		return false, err
	}

	// Sync contact_tags junction table (always call — even with empty tagNames to clean up removed tags)
	s.syncLeadTags(ctx, accountID, leadID, tagNames)

	// Sync call observations from Kommo custom fields → Clarin interactions
	s.syncCallsFromKommo(ctx, accountID, leadID, contactID, kl.CustomFields)

	return true, nil
}

// syncCallsFromKommo reads the 10 call slots from Kommo custom fields and upserts
// them as type=call interactions in Clarin. Uses kommo_call_slot for dedup.
func (s *SyncService) syncCallsFromKommo(ctx context.Context, accountID, leadID uuid.UUID, contactID *uuid.UUID, fields []KommoCustomField) {
	if len(fields) == 0 {
		return
	}

	// Build a lookup map: field_id → first value (as string)
	fieldMap := make(map[int]string, len(fields))
	for _, f := range fields {
		if len(f.Values) > 0 && f.Values[0].Value != nil {
			switch v := f.Values[0].Value.(type) {
			case string:
				fieldMap[f.FieldID] = v
			case float64:
				// date_time fields come as unix timestamps
				fieldMap[f.FieldID] = fmt.Sprintf("%.0f", v)
			}
		}
	}

	for slot := 0; slot < KommoCallSlotCount; slot++ {
		responsable := fieldMap[KommoCallFieldResponsable[slot]]
		fecha := fieldMap[KommoCallFieldFecha[slot]]
		resultado := fieldMap[KommoCallFieldResultado[slot]]

		// Skip empty slots
		if responsable == "" && resultado == "" {
			continue
		}

		slotNum := slot + 1 // 1-based slot number

		// Check if a locally-created interaction already owns this slot
		var existingNotes *string
		_ = s.db.QueryRow(ctx, `SELECT notes FROM interactions WHERE lead_id = $1 AND kommo_call_slot = $2`, leadID, slotNum).Scan(&existingNotes)
		if existingNotes != nil && !strings.HasPrefix(*existingNotes, "(sinc) ") {
			// This slot is owned by a local interaction — don't overwrite
			continue
		}

		// Build the note with (sinc) prefix
		var parts []string
		if responsable != "" {
			parts = append(parts, "Responsable: "+responsable)
		}
		if fecha != "" {
			if ts, err := strconv.ParseInt(fecha, 10, 64); err == nil && ts > 0 {
				fecha = time.Unix(ts, 0).Format("02/01/2006 15:04")
			}
			parts = append(parts, "Fecha: "+fecha)
		}
		if resultado != "" {
			parts = append(parts, "Resultado: "+resultado)
		}
		notes := "(sinc) " + strings.Join(parts, " | ")

		// Upsert: use kommo_call_slot unique index for dedup
		_, err := s.db.Exec(ctx, `
			INSERT INTO interactions (id, account_id, contact_id, lead_id, type, notes, kommo_call_slot, created_at)
			VALUES (gen_random_uuid(), $1, $2, $3, 'call', $4, $5, NOW())
			ON CONFLICT (lead_id, kommo_call_slot) WHERE kommo_call_slot IS NOT NULL
			DO UPDATE SET notes = EXCLUDED.notes
		`, accountID, contactID, leadID, notes, slotNum)
		if err != nil {
			log.Printf("[Kommo Sync] Error syncing call slot %d for lead %s: %v", slotNum, leadID, err)
		}
	}

	// Broadcast interaction update for this lead
	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventInteractionUpdate, map[string]interface{}{
			"action":  "synced",
			"lead_id": leadID.String(),
		})
	}

	// Handle "Otras llamadas" overflow field
	otrasLlamadas := fieldMap[KommoCallFieldOtrasLlamadas]
	if otrasLlamadas != "" {
		notes := "(sinc) Otras llamadas: " + otrasLlamadas
		slotNum := KommoCallSlotCount + 1 // slot 11 = overflow

		_, err := s.db.Exec(ctx, `
			INSERT INTO interactions (id, account_id, contact_id, lead_id, type, notes, kommo_call_slot, created_at)
			VALUES (gen_random_uuid(), $1, $2, $3, 'call', $4, $5, NOW())
			ON CONFLICT (lead_id, kommo_call_slot) WHERE kommo_call_slot IS NOT NULL
			DO UPDATE SET notes = EXCLUDED.notes
		`, accountID, contactID, leadID, notes, slotNum)
		if err != nil {
			log.Printf("[Kommo Sync] Error syncing 'Otras llamadas' for lead %s: %v", leadID, err)
		}
	}
}

func kommoCustomFieldValue(fields []KommoCustomField, fieldID int) interface{} {
	for _, field := range fields {
		if field.FieldID == fieldID && len(field.Values) > 0 {
			return field.Values[0].Value
		}
	}
	return nil
}

func kommoCustomFieldString(fields []KommoCustomField, fieldID int) string {
	value := kommoCustomFieldValue(fields, fieldID)
	switch typedValue := value.(type) {
	case string:
		return cleanQuotes(typedValue)
	case float64:
		return strconv.FormatFloat(typedValue, 'f', -1, 64)
	case int:
		return strconv.Itoa(typedValue)
	case int64:
		return strconv.FormatInt(typedValue, 10)
	default:
		return ""
	}
}

func kommoCustomFieldInt(fields []KommoCustomField, fieldID int) *int {
	rawValue := strings.TrimSpace(kommoCustomFieldString(fields, fieldID))
	if rawValue == "" {
		return nil
	}
	rawValue = strings.ReplaceAll(rawValue, ",", ".")
	parsedValue, err := strconv.ParseFloat(rawValue, 64)
	if err != nil {
		return nil
	}
	intValue := int(parsedValue)
	if intValue <= 0 || intValue > 130 {
		return nil
	}
	return &intValue
}

func kommoCustomFieldDate(fields []KommoCustomField, fieldID int) *time.Time {
	value := kommoCustomFieldValue(fields, fieldID)
	switch typedValue := value.(type) {
	case float64:
		if typedValue <= 0 {
			return nil
		}
		parsedTime := time.Unix(int64(typedValue), 0).UTC()
		return &parsedTime
	case int:
		if typedValue <= 0 {
			return nil
		}
		parsedTime := time.Unix(int64(typedValue), 0).UTC()
		return &parsedTime
	case string:
		rawValue := strings.TrimSpace(typedValue)
		if rawValue == "" {
			return nil
		}
		if unixValue, err := strconv.ParseInt(rawValue, 10, 64); err == nil && unixValue > 0 {
			parsedTime := time.Unix(unixValue, 0).UTC()
			return &parsedTime
		}
		for _, layout := range []string{time.RFC3339, "2006-01-02", "02/01/2006", "02.01.2006"} {
			parsedTime, err := time.Parse(layout, rawValue)
			if err == nil {
				return &parsedTime
			}
		}
	}
	return nil
}

func (s *SyncService) upsertContact(ctx context.Context, accountID uuid.UUID, kc KommoContact) (*uuid.UUID, bool) {
	kommoID := int64(kc.ID)
	phone := GetContactPhone(kc.CustomFields)
	email := GetContactEmail(kc.CustomFields)
	age := kommoCustomFieldInt(kc.CustomFields, KommoContactFieldAge)
	dni := nilIfEmpty(kommoCustomFieldString(kc.CustomFields, KommoContactFieldDNI))
	birthDate := kommoCustomFieldDate(kc.CustomFields, KommoContactFieldBirthDate)
	ocupacion := nilIfEmpty(kommoCustomFieldString(kc.CustomFields, KommoContactFieldPosition))

	if phone == "" && kc.Name == "" {
		return nil, false
	}

	cleanPhone := normalizePhone(phone)
	jid := ""
	if cleanPhone != "" {
		jid = cleanPhone + "@s.whatsapp.net"
	} else {
		// Contacts without phone get a unique kommo-based JID to avoid duplicates
		jid = fmt.Sprintf("kommo_contact_%d@kommo.contact", kc.ID)
	}

	name := cleanQuotes(kc.Name)
	if kc.FirstName != "" {
		name = cleanQuotes(kc.FirstName)
	}

	lastName := cleanQuotes(kc.LastName)

	var existingID uuid.UUID
	err := s.db.QueryRow(ctx, `
		SELECT id FROM contacts
		WHERE account_id = $1 AND kommo_id = $2
		ORDER BY updated_at DESC
		LIMIT 1
	`, accountID, kommoID).Scan(&existingID)
	if err != nil && jid != "" {
		// Also try to find by JID (contact may exist from WhatsApp sync without kommo_id)
		err = s.db.QueryRow(ctx, `
			SELECT id FROM contacts
			WHERE account_id = $1 AND jid = $2
			ORDER BY updated_at DESC
			LIMIT 1
		`, accountID, jid).Scan(&existingID)
	}
	contactChanged := false
	if err != nil {
		existingID = uuid.New()
		_, err = s.db.Exec(ctx, `
			INSERT INTO contacts (id, account_id, jid, phone, name, last_name, email, source, kommo_id,
				age, dni, birth_date, ocupacion, is_group, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'kommo', $8, $9, $10, $11, $12, FALSE, NOW(), NOW())
		`, existingID, accountID, jid, nilIfEmpty(cleanPhone), nilIfEmpty(name), nilIfEmpty(lastName),
			nilIfEmpty(email), kommoID, age, dni, birthDate, ocupacion)
		contactChanged = err == nil
	} else {
		commandTag, execErr := s.db.Exec(ctx, `
			UPDATE contacts SET
				name = CASE WHEN $1 != '' THEN $1 ELSE name END,
				custom_name = CASE
					WHEN $1 != '' AND (NULLIF(custom_name, '') IS NULL OR custom_name = name) THEN $1
					ELSE custom_name
				END,
				last_name = CASE WHEN $2 != '' THEN $2 ELSE last_name END,
				phone = COALESCE($3, phone),
				email = COALESCE($4, email),
				jid = COALESCE($5, jid),
				kommo_id = COALESCE($6, kommo_id),
				age = COALESCE($7::integer, age),
				dni = COALESCE($8::text, dni),
				birth_date = COALESCE($9::date, birth_date),
				ocupacion = COALESCE($10::varchar, ocupacion),
				updated_at = NOW()
			WHERE account_id = $11
			  AND (id = $12 OR kommo_id = $6)
			  AND (
				($1 != '' AND name IS DISTINCT FROM $1) OR
				($1 != '' AND (NULLIF(custom_name, '') IS NULL OR custom_name = name) AND custom_name IS DISTINCT FROM $1) OR
				($2 != '' AND last_name IS DISTINCT FROM $2) OR
				($3::varchar IS NOT NULL AND phone IS DISTINCT FROM $3) OR
				($4::varchar IS NOT NULL AND email IS DISTINCT FROM $4) OR
				($5::varchar IS NOT NULL AND jid IS DISTINCT FROM $5) OR
				(kommo_id IS DISTINCT FROM $6) OR
				($7::integer IS NOT NULL AND age IS DISTINCT FROM $7) OR
				($8::text IS NOT NULL AND dni IS DISTINCT FROM $8) OR
				($9::date IS NOT NULL AND birth_date IS DISTINCT FROM $9::date) OR
				($10::varchar IS NOT NULL AND ocupacion IS DISTINCT FROM $10)
			  )
		`, name, lastName, nilIfEmpty(cleanPhone), nilIfEmpty(email), nilIfEmpty(jid), kommoID,
			age, dni, birthDate, ocupacion, accountID, existingID)
		err = execErr
		contactChanged = execErr == nil && commandTag.RowsAffected() > 0
	}
	if err != nil {
		log.Printf("[Kommo Sync] contact %d error: %v", kc.ID, err)
		return nil, false
	}

	// Sync contact_tags junction table
	if kc.Embedded != nil && len(kc.Embedded.Tags) > 0 {
		s.syncContactTags(ctx, accountID, existingID, kc.Embedded.Tags)
	}

	return &existingID, contactChanged
}

func (s *SyncService) syncPipelines(ctx context.Context, accountID uuid.UUID) (int, int, error) {
	kommoPipelines, err := s.client.GetPipelines()
	if err != nil {
		return 0, 0, err
	}

	pCount := 0
	sCount := 0

	for _, kp := range kommoPipelines {
		kommoID := int64(kp.ID)
		var pipelineID uuid.UUID
		err := s.db.QueryRow(ctx, `SELECT id FROM pipelines WHERE account_id = $1 AND kommo_id = $2`, accountID, kommoID).Scan(&pipelineID)
		if err != nil {
			pipelineID = uuid.New()
			_, err = s.db.Exec(ctx, `
				INSERT INTO pipelines (id, account_id, name, is_default, kommo_id, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
			`, pipelineID, accountID, kp.Name, kp.IsMain, kommoID)
		} else {
			_, err = s.db.Exec(ctx, `
				UPDATE pipelines SET name = $1, is_default = $2, updated_at = NOW() WHERE id = $3
			`, kp.Name, kp.IsMain, pipelineID)
		}
		if err != nil {
			log.Printf("[Kommo Sync] pipeline %d error: %v", kp.ID, err)
			continue
		}
		pCount++

		for i, ks := range kp.Statuses {
			stageKommoID := int64(ks.ID)
			color := kommoColorToHex(ks.Color)
			var existingStageID uuid.UUID
			err := s.db.QueryRow(ctx, `SELECT id FROM pipeline_stages WHERE kommo_id = $1`, stageKommoID).Scan(&existingStageID)
			if err != nil {
				_, err = s.db.Exec(ctx, `
					INSERT INTO pipeline_stages (id, pipeline_id, name, color, position, kommo_id, created_at)
					VALUES ($1, $2, $3, $4, $5, $6, NOW())
				`, uuid.New(), pipelineID, ks.Name, color, i, stageKommoID)
			} else {
				_, err = s.db.Exec(ctx, `
					UPDATE pipeline_stages SET name = $1, color = $2, position = $3 WHERE id = $4
				`, ks.Name, color, i, existingStageID)
			}
			if err != nil {
				log.Printf("[Kommo Sync] stage %d error: %v", ks.ID, err)
			}
			sCount++
		}
	}

	return pCount, sCount, nil
}

func (s *SyncService) syncTags(ctx context.Context, accountID uuid.UUID) (int, error) {
	kommoTags, err := s.client.GetTags()
	if err != nil {
		return 0, err
	}

	count := 0
	for _, kt := range kommoTags {
		kommoID := int64(kt.ID)
		var existingTagID uuid.UUID
		err := s.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND kommo_id = $2`, accountID, kommoID).Scan(&existingTagID)
		if err != nil {
			_, err = s.db.Exec(ctx, `
				INSERT INTO tags (id, account_id, name, color, kommo_id, created_at, updated_at)
				VALUES ($1, $2, $3, '#6366f1', $4, NOW(), NOW())
			`, uuid.New(), accountID, kt.Name, kommoID)
		} else {
			_, err = s.db.Exec(ctx, `UPDATE tags SET name = $1, updated_at = NOW() WHERE id = $2`, kt.Name, existingTagID)
		}
		if err != nil {
			log.Printf("[Kommo Sync] tag %d error: %v", kt.ID, err)
			continue
		}
		count++
	}
	return count, nil
}

// pushMissingTagsToKommo creates tags in Kommo that exist locally but have no kommo_id.
// This enables bidirectional tag sync: tags created in Clarin are pushed to Kommo.
func (s *SyncService) pushMissingTagsToKommo(ctx context.Context, accountID uuid.UUID) (int, error) {
	rows, err := s.db.Query(ctx, `SELECT id, name FROM tags WHERE account_id = $1 AND kommo_id IS NULL`, accountID)
	if err != nil {
		return 0, fmt.Errorf("query missing tags: %w", err)
	}
	defer rows.Close()

	type localTag struct {
		id   uuid.UUID
		name string
	}
	var missing []localTag
	for rows.Next() {
		var t localTag
		if err := rows.Scan(&t.id, &t.name); err != nil {
			continue
		}
		missing = append(missing, t)
	}

	count := 0
	for _, t := range missing {
		newKommoID, createErr := s.client.CreateLeadTag(t.name)
		if createErr != nil {
			log.Printf("[SYNC] Failed to create tag %q in Kommo: %v", t.name, createErr)
			continue
		}
		kommoID64 := int64(newKommoID)
		_, _ = s.db.Exec(ctx, `UPDATE tags SET kommo_id = $1, updated_at = NOW() WHERE id = $2`, kommoID64, t.id)
		log.Printf("[SYNC] Created tag %q in Kommo (kommo_id=%d)", t.name, newKommoID)
		count++
	}
	return count, nil
}

func (s *SyncService) syncContacts(ctx context.Context, accountID uuid.UUID) (int, error) {
	count := 0
	page := 1

	for {
		contacts, hasMore, err := s.client.GetContacts(page)
		if err != nil {
			if strings.Contains(err.Error(), "204") || strings.Contains(err.Error(), "No content") {
				break
			}
			return count, err
		}

		for _, kc := range contacts {
			if syncedID, _ := s.upsertContact(ctx, accountID, kc); syncedID != nil {
				count++
			}
		}

		if !hasMore || len(contacts) == 0 {
			break
		}
		page++
	}

	return count, nil
}

func (s *SyncService) syncLeads(ctx context.Context, accountID uuid.UUID) (int, error) {
	count := 0
	page := 1

	for {
		leads, hasMore, err := s.client.GetLeads(page, 0)
		if err != nil {
			if strings.Contains(err.Error(), "204") || strings.Contains(err.Error(), "No content") {
				break
			}
			return count, err
		}

		// Batch-fetch contacts for reconcile page
		contactMap := s.batchFetchContacts(leads)

		for _, kl := range leads {
			var prefetched *KommoContact
			if kl.Embedded != nil && len(kl.Embedded.Contacts) > 0 {
				if c, ok := contactMap[kl.Embedded.Contacts[0].ID]; ok {
					prefetched = &c
				}
			}
			if _, err := s.upsertLead(ctx, accountID, kl, prefetched); err != nil {
				log.Printf("[Kommo Sync] lead %d error: %v", kl.ID, err)
				continue
			}
			count++
		}

		if !hasMore || len(leads) == 0 {
			break
		}
		page++
	}

	return count, nil
}

// syncLeadTags uses three-way merge to reconcile tags between Kommo and Clarin.
// baseline (kommo_synced_tags) tracks the last agreed state. Changes from both sides
// are computed as diffs against the baseline and merged without data loss.
func (s *SyncService) syncLeadTags(ctx context.Context, accountID, leadID uuid.UUID, kommoTagNames []string) {
	var contactID *uuid.UUID
	var baseline []string
	_ = s.db.QueryRow(ctx, `SELECT contact_id, COALESCE(kommo_synced_tags, '{}') FROM leads WHERE id = $1`, leadID).Scan(&contactID, &baseline)
	if contactID == nil {
		return
	}

	// Resolve all Kommo tag names → local tag IDs (create if needed)
	kommoTagIDs := make(map[string]uuid.UUID, len(kommoTagNames))
	for _, name := range kommoTagNames {
		var tagID uuid.UUID
		err := s.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND name = $2`, accountID, name).Scan(&tagID)
		if err != nil {
			tagID = uuid.New()
			_, err = s.db.Exec(ctx, `
				INSERT INTO tags (id, account_id, name, color, created_at, updated_at)
				VALUES ($1, $2, $3, '#6366f1', NOW(), NOW())
				ON CONFLICT (account_id, name) DO NOTHING
			`, tagID, accountID, name)
			if err != nil {
				_ = s.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND name = $2`, accountID, name).Scan(&tagID)
			}
		}
		kommoTagIDs[name] = tagID
	}

	// Get current Clarin tags for this contact (name → tagID)
	clarinTagIDs := make(map[string]uuid.UUID)
	rows, err := s.db.Query(ctx, `
		SELECT t.name, ct.tag_id
		FROM contact_tags ct
		JOIN tags t ON ct.tag_id = t.id
		WHERE ct.contact_id = $1 AND t.account_id = $2
	`, *contactID, accountID)
	if err == nil {
		for rows.Next() {
			var name string
			var tid uuid.UUID
			if rows.Scan(&name, &tid) == nil {
				clarinTagIDs[name] = tid
			}
		}
		rows.Close()
	}

	// Three-way merge
	baselineSet := toStringSet(baseline)
	kommoSet := toStringSet(kommoTagNames)
	clarinSet := make(map[string]bool, len(clarinTagIDs))
	for name := range clarinTagIDs {
		clarinSet[name] = true
	}

	kommoAdded := diffSet(kommoSet, baselineSet)   // tags Kommo added since baseline
	kommoRemoved := diffSet(baselineSet, kommoSet) // tags Kommo removed since baseline

	// merged = (clarin_current ∪ kommo_added) - kommo_removed
	merged := copySet(clarinSet)
	for tag := range kommoAdded {
		merged[tag] = true
	}
	for tag := range kommoRemoved {
		delete(merged, tag)
	}

	// Apply merged state to contact_tags
	// ADD: tags in merged but not in clarinSet
	for name := range merged {
		if _, exists := clarinTagIDs[name]; !exists {
			// Need to resolve tag ID
			if tid, ok := kommoTagIDs[name]; ok {
				_, _ = s.db.Exec(ctx, `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, *contactID, tid)
			}
		}
	}
	// REMOVE: tags in clarinSet but not in merged
	for name, tid := range clarinTagIDs {
		if !merged[name] {
			_, _ = s.db.Exec(ctx, `DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = $2`, *contactID, tid)
		}
	}

	// Update baseline
	mergedSlice := setToSlice(merged)
	_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_synced_tags = $1 WHERE id = $2`, mergedSlice, leadID)
}

// syncContactTags merges the contact_tags junction table for a contact.
// Uses MERGE logic: adds new Kommo tags, removes only Kommo-sourced tags no longer present.
func (s *SyncService) syncContactTags(ctx context.Context, accountID, contactID uuid.UUID, tags []KommoTag) {
	if len(tags) == 0 {
		return
	}

	// Resolve all Kommo tags → local tag IDs (create if needed)
	newTagIDs := make(map[uuid.UUID]bool, len(tags))
	for _, kt := range tags {
		var tagID uuid.UUID
		err := s.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND name = $2`, accountID, kt.Name).Scan(&tagID)
		if err != nil {
			tagID = uuid.New()
			_, err = s.db.Exec(ctx, `
				INSERT INTO tags (id, account_id, name, color, created_at, updated_at)
				VALUES ($1, $2, $3, '#6366f1', NOW(), NOW())
				ON CONFLICT (account_id, name) DO NOTHING
			`, tagID, accountID, kt.Name)
			if err != nil {
				_ = s.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND name = $2`, accountID, kt.Name).Scan(&tagID)
			}
		}
		newTagIDs[tagID] = true
	}

	// Get existing tags with origin info
	type existingTag struct {
		tagID      uuid.UUID
		hasKommoID bool
	}
	var existingTags []existingTag
	rows, err := s.db.Query(ctx, `
		SELECT ct.tag_id, (t.kommo_id IS NOT NULL) as has_kommo_id
		FROM contact_tags ct
		JOIN tags t ON ct.tag_id = t.id
		WHERE ct.contact_id = $1
	`, contactID)
	if err == nil {
		for rows.Next() {
			var et existingTag
			if rows.Scan(&et.tagID, &et.hasKommoID) == nil {
				existingTags = append(existingTags, et)
			}
		}
		rows.Close()
	}

	existingSet := make(map[uuid.UUID]bool, len(existingTags))
	for _, et := range existingTags {
		existingSet[et.tagID] = true
	}

	// ADD: tags in Kommo but not locally
	for tid := range newTagIDs {
		if !existingSet[tid] {
			_, _ = s.db.Exec(ctx, `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, contactID, tid)
		}
	}

	// REMOVE: any tag no longer in Kommo's authoritative list
	for _, et := range existingTags {
		if !newTagIDs[et.tagID] {
			_, _ = s.db.Exec(ctx, `DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = $2`, contactID, et.tagID)
		}
	}
}

// --- Helpers ---

// --- Push Operations (Clarin → Kommo, async, individual actions only) ---

// PushLeadStageChange pushes a lead stage change to Kommo.
// Only acts if the lead has a kommo_id and the stage has a kommo_id.
func (s *SyncService) PushLeadStageChange(accountID, leadID, stageID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if !s.isKommoEnabled(ctx, accountID) {
		return
	}

	var kommoLeadID *int64
	var kommoStageID *int64
	var kommoPipelineID *int64

	err := s.db.QueryRow(ctx, `SELECT kommo_id FROM leads WHERE id = $1 AND account_id = $2`, leadID, accountID).Scan(&kommoLeadID)
	if err != nil || kommoLeadID == nil {
		return // Not a Kommo lead
	}

	err = s.db.QueryRow(ctx, `
		SELECT ps.kommo_id, p.kommo_id
		FROM pipeline_stages ps
		JOIN pipelines p ON ps.pipeline_id = p.id
		WHERE ps.id = $1
	`, stageID).Scan(&kommoStageID, &kommoPipelineID)
	if err != nil || kommoStageID == nil || kommoPipelineID == nil {
		return // Not a Kommo stage/pipeline
	}

	updatedAt, err := s.client.UpdateLeadStatus(int(*kommoLeadID), int(*kommoStageID), int(*kommoPipelineID))
	if err != nil {
		log.Printf("[PUSH] Lead %s stage change to Kommo failed: %v", leadID, err)
		return
	}

	// Store the pushed timestamp for anti-loop
	_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = $1 WHERE id = $2`, updatedAt, leadID)
	log.Printf("[PUSH] Lead %s stage → Kommo lead %d, stage %d (updated_at=%d)", leadID, *kommoLeadID, *kommoStageID, updatedAt)
	s.Monitor.Log("push", fmt.Sprintf("Lead etapa → Kommo lead %d, etapa %d", *kommoLeadID, *kommoStageID), "info")
}

// PushLeadTagsChange pushes all current tags of a lead to Kommo.
func (s *SyncService) PushLeadTagsChange(accountID, leadID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if !s.isKommoEnabled(ctx, accountID) {
		return
	}

	var kommoLeadID *int64
	var baseline []string
	err := s.db.QueryRow(ctx, `SELECT kommo_id, COALESCE(kommo_synced_tags, '{}') FROM leads WHERE id = $1 AND account_id = $2`, leadID, accountID).Scan(&kommoLeadID, &baseline)
	if err != nil || kommoLeadID == nil {
		return
	}

	// Get all current Clarin tags for this lead (via contact_tags)
	rows, err := s.db.Query(ctx, `
		SELECT t.name FROM contact_tags ct
		JOIN tags t ON ct.tag_id = t.id
		JOIN leads l ON l.contact_id = ct.contact_id
		WHERE l.id = $1
	`, leadID)
	if err != nil {
		log.Printf("[PUSH] Lead %s: failed to fetch tags: %v", leadID, err)
		return
	}
	defer rows.Close()
	var clarinCurrent []string
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			clarinCurrent = append(clarinCurrent, name)
		}
	}
	rows.Close()

	// Read-before-write: fetch current Kommo tags
	kl, err := s.client.GetLeadByID(int(*kommoLeadID))
	if err != nil {
		log.Printf("[PUSH] Lead %s: failed to fetch Kommo lead %d: %v", leadID, *kommoLeadID, err)
		return
	}
	var kommoCurrent []string
	if kl.Embedded != nil {
		for _, t := range kl.Embedded.Tags {
			kommoCurrent = append(kommoCurrent, t.Name)
		}
	}

	// Three-way merge: compute diffs against baseline
	baselineSet := toStringSet(baseline)
	clarinSet := toStringSet(clarinCurrent)
	kommoSet := toStringSet(kommoCurrent)

	clarinAdded := diffSet(clarinSet, baselineSet)   // tags Clarin added since baseline
	clarinRemoved := diffSet(baselineSet, clarinSet) // tags Clarin removed since baseline

	// merged = (kommo_current ∪ clarin_added) - clarin_removed
	merged := copySet(kommoSet)
	for tag := range clarinAdded {
		merged[tag] = true
	}
	for tag := range clarinRemoved {
		delete(merged, tag)
	}

	mergedSlice := setToSlice(merged)

	// Build KommoTag list for API
	var tags []KommoTag
	for _, name := range mergedSlice {
		tags = append(tags, KommoTag{Name: name})
	}

	updatedAt, err := s.client.UpdateLeadTags(int(*kommoLeadID), tags)
	if err != nil {
		log.Printf("[PUSH] Lead %s tags to Kommo failed: %v", leadID, err)
		return
	}

	// Sync-back: add Kommo-only tags to Clarin (tags in merged but not in clarinSet)
	kommoOnlyTags := diffSet(merged, clarinSet)
	if len(kommoOnlyTags) > 0 {
		var contactID *uuid.UUID
		_ = s.db.QueryRow(ctx, `SELECT contact_id FROM leads WHERE id = $1`, leadID).Scan(&contactID)
		if contactID != nil {
			for tagName := range kommoOnlyTags {
				var tagID uuid.UUID
				err := s.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND name = $2`, accountID, tagName).Scan(&tagID)
				if err != nil {
					tagID = uuid.New()
					_, _ = s.db.Exec(ctx, `
						INSERT INTO tags (id, account_id, name, color, created_at, updated_at)
						VALUES ($1, $2, $3, '#6366f1', NOW(), NOW())
						ON CONFLICT (account_id, name) DO NOTHING
					`, tagID, accountID, tagName)
					_ = s.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND name = $2`, accountID, tagName).Scan(&tagID)
				}
				_, _ = s.db.Exec(ctx, `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, *contactID, tagID)
			}
		}
	}

	// Update baseline + anti-echo timestamp
	_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_synced_tags = $1, kommo_last_pushed_at = $2, tags = $1 WHERE id = $3`, mergedSlice, updatedAt, leadID)

	log.Printf("[PUSH] Lead %s tags → Kommo lead %d (3-way merge: %d baseline, %d clarin, %d kommo → %d merged)", leadID, *kommoLeadID, len(baseline), len(clarinCurrent), len(kommoCurrent), len(mergedSlice))
	s.Monitor.Log("push", fmt.Sprintf("Lead tags → Kommo lead %d (%d tags, 3-way merge)", *kommoLeadID, len(mergedSlice)), "info")
}

// PushContactTagsChange pushes all current tags of a contact to Kommo.
func (s *SyncService) PushContactTagsChange(accountID, contactID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if !s.isKommoEnabled(ctx, accountID) {
		return
	}

	var kommoContactID *int64
	err := s.db.QueryRow(ctx, `SELECT kommo_id FROM contacts WHERE id = $1 AND account_id = $2`, contactID, accountID).Scan(&kommoContactID)
	if err != nil || kommoContactID == nil {
		return
	}

	rows, err := s.db.Query(ctx, `
		SELECT t.id, t.name, t.kommo_id FROM contact_tags ct
		JOIN tags t ON ct.tag_id = t.id
		WHERE ct.contact_id = $1
	`, contactID)
	if err != nil {
		log.Printf("[PUSH] Contact %s: failed to fetch tags: %v", contactID, err)
		return
	}
	defer rows.Close()

	// Send tags by NAME only — Kommo resolves by name natively.
	var tags []KommoTag
	for rows.Next() {
		var tagLocalID uuid.UUID
		var name string
		var kommoTagID *int64
		if err := rows.Scan(&tagLocalID, &name, &kommoTagID); err != nil {
			continue
		}
		tags = append(tags, KommoTag{Name: name})
	}

	updatedAt, err := s.client.UpdateContactTags(int(*kommoContactID), tags)
	if err != nil {
		log.Printf("[PUSH] Contact %s tags to Kommo failed: %v", contactID, err)
		return
	}

	_, _ = s.db.Exec(ctx, `UPDATE contacts SET kommo_last_pushed_at = $1 WHERE id = $2`, updatedAt, contactID)
	log.Printf("[PUSH] Contact %s tags → Kommo contact %d (%d tags, updated_at=%d)", contactID, *kommoContactID, len(tags), updatedAt)
	s.Monitor.Log("push", fmt.Sprintf("Contact tags → Kommo contact %d (%d tags)", *kommoContactID, len(tags)), "info")
}

// PushNewLead creates a new lead (and optionally contact) in Kommo.
// Only acts if the lead's pipeline has a kommo_id (connected to Kommo).
func (s *SyncService) PushNewLead(accountID, leadID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if !s.isKommoEnabled(ctx, accountID) {
		return
	}

	// Fetch lead details (personal data from linked contact via COALESCE)
	var leadName, phone, email *string
	var pipelineID, stageID, contactID *uuid.UUID
	err := s.db.QueryRow(ctx, `
		SELECT COALESCE(c.custom_name, c.name, l.name), COALESCE(c.phone, l.phone), COALESCE(c.email, l.email),
		       l.pipeline_id, l.stage_id, l.contact_id
		FROM leads l
		LEFT JOIN contacts c ON c.id = l.contact_id
		WHERE l.id = $1 AND l.account_id = $2 AND l.kommo_id IS NULL
	`, leadID, accountID).Scan(&leadName, &phone, &email, &pipelineID, &stageID, &contactID)
	if err != nil {
		return // Lead not found or already has kommo_id
	}

	if pipelineID == nil || stageID == nil {
		return // No pipeline assigned
	}

	// Check if pipeline is connected to Kommo
	var kommoPipelineID *int64
	err = s.db.QueryRow(ctx, `SELECT kommo_id FROM pipelines WHERE id = $1`, *pipelineID).Scan(&kommoPipelineID)
	if err != nil || kommoPipelineID == nil {
		return // Not a Kommo pipeline
	}

	var kommoStageID *int64
	err = s.db.QueryRow(ctx, `SELECT kommo_id FROM pipeline_stages WHERE id = $1`, *stageID).Scan(&kommoStageID)
	if err != nil || kommoStageID == nil {
		return
	}

	name := ""
	if leadName != nil {
		name = *leadName
	}

	// Create lead in Kommo
	kommoLeadID, leadUpdatedAt, err := s.client.CreateLead(name, int(*kommoPipelineID), int(*kommoStageID), nil)
	if err != nil {
		log.Printf("[PUSH] Create lead %s in Kommo failed: %v", leadID, err)
		return
	}

	// Store kommo_id and pushed_at
	kommoIDVal := int64(kommoLeadID)
	_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_id = $1, kommo_last_pushed_at = $2 WHERE id = $3`,
		kommoIDVal, leadUpdatedAt, leadID)
	log.Printf("[PUSH] Created lead %s → Kommo lead %d", leadID, kommoLeadID)
	s.Monitor.Log("push", fmt.Sprintf("Nuevo lead creado → Kommo lead %d", kommoLeadID), "info")

	// Create contact in Kommo if exists and doesn't have kommo_id
	if contactID != nil {
		var contactKommoID *int64
		var cName, cLastName, cPhone, cEmail *string
		err = s.db.QueryRow(ctx, `
			SELECT kommo_id, name, last_name, phone, email
			FROM contacts WHERE id = $1
		`, *contactID).Scan(&contactKommoID, &cName, &cLastName, &cPhone, &cEmail)
		if err != nil {
			return
		}

		if contactKommoID == nil {
			// Create contact in Kommo
			cn := ""
			if cName != nil {
				cn = *cName
			}
			cfn := cn
			cln := ""
			if cLastName != nil {
				cln = *cLastName
			}
			cp := ""
			if cPhone != nil {
				cp = *cPhone
			}
			ce := ""
			if cEmail != nil {
				ce = *cEmail
			}

			kommoContactID, contactUpdatedAt, err := s.client.CreateContact(cn, cfn, cln, cp, ce)
			if err != nil {
				log.Printf("[PUSH] Create contact for lead %s failed: %v", leadID, err)
				return
			}

			contactKommoIDVal := int64(kommoContactID)
			_, _ = s.db.Exec(ctx, `UPDATE contacts SET kommo_id = $1, kommo_last_pushed_at = $2 WHERE id = $3`,
				contactKommoIDVal, contactUpdatedAt, *contactID)
			contactKommoID = &contactKommoIDVal
			log.Printf("[PUSH] Created contact %s → Kommo contact %d", *contactID, kommoContactID)
		}

		// Link contact to lead in Kommo
		if contactKommoID != nil {
			if err := s.client.LinkContactToLead(kommoLeadID, int(*contactKommoID)); err != nil {
				log.Printf("[PUSH] Link contact %d to lead %d failed: %v", *contactKommoID, kommoLeadID, err)
			}
		}
	}
}

// PushLeadObservations reads all call interactions for a lead and pushes them
// to Kommo's 10 call custom field slots + "Otras llamadas" overflow.
// Only pushes locally-created calls (excludes (sinc) synced ones).
func (s *SyncService) PushLeadObservations(accountID, leadID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if !s.isKommoEnabled(ctx, accountID) {
		return
	}

	var kommoLeadID *int64
	err := s.db.QueryRow(ctx, `SELECT kommo_id FROM leads WHERE id = $1 AND account_id = $2`, leadID, accountID).Scan(&kommoLeadID)
	if err != nil || kommoLeadID == nil {
		return // Not a Kommo lead
	}

	// Get only locally-created call interactions (exclude synced ones with "(sinc)" prefix)
	rows, err := s.db.Query(ctx, `
		SELECT i.id, i.notes, i.created_at, u.display_name
		FROM interactions i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.lead_id = $1 AND i.type = 'call'
		  AND (i.notes IS NULL OR i.notes NOT LIKE '(sinc)%')
		ORDER BY i.created_at ASC
	`, leadID)
	if err != nil {
		log.Printf("[PUSH] Lead %s: failed to fetch call interactions: %v", leadID, err)
		return
	}
	defer rows.Close()

	type callData struct {
		id        uuid.UUID
		notes     string
		createdAt time.Time
		createdBy string
	}
	var calls []callData
	for rows.Next() {
		var cd callData
		var notes *string
		var createdBy *string
		if err := rows.Scan(&cd.id, &notes, &cd.createdAt, &createdBy); err != nil {
			continue
		}
		if notes != nil {
			cd.notes = *notes
		}
		if createdBy != nil {
			cd.createdBy = *createdBy
		}
		calls = append(calls, cd)
	}

	// Build custom fields for the 10 slots
	var fields []KommoCustomFieldWrite

	for slot := 0; slot < KommoCallSlotCount; slot++ {
		if slot < len(calls) {
			call := calls[slot]

			// Responsable: user who created + date
			responsable := call.createdBy
			if responsable == "" {
				responsable = "Clarin"
			}
			fecha := call.createdAt.Format("02/01/2006 15:04")
			responsable = fecha + " " + responsable

			fields = append(fields,
				KommoCustomFieldWrite{
					FieldID: KommoCallFieldResponsable[slot],
					Values:  []KommoCustomFieldWriteVal{{Value: responsable}},
				},
				KommoCustomFieldWrite{
					FieldID: KommoCallFieldResultado[slot],
					Values:  []KommoCustomFieldWriteVal{{Value: call.notes}},
				},
			)
		} else {
			// Clear empty slots — Kommo requires exactly 1 value element
			fields = append(fields,
				KommoCustomFieldWrite{
					FieldID: KommoCallFieldResponsable[slot],
					Values:  []KommoCustomFieldWriteVal{{Value: ""}},
				},
				KommoCustomFieldWrite{
					FieldID: KommoCallFieldResultado[slot],
					Values:  []KommoCustomFieldWriteVal{{Value: ""}},
				},
			)
		}
	}

	// Build "Otras llamadas" overflow for calls beyond 10
	if len(calls) > KommoCallSlotCount {
		var b strings.Builder
		for i := KommoCallSlotCount; i < len(calls); i++ {
			call := calls[i]
			createdBy := call.createdBy
			if createdBy == "" {
				createdBy = "Clarin"
			}
			fmt.Fprintf(&b, "Llamada %d - %s %s: %s\n",
				i+1, call.createdAt.Format("02/01/2006 15:04"), createdBy, call.notes)
		}
		fields = append(fields, KommoCustomFieldWrite{
			FieldID: KommoCallFieldOtrasLlamadas,
			Values:  []KommoCustomFieldWriteVal{{Value: b.String()}},
		})
	} else {
		fields = append(fields, KommoCustomFieldWrite{
			FieldID: KommoCallFieldOtrasLlamadas,
			Values:  []KommoCustomFieldWriteVal{{Value: ""}},
		})
	}

	updatedAt, err := s.client.UpdateLeadCustomFields(int(*kommoLeadID), fields)
	if err != nil {
		log.Printf("[PUSH] Lead %s observations to Kommo failed: %v", leadID, err)
		return
	}

	// Remove all (sinc) entries — they are echoes of Kommo data that we just overwrote
	_, _ = s.db.Exec(ctx, `DELETE FROM interactions WHERE lead_id = $1 AND type = 'call' AND notes LIKE '(sinc)%'`, leadID)

	// Assign kommo_call_slot to local interactions so syncCallsFromKommo won't overwrite them
	for i, call := range calls {
		if i < KommoCallSlotCount {
			slotNum := i + 1
			_, _ = s.db.Exec(ctx, `UPDATE interactions SET kommo_call_slot = $1 WHERE id = $2`, slotNum, call.id)
		}
	}

	_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = $1 WHERE id = $2`, updatedAt, leadID)
	log.Printf("[PUSH] Lead %s observations → Kommo lead %d (%d calls, updated_at=%d)", leadID, *kommoLeadID, len(calls), updatedAt)
	s.Monitor.Log("push", fmt.Sprintf("Lead observaciones → Kommo lead %d (%d llamadas)", *kommoLeadID, len(calls)), "info")
}

// PushLeadName pushes a lead's name change to Kommo (both lead and linked contact).
func (s *SyncService) PushLeadName(accountID, leadID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if !s.isKommoEnabled(ctx, accountID) {
		return
	}

	var kommoLeadID *int64
	var leadName *string
	err := s.db.QueryRow(ctx, `SELECT l.kommo_id, COALESCE(c.custom_name, c.name, l.name) FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id WHERE l.id = $1 AND l.account_id = $2`, leadID, accountID).Scan(&kommoLeadID, &leadName)
	if err != nil || kommoLeadID == nil {
		return // Not a Kommo lead
	}

	name := ""
	if leadName != nil {
		name = *leadName
	}
	if name == "" {
		return // Nothing to push
	}

	updatedAt, err := s.client.UpdateLeadName(int(*kommoLeadID), name)
	if err != nil {
		log.Printf("[PUSH] Lead %s name to Kommo failed: %v", leadID, err)
		return
	}

	_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = $1 WHERE id = $2`, updatedAt, leadID)
	log.Printf("[PUSH] Lead %s name '%s' → Kommo lead %d (updated_at=%d)", leadID, name, *kommoLeadID, updatedAt)
	s.Monitor.Log("push", fmt.Sprintf("Lead nombre '%s' → Kommo lead %d", name, *kommoLeadID), "info")

	// Also update the linked contact name in Kommo
	var kommoContactID *int64
	err = s.db.QueryRow(ctx, `
		SELECT c.kommo_id FROM contacts c
		JOIN leads l ON l.contact_id = c.id
		WHERE l.id = $1 AND c.kommo_id IS NOT NULL
	`, leadID).Scan(&kommoContactID)
	if err == nil && kommoContactID != nil {
		contactUpdatedAt, err := s.client.UpdateContactName(int(*kommoContactID), name)
		if err != nil {
			log.Printf("[PUSH] Contact for lead %s name to Kommo failed: %v", leadID, err)
		} else {
			log.Printf("[PUSH] Contact name '%s' → Kommo contact %d (updated_at=%d)", name, *kommoContactID, contactUpdatedAt)
		}
	}
}

// PushPipelineStageChange updates the pipeline and/or stage of a lead in Kommo.
func (s *SyncService) PushPipelineStageChange(accountID, leadID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if !s.isKommoEnabled(ctx, accountID) {
		return
	}

	var kommoID *int64
	var pipelineKommoID *int64
	var stageKommoID *int64

	// Get lead's kommo_id and current pipeline/stage kommo ids
	err := s.db.QueryRow(ctx, `
		SELECT l.kommo_id, p.kommo_id, s.kommo_id
		FROM leads l
		LEFT JOIN pipelines p ON l.pipeline_id = p.id
		LEFT JOIN pipeline_stages s ON l.stage_id = s.id
		WHERE l.id = $1 AND l.account_id = $2
	`, leadID, accountID).Scan(&kommoID, &pipelineKommoID, &stageKommoID)

	if err != nil {
		log.Printf("[PUSH] Failed to get lead/pipeline info for %s: %v", leadID, err)
		return
	}
	if kommoID == nil || *kommoID == 0 {
		return // Not a Kommo lead
	}
	if pipelineKommoID == nil || stageKommoID == nil {
		// Lead moved to unsynced pipeline.
		return
	}

	updatedAt, err := s.client.UpdateLeadStatus(int(*kommoID), int(*stageKommoID), int(*pipelineKommoID))
	if err != nil {
		log.Printf("[PUSH] Update lead %s pipeline/stage in Kommo failed: %v", leadID, err)
		return
	}

	// Record echo prevention
	_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = $1 WHERE id = $2`, updatedAt, leadID)
	log.Printf("[PUSH] Lead %s pipeline/stage updated in Kommo (ts=%d)", leadID, updatedAt)
	s.Monitor.Log("push", fmt.Sprintf("Lead pipeline/etapa → Kommo lead %d", *kommoID), "info")
}

// ─── Enqueue* helpers: batched push entry points ──────────────────────────
//
// These are the preferred way to schedule Kommo writes. They insert a row
// into kommo_push_outbox (coalesced by (entity, operation)) and return
// immediately. The Outbox worker drains the queue every flush interval and
// sends bulk PATCH /leads or /contacts with up to batch size items.
//
// If the outbox is nil (feature disabled), callers fall back to the legacy
// direct Push* goroutines. Handlers can always call these helpers — they
// no-op cleanly when Kommo is disabled for the account.

// EnqueuePushLeadName coalesces a name push for a lead. If the lead has a
// linked contact in Kommo, the contact's name is also queued.
func (s *SyncService) EnqueuePushLeadName(accountID, leadID uuid.UUID) {
	if s.Outbox == nil {
		go s.PushLeadName(accountID, leadID)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !s.isKommoEnabled(ctx, accountID) {
		return
	}
	var kommoLeadID, kommoContactID *int64
	err := s.db.QueryRow(ctx, `
		SELECT l.kommo_id, c.kommo_id
		FROM leads l
		LEFT JOIN contacts c ON c.id = l.contact_id
		WHERE l.id = $1 AND l.account_id = $2
	`, leadID, accountID).Scan(&kommoLeadID, &kommoContactID)
	if err != nil || kommoLeadID == nil || *kommoLeadID == 0 {
		return
	}
	if err := s.Outbox.Enqueue(ctx, accountID, leadID, *kommoLeadID, OpLeadName, nil); err != nil {
		log.Printf("[OUTBOX] EnqueuePushLeadName lead=%s: %v", leadID, err)
	}
	if kommoContactID != nil && *kommoContactID > 0 {
		// Resolve contact_id for the coalescing key.
		var contactID *uuid.UUID
		_ = s.db.QueryRow(ctx, `SELECT contact_id FROM leads WHERE id = $1`, leadID).Scan(&contactID)
		if contactID != nil {
			if err := s.Outbox.Enqueue(ctx, accountID, *contactID, *kommoContactID, OpContactName, nil); err != nil {
				log.Printf("[OUTBOX] EnqueuePushLeadName (contact) lead=%s: %v", leadID, err)
			}
		}
	}
}

// EnqueuePushLeadStage coalesces a pipeline/stage change for a lead.
// Reads the current pipeline/stage from DB at flush time.
func (s *SyncService) EnqueuePushLeadStage(accountID, leadID uuid.UUID) {
	if s.Outbox == nil {
		go s.PushPipelineStageChange(accountID, leadID)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !s.isKommoEnabled(ctx, accountID) {
		return
	}
	var kommoLeadID *int64
	err := s.db.QueryRow(ctx, `SELECT kommo_id FROM leads WHERE id = $1 AND account_id = $2`, leadID, accountID).Scan(&kommoLeadID)
	if err != nil || kommoLeadID == nil || *kommoLeadID == 0 {
		return
	}
	if err := s.Outbox.Enqueue(ctx, accountID, leadID, *kommoLeadID, OpLeadStage, nil); err != nil {
		log.Printf("[OUTBOX] EnqueuePushLeadStage lead=%s: %v", leadID, err)
	}
}

// EnqueuePushLeadStageForced queues a pipeline/stage change with explicit
// Kommo ids. Used when the local lead is about to be deleted (e.g., the
// delete→Perdido flow) so the flusher cannot read from the `leads` table.
// Pass the Kommo lead_id, Kommo status_id (143 for Perdido), and Kommo pipeline_id.
func (s *SyncService) EnqueuePushLeadStageForced(accountID, leadID uuid.UUID, kommoLeadID, kommoStatusID, kommoPipelineID int64) {
	if s.Outbox == nil {
		// Fallback: synchronous direct call.
		_, err := s.client.UpdateLeadStatus(int(kommoLeadID), int(kommoStatusID), int(kommoPipelineID))
		if err != nil {
			log.Printf("[PUSH] Forced stage fallback failed for lead %s: %v", leadID, err)
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !s.isKommoEnabled(ctx, accountID) {
		return
	}
	payload := map[string]int64{
		"status_id":   kommoStatusID,
		"pipeline_id": kommoPipelineID,
	}
	if err := s.Outbox.Enqueue(ctx, accountID, leadID, kommoLeadID, OpLeadStageForced, payload); err != nil {
		log.Printf("[OUTBOX] EnqueuePushLeadStageForced lead=%s: %v", leadID, err)
	}
}

// EnqueuePushLeadTags coalesces a lead tag push. The 3-way merge and sync-back
// are executed at flush time against the latest DB state.
func (s *SyncService) EnqueuePushLeadTags(accountID, leadID uuid.UUID) {
	if s.Outbox == nil {
		go s.PushLeadTagsChange(accountID, leadID)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !s.isKommoEnabled(ctx, accountID) {
		return
	}
	var kommoLeadID *int64
	err := s.db.QueryRow(ctx, `SELECT kommo_id FROM leads WHERE id = $1 AND account_id = $2`, leadID, accountID).Scan(&kommoLeadID)
	if err != nil || kommoLeadID == nil || *kommoLeadID == 0 {
		return
	}
	if err := s.Outbox.Enqueue(ctx, accountID, leadID, *kommoLeadID, OpLeadTags, nil); err != nil {
		log.Printf("[OUTBOX] EnqueuePushLeadTags lead=%s: %v", leadID, err)
	}
}

// EnqueuePushLeadObservations coalesces the observations (custom-fields calls) push.
func (s *SyncService) EnqueuePushLeadObservations(accountID, leadID uuid.UUID) {
	if s.Outbox == nil {
		go s.PushLeadObservations(accountID, leadID)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !s.isKommoEnabled(ctx, accountID) {
		return
	}
	var kommoLeadID *int64
	err := s.db.QueryRow(ctx, `SELECT kommo_id FROM leads WHERE id = $1 AND account_id = $2`, leadID, accountID).Scan(&kommoLeadID)
	if err != nil || kommoLeadID == nil || *kommoLeadID == 0 {
		return
	}
	if err := s.Outbox.Enqueue(ctx, accountID, leadID, *kommoLeadID, OpLeadCustomFields, nil); err != nil {
		log.Printf("[OUTBOX] EnqueuePushLeadObservations lead=%s: %v", leadID, err)
	}
}

// EnqueuePushContactTags coalesces a contact tag push.
func (s *SyncService) EnqueuePushContactTags(accountID, contactID uuid.UUID) {
	if s.Outbox == nil {
		go s.PushContactTagsChange(accountID, contactID)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !s.isKommoEnabled(ctx, accountID) {
		return
	}
	var kommoContactID *int64
	err := s.db.QueryRow(ctx, `SELECT kommo_id FROM contacts WHERE id = $1 AND account_id = $2`, contactID, accountID).Scan(&kommoContactID)
	if err != nil || kommoContactID == nil || *kommoContactID == 0 {
		return
	}
	if err := s.Outbox.Enqueue(ctx, accountID, contactID, *kommoContactID, OpContactTags, nil); err != nil {
		log.Printf("[OUTBOX] EnqueuePushContactTags contact=%s: %v", contactID, err)
	}
}

// --- Helpers ---

func normalizePhone(phone string) string {
	phone = strings.TrimSpace(phone)
	phone = strings.TrimPrefix(phone, "'")
	phone = strings.ReplaceAll(phone, " ", "")
	phone = strings.ReplaceAll(phone, "-", "")
	phone = strings.ReplaceAll(phone, "(", "")
	phone = strings.ReplaceAll(phone, ")", "")
	phone = strings.TrimPrefix(phone, "+")
	// Auto-add Peru country code for 9-digit numbers starting with 9
	if len(phone) == 9 && strings.HasPrefix(phone, "9") {
		phone = "51" + phone
	}
	return phone
}

// NormalizePhone is the exported version for use by other packages.
func NormalizePhone(phone string) string {
	return normalizePhone(phone)
}

func kommoColorToHex(color string) string {
	if strings.HasPrefix(color, "#") {
		return color
	}
	return "#6366f1"
}

func cleanQuotes(s string) string {
	return strings.TrimPrefix(strings.TrimSpace(s), "'")
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// SyncSingleContact fetches a contact from Kommo by its kommo_id and updates Clarin.
// This is a synchronous operation for on-demand use.
func (s *SyncService) SyncSingleContact(ctx context.Context, accountID, contactID uuid.UUID) error {
	var kommoID *int64
	err := s.db.QueryRow(ctx, `SELECT kommo_id FROM contacts WHERE id = $1 AND account_id = $2`, contactID, accountID).Scan(&kommoID)
	if err != nil {
		return fmt.Errorf("contact not found")
	}
	if kommoID == nil {
		return fmt.Errorf("contact not linked to Kommo")
	}

	kc, err := s.client.GetContactByID(int(*kommoID))
	if err != nil {
		return fmt.Errorf("failed to fetch from Kommo: %w", err)
	}

	_, _ = s.upsertContact(ctx, accountID, *kc)
	log.Printf("[Kommo Sync] Manual contact sync: %s (Kommo ID %d)", contactID, *kommoID)
	return nil
}

// SyncSingleLead fetches a lead from Kommo by its kommo_id and updates Clarin.
// Updates name, email, tags, pipeline/stage from Kommo. For calls, only adds new
// ones from Kommo without overwriting locally-created calls.
func (s *SyncService) SyncSingleLead(ctx context.Context, accountID, leadID uuid.UUID) error {
	var kommoID *int64
	err := s.db.QueryRow(ctx, `SELECT kommo_id FROM leads WHERE id = $1 AND account_id = $2`, leadID, accountID).Scan(&kommoID)
	if err != nil {
		return fmt.Errorf("lead not found")
	}
	if kommoID == nil {
		return fmt.Errorf("lead not linked to Kommo")
	}

	kl, err := s.client.GetLeadByID(int(*kommoID))
	if err != nil {
		return fmt.Errorf("failed to fetch from Kommo: %w", err)
	}

	// Clear anti-loop flag so the upsert performs a full update
	_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = 0 WHERE id = $1`, leadID)

	if _, err := s.upsertLead(ctx, accountID, *kl, nil); err != nil {
		return fmt.Errorf("failed to update from Kommo: %w", err)
	}

	log.Printf("[Kommo Sync] Manual lead sync: %s (Kommo ID %d)", leadID, *kommoID)
	return nil
}

// eventsPoller uses the Kommo Events API to detect ALL changes (including UI tag edits
// that webhooks miss). Runs with an adaptive interval: 15s target, minimum 2s pause.
func (s *SyncService) eventsPoller() {
	// Initial delay: let startup (pipelines, webhook registration) finish
	select {
	case <-time.After(30 * time.Second):
	case <-s.stopCh:
		return
	}

	log.Println("[EventsPoller] Started (15s adaptive interval, Events API)")

	for {
		select {
		case <-s.stopCh:
			return
		default:
		}

		start := time.Now()
		s.pollEvents()
		elapsed := time.Since(start)

		// Adaptive wait: target 15s between poll starts, minimum 2s pause
		wait := 15*time.Second - elapsed
		if wait < 2*time.Second {
			wait = 2 * time.Second
		}

		select {
		case <-time.After(wait):
		case <-s.stopCh:
			return
		}
	}
}

// eventTypesFilter is the comma-separated list of Kommo event types to monitor.
const eventTypesFilter = "entity_tag_added,entity_tag_deleted,lead_status_changed,custom_field_value_changed,entity_responsible_changed,name_field_changed,sale_field_changed"

// pollEvents fetches recent events from the Kommo Events API and syncs affected leads.
func (s *SyncService) pollEvents() {
	start := time.Now()
	s.eventsPollerMu.Lock()
	since := s.lastEventPoll - 5 // 5s overlap to avoid gaps
	s.eventsPollerMu.Unlock()

	// Skip if a full sync is running
	s.fullSyncMu.RLock()
	for _, st := range s.fullSync {
		if st.Running {
			s.fullSyncMu.RUnlock()
			return
		}
	}
	s.fullSyncMu.RUnlock()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// Fetch events from Kommo
	seenEventIDs := make(map[string]bool)
	leadIDSet := make(map[int]bool)

	for page := 1; page <= 5; page++ { // Max 500 events per cycle
		events, hasMore, err := s.client.GetEvents(since, eventTypesFilter, "lead", page)
		if err != nil {
			log.Printf("[EventsPoller] Error fetching events page %d: %v", page, err)
			break
		}

		for _, ev := range events {
			if seenEventIDs[ev.ID] {
				continue
			}
			seenEventIDs[ev.ID] = true

			if ev.EntityType == "lead" && ev.EntityID > 0 {
				leadIDSet[ev.EntityID] = true
			}
		}

		if !hasMore {
			break
		}
	}

	totalEvents := len(seenEventIDs)

	// Update cursor to now
	now := time.Now().Unix()
	s.eventsPollerMu.Lock()
	s.lastEventPoll = now
	s.lastEventPollAt = time.Now()
	s.lastEventPollEvents = totalEvents
	s.eventsPollerMu.Unlock()

	if len(leadIDSet) == 0 {
		s.Monitor.LogEvent(SyncMonitorEvent{Source: "events_poller", Message: fmt.Sprintf("Poll completado: %d eventos, sin cambios de leads", totalEvents), Operation: "poll_events", Status: "no_changes", Direction: "inbound", DurationMS: time.Since(start).Milliseconds(), RequestCount: 1, Details: map[string]interface{}{"events": totalEvents}})
		return
	}

	// Collect all affected lead IDs (no cooldown filtering — three-way merge handles echoes)
	var leadIDs []int
	for id := range leadIDSet {
		leadIDs = append(leadIDs, id)
	}

	// Batch fetch leads from Kommo
	leadsMap, err := s.client.GetLeadsByIDs(leadIDs)
	if err != nil {
		log.Printf("[EventsPoller] Error batch fetching %d leads: %v", len(leadIDs), err)
		s.Monitor.LogEvent(SyncMonitorEvent{Source: "events_poller", Message: fmt.Sprintf("Error fetching %d leads: %v", len(leadIDs), err), Level: "error", EntityType: "lead", Operation: "fetch_leads", Direction: "inbound", DurationMS: time.Since(start).Milliseconds(), RequestCount: 1, BatchSize: len(leadIDs), Details: map[string]interface{}{"error": err.Error(), "lead_ids": leadIDs}})
		return
	}

	if len(leadsMap) == 0 {
		return
	}

	// Convert to slice for batchFetchContacts
	var leadSlice []KommoLead
	for _, kl := range leadsMap {
		leadSlice = append(leadSlice, kl)
	}

	// Batch fetch contacts for these leads
	contacts := s.batchFetchContacts(leadSlice)

	// Get all accounts assigned to this Kommo instance.
	accounts, err := s.assignedAccounts(ctx)
	if err != nil {
		log.Printf("[EventsPoller] Error fetching accounts: %v", err)
		return
	}
	if len(accounts) == 0 {
		return
	}

	// Sync each lead to all accounts (espejo total)
	synced := 0
	accountCounts := make(map[uuid.UUID]int)
	accountNames := make(map[uuid.UUID]string)
	for _, kl := range leadSlice {
		var prefetched *KommoContact
		if kl.Embedded != nil && len(kl.Embedded.Contacts) > 0 {
			if c, ok := contacts[kl.Embedded.Contacts[0].ID]; ok {
				prefetched = &c
			}
		}

		for _, account := range accounts {
			accountNames[account.ID] = account.Name
			changed, err := s.upsertLead(ctx, account.ID, kl, prefetched)
			if err != nil {
				continue
			}
			if changed {
				synced++
				accountCounts[account.ID]++
				if s.hub != nil {
					s.hub.BroadcastToAccount(account.ID, ws.EventLeadUpdate, map[string]interface{}{"action": "updated"})
				}
			}
		}
	}

	// Update stats
	s.eventsPollerMu.Lock()
	s.lastEventPollLeads = synced
	s.eventsPollerMu.Unlock()

	affectedAccounts := make([]map[string]interface{}, 0, len(accountCounts))
	for accountID, count := range accountCounts {
		name := accountNames[accountID]
		affectedAccounts = append(affectedAccounts, map[string]interface{}{"id": accountID.String(), "name": name, "leads_synced": count})
		localAccountID := accountID
		s.Monitor.LogEvent(SyncMonitorEvent{Source: "events_poller", Message: fmt.Sprintf("Pull actualizó %d lead(s) en %s", count, name), AccountID: &localAccountID, EntityType: "lead", Operation: "poll_sync", Status: "updated", Direction: "inbound", DurationMS: time.Since(start).Milliseconds(), RequestCount: 2, BatchSize: count, Details: map[string]interface{}{"account_name": name, "events": totalEvents}})
	}
	s.Monitor.LogEvent(SyncMonitorEvent{Source: "events_poller", Message: fmt.Sprintf("Poll completado: %d eventos, %d leads obtenidos, %d sincronizados", totalEvents, len(leadSlice), synced), EntityType: "lead", Operation: "poll_events", Status: "completed", Direction: "inbound", DurationMS: time.Since(start).Milliseconds(), RequestCount: 2, BatchSize: len(leadSlice), Details: map[string]interface{}{"events": totalEvents, "lead_ids": leadIDs, "affected_accounts": affectedAccounts}})

	if synced > 0 {
		log.Printf("[EventsPoller] Synced %d lead changes across %d accounts (%d events, %d leads fetched)", synced, len(accounts), totalEvents, len(leadSlice))
		// Trigger event reconciliation for tag changes
		if s.OnLeadTagsChanged != nil {
			for _, account := range accounts {
				s.OnLeadTagsChanged(ctx, account.ID)
			}
		}
	}
}

// ForceEventsPoll triggers an immediate events poll cycle.
// Returns the number of events found and leads synced.
func (s *SyncService) ForceEventsPoll() (int, int) {
	s.eventsPollerMu.Lock()
	// Check if already running
	s.eventsPollerMu.Unlock()

	log.Println("[EventsPoller] Manual poll triggered")
	s.Monitor.Log("events_poller", "Poll manual forzado", "info")
	s.pollEvents()

	s.eventsPollerMu.Lock()
	defer s.eventsPollerMu.Unlock()
	return s.lastEventPollEvents, s.lastEventPollLeads
}

// GetEventsPollerStatus returns the current status of the events poller.
func (s *SyncService) GetEventsPollerStatus() map[string]interface{} {
	s.eventsPollerMu.Lock()
	defer s.eventsPollerMu.Unlock()

	result := map[string]interface{}{
		"interval_seconds":       15,
		"last_poll_events_found": s.lastEventPollEvents,
		"last_poll_leads_synced": s.lastEventPollLeads,
	}

	if !s.lastEventPollAt.IsZero() {
		result["last_poll_at"] = s.lastEventPollAt.Format(time.RFC3339)
		result["seconds_since_last_poll"] = int(time.Since(s.lastEventPollAt).Seconds())
	}

	return result
}

// reconcileLoop runs a periodic full reconciliation of all synced pipelines.
// It detects leads that exist in Clarin but are no longer in their Kommo pipeline
// (moved, deleted, or archived) and fixes them via SyncSingleLead.
func (s *SyncService) reconcileLoop() {
	// Initial delay: wait 2 minutes after startup to let the poller warm up
	select {
	case <-time.After(2 * time.Minute):
	case <-s.stopCh:
		return
	}

	log.Println("[Reconcile] Running initial reconciliation cycle")
	s.Monitor.Log("reconcile", "Iniciando ciclo de reconciliación", "info")
	s.runReconciliation()

	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.runReconciliation()
		}
	}
}

// runReconciliation reconciles all accounts with enabled pipelines.
func (s *SyncService) runReconciliation() {
	start := time.Now()
	// Re-sync all Kommo pipelines to all accounts (espejo total)
	s.syncAllKommoPipelines()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT kcp.account_id
		FROM kommo_connected_pipelines kcp
		JOIN accounts a ON a.id = kcp.account_id
		WHERE kcp.enabled = TRUE
		  AND kcp.integration_instance_id IS NOT DISTINCT FROM $1
		  AND ($1::uuid IS NOT NULL OR a.kommo_enabled = TRUE)
	`, s.instanceArg())
	if err != nil {
		log.Printf("[Reconcile] Error querying accounts: %v", err)
		s.Monitor.LogEvent(SyncMonitorEvent{Source: "reconcile", Message: fmt.Sprintf("Error consultando cuentas: %v", err), Level: "error", Operation: "query_accounts", Direction: "inbound", DurationMS: time.Since(start).Milliseconds(), Details: map[string]interface{}{"error": err.Error()}})
		return
	}
	defer rows.Close()

	var accountIDs []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			accountIDs = append(accountIDs, id)
		}
	}
	rows.Close()

	for _, accountID := range accountIDs {
		// Skip if a full sync is already running for this account
		s.fullSyncMu.RLock()
		if st, ok := s.fullSync[accountID]; ok && st.Running {
			s.fullSyncMu.RUnlock()
			continue
		}
		s.fullSyncMu.RUnlock()

		s.reconcileAccount(ctx, accountID, false)
	}
	s.Monitor.LogEvent(SyncMonitorEvent{Source: "reconcile", Message: fmt.Sprintf("Ciclo de reconciliación completado: %d cuenta(s)", len(accountIDs)), Operation: "reconcile_cycle", Status: "completed", Direction: "inbound", DurationMS: time.Since(start).Milliseconds(), BatchSize: len(accountIDs)})
}

// reconcileAccount checks all leads in synced pipelines for a single account.
// For each synced pipeline, it compares Clarin's leads vs Kommo's leads and
// re-syncs any that are in Clarin but no longer in that Kommo pipeline.
func (s *SyncService) reconcileAccount(ctx context.Context, accountID uuid.UUID, unlimited bool) {
	pipelines, err := s.GetConnectedPipelines(ctx, accountID)
	if err != nil {
		log.Printf("[Reconcile] Account %s: error getting pipelines: %v", accountID, err)
		s.Monitor.LogEvent(SyncMonitorEvent{Source: "reconcile", Message: fmt.Sprintf("Cuenta %s: error obteniendo pipelines: %v", accountID, err), Level: "error", AccountID: &accountID, Operation: "reconcile_account", Direction: "inbound", Details: map[string]interface{}{"error": err.Error()}})
		return
	}

	totalFixed := 0
	for _, cp := range pipelines {
		if !cp.Enabled || cp.PipelineID == nil {
			continue
		}

		fixed, err := s.reconcilePipeline(ctx, accountID, *cp.PipelineID, int(cp.KommoPipelineID), unlimited)
		if err != nil {
			log.Printf("[Reconcile] Account %s pipeline %d: error: %v", accountID, cp.KommoPipelineID, err)
			continue
		}
		totalFixed += fixed
	}

	if totalFixed > 0 {
		log.Printf("[Reconcile] Account %s: fixed %d desynchronized leads", accountID, totalFixed)
		s.Monitor.LogEvent(SyncMonitorEvent{Source: "reconcile", Message: fmt.Sprintf("Cuenta %s: corregidos %d leads desincronizados", accountID, totalFixed), AccountID: &accountID, EntityType: "lead", Operation: "reconcile_account", Status: "fixed", Direction: "inbound", BatchSize: totalFixed, Details: map[string]interface{}{"pipelines": len(pipelines), "fixed_leads": totalFixed}})
		if s.hub != nil {
			s.hub.BroadcastToAccount(accountID, ws.EventLeadUpdate, map[string]interface{}{"action": "reconciled"})
		}
		if s.OnLeadTagsChanged != nil {
			s.OnLeadTagsChanged(ctx, accountID)
		}
	}
}

// reconcilePipeline compares leads in a single Clarin pipeline against Kommo.
// Returns the number of leads that were fixed (stale re-synced + missing imported).
func (s *SyncService) reconcilePipeline(ctx context.Context, accountID uuid.UUID, pipelineID uuid.UUID, kommoPipelineID int, unlimited bool) (int, error) {
	// 1. Fetch ALL leads from Kommo for this pipeline (no date filter)
	kommoIDs := make(map[int64]bool)
	kommoLeads := make(map[int64]KommoLead)
	page := 1
	for {
		leads, hasMore, err := s.client.GetLeadsForPipeline(kommoPipelineID, 0, page)
		if err != nil {
			if strings.Contains(err.Error(), "204") || strings.Contains(err.Error(), "No content") {
				break
			}
			return 0, fmt.Errorf("fetch Kommo leads page %d: %w", page, err)
		}
		for _, kl := range leads {
			kid := int64(kl.ID)
			kommoIDs[kid] = true
			kommoLeads[kid] = kl
		}
		if !hasMore || len(leads) == 0 {
			break
		}
		page++
	}

	// 2. Get all kommo_ids from Clarin that claim to be in this pipeline
	rows, err := s.db.Query(ctx, `
		SELECT id, kommo_id FROM leads
		WHERE account_id = $1 AND pipeline_id = $2 AND kommo_id IS NOT NULL AND kommo_deleted_at IS NULL
	`, accountID, pipelineID)
	if err != nil {
		return 0, fmt.Errorf("query Clarin leads: %w", err)
	}
	defer rows.Close()

	type staleEntry struct {
		leadID  uuid.UUID
		kommoID int64
	}
	var stale []staleEntry
	clarinKommoIDs := make(map[int64]bool)
	for rows.Next() {
		var leadID uuid.UUID
		var kid int64
		if err := rows.Scan(&leadID, &kid); err != nil {
			continue
		}
		clarinKommoIDs[kid] = true
		if !kommoIDs[kid] {
			stale = append(stale, staleEntry{leadID, kid})
		}
	}
	rows.Close()

	fixed := 0

	// 3. Re-sync each stale lead individually (in Clarin but not in Kommo pipeline)
	if len(stale) > 0 {
		log.Printf("[Reconcile] Pipeline %d: found %d leads in Clarin but not in Kommo pipeline (out of %d Kommo / %d Clarin checked)",
			kommoPipelineID, len(stale), len(kommoIDs), len(clarinKommoIDs))

		maxPerCycle := 200
		for i, entry := range stale {
			if !unlimited && i >= maxPerCycle {
				log.Printf("[Reconcile] Pipeline %d: stale batch limit (%d), remaining %d will be processed next cycle",
					kommoPipelineID, maxPerCycle, len(stale)-maxPerCycle)
				break
			}
			if err := s.SyncSingleLead(ctx, accountID, entry.leadID); err != nil {
				if strings.Contains(err.Error(), "eliminado") || strings.Contains(err.Error(), "archivado") {
					_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, entry.leadID)
					log.Printf("[Reconcile] Lead %s (Kommo %d): deleted/archived in Kommo → marked as kommo_deleted (kept in pipeline)", entry.leadID, entry.kommoID)
					fixed++
				} else {
					log.Printf("[Reconcile] Lead %s (Kommo %d): sync error: %v", entry.leadID, entry.kommoID, err)
				}
				continue
			}
			fixed++
		}
	}

	// 4. Import missing leads (in Kommo but not in Clarin) — reverse reconciliation
	var missing []KommoLead
	for kid, kl := range kommoLeads {
		if !clarinKommoIDs[kid] {
			missing = append(missing, kl)
		}
	}

	if len(missing) > 0 {
		log.Printf("[Reconcile] Pipeline %d: found %d leads in Kommo but not in Clarin → importing",
			kommoPipelineID, len(missing))

		// Batch-fetch contacts to avoid N+1 API calls
		maxImportPerCycle := 200
		toImport := missing
		if !unlimited && len(toImport) > maxImportPerCycle {
			log.Printf("[Reconcile] Pipeline %d: import batch limit (%d), remaining %d will be processed next cycle",
				kommoPipelineID, maxImportPerCycle, len(missing)-maxImportPerCycle)
			toImport = toImport[:maxImportPerCycle]
		}

		contactMap := s.batchFetchContacts(toImport)
		imported := 0
		for _, kl := range toImport {
			var prefetched *KommoContact
			if contactMap != nil && kl.Embedded != nil && len(kl.Embedded.Contacts) > 0 {
				if c, ok := contactMap[kl.Embedded.Contacts[0].ID]; ok {
					prefetched = &c
				}
			}
			_, err := s.upsertLead(ctx, accountID, kl, prefetched)
			if err != nil {
				log.Printf("[Reconcile] Pipeline %d: import Kommo %d error: %v", kommoPipelineID, kl.ID, err)
				continue
			}
			imported++
		}
		fixed += imported
		log.Printf("[Reconcile] Pipeline %d: imported %d/%d missing leads from Kommo", kommoPipelineID, imported, len(missing))
		s.Monitor.Log("reconcile", fmt.Sprintf("Pipeline %d: importados %d leads faltantes desde Kommo", kommoPipelineID, imported), "info")
	}

	return fixed, nil
}

// --- Three-way merge helpers for tag sets ---

// toStringSet converts a string slice to a set (map[string]bool).
func toStringSet(s []string) map[string]bool {
	m := make(map[string]bool, len(s))
	for _, v := range s {
		m[v] = true
	}
	return m
}

// diffSet returns elements in a but not in b (a - b).
func diffSet(a, b map[string]bool) map[string]bool {
	d := make(map[string]bool)
	for k := range a {
		if !b[k] {
			d[k] = true
		}
	}
	return d
}

// copySet returns a shallow copy of a set.
func copySet(s map[string]bool) map[string]bool {
	c := make(map[string]bool, len(s))
	for k := range s {
		c[k] = true
	}
	return c
}

// setToSlice converts a set back to a sorted string slice.
func setToSlice(s map[string]bool) []string {
	result := make([]string, 0, len(s))
	for k := range s {
		result = append(result, k)
	}
	sort.Strings(result)
	return result
}
