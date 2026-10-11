package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

type storageInventoryFreshness struct {
	Status       string     `json:"catalog_status"`
	LastVerified *time.Time `json:"last_verified_at"`
	Complete     bool       `json:"inventory_complete"`
}

func (s *Server) storageInventoryFreshness(ctx context.Context, accountID uuid.UUID) (storageInventoryFreshness, error) {
	f := storageInventoryFreshness{Status: "indexing"}
	var scans int
	var unfinished, dirty, failed bool
	err := s.repos.DB().QueryRow(ctx, `SELECT
	 (SELECT count(*) FROM storage_inventory_scans WHERE account_id=$1 AND completed_at IS NOT NULL),
	 (SELECT min(completed_at) FROM storage_inventory_scans WHERE account_id=$1),
	 (SELECT count(*) FROM storage_inventory_backfill WHERE account_id=$1)<>$2::int OR EXISTS(SELECT 1 FROM storage_inventory_backfill WHERE account_id=$1 AND NOT complete),
	 EXISTS(SELECT 1 FROM storage_inventory_sources WHERE account_id=$1 AND generation<>indexed_generation),
	 EXISTS(SELECT 1 FROM storage_inventory_scans WHERE account_id=$1 AND last_error<>'')`, accountID, len(storageInventorySources())).Scan(&scans, &f.LastVerified, &unfinished, &dirty, &failed)
	if err != nil {
		return f, err
	}
	f.Complete = scans == 2 && !unfinished && !dirty
	if f.Complete {
		f.Status = "ready"
	}
	if failed {
		f.Status = "degraded"
		f.Complete = false
	}
	return f, nil
}

func storageInventoryOrigins(claims *service.JWTClaims) []string {
	origins := []string{}
	for _, origin := range []string{"chats", "quick_replies", "stickers", "campaigns", "dynamics", "surveys", "documents", "contacts"} {
		if storageSelfServiceHasPermission(claims, storageSelfServiceOriginPermission(origin)) {
			origins = append(origins, origin)
		}
	}
	return origins
}

// Compare source identities once for this object. A correlated anti-join can
// be planned as 10000-by-10000 nested comparisons when generation estimates
// underestimate authorized rows. EXCEPT keeps the exact same source/key policy,
// including readable mirrors and the actor's verified ownership exception.
func storageInventoryRetainedElsewhereSQL(objectKey string) string {
	return `EXISTS(SELECT hidden.source_kind,hidden.source_id FROM storage_inventory_references hidden
 WHERE hidden.account_id=$1 AND hidden.object_key=` + objectKey + `
 AND NOT(hidden.source_kind='storage_upload_ownership' AND EXISTS(SELECT 1 FROM storage_upload_ownership own
  WHERE own.account_id=$1 AND own.actor_id=$2 AND own.id::text=hidden.source_id AND own.provenance_verified AND own.state='active'))
 EXCEPT SELECT vr.source_kind,vr.source_id FROM authorized_refs vr WHERE vr.object_key=` + objectKey + `)`
}

// All labels, filenames, search predicates and counts use this actor-specific
// relation. Resource grants are resolved on every query; no cached permission
// bit can retain access after an ACL or account membership is revoked.
// Materialize only private ACL identities within this statement: otherwise
// PostgreSQL expands the large canonical predicates into every correlated
// projection. Ordinary references remain inline so account/key indexes apply.
func storageInventoryCTE(claims *service.JWTClaims, includePrivateSources ...bool) string {
	privateAccess, privateRecovery, privateMutation, privateRestore := "FALSE", "FALSE", "FALSE", "FALSE"
	boardACL := ""
	// These claims were reloaded from current membership for this request. A
	// missing module cannot grant private access; avoid planning its resource
	// hierarchy at all for actors who cannot use either private module.
	if (len(includePrivateSources) == 0 || includePrivateSources[0]) && (storageSelfServiceHasPermission(claims, domain.PermTasks) || storageSelfServiceHasPermission(claims, domain.PermWhiteboards)) {
		privateAccess = repository.StoragePrivateMediaAccessSQL("ir", "$2", true)
		privateRecovery = repository.StoragePrivateMediaRecoveryAccessSQL("rr", "$2", true)
		privateMutation = repository.StoragePrivateMediaMutationSQL("ir", "$2", true)
		privateRestore = repository.StoragePrivateMediaRecoveryMutationSQL("rr", "$2", true)
		boardACL = "storage_private_visible_boards AS MATERIALIZED (" + repository.StoragePrivateWhiteboardACLCTE("$1", "$2") + "), "
	}
	quickReplyManage := "FALSE"
	if storageSelfServiceHasPermission(claims, domain.PermQuickRepliesManage) {
		quickReplyManage = "TRUE"
	}
	return "WITH " + boardACL + `catalog_state AS (
 SELECT ((SELECT count(*) FROM storage_inventory_backfill WHERE account_id=$1 AND complete)=` + strconv.Itoa(len(storageInventorySources())) + `
 AND (SELECT count(*) FROM storage_inventory_scans WHERE account_id=$1 AND completed_at IS NOT NULL)=2
	 AND NOT EXISTS(SELECT 1 FROM storage_inventory_scans WHERE account_id=$1 AND last_error<>'')
 AND NOT EXISTS(SELECT 1 FROM storage_inventory_sources WHERE account_id=$1 AND generation<>indexed_generation)) AS ready
 ), private_readable_refs AS MATERIALIZED (
 SELECT DISTINCT ir.source_kind,ir.source_id FROM storage_inventory_references ir
 WHERE ir.account_id=$1 AND ir.readable AND ir.source_kind IN ('task_attachments','whiteboard_assets','whiteboard_revision_assets')
 AND (` + privateAccess + `)
 ), private_mutable_refs AS MATERIALIZED (
 SELECT DISTINCT ir.source_kind,ir.source_id FROM storage_inventory_references ir
 WHERE ir.account_id=$1 AND ir.readable AND $5::boolean AND ir.source_kind IN ('task_attachments','whiteboard_assets','whiteboard_revision_assets')
 AND (` + privateMutation + `)
 ), private_readable_recoveries AS MATERIALIZED (
 SELECT rr.id FROM storage_removed_references rr WHERE rr.account_id=$1 AND rr.state IN ('removed','purging')
 AND rr.adapter IN ('private_work','private_whiteboards') AND (` + privateRecovery + `)
 ), private_restorable_recoveries AS MATERIALIZED (
 SELECT rr.id FROM storage_removed_references rr WHERE rr.account_id=$1 AND rr.state='removed' AND $5::boolean
 AND rr.adapter IN ('private_work','private_whiteboards') AND (` + privateRestore + `)
 ), authorized_refs AS NOT MATERIALIZED (
	 SELECT ir.* FROM storage_inventory_references ir
	 JOIN storage_inventory_sources src ON src.account_id=ir.account_id AND src.source_kind=ir.source_kind AND src.source_id=ir.source_id
	 WHERE ir.account_id=$1 AND ir.readable AND src.generation=ir.source_generation AND src.indexed_generation=src.generation
	 AND ((ir.origin=ANY($3::text[]) AND (
	  (split_part(ir.object_key,'/',2) NOT IN ('_private','statuses','task-previews')
	   AND NOT(split_part(ir.object_key,'/',2)='tasks' AND split_part(ir.object_key,'/',3)='attachments')
	   AND strpos(ir.object_key,'/whiteboards/')=0)
	  OR (ir.source_kind='contacts' AND split_part(ir.object_key,'/',2)='_private' AND split_part(ir.object_key,'/',3)='avatars')
	 )) OR EXISTS(SELECT 1 FROM private_readable_refs allowed WHERE allowed.source_kind=ir.source_kind AND allowed.source_id=ir.source_id))
	), mutable_refs AS NOT MATERIALIZED (
 SELECT ir.* FROM authorized_refs ir WHERE $5::boolean AND (
 ir.origin IN ('chats','stickers','contacts')
 OR (ir.origin='quick_replies' AND ` + quickReplyManage + `)
 OR (ir.origin='campaigns' AND EXISTS(SELECT 1 FROM campaigns campaign WHERE campaign.account_id=ir.account_id AND campaign.status='draft'
  AND campaign.id::text=CASE WHEN ir.source_kind='campaigns' THEN ir.source_id ELSE (SELECT attachment.campaign_id::text FROM campaign_attachments attachment WHERE attachment.id::text=ir.source_id) END
  AND strpos(COALESCE(campaign.settings::text,''),ir.object_key)=0))
 OR EXISTS(SELECT 1 FROM private_mutable_refs editable WHERE editable.source_kind=ir.source_kind AND editable.source_id=ir.source_id))
 ), inventory_files AS NOT MATERIALIZED (
	 SELECT io.object_key,COALESCE(NULLIF(t.filename,''),CASE WHEN EXISTS(SELECT 1 FROM storage_upload_ownership own WHERE own.account_id=$1 AND own.object_key=io.object_key AND own.actor_id=$2 AND own.provenance_verified AND own.state='active') THEN COALESCE(NULLIF((SELECT own.filename FROM storage_upload_ownership own WHERE own.account_id=$1 AND own.object_key=io.object_key AND own.actor_id=$2 AND own.provenance_verified AND own.state='active'),''),'Archivo subido') ELSE COALESCE(NULLIF((SELECT vr.filename FROM authorized_refs vr WHERE vr.object_key=io.object_key AND vr.filename<>'' ORDER BY vr.origin DESC,vr.ref_id DESC LIMIT 1),''),CASE io.media_type WHEN 'image' THEN 'Foto' WHEN 'video' THEN 'Vídeo' WHEN 'audio' THEN 'Audio' ELSE 'Documento' END) END) AS filename,
	 COALESCE(NULLIF(t.media_type,''),io.media_type) AS media_type,io.size_bytes,io.last_modified,
	 CASE WHEN t.object_key IS NOT NULL THEN 'trash' ELSE 'active' END AS status,
	 t.removed_at AS trash_at,t.purge_after,
	 ($5::boolean AND t.object_key IS NULL AND EXISTS(SELECT 1 FROM authorized_refs ar WHERE ar.object_key=io.object_key AND ar.origin='chats')
	  AND NOT EXISTS(SELECT 1 FROM storage_inventory_references ar WHERE ar.account_id=$1 AND ar.object_key=io.object_key AND ar.origin<>'chats')) AS can_remove,
	 ($5::boolean AND t.object_key IS NULL AND EXISTS(SELECT 1 FROM mutable_refs mr WHERE mr.object_key=io.object_key)) AS can_remove_uses,
 ($5::boolean AND t.state='trash') AS can_restore,
	 ($5::boolean AND (SELECT ready FROM catalog_state) AND t.state='trash' AND t.purge_after<=NOW() AND NOT EXISTS(SELECT 1 FROM storage_inventory_references ar WHERE ar.account_id=$1 AND ar.object_key=io.object_key)
	  AND NOT EXISTS(SELECT 1 FROM storage_removed_references newer WHERE newer.account_id=$1 AND newer.object_key=io.object_key AND newer.state IN ('removed','purging'))) AS can_purge,
	 (SELECT count(*) FROM authorized_refs vr WHERE vr.object_key=io.object_key) AS references_count,
	 COALESCE(t.id::text,'') AS recovery_id,
 ` + storageInventoryRetainedElsewhereSQL("io.object_key") + ` AS retained_elsewhere,
	 EXISTS(SELECT 1 FROM storage_upload_ownership own WHERE own.account_id=$1 AND own.object_key=io.object_key AND own.actor_id=$2 AND own.provenance_verified AND own.state='active') AS is_own_upload,
	 ((SELECT ready FROM catalog_state) AND EXISTS(SELECT 1 FROM storage_upload_ownership own WHERE own.account_id=$1 AND own.object_key=io.object_key AND own.actor_id=$2 AND own.provenance_verified AND own.state='active' AND own.last_uploaded_at<NOW()-INTERVAL '24 hours')
	 AND NOT EXISTS(SELECT 1 FROM storage_upload_ownership other WHERE other.account_id=$1 AND other.object_key=io.object_key AND other.actor_id<>$2 AND other.state<>'removed')
	 AND NOT EXISTS(SELECT 1 FROM storage_inventory_references ar WHERE ar.account_id=$1 AND ar.object_key=io.object_key AND ar.origin<>'private_upload_claims')
	 AND NOT EXISTS(SELECT 1 FROM storage_inventory_sources ds WHERE ds.account_id=$1 AND ds.generation<>ds.indexed_generation)) AS unused_upload
	 FROM storage_inventory_objects io
	 LEFT JOIN storage_media_trash t ON t.account_id=io.account_id AND t.object_key=io.object_key AND t.state IN ('trash','purging') AND jsonb_array_length(t.message_backups)>0 AND (t.actor_id=$2 OR $4::boolean) AND $6::boolean
	 WHERE io.account_id=$1 AND io.presence='present' AND io.media_type IN ('image','video','audio','document')
	 AND io.bucket_kind=CASE WHEN split_part(io.object_key,'/',2)='_private' THEN 'private' ELSE 'ordinary' END
	 AND (EXISTS(SELECT 1 FROM authorized_refs vr WHERE vr.object_key=io.object_key) OR t.object_key IS NOT NULL
	 OR EXISTS(SELECT 1 FROM storage_upload_ownership own WHERE own.account_id=$1 AND own.object_key=io.object_key AND own.actor_id=$2 AND own.provenance_verified AND own.state='active'))
	), recovery_files AS NOT MATERIALIZED (
	 SELECT rr.object_key,rr.filename,rr.media_type,rr.size_bytes,COALESCE(io.last_modified,rr.removed_at) AS last_modified,'trash'::text AS status,
	 rr.removed_at AS trash_at,rr.retain_until AS purge_after,false AS can_remove,false AS can_remove_uses,
 ($5::boolean AND rr.state='removed' AND (CASE WHEN rr.adapter IN ('private_work','private_whiteboards') THEN EXISTS(SELECT 1 FROM private_restorable_recoveries restorable WHERE restorable.id=rr.id) WHEN rr.origin_type='quick_replies' THEN ` + quickReplyManage + ` ELSE TRUE END)) AS can_restore,
	 ($5::boolean AND (SELECT ready FROM catalog_state) AND rr.state='removed' AND rr.retain_until<=NOW()
	  AND NOT EXISTS(SELECT 1 FROM storage_media_trash legacy WHERE legacy.account_id=$1 AND legacy.object_key=rr.object_key AND legacy.state IN ('trash','purging') AND jsonb_array_length(legacy.message_backups)>0)
	  AND NOT EXISTS(SELECT 1 FROM storage_inventory_references ar WHERE ar.account_id=$1 AND ar.object_key=rr.object_key)
	  AND NOT EXISTS(SELECT 1 FROM storage_removed_references retained WHERE retained.account_id=$1 AND retained.object_key=rr.object_key AND retained.state='removed' AND retained.retain_until>NOW())) AS can_purge,
	 (SELECT count(*) FROM authorized_refs vr WHERE vr.object_key=rr.object_key) AS references_count,rr.id::text AS recovery_id,` + storageInventoryRetainedElsewhereSQL("rr.object_key") + ` AS retained_elsewhere,false AS is_own_upload,false AS unused_upload
	 FROM storage_removed_references rr
	 LEFT JOIN storage_inventory_objects io ON io.account_id=rr.account_id AND io.object_key=rr.object_key AND io.bucket_kind=CASE WHEN split_part(rr.object_key,'/',2)='_private' THEN 'private' ELSE 'ordinary' END
	 WHERE rr.account_id=$1 AND rr.state IN ('removed','purging') AND (rr.actor_id=$2 OR $4::boolean)
	 AND (rr.origin_type=ANY($3::text[]) OR (rr.adapter='own_upload' AND rr.actor_id=$2) OR EXISTS(SELECT 1 FROM private_readable_recoveries recoverable WHERE recoverable.id=rr.id))
	), file_rows AS NOT MATERIALIZED (
	 SELECT object_key,filename,media_type,size_bytes,last_modified,status,trash_at,purge_after,
	 can_remove OR ($5::boolean AND unused_upload) AS can_remove,
	 can_remove_uses OR ($5::boolean AND unused_upload) AS can_remove_uses,
	 can_restore,can_purge,references_count,recovery_id,retained_elsewhere,is_own_upload,unused_upload
	 FROM inventory_files UNION ALL SELECT * FROM recovery_files
	)`
}

type storageInventoryFilter struct {
	Type, Query, Origin, Status, Sort, Order string
	MinSize                                  int64
	OlderThan                                *time.Time
	Limit, Offset                            int
}

func storageInventoryRequestFilter(c *fiber.Ctx) storageInventoryFilter {
	limit, offset := storageSelfServicePage(c)
	f := storageInventoryFilter{Type: strings.TrimSpace(c.Query("type")), Query: strings.ToLower(strings.TrimSpace(c.Query("q"))), Origin: c.Query("origin"), Status: c.Query("status", "all"), Sort: c.Query("sort", "size"), Order: c.Query("order", "desc"), MinSize: int64(c.QueryInt("min_size", 0)), Limit: limit, Offset: offset}
	if f.MinSize < 0 {
		f.MinSize = 0
	}
	days := c.QueryInt("older_than_days", 0)
	if days > 36500 {
		days = 36500
	}
	if days > 0 {
		before := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
		f.OlderThan = &before
	}
	return f
}

func (f storageInventoryFilter) orderSQL() string {
	direction := "DESC"
	if f.Order == "asc" {
		direction = "ASC"
	}
	return f.sortColumnSQL() + " " + direction + ",object_key ASC,recovery_id ASC"
}

func (f storageInventoryFilter) sortColumnSQL() string {
	switch f.Sort {
	case "size":
		return "size_bytes"
	case "name":
		return "lower(filename)"
	default:
		return "last_modified"
	}
}

const storageInventoryFilterSQL = ` WHERE ($7::text='' OR f.media_type=$7::text)
 AND ($8::text='' OR strpos(lower(f.filename),$8::text)>0 OR EXISTS(SELECT 1 FROM authorized_refs vr WHERE vr.object_key=f.object_key AND strpos(lower(vr.label),$8::text)>0))
 AND ($9::text='' OR ($9::text='own_uploads' AND f.is_own_upload) OR EXISTS(SELECT 1 FROM authorized_refs vr WHERE vr.object_key=f.object_key AND vr.origin=CASE $9::text WHEN 'tasks' THEN 'private_work' WHEN 'whiteboards' THEN 'private_whiteboards' ELSE $9::text END))
 AND CASE $10::text WHEN 'trash' THEN f.status='trash' WHEN 'trash_ready' THEN f.status='trash' AND f.can_purge WHEN 'removable' THEN f.status='active' AND f.can_remove WHEN 'protected' THEN f.status='active' AND NOT f.can_remove WHEN 'unused_uploads' THEN f.status='active' AND f.unused_upload ELSE f.status='active' END
 AND f.size_bytes >= $11::bigint AND ($12::timestamptz IS NULL OR f.last_modified<=$12::timestamptz)`

func storageInventoryArguments(accountID, actorID uuid.UUID, claims *service.JWTClaims) []any {
	return []any{accountID, actorID, storageInventoryOrigins(claims), domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin), storageSelfServiceHasPermission(claims, domain.PermSettings), storageSelfServiceHasPermission(claims, domain.PermChats)}
}

// PostgreSQL otherwise plans the private resource hierarchies even for a Chat-
// only account. This uncached probe can only suppress private results: if the
// first private reference appears concurrently, the following GET will include
// it. Whenever a private source or recovery exists, all canonical ACL predicates
// remain in the statement, including current module and resource authority.
func (s *Server) storageInventoryHasPrivateSources(ctx context.Context, accountID uuid.UUID, claims *service.JWTClaims) (bool, error) {
	if !storageSelfServiceHasPermission(claims, domain.PermTasks) && !storageSelfServiceHasPermission(claims, domain.PermWhiteboards) {
		return false, nil
	}
	var present bool
	err := s.repos.DB().QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM storage_inventory_references WHERE account_id=$1 AND source_kind IN ('task_attachments','whiteboard_assets','whiteboard_revision_assets'))
 OR EXISTS(SELECT 1 FROM storage_removed_references WHERE account_id=$1 AND state IN ('removed','purging') AND adapter IN ('private_work','private_whiteboards'))`, accountID).Scan(&present)
	return present, err
}

func storageInventoryPageSQL(claims *service.JWTClaims, filter storageInventoryFilter, includePrivateSources ...bool) string {
	// Select scalar identities first. A wide subquery still evaluates all of
	// its reference/capability projections before sorting on PostgreSQL 16.
	// The lateral fence then hydrates only selected rows, with the same live
	// authorization and generation checks as the scalar selection.
	direction := "DESC"
	if filter.Order == "asc" {
		direction = "ASC"
	}
	return storageInventoryCTE(claims, includePrivateSources...) + `, page_keys AS MATERIALIZED (
 SELECT f.object_key,f.recovery_id,` + filter.sortColumnSQL() + ` AS sort_value
 FROM file_rows f` + storageInventoryFilterSQL + ` ORDER BY ` + filter.orderSQL() + ` LIMIT $13 OFFSET $14
 ) SELECT to_jsonb(f) FROM page_keys selected CROSS JOIN LATERAL (
 SELECT * FROM file_rows f WHERE f.object_key=selected.object_key AND f.recovery_id=selected.recovery_id OFFSET 0
 ) f ORDER BY selected.sort_value ` + direction + `,selected.object_key ASC,selected.recovery_id ASC`
}

// Count and page the same authorized scalar projection in one statement.
// This avoids planning/evaluating the private ACL hierarchy twice. Only the
// bounded page gets full metadata; an empty page still returns the exact total.
func storageInventoryPageWithCountSQL(claims *service.JWTClaims, filter storageInventoryFilter, includePrivateSources ...bool) string {
	direction := "DESC"
	if filter.Order == "asc" {
		direction = "ASC"
	}
	return storageInventoryCTE(claims, includePrivateSources...) + `, filtered_keys AS MATERIALIZED (
        SELECT f.object_key,f.recovery_id,` + filter.sortColumnSQL() + ` AS sort_value FROM file_rows f` + storageInventoryFilterSQL + `
    ), page_keys AS MATERIALIZED (
        SELECT * FROM filtered_keys ORDER BY sort_value ` + direction + `,object_key ASC,recovery_id ASC LIMIT $13 OFFSET $14
    ), page_total AS (SELECT count(*) AS total FROM filtered_keys)
    SELECT (SELECT to_jsonb(f) FROM file_rows f WHERE f.object_key=selected.object_key AND f.recovery_id=selected.recovery_id OFFSET 0),page_total.total
    FROM page_total LEFT JOIN page_keys selected ON true
    ORDER BY selected.sort_value ` + direction + `,selected.object_key ASC,selected.recovery_id ASC`
}

// These bounded interactive reads expand current Work/Whiteboard ACLs into
// several SQL projections. JIT compilation of those expressions took 3-4 seconds
// on the reported account before returning any rows. Disable JIT only inside
// this read-only transaction; no session/global setting or permission is cached.
func (s *Server) storageInventoryReader(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.repos.DB().BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "SET LOCAL jit=off"); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

func (s *Server) storageInventoryFiles(ctx context.Context, accountID, actorID uuid.UUID, claims *service.JWTClaims, filter storageInventoryFilter) ([]storageSelfServiceFile, int, error) {
	privateSources, err := s.storageInventoryHasPrivateSources(ctx, accountID, claims)
	if err != nil {
		return nil, 0, err
	}
	q, err := s.storageInventoryReader(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer q.Rollback(context.Background())
	args := append(storageInventoryArguments(accountID, actorID, claims), filter.Type, filter.Query, filter.Origin, filter.Status, filter.MinSize, filter.OlderThan)
	var total int
	args = append(args, filter.Limit, filter.Offset)
	rows, err := q.Query(ctx, storageInventoryPageWithCountSQL(claims, filter, privateSources), args...)
	if err != nil {
		return nil, 0, err
	}
	files := make([]storageSelfServiceFile, 0, filter.Limit)
	keys := make([]string, 0, filter.Limit)
	for rows.Next() {
		var data []byte
		var file storageSelfServiceFile
		if err = rows.Scan(&data, &total); err != nil {
			rows.Close()
			return nil, 0, err
		}
		if len(data) == 0 {
			continue
		}
		if err = json.Unmarshal(data, &file); err != nil {
			rows.Close()
			return nil, 0, err
		}
		file.PreviewURL = "/api/storage/content?object_key=" + url.QueryEscape(file.ObjectKey)
		file.Origins = []storageSelfServiceReference{}
		files = append(files, file)
		keys = append(keys, file.ObjectKey)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, 0, err
	}
	if len(keys) == 0 {
		return files, total, nil
	}
	// Context labels only need private ACLs for this page, not every private
	// attachment in the account. The keys and permissions remain statement-bound.
	pagePrivate := false
	if privateSources {
		if err = q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM storage_inventory_references WHERE account_id=$1 AND object_key=ANY($2::text[]) AND source_kind IN ('task_attachments','whiteboard_assets','whiteboard_revision_assets'))`, accountID, keys).Scan(&pagePrivate); err != nil {
			return nil, 0, err
		}
	}
	refArgs := append(storageInventoryArguments(accountID, actorID, claims), keys)
	// Keep all positional parameters typed even though this projection needs
	// only the actor and module permissions from the shared CTE.
	// One object may have millions of references. Keep its exact authorized
	// count in SQL, but return at most six distinct presentation contexts per
	// requested key. A page cannot materialize every message using one file.
	rows, err = q.Query(ctx, storageInventoryKeysCTE(claims, pagePrivate)+` SELECT requested.object_key,summary.origin,summary.ref_id,summary.label,summary.href,summary.filename
	 FROM (SELECT DISTINCT unnest($7::text[]) AS object_key) requested
	 CROSS JOIN LATERAL (SELECT vr.origin,min(vr.ref_id) AS ref_id,vr.label,vr.href,max(vr.filename) AS filename
	 FROM authorized_refs vr WHERE vr.object_key=requested.object_key
	 GROUP BY vr.origin,vr.label,vr.href ORDER BY vr.origin,vr.label,vr.href LIMIT 6) summary
	 ORDER BY requested.object_key,summary.origin,summary.label,summary.href`, refArgs...)
	if err != nil {
		return nil, 0, err
	}
	refs := map[string][]storageSelfServiceReference{}
	for rows.Next() {
		var key string
		var ref storageSelfServiceReference
		if err = rows.Scan(&key, &ref.Origin, &ref.ID, &ref.Label, &ref.Href, &ref.Filename); err != nil {
			rows.Close()
			return nil, 0, err
		}
		if ref.Origin == "quick_replies" && !storageSelfServiceHasPermission(claims, domain.PermQuickRepliesManage) {
			ref.Href = "/dashboard/chats"
		}
		refs[key] = append(refs[key], ref)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, 0, err
	}
	for i := range files {
		f := &files[i]
		f.refs = refs[f.ObjectKey]
		f.HasMoreUses = f.ReferencesCount > len(f.refs)
		seen := map[string]bool{}
		for _, ref := range f.refs {
			k := ref.Origin + "|" + ref.Href + "|" + ref.Label
			if !seen[k] {
				seen[k] = true
				f.Origins = append(f.Origins, ref)
			}
		}
		if !f.CanRemove {
			f.BlockedReason = "Gestiona los usos del archivo para retirarlo de forma segura."
		}
		if f.Status == "trash" && !f.CanPurge {
			f.BlockedReason = "El archivo se conserva mientras haya usos activos o recuperación pendiente."
		}
	}
	if err = s.decorateStorageSelfServiceIndexedFiles(ctx, q, accountID, actorID, claims, files); err != nil {
		return nil, 0, err
	}
	return files, total, nil
}

func (s *Server) storageInventoryUsage(ctx context.Context, accountID, actorID uuid.UUID, claims *service.JWTClaims) (fiber.Map, error) {
	privateSources, err := s.storageInventoryHasPrivateSources(ctx, accountID, claims)
	if err != nil {
		return nil, err
	}
	q, err := s.storageInventoryReader(ctx)
	if err != nil {
		return nil, err
	}
	defer q.Rollback(context.Background())
	args := storageInventoryArguments(accountID, actorID, claims)
	var visible, count, removable, removableCount, trash int64
	var byType, byOrigin, recommendations []byte
	err = q.QueryRow(ctx, storageInventoryUsageSQL(claims, privateSources), args...).Scan(&visible, &count, &removable, &removableCount, &trash, &byType, &byOrigin, &recommendations)
	if err != nil {
		return nil, err
	}
	types := map[string]int64{"image": 0, "video": 0, "audio": 0, "document": 0}
	origins := map[string]int64{}
	if err = json.Unmarshal(byType, &types); err != nil {
		return nil, err
	}
	if err = json.Unmarshal(byOrigin, &origins); err != nil {
		return nil, err
	}
	for internal, public := range map[string]string{"private_work": "tasks", "private_whiteboards": "whiteboards", "uploads": "own_uploads"} {
		if value, ok := origins[internal]; ok {
			origins[public] += value
			delete(origins, internal)
		}
	}
	used := visible
	scope := "authorized"
	var limit, reserved int64
	if domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin) {
		scope = "account"
		if err = q.QueryRow(ctx, `SELECT COALESCE(t.size_bytes,0),a.storage_limit_bytes FROM accounts a LEFT JOIN storage_inventory_totals t ON t.account_id=a.id WHERE a.id=$1`, accountID).Scan(&used, &limit); err != nil {
			return nil, err
		}
		reserved = used - visible
		if reserved < 0 {
			reserved = 0
		}
	}
	available := int64(0)
	percent := float64(0)
	if limit > 0 {
		available = limit - used
		if available < 0 {
			available = 0
		}
		percent = 100 * float64(used) / float64(limit)
		if percent > 100 {
			percent = 100
		}
	}
	var recs []any
	if err = json.Unmarshal(recommendations, &recs); err != nil {
		return nil, err
	}
	return fiber.Map{"success": true, "account_id": accountID, "scope": scope, "used_bytes": used, "visible_bytes": visible, "managed_elsewhere_bytes": reserved, "object_count": count, "limit_bytes": limit, "available_bytes": available, "percent_used": percent, "by_type": types, "by_origin": origins, "removable_bytes": removable, "removable_count": removableCount, "trash_bytes": trash, "can_manage": storageSelfServiceHasPermission(claims, domain.PermSettings), "retention_days": storageSelfServiceRetentionDays, "recommendations": recs}, nil
}

// Aggregate the physical, actor-visible relation once for the complete summary.
// In particular, recommendations must not rebuild the entire ACL and object
// relation in a second statement. Origin selection is the same lexical first
// origin as before; grouping it once avoids one ordered lookup per object.
func storageInventoryUsageSQL(claims *service.JWTClaims, includePrivateSources ...bool) string {
	return storageInventoryCTE(claims, includePrivateSources...) + storageInventoryPhysicalFilesSQL + `,
 unique_files AS MATERIALIZED (
 SELECT DISTINCT ON(object_key) * FROM physical_files
 ORDER BY object_key,CASE WHEN status='active' THEN 0 ELSE 1 END,recovery_id
 ), type_totals AS (
 SELECT media_type,sum(size_bytes) bytes FROM unique_files GROUP BY media_type
 ), origin_inputs AS (
 SELECT object_key,origin,NULL::text AS fallback_origin,NULL::bigint AS size_bytes FROM authorized_refs
 UNION ALL SELECT object_key,NULL::text,CASE WHEN status='trash' THEN 'trash' ELSE 'uploads' END,size_bytes FROM unique_files
 ), object_origins AS (
 SELECT object_key,COALESCE(min(origin),max(fallback_origin)) AS origin,max(size_bytes) AS size_bytes
 FROM origin_inputs GROUP BY object_key HAVING count(size_bytes)>0
 ), origin_totals AS (
 SELECT origin,sum(size_bytes) bytes FROM object_origins GROUP BY origin
 )
 SELECT COALESCE(sum(size_bytes),0),count(*),COALESCE(sum(size_bytes) FILTER(WHERE can_remove),0),count(*) FILTER(WHERE can_remove),COALESCE(sum(size_bytes) FILTER(WHERE status='trash'),0),
 COALESCE((SELECT jsonb_object_agg(media_type,bytes) FROM type_totals),'{}'::jsonb),
 COALESCE((SELECT jsonb_object_agg(origin,bytes) FROM origin_totals),'{}'::jsonb),
 jsonb_build_array(
 jsonb_build_object('id','large_files','count',count(*) FILTER(WHERE status='active' AND size_bytes>=10485760),'bytes',COALESCE(sum(size_bytes) FILTER(WHERE status='active' AND size_bytes>=10485760),0),'filters',jsonb_build_object('min_size',10485760)),
 jsonb_build_object('id','older_files','count',count(*) FILTER(WHERE status='active' AND last_modified<NOW()-INTERVAL '180 days'),'bytes',COALESCE(sum(size_bytes) FILTER(WHERE status='active' AND last_modified<NOW()-INTERVAL '180 days'),0),'filters',jsonb_build_object('older_than_days',180)),
 jsonb_build_object('id','trash_ready','count',count(*) FILTER(WHERE status='trash' AND can_purge),'bytes',COALESCE(sum(size_bytes) FILTER(WHERE status='trash' AND can_purge),0),'filters',jsonb_build_object('status','trash_ready')),
 jsonb_build_object('id','unused_uploads','count',count(*) FILTER(WHERE status='active' AND unused_upload),'bytes',COALESCE(sum(size_bytes) FILTER(WHERE status='active' AND unused_upload),0),'filters',jsonb_build_object('status','unused_uploads'))
 ) FROM unique_files`
}

// A recovery retains its historical size for review, but summary accounting
// must use observed physical bytes. Multiple recovery records share one object;
// callers deduplicate this relation after preferring its active representation.
const storageInventoryPhysicalFilesSQL = `, physical_files AS NOT MATERIALIZED (
 SELECT f.object_key,f.media_type,io.size_bytes,f.status,f.can_remove,f.can_purge,f.last_modified,f.unused_upload,f.recovery_id
 FROM file_rows f JOIN storage_inventory_objects io ON io.account_id=$1 AND io.object_key=f.object_key
 AND io.bucket_kind=CASE WHEN split_part(f.object_key,'/',2)='_private' THEN 'private' ELSE 'ordinary' END
 WHERE io.presence='present'
)`

func storageInventoryAddFreshness(response fiber.Map, f storageInventoryFreshness) {
	response["catalog_status"] = f.Status
	response["last_verified_at"] = f.LastVerified
	response["inventory_complete"] = f.Complete
	response["generated_at"] = time.Now().UTC()
}

func (s *Server) storageInventoryRequestActor(c *fiber.Ctx, ctx context.Context) (uuid.UUID, uuid.UUID, *service.JWTClaims, error) {
	if s.storage == nil {
		return uuid.Nil, uuid.Nil, nil, fmt.Errorf("storage unavailable")
	}
	return s.storageSelfServiceActor(c, ctx)
}
