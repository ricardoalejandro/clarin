package api

import (
	"context"
	"encoding/base64"
	"sort"
	"strconv"
	"strings"
	"time"

	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

func storageUseAdapters() []storageUseAdapter {
	return append([]storageUseAdapter{storageOrdinaryUseAdapter{}}, storageAdditionalUseAdapters...)
}
func storageUseAdapterNamed(name string) storageUseAdapter {
	for _, a := range storageUseAdapters() {
		if a.Name() == name {
			return a
		}
	}
	return nil
}

func (s *Server) storageSelfServiceListUses(ctx context.Context, q storageSelfServiceQuerier, actor storageUseActor, key string) ([]storageSelfServiceUse, error) {
	if !storageSelfServiceValidKey(actor.AccountID, key) {
		return nil, errStorageUseProtected
	}
	result := []storageSelfServiceUse{}
	covered := map[string]bool{}
	for _, a := range storageUseAdapters() {
		uses, err := a.List(ctx, s, q, actor, key)
		if err != nil {
			return nil, err
		}
		for _, u := range uses {
			if !storageSelfServiceHasPermission(actor.Claims, domain.PermSettings) {
				u.CanRemove = false
				u.BlockedReason = "Necesitas permiso para gestionar el almacenamiento."
			}
			if u.AccountID != actor.AccountID || u.ObjectKey != key {
				return nil, errStorageUseProtected
			}
			for _, id := range u.ReferenceIDs {
				covered[id] = true
			}
			covered[u.Type+"|"+u.SourceID.String()] = true
			result = append(result, u)
		}
	}
	refs, err := storageSelfServiceObjectReferences(ctx, q, actor.AccountID, key, s.storage)
	if err != nil {
		return nil, err
	}
	for _, ref := range refs {
		if storage.IsProtectedMediaObjectKey(key) && !(ref.Origin == "contacts" && storage.IsAccountPrivateAvatarObjectKey(actor.AccountID, key)) {
			continue
		}
		if covered[ref.Origin+"|"+ref.ID] {
			continue
		}
		permission := storageSelfServiceOriginPermission(ref.Origin)
		if permission == "" || !storageSelfServiceHasPermission(actor.Claims, permission) {
			continue
		}
		id, err := uuid.Parse(ref.ID)
		if err != nil {
			continue
		}
		result = append(result, storageSelfServiceUse{UseID: storageUseID(actor.AccountID, "protected", id, ref.Origin, key), Type: ref.Origin, Label: ref.Label, Href: ref.Href, BlockedReason: "Este uso se conserva para proteger su contenido publicado o su historial.", Adapter: "protected", AccountID: actor.AccountID, ObjectKey: key, SourceID: id, Slot: ref.Origin, ReferenceIDs: []string{ref.Origin + "|" + ref.ID}})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UseID < result[j].UseID })
	return result, nil
}

func (s *Server) handleStorageSelfServiceUses(c *fiber.Ctx) error {
	ctx, cancel := context.WithTimeout(c.Context(), storageSelfServiceCatalogTimeout)
	defer cancel()
	account, actor, claims, err := s.storageSelfServiceActor(c, ctx)
	if err != nil {
		return storageSelfServiceError(c, 403, "storage_forbidden", "No tienes acceso al almacenamiento.")
	}
	key := strings.TrimSpace(c.Query("object_key"))
	if !storageSelfServiceValidKey(account, key) {
		return storageSelfServiceError(c, 404, "storage_not_found", "El archivo no está disponible.")
	}
	uses, err := s.storageSelfServiceListUses(ctx, s.repos.DB(), storageUseActor{account, actor, claims}, key)
	if err != nil {
		return storageSelfServiceError(c, 503, "storage_scan_failed", "No se pudieron verificar los usos.")
	}
	if len(uses) == 0 {
		recoveries, e := s.storageSelfServiceRecoveryFiles(ctx, s.repos.DB(), storageUseActor{account, actor, claims}, []string{key})
		if e != nil {
			return storageSelfServiceError(c, 503, "storage_scan_failed", "No se pudieron verificar los usos.")
		}
		readable := false
		for _, recovery := range recoveries {
			if recovery.PreviewURL != "" {
				readable = true
				break
			}
		}
		if !readable && !storage.IsProtectedMediaObjectKey(key) && storageSelfServiceHasPermission(claims, domain.PermChats) {
			if e = s.repos.DB().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state='trash' AND jsonb_array_length(message_backups)>0 AND (actor_id=$3 OR $4::boolean))`, account, key, actor, domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin)).Scan(&readable); e != nil {
				return storageSelfServiceError(c, 503, "storage_scan_failed", "No se pudieron verificar los usos.")
			}
		}
		if !readable {
			return storageSelfServiceError(c, 404, "storage_not_found", "El archivo no está disponible.")
		}
	}
	limit, _ := strconv.Atoi(c.Query("limit", "40"))
	if limit < 1 || limit > 100 {
		limit = 40
	}
	after := ""
	if encoded := c.Query("cursor"); encoded != "" {
		decoded, e := base64.RawURLEncoding.DecodeString(encoded)
		if e != nil {
			return storageSelfServiceError(c, 400, "invalid_cursor", "Vuelve a cargar los usos.")
		}
		var cursor struct {
			AccountID, ActorID uuid.UUID
			Key, After         string
		}
		if json.Unmarshal(decoded, &cursor) != nil || cursor.AccountID != account || cursor.ActorID != actor || cursor.Key != key {
			return storageSelfServiceError(c, 400, "invalid_cursor", "Vuelve a cargar los usos.")
		}
		after = cursor.After
	}
	start := sort.Search(len(uses), func(i int) bool { return uses[i].UseID > after })
	end := start + limit
	if end > len(uses) {
		end = len(uses)
	}
	next := ""
	if end < len(uses) {
		raw, _ := json.Marshal(struct {
			AccountID, ActorID uuid.UUID
			Key, After         string
		}{account, actor, key, uses[end-1].UseID})
		next = base64.RawURLEncoding.EncodeToString(raw)
	}
	return c.JSON(fiber.Map{"success": true, "uses": uses[start:end], "total": len(uses), "limit": limit, "has_more": end < len(uses), "next_cursor": next, "can_manage": storageSelfServiceHasPermission(claims, domain.PermSettings)})
}

func (s *Server) storageUseAuthorizeRecovery(ctx context.Context, q storageSelfServiceQuerier, actor storageUseActor, snapshot storageUseSnapshot, owner uuid.UUID, action string) error {
	if (action == "restore" || action == "purge") && !storageSelfServiceHasPermission(actor.Claims, domain.PermSettings) {
		return errStorageUseProtected
	}
	if snapshot.AccountID != actor.AccountID || (owner != actor.UserID && !domain.HasAccountAdminAuthority(actor.Claims.Role, actor.Claims.IsSuperAdmin)) {
		return errStorageUseProtected
	}
	adapter := storageUseAdapterNamed(snapshot.Adapter)
	if adapter == nil {
		return errStorageUseProtected
	}
	if access, ok := adapter.(storageUseRecoveryAccess); ok {
		return access.AuthorizeRecovery(ctx, s, q, actor, snapshot, action)
	}
	permission := storageSelfServiceOriginPermission(snapshot.Type)
	if permission != "" && storageSelfServiceHasPermission(actor.Claims, permission) {
		return nil
	}
	if snapshot.Adapter == "own_upload" && storageSelfServiceHasPermission(actor.Claims, domain.PermSettings) {
		return nil
	}
	return errStorageUseProtected
}

func (s *Server) storageUseAfterCommit(ctx context.Context, actor storageUseActor, snapshots []storageUseSnapshot, action string) {
	byAdapter := map[string][]storageUseSnapshot{}
	for _, snap := range snapshots {
		byAdapter[snap.Adapter] = append(byAdapter[snap.Adapter], snap)
	}
	for name, values := range byAdapter {
		if hook, ok := storageUseAdapterNamed(name).(storageUseAfterCommit); ok {
			hook.AfterCommit(ctx, s, actor, values, action)
		}
	}
	s.invalidateMessagesCache(actor.AccountID, nil)
	s.storageSelfServicePublishChanged(actor.AccountID, "changed")
}

func storageUseNow() time.Time { return time.Now().UTC() }
