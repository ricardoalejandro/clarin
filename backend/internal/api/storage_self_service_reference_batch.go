package api

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/storage"
)

// This snapshot lives only inside one read-only review/revalidation phase. It
// never survives a request, crosses an account or is reused after a mutation.
// Confirmation takes a new snapshot under the account reference barrier; detach
// and the final physical-reference check continue to read their transaction live.
type storageSelectedReferenceSnapshot struct {
	account uuid.UUID
	querier storageSelfServiceQuerier
	stores  []*storage.Storage
	refs    map[string][]storageSelfServiceReference
}
type storageSelectedReferenceSnapshotKey struct{}

func storageSelectedReferences(ctx context.Context, q storageSelfServiceQuerier, account uuid.UUID, key string, stores ...*storage.Storage) ([]storageSelfServiceReference, bool) {
	if ctx.Err() != nil {
		return nil, false
	}
	snapshot, ok := ctx.Value(storageSelectedReferenceSnapshotKey{}).(*storageSelectedReferenceSnapshot)
	if !ok || snapshot.account != account || reflect.TypeOf(q) == nil || !reflect.TypeOf(q).Comparable() || snapshot.querier != q || len(stores) != len(snapshot.stores) {
		return nil, false
	}
	for i := range stores {
		if stores[i] != snapshot.stores[i] {
			return nil, false
		}
	}
	refs, ok := snapshot.refs[key]
	return refs, ok
}

// Source payloads are serialized by PostgreSQL. Build their escaped key with
// the same serializer: Go's JSON HTML and Unicode escaping differs and could
// silently hide a legitimate legacy reference containing quotes and '&'. The
// structured parser below remains the exact reference/authorization proof.
const storageReferenceSelectedKeysSQL = `WITH selected_keys AS MATERIALIZED (
 SELECT object_key,substring(to_jsonb(object_key)::text FROM 2 FOR length(to_jsonb(object_key)::text)-2) AS encoded_key
 FROM unnest($2::text[]) AS keys(object_key)
) `

// Only URL-bearing scalar values need percent decoding. A percent sign in a
// document's text/style must not decode its entire serialized design per key.
// The Go structural parser remains the authority after this coarse filter.
const storageReferenceSelectedKeyPredicateSQL = `EXISTS(SELECT 1 FROM selected_keys selected
 WHERE strpos(r.payload,selected.object_key)>0 OR strpos(r.payload,selected.encoded_key)>0
 OR (strpos(r.payload,'%')>0 AND EXISTS(
  SELECT 1 FROM jsonb_path_query(r.payload::jsonb, '$.** ? (@.type() == "string")') scalar(value)
  WHERE strpos(scalar.value #>> '{}','%')>0
  AND ((scalar.value #>> '{}') ~ '^(https?://|/)'
    OR strpos(scalar.value #>> '{}','/api/media/file/')>0
    OR strpos(scalar.value #>> '{}','/clarin-media/')>0)
  AND strpos(clarin_storage_path_unescape(scalar.value #>> '{}'),selected.object_key)>0)))`

func storageSelfServiceReferencesForKeys(ctx context.Context, q storageSelfServiceQuerier, account uuid.UUID, keys []string, stores ...*storage.Storage) (map[string][]storageSelfServiceReference, error) {
	if len(keys) == 0 || len(keys) > 100 {
		return nil, errStorageUseProtected
	}
	refs := make(map[string][]storageSelfServiceReference, len(keys))
	for _, key := range keys {
		if !storageSelfServiceValidKey(account, key) {
			return nil, errStorageUseProtected
		}
		refs[key] = []storageSelfServiceReference{}
	}
	queries := make([]string, 0, len(storageSelfServiceReferenceQueries))
	for _, source := range storageSelfServiceReferenceQueries {
		queries = append(queries, `SELECT '`+source.origin+`',r.id,r.label,r.href,r.filename,r.payload FROM (`+source.sql+`) AS r(id,label,href,filename,payload) WHERE `+storageReferenceSelectedKeyPredicateSQL)
	}
	rows, err := q.Query(ctx, storageReferenceSelectedKeysSQL+strings.Join(queries, " UNION ALL "), account, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var ref storageSelfServiceReference
		var payload string
		if err = rows.Scan(&ref.Origin, &ref.ID, &ref.Label, &ref.Href, &ref.Filename, &payload); err != nil {
			return nil, err
		}
		for key, readable := range storageSelfServiceReferenceValues(account, payload, stores...) {
			if _, wanted := refs[key]; !wanted {
				continue
			}
			item := ref
			if !readable {
				item.Origin, item.Label, item.Href, item.Filename = "private_external", "", "", ""
			}
			identity := key + "|" + item.Origin + "|" + item.ID
			if !seen[identity] {
				seen[identity] = true
				refs[key] = append(refs[key], item)
			}
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	for key := range refs {
		sort.Slice(refs[key], func(i, j int) bool {
			return refs[key][i].Origin+"|"+refs[key][i].ID < refs[key][j].Origin+"|"+refs[key][j].ID
		})
	}
	return refs, nil
}

func (s *Server) storageReviewReferenceContext(ctx context.Context, q storageSelfServiceQuerier, actor storageUseActor, selection storageUseSelection) (context.Context, error) {
	keys := []string{}
	if selection.Action == "trash" {
		if len(selection.Targets) < 1 || len(selection.Targets) > 100 || len(selection.RecoveryIDs) > 0 {
			return ctx, errStorageUseProtected
		}
		seen := map[string]bool{}
		for _, target := range selection.Targets {
			if !storageSelfServiceValidKey(actor.AccountID, target.ObjectKey) || seen[target.ObjectKey] || (target.Mode != "file" && target.Mode != "uses") {
				return ctx, errStorageUseProtected
			}
			seen[target.ObjectKey] = true
			keys = append(keys, target.ObjectKey)
		}
	} else {
		// Keep recovery access checks and ordering in the existing review builder.
		return ctx, nil
	}
	refs, err := storageSelfServiceReferencesForKeys(ctx, q, actor.AccountID, keys, s.storage)
	if err != nil {
		return ctx, err
	}
	return context.WithValue(ctx, storageSelectedReferenceSnapshotKey{}, &storageSelectedReferenceSnapshot{account: actor.AccountID, querier: q, stores: []*storage.Storage{s.storage}, refs: refs}), nil
}

// Physical absence is a blocked review item, not proof that its business
// references may be deleted. No bytes or removals are attributed to that item.
func storageMissingUseReviewItem(key string, uses []storageSelfServiceUse, refs []storageSelfServiceReference) storageUseReviewItem {
	filename := "Archivo"
	fingerprints := []string{}
	for _, use := range uses {
		if filename == "Archivo" && use.Filename != "" {
			filename = use.Filename
		}
		fingerprints = append(fingerprints, use.UseID+"|"+use.Fingerprint)
	}
	sort.Strings(fingerprints)
	typ := storageSelfServiceMediaType(filename, "")
	if typ == "" {
		typ = storageSelfServiceMediaType(key, "")
	}
	return storageUseReviewItem{ObjectKey: key, Filename: filename, MediaType: typ, Eligible: false,
		Reason:          "El archivo ya no está en el almacenamiento. Sus ubicaciones se conservarán.",
		ReferencesCount: len(uses), Fingerprint: storageUseFingerprint([]any{"missing", key, refs, fingerprints})}
}

func storageMissingRecoveryReviewItem(recovery storageUseRecovery, refs []storageSelfServiceReference, action string) storageUseReviewItem {
	return storageUseReviewItem{ObjectKey: recovery.ObjectKey, RecoveryID: recovery.ID.String(),
		RecoveryOrder: recovery.RemovalOrder, Filename: recovery.Filename, MediaType: recovery.MediaType,
		Eligible: false, Reason: "El archivo ya no está en el almacenamiento. Su recuperación se conservará para revisión.",
		ReferencesCount: len(refs), Fingerprint: storageUseFingerprint([]any{"missing-recovery", recovery, refs, action})}
}

func storageUseSelectionConflict(err error) bool {
	return errors.Is(err, errStorageUseProtected) || errors.Is(err, errStorageUseChanged) || errors.Is(err, errStorageUseRestoreConflict) || errors.Is(err, pgx.ErrNoRows)
}
