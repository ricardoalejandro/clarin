package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/storage"
)

const storageInventoryBatch = 500

// ReconcileStorageInventory exposes the same bounded worker to explicit local
// maintenance/fixture commands without constructing an HTTP server.
func ReconcileStorageInventory(ctx context.Context, db *pgxpool.Pool, store *storage.Storage, accountID uuid.UUID) error {
	if db == nil || store == nil || accountID == uuid.Nil {
		return fmt.Errorf("invalid inventory reconciliation scope")
	}
	server := &Server{repos: repository.NewRepositories(db), storage: store}
	return server.ReconcileStorageInventory(ctx, accountID)
}

var storageInventorySourceFrom = regexp.MustCompile(` FROM ([a-z_]+)(?: ([a-z]+))?`)

type storageInventorySource struct{ kind, idColumn, origin, sql string }

func storageInventorySources() []storageInventorySource {
	sources := make([]storageInventorySource, 0, len(storageSelfServiceReferenceQueries))
	for _, source := range storageSelfServiceReferenceQueries {
		match := storageInventorySourceFrom.FindStringSubmatch(source.sql)
		if len(match) < 2 {
			continue
		}
		alias := match[1]
		if len(match) > 2 && match[2] != "" {
			alias = match[2]
		}
		sources = append(sources, storageInventorySource{kind: match[1], idColumn: alias + ".id", origin: source.origin, sql: source.sql})
	}
	return sources
}

// StartStorageInventoryWorker reconciles bounded pages outside request paths.
// Each tenant has its own transaction advisory lock; another replica can resume
// its durable checkpoints after a crash without blocking another account.
func (s *Server) StartStorageInventoryWorker(ctx context.Context) {
	if s.storage == nil || s.repos == nil {
		return
	}
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		var after uuid.UUID
		for {
			cycleCtx, cancel := context.WithTimeout(ctx, 40*time.Second)
			rows, err := s.repos.DB().Query(cycleCtx, `SELECT id FROM accounts WHERE id>$1::uuid ORDER BY id LIMIT 20`, after)
			var accounts []uuid.UUID
			if err == nil {
				for rows.Next() {
					var id uuid.UUID
					if err = rows.Scan(&id); err != nil {
						break
					}
					accounts = append(accounts, id)
				}
				if err == nil {
					err = rows.Err()
				}
				rows.Close()
			}
			if err == nil {
				for _, id := range accounts {
					if _, err = s.storageInventoryCycle(cycleCtx, id); err != nil && cycleCtx.Err() == nil {
						log.Printf("[StorageInventory] reconciliation failed account=%s: %v", id, err)
					}
					after = id
				}
				if len(accounts) < 20 {
					after = uuid.Nil
				}
			}
			cancel()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

// ReconcileStorageInventory is also used by integration fixtures and operational
// repair commands. It is never called by a listing or usage HTTP request.
func (s *Server) ReconcileStorageInventory(ctx context.Context, accountID uuid.UUID) error {
	if accountID == uuid.Nil {
		return fmt.Errorf("missing inventory account")
	}
	for {
		pending, err := s.storageInventoryCycle(ctx, accountID)
		if err != nil {
			return err
		}
		if !pending {
			return nil
		}
		if err = ctx.Err(); err != nil {
			return err
		}
	}
}

func (s *Server) storageInventoryCycle(ctx context.Context, accountID uuid.UUID) (pendingResult bool, resultErr error) {
	tx, err := s.repos.DB().Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	defer func() {
		if resultErr != nil {
			_ = tx.Rollback(ctx)
			recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
			defer cancel()
			_, _ = s.repos.DB().Exec(recordCtx, `UPDATE storage_inventory_scans SET last_error='reconciliation_failed',next_run_at=GREATEST(next_run_at,NOW()+INTERVAL '5 seconds') WHERE account_id=$1`, accountID)
		}
	}()
	var locked bool
	if err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('storage-inventory:'||$1::text,0))`, accountID).Scan(&locked); err != nil {
		return false, err
	}
	if !locked {
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(25 * time.Millisecond):
			return true, nil
		}
	}
	sources := storageInventorySources()
	kinds := make([]string, 0, len(sources))
	for _, source := range sources {
		kinds = append(kinds, source.kind)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO storage_inventory_backfill(account_id,source_kind) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING`, accountID, kinds); err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO storage_inventory_scans(account_id,bucket_kind) VALUES($1,'ordinary'),($1,'private') ON CONFLICT DO NOTHING`, accountID); err != nil {
		return false, err
	}
	var beforeReady, afterReady bool
	var beforeCount, beforeBytes int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT object_count FROM storage_inventory_totals WHERE account_id=$1),0),COALESCE((SELECT size_bytes FROM storage_inventory_totals WHERE account_id=$1),0),`+storageInventoryWorkerReadySQL, accountID).Scan(&beforeCount, &beforeBytes, &beforeReady); err != nil {
		return false, err
	}
	pending, err := s.storageInventoryBackfill(ctx, tx, accountID, sources)
	if err != nil {
		return false, err
	}
	more, err := s.storageInventoryIndexSources(ctx, tx, accountID, sources)
	if err != nil {
		return false, err
	}
	indexedChanged := more
	pending = pending || more
	more, err = s.storageInventoryPhysicalPage(ctx, tx, accountID)
	if err != nil {
		return false, err
	}
	pending = pending || more
	var afterCount, afterBytes int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT object_count FROM storage_inventory_totals WHERE account_id=$1),0),COALESCE((SELECT size_bytes FROM storage_inventory_totals WHERE account_id=$1),0),`+storageInventoryWorkerReadySQL, accountID).Scan(&afterCount, &afterBytes, &afterReady); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	if indexedChanged || beforeCount != afterCount || beforeBytes != afterBytes || beforeReady != afterReady {
		s.storageSelfServicePublishChanged(accountID, "changed")
	}
	return pending, nil
}

const storageInventoryWorkerReadySQL = `(
 NOT EXISTS(SELECT 1 FROM storage_inventory_backfill WHERE account_id=$1 AND NOT complete)
 AND NOT EXISTS(SELECT 1 FROM storage_inventory_sources WHERE account_id=$1 AND generation<>indexed_generation)
 AND (SELECT count(*) FROM storage_inventory_scans WHERE account_id=$1 AND completed_at IS NOT NULL AND last_error='')=2
)`

func (s *Server) storageInventoryBackfill(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, sources []storageInventorySource) (bool, error) {
	var kind string
	var after *uuid.UUID
	err := tx.QueryRow(ctx, `SELECT source_kind,after_id FROM storage_inventory_backfill WHERE account_id=$1 AND NOT complete ORDER BY source_kind LIMIT 1 FOR UPDATE`, accountID).Scan(&kind, &after)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var source *storageInventorySource
	for i := range sources {
		if sources[i].kind == kind {
			source = &sources[i]
			break
		}
	}
	if source == nil {
		return false, fmt.Errorf("unknown inventory source %s", kind)
	}
	checkpoint := uuid.Nil
	if after != nil {
		checkpoint = *after
	}
	query := source.sql + " AND " + source.idColumn + ">$2::uuid ORDER BY " + source.idColumn + " LIMIT $3"
	rows, err := tx.Query(ctx, query, accountID, checkpoint, storageInventoryBatch)
	if err != nil {
		return false, err
	}
	ids := make([]string, 0, storageInventoryBatch)
	for rows.Next() {
		var id, label, href, name, payload string
		if err = rows.Scan(&id, &label, &href, &name, &payload); err != nil {
			rows.Close()
			return false, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	if len(ids) > 0 {
		if _, err = tx.Exec(ctx, `INSERT INTO storage_inventory_sources(account_id,source_kind,source_id) SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING`, accountID, kind, ids); err != nil {
			return false, err
		}
		checkpoint, err = uuid.Parse(ids[len(ids)-1])
		if err != nil {
			return false, err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE storage_inventory_backfill SET after_id=$3::uuid,complete=$4 WHERE account_id=$1 AND source_kind=$2`, accountID, kind, checkpoint, len(ids) < storageInventoryBatch)
	return true, err
}

type storageInventoryRefRow struct {
	SourceKind string `json:"source_kind"`
	SourceID   string `json:"source_id"`
	ObjectKey  string `json:"object_key"`
	Generation int64  `json:"source_generation"`
	Origin     string `json:"origin"`
	RefID      string `json:"ref_id"`
	Label      string `json:"label"`
	Href       string `json:"href"`
	Filename   string `json:"filename"`
	Readable   bool   `json:"readable"`
}

func (s *Server) storageInventoryIndexSources(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, sources []storageInventorySource) (bool, error) {
	rows, err := tx.Query(ctx, `SELECT source_kind,source_id,generation FROM storage_inventory_sources WHERE account_id=$1 AND generation<>indexed_generation AND next_attempt_at<=NOW() AND (source_kind NOT IN ('storage_objects','media_assets') OR (SELECT count(*) FROM storage_inventory_scans WHERE account_id=$1 AND completed_at IS NOT NULL)=2) ORDER BY source_kind,source_id LIMIT $2 FOR UPDATE`, accountID, storageInventoryBatch)
	if err != nil {
		return false, err
	}
	groups := map[string][]string{}
	versions := map[string]int64{}
	count := 0
	for rows.Next() {
		var kind, id string
		var generation int64
		if err = rows.Scan(&kind, &id, &generation); err != nil {
			rows.Close()
			return false, err
		}
		groups[kind] = append(groups[kind], id)
		versions[kind+"|"+id] = generation
		count++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	if count == 0 {
		return false, nil
	}
	indexed := make([]storageInventoryRefRow, 0, count)
	for _, source := range sources {
		ids := groups[source.kind]
		if len(ids) == 0 {
			continue
		}
		query := source.sql + " AND " + source.idColumn + "=ANY($2::uuid[])"
		rows, err = tx.Query(ctx, query, accountID, ids)
		if err != nil {
			return false, fmt.Errorf("inventory source %s: %w", source.kind, err)
		}
		for rows.Next() {
			var id, label, href, name, payload string
			if err = rows.Scan(&id, &label, &href, &name, &payload); err != nil {
				rows.Close()
				return false, err
			}
			for key, readable := range storageSelfServiceReferenceValues(accountID, payload, s.storage) {
				item := storageInventoryRefRow{SourceKind: source.kind, SourceID: id, ObjectKey: key, Generation: versions[source.kind+"|"+id], Origin: source.origin, RefID: id, Label: label, Href: href, Filename: name, Readable: readable}
				if !readable {
					item.Origin = "private_external"
					item.Label = ""
					item.Href = ""
					item.Filename = ""
				}
				indexed = append(indexed, item)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return false, err
		}
	}
	// Metadata writes are durable hints to inspect a newly uploaded/replaced
	// object; the periodic S3 traversal remains the recovery path for legacy or
	// interrupted uploads that never created an inventory ledger row.
	for _, kind := range []string{"storage_objects", "media_assets"} {
		ids := groups[kind]
		if len(ids) == 0 {
			continue
		}
		rows, err = tx.Query(ctx, `SELECT DISTINCT src.object_key FROM `+kind+` src JOIN storage_inventory_sources changed ON changed.account_id=src.account_id AND changed.source_id=src.id::text AND changed.source_kind='`+kind+`' WHERE src.account_id=$1 AND src.id=ANY($2::uuid[]) AND NOT EXISTS(SELECT 1 FROM storage_inventory_objects io WHERE io.account_id=src.account_id AND io.object_key=src.object_key AND io.bucket_kind=CASE WHEN split_part(src.object_key,'/',2)='_private' THEN 'private' ELSE 'ordinary' END AND io.observed_at>=changed.changed_at)`, accountID, ids)
		if err != nil {
			return false, err
		}
		var keys []string
		for rows.Next() {
			var key string
			if err = rows.Scan(&key); err != nil {
				rows.Close()
				return false, err
			}
			keys = append(keys, key)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return false, err
		}
		for _, key := range keys {
			if !storageSelfServiceValidKey(accountID, key) {
				continue
			}
			bucket := "ordinary"
			if storage.IsPrivateObjectKey(key) {
				bucket = "private"
			}
			observedAt := time.Now().UTC()
			info, statErr := s.storage.StatInventoryObject(ctx, accountID, bucket, key)
			if statErr != nil {
				if storageSelfServiceObjectMissing(statErr) {
					if _, err = tx.Exec(ctx, `UPDATE storage_inventory_objects SET presence='missing',observed_at=$4 WHERE account_id=$1 AND bucket_kind=$2 AND object_key=$3 AND observed_at<=$4`, accountID, bucket, key, observedAt); err != nil {
						return false, err
					}
					continue
				}
				return false, statErr
			}
			if err = s.storageInventoryUpsertObjects(ctx, tx, accountID, bucket, 0, []storage.InventoryObject{{Key: key, Size: info.Size, ETag: info.ETag, LastModified: info.LastModified, ObservedAt: observedAt}}); err != nil {
				return false, err
			}
		}
	}
	for kind, ids := range groups {
		if _, err = tx.Exec(ctx, `DELETE FROM storage_inventory_references WHERE account_id=$1 AND source_kind=$2 AND source_id=ANY($3::text[])`, accountID, kind, ids); err != nil {
			return false, err
		}
	}
	if len(indexed) > 0 {
		data, _ := json.Marshal(indexed)
		_, err = tx.Exec(ctx, `INSERT INTO storage_inventory_references(account_id,source_kind,source_id,object_key,source_generation,origin,ref_id,label,href,filename,readable)
		SELECT $1,r.source_kind,r.source_id,r.object_key,r.source_generation,r.origin,r.ref_id,r.label,r.href,r.filename,r.readable
		FROM jsonb_to_recordset($2::jsonb) r(source_kind text,source_id text,object_key text,source_generation bigint,origin text,ref_id text,label text,href text,filename text,readable boolean) ON CONFLICT DO NOTHING`, accountID, data)
		if err != nil {
			return false, err
		}
	}
	for kind, ids := range groups {
		if _, err = tx.Exec(ctx, `UPDATE storage_inventory_sources SET indexed_generation=generation,attempts=0,last_error='' WHERE account_id=$1 AND source_kind=$2 AND source_id=ANY($3::text[])`, accountID, kind, ids); err != nil {
			return false, err
		}
	}
	// One final no-work cycle is cheap and lets the caller both drain new hints
	// and distinguish a successful projection change from deferred dirty work.
	return count > 0, nil
}

func (s *Server) storageInventoryPhysicalPage(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) (bool, error) {
	var bucket, after string
	var generation int64
	var started *time.Time
	err := tx.QueryRow(ctx, `SELECT bucket_kind,after_key,scan_generation,started_at FROM storage_inventory_scans WHERE account_id=$1 AND next_run_at<=NOW() ORDER BY bucket_kind LIMIT 1 FOR UPDATE`, accountID).Scan(&bucket, &after, &generation, &started)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if started == nil {
		if err = tx.QueryRow(ctx, `UPDATE storage_inventory_scans SET scan_generation=scan_generation+1,started_at=NOW(),after_key='' WHERE account_id=$1 AND bucket_kind=$2 RETURNING scan_generation,started_at`, accountID, bucket).Scan(&generation, &started); err != nil {
			return false, err
		}
		after = ""
	}
	objects, more, err := s.storage.ListInventoryPage(ctx, accountID, bucket, after, 1000)
	if err != nil {
		return false, err
	}
	if err = s.storageInventoryUpsertObjects(ctx, tx, accountID, bucket, generation, objects); err != nil {
		return false, err
	}
	if len(objects) > 0 {
		after = objects[len(objects)-1].Key
	}
	if more {
		_, err = tx.Exec(ctx, `UPDATE storage_inventory_scans SET after_key=$3 WHERE account_id=$1 AND bucket_kind=$2`, accountID, bucket, after)
		return true, err
	}
	// The listing is not a snapshot. Only old observations missed in this
	// completed pass are candidates, and each absence requires a real Stat.
	rows, err := tx.Query(ctx, `SELECT object_key FROM storage_inventory_objects WHERE account_id=$1 AND bucket_kind=$2 AND presence='present' AND scan_generation<>$3 AND observed_at<$4 ORDER BY object_key LIMIT 100`, accountID, bucket, generation, started)
	if err != nil {
		return false, err
	}
	var missing []string
	for rows.Next() {
		var key string
		if err = rows.Scan(&key); err != nil {
			rows.Close()
			return false, err
		}
		missing = append(missing, key)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, err
	}
	for _, key := range missing {
		observedAt := time.Now().UTC()
		info, statErr := s.storage.StatInventoryObject(ctx, accountID, bucket, key)
		if statErr == nil {
			if err = s.storageInventoryUpsertObjects(ctx, tx, accountID, bucket, generation, []storage.InventoryObject{{Key: key, Size: info.Size, ETag: info.ETag, LastModified: info.LastModified, ObservedAt: observedAt}}); err != nil {
				return false, err
			}
			continue
		}
		if !storageSelfServiceObjectMissing(statErr) {
			return false, statErr
		}
		if _, err = tx.Exec(ctx, `UPDATE storage_inventory_objects SET presence='missing',observed_at=$5,scan_generation=$4 WHERE account_id=$1 AND bucket_kind=$2 AND object_key=$3 AND observed_at<=$5`, accountID, bucket, key, generation, observedAt); err != nil {
			return false, err
		}
	}
	if len(missing) == 100 {
		_, err = tx.Exec(ctx, `UPDATE storage_inventory_scans SET after_key=$3 WHERE account_id=$1 AND bucket_kind=$2`, accountID, bucket, after)
		return true, err
	}
	_, err = tx.Exec(ctx, `UPDATE storage_inventory_scans SET after_key='',started_at=NULL,completed_at=NOW(),last_error='',next_run_at=NOW()+INTERVAL '15 minutes' WHERE account_id=$1 AND bucket_kind=$2`, accountID, bucket)
	return true, err
}

func (s *Server) storageInventoryUpsertObjects(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, bucket string, generation int64, objects []storage.InventoryObject) error {
	if len(objects) == 0 {
		return nil
	}
	keys := make([]string, 0, len(objects))
	for _, object := range objects {
		if storageSelfServiceValidKey(accountID, object.Key) {
			keys = append(keys, object.Key)
		}
	}
	type metadata struct{ filename, contentType string }
	meta := map[string]metadata{}
	rows, err := tx.Query(ctx, `SELECT DISTINCT ON(object_key) object_key,filename,content_type FROM (SELECT object_key,filename,content_type,0 AS priority,updated_at FROM storage_objects WHERE account_id=$1 AND object_key=ANY($2::text[]) UNION ALL SELECT object_key,filename,content_type,1,updated_at FROM media_assets WHERE account_id=$1 AND object_key=ANY($2::text[])) m ORDER BY object_key,priority DESC,updated_at DESC`, accountID, keys)
	if err != nil {
		return err
	}
	for rows.Next() {
		var key string
		var m metadata
		if err = rows.Scan(&key, &m.filename, &m.contentType); err != nil {
			rows.Close()
			return err
		}
		meta[key] = m
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	type row struct {
		Key         string    `json:"object_key"`
		Size        int64     `json:"size_bytes"`
		ETag        string    `json:"etag"`
		Modified    time.Time `json:"last_modified"`
		ObservedAt  time.Time `json:"observed_at"`
		Filename    string    `json:"filename"`
		Type        string    `json:"media_type"`
		ContentType string    `json:"content_type"`
	}
	items := make([]row, 0, len(keys))
	for _, object := range objects {
		if !storageSelfServiceValidKey(accountID, object.Key) {
			continue
		}
		m := meta[object.Key]
		name := m.filename
		if name == "" {
			name = path.Base(object.Key)
		}
		name = path.Base(strings.ReplaceAll(name, "\\", "/"))
		observedAt := object.ObservedAt
		if observedAt.IsZero() {
			observedAt = time.Now().UTC()
		}
		items = append(items, row{object.Key, object.Size, object.ETag, object.LastModified, observedAt, name, storageSelfServiceMediaType(name, m.contentType), m.contentType})
	}
	data, _ := json.Marshal(items)
	_, err = tx.Exec(ctx, `INSERT INTO storage_inventory_objects(account_id,bucket_kind,object_key,size_bytes,etag,last_modified,observed_at,scan_generation,presence,filename,media_type,content_type)
	SELECT $1,$2,r.object_key,r.size_bytes,r.etag,r.last_modified,r.observed_at,$3,'present',r.filename,r.media_type,r.content_type FROM jsonb_to_recordset($4::jsonb) r(object_key text,size_bytes bigint,etag text,last_modified timestamptz,observed_at timestamptz,filename text,media_type text,content_type text)
	ON CONFLICT(account_id,bucket_kind,object_key) DO UPDATE SET size_bytes=EXCLUDED.size_bytes,etag=EXCLUDED.etag,last_modified=EXCLUDED.last_modified,observed_at=EXCLUDED.observed_at,scan_generation=CASE WHEN EXCLUDED.scan_generation=0 THEN storage_inventory_objects.scan_generation ELSE EXCLUDED.scan_generation END,presence='present',filename=EXCLUDED.filename,media_type=EXCLUDED.media_type,content_type=EXCLUDED.content_type WHERE EXCLUDED.observed_at>=storage_inventory_objects.observed_at`, accountID, bucket, generation, data)
	return err
}
