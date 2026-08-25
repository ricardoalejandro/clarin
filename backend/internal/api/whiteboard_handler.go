package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

var emptyWhiteboardScene = json.RawMessage(`{"type":"excalidraw","version":2,"source":"clarin","elements":[],"appState":{},"files":{}}`)

func whiteboardError(c *fiber.Ctx, err error) error {
	if err == nil {
		return nil
	}
	var conflict *repository.WhiteboardConflictError
	var trashEligibility *repository.WhiteboardTrashEligibilityError
	switch {
	case errors.As(err, &conflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La pizarra cambió en otra sesión", "code": "whiteboard_conflict", "current_sequence": conflict.CurrentSequence, "current_version": conflict.CurrentVersion})
	case errors.Is(err, repository.ErrWhiteboardNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Recurso no encontrado", "code": "whiteboard_not_found"})
	case errors.Is(err, repository.ErrWhiteboardForbidden):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "No tienes acceso suficiente", "code": "whiteboard_forbidden"})
	case errors.Is(err, repository.ErrWhiteboardFolderNotEmpty):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La carpeta contiene carpetas o pizarras activas", "code": "whiteboard_folder_not_empty"})
	case errors.Is(err, repository.ErrWhiteboardConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "El recurso cambió o ya existe", "code": "whiteboard_conflict"})
	case errors.Is(err, repository.ErrWhiteboardUploadInProgress):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "El archivo ya se está cargando", "code": "whiteboard_upload_in_progress"})
	case errors.Is(err, repository.ErrWhiteboardStorageLimit):
		return c.Status(fiber.StatusInsufficientStorage).JSON(fiber.Map{"success": false, "error": "Límite de almacenamiento alcanzado", "code": "storage_limit_reached"})
	case errors.Is(err, repository.ErrWhiteboardShareUnavailable):
		return c.Status(fiber.StatusGone).JSON(fiber.Map{"success": false, "error": "El enlace no está disponible", "code": "whiteboard_share_unavailable"})
	case errors.Is(err, repository.ErrWhiteboardSessionUnavailable):
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "La sesión de invitado no está disponible", "code": "whiteboard_guest_session_unavailable"})
	case errors.Is(err, repository.ErrWhiteboardLibraryImportExpired):
		return c.Status(fiber.StatusGone).JSON(fiber.Map{"success": false, "error": "La importación de biblioteca expiró", "code": "whiteboard_library_import_expired"})
	case errors.Is(err, repository.ErrWhiteboardLibraryImportUnavailable):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La importación de biblioteca ya fue consumida o no está lista", "code": "whiteboard_library_import_unavailable"})
	case errors.Is(err, repository.ErrWhiteboardLibraryImportNotPersisted):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Los elementos importados aún no están guardados en la biblioteca personal", "code": "whiteboard_library_import_not_persisted"})
	case errors.Is(err, service.ErrWhiteboardPublicLibrary):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "La biblioteca pública no es válida o no pudo verificarse", "code": "invalid_public_whiteboard_library"})
	case errors.Is(err, repository.ErrWhiteboardTrashConfirmation):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "El nombre de confirmación no coincide", "code": "whiteboard_trash_confirmation_mismatch"})
	case errors.As(err, &trashEligibility):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La pizarra aún está dentro del plazo de retención", "code": "whiteboard_trash_not_eligible", "next_eligible_at": trashEligibility.NextEligibleAt})
	case errors.Is(err, repository.ErrWhiteboardTrashNotEligible):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La pizarra no está lista para eliminarse permanentemente", "code": "whiteboard_trash_not_eligible"})
	case errors.Is(err, repository.ErrWhiteboardInvalid), errors.Is(err, service.ErrWhiteboardPayloadInvalid):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Datos de pizarra inválidos", "code": "invalid_whiteboard_payload"})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo completar la operación", "code": "whiteboard_internal_error"})
	}
}

func whiteboardWriteFailureCode(err error) string {
	var conflict *repository.WhiteboardConflictError
	switch {
	case errors.As(err, &conflict), errors.Is(err, repository.ErrWhiteboardConflict):
		return "whiteboard_conflict"
	case errors.Is(err, repository.ErrWhiteboardNotFound):
		return "whiteboard_not_found"
	case errors.Is(err, repository.ErrWhiteboardForbidden):
		return "whiteboard_forbidden"
	case errors.Is(err, repository.ErrWhiteboardStorageLimit):
		return "storage_limit_reached"
	case errors.Is(err, repository.ErrWhiteboardUploadInProgress):
		return "whiteboard_upload_in_progress"
	case errors.Is(err, repository.ErrWhiteboardInvalid), errors.Is(err, service.ErrWhiteboardPayloadInvalid), errors.Is(err, whiteboardcore.ErrInvalidRealtimeMessage):
		return "invalid_whiteboard_payload"
	default:
		return "whiteboard_internal_error"
	}
}

func whiteboardSceneWriteError(c *fiber.Ctx, transport string, accountID, boardID, operationID uuid.UUID, err error) error {
	log.Printf("[WHITEBOARD WRITE] transport=%s account=%s board=%s operation=%s code=%s err=%v",
		transport, accountID, boardID, operationID, whiteboardWriteFailureCode(err), err)
	return whiteboardError(c, err)
}

func logWhiteboardSceneConflict(transport string, accountID, boardID, operationID uuid.UUID, kind string, expectedSequence int64, currentSequence *int64) {
	current := "unknown"
	if currentSequence != nil {
		current = strconv.FormatInt(*currentSequence, 10)
	}
	log.Printf("[WHITEBOARD WRITE] transport=%s account=%s board=%s operation=%s code=whiteboard_conflict conflict_kind=%s expected_sequence=%d current_sequence=%s",
		transport, accountID, boardID, operationID, kind, expectedSequence, current)
}

func whiteboardSceneConflictError(c *fiber.Ctx, transport string, accountID, boardID, operationID uuid.UUID, kind string, expectedSequence, currentSequence int64) error {
	logWhiteboardSceneConflict(transport, accountID, boardID, operationID, kind, expectedSequence, &currentSequence)
	return whiteboardError(c, &repository.WhiteboardConflictError{CurrentSequence: currentSequence})
}

func whiteboardActor(c *fiber.Ctx) (uuid.UUID, uuid.UUID, error) {
	accountID, accountOK := c.Locals("account_id").(uuid.UUID)
	userID, userOK := c.Locals("user_id").(uuid.UUID)
	if !accountOK || !userOK || accountID == uuid.Nil || userID == uuid.Nil {
		return uuid.Nil, uuid.Nil, fiber.ErrUnauthorized
	}
	return accountID, userID, nil
}

func whiteboardPathID(c *fiber.Ctx, name string) (uuid.UUID, error) {
	id, err := uuid.Parse(c.Params(name))
	if err != nil || id == uuid.Nil {
		return uuid.Nil, repository.ErrWhiteboardInvalid
	}
	return id, nil
}

func whiteboardLimit(c *fiber.Ctx) int {
	limit, err := strconv.Atoi(c.Query("limit", "50"))
	if err != nil || limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func whiteboardExpectedVersionQuery(c *fiber.Ctx) (int64, error) {
	version, err := strconv.ParseInt(c.Query("expected_version"), 10, 64)
	if err != nil || version <= 0 {
		return 0, repository.ErrWhiteboardInvalid
	}
	return version, nil
}

func (s *Server) handleListWhiteboardFolders(c *fiber.Ctx) error {
	accountID, _, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	options := repository.WhiteboardFolderListOptions{Limit: whiteboardLimit(c), IncludeArchived: c.QueryBool("include_archived", false)}
	if rawParent, present := c.Queries()["parent_id"]; present {
		options.FilterByParent = true
		if rawParent != "" && rawParent != "root" {
			parentID, parseErr := uuid.Parse(rawParent)
			if parseErr != nil {
				return whiteboardError(c, repository.ErrWhiteboardInvalid)
			}
			options.ParentID = &parentID
		}
	}
	options.AfterSortOrder, options.AfterID, err = service.DecodeWhiteboardFolderCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListFolders(c.Context(), accountID, options)
	if err != nil {
		return whiteboardError(c, err)
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardFolderCursor(last.SortOrder, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "folders": items, "next_cursor": nextCursor})
}

func (s *Server) handleCreateWhiteboardFolder(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	var request struct {
		ParentID    *uuid.UUID `json:"parent_id"`
		Name        string     `json:"name"`
		Description string     `json:"description"`
		SortOrder   *int64     `json:"sort_order"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	request.Name, err = service.NormalizeWhiteboardName(request.Name, 120)
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.CreateFolder(c.Context(), accountID, actorID, repository.WhiteboardFolderInput{
		ParentID: request.ParentID, Name: request.Name, Description: strings.TrimSpace(request.Description), SortOrder: request.SortOrder,
	})
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "folder": item})
}

func (s *Server) handleGetWhiteboardFolder(c *fiber.Ctx) error {
	accountID, _, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	folderID, err := whiteboardPathID(c, "folderId")
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.GetFolder(c.Context(), accountID, folderID)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "folder": item})
}

func (s *Server) handleUpdateWhiteboardFolder(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	folderID, err := whiteboardPathID(c, "folderId")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		ParentID    *uuid.UUID `json:"parent_id"`
		Name        string     `json:"name"`
		Description string     `json:"description"`
		SortOrder   *int64     `json:"sort_order"`
		Placement   *struct {
			ParentID       *uuid.UUID `json:"parent_id"`
			BeforeFolderID *uuid.UUID `json:"before_folder_id"`
		} `json:"placement"`
		ExpectedVersion int64 `json:"expected_version"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	var rawFields map[string]json.RawMessage
	if err := json.Unmarshal(c.Body(), &rawFields); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	_, parentIDProvided := rawFields["parent_id"]
	if request.Placement != nil && request.SortOrder != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	request.Name, err = service.NormalizeWhiteboardName(request.Name, 120)
	if err != nil {
		return whiteboardError(c, err)
	}
	var placement *repository.WhiteboardFolderPlacement
	if request.Placement != nil {
		placement = &repository.WhiteboardFolderPlacement{
			ParentID: request.Placement.ParentID, BeforeFolderID: request.Placement.BeforeFolderID,
		}
	}
	result, err := s.repos.Whiteboard.UpdateFolder(c.Context(), accountID, actorID, folderID, repository.WhiteboardFolderInput{
		ParentID: request.ParentID, Name: request.Name, Description: strings.TrimSpace(request.Description),
		ParentIDProvided: parentIDProvided, SortOrder: request.SortOrder, Placement: placement,
		ExpectedVersion: request.ExpectedVersion,
	})
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "folder": result.Folder, "affected_folders": result.AffectedFolders})
}

func (s *Server) handleArchiveWhiteboardFolder(c *fiber.Ctx) error {
	accountID, _, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	folderID, err := whiteboardPathID(c, "folderId")
	if err != nil {
		return whiteboardError(c, err)
	}
	version, err := whiteboardExpectedVersionQuery(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	if err := s.repos.Whiteboard.ArchiveFolder(c.Context(), accountID, folderID, version); err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleRestoreWhiteboardFolder(c *fiber.Ctx) error {
	accountID, _, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	folderID, err := whiteboardPathID(c, "folderId")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		ExpectedVersion int64 `json:"expected_version"`
	}
	if err := c.BodyParser(&request); err != nil || request.ExpectedVersion <= 0 {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	item, err := s.repos.Whiteboard.RestoreFolder(c.Context(), accountID, folderID, request.ExpectedVersion)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "folder": item})
}

func (s *Server) handleListWhiteboards(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	options := repository.WhiteboardListOptions{Query: c.Query("q"), Scope: c.Query("scope", repository.WhiteboardScopeAll), Limit: whiteboardLimit(c)}
	if rawFolder := strings.TrimSpace(c.Query("folder_id")); rawFolder != "" {
		folderID, parseErr := uuid.Parse(rawFolder)
		if parseErr != nil {
			return whiteboardError(c, repository.ErrWhiteboardInvalid)
		}
		options.FolderID = &folderID
	}
	options.BeforeUpdatedAt, options.BeforeID, err = service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListBoards(c.Context(), accountID, actorID, options)
	if err != nil {
		return whiteboardError(c, err)
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardBoardCursor(last.UpdatedAt, last.ID)
	}
	counts, err := s.repos.Whiteboard.CountBoardScopes(c.Context(), accountID, actorID)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{
		"success": true, "whiteboards": items, "next_cursor": nextCursor, "counts": counts,
		"permissions": fiber.Map{"can_create": true, "can_create_folder": true},
	})
}

func (s *Server) prepareAndUploadWhiteboardSnapshot(ctx context.Context, accountID, boardID, operationID uuid.UUID, scene json.RawMessage) (service.PreparedWhiteboardSnapshot, error) {
	if s.storage == nil {
		return service.PreparedWhiteboardSnapshot{}, fiber.ErrServiceUnavailable
	}
	prepared, err := service.PrepareWhiteboardSnapshot(accountID, boardID, operationID, scene)
	if err != nil {
		return service.PreparedWhiteboardSnapshot{}, err
	}
	reserved, err := s.repos.Whiteboard.ReserveRevisionSnapshot(ctx, accountID, prepared.ObjectKey, prepared.ContentHash, prepared.SizeBytes)
	if err != nil {
		return service.PreparedWhiteboardSnapshot{}, err
	}
	if !reserved {
		// The object already belongs to a committed idempotent operation.
		// writeScene verifies the result hash before it can reuse that result.
		return prepared, nil
	}
	if _, err := s.storage.UploadObject(ctx, prepared.ObjectKey, prepared.CompressedBytes, service.WhiteboardSnapshotContentType()); err != nil {
		_ = s.repos.Whiteboard.MarkRevisionSnapshotFailed(ctx, accountID, prepared.ObjectKey, "storage upload failed")
		return service.PreparedWhiteboardSnapshot{}, err
	}
	prepared.UploadedByRequest = true
	return prepared, nil
}

func (s *Server) handleCreateWhiteboard(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	var request struct {
		FolderID           *uuid.UUID      `json:"folder_id"`
		Name               string          `json:"name"`
		Description        string          `json:"description"`
		Scene              json.RawMessage `json:"scene"`
		SceneSchemaVersion string          `json:"scene_schema_version"`
		EditorVersion      string          `json:"editor_version"`
		AccessMode         string          `json:"access_mode"`
		OperationID        *uuid.UUID      `json:"operation_id"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	request.Name, err = service.NormalizeWhiteboardName(request.Name, 200)
	if err != nil {
		return whiteboardError(c, err)
	}
	if len(request.Scene) == 0 {
		request.Scene = emptyWhiteboardScene
	}
	var sceneHash string
	request.Scene, sceneHash, err = service.ValidateAndHashWhiteboardScene(request.Scene)
	if err != nil {
		return whiteboardError(c, err)
	}
	if referencedFiles, referenceErr := whiteboardcore.ReferencedFileIDs(request.Scene); referenceErr != nil || len(referencedFiles) > 0 {
		// Import assets only after the board exists, then commit the imported
		// scene in one ordinary snapshot transaction.
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	request.SceneSchemaVersion, err = service.ValidateWhiteboardVersion(request.SceneSchemaVersion, "excalidraw")
	if err != nil || request.SceneSchemaVersion != "excalidraw" {
		return whiteboardError(c, service.ErrWhiteboardPayloadInvalid)
	}
	request.EditorVersion = whiteboardEditorVersion
	if request.AccessMode == "" {
		request.AccessMode = domain.WhiteboardAccessPrivate
	}
	if request.AccessMode != domain.WhiteboardAccessPrivate && request.AccessMode != domain.WhiteboardAccessAccount {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	operationID := uuid.New()
	if request.OperationID != nil {
		operationID = *request.OperationID
	}
	boardID, err := service.StableWhiteboardID(accountID, operationID)
	if err != nil {
		return whiteboardError(c, err)
	}
	createPayload, err := json.Marshal(struct {
		FolderID           *uuid.UUID `json:"folder_id"`
		Name               string     `json:"name"`
		Description        string     `json:"description"`
		SceneHash          string     `json:"scene_hash"`
		SceneSchemaVersion string     `json:"scene_schema_version"`
		EditorVersion      string     `json:"editor_version"`
		AccessMode         string     `json:"access_mode"`
	}{
		FolderID: request.FolderID, Name: request.Name, Description: strings.TrimSpace(request.Description),
		SceneHash: sceneHash, SceneSchemaVersion: request.SceneSchemaVersion,
		EditorVersion: request.EditorVersion, AccessMode: request.AccessMode,
	})
	if err != nil {
		return whiteboardError(c, err)
	}
	createPayloadHash, err := service.HashWhiteboardOperationPayload(createPayload)
	if err != nil {
		return whiteboardError(c, err)
	}
	if existing, found, findErr := s.repos.Whiteboard.FindCreatedBoardByOperation(c.Context(), accountID, actorID, boardID, operationID, createPayloadHash); findErr != nil {
		return whiteboardError(c, findErr)
	} else if found {
		return c.JSON(fiber.Map{"success": true, "whiteboard": existing, "idempotent": true})
	}
	prepared, err := s.prepareAndUploadWhiteboardSnapshot(c.Context(), accountID, boardID, operationID, request.Scene)
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.CreateBoard(c.Context(), repository.WhiteboardCreateInput{
		ID: boardID, AccountID: accountID, ActorID: actorID, FolderID: request.FolderID,
		Name: request.Name, Description: strings.TrimSpace(request.Description), Scene: request.Scene,
		SceneSchemaVersion: request.SceneSchemaVersion, EditorVersion: request.EditorVersion,
		AccessMode: request.AccessMode, OperationID: operationID, RequestPayloadHash: createPayloadHash, ResultSceneHash: prepared.SceneHash,
		SnapshotObjectKey: prepared.ObjectKey, SnapshotContentHash: prepared.ContentHash, SnapshotSizeBytes: prepared.SizeBytes,
	})
	if err != nil {
		if prepared.UploadedByRequest {
			_ = s.repos.Whiteboard.MarkRevisionSnapshotFailed(c.Context(), accountID, prepared.ObjectKey, "board creation failed")
		}
		return whiteboardError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "whiteboard": item})
}

func whiteboardCopyName(name string) string {
	const suffix = " (copia)"
	runes := []rune(strings.TrimSpace(name))
	maximumBase := 200 - len([]rune(suffix))
	if len(runes) > maximumBase {
		runes = runes[:maximumBase]
	}
	return string(runes) + suffix
}

// handleDuplicateWhiteboard creates a new private board with the source's
// current scene and committed asset manifest. It deliberately copies neither
// grants nor public links, and a client-supplied operation ID makes the whole
// operation safe to retry after a lost response.
func (s *Server) handleDuplicateWhiteboard(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	sourceBoardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		FolderID    *uuid.UUID `json:"folder_id"`
		Name        string     `json:"name"`
		OperationID *uuid.UUID `json:"operation_id"`
	}
	if len(c.Body()) > 0 {
		if err := c.BodyParser(&request); err != nil {
			return whiteboardError(c, repository.ErrWhiteboardInvalid)
		}
	}
	source, err := s.repos.Whiteboard.GetBoard(c.Context(), accountID, actorID, sourceBoardID)
	if err != nil {
		return whiteboardError(c, err)
	}
	if source.ArchivedAt != nil {
		return whiteboardError(c, repository.ErrWhiteboardConflict)
	}
	if request.FolderID == nil {
		request.FolderID = source.FolderID
	}
	if strings.TrimSpace(request.Name) == "" {
		request.Name = whiteboardCopyName(source.Name)
	}
	request.Name, err = service.NormalizeWhiteboardName(request.Name, 200)
	if err != nil {
		return whiteboardError(c, err)
	}
	operationID := uuid.New()
	if request.OperationID != nil {
		operationID = *request.OperationID
	}
	boardID, err := service.StableWhiteboardID(accountID, operationID)
	if err != nil || boardID == sourceBoardID {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	requestPayload, err := json.Marshal(struct {
		SourceBoardID uuid.UUID  `json:"source_board_id"`
		FolderID      *uuid.UUID `json:"folder_id"`
		Name          string     `json:"name"`
	}{SourceBoardID: sourceBoardID, FolderID: request.FolderID, Name: request.Name})
	if err != nil {
		return whiteboardError(c, err)
	}
	requestPayloadHash, err := service.HashWhiteboardOperationPayload(requestPayload)
	if err != nil {
		return whiteboardError(c, err)
	}
	if existing, found, findErr := s.repos.Whiteboard.FindCreatedBoardByOperation(
		c.Context(), accountID, actorID, boardID, operationID, requestPayloadHash,
	); findErr != nil {
		return whiteboardError(c, findErr)
	} else if found {
		return c.JSON(fiber.Map{"success": true, "whiteboard": existing, "idempotent": true})
	}
	scene, err := s.repos.Whiteboard.GetScene(c.Context(), accountID, actorID, sourceBoardID, domain.WhiteboardAccessView)
	if err != nil {
		return whiteboardError(c, err)
	}
	prepared, err := s.prepareAndUploadWhiteboardSnapshot(c.Context(), accountID, boardID, operationID, scene.Scene)
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.DuplicateBoard(c.Context(), repository.WhiteboardDuplicateInput{
		ID: boardID, AccountID: accountID, ActorID: actorID, SourceBoardID: sourceBoardID,
		FolderID: request.FolderID, Name: request.Name, Description: source.Description, Scene: scene.Scene,
		SceneSchemaVersion: scene.SceneSchemaVersion, EditorVersion: scene.EditorVersion,
		OperationID: operationID, RequestPayloadHash: requestPayloadHash, ResultSceneHash: prepared.SceneHash,
		SnapshotObjectKey: prepared.ObjectKey, SnapshotContentHash: prepared.ContentHash,
		SnapshotSizeBytes: prepared.SizeBytes,
	})
	if err != nil {
		if prepared.UploadedByRequest {
			_ = s.repos.Whiteboard.MarkRevisionSnapshotFailed(c.Context(), accountID, prepared.ObjectKey, "board duplication failed")
		}
		return whiteboardError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "whiteboard": item})
}

func (s *Server) handleGetWhiteboard(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.GetBoard(c.Context(), accountID, actorID, boardID)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "whiteboard": item})
}

func (s *Server) handleListWhiteboardActivity(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	beforeCreatedAt, beforeID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListBoardActivity(c.Context(), accountID, actorID, boardID,
		repository.WhiteboardActivityListOptions{BeforeCreatedAt: beforeCreatedAt, BeforeID: beforeID, Limit: whiteboardLimit(c)})
	if err != nil {
		return whiteboardError(c, err)
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardBoardCursor(last.CreatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "activity": items, "next_cursor": nextCursor})
}

func (s *Server) handleUpdateWhiteboard(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		FolderID        *uuid.UUID `json:"folder_id"`
		Name            string     `json:"name"`
		Description     string     `json:"description"`
		ExpectedVersion int64      `json:"expected_version"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	request.Name, err = service.NormalizeWhiteboardName(request.Name, 200)
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.UpdateBoard(c.Context(), accountID, actorID, boardID, repository.WhiteboardUpdateInput{
		FolderID: request.FolderID, Name: request.Name, Description: strings.TrimSpace(request.Description), ExpectedVersion: request.ExpectedVersion,
	})
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "whiteboard": item})
}

func (s *Server) handleArchiveWhiteboard(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	version, err := whiteboardExpectedVersionQuery(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	if err := s.repos.Whiteboard.ArchiveBoard(c.Context(), accountID, actorID, boardID, version); err != nil {
		return whiteboardError(c, err)
	}
	// Archiving terminates every live collaboration principal immediately;
	// relying only on the next rejected write would leave presence and cursors
	// visible for an inactive board.
	s.revokeWhiteboardBoardSockets(accountID, boardID)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleRestoreWhiteboard(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		ExpectedVersion int64 `json:"expected_version"`
	}
	if err := c.BodyParser(&request); err != nil || request.ExpectedVersion <= 0 {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	item, err := s.repos.Whiteboard.RestoreBoard(c.Context(), accountID, actorID, boardID, request.ExpectedVersion)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "whiteboard": item})
}

func (s *Server) handleGetWhiteboardScene(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	scene, err := s.repos.Whiteboard.GetScene(c.Context(), accountID, actorID, boardID, domain.WhiteboardAccessView)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "scene": scene})
}

type whiteboardSceneWriteRequest struct {
	ExpectedSequence   int64           `json:"expected_sequence"`
	OperationID        uuid.UUID       `json:"operation_id"`
	Scene              json.RawMessage `json:"scene"`
	Patch              json.RawMessage `json:"patch"`
	SceneSchemaVersion string          `json:"scene_schema_version"`
	EditorVersion      string          `json:"editor_version"`
}

func parseWhiteboardSceneWrite(c *fiber.Ctx) (whiteboardSceneWriteRequest, error) {
	var request whiteboardSceneWriteRequest
	if err := c.BodyParser(&request); err != nil || request.OperationID == uuid.Nil || request.ExpectedSequence < 0 {
		return request, repository.ErrWhiteboardInvalid
	}
	var err error
	request.Scene, err = service.ValidateWhiteboardScene(request.Scene)
	if err != nil {
		return request, err
	}
	request.SceneSchemaVersion, err = service.ValidateWhiteboardVersion(request.SceneSchemaVersion, "excalidraw")
	if err != nil || request.SceneSchemaVersion != "excalidraw" {
		return request, service.ErrWhiteboardPayloadInvalid
	}
	request.EditorVersion = whiteboardEditorVersion
	return request, nil
}

func (s *Server) handlePutWhiteboardScene(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	if _, err := s.repos.Whiteboard.RequireAccess(c.Context(), accountID, actorID, boardID, domain.WhiteboardAccessEdit); err != nil {
		return whiteboardSceneWriteError(c, "rest.snapshot", accountID, boardID, uuid.Nil, err)
	}
	request, err := parseWhiteboardSceneWrite(c)
	if err != nil {
		return whiteboardSceneWriteError(c, "rest.snapshot", accountID, boardID, request.OperationID, err)
	}
	prepared, err := s.prepareAndUploadWhiteboardSnapshot(c.Context(), accountID, boardID, request.OperationID, request.Scene)
	if err != nil {
		return whiteboardSceneWriteError(c, "rest.snapshot", accountID, boardID, request.OperationID, err)
	}
	result, err := s.repos.Whiteboard.UpdateScene(c.Context(), accountID, actorID, boardID, repository.WhiteboardSceneWriteInput{
		ExpectedSequence: request.ExpectedSequence, OperationID: request.OperationID, Scene: request.Scene,
		SceneSchemaVersion: request.SceneSchemaVersion, EditorVersion: request.EditorVersion, WriteKind: "snapshot", RevisionKind: "automatic",
		ResultSceneHash: prepared.SceneHash, SnapshotObjectKey: prepared.ObjectKey,
		SnapshotContentHash: prepared.ContentHash, SnapshotSizeBytes: prepared.SizeBytes,
	})
	if err != nil {
		if prepared.UploadedByRequest {
			_ = s.repos.Whiteboard.MarkRevisionSnapshotFailed(c.Context(), accountID, prepared.ObjectKey, "scene snapshot failed")
		}
		return whiteboardSceneWriteError(c, "rest.snapshot", accountID, boardID, request.OperationID, err)
	}
	s.broadcastWhiteboardMessage(accountID, boardID, whiteboardSceneSnapshotMessage(result.Scene), uuid.Nil)
	return c.JSON(fiber.Map{"success": true, "result": result})
}

func (s *Server) handlePatchWhiteboardScene(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	request, err := parseWhiteboardSceneWrite(c)
	if err != nil || len(request.Patch) == 0 || !json.Valid(request.Patch) {
		return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, repository.ErrWhiteboardInvalid)
	}
	var patch whiteboardRealtimePatchData
	if err := json.Unmarshal(request.Patch, &patch); err != nil || len(patch.Elements) > whiteboardcore.MaxElementsPerPatch {
		return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, repository.ErrWhiteboardInvalid)
	}
	patch.ClientBaseSequence = request.ExpectedSequence
	patch.AppState, err = whiteboardcore.SanitizePersistedAppState(patch.AppState)
	if err != nil {
		return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, repository.ErrWhiteboardInvalid)
	}
	var persistedAppState map[string]json.RawMessage
	if err := json.Unmarshal(patch.AppState, &persistedAppState); err != nil || (len(patch.Elements) == 0 && len(persistedAppState) == 0) {
		return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, repository.ErrWhiteboardInvalid)
	}
	requestHash, err := whiteboardPatchRequestPayloadHash(request.ExpectedSequence, patch.Elements, patch.AppState)
	if err != nil {
		return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, err)
	}
	if existing, found, findErr := s.repos.Whiteboard.FindSceneOperation(c.Context(), accountID, actorID, boardID, request.OperationID, requestHash); findErr != nil {
		if errors.Is(findErr, repository.ErrWhiteboardConflict) {
			logWhiteboardSceneConflict("rest.patch", accountID, boardID, request.OperationID, "operation_reuse", request.ExpectedSequence, nil)
			return whiteboardError(c, findErr)
		}
		return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, findErr)
	} else if found {
		return c.JSON(fiber.Map{
			"success": true, "result": existing,
			"rebased": existing.OperationSequence > request.ExpectedSequence+1,
		})
	}
	var result *domain.WhiteboardSceneWriteResult
	var rebased bool
	for attempt := 0; attempt < 3; attempt++ {
		current, currentErr := s.repos.Whiteboard.GetScene(c.Context(), accountID, actorID, boardID, domain.WhiteboardAccessEdit)
		if currentErr != nil {
			return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, currentErr)
		}
		if request.ExpectedSequence > current.Sequence {
			return whiteboardSceneConflictError(c, "rest.patch", accountID, boardID, request.OperationID,
				"future_base", request.ExpectedSequence, current.Sequence)
		}
		patch.BaseSequence = current.Sequence
		materialized, _, materializeErr := whiteboardcore.MaterializeScenePatch(current.Scene, patch.Elements, patch.AppState)
		if materializeErr != nil {
			return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, repository.ErrWhiteboardInvalid)
		}
		materialized, sceneHash, validateErr := service.ValidateAndHashWhiteboardScene(materialized)
		if validateErr != nil {
			return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, validateErr)
		}
		canonicalPatch, marshalErr := json.Marshal(patch)
		if marshalErr != nil {
			return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, repository.ErrWhiteboardInvalid)
		}
		result, err = s.repos.Whiteboard.ApplyScenePatch(c.Context(), accountID, actorID, boardID, repository.WhiteboardSceneWriteInput{
			ExpectedSequence: current.Sequence, OperationID: request.OperationID, Scene: materialized, Patch: canonicalPatch,
			SceneSchemaVersion: current.SceneSchemaVersion, EditorVersion: whiteboardEditorVersion,
			RequestPayloadHash: requestHash, ResultSceneHash: sceneHash,
		})
		if err == nil {
			rebased = request.ExpectedSequence < current.Sequence
			break
		}
		var concurrentConflict *repository.WhiteboardConflictError
		if !errors.As(err, &concurrentConflict) {
			return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, err)
		}
	}
	if result == nil {
		latest, latestErr := s.repos.Whiteboard.GetScene(c.Context(), accountID, actorID, boardID, domain.WhiteboardAccessView)
		if latestErr != nil {
			return whiteboardSceneWriteError(c, "rest.patch", accountID, boardID, request.OperationID, latestErr)
		}
		return whiteboardSceneConflictError(c, "rest.patch", accountID, boardID, request.OperationID,
			"retry_exhausted", request.ExpectedSequence, latest.Sequence)
	}
	if !result.Idempotent {
		operationID := request.OperationID
		s.broadcastWhiteboardMessage(accountID, boardID, whiteboardcore.OutgoingMessage{
			Event: whiteboardcore.EventScenePatch, OperationID: &operationID, Sequence: result.Scene.Sequence,
			Actor: whiteboardcore.RealtimeActor{Kind: "user", ID: uuid.New(), UserID: &actorID, DisplayName: "Usuario de Clarin"}, Data: patch,
		}, uuid.Nil)
		s.scheduleWhiteboardCheckpoint(&whiteboardRealtimePrincipal{
			AccountID: accountID, BoardID: boardID, UserID: &actorID,
			Actor: whiteboardcore.RealtimeActor{Kind: "user", ID: uuid.New(), UserID: &actorID, DisplayName: "Usuario de Clarin", Access: domain.WhiteboardAccessEdit},
		})
	}
	return c.JSON(fiber.Map{"success": true, "result": result, "rebased": rebased})
}

func (s *Server) handleListWhiteboardOperations(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	after, parseErr := strconv.ParseInt(c.Query("after_sequence", "0"), 10, 64)
	if parseErr != nil || after < 0 {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	items, err := s.repos.Whiteboard.ListOperationsAfter(c.Context(), accountID, actorID, boardID, after, whiteboardLimit(c))
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "operations": items})
}

func (s *Server) handleListWhiteboardRevisions(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	var before *int64
	if raw := strings.TrimSpace(c.Query("before_sequence")); raw != "" {
		value, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || value < 0 {
			return whiteboardError(c, repository.ErrWhiteboardInvalid)
		}
		before = &value
	}
	items, hasMore, err := s.repos.Whiteboard.ListRevisions(c.Context(), accountID, actorID, boardID, before, whiteboardLimit(c))
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "revisions": items, "has_more": hasMore})
}

func (s *Server) handleCreateWhiteboardRevision(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		ExpectedSequence int64     `json:"expected_sequence"`
		OperationID      uuid.UUID `json:"operation_id"`
	}
	if err := c.BodyParser(&request); err != nil || request.ExpectedSequence < 0 || request.OperationID == uuid.Nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	requestPayload, _ := json.Marshal(struct {
		ExpectedSequence int64  `json:"expected_sequence"`
		RevisionKind     string `json:"revision_kind"`
	}{ExpectedSequence: request.ExpectedSequence, RevisionKind: "manual"})
	requestHash, err := service.HashWhiteboardOperationPayload(requestPayload)
	if err != nil {
		return whiteboardError(c, err)
	}
	if existing, found, findErr := s.repos.Whiteboard.FindSceneOperation(c.Context(), accountID, actorID, boardID, request.OperationID, requestHash); findErr != nil {
		return whiteboardError(c, findErr)
	} else if found {
		return c.JSON(fiber.Map{"success": true, "result": existing})
	}
	scene, err := s.repos.Whiteboard.GetScene(c.Context(), accountID, actorID, boardID, domain.WhiteboardAccessEdit)
	if err != nil {
		return whiteboardError(c, err)
	}
	if scene.Sequence != request.ExpectedSequence {
		return whiteboardError(c, &repository.WhiteboardConflictError{CurrentSequence: scene.Sequence})
	}
	prepared, err := s.prepareAndUploadWhiteboardSnapshot(c.Context(), accountID, boardID, request.OperationID, scene.Scene)
	if err != nil {
		return whiteboardError(c, err)
	}
	result, err := s.repos.Whiteboard.UpdateScene(c.Context(), accountID, actorID, boardID, repository.WhiteboardSceneWriteInput{
		ExpectedSequence: scene.Sequence, OperationID: request.OperationID, Scene: scene.Scene,
		SceneSchemaVersion: scene.SceneSchemaVersion, EditorVersion: scene.EditorVersion,
		WriteKind: "snapshot", RevisionKind: "manual", ResultSceneHash: prepared.SceneHash,
		RequestPayloadHash: requestHash,
		SnapshotObjectKey:  prepared.ObjectKey, SnapshotContentHash: prepared.ContentHash,
		SnapshotSizeBytes: prepared.SizeBytes,
	})
	if err != nil {
		if prepared.UploadedByRequest {
			_ = s.repos.Whiteboard.MarkRevisionSnapshotFailed(c.Context(), accountID, prepared.ObjectKey, "manual revision failed")
		}
		return whiteboardError(c, err)
	}
	s.broadcastWhiteboardMessage(accountID, boardID, whiteboardSceneSnapshotMessage(result.Scene), uuid.Nil)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "result": result})
}

func (s *Server) handleGetWhiteboardRevision(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	revisionID, err := whiteboardPathID(c, "revisionId")
	if err != nil {
		return whiteboardError(c, err)
	}
	revision, err := s.repos.Whiteboard.GetRevision(c.Context(), accountID, actorID, boardID, revisionID)
	if err != nil {
		return whiteboardError(c, err)
	}
	compressed, err := s.storage.GetFile(c.Context(), revision.SnapshotObjectKey)
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardNotFound)
	}
	scene, err := service.DecodeWhiteboardSnapshot(compressed, revision.SnapshotContentHash)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "revision": revision, "scene": json.RawMessage(scene)})
}

func (s *Server) handleRestoreWhiteboardRevision(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	if _, err := s.repos.Whiteboard.RequireAccess(c.Context(), accountID, actorID, boardID, domain.WhiteboardAccessEdit); err != nil {
		return whiteboardError(c, err)
	}
	revisionID, err := whiteboardPathID(c, "revisionId")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		ExpectedSequence int64     `json:"expected_sequence"`
		OperationID      uuid.UUID `json:"operation_id"`
	}
	if err := c.BodyParser(&request); err != nil || request.ExpectedSequence < 0 || request.OperationID == uuid.Nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	revision, err := s.repos.Whiteboard.GetRevision(c.Context(), accountID, actorID, boardID, revisionID)
	if err != nil {
		return whiteboardError(c, err)
	}
	if s.storage == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "Storage no está configurado", "code": "storage_unavailable"})
	}
	compressed, err := s.storage.GetFile(c.Context(), revision.SnapshotObjectKey)
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardNotFound)
	}
	scene, err := service.DecodeWhiteboardSnapshot(compressed, revision.SnapshotContentHash)
	if err != nil {
		return whiteboardError(c, err)
	}
	prepared, err := s.prepareAndUploadWhiteboardSnapshot(c.Context(), accountID, boardID, request.OperationID, scene)
	if err != nil {
		return whiteboardError(c, err)
	}
	result, err := s.repos.Whiteboard.UpdateScene(c.Context(), accountID, actorID, boardID, repository.WhiteboardSceneWriteInput{
		ExpectedSequence: request.ExpectedSequence, OperationID: request.OperationID, Scene: scene,
		SceneSchemaVersion: revision.SceneSchemaVersion, EditorVersion: revision.EditorVersion, WriteKind: "restore", RevisionKind: "manual",
		SourceRevisionID: &revision.ID,
		ResultSceneHash:  prepared.SceneHash, SnapshotObjectKey: prepared.ObjectKey,
		SnapshotContentHash: prepared.ContentHash, SnapshotSizeBytes: prepared.SizeBytes,
	})
	if err != nil {
		if prepared.UploadedByRequest {
			_ = s.repos.Whiteboard.MarkRevisionSnapshotFailed(c.Context(), accountID, prepared.ObjectKey, "revision restore failed")
		}
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "result": result})
}
