package kommo

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Operation constants for rows in kommo_push_outbox.
const (
	OpLeadName         = "lead_name"
	OpLeadStage        = "lead_stage"        // reads fresh state from leads.pipeline_id / stage_id
	OpLeadStageForced  = "lead_stage_forced" // payload carries status_id + pipeline_id (used when local lead is deleted)
	OpLeadTags         = "lead_tags"
	OpLeadCustomFields = "lead_custom_fields"
	OpContactName      = "contact_name"
	OpContactTags      = "contact_tags"
)

const (
	// Max attempts before a row is left in the outbox with an error for manual inspection.
	outboxMaxAttempts = 5
	// Processing timeout: rows stuck with processing_started_at older than this
	// are reset so another worker (or this worker on restart) can retry them.
	outboxStaleAfter = 2 * time.Minute
	// Max items fetched from Kommo in a single GetLeadsByIDs call (matches client batching).
	kommoGetLeadsChunk = 50
)

// Outbox is the batched push worker. One instance per SyncService.
// Rows are inserted by Enqueue* helpers on the hot path (HTTP handlers)
// and drained by Start() goroutine which groups them into bulk PATCH /leads
// and PATCH /contacts calls (up to BatchSize per request).
type Outbox struct {
	db         *pgxpool.Pool
	client     *Client
	monitor    *SyncMonitor
	instanceID *uuid.UUID
	batchSize  int
	interval   time.Duration

	mu      sync.Mutex
	running bool
	stopCh  chan struct{}
	wg      sync.WaitGroup
}

// NewOutbox constructs an Outbox worker. Caller must invoke Start() to begin
// the flush loop. batchSize is capped to [1, 250] (Kommo's per-request limit).
func NewOutbox(db *pgxpool.Pool, client *Client, monitor *SyncMonitor, batchSize int, interval time.Duration) *Outbox {
	return NewOutboxForInstance(db, client, monitor, nil, batchSize, interval)
}

func NewOutboxForInstance(db *pgxpool.Pool, client *Client, monitor *SyncMonitor, instanceID *uuid.UUID, batchSize int, interval time.Duration) *Outbox {
	if batchSize < 1 {
		batchSize = 250
	}
	if batchSize > 250 {
		batchSize = 250
	}
	if interval < 250*time.Millisecond {
		interval = 2 * time.Second
	}
	return &Outbox{
		db:         db,
		client:     client,
		monitor:    monitor,
		instanceID: instanceID,
		batchSize:  batchSize,
		interval:   interval,
		stopCh:     make(chan struct{}),
	}
}

// Start launches the flush loop. Safe to call once; subsequent calls are no-ops.
func (o *Outbox) Start() {
	o.mu.Lock()
	if o.running {
		o.mu.Unlock()
		return
	}
	o.running = true
	o.mu.Unlock()

	o.wg.Add(1)
	go o.loop()
	log.Printf("[OUTBOX] Started: batch=%d interval=%s", o.batchSize, o.interval)
}

// Stop signals the flush loop to exit and waits for it to finish.
func (o *Outbox) Stop() {
	o.mu.Lock()
	if !o.running {
		o.mu.Unlock()
		return
	}
	o.running = false
	close(o.stopCh)
	o.mu.Unlock()
	o.wg.Wait()
	log.Println("[OUTBOX] Stopped")
}

func (o *Outbox) loop() {
	defer o.wg.Done()
	ticker := time.NewTicker(o.interval)
	defer ticker.Stop()
	for {
		select {
		case <-o.stopCh:
			return
		case <-ticker.C:
			o.resetStale()
			o.flushAll()
		}
	}
}

// resetStale releases rows that have been in-flight longer than outboxStaleAfter.
// This covers the case where a previous worker instance crashed mid-flush.
func (o *Outbox) resetStale() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := o.db.Exec(ctx, `
		UPDATE kommo_push_outbox
		SET processing_started_at = NULL
		WHERE processing_started_at IS NOT NULL
		  AND integration_instance_id IS NOT DISTINCT FROM $3
		  AND processing_started_at < NOW() - $1::interval
		  AND attempts < $2
	`, fmt.Sprintf("%d seconds", int(outboxStaleAfter.Seconds())), outboxMaxAttempts, o.instanceID)
	if err != nil {
		log.Printf("[OUTBOX] resetStale error: %v", err)
	}
}

func (o *Outbox) flushAll() {
	// Order matters: names before tags before stage (so a rename + retag lands
	// both on the same Kommo lead without conflicting updated_at races, and
	// stage changes stabilize last).
	for _, op := range []string{OpLeadName, OpContactName, OpLeadTags, OpContactTags, OpLeadCustomFields, OpLeadStage, OpLeadStageForced} {
		for {
			claimed, err := o.flushOnce(op)
			if err != nil {
				log.Printf("[OUTBOX] flush %s error: %v", op, err)
				break
			}
			if claimed < o.batchSize {
				break // queue drained for this op
			}
		}
	}
}

// claimedRow is an in-flight outbox entry being processed in the current flush.
type claimedRow struct {
	ID            uuid.UUID
	AccountID     uuid.UUID
	EntityID      uuid.UUID
	KommoEntityID int64
	Payload       []byte
}

func (o *Outbox) logBatch(operation, entityType, message, status string, claimed []claimedRow, requestCount int, startedAt time.Time, details map[string]interface{}) {
	if o.monitor == nil {
		return
	}
	accounts := make([]string, 0, len(claimed))
	seen := make(map[uuid.UUID]bool)
	for _, row := range claimed {
		if seen[row.AccountID] {
			continue
		}
		seen[row.AccountID] = true
		accounts = append(accounts, row.AccountID.String())
	}
	sort.Strings(accounts)
	if details == nil {
		details = map[string]interface{}{}
	}
	details["accounts"] = accounts
	details["account_count"] = len(accounts)
	var accountID *uuid.UUID
	if len(accounts) == 1 && len(claimed) > 0 {
		localAccountID := claimed[0].AccountID
		accountID = &localAccountID
	}
	o.monitor.LogEvent(SyncMonitorEvent{
		Source:       "push",
		Message:      message,
		AccountID:    accountID,
		EntityType:   entityType,
		Operation:    operation,
		Status:       status,
		Direction:    "outbound",
		DurationMS:   time.Since(startedAt).Milliseconds(),
		RequestCount: requestCount,
		BatchSize:    len(claimed),
		Details:      details,
	})
}

// flushOnce claims up to batchSize rows for the given operation and processes them.
// Returns the number of rows claimed (0 when the queue is empty).
func (o *Outbox) flushOnce(op string) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	// Atomically claim a batch. FOR UPDATE SKIP LOCKED lets multiple workers
	// coexist safely; we currently run a single worker per process but this
	// future-proofs the design.
	tx, err := o.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT id, account_id, entity_id, kommo_entity_id, payload
		FROM kommo_push_outbox
		WHERE operation = $1 AND processing_started_at IS NULL
		  AND integration_instance_id IS NOT DISTINCT FROM $3
		ORDER BY enqueued_at ASC
		LIMIT $2
		FOR UPDATE SKIP LOCKED
	`, op, o.batchSize, o.instanceID)
	if err != nil {
		return 0, err
	}
	var claimed []claimedRow
	for rows.Next() {
		var r claimedRow
		if err := rows.Scan(&r.ID, &r.AccountID, &r.EntityID, &r.KommoEntityID, &r.Payload); err != nil {
			rows.Close()
			return 0, err
		}
		claimed = append(claimed, r)
	}
	rows.Close()
	if len(claimed) == 0 {
		return 0, tx.Commit(ctx)
	}

	ids := make([]uuid.UUID, 0, len(claimed))
	for _, r := range claimed {
		ids = append(ids, r.ID)
	}
	_, err = tx.Exec(ctx, `UPDATE kommo_push_outbox SET processing_started_at = NOW(), attempts = attempts + 1 WHERE id = ANY($1)`, ids)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}

	// Dispatch per operation. Each handler is responsible for completing
	// (delete row) or failing (reset processing_started_at) each claimed row.
	switch op {
	case OpLeadName:
		o.flushLeadNames(ctx, claimed)
	case OpContactName:
		o.flushContactNames(ctx, claimed)
	case OpLeadStage:
		o.flushLeadStages(ctx, claimed, false)
	case OpLeadStageForced:
		o.flushLeadStages(ctx, claimed, true)
	case OpLeadTags:
		o.flushLeadTags(ctx, claimed)
	case OpContactTags:
		o.flushContactTags(ctx, claimed)
	case OpLeadCustomFields:
		o.flushLeadCustomFields(ctx, claimed)
	default:
		// Unknown operation — mark failed to avoid infinite retries.
		for _, r := range claimed {
			o.failRow(ctx, r.ID, fmt.Sprintf("unknown operation %q", op))
		}
	}
	return len(claimed), nil
}

// ─── Enqueue API ──────────────────────────────────────────────────────────
//
// Enqueue*() helpers are the only public interface hotpath handlers should
// touch. They are idempotent: re-enqueuing the same (entity, operation)
// before the first flush drains it coalesces into a single row via the
// unique partial index on (entity_id, operation) WHERE processing_started_at IS NULL.

// Enqueue inserts (or coalesces) a single outbox row. Returns nil on success.
// Callers should pass payload=nil when flush-time state reads are sufficient.
func (o *Outbox) Enqueue(ctx context.Context, accountID, entityID uuid.UUID, kommoEntityID int64, operation string, payload interface{}) error {
	if o == nil {
		return fmt.Errorf("outbox not initialized")
	}
	if kommoEntityID <= 0 {
		return fmt.Errorf("kommo_entity_id must be > 0 (entity %s not linked to Kommo)", entityID)
	}
	var payloadJSON []byte
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("marshal payload: %w", err)
		}
		payloadJSON = b
	} else {
		payloadJSON = []byte(`{}`)
	}
	result, err := o.db.Exec(ctx, `
		UPDATE kommo_push_outbox
		SET payload = $1::jsonb,
		    kommo_entity_id = $2,
		    enqueued_at = NOW(),
		    attempts = 0,
		    last_error = NULL
		WHERE entity_id = $3
		  AND operation = $4
		  AND processing_started_at IS NULL
		  AND integration_instance_id IS NOT DISTINCT FROM $5
	`, payloadJSON, kommoEntityID, entityID, operation, o.instanceID)
	if err != nil {
		return err
	}
	if result.RowsAffected() > 0 {
		return nil
	}
	_, err = o.db.Exec(ctx, `
		INSERT INTO kommo_push_outbox (id, integration_instance_id, account_id, operation, entity_id, kommo_entity_id, payload)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
	`, uuid.New(), o.instanceID, accountID, operation, entityID, kommoEntityID, payloadJSON)
	return err
}

// ─── Completion helpers ───────────────────────────────────────────────────

func (o *Outbox) completeRows(ctx context.Context, rowIDs []uuid.UUID) {
	if len(rowIDs) == 0 {
		return
	}
	_, err := o.db.Exec(ctx, `DELETE FROM kommo_push_outbox WHERE id = ANY($1)`, rowIDs)
	if err != nil {
		log.Printf("[OUTBOX] completeRows error: %v", err)
	}
}

// failRow resets processing_started_at for retry (up to outboxMaxAttempts).
// After the max, the row is left with processing_started_at NOT NULL and a
// last_error message for manual inspection.
func (o *Outbox) failRow(ctx context.Context, rowID uuid.UUID, errMsg string) {
	if len(errMsg) > 500 {
		errMsg = errMsg[:500]
	}
	_, err := o.db.Exec(ctx, `
		UPDATE kommo_push_outbox
		SET last_error = $2,
		    processing_started_at = CASE WHEN attempts >= $3 THEN processing_started_at ELSE NULL END
		WHERE id = $1
	`, rowID, errMsg, outboxMaxAttempts)
	if err != nil {
		log.Printf("[OUTBOX] failRow error: %v", err)
	}
}

// failRowsBulk marks all claimed rows as failed with the same error (batch-level failure).
func (o *Outbox) failRowsBulk(ctx context.Context, rows []claimedRow, errMsg string) {
	for _, r := range rows {
		o.failRow(ctx, r.ID, errMsg)
	}
}

// ─── Per-operation flushers ───────────────────────────────────────────────

// flushLeadNames reads the current effective name for each lead (COALESCE of
// contact custom_name, contact name, lead name) and sends one bulk PATCH /leads.
func (o *Outbox) flushLeadNames(ctx context.Context, claimed []claimedRow) {
	// Map: outboxRowID → (kommoID, name). We preserve order of `claimed`.
	startedAt := time.Now()
	type entry struct {
		row  claimedRow
		name string
	}
	leadIDs := make([]uuid.UUID, 0, len(claimed))
	for _, r := range claimed {
		leadIDs = append(leadIDs, r.EntityID)
	}
	// Fetch names in a single query.
	type nameRow struct {
		ID   uuid.UUID
		Name string
	}
	rows, err := o.db.Query(ctx, `
		SELECT l.id, COALESCE(c.custom_name, c.name, l.name, '')
		FROM leads l
		LEFT JOIN contacts c ON c.id = l.contact_id
		WHERE l.id = ANY($1)
	`, leadIDs)
	if err != nil {
		log.Printf("[OUTBOX] flushLeadNames read error: %v", err)
		o.failRowsBulk(ctx, claimed, err.Error())
		return
	}
	nameByID := make(map[uuid.UUID]string, len(claimed))
	for rows.Next() {
		var nr nameRow
		if err := rows.Scan(&nr.ID, &nr.Name); err == nil {
			nameByID[nr.ID] = nr.Name
		}
	}
	rows.Close()

	var entries []entry
	var items []map[string]interface{}
	for _, r := range claimed {
		name, ok := nameByID[r.EntityID]
		if !ok || name == "" {
			// Lead vanished or has no name — nothing to push, drop silently.
			o.completeRows(ctx, []uuid.UUID{r.ID})
			continue
		}
		entries = append(entries, entry{row: r, name: name})
		items = append(items, map[string]interface{}{
			"id":   r.KommoEntityID,
			"name": name,
		})
	}
	if len(items) == 0 {
		return
	}

	result, err := o.client.BatchUpdateLeads(items)
	if err != nil {
		log.Printf("[OUTBOX] BatchUpdateLeads (name, %d items) failed: %v", len(items), err)
		var rowsToFail []claimedRow
		for _, e := range entries {
			rowsToFail = append(rowsToFail, e.row)
		}
		o.failRowsBulk(ctx, rowsToFail, err.Error())
		return
	}
	// Map Kommo id → updated_at
	tsByKommoID := make(map[int64]int64, len(result))
	for _, r := range result {
		tsByKommoID[int64(r.ID)] = r.UpdatedAt
	}
	// Per-row post-update: set kommo_last_pushed_at for anti-loop.
	var completed []uuid.UUID
	for _, e := range entries {
		ts := tsByKommoID[e.row.KommoEntityID]
		if ts > 0 {
			_, _ = o.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = $1 WHERE id = $2`, ts, e.row.EntityID)
		}
		completed = append(completed, e.row.ID)
	}
	o.completeRows(ctx, completed)
	log.Printf("[OUTBOX] flushLeadNames pushed %d names in 1 PATCH", len(items))
	o.logBatch("lead_name", "lead", fmt.Sprintf("Batch names → Kommo (%d leads)", len(items)), "pushed", claimed, 1, startedAt, nil)
}

// flushContactNames reads current contact names and sends one bulk PATCH /contacts.
func (o *Outbox) flushContactNames(ctx context.Context, claimed []claimedRow) {
	contactIDs := make([]uuid.UUID, 0, len(claimed))
	startedAt := time.Now()
	for _, r := range claimed {
		contactIDs = append(contactIDs, r.EntityID)
	}
	rows, err := o.db.Query(ctx, `
		SELECT id, COALESCE(custom_name, name, '')
		FROM contacts
		WHERE id = ANY($1)
	`, contactIDs)
	if err != nil {
		log.Printf("[OUTBOX] flushContactNames read error: %v", err)
		o.failRowsBulk(ctx, claimed, err.Error())
		return
	}
	nameByID := make(map[uuid.UUID]string, len(claimed))
	for rows.Next() {
		var id uuid.UUID
		var name string
		if err := rows.Scan(&id, &name); err == nil {
			nameByID[id] = name
		}
	}
	rows.Close()

	var items []map[string]interface{}
	var entries []claimedRow
	for _, r := range claimed {
		name, ok := nameByID[r.EntityID]
		if !ok || name == "" {
			o.completeRows(ctx, []uuid.UUID{r.ID})
			continue
		}
		entries = append(entries, r)
		items = append(items, map[string]interface{}{
			"id":   r.KommoEntityID,
			"name": name,
		})
	}
	if len(items) == 0 {
		return
	}
	result, err := o.client.BatchUpdateContacts(items)
	if err != nil {
		log.Printf("[OUTBOX] BatchUpdateContacts (name, %d items) failed: %v", len(items), err)
		o.failRowsBulk(ctx, entries, err.Error())
		return
	}
	tsByKommoID := make(map[int64]int64, len(result))
	for _, r := range result {
		tsByKommoID[int64(r.ID)] = r.UpdatedAt
	}
	var completed []uuid.UUID
	for _, r := range entries {
		ts := tsByKommoID[r.KommoEntityID]
		if ts > 0 {
			_, _ = o.db.Exec(ctx, `UPDATE contacts SET kommo_last_pushed_at = $1 WHERE id = $2`, ts, r.EntityID)
		}
		completed = append(completed, r.ID)
	}
	o.completeRows(ctx, completed)
	log.Printf("[OUTBOX] flushContactNames pushed %d names in 1 PATCH", len(items))
	o.logBatch("contact_name", "contact", fmt.Sprintf("Batch contact names → Kommo (%d)", len(items)), "pushed", claimed, 1, startedAt, nil)
}

// flushLeadStages pushes pipeline/stage changes. When forced=true, the payload
// is trusted verbatim (used for the delete→Perdido flow where the local lead
// is already gone). Otherwise we read fresh pipeline/stage kommo_ids from DB.
func (o *Outbox) flushLeadStages(ctx context.Context, claimed []claimedRow, forced bool) {
	type entry struct {
		row        claimedRow
		statusID   int64
		pipelineID int64
	}
	startedAt := time.Now()
	var entries []entry

	if forced {
		type forcedPayload struct {
			StatusID   int64 `json:"status_id"`
			PipelineID int64 `json:"pipeline_id"`
		}
		for _, r := range claimed {
			var p forcedPayload
			if err := json.Unmarshal(r.Payload, &p); err != nil || p.StatusID == 0 || p.PipelineID == 0 {
				o.failRow(ctx, r.ID, fmt.Sprintf("invalid forced payload: %v", err))
				continue
			}
			entries = append(entries, entry{row: r, statusID: p.StatusID, pipelineID: p.PipelineID})
		}
	} else {
		leadIDs := make([]uuid.UUID, 0, len(claimed))
		for _, r := range claimed {
			leadIDs = append(leadIDs, r.EntityID)
		}
		rows, err := o.db.Query(ctx, `
			SELECT l.id, p.kommo_id, s.kommo_id
			FROM leads l
			LEFT JOIN pipelines p ON l.pipeline_id = p.id
			LEFT JOIN pipeline_stages s ON l.stage_id = s.id
			WHERE l.id = ANY($1)
		`, leadIDs)
		if err != nil {
			log.Printf("[OUTBOX] flushLeadStages read error: %v", err)
			o.failRowsBulk(ctx, claimed, err.Error())
			return
		}
		stageByLead := make(map[uuid.UUID][2]int64, len(claimed))
		for rows.Next() {
			var id uuid.UUID
			var pID, sID *int64
			if err := rows.Scan(&id, &pID, &sID); err == nil && pID != nil && sID != nil {
				stageByLead[id] = [2]int64{*pID, *sID}
			}
		}
		rows.Close()
		for _, r := range claimed {
			v, ok := stageByLead[r.EntityID]
			if !ok {
				// Lead gone or no synced pipeline — drop silently.
				o.completeRows(ctx, []uuid.UUID{r.ID})
				continue
			}
			entries = append(entries, entry{row: r, pipelineID: v[0], statusID: v[1]})
		}
	}
	if len(entries) == 0 {
		return
	}

	items := make([]map[string]interface{}, 0, len(entries))
	for _, e := range entries {
		items = append(items, map[string]interface{}{
			"id":          e.row.KommoEntityID,
			"status_id":   e.statusID,
			"pipeline_id": e.pipelineID,
		})
	}
	result, err := o.client.BatchUpdateLeads(items)
	if err != nil {
		log.Printf("[OUTBOX] BatchUpdateLeads (stage, %d items) failed: %v", len(items), err)
		var toFail []claimedRow
		for _, e := range entries {
			toFail = append(toFail, e.row)
		}
		o.failRowsBulk(ctx, toFail, err.Error())
		return
	}
	tsByKommoID := make(map[int64]int64, len(result))
	for _, r := range result {
		tsByKommoID[int64(r.ID)] = r.UpdatedAt
	}
	var completed []uuid.UUID
	for _, e := range entries {
		ts := tsByKommoID[e.row.KommoEntityID]
		if ts > 0 && !forced {
			_, _ = o.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = $1 WHERE id = $2`, ts, e.row.EntityID)
		}
		completed = append(completed, e.row.ID)
	}
	o.completeRows(ctx, completed)
	label := "stage"
	if forced {
		label = "stage_forced"
	}
	log.Printf("[OUTBOX] flushLeadStages (%s) pushed %d items in 1 PATCH", label, len(items))
	o.logBatch("lead_"+label, "lead", fmt.Sprintf("Batch %s → Kommo (%d leads)", label, len(items)), "pushed", claimed, 1, startedAt, map[string]interface{}{"forced": forced})
}

// flushLeadTags performs 3-way merge per lead and sends one bulk PATCH /leads.
// For each claimed lead:
//   - baseline = leads.kommo_synced_tags
//   - clarinCurrent = tags via contact_tags (current local state)
//   - kommoCurrent = tags from Kommo (fetched in batch via GetLeadsByIDs)
//   - merged = (kommoCurrent ∪ clarinAdded) − clarinRemoved
//
// After a successful push, we also sync back Kommo-only tags into Clarin
// (same behavior as the legacy PushLeadTagsChange).
func (o *Outbox) flushLeadTags(ctx context.Context, claimed []claimedRow) {
	// 1. Read baselines + clarin current tags in batch.
	startedAt := time.Now()
	leadIDs := make([]uuid.UUID, 0, len(claimed))
	for _, r := range claimed {
		leadIDs = append(leadIDs, r.EntityID)
	}

	baselines := make(map[uuid.UUID][]string, len(claimed))
	{
		rows, err := o.db.Query(ctx, `
			SELECT id, COALESCE(kommo_synced_tags, '{}')
			FROM leads WHERE id = ANY($1)
		`, leadIDs)
		if err != nil {
			log.Printf("[OUTBOX] flushLeadTags baseline read error: %v", err)
			o.failRowsBulk(ctx, claimed, err.Error())
			return
		}
		for rows.Next() {
			var id uuid.UUID
			var tags []string
			if err := rows.Scan(&id, &tags); err == nil {
				baselines[id] = tags
			}
		}
		rows.Close()
	}

	clarinCurrent := make(map[uuid.UUID][]string, len(claimed))
	{
		rows, err := o.db.Query(ctx, `
			SELECT l.id, t.name
			FROM leads l
			JOIN contact_tags ct ON ct.contact_id = l.contact_id
			JOIN tags t ON t.id = ct.tag_id
			WHERE l.id = ANY($1)
		`, leadIDs)
		if err != nil {
			log.Printf("[OUTBOX] flushLeadTags clarin read error: %v", err)
			o.failRowsBulk(ctx, claimed, err.Error())
			return
		}
		for rows.Next() {
			var id uuid.UUID
			var name string
			if err := rows.Scan(&id, &name); err == nil {
				clarinCurrent[id] = append(clarinCurrent[id], name)
			}
		}
		rows.Close()
	}

	// 2. Batch-fetch current Kommo state for all leads (chunks of 50).
	kommoCurrent := make(map[int64][]string, len(claimed))
	{
		kommoIDs := make([]int, 0, len(claimed))
		for _, r := range claimed {
			kommoIDs = append(kommoIDs, int(r.KommoEntityID))
		}
		// Chunk respects the helper's internal limit too.
		for start := 0; start < len(kommoIDs); start += kommoGetLeadsChunk {
			end := start + kommoGetLeadsChunk
			if end > len(kommoIDs) {
				end = len(kommoIDs)
			}
			chunk := kommoIDs[start:end]
			batchRes, err := o.client.GetLeadsByIDs(chunk)
			if err != nil {
				log.Printf("[OUTBOX] flushLeadTags GetLeadsByIDs failed: %v", err)
				o.failRowsBulk(ctx, claimed, err.Error())
				return
			}
			for kid, kl := range batchRes {
				if kl.Embedded != nil {
					names := make([]string, 0, len(kl.Embedded.Tags))
					for _, t := range kl.Embedded.Tags {
						names = append(names, t.Name)
					}
					kommoCurrent[int64(kid)] = names
				} else {
					kommoCurrent[int64(kid)] = nil
				}
			}
		}
	}

	// 3. Build merged sets + batch payload.
	type tagEntry struct {
		row    claimedRow
		merged []string
	}
	var entries []tagEntry
	var items []map[string]interface{}
	for _, r := range claimed {
		baselineSet := toStringSet(baselines[r.EntityID])
		clarinSet := toStringSet(clarinCurrent[r.EntityID])
		kommoSet := toStringSet(kommoCurrent[r.KommoEntityID])

		clarinAdded := diffSet(clarinSet, baselineSet)
		clarinRemoved := diffSet(baselineSet, clarinSet)
		merged := copySet(kommoSet)
		for tag := range clarinAdded {
			merged[tag] = true
		}
		for tag := range clarinRemoved {
			delete(merged, tag)
		}
		mergedSlice := setToSlice(merged)

		tags := make([]KommoTag, 0, len(mergedSlice))
		for _, name := range mergedSlice {
			tags = append(tags, KommoTag{Name: name})
		}
		items = append(items, map[string]interface{}{
			"id": r.KommoEntityID,
			"_embedded": map[string]interface{}{
				"tags": tags,
			},
		})
		entries = append(entries, tagEntry{row: r, merged: mergedSlice})
	}

	// 4. Send one bulk PATCH.
	result, err := o.client.BatchUpdateLeads(items)
	if err != nil {
		log.Printf("[OUTBOX] BatchUpdateLeads (tags, %d items) failed: %v", len(items), err)
		var toFail []claimedRow
		for _, e := range entries {
			toFail = append(toFail, e.row)
		}
		o.failRowsBulk(ctx, toFail, err.Error())
		return
	}
	tsByKommoID := make(map[int64]int64, len(result))
	for _, r := range result {
		tsByKommoID[int64(r.ID)] = r.UpdatedAt
	}

	// 5. Per-lead post-processing: sync-back Kommo-only tags and update baseline.
	var completed []uuid.UUID
	for _, e := range entries {
		ts := tsByKommoID[e.row.KommoEntityID]
		// Sync-back: tags that exist in Kommo but not locally → add to local contact_tags.
		clarinSet := toStringSet(clarinCurrent[e.row.EntityID])
		mergedSet := toStringSet(e.merged)
		kommoOnly := diffSet(mergedSet, clarinSet)
		if len(kommoOnly) > 0 {
			var contactID *uuid.UUID
			_ = o.db.QueryRow(ctx, `SELECT contact_id FROM leads WHERE id = $1`, e.row.EntityID).Scan(&contactID)
			if contactID != nil {
				for tagName := range kommoOnly {
					var tagID uuid.UUID
					if err := o.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND name = $2`, e.row.AccountID, tagName).Scan(&tagID); err != nil {
						tagID = uuid.New()
						_, _ = o.db.Exec(ctx, `
							INSERT INTO tags (id, account_id, name, color, created_at, updated_at)
							VALUES ($1, $2, $3, '#6366f1', NOW(), NOW())
							ON CONFLICT (account_id, name) DO NOTHING
						`, tagID, e.row.AccountID, tagName)
						_ = o.db.QueryRow(ctx, `SELECT id FROM tags WHERE account_id = $1 AND name = $2`, e.row.AccountID, tagName).Scan(&tagID)
					}
					_, _ = o.db.Exec(ctx, `INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, *contactID, tagID)
				}
			}
		}
		// Update baseline + anti-echo timestamp + denormalized tags[] column.
		if ts > 0 {
			_, _ = o.db.Exec(ctx, `UPDATE leads SET kommo_synced_tags = $1, kommo_last_pushed_at = $2, tags = $1 WHERE id = $3`,
				e.merged, ts, e.row.EntityID)
		} else {
			_, _ = o.db.Exec(ctx, `UPDATE leads SET kommo_synced_tags = $1, tags = $1 WHERE id = $2`,
				e.merged, e.row.EntityID)
		}
		completed = append(completed, e.row.ID)
	}
	o.completeRows(ctx, completed)
	log.Printf("[OUTBOX] flushLeadTags pushed %d leads in 1 PATCH (+ 1 batch GET)", len(items))
	o.logBatch("lead_tags", "lead", fmt.Sprintf("Batch tags → Kommo (%d leads, 3-way merge)", len(items)), "pushed", claimed, 2, startedAt, map[string]interface{}{"merge": "three_way"})
}

// flushContactTags sends current contact tags in one bulk PATCH /contacts.
// Unlike leads, there is no 3-way merge for contacts (the legacy code
// overwrites Kommo state with Clarin state directly).
func (o *Outbox) flushContactTags(ctx context.Context, claimed []claimedRow) {
	contactIDs := make([]uuid.UUID, 0, len(claimed))
	startedAt := time.Now()
	for _, r := range claimed {
		contactIDs = append(contactIDs, r.EntityID)
	}
	rows, err := o.db.Query(ctx, `
		SELECT ct.contact_id, t.name
		FROM contact_tags ct
		JOIN tags t ON t.id = ct.tag_id
		WHERE ct.contact_id = ANY($1)
	`, contactIDs)
	if err != nil {
		log.Printf("[OUTBOX] flushContactTags read error: %v", err)
		o.failRowsBulk(ctx, claimed, err.Error())
		return
	}
	tagsByContact := make(map[uuid.UUID][]string, len(claimed))
	for rows.Next() {
		var id uuid.UUID
		var name string
		if err := rows.Scan(&id, &name); err == nil {
			tagsByContact[id] = append(tagsByContact[id], name)
		}
	}
	rows.Close()

	var items []map[string]interface{}
	var entries []claimedRow
	for _, r := range claimed {
		names := tagsByContact[r.EntityID]
		tags := make([]KommoTag, 0, len(names))
		for _, n := range names {
			tags = append(tags, KommoTag{Name: n})
		}
		items = append(items, map[string]interface{}{
			"id": r.KommoEntityID,
			"_embedded": map[string]interface{}{
				"tags": tags,
			},
		})
		entries = append(entries, r)
	}
	result, err := o.client.BatchUpdateContacts(items)
	if err != nil {
		log.Printf("[OUTBOX] BatchUpdateContacts (tags, %d items) failed: %v", len(items), err)
		o.failRowsBulk(ctx, entries, err.Error())
		return
	}
	tsByKommoID := make(map[int64]int64, len(result))
	for _, r := range result {
		tsByKommoID[int64(r.ID)] = r.UpdatedAt
	}
	var completed []uuid.UUID
	for _, r := range entries {
		ts := tsByKommoID[r.KommoEntityID]
		if ts > 0 {
			_, _ = o.db.Exec(ctx, `UPDATE contacts SET kommo_last_pushed_at = $1 WHERE id = $2`, ts, r.EntityID)
		}
		completed = append(completed, r.ID)
	}
	o.completeRows(ctx, completed)
	log.Printf("[OUTBOX] flushContactTags pushed %d contacts in 1 PATCH", len(items))
	o.logBatch("contact_tags", "contact", fmt.Sprintf("Batch contact tags → Kommo (%d)", len(items)), "pushed", claimed, 1, startedAt, nil)
}

// flushLeadCustomFields pushes observation custom-fields (10 call slots + overflow)
// per lead. Unlike the other flushers, Kommo's per-lead custom_fields_values
// array is large and varies per row, but the endpoint still accepts batches:
// each item in the PATCH array carries its own custom_fields_values.
func (o *Outbox) flushLeadCustomFields(ctx context.Context, claimed []claimedRow) {
	// We re-use the exact payload structure that PushLeadObservations builds.
	// To avoid duplicating the logic we read interactions per-lead here, then
	// assemble the items array.
	startedAt := time.Now()
	type entry struct {
		row    claimedRow
		fields []KommoCustomFieldWrite
		// calls captured for the post-success bookkeeping (slot assignment, dedup)
		calls []interactionData
	}
	var entries []entry
	var items []map[string]interface{}

	for _, r := range claimed {
		calls, err := loadLeadCallInteractions(ctx, o.db, r.EntityID)
		if err != nil {
			log.Printf("[OUTBOX] flushLeadCustomFields read error for lead %s: %v", r.EntityID, err)
			o.failRow(ctx, r.ID, err.Error())
			continue
		}
		fields := buildCallCustomFields(calls)
		entries = append(entries, entry{row: r, fields: fields, calls: calls})
		items = append(items, map[string]interface{}{
			"id":                   r.KommoEntityID,
			"custom_fields_values": fields,
		})
	}
	if len(items) == 0 {
		return
	}
	result, err := o.client.BatchUpdateLeads(items)
	if err != nil {
		log.Printf("[OUTBOX] BatchUpdateLeads (custom_fields, %d items) failed: %v", len(items), err)
		var toFail []claimedRow
		for _, e := range entries {
			toFail = append(toFail, e.row)
		}
		o.failRowsBulk(ctx, toFail, err.Error())
		return
	}
	tsByKommoID := make(map[int64]int64, len(result))
	for _, r := range result {
		tsByKommoID[int64(r.ID)] = r.UpdatedAt
	}
	var completed []uuid.UUID
	for _, e := range entries {
		ts := tsByKommoID[e.row.KommoEntityID]
		// Remove (sinc) echoes — they were overwritten in Kommo.
		_, _ = o.db.Exec(ctx, `DELETE FROM interactions WHERE lead_id = $1 AND type = 'call' AND notes LIKE '(sinc)%'`, e.row.EntityID)
		// Assign kommo_call_slot on the first KommoCallSlotCount calls.
		for i, call := range e.calls {
			if i < KommoCallSlotCount {
				slotNum := i + 1
				_, _ = o.db.Exec(ctx, `UPDATE interactions SET kommo_call_slot = $1 WHERE id = $2`, slotNum, call.id)
			}
		}
		if ts > 0 {
			_, _ = o.db.Exec(ctx, `UPDATE leads SET kommo_last_pushed_at = $1 WHERE id = $2`, ts, e.row.EntityID)
		}
		completed = append(completed, e.row.ID)
	}
	o.completeRows(ctx, completed)
	log.Printf("[OUTBOX] flushLeadCustomFields pushed %d leads in 1 PATCH", len(items))
	o.logBatch("lead_observations", "lead", fmt.Sprintf("Batch observations → Kommo (%d leads)", len(items)), "pushed", claimed, 1, startedAt, nil)
}

// interactionData mirrors the local struct used by PushLeadObservations.
type interactionData struct {
	id        uuid.UUID
	notes     string
	createdAt time.Time
	createdBy string
}

func loadLeadCallInteractions(ctx context.Context, db *pgxpool.Pool, leadID uuid.UUID) ([]interactionData, error) {
	rows, err := db.Query(ctx, `
		SELECT i.id, i.notes, i.created_at, u.display_name
		FROM interactions i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.lead_id = $1 AND i.type = 'call'
		  AND (i.notes IS NULL OR i.notes NOT LIKE '(sinc)%')
		ORDER BY i.created_at ASC
	`, leadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []interactionData
	for rows.Next() {
		var cd interactionData
		var notes, createdBy *string
		if err := rows.Scan(&cd.id, &notes, &cd.createdAt, &createdBy); err != nil {
			continue
		}
		if notes != nil {
			cd.notes = *notes
		}
		if createdBy != nil {
			cd.createdBy = *createdBy
		}
		out = append(out, cd)
	}
	return out, nil
}

func buildCallCustomFields(calls []interactionData) []KommoCustomFieldWrite {
	var fields []KommoCustomFieldWrite
	for slot := 0; slot < KommoCallSlotCount; slot++ {
		if slot < len(calls) {
			call := calls[slot]
			resp := call.createdBy
			if resp == "" {
				resp = "Clarin"
			}
			fecha := call.createdAt.Format("02/01/2006 15:04")
			resp = fecha + " " + resp
			fields = append(fields,
				KommoCustomFieldWrite{FieldID: KommoCallFieldResponsable[slot], Values: []KommoCustomFieldWriteVal{{Value: resp}}},
				KommoCustomFieldWrite{FieldID: KommoCallFieldResultado[slot], Values: []KommoCustomFieldWriteVal{{Value: call.notes}}},
			)
		} else {
			fields = append(fields,
				KommoCustomFieldWrite{FieldID: KommoCallFieldResponsable[slot], Values: []KommoCustomFieldWriteVal{{Value: ""}}},
				KommoCustomFieldWrite{FieldID: KommoCallFieldResultado[slot], Values: []KommoCustomFieldWriteVal{{Value: ""}}},
			)
		}
	}
	if len(calls) > KommoCallSlotCount {
		var b strings.Builder
		for i := KommoCallSlotCount; i < len(calls); i++ {
			c := calls[i]
			cb := c.createdBy
			if cb == "" {
				cb = "Clarin"
			}
			fmt.Fprintf(&b, "Llamada %d - %s %s: %s\n", i+1, c.createdAt.Format("02/01/2006 15:04"), cb, c.notes)
		}
		fields = append(fields, KommoCustomFieldWrite{FieldID: KommoCallFieldOtrasLlamadas, Values: []KommoCustomFieldWriteVal{{Value: b.String()}}})
	} else {
		fields = append(fields, KommoCustomFieldWrite{FieldID: KommoCallFieldOtrasLlamadas, Values: []KommoCustomFieldWriteVal{{Value: ""}}})
	}
	return fields
}
