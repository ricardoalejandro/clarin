package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
)

const storageSelfServiceRetentionDays = 7

type storageSelfServiceQuerier interface {
	Query(context.Context, string, ...interface{}) (pgx.Rows, error)
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}
type storageSelfServiceReference struct {
	Origin   string `json:"type"`
	ID       string `json:"-"`
	Label    string `json:"label"`
	Href     string `json:"href"`
	Filename string `json:"-"`
}
type storageSelfServiceFile struct {
	ObjectKey       string                        `json:"object_key"`
	Filename        string                        `json:"filename"`
	MediaType       string                        `json:"media_type"`
	SizeBytes       int64                         `json:"size_bytes"`
	LastModified    time.Time                     `json:"last_modified"`
	Origins         []storageSelfServiceReference `json:"origins"`
	ReferencesCount int                           `json:"references_count"`
	CanRemove       bool                          `json:"can_remove"`
	CanRestore      bool                          `json:"can_restore"`
	CanPurge        bool                          `json:"can_purge"`
	BlockedReason   string                        `json:"blocked_reason"`
	PreviewURL      string                        `json:"preview_url"`
	Status          string                        `json:"status"`
	TrashAt         *time.Time                    `json:"trash_at,omitempty"`
	PurgeAfter      *time.Time                    `json:"purge_after,omitempty"`
	Fingerprint     string                        `json:"-"`
	refs            []storageSelfServiceReference
}
type storageSelfServiceCatalog struct {
	Files      []storageSelfServiceFile
	TotalBytes int64
}

func storageSelfServiceHasPermission(claims *service.JWTClaims, permission string) bool {
	if claims == nil {
		return false
	}
	if domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin) {
		return true
	}
	for _, p := range claims.Permissions {
		if p == permission || p == domain.PermAll {
			return true
		}
	}
	return false
}
func storageSelfServiceOriginPermission(origin string) string {
	switch origin {
	case "chats", "quick_replies", "stickers":
		return domain.PermChats
	case "campaigns":
		return domain.PermBroadcasts
	case "dynamics":
		return domain.PermDynamics
	case "surveys":
		return domain.PermSurveys
	case "documents":
		return domain.PermDocuments
	case "contacts":
		return domain.PermContacts
	}
	return ""
}
func storageSelfServiceCanRead(claims *service.JWTClaims, refs []storageSelfServiceReference) bool {
	for _, ref := range refs {
		p := storageSelfServiceOriginPermission(ref.Origin)
		if p != "" && storageSelfServiceHasPermission(claims, p) {
			return true
		}
	}
	return false
}
func storageSelfServiceValidKey(accountID uuid.UUID, key string) bool {
	return strings.HasPrefix(key, accountID.String()+"/") && !strings.ContainsAny(key, "\\\x00\r\n") && path.Clean(key) == key && !strings.HasSuffix(key, "/")
}

// Paths are never sufficient proof of user ownership. They are used only to
// exclude internal/derived files after an account-scoped business reference.
func storageSelfServiceMediaType(filename, contentType string) string {
	lower := strings.ToLower(filename)
	switch strings.ToLower(path.Ext(lower)) {
	case ".log", ".sql", ".dump", ".bak", ".json", ".jsonl", ".db", ".sqlite", ".sqlite3", ".yaml", ".yml", ".env", ".tmp":
		return ""
	case ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".odt", ".ods", ".odp", ".rtf", ".zip", ".rar", ".7z":
		return "document"
	case ".heic", ".heif", ".avif", ".bmp", ".tiff", ".tif":
		return "image"
	case ".m4a", ".flac":
		return "audio"
	case ".m4v", ".mkv", ".avi":
		return "video"
	}
	typ := classifyStorageMediaType(filename, contentType)
	if typ == "image" || typ == "video" || typ == "audio" {
		return typ
	}
	if contentType == "application/pdf" {
		return "document"
	}
	return ""
}

func storageSelfServiceExtractKeys(accountID uuid.UUID, value string) []string {
	seen := map[string]bool{}
	var visit func(interface{})
	visit = func(v interface{}) {
		switch v := v.(type) {
		case []interface{}:
			for _, x := range v {
				visit(x)
			}
		case map[string]interface{}:
			for _, x := range v {
				visit(x)
			}
		case string:
			keys := storageObjectKeyFromValue(v)
			for _, key := range keys {
				if decoded, err := url.PathUnescape(key); err == nil {
					key = decoded
				}
				key = strings.TrimRight(key, "\"']}")
				key, _, _ = strings.Cut(key, "?")
				if storageSelfServiceValidKey(accountID, key) {
					seen[key] = true
				}
			}
		}
	}
	var decoded interface{}
	if err := json.Unmarshal([]byte(value), &decoded); err == nil {
		visit(decoded)
	} else {
		visit(value)
	}
	keys := make([]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Every ownership join is tenant scoped, including legacy children without an
// account_id column. JSON payloads are inspected as well as normalized links.
// A failed source query fails the whole catalog: it can never mean "unused".
var storageSelfServiceReferenceQueries = []struct{ origin, sql string }{
	{"chats", `SELECT m.id::text,COALESCE(NULLIF(c.name,''),'Conversación'),'/dashboard/chats?open='||c.id::text,COALESCE(m.media_filename,''),jsonb_build_array(m.media_url,ma.object_key)::text FROM messages m JOIN chats c ON c.id=m.chat_id AND c.account_id=m.account_id LEFT JOIN media_assets ma ON ma.id=m.media_asset_id AND ma.account_id=m.account_id WHERE m.account_id=$1 AND NOT COALESCE(m.media_deleted,false)`},
	{"campaigns", `SELECT id::text,name,'/dashboard/broadcasts','',jsonb_build_array(media_url,settings)::text FROM campaigns WHERE account_id=$1`},
	{"campaigns", `SELECT a.id::text,c.name,'/dashboard/broadcasts',COALESCE(a.file_name,''),jsonb_build_array(a.media_url)::text FROM campaign_attachments a JOIN campaigns c ON c.id=a.campaign_id WHERE c.account_id=$1`},
	{"quick_replies", `SELECT id::text,title,'/dashboard/settings?tab=quick-replies',COALESCE(media_filename,''),jsonb_build_array(media_url,items)::text FROM quick_replies WHERE account_id=$1`},
	{"quick_replies", `SELECT a.id::text,q.title,'/dashboard/settings?tab=quick-replies',COALESCE(a.media_filename,''),jsonb_build_array(a.media_url,ma.object_key)::text FROM quick_reply_attachments a JOIN quick_replies q ON q.id=a.quick_reply_id AND q.account_id=a.account_id LEFT JOIN media_assets ma ON ma.id=a.media_asset_id AND ma.account_id=q.account_id WHERE q.account_id=$1`},
	{"stickers", `SELECT id::text,'Sticker guardado','/dashboard/chats','',jsonb_build_array(media_url)::text FROM saved_stickers WHERE account_id=$1`},
	{"dynamics", `SELECT id::text,name,'/dashboard/dynamics/'||id::text,'',jsonb_build_array(config)::text FROM dynamics WHERE account_id=$1`},
	{"dynamics", `SELECT i.id::text,d.name,'/dashboard/dynamics/'||d.id::text,'',jsonb_build_array(i.image_url)::text FROM dynamic_items i JOIN dynamics d ON d.id=i.dynamic_id WHERE d.account_id=$1`},
	{"dynamics", `SELECT l.id::text,d.name,'/dashboard/dynamics/'||d.id::text,'',jsonb_build_array(l.extra_message_media_url)::text FROM dynamic_links l JOIN dynamics d ON d.id=l.dynamic_id WHERE d.account_id=$1`},
	{"dynamics", `SELECT e.id::text,d.name,'/dashboard/dynamics/'||d.id::text,'',jsonb_build_array(e.url)::text FROM dynamic_link_extra_media e JOIN dynamic_links l ON l.id=e.link_id JOIN dynamics d ON d.id=l.dynamic_id WHERE d.account_id=$1`},
	{"dynamics", `SELECT q.id::text,d.name,'/dashboard/dynamics/'||d.id::text,'',jsonb_build_array(q.image_url,q.extra_media_url)::text FROM dynamic_whatsapp_queue q JOIN dynamics d ON d.id=q.dynamic_id AND d.account_id=q.account_id WHERE q.account_id=$1`},
	{"documents", `SELECT id::text,name,'/dashboard/documents','',jsonb_build_array(thumbnail_url,canvas_json)::text FROM document_templates WHERE account_id=$1`},
	{"surveys", `SELECT u.id::text,s.name,'/dashboard/surveys',u.original_filename,jsonb_build_array(u.object_key,ma.object_key)::text FROM survey_file_uploads u JOIN surveys s ON s.id=u.survey_id AND s.account_id=u.account_id LEFT JOIN media_assets ma ON ma.id=u.media_asset_id AND ma.account_id=u.account_id WHERE u.account_id=$1 AND u.status<>'deleted'`},
	{"surveys", `SELECT a.id::text,s.name,'/dashboard/surveys','',jsonb_build_array(a.file_url)::text FROM survey_answers a JOIN survey_responses r ON r.id=a.response_id JOIN surveys s ON s.id=r.survey_id WHERE s.account_id=$1`},
	{"surveys", `SELECT r.id::text,'Imagen de encuesta','/dashboard/surveys',ma.filename,jsonb_build_array(ma.object_key)::text FROM survey_branding_asset_refs r JOIN media_assets ma ON ma.id=r.media_asset_id AND ma.account_id=r.account_id WHERE r.account_id=$1`},
	{"surveys", `SELECT id::text,name,'/dashboard/surveys','',jsonb_build_array(branding)::text FROM surveys WHERE account_id=$1`},
	{"surveys", `SELECT id::text,name,'/dashboard/surveys','',jsonb_build_array(branding)::text FROM survey_templates WHERE account_id=$1`},
	{"contacts", `SELECT c.id::text,COALESCE(NULLIF(c.name,''),'Foto de contacto'),'/dashboard/contacts','',jsonb_build_array(c.avatar_url,ma.object_key)::text FROM contacts c LEFT JOIN media_assets ma ON ma.id=c.avatar_media_asset_id AND ma.account_id=c.account_id WHERE c.account_id=$1`},
	{"private_status", `SELECT s.id::text,'','','',jsonb_build_array(s.media_url,ma.object_key)::text FROM whatsapp_statuses s LEFT JOIN media_assets ma ON ma.id=s.media_asset_id AND ma.account_id=s.account_id WHERE s.account_id=$1`},
	{"private_work", `SELECT a.id::text,'','','',jsonb_build_array(ma.object_key)::text FROM task_attachments a JOIN media_assets ma ON ma.id=a.media_asset_id AND ma.account_id=a.account_id WHERE a.account_id=$1`},
	{"private_work", `SELECT p.id::text,'','','',jsonb_build_array(ma.object_key)::text FROM task_attachment_previews p JOIN media_assets ma ON ma.id=p.derivative_asset_id AND ma.account_id=p.account_id WHERE p.account_id=$1`},
	{"private_whiteboards", `SELECT a.id::text,'','','',jsonb_build_array(ma.object_key)::text FROM whiteboard_assets a JOIN media_assets ma ON ma.id=a.media_asset_id AND ma.account_id=a.account_id WHERE a.account_id=$1`},
	{"private_whiteboards", `SELECT a.id::text,'','','',jsonb_build_array(ma.object_key)::text FROM whiteboard_revision_assets a JOIN media_assets ma ON ma.id=a.media_asset_id AND ma.account_id=a.account_id WHERE a.account_id=$1`},
	{"private_whiteboards", `SELECT id::text,'','','',jsonb_build_array(snapshot_object_key)::text FROM whiteboard_revisions WHERE account_id=$1`},
}

func storageSelfServiceReferences(ctx context.Context, q storageSelfServiceQuerier, accountID uuid.UUID, stores ...*storage.Storage) (map[string][]storageSelfServiceReference, error) {
	refs := make(map[string][]storageSelfServiceReference)
	seen := make(map[string]bool)
	for _, source := range storageSelfServiceReferenceQueries {
		rows, err := q.Query(ctx, source.sql, accountID)
		if err != nil {
			return nil, fmt.Errorf("storage reference %s: %w", source.origin, err)
		}
		for rows.Next() {
			ref := storageSelfServiceReference{Origin: source.origin}
			var values string
			if err := rows.Scan(&ref.ID, &ref.Label, &ref.Href, &ref.Filename, &values); err != nil {
				rows.Close()
				return nil, err
			}
			for key, readable := range storageSelfServiceReferenceValues(accountID, values, stores...) {
				item := ref
				if !readable {
					item.Origin = "private_external"
					item.Label = ""
					item.Href = ""
					item.Filename = ""
				}
				id := key + "|" + item.Origin + "|" + item.ID
				if !seen[id] {
					seen[id] = true
					refs[key] = append(refs[key], item)
				}
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	for key := range refs {
		sort.Slice(refs[key], func(i, j int) bool { a, b := refs[key][i], refs[key][j]; return a.Origin+a.ID < b.Origin+b.ID })
	}
	return refs, nil
}

func storageSelfServiceFingerprint(file storageSelfServiceFile, refs []storageSelfServiceReference) string {
	type refID struct{ Origin, ID string }
	ids := make([]refID, 0, len(refs))
	for _, r := range refs {
		ids = append(ids, refID{r.Origin, r.ID})
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].Origin+ids[i].ID < ids[j].Origin+ids[j].ID })
	payload, _ := json.Marshal(struct {
		Key                 string
		Size                int64
		Modified            time.Time
		Status              string
		TrashAt, PurgeAfter *time.Time
		Refs                []refID
	}{file.ObjectKey, file.SizeBytes, file.LastModified, file.Status, file.TrashAt, file.PurgeAfter, ids})
	return fmt.Sprintf("%x", sha256.Sum256(payload))
}

func (s *Server) storageSelfServiceCatalog(ctx context.Context, q storageSelfServiceQuerier, accountID, actorID uuid.UUID, claims *service.JWTClaims, selected ...[]string) (*storageSelfServiceCatalog, error) {
	var refs map[string][]storageSelfServiceReference
	var objects []storage.ObjectSummary
	etags := map[string]string{}
	var err error
	if len(selected) > 0 {
		refs = make(map[string][]storageSelfServiceReference)
		for _, key := range selected[0] {
			if !storageSelfServiceValidKey(accountID, key) {
				return nil, fmt.Errorf("invalid key")
			}
			refs[key], err = storageSelfServiceObjectReferences(ctx, q, accountID, key, s.storage)
			if err != nil {
				return nil, err
			}
			info, statErr := s.storage.GetFileInfo(ctx, key)
			if statErr != nil {
				if storageSelfServiceObjectMissing(statErr) {
					continue
				}
				return nil, statErr
			}
			etags[key] = info.ETag
			objects = append(objects, storage.ObjectSummary{Key: key, Size: info.Size, LastModified: info.LastModified})
		}
	} else {
		refs, err = storageSelfServiceReferences(ctx, q, accountID, s.storage)
		if err != nil {
			return nil, err
		}
		objects, err = s.storage.ListPrefix(ctx, accountID.String()+"/")
		if err != nil {
			return nil, err
		}
	}
	type meta struct{ filename, contentType string }
	metadata := map[string]meta{}
	var selectedKeys []string
	if len(selected) > 0 {
		selectedKeys = selected[0]
	}
	rows, err := q.Query(ctx, `SELECT object_key,filename,content_type FROM storage_objects WHERE account_id=$1 AND ($2::text[] IS NULL OR object_key=ANY($2::text[])) UNION ALL SELECT object_key,filename,content_type FROM media_assets WHERE account_id=$1 AND ($2::text[] IS NULL OR object_key=ANY($2::text[]))`, accountID, selectedKeys)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var key string
		var m meta
		if err := rows.Scan(&key, &m.filename, &m.contentType); err != nil {
			rows.Close()
			return nil, err
		}
		metadata[key] = m
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	type trash struct {
		owner                      uuid.UUID
		filename, mediaType, state string
		removed, purge             time.Time
	}
	trashMap := map[string]trash{}
	rows, err = q.Query(ctx, `SELECT object_key,actor_id,filename,media_type,state,removed_at,purge_after FROM storage_media_trash WHERE account_id=$1 AND state IN ('trash','purging') AND ($2::text[] IS NULL OR object_key=ANY($2::text[]))`, accountID, selectedKeys)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var key string
		var t trash
		if err := rows.Scan(&key, &t.owner, &t.filename, &t.mediaType, &t.state, &t.removed, &t.purge); err != nil {
			rows.Close()
			return nil, err
		}
		trashMap[key] = t
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	catalog := &storageSelfServiceCatalog{Files: make([]storageSelfServiceFile, 0)}
	canManage := storageSelfServiceHasPermission(claims, domain.PermSettings)
	isAdmin := claims != nil && domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin)
	for _, object := range objects {
		if !storageSelfServiceValidKey(accountID, object.Key) {
			continue
		}
		catalog.TotalBytes += object.Size
		allRefs := refs[object.Key]
		t, inTrash := trashMap[object.Key]
		ownsTrash := inTrash && (t.owner == actorID || isAdmin) && storageSelfServiceHasPermission(claims, domain.PermChats)
		if !storageSelfServiceCanRead(claims, allRefs) && !ownsTrash {
			continue
		}
		m := metadata[object.Key]
		filename := m.filename
		visible := make([]storageSelfServiceReference, 0)
		chatOnly := len(allRefs) > 0
		for _, ref := range allRefs {
			if ref.Origin != "chats" {
				chatOnly = false
			}
			permission := storageSelfServiceOriginPermission(ref.Origin)
			if permission != "" && storageSelfServiceHasPermission(claims, permission) {
				if ref.Origin == "quick_replies" && !storageSelfServiceHasPermission(claims, domain.PermQuickRepliesManage) {
					ref.Href = "/dashboard/chats"
				}
				visible = append(visible, ref)
				if ref.Filename != "" {
					filename = ref.Filename
				}
			}
		}
		if ownsTrash {
			filename = t.filename
		}
		if filename == "" {
			filename = path.Base(object.Key)
		}
		filename = path.Base(strings.ReplaceAll(filename, "\\", "/"))
		mediaType := storageSelfServiceMediaType(filename, m.contentType)
		if mediaType == "" {
			continue
		}
		if storage.IsProtectedTaskObjectKey(object.Key) || storage.IsProtectedStatusObjectKey(object.Key) || strings.Contains(object.Key, "/whiteboards/") {
			continue
		}
		file := storageSelfServiceFile{ObjectKey: object.Key, Filename: filename, MediaType: mediaType, SizeBytes: object.Size, LastModified: object.LastModified, Origins: visible, ReferencesCount: len(visible), Status: "active", CanRemove: canManage && chatOnly, BlockedReason: "Gestiona este archivo desde el contenido donde se utiliza.", refs: allRefs}
		if !canManage {
			file.BlockedReason = "Necesitas permiso para gestionar el almacenamiento."
		}
		if file.CanRemove {
			file.BlockedReason = ""
		}
		if ownsTrash {
			file.Status = "trash"
			file.TrashAt = &t.removed
			file.PurgeAfter = &t.purge
			file.CanRemove = false
			file.CanRestore = canManage && t.state == "trash"
			file.CanPurge = canManage && t.state == "trash" && len(allRefs) == 0 && !time.Now().Before(t.purge)
			file.BlockedReason = "Podrás eliminarlo definitivamente después de 7 días."
			if len(allRefs) > 0 {
				file.BlockedReason = "El archivo volvió a utilizarse y se conservará."
			}
			if file.CanPurge {
				file.BlockedReason = ""
			}
			if t.state == "purging" {
				file.BlockedReason = "La eliminación está pendiente. Puedes reintentarla desde Actividad."
				file.PreviewURL = ""
			}
		} else if inTrash {
			file.CanRemove = false
			file.BlockedReason = "Este archivo tiene una operación de recuperación pendiente."
		}
		if !ownsTrash || t.state != "purging" {
			file.PreviewURL = "/api/storage/content?object_key=" + url.QueryEscape(object.Key)
		}
		file.Fingerprint = fmt.Sprintf("%x", sha256.Sum256([]byte(storageSelfServiceFingerprint(file, allRefs)+"|"+etags[object.Key])))
		catalog.Files = append(catalog.Files, file)
	}
	return catalog, nil
}

func storageSelfServiceError(c *fiber.Ctx, status int, code, message string) error {
	return c.Status(status).JSON(fiber.Map{"success": false, "code": code, "error": message})
}

// One round trip and only matching rows for hot-path image authorization. The
// final structural key check avoids substring/filename collisions in JSON.
func storageSelfServiceObjectReferences(ctx context.Context, q storageSelfServiceQuerier, accountID uuid.UUID, key string, stores ...*storage.Storage) ([]storageSelfServiceReference, error) {
	if !storageSelfServiceValidKey(accountID, key) {
		return nil, nil
	}
	queries := make([]string, 0, len(storageSelfServiceReferenceQueries))
	for _, source := range storageSelfServiceReferenceQueries {
		queries = append(queries, `SELECT '`+source.origin+`',r.id,r.label,r.href,r.filename,r.payload FROM (`+source.sql+`) AS r(id,label,href,filename,payload) WHERE strpos(r.payload,$2)>0 OR (strpos(r.payload,'%')>0 AND strpos(clarin_storage_path_unescape(r.payload),$2)>0)`)
	}
	rows, err := q.Query(ctx, strings.Join(queries, " UNION ALL "), accountID, key)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]storageSelfServiceReference, 0)
	seen := map[string]bool{}
	for rows.Next() {
		var ref storageSelfServiceReference
		var payload string
		if err := rows.Scan(&ref.Origin, &ref.ID, &ref.Label, &ref.Href, &ref.Filename, &payload); err != nil {
			return nil, err
		}
		for matched, readable := range storageSelfServiceReferenceValues(accountID, payload, stores...) {
			item := ref
			if !readable {
				item.Origin = "private_external"
				item.Label = ""
				item.Href = ""
				item.Filename = ""
			}
			id := item.Origin + "|" + item.ID
			if matched == key && !seen[id] {
				seen[id] = true
				result = append(result, item)
			}
		}
	}
	return result, rows.Err()
}

// Deletion uses conservative reference matching, while reading additionally
// proves a canonical local URL or the configured S3 origin. An unrelated host
// containing a bucket/key substring must never grant content access.
func storageSelfServiceReferenceValues(accountID uuid.UUID, payload string, stores ...*storage.Storage) map[string]bool {
	result := map[string]bool{}
	var visit func(interface{})
	visit = func(value interface{}) {
		switch v := value.(type) {
		case []interface{}:
			for _, child := range v {
				visit(child)
			}
		case map[string]interface{}:
			for _, child := range v {
				visit(child)
			}
		case string:
			local := strings.HasPrefix(v, "/api/media/file/") || strings.HasPrefix(v, accountID.String()+"/")
			for _, key := range storageSelfServiceExtractKeys(accountID, v) {
				result[key] = result[key] || local
			}
			parsed, err := url.Parse(v)
			if err == nil && strings.HasPrefix(v, "/api/media/file/") {
				key := strings.TrimPrefix(parsed.Path, "/api/media/file/")
				if storageSelfServiceValidKey(accountID, key) {
					result[key] = true
				}
			}
			if err == nil && parsed.IsAbs() {
				decodedPath := parsed.Path
				marker := "/" + accountID.String() + "/"
				if at := strings.Index(decodedPath, marker); at >= 0 {
					key := decodedPath[at+1:]
					if storageSelfServiceValidKey(accountID, key) {
						if _, exists := result[key]; !exists {
							result[key] = false
						}
					}
				}
				for _, store := range stores {
					if store != nil {
						if key, ok := store.OrdinaryObjectKeyFromURL(v); ok && storageSelfServiceValidKey(accountID, key) {
							result[key] = true
						}
					}
				}
			}
		}
	}
	var decoded interface{}
	if json.Unmarshal([]byte(payload), &decoded) == nil {
		visit(decoded)
	} else {
		visit(payload)
	}
	return result
}
