package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

type storageReadUseSelection struct{ IDs map[string][]uuid.UUID }
type storageReadUseSelectionKey struct{}

// Candidate mode only builds ordinary identities/coverage; business payloads
// are loaded after the canonical fallback has chosen its bounded page.
type storageReadUseCandidatesOnlyKey struct{}

func storageReadSelectedIDs(ctx context.Context, adapter string) ([]uuid.UUID, bool) {
	selected, ok := ctx.Value(storageReadUseSelectionKey{}).(storageReadUseSelection)
	if !ok {
		return nil, false
	}
	return selected.IDs[adapter], true
}

type storageUseCursor struct {
	Version            int
	AccountID, ActorID uuid.UUID
	Key, After         string
}

func storageDecodeUseCursor(encoded string, actor storageUseActor, key string) (string, error) {
	if encoded == "" {
		return "", nil
	}
	if len(encoded) > 4096 {
		return "", fmt.Errorf("invalid cursor")
	}
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(data) > 2048 {
		return "", fmt.Errorf("invalid cursor")
	}
	var cursor storageUseCursor
	if json.Unmarshal(data, &cursor) != nil || cursor.Version != 2 || cursor.AccountID != actor.AccountID || cursor.ActorID != actor.UserID || cursor.Key != key {
		return "", fmt.Errorf("invalid cursor")
	}
	return cursor.After, nil
}
func storageEncodeUseCursor(actor storageUseActor, key, after string) string {
	data, _ := json.Marshal(storageUseCursor{2, actor.AccountID, actor.UserID, key, after})
	return base64.RawURLEncoding.EncodeToString(data)
}
func storageUseOrder(use storageSelfServiceUse) string {
	return use.Adapter + "/" + use.SourceID.String() + "/" + use.Slot
}

type storageUseCandidate struct {
	Adapter, Slot string
	SourceID      uuid.UUID
	Ref           storageSelfServiceReference
}

func (c storageUseCandidate) order() string {
	return c.Adapter + "/" + c.SourceID.String() + "/" + c.Slot
}

// Map physical references to real business uses before applying the page.
// Mirrors (campaign/reply attachments) collapse into their owning editable row.
// The live authorization and generation predicate is applied before counting.
const storageUseCandidatesSQL = `, mapped_uses AS (
 SELECT
 CASE WHEN vr.source_kind IN ('messages','campaigns','campaign_attachments','quick_replies','quick_reply_attachments','saved_stickers','contacts') THEN 'ordinary'
 WHEN vr.source_kind='task_attachments' THEN 'private_work'
 WHEN vr.source_kind IN ('whiteboard_assets','whiteboard_revision_assets') THEN 'private_whiteboards'
 ELSE 'protected' END AS adapter,
 CASE WHEN vr.source_kind='campaign_attachments' THEN ca.campaign_id::text
 WHEN vr.source_kind='quick_reply_attachments' THEN qa.quick_reply_id::text ELSE vr.source_id END AS source_id,
 CASE WHEN vr.source_kind IN ('task_attachments','whiteboard_assets','whiteboard_revision_assets') THEN vr.source_kind ELSE vr.origin END AS slot,
 vr.origin,vr.label,vr.href,vr.filename
 FROM authorized_refs vr
 LEFT JOIN campaign_attachments ca ON vr.source_kind='campaign_attachments' AND ca.id::text=vr.source_id
 LEFT JOIN quick_reply_attachments qa ON vr.source_kind='quick_reply_attachments' AND qa.account_id=$1 AND qa.id::text=vr.source_id
 WHERE vr.object_key=$7::text
), use_candidates AS (
 SELECT adapter,source_id,slot,min(origin) AS origin,min(label) AS label,min(href) AS href,max(filename) AS filename
 FROM mapped_uses WHERE source_id IS NOT NULL GROUP BY adapter,source_id,slot
 UNION ALL
 SELECT 'own_upload',own.id::text,'upload','private_upload_claims','Carga propia sin adjuntar','',own.filename
 FROM storage_upload_ownership own WHERE own.account_id=$1 AND own.object_key=$7::text AND own.actor_id=$2 AND own.provenance_verified AND own.state='active'
 AND split_part(own.object_key,'/',2) NOT IN ('_private','statuses','task-previews')
 AND NOT(split_part(own.object_key,'/',2)='tasks' AND split_part(own.object_key,'/',3)='attachments')
 AND strpos(own.object_key,'/whiteboards/')=0
 AND NOT EXISTS(SELECT 1 FROM storage_inventory_references business WHERE business.account_id=$1 AND business.object_key=own.object_key AND business.origin<>'private_upload_claims')
)`

func (s *Server) storageReadUsesPage(ctx context.Context, actor storageUseActor, key, after string, limit int) ([]storageSelfServiceUse, int, string, error) {
	freshness, err := s.storageInventoryFreshness(ctx, actor.AccountID)
	if err != nil {
		return nil, 0, "", err
	}
	if !freshness.Complete {
		release, acquired := storageFallbackReaders.acquire(ctx, actor.AccountID)
		if !acquired {
			return nil, 0, "", errStorageIndexingBudget
		}
		defer release()
		ctx = context.WithValue(ctx, storageReferenceReadBudgetKey{}, &storageReferenceReadBudget{})
		// Initial indexing and dirty sources keep immediate canonical behavior. One
		// request-local reference snapshot avoids re-scanning for every adapter.
		// Ordinary uses only contribute identities until the page is selected;
		// a shared file never hydrates every message/campaign during indexing.
		refs, err := storageSelfServiceReferencesForKeys(ctx, s.repos.DB(), actor.AccountID, []string{key}, s.storage)
		if err != nil {
			return nil, 0, "", err
		}
		ctx = context.WithValue(ctx, storageSelectedReferenceSnapshotKey{}, &storageSelectedReferenceSnapshot{account: actor.AccountID, querier: s.repos.DB(), stores: []*storage.Storage{s.storage}, refs: refs})
		all, err := s.storageSelfServiceListUses(context.WithValue(ctx, storageReadUseCandidatesOnlyKey{}, true), s.repos.DB(), actor, key)
		if err != nil {
			return nil, 0, "", err
		}
		sort.Slice(all, func(i, j int) bool { return storageUseOrder(all[i]) < storageUseOrder(all[j]) })
		start := sort.Search(len(all), func(i int) bool { return storageUseOrder(all[i]) > after })
		end := min(start+limit, len(all))
		next := ""
		if end < len(all) {
			next = storageUseOrder(all[end-1])
		}
		page := all[start:end]
		selection := storageReadUseSelection{IDs: map[string][]uuid.UUID{}}
		for _, use := range page {
			if use.Adapter == "ordinary" {
				selection.IDs["ordinary"] = append(selection.IDs["ordinary"], use.SourceID)
			}
		}
		hydrated, err := (storageOrdinaryUseAdapter{}).List(context.WithValue(ctx, storageReadUseSelectionKey{}, selection), s, s.repos.DB(), actor, key)
		if err != nil {
			return nil, 0, "", err
		}
		byOrder := make(map[string]storageSelfServiceUse, len(hydrated))
		for _, use := range hydrated {
			if !storageSelfServiceHasPermission(actor.Claims, domain.PermSettings) {
				use.CanRemove = false
				use.BlockedReason = "Necesitas permiso para gestionar el almacenamiento."
			}
			byOrder[storageUseOrder(use)] = use
		}
		result := make([]storageSelfServiceUse, 0, len(page))
		for _, use := range page {
			if use.Adapter == "ordinary" {
				// A row deleted after candidate selection must not survive as an identity-only placeholder.
				current, exists := byOrder[storageUseOrder(use)]
				if !exists {
					continue
				}
				use = current
			}
			result = append(result, use)
		}
		return result, len(all), next, nil
	}
	private, err := s.storageObjectHasPrivateReferences(ctx, actor.AccountID, key)
	if err != nil {
		return nil, 0, "", err
	}
	base := storageInventoryObjectCTE(actor.Claims, private) + storageUseCandidatesSQL
	args := append(storageInventoryArguments(actor.AccountID, actor.UserID, actor.Claims), key)
	var total int
	if err = s.repos.DB().QueryRow(ctx, base+` SELECT count(*) FROM use_candidates`, args...).Scan(&total); err != nil {
		return nil, 0, "", err
	}
	pageArgs := append(args, after, limit+1)
	rows, err := s.repos.DB().Query(ctx, base+` SELECT adapter,source_id,slot,origin,label,href,filename FROM use_candidates
 WHERE adapter||'/'||source_id||'/'||slot > $8::text
 ORDER BY adapter,source_id,slot LIMIT $9::int`, pageArgs...)
	if err != nil {
		return nil, 0, "", err
	}
	candidates := make([]storageUseCandidate, 0, limit+1)
	for rows.Next() {
		var candidate storageUseCandidate
		if err = rows.Scan(&candidate.Adapter, &candidate.SourceID, &candidate.Slot, &candidate.Ref.Origin, &candidate.Ref.Label, &candidate.Ref.Href, &candidate.Ref.Filename); err != nil {
			rows.Close()
			return nil, 0, "", err
		}
		candidate.Ref.ID = candidate.SourceID.String()
		candidates = append(candidates, candidate)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, 0, "", err
	}
	next := ""
	if len(candidates) > limit {
		candidates = candidates[:limit]
		next = candidates[len(candidates)-1].order()
	}
	selection := storageReadUseSelection{IDs: map[string][]uuid.UUID{}}
	refs := make([]storageSelfServiceReference, 0, len(candidates))
	for _, candidate := range candidates {
		selection.IDs[candidate.Adapter] = append(selection.IDs[candidate.Adapter], candidate.SourceID)
		refs = append(refs, candidate.Ref)
	}
	if len(candidates) == 0 {
		return []storageSelfServiceUse{}, total, next, nil
	}
	ctx = context.WithValue(ctx, storageReadUseSelectionKey{}, selection)
	ctx = context.WithValue(ctx, storageSelectedReferenceSnapshotKey{}, &storageSelectedReferenceSnapshot{account: actor.AccountID, querier: s.repos.DB(), stores: []*storage.Storage{s.storage}, refs: map[string][]storageSelfServiceReference{key: refs}})
	uses, err := s.storageSelfServiceListUses(ctx, s.repos.DB(), actor, key)
	if err != nil {
		return nil, 0, "", err
	}
	// A private adapter always rechecks its resource ACL. Concurrent revocation
	// can remove a candidate after SQL selection; it must not refill from hidden
	// sources or accidentally add another unselected use.
	allowed := map[string]bool{}
	for _, candidate := range candidates {
		allowed[candidate.order()] = true
	}
	result := make([]storageSelfServiceUse, 0, len(uses))
	for _, use := range uses {
		if allowed[storageUseOrder(use)] {
			result = append(result, use)
		}
	}
	sort.Slice(result, func(i, j int) bool { return storageUseOrder(result[i]) < storageUseOrder(result[j]) })
	return result, total, next, nil
}
