package api

import (
	"fmt"
	"log"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

// Storage operations refresh the account membership instead of trusting an old
// token after a role change. Every later query still carries this account id.
func (s *Server) storageSelfServiceActor(c *fiber.Ctx) (uuid.UUID, uuid.UUID, *service.JWTClaims, error) {
	accountID, ok := c.Locals("account_id").(uuid.UUID)
	if !ok {
		return uuid.Nil, uuid.Nil, nil, fmt.Errorf("missing account")
	}
	actorID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok {
		return uuid.Nil, uuid.Nil, nil, fmt.Errorf("missing actor")
	}
	claims, ok := c.Locals("claims").(*service.JWTClaims)
	if !ok || claims == nil || claims.AccountID != accountID || claims.UserID != actorID {
		return uuid.Nil, uuid.Nil, nil, fmt.Errorf("invalid actor")
	}
	current := *claims
	err := s.repos.DB().QueryRow(c.Context(), `SELECT ua.role,COALESCE(u.is_super_admin,false),COALESCE(r.permissions,'{}'::text[]) FROM user_accounts ua JOIN users u ON u.id=ua.user_id LEFT JOIN roles r ON r.id=ua.role_id AND r.account_id=ua.account_id WHERE ua.account_id=$1 AND ua.user_id=$2`, accountID, actorID).Scan(&current.Role, &current.IsSuperAdmin, &current.Permissions)
	if err != nil {
		return uuid.Nil, uuid.Nil, nil, err
	}
	return accountID, actorID, &current, nil
}
func (s *Server) storageSelfServiceRequestCatalog(c *fiber.Ctx) (*storageSelfServiceCatalog, *service.JWTClaims, error) {
	if s.storage == nil {
		return nil, nil, storageSelfServiceError(c, 503, "storage_unavailable", "El almacenamiento no está disponible.")
	}
	accountID, actorID, claims, err := s.storageSelfServiceActor(c)
	if err != nil {
		return nil, nil, storageSelfServiceError(c, 403, "storage_forbidden", "No tienes acceso a esta cuenta.")
	}
	catalog, err := s.storageSelfServiceCatalog(c.Context(), s.repos.DB(), accountID, actorID, claims)
	if err != nil {
		log.Printf("[StorageSelfService] catalog failed account=%s: %v", accountID, err)
		return nil, nil, storageSelfServiceError(c, 503, "storage_scan_failed", "No se pudo verificar el almacenamiento. Inténtalo de nuevo.")
	}
	return catalog, claims, nil
}
func (s *Server) handleStorageSelfServiceUsage(c *fiber.Ctx) error {
	catalog, claims, err := s.storageSelfServiceRequestCatalog(c)
	if catalog == nil {
		return err
	}
	account, err := s.services.Account.GetByID(c.Context(), claims.AccountID)
	if err != nil {
		return storageSelfServiceError(c, 503, "storage_usage_failed", "No se pudo consultar la capacidad.")
	}
	var visible, removable, trash int64
	var count, removableCount int
	byType := map[string]int64{"image": 0, "video": 0, "audio": 0, "document": 0}
	byOrigin := map[string]int64{}
	for _, f := range catalog.Files {
		visible += f.SizeBytes
		count++
		byType[f.MediaType] += f.SizeBytes
		if f.Status == "trash" {
			trash += f.SizeBytes
			byOrigin["trash"] += f.SizeBytes
		} else if len(f.Origins) > 0 {
			byOrigin[f.Origins[0].Origin] += f.SizeBytes
		}
		if f.CanRemove {
			removable += f.SizeBytes
			removableCount++
		}
	}
	used := visible
	scope := "authorized"
	reserved := int64(0)
	if domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin) {
		used = catalog.TotalBytes
		scope = "account"
		reserved = used - visible
	}
	limit := int64(0)
	if account != nil {
		limit = account.StorageLimitBytes
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
	return c.JSON(fiber.Map{"success": true, "scope": scope, "used_bytes": used, "visible_bytes": visible, "managed_elsewhere_bytes": reserved, "object_count": count, "limit_bytes": limit, "available_bytes": available, "percent_used": percent, "by_type": byType, "by_origin": byOrigin, "removable_bytes": removable, "removable_count": removableCount, "trash_bytes": trash, "can_manage": storageSelfServiceHasPermission(claims, domain.PermSettings), "retention_days": storageSelfServiceRetentionDays})
}
func storageSelfServicePage(c *fiber.Ctx) (int, int) {
	limit := c.QueryInt("limit", 40)
	if limit < 1 || limit > 100 {
		limit = 40
	}
	offset := c.QueryInt("offset", 0)
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}
func storageSelfServiceFilterFiles(files []storageSelfServiceFile, typ, query, origin, status, sortBy, order string, minSize int64, olderThanDays int, now time.Time) []storageSelfServiceFile {
	filtered := make([]storageSelfServiceFile, 0)
	for _, f := range files {
		if status == "trash" && f.Status != "trash" || status != "trash" && f.Status == "trash" {
			continue
		}
		if typ != "" && f.MediaType != typ {
			continue
		}
		if status == "removable" && !f.CanRemove || status == "protected" && f.CanRemove {
			continue
		}
		if minSize > 0 && f.SizeBytes < minSize {
			continue
		}
		if olderThanDays > 0 && f.LastModified.After(now.Add(-time.Duration(olderThanDays)*24*time.Hour)) {
			continue
		}
		if origin != "" {
			found := false
			for _, r := range f.Origins {
				if r.Origin == origin {
					found = true
				}
			}
			if !found {
				continue
			}
		}
		if query != "" {
			text := strings.ToLower(f.Filename)
			for _, r := range f.Origins {
				text += " " + strings.ToLower(r.Label)
			}
			if !strings.Contains(text, query) {
				continue
			}
		}
		filtered = append(filtered, f)
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		a, b := filtered[i], filtered[j]
		cmp := 0
		switch sortBy {
		case "size":
			if a.SizeBytes < b.SizeBytes {
				cmp = -1
			} else if a.SizeBytes > b.SizeBytes {
				cmp = 1
			}
		case "name":
			cmp = strings.Compare(strings.ToLower(a.Filename), strings.ToLower(b.Filename))
		default:
			if a.LastModified.Before(b.LastModified) {
				cmp = -1
			} else if a.LastModified.After(b.LastModified) {
				cmp = 1
			}
		}
		if cmp == 0 {
			return a.ObjectKey < b.ObjectKey
		}
		if order == "asc" {
			return cmp < 0
		}
		return cmp > 0
	})
	return filtered
}
func (s *Server) handleStorageSelfServiceFiles(c *fiber.Ctx) error {
	catalog, claims, err := s.storageSelfServiceRequestCatalog(c)
	if catalog == nil {
		return err
	}
	limit, offset := storageSelfServicePage(c)
	minSize := int64(c.QueryInt("min_size", 0))
	days := c.QueryInt("older_than_days", 0)
	if days > 36500 {
		days = 36500
	}
	files := storageSelfServiceFilterFiles(catalog.Files, strings.TrimSpace(c.Query("type")), strings.ToLower(strings.TrimSpace(c.Query("q"))), c.Query("origin"), c.Query("status", "all"), c.Query("sort", "size"), c.Query("order", "desc"), minSize, days, time.Now())
	total := len(files)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	// The full count remains accurate, but repeated references in the same
	// context are presented once. Internal identifiers never leave the server.
	for i := offset; i < end; i++ {
		seen := map[string]bool{}
		origins := make([]storageSelfServiceReference, 0)
		for _, r := range files[i].Origins {
			k := r.Origin + "|" + r.Href + "|" + r.Label
			if !seen[k] {
				seen[k] = true
				origins = append(origins, r)
			}
		}
		files[i].Origins = origins
	}
	return c.JSON(fiber.Map{"success": true, "files": files[offset:end], "total": total, "limit": limit, "offset": offset, "next_offset": end, "has_more": end < total, "can_manage": storageSelfServiceHasPermission(claims, domain.PermSettings)})
}
func (s *Server) handleStorageSelfServiceContent(c *fiber.Ctx) error {
	if s.storage == nil {
		return storageSelfServiceError(c, 503, "storage_unavailable", "El almacenamiento no está disponible.")
	}
	accountID, actorID, claims, err := s.storageSelfServiceActor(c)
	if err != nil {
		return storageSelfServiceError(c, 403, "storage_forbidden", "No tienes acceso a esta cuenta.")
	}
	key := c.Query("object_key")
	if !storageSelfServiceValidKey(accountID, key) {
		return storageSelfServiceError(c, 404, "storage_not_found", "Archivo no disponible.")
	}
	catalog, err := s.storageSelfServiceCatalog(c.Context(), s.repos.DB(), accountID, actorID, claims, []string{key})
	if err != nil {
		return storageSelfServiceError(c, 404, "storage_not_found", "Archivo no disponible.")
	}
	for _, f := range catalog.Files {
		if f.ObjectKey == key && f.PreviewURL != "" {
			c.Set("Content-Disposition", fmt.Sprintf("inline; filename*=UTF-8''%s", url.PathEscape(f.Filename)))
			c.Set("Content-Security-Policy", "sandbox; default-src 'none'")
			return s.serveStorageObject(c, key, "private, no-store", "")
		}
	}
	return storageSelfServiceError(c, 404, "storage_not_found", "Archivo no disponible.")
}
func (s *Server) handleStorageLegacyMutationDisabled(c *fiber.Ctx) error {
	return storageSelfServiceError(c, 410, "storage_review_required", "Esta operación ya no está disponible. Revisa los archivos desde Almacenamiento.")
}
