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
func (s *SyncService) ConnectPipeline(ctx context.Context, accountID uuid.UUID, kommoPipelineID int) (*ConnectedPipeline, error) {
// Sync this pipeline's metadata (pipeline + stages) from Kommo
pipelineID, err := s.syncSinglePipeline(ctx, accountID, kommoPipelineID)
if err != nil {
return nil, fmt.Errorf("failed to sync pipeline metadata: %w", err)
}

// Sync tags (needed for leads)
_, _ = s.syncTags(ctx, accountID)

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

setProgress("Sincronizando etiquetas...")
tCount, err := s.syncTags(ctx, accountID)
if err != nil {
result.Errors = append(result.Errors, fmt.Sprintf("tags: %v", err))
}
result.Tags = tCount

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

var leadID uuid.UUID
	err = s.db.QueryRow(ctx, `SELECT id FROM leads WHERE account_id = $1 AND kommo_id = $2`, accountID, kommoID).Scan(&leadID)
	if err != nil {
		leadID = uuid.New()
		_, err = s.db.Exec(ctx, `
			INSERT INTO leads (id, account_id, contact_id, jid, name, phone, email, status, source, notes,
				pipeline_id, stage_id, tags, kommo_id, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', 'kommo', '', $8, $9, $10, $11, NOW(), NOW())
		`, leadID, accountID, contactID, jid, nilIfEmpty(cleanQuotes(kl.Name)), nilIfEmpty(phone),
			nilIfEmpty(email), pipelineID, stageID, tagNames, kommoID)
	} else {
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
		`, cleanQuotes(kl.Name), nilIfEmpty(phone), nilIfEmpty(email),
			contactID, pipelineID, stageID, tagNames, leadID)
	}
	if err != nil {
		return err
	}

	// Sync lead_tags junction table
	if len(tagNames) > 0 {
		s.syncLeadTags(ctx, accountID, leadID, tagNames)
	}

	return nil
}

// upsertContact inserts or updates a single contact. Returns the local UUID.
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
