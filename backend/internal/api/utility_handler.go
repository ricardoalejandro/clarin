package api

import (
	"context"
	"errors"
	"log"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/internal/utilities"
)

type utilityObjectStore struct{ *storage.Storage }

func (s utilityObjectStore) DeleteFile(ctx context.Context, key string) error {
	return s.DeleteUtilityObject(ctx, key)
}

// The utility GC holds the same exclusive account barrier as ordinary media
// cleanup. A retained asset/lease/recovery is a live reference even when no
// visible business row currently points to the object.
func utilityStorageReferences(ctx context.Context, q storageSelfServiceQuerier, account uuid.UUID, key string, store *storage.Storage) (bool, error) {
	var retained bool
	err := q.QueryRow(ctx, `SELECT
	 EXISTS(SELECT 1 FROM media_assets WHERE account_id=$1 AND object_key=$2 AND status='active')
	 OR EXISTS(SELECT 1 FROM storage_upload_ownership WHERE account_id=$1 AND object_key=$2 AND state='active')
	 OR EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state IN ('trash','purging'))
	 OR EXISTS(SELECT 1 FROM storage_removed_references WHERE account_id=$1 AND object_key=$2 AND state IN ('removed','purging'))`, account, key).Scan(&retained)
	if err != nil || retained {
		return retained, err
	}
	refs, err := storageSelfServiceObjectReferences(ctx, q, account, key, store)
	return len(refs) > 0, err
}

func (s *Server) registerUtilityRoutes(protected fiber.Router) {
	r := protected.Group("/utilities", s.requirePermission(domain.PermUtilities))
	r.Use(func(c *fiber.Ctx) error {
		c.Set("Cache-Control", "no-store")
		c.Set("X-Content-Type-Options", "nosniff")
		if s.utilities == nil {
			return utilityError(c, utilities.ErrVaultUnavailable)
		}
		return c.Next()
	})
	r.Get("/documents", s.handleUtilityList)
	r.Post("/documents", s.handleUtilityCreate)
	r.Get("/documents/:id", s.handleUtilityGet)
	r.Patch("/documents/:id", s.handleUtilityPatch)
	r.Delete("/documents/:id", s.handleUtilityDelete)
	r.Get("/documents/:id/content/:slot", s.handleUtilityRead)
	r.Put("/documents/:id/content/:slot", s.handleUtilityWrite)
	r.Patch("/documents/:id/changes", s.handleUtilityChanges)
	r.Get("/folders", s.handleUtilityFolders)
	r.Post("/folders", s.handleUtilitySaveFolder)
	r.Patch("/folders/:id", s.handleUtilitySaveFolder)
	r.Delete("/folders/:id", s.handleUtilityDeleteFolder)
	r.Get("/workspace", s.handleUtilityWorkspace)
	r.Put("/workspace", s.handleUtilitySaveWorkspace)
	r.Get("/vault/status", func(c *fiber.Ctx) error { return utilityData(c, fiber.Map{"configured": s.utilities.Cipher != nil}) })
	r.Get("/vault/legacy", s.handleUtilityLegacyVaultList)
	r.Get("/vault/legacy/:keyId", s.handleUtilityLegacyVaultGet)
	r.Post("/documents/:id/duplicate", s.handleUtilityDuplicate)
	r.Get("/documents/:id/vault", s.handleUtilityVaultList)
	r.Post("/documents/:id/vault", s.handleUtilityVaultCreate)
	r.Post("/documents/:id/vault/import-legacy", s.handleUtilityLegacyVaultImport)
	r.Get("/documents/:id/vault/:keyId", s.handleUtilityVaultGet)
	r.Patch("/documents/:id/vault/:keyId", s.handleUtilityVaultPatch)
	r.Delete("/documents/:id/vault/:keyId", s.handleUtilityVaultDelete)
	r.Get("/documents/:id/vault/:keyId/material", s.handleUtilityVaultMaterial)
	r.Put("/documents/:id/vault/:keyId/material", s.handleUtilityVaultMaterialWrite)
}
func utilityScope(c *fiber.Ctx) (account, owner uuid.UUID, err error) {
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	if !ok || claims == nil || claims.AccountID == uuid.Nil || claims.UserID == uuid.Nil {
		return account, owner, fiber.ErrUnauthorized
	}
	return claims.AccountID, claims.UserID, nil
}
func utilityID(c *fiber.Ctx) (uuid.UUID, error) {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil || id == uuid.Nil {
		return uuid.Nil, utilities.ErrInvalid
	}
	return id, nil
}
func utilityVersion(raw string) (int64, error) {
	value, err := strconv.ParseInt(strings.Trim(raw, `"`), 10, 64)
	if err != nil || value < 0 {
		return 0, utilities.ErrInvalid
	}
	return value, nil
}
func utilityData(c *fiber.Ctx, data any) error {
	return c.JSON(fiber.Map{"success": true, "data": data})
}
func utilityError(c *fiber.Ctx, err error) error {
	status, code, message := fiber.StatusServiceUnavailable, "utilities_unavailable", "No se pudo completar la operación. Inténtalo nuevamente."
	switch {
	case errors.Is(err, fiber.ErrUnauthorized):
		status, code, message = 401, "unauthorized", "Inicia sesión para continuar."
	case errors.Is(err, utilities.ErrMissing):
		status, code, message = 404, "utility_not_found", "El documento no está disponible."
	case errors.Is(err, utilities.ErrConflict):
		status, code, message = 409, "utility_conflict", "El documento cambió en otra sesión. Conserva tu borrador y vuelve a cargar o guarda una copia."
	case errors.Is(err, utilities.ErrInvalid):
		status, code, message = 400, "invalid_utility", "Revisa el contenido, la versión y los límites de esta operación."
	case errors.Is(err, utilities.ErrQuota):
		status, code, message = 413, "storage_quota_exceeded", "La cuenta no tiene espacio suficiente para guardar este archivo."
	case errors.Is(err, utilities.ErrVaultUnavailable):
		status, code, message = 503, "vault_unavailable", "El almacenamiento protegido no está configurado o no está disponible."
	default:
		log.Printf("[Utilities] operation failed (%T)", err)
	}
	return c.Status(status).JSON(fiber.Map{"success": false, "code": code, "error": message})
}
func (s *Server) utilityEvent(account, owner uuid.UUID, kind string, id uuid.UUID) {
	if s.hub != nil {
		s.hub.BroadcastToAccountUsersWithPermission(account, []uuid.UUID{owner}, domain.PermUtilities, "utility_updated", fiber.Map{"kind": kind, "id": id})
	}
}

func (s *Server) handleUtilityList(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	docs, next, err := s.utilities.Store.List(c.UserContext(), a, u, utilities.Query{Search: c.Query("q"), Type: c.Query("type"), Folder: c.Query("folder_id"), Favorite: c.Query("favorite") == "true", Cursor: c.Query("cursor"), Limit: c.QueryInt("limit", 50)})
	if err != nil {
		return utilityError(c, err)
	}
	return utilityData(c, fiber.Map{"documents": docs, "next_cursor": next, "has_more": next != ""})
}
func (s *Server) handleUtilityCreate(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	var in utilities.DocumentInput
	if len(c.Body()) > 128*1024 || c.BodyParser(&in) != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	d, err := s.utilities.Store.Create(c.UserContext(), a, u, in)
	if err != nil {
		return utilityError(c, err)
	}
	s.utilityEvent(a, u, "document", d.ID)
	return utilityData(c, fiber.Map{"document": d})
}
func (s *Server) handleUtilityGet(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	id, err := utilityID(c)
	if err != nil {
		return utilityError(c, err)
	}
	d, err := s.utilities.Store.Get(c.UserContext(), a, u, id)
	if err != nil {
		return utilityError(c, err)
	}
	return utilityData(c, fiber.Map{"document": d})
}
func (s *Server) handleUtilityPatch(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	id, err := utilityID(c)
	if err != nil {
		return utilityError(c, err)
	}
	var in utilities.DocumentPatch
	if len(c.Body()) > 128*1024 || c.BodyParser(&in) != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	d, err := s.utilities.Store.Patch(c.UserContext(), a, u, id, in)
	if err != nil {
		return utilityError(c, err)
	}
	s.utilityEvent(a, u, "document", id)
	return utilityData(c, fiber.Map{"document": d})
}
func (s *Server) handleUtilityDelete(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	id, err := utilityID(c)
	if err != nil {
		return utilityError(c, err)
	}
	version, err := utilityVersion(c.Query("version"))
	if err != nil {
		return utilityError(c, err)
	}
	if err = s.utilities.Store.Delete(c.UserContext(), a, u, id, version); err != nil {
		return utilityError(c, err)
	}
	s.utilityEvent(a, u, "deleted", id)
	return utilityDocumentDeleted(c, func() (domain.UtilityWorkspace, error) { return s.utilities.Store.Workspace(c.UserContext(), a, u) })
}

// Deletion has already committed. A failed preference read must never turn it
// into an apparent failed deletion. The canonical version lets the client
// close its tab without submitting the pre-delete workspace version.
func utilityDocumentDeleted(c *fiber.Ctx, workspace func() (domain.UtilityWorkspace, error)) error {
	var canonical *domain.UtilityWorkspace
	if current, err := workspace(); err == nil {
		canonical = &current
	}
	return utilityData(c, fiber.Map{"deleted": true, "cleanup_pending": true, "workspace": canonical})
}
func (s *Server) handleUtilityRead(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	id, err := utilityID(c)
	if err != nil {
		return utilityError(c, err)
	}
	data, content, err := s.utilities.ReadContent(c.UserContext(), a, u, id, c.Params("slot"))
	if err != nil {
		return utilityError(c, err)
	}
	c.Set("Content-Type", content.ContentType)
	c.Set("X-Content-Version", strconv.FormatInt(content.Version, 10))
	c.Set("Content-Disposition", `attachment; filename="document.bin"`)
	return c.Send(data)
}
func (s *Server) handleUtilityWrite(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	id, err := utilityID(c)
	if err != nil {
		return utilityError(c, err)
	}
	version, err := utilityVersion(c.Get("If-Match"))
	if err != nil {
		return utilityError(c, err)
	}
	op, err := uuid.Parse(c.Get("X-Operation-Id"))
	if err != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	result, err := s.utilities.WriteContent(c.UserContext(), a, u, id, c.Params("slot"), c.Get("Content-Type"), version, op, c.Body())
	if err != nil {
		return utilityError(c, err)
	}
	s.utilityEvent(a, u, "content", id)
	return utilityData(c, result)
}
func (s *Server) handleUtilityChanges(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	id, err := utilityID(c)
	if err != nil {
		return utilityError(c, err)
	}
	var in utilities.ChangeInput
	if len(c.Body()) > 9*1024*1024 || c.BodyParser(&in) != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	result, err := s.utilities.Changes(c.UserContext(), a, u, id, in)
	if err != nil {
		return utilityError(c, err)
	}
	s.utilityEvent(a, u, "content", id)
	return utilityData(c, result)
}
func (s *Server) handleUtilityFolders(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	folders, err := s.utilities.Store.Folders(c.UserContext(), a, u)
	if err != nil {
		return utilityError(c, err)
	}
	return utilityData(c, fiber.Map{"folders": folders})
}
func (s *Server) handleUtilitySaveFolder(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	var id uuid.UUID
	if c.Params("id") != "" {
		id, err = utilityID(c)
		if err != nil {
			return utilityError(c, err)
		}
	}
	var in struct {
		Name    string `json:"name"`
		Version int64  `json:"version"`
	}
	if len(c.Body()) > 4096 || c.BodyParser(&in) != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	folder, err := s.utilities.Store.SaveFolder(c.UserContext(), a, u, id, in.Name, in.Version)
	if err != nil {
		return utilityError(c, err)
	}
	s.utilityEvent(a, u, "folder", folder.ID)
	return utilityData(c, fiber.Map{"folder": folder})
}
func (s *Server) handleUtilityDeleteFolder(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	id, err := utilityID(c)
	if err != nil {
		return utilityError(c, err)
	}
	version, err := utilityVersion(c.Query("version"))
	if err != nil {
		return utilityError(c, err)
	}
	if err = s.utilities.Store.DeleteFolder(c.UserContext(), a, u, id, version); err != nil {
		return utilityError(c, err)
	}
	s.utilityEvent(a, u, "folder", id)
	return utilityData(c, fiber.Map{"deleted": true})
}
func (s *Server) handleUtilityWorkspace(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	w, err := s.utilities.Store.Workspace(c.UserContext(), a, u)
	if err != nil {
		return utilityError(c, err)
	}
	return utilityData(c, fiber.Map{"workspace": w})
}
func (s *Server) handleUtilitySaveWorkspace(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	var in struct {
		OpenIDs     []uuid.UUID `json:"open_ids"`
		ActiveID    *uuid.UUID  `json:"active_id"`
		BaseVersion int64       `json:"base_version"`
	}
	if len(c.Body()) > 16*1024 || c.BodyParser(&in) != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	if in.OpenIDs == nil {
		in.OpenIDs = []uuid.UUID{}
	}
	w, err := s.utilities.Store.SaveWorkspace(c.UserContext(), a, u, domain.UtilityWorkspace{OpenIDs: in.OpenIDs, ActiveID: in.ActiveID, Version: in.BaseVersion})
	if err != nil {
		return utilityError(c, err)
	}
	return utilityData(c, fiber.Map{"workspace": w})
}
func utilityVaultScope(c *fiber.Ctx) (a, u, d, k uuid.UUID, err error) {
	a, u, err = utilityScope(c)
	if err != nil {
		return
	}
	d, err = utilityID(c)
	if err != nil {
		return
	}
	if c.Params("keyId") != "" {
		k, err = uuid.Parse(c.Params("keyId"))
		if k == uuid.Nil {
			err = utilities.ErrInvalid
		}
	}
	return
}
func (s *Server) utilityVaultEvent(a, u, d uuid.UUID, kind string, id uuid.UUID) {
	if s.hub != nil {
		s.hub.BroadcastToAccountUsersWithPermission(a, []uuid.UUID{u}, domain.PermUtilities, "utility_updated", fiber.Map{"kind": kind, "id": id, "document_id": d})
	}
}
func (s *Server) handleUtilityVaultList(c *fiber.Ctx) error {
	a, u, d, _, err := utilityVaultScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	items, next, err := s.utilities.ListVault(c.UserContext(), a, u, d, c.Query("q"), c.Query("cursor"))
	if err != nil {
		return utilityError(c, err)
	}
	return utilityData(c, fiber.Map{"items": items, "next_cursor": next, "has_more": next != ""})
}
func (s *Server) handleUtilityLegacyVaultList(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	items, next, err := s.utilities.ListLegacyVault(c.UserContext(), a, u, c.Query("q"), c.Query("cursor"))
	if err != nil {
		return utilityError(c, err)
	}
	return utilityData(c, fiber.Map{"items": items, "next_cursor": next, "has_more": next != ""})
}
func (s *Server) handleUtilityLegacyVaultGet(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	key, err := uuid.Parse(c.Params("keyId"))
	if err != nil || key == uuid.Nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	item, err := s.utilities.GetLegacyVault(c.UserContext(), a, u, key)
	if err != nil {
		return utilityError(c, err)
	}
	return utilityData(c, fiber.Map{"item": item})
}
func (s *Server) handleUtilityLegacyVaultImport(c *fiber.Ctx) error {
	a, u, d, _, err := utilityVaultScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	var in utilities.LegacyVaultImport
	if len(c.Body()) > 4096 || c.BodyParser(&in) != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	item, err := s.utilities.ImportLegacyVault(c.UserContext(), a, u, d, in)
	if err != nil {
		return utilityError(c, err)
	}
	s.utilityVaultEvent(a, u, d, "vault", item.ID)
	return utilityData(c, fiber.Map{"item": item})
}
func (s *Server) handleUtilityVaultCreate(c *fiber.Ctx) error {
	a, u, d, _, err := utilityVaultScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	var in utilities.VaultInput
	if len(c.Body()) > 3*1024*1024 || c.BodyParser(&in) != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	item, err := s.utilities.CreateVault(c.UserContext(), a, u, d, in)
	if err != nil {
		return utilityError(c, err)
	}
	s.utilityVaultEvent(a, u, d, "vault", item.ID)
	return utilityData(c, fiber.Map{"item": item})
}
func (s *Server) handleUtilityVaultGet(c *fiber.Ctx) error {
	a, u, d, k, err := utilityVaultScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	item, err := s.utilities.GetVault(c.UserContext(), a, u, d, k)
	if err != nil {
		return utilityError(c, err)
	}
	return utilityData(c, fiber.Map{"item": item})
}
func (s *Server) handleUtilityVaultPatch(c *fiber.Ctx) error {
	a, u, d, k, err := utilityVaultScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	var in utilities.VaultPatch
	if len(c.Body()) > 16*1024 || c.BodyParser(&in) != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	item, err := s.utilities.PatchVault(c.UserContext(), a, u, d, k, in)
	if err != nil {
		return utilityError(c, err)
	}
	s.utilityVaultEvent(a, u, d, "vault", k)
	return utilityData(c, fiber.Map{"item": item})
}
func (s *Server) handleUtilityVaultDelete(c *fiber.Ctx) error {
	a, u, d, k, err := utilityVaultScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	version, err := utilityVersion(c.Query("version"))
	if err != nil {
		return utilityError(c, err)
	}
	if err = s.utilities.DeleteVault(c.UserContext(), a, u, d, k, version); err != nil {
		return utilityError(c, err)
	}
	s.utilityVaultEvent(a, u, d, "vault_deleted", k)
	// The deletion is committed. A failed follow-up read cannot turn it into a
	// reported failure; clients can retry reconciliation while preserving drafts.
	var canonical *domain.UtilityDocument
	if document, readError := s.utilities.Store.Get(c.UserContext(), a, u, d); readError == nil {
		canonical = &document
	}
	return utilityData(c, fiber.Map{"deleted": true, "cleanup_pending": true, "document": canonical})
}
func (s *Server) handleUtilityVaultMaterial(c *fiber.Ctx) error {
	a, u, d, k, err := utilityVaultScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	material, public, metadata, err := s.utilities.VaultMaterial(c.UserContext(), a, u, d, k)
	if err != nil {
		return utilityError(c, err)
	}
	return utilityData(c, fiber.Map{"material": material, "public_data": public, "metadata": metadata})
}
func (s *Server) handleUtilityVaultMaterialWrite(c *fiber.Ctx) error {
	a, u, d, k, err := utilityVaultScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	var in utilities.VaultMaterialInput
	if len(c.Body()) > 3*1024*1024 || c.BodyParser(&in) != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	item, err := s.utilities.WriteVaultMaterial(c.UserContext(), a, u, d, k, in)
	if err != nil {
		return utilityError(c, err)
	}
	s.utilityVaultEvent(a, u, d, "vault", k)
	return utilityData(c, fiber.Map{"item": item})
}
func (s *Server) handleUtilityDuplicate(c *fiber.Ctx) error {
	a, u, err := utilityScope(c)
	if err != nil {
		return utilityError(c, err)
	}
	id, err := utilityID(c)
	if err != nil {
		return utilityError(c, err)
	}
	var in utilities.DocumentDuplicate
	if len(c.Body()) > 128*1024 || c.BodyParser(&in) != nil {
		return utilityError(c, utilities.ErrInvalid)
	}
	document, err := s.utilities.DuplicateCryptoDocument(c.UserContext(), a, u, id, in)
	if err != nil {
		return utilityError(c, err)
	}
	s.utilityEvent(a, u, "document", document.ID)
	return utilityData(c, fiber.Map{"document": document})
}
