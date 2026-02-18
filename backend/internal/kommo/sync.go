package kommo

import (
"context"
"fmt"
"log"
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
type WorkerStatus struct {
Running            bool       `json:"running"`
QueueLength        int        `json:"queue_length"`
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
client  *Client
db      *pgxpool.Pool
hub     *ws.Hub
queue   chan SyncTask
stopCh  chan struct{}
stopped chan struct{}
mu      sync.RWMutex
status  WorkerStatus
running bool
fullSyncMu sync.RWMutex
fullSync   map[uuid.UUID]*FullSyncStatus
}

// NewSyncService creates a new sync service with a background queue.
func NewSyncService(client *Client, db *pgxpool.Pool, hub *ws.Hub) *SyncService {
return &SyncService{
client:   client,
db:       db,
hub:     hub,
queue:    make(chan SyncTask, 100),
stopCh:   make(chan struct{}),
stopped:  make(chan struct{}),
fullSync: make(map[uuid.UUID]*FullSyncStatus),
}
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

now := time.Now()
s.fullSyncMu.Lock()
if st, ok := s.fullSync[accountID]; ok {
st.Running = false
st.DoneAt = &now
if err != nil {
st.Error = err.Error()
} else {
st.Result = result
st.Progress = "Completado"
}
}
s.fullSyncMu.Unlock()

if err != nil {
log.Printf("[Kommo Sync] Background full sync failed for %s: %v", accountID, err)
} else {
log.Printf("[Kommo Sync] Background full sync completed for %s in %s", accountID, result.Duration)
}
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

// Start begins the background sync worker and poller.
func (s *SyncService) Start() {
s.mu.Lock()
if s.running {
s.mu.Unlock()
return
}
s.running = true
s.status.Running = true
s.mu.Unlock()

// Worker: processes sync tasks from the queue
go s.worker()

// Poller: checks for updates every 30 seconds
go s.poller()

	log.Println("[Kommo Sync] Background worker started (5s poll interval)")
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
<-s.stopped
log.Println("[Kommo Sync] Background worker stopped")
}

// GetStatus returns the current worker status.
func (s *SyncService) GetStatus() WorkerStatus {
s.mu.RLock()
defer s.mu.RUnlock()
st := s.status
st.QueueLength = len(s.queue)
return st
}

// EnqueuePipelineSync adds a pipeline sync task to the queue (non-blocking).
func (s *SyncService) EnqueuePipelineSync(accountID uuid.UUID, kommoPipelineID int, updatedSince int64) {
select {
case s.queue <- SyncTask{AccountID: accountID, KommoPipelineID: kommoPipelineID, UpdatedSince: updatedSince}:
default:
log.Printf("[Kommo Sync] Queue full, dropping sync task for pipeline %d", kommoPipelineID)
}
}

// worker processes sync tasks from the channel one at a time.
func (s *SyncService) worker() {
defer close(s.stopped)
for {
select {
case <-s.stopCh:
return
case task := <-s.queue:
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
count, err := s.syncPipelineLeads(ctx, task.AccountID, task.KommoPipelineID, task.UpdatedSince)
cancel()
if err != nil {
if !strings.Contains(err.Error(), "204") && !strings.Contains(err.Error(), "No content") {
log.Printf("[Kommo Sync] Pipeline %d error: %v", task.KommoPipelineID, err)
}
} else if count > 0 {
			log.Printf("[Kommo Sync] Pipeline %d: synced %d leads", task.KommoPipelineID, count)
			// Broadcast real-time update to frontend
			if s.hub != nil {
				s.hub.BroadcastToAccount(task.AccountID, ws.EventLeadUpdate, map[string]interface{}{
					"pipeline_id": task.KommoPipelineID,
					"count":       count,
				})
			}
		}
// Update last_synced_at
_, _ = s.db.Exec(context.Background(),
`UPDATE kommo_connected_pipelines SET last_synced_at = NOW() WHERE account_id = $1 AND kommo_pipeline_id = $2`,
task.AccountID, task.KommoPipelineID)

s.mu.Lock()
now := time.Now()
s.status.LastCheck = &now
s.status.LastSyncedPipeline = fmt.Sprintf("%d", task.KommoPipelineID)
s.mu.Unlock()
}
}
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

rows, err := s.db.Query(ctx,
`SELECT account_id, kommo_pipeline_id, last_synced_at FROM kommo_connected_pipelines WHERE enabled = TRUE`)
if err != nil {
log.Printf("[Kommo Sync] Poll error: %v", err)
return
}
defer rows.Close()

count := 0
for rows.Next() {
var accountID uuid.UUID
var kommoPipelineID int64
var lastSynced *time.Time
if err := rows.Scan(&accountID, &kommoPipelineID, &lastSynced); err != nil {
continue
}
var since int64
if lastSynced != nil {
// Subtract 60 seconds buffer to avoid missing updates due to clock skew
since = lastSynced.Add(-60 * time.Second).Unix()
}
s.EnqueuePipelineSync(accountID, int(kommoPipelineID), since)
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
WHERE kcp.account_id = $1
ORDER BY kcp.created_at
`, accountID)
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
// Only ONE pipeline can be active per account — auto-disconnects any other.
func (s *SyncService) ConnectPipeline(ctx context.Context, accountID uuid.UUID, kommoPipelineID int) (*ConnectedPipeline, error) {
// Auto-disconnect any other enabled pipeline for this account
_, _ = s.db.Exec(ctx,
	`UPDATE kommo_connected_pipelines SET enabled = FALSE WHERE account_id = $1 AND kommo_pipeline_id != $2`,
	accountID, kommoPipelineID)

// Sync this pipeline's metadata (pipeline + stages) from Kommo
pipelineID, err := s.syncSinglePipeline(ctx, accountID, kommoPipelineID)
if err != nil {
return nil, fmt.Errorf("failed to sync pipeline metadata: %w", err)
}

// Sync tags (needed for leads)
_, _ = s.syncTags(ctx, accountID)

// Push local tags to Kommo
_, _ = s.pushMissingTagsToKommo(ctx, accountID)

// Insert or update the connected pipeline record
var cp ConnectedPipeline
err = s.db.QueryRow(ctx, `
INSERT INTO kommo_connected_pipelines (account_id, kommo_pipeline_id, pipeline_id, enabled)
VALUES ($1, $2, $3, TRUE)
ON CONFLICT (account_id, kommo_pipeline_id) DO UPDATE SET enabled = TRUE, pipeline_id = $3
RETURNING id, account_id, kommo_pipeline_id, pipeline_id, enabled, last_synced_at, created_at
`, accountID, kommoPipelineID, pipelineID).Scan(&cp.ID, &cp.AccountID, &cp.KommoPipelineID, &cp.PipelineID, &cp.Enabled, &cp.LastSyncedAt, &cp.CreatedAt)
if err != nil {
return nil, err
}

// Enqueue a full sync for this pipeline (updatedSince=0 = all leads)
s.EnqueuePipelineSync(accountID, kommoPipelineID, 0)

return &cp, nil
}

// DisconnectPipeline disconnects a Kommo pipeline from real-time sync.
func (s *SyncService) DisconnectPipeline(ctx context.Context, accountID uuid.UUID, kommoPipelineID int) error {
_, err := s.db.Exec(ctx,
`UPDATE kommo_connected_pipelines SET enabled = FALSE WHERE account_id = $1 AND kommo_pipeline_id = $2`,
accountID, kommoPipelineID)
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

// Sync only connected pipelines (metadata + stages)
setProgress(fmt.Sprintf("Sincronizando %d pipeline(s)...", len(activePipelines)))
pCount := 0
for _, cp := range activePipelines {
_, err := s.syncSinglePipeline(ctx, accountID, int(cp.KommoPipelineID))
if err != nil {
result.Errors = append(result.Errors, fmt.Sprintf("pipeline %d: %v", cp.KommoPipelineID, err))
continue
}
pCount++
}
result.Pipelines = pCount

// Only sync tags if the account has at least one active pipeline.
// Tags come from the shared Kommo API, so syncing without a pipeline
// would incorrectly assign another account's tags to this account.
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

// Contacts are synced automatically when leads are synced (via upsertLead → upsertContact),
// so we only sync contacts that are linked to leads in connected pipelines.
// No separate syncContacts call to avoid importing 50K+ contacts from all pipelines.

// Sync leads only from connected pipelines (contacts are synced within each lead)
setProgress(fmt.Sprintf("Sincronizando leads de %d pipeline(s)...", len(activePipelines)))
lCount := 0
for _, cp := range activePipelines {
count, err := s.syncPipelineLeads(ctx, accountID, int(cp.KommoPipelineID), 0)
if err != nil {
result.Errors = append(result.Errors, fmt.Sprintf("leads pipeline %d: %v", cp.KommoPipelineID, err))
continue
}
lCount += count
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
if ks.ID == 142 || ks.ID == 143 {
continue
}
stageKommoID := int64(ks.ID)
color := kommoColorToHex(ks.Color)
var existingStageID uuid.UUID
err := s.db.QueryRow(ctx, `SELECT id FROM pipeline_stages WHERE kommo_id = $1`, stageKommoID).Scan(&existingStageID)
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

// syncPipelineLeads syncs leads for a specific pipeline.
func (s *SyncService) syncPipelineLeads(ctx context.Context, accountID uuid.UUID, kommoPipelineID int, updatedSince int64) (int, error) {
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

for _, kl := range leads {
if err := s.upsertLead(ctx, accountID, kl); err != nil {
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

// upsertLead inserts or updates a single lead and its associated contact.
func (s *SyncService) upsertLead(ctx context.Context, accountID uuid.UUID, kl KommoLead) error {
kommoID := int64(kl.ID)
pipelineKommoID := int64(kl.PipelineID)
statusKommoID := int64(kl.StatusID)

var pipelineID, stageID *uuid.UUID
var pid uuid.UUID
err := s.db.QueryRow(ctx, `SELECT id FROM pipelines WHERE account_id = $1 AND kommo_id = $2`, accountID, pipelineKommoID).Scan(&pid)
if err == nil {
pipelineID = &pid
var sid uuid.UUID
err = s.db.QueryRow(ctx, `SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND kommo_id = $2`, pid, statusKommoID).Scan(&sid)
if err == nil {
stageID = &sid
}
}

var contactID *uuid.UUID
var phone, email string
if kl.Embedded != nil && len(kl.Embedded.Contacts) > 0 {
// Always fetch and upsert contact to keep names/phones in sync
contact, fetchErr := s.client.GetContactByID(kl.Embedded.Contacts[0].ID)
if fetchErr == nil {
syncedID := s.upsertContact(ctx, accountID, *contact)
if syncedID != nil {
contactID = syncedID
s.db.QueryRow(ctx, `SELECT COALESCE(phone, ''), COALESCE(email, '') FROM contacts WHERE id = $1`, *syncedID).Scan(&phone, &email)
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

// Determine lead name: prefer contact name over generic Kommo lead name
	leadName := cleanQuotes(kl.Name)
	if contactID != nil {
		var contactName string
		_ = s.db.QueryRow(ctx, `SELECT COALESCE(name, '') FROM contacts WHERE id = $1`, *contactID).Scan(&contactName)
		if contactName != "" {
			leadName = contactName
		}
	}

	var leadID uuid.UUID
	foundByKommoID := false
	err = s.db.QueryRow(ctx, `SELECT id FROM leads WHERE account_id = $1 AND kommo_id = $2`, accountID, kommoID).Scan(&leadID)
	if err == nil {
		foundByKommoID = true
	} else if jid != "" {
		// Also try to find by JID (lead may exist from WhatsApp auto-create without kommo_id)
		err = s.db.QueryRow(ctx, `SELECT id FROM leads WHERE account_id = $1 AND jid = $2`, accountID, jid).Scan(&leadID)
	}
	if err != nil {
		leadID = uuid.New()
		_, err = s.db.Exec(ctx, `
			INSERT INTO leads (id, account_id, contact_id, jid, name, phone, email, status, source, notes,
				pipeline_id, stage_id, tags, kommo_id, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', 'kommo', '', $8, $9, $10, $11, NOW(), NOW())
		`, leadID, accountID, contactID, jid, nilIfEmpty(leadName), nilIfEmpty(phone),
			nilIfEmpty(email), pipelineID, stageID, tagNames, kommoID)
	} else {
		// Anti-loop: skip update if this is an echo of our own push
		var lastPushedAt int64
		_ = s.db.QueryRow(ctx, `SELECT COALESCE(kommo_last_pushed_at, 0) FROM leads WHERE id = $1`, leadID).Scan(&lastPushedAt)
		if lastPushedAt > 0 && lastPushedAt == kl.UpdatedAt {
			// This update was caused by our own push — reset and skip
			_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = 0 WHERE id = $1`, leadID)
			return nil
		}

		if foundByKommoID {
			// Already linked — full bidirectional update from Kommo
			_, err = s.db.Exec(ctx, `
				UPDATE leads SET
					name = CASE WHEN $1 != '' THEN $1 ELSE name END,
					phone = COALESCE($2, phone),
					email = COALESCE($3, email),
					contact_id = COALESCE($4, contact_id),
					pipeline_id = COALESCE($5, pipeline_id),
					stage_id = COALESCE($6, stage_id),
					tags = COALESCE($7, tags),
					updated_at = NOW()
				WHERE id = $8
			`, leadName, nilIfEmpty(phone), nilIfEmpty(email),
				contactID, pipelineID, stageID, tagNames, leadID)
		} else {
			// First-time linking (found by JID) — Clarin keeps name/phone/email,
			// only link kommo_id and sync CRM fields (pipeline, stage, tags)
			_, err = s.db.Exec(ctx, `
				UPDATE leads SET
					kommo_id = $1,
					contact_id = COALESCE($2, contact_id),
					pipeline_id = COALESCE($3, pipeline_id),
					stage_id = COALESCE($4, stage_id),
					tags = COALESCE($5, tags),
					updated_at = NOW()
				WHERE id = $6
			`, kommoID, contactID, pipelineID, stageID, tagNames, leadID)
			log.Printf("[Kommo Sync] Linked existing Clarin lead %s to Kommo ID %d (preserved Clarin name/phone/email)", leadID, kommoID)
		}
	}
	if err != nil {
		return err
	}

	// Sync lead_tags junction table
	if len(tagNames) > 0 {
		s.syncLeadTags(ctx, accountID, leadID, tagNames)
	}

	// Sync call observations from Kommo custom fields → Clarin interactions
	s.syncCallsFromKommo(ctx, accountID, leadID, contactID, kl.CustomFields)

	return nil
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
func (s *SyncService) upsertContact(ctx context.Context, accountID uuid.UUID, kc KommoContact) *uuid.UUID {
kommoID := int64(kc.ID)
phone := GetContactPhone(kc.CustomFields)
email := GetContactEmail(kc.CustomFields)

if phone == "" && kc.Name == "" {
return nil
}

cleanPhone := normalizePhone(phone)
jid := ""
if cleanPhone != "" {
jid = cleanPhone + "@s.whatsapp.net"
}

name := cleanQuotes(kc.Name)
	if kc.FirstName != "" {
		name = cleanQuotes(kc.FirstName)
}

var existingID uuid.UUID
err := s.db.QueryRow(ctx, `SELECT id FROM contacts WHERE account_id = $1 AND kommo_id = $2`, accountID, kommoID).Scan(&existingID)
if err != nil && jid != "" {
	// Also try to find by JID (contact may exist from WhatsApp sync without kommo_id)
	err = s.db.QueryRow(ctx, `SELECT id FROM contacts WHERE account_id = $1 AND jid = $2`, accountID, jid).Scan(&existingID)
}
if err != nil {
existingID = uuid.New()
_, err = s.db.Exec(ctx, `
INSERT INTO contacts (id, account_id, jid, phone, name, last_name, email, source, kommo_id, is_group, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'kommo', $8, FALSE, NOW(), NOW())
`, existingID, accountID, jid, nilIfEmpty(cleanPhone), nilIfEmpty(name), nilIfEmpty(cleanQuotes(kc.LastName)),
nilIfEmpty(email), kommoID)
} else {
_, err = s.db.Exec(ctx, `
UPDATE contacts SET
name = CASE WHEN $1 != '' THEN $1 ELSE name END,
last_name = CASE WHEN $2 != '' THEN $2 ELSE last_name END,
phone = COALESCE($3, phone),
email = COALESCE($4, email),
jid = COALESCE($5, jid),
kommo_id = COALESCE($6, kommo_id),
updated_at = NOW()
WHERE id = $7
`, name, cleanQuotes(kc.LastName), nilIfEmpty(cleanPhone), nilIfEmpty(email), nilIfEmpty(jid), &kommoID, existingID)
}
	if err != nil {
		log.Printf("[Kommo Sync] contact %d error: %v", kc.ID, err)
		return nil
	}

	// Sync contact_tags junction table
	if kc.Embedded != nil && len(kc.Embedded.Tags) > 0 {
		s.syncContactTags(ctx, accountID, existingID, kc.Embedded.Tags)
	}

	return &existingID
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
if ks.ID == 142 || ks.ID == 143 {
continue
}
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
if s.upsertContact(ctx, accountID, kc) != nil {
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
leads, hasMore, err := s.client.GetLeads(page)
if err != nil {
if strings.Contains(err.Error(), "204") || strings.Contains(err.Error(), "No content") {
break
}
return count, err
}

for _, kl := range leads {
if err := s.upsertLead(ctx, accountID, kl); err != nil {
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

// syncLeadTags populates the lead_tags junction table for a lead.
func (s *SyncService) syncLeadTags(ctx context.Context, accountID, leadID uuid.UUID, tagNames []string) {
	// Clear existing lead_tags for this lead
	_, _ = s.db.Exec(ctx, `DELETE FROM lead_tags WHERE lead_id = $1`, leadID)

	for _, name := range tagNames {
		var tagID uuid.UUID
		err := s.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND name = $2`, accountID, name).Scan(&tagID)
		if err != nil {
			// Tag doesn't exist yet — create it
			tagID = uuid.New()
			_, err = s.db.Exec(ctx, `
				INSERT INTO tags (id, account_id, name, color, created_at, updated_at)
				VALUES ($1, $2, $3, '#6366f1', NOW(), NOW())
				ON CONFLICT (account_id, name) DO NOTHING
			`, tagID, accountID, name)
			if err != nil {
				// If insert failed due to race, re-fetch
				_ = s.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND name = $2`, accountID, name).Scan(&tagID)
			}
		}
		_, _ = s.db.Exec(ctx, `
			INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
		`, leadID, tagID)
	}
}

// syncContactTags populates the contact_tags junction table for a contact.
func (s *SyncService) syncContactTags(ctx context.Context, accountID, contactID uuid.UUID, tags []KommoTag) {
	if len(tags) == 0 {
		return
	}
	// Clear existing contact_tags for this contact
	_, _ = s.db.Exec(ctx, `DELETE FROM contact_tags WHERE contact_id = $1`, contactID)

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
		_, _ = s.db.Exec(ctx, `
			INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
		`, contactID, tagID)
	}
}

// --- Helpers ---

// --- Push Operations (Clarin → Kommo, async, individual actions only) ---

// PushLeadStageChange pushes a lead stage change to Kommo.
// Only acts if the lead has a kommo_id and the stage has a kommo_id.
func (s *SyncService) PushLeadStageChange(accountID, leadID, stageID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

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
}

// PushLeadTagsChange pushes all current tags of a lead to Kommo.
func (s *SyncService) PushLeadTagsChange(accountID, leadID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var kommoLeadID *int64
	err := s.db.QueryRow(ctx, `SELECT kommo_id FROM leads WHERE id = $1 AND account_id = $2`, leadID, accountID).Scan(&kommoLeadID)
	if err != nil || kommoLeadID == nil {
		return
	}

	// Get all current tags for this lead with their kommo_id
	rows, err := s.db.Query(ctx, `
		SELECT t.id, t.name, t.kommo_id FROM lead_tags lt
		JOIN tags t ON lt.tag_id = t.id
		WHERE lt.lead_id = $1
	`, leadID)
	if err != nil {
		log.Printf("[PUSH] Lead %s: failed to fetch tags: %v", leadID, err)
		return
	}
	defer rows.Close()

	var tags []KommoTag
	for rows.Next() {
		var tagLocalID uuid.UUID
		var name string
		var kommoTagID *int64
		if err := rows.Scan(&tagLocalID, &name, &kommoTagID); err != nil {
			continue
		}
		if kommoTagID != nil {
			tags = append(tags, KommoTag{ID: int(*kommoTagID), Name: name})
		} else {
			// Tag doesn't exist in Kommo — create it one by one
			newKommoID, createErr := s.client.CreateLeadTag(name)
			if createErr != nil {
				log.Printf("[PUSH] Lead %s: failed to create tag %q in Kommo: %v", leadID, name, createErr)
				// Still include by name so Kommo can try auto-create
				tags = append(tags, KommoTag{Name: name})
				continue
			}
			// Save the new kommo_id back to our database
			kommoID64 := int64(newKommoID)
			_, _ = s.db.Exec(ctx, `UPDATE tags SET kommo_id = $1, updated_at = NOW() WHERE id = $2`, kommoID64, tagLocalID)
			tags = append(tags, KommoTag{ID: newKommoID, Name: name})
			log.Printf("[PUSH] Lead %s: created tag %q in Kommo (kommo_id=%d)", leadID, name, newKommoID)
		}
	}

	updatedAt, err := s.client.UpdateLeadTags(int(*kommoLeadID), tags)
	if err != nil {
		log.Printf("[PUSH] Lead %s tags to Kommo failed: %v", leadID, err)
		return
	}

	_, _ = s.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = $1 WHERE id = $2`, updatedAt, leadID)
	log.Printf("[PUSH] Lead %s tags → Kommo lead %d (%d tags, updated_at=%d)", leadID, *kommoLeadID, len(tags), updatedAt)
}

// PushContactTagsChange pushes all current tags of a contact to Kommo.
func (s *SyncService) PushContactTagsChange(accountID, contactID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

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

	var tags []KommoTag
	for rows.Next() {
		var tagLocalID uuid.UUID
		var name string
		var kommoTagID *int64
		if err := rows.Scan(&tagLocalID, &name, &kommoTagID); err != nil {
			continue
		}
		if kommoTagID != nil {
			tags = append(tags, KommoTag{ID: int(*kommoTagID), Name: name})
		} else {
			// Tag doesn't exist in Kommo — create it one by one
			newKommoID, createErr := s.client.CreateContactTag(name)
			if createErr != nil {
				log.Printf("[PUSH] Contact %s: failed to create tag %q in Kommo: %v", contactID, name, createErr)
				tags = append(tags, KommoTag{Name: name})
				continue
			}
			kommoID64 := int64(newKommoID)
			_, _ = s.db.Exec(ctx, `UPDATE tags SET kommo_id = $1, updated_at = NOW() WHERE id = $2`, kommoID64, tagLocalID)
			tags = append(tags, KommoTag{ID: newKommoID, Name: name})
			log.Printf("[PUSH] Contact %s: created tag %q in Kommo (kommo_id=%d)", contactID, name, newKommoID)
		}
	}

	updatedAt, err := s.client.UpdateContactTags(int(*kommoContactID), tags)
	if err != nil {
		log.Printf("[PUSH] Contact %s tags to Kommo failed: %v", contactID, err)
		return
	}

	_, _ = s.db.Exec(ctx, `UPDATE contacts SET kommo_last_pushed_at = $1 WHERE id = $2`, updatedAt, contactID)
	log.Printf("[PUSH] Contact %s tags → Kommo contact %d (%d tags, updated_at=%d)", contactID, *kommoContactID, len(tags), updatedAt)
}

// PushNewLead creates a new lead (and optionally contact) in Kommo.
// Only acts if the lead's pipeline has a kommo_id (connected to Kommo).
func (s *SyncService) PushNewLead(accountID, leadID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Fetch lead details
	var leadName, phone, email *string
	var pipelineID, stageID, contactID *uuid.UUID
	err := s.db.QueryRow(ctx, `
		SELECT name, phone, email, pipeline_id, stage_id, contact_id
		FROM leads WHERE id = $1 AND account_id = $2 AND kommo_id IS NULL
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
}

// PushLeadName pushes a lead's name change to Kommo (both lead and linked contact).
func (s *SyncService) PushLeadName(accountID, leadID uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var kommoLeadID *int64
	var leadName *string
	err := s.db.QueryRow(ctx, `SELECT kommo_id, name FROM leads WHERE id = $1 AND account_id = $2`, leadID, accountID).Scan(&kommoLeadID, &leadName)
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

	s.upsertContact(ctx, accountID, *kc)
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

	if err := s.upsertLead(ctx, accountID, *kl); err != nil {
		return fmt.Errorf("failed to update from Kommo: %w", err)
	}

	log.Printf("[Kommo Sync] Manual lead sync: %s (Kommo ID %d)", leadID, *kommoID)
	return nil
}
