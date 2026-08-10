package api

import (
	"io"
	"path/filepath"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

func (s *Server) handleUploadWhiteboardLibraryAsset(c *fiber.Ctx) error {
	if s.storage == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "Storage no está configurado", "code": "storage_unavailable"})
	}
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	libraryID, err := whiteboardPathID(c, "libraryId")
	if err != nil {
		return whiteboardError(c, err)
	}
	if err := s.repos.Whiteboard.RequireLibraryAccess(c.Context(), accountID, actorID, libraryID, domain.WhiteboardAccessEdit); err != nil {
		return whiteboardError(c, err)
	}
	library, err := s.repos.Whiteboard.GetLibrary(c.Context(), accountID, actorID, libraryID)
	if err != nil {
		return whiteboardError(c, err)
	}
	if library.ArchivedAt != nil {
		return whiteboardError(c, repository.ErrWhiteboardConflict)
	}
	fileID := strings.TrimSpace(c.FormValue("file_id"))
	if !whiteboardcore.ValidAssetFileID(fileID) {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	header, err := c.FormFile("file")
	if err != nil || header.Size <= 0 || header.Size > whiteboardcore.MaxAssetBytes {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{"success": false, "error": "El recurso supera el máximo de 10 MB", "code": "whiteboard_asset_too_large"})
	}
	source, err := header.Open()
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	defer source.Close()
	data, err := io.ReadAll(io.LimitReader(source, whiteboardcore.MaxAssetBytes+1))
	if err != nil || int64(len(data)) > whiteboardcore.MaxAssetBytes {
		return c.Status(fiber.StatusRequestEntityTooLarge).JSON(fiber.Map{"success": false, "error": "El recurso supera el máximo de 10 MB", "code": "whiteboard_asset_too_large"})
	}
	normalized, err := whiteboardcore.NormalizeAsset(header.Header.Get("Content-Type"), data)
	if err != nil {
		return c.Status(fiber.StatusUnsupportedMediaType).JSON(fiber.Map{"success": false, "error": "Usa PNG, JPEG, WebP o GIF", "code": "invalid_whiteboard_asset"})
	}
	objectKey, err := whiteboardcore.LibraryAssetObjectKey(accountID, libraryID, fileID, normalized)
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	filename := strings.TrimSpace(filepath.Base(header.Filename))
	if filename == "" || filename == "." {
		filename = fileID + normalized.Extension
	}
	// Scope deduplication to this library. That guarantees every newly stored
	// library object remains below /whiteboards/libraries/:id while still
	// deduplicating repeated imports and upload retries inside the library.
	contentHash := domain.MediaAssetHashWhiteboardPrefix + "library:" + libraryID.String() + ":" + normalized.Hash
	asset, uploadRequired, err := s.repos.Whiteboard.ReserveWhiteboardAsset(c.Context(), repository.MediaAssetUpsert{
		AccountID: accountID, ContentHash: contentHash, ObjectKey: objectKey, MediaType: "image",
		ContentType: normalized.ContentType, Filename: filename, SizeBytes: normalized.Size,
	})
	if err != nil {
		return whiteboardError(c, err)
	}
	if uploadRequired {
		if _, err := s.storage.UploadObject(c.Context(), asset.ObjectKey, data, normalized.ContentType); err != nil {
			_ = s.repos.Whiteboard.MarkWhiteboardAssetUploadFailed(c.Context(), accountID, asset.ID, "library asset storage upload failed")
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": "No se pudo guardar el recurso", "code": "whiteboard_asset_storage_failed"})
		}
	}
	link, err := s.repos.Whiteboard.AttachLibraryAsset(c.Context(), accountID, actorID, libraryID, asset.ID, fileID)
	if err != nil {
		if uploadRequired {
			_ = s.repos.Whiteboard.MarkWhiteboardAssetUploadFailed(c.Context(), accountID, asset.ID, "library asset attachment failed")
		}
		return whiteboardError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "asset": link, "deduped": !uploadRequired})
}

func (s *Server) handleListWhiteboardLibraryAssets(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	libraryID, err := whiteboardPathID(c, "libraryId")
	if err != nil {
		return whiteboardError(c, err)
	}
	afterCreatedAt, afterID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListLibraryAssets(c.Context(), accountID, actorID, libraryID,
		repository.WhiteboardAssetListOptions{AfterCreatedAt: afterCreatedAt, AfterID: afterID, Limit: whiteboardLimit(c), ReferencedOnly: c.QueryBool("referenced_only", false)})
	if err != nil {
		return whiteboardError(c, err)
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardBoardCursor(last.CreatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "assets": items, "next_cursor": nextCursor})
}

func (s *Server) handleDownloadWhiteboardLibraryAsset(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	libraryID, err := whiteboardPathID(c, "libraryId")
	if err != nil {
		return whiteboardError(c, err)
	}
	assetID, err := whiteboardPathID(c, "assetId")
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.ResolveLibraryAssetDownload(c.Context(), accountID, actorID, libraryID, assetID)
	if err != nil {
		return whiteboardError(c, err)
	}
	return serveWhiteboardAsset(c, s, item)
}

func (s *Server) handleDeleteWhiteboardLibraryAsset(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	libraryID, err := whiteboardPathID(c, "libraryId")
	if err != nil {
		return whiteboardError(c, err)
	}
	assetID, err := whiteboardPathID(c, "assetId")
	if err != nil {
		return whiteboardError(c, err)
	}
	if err := s.repos.Whiteboard.DeleteLibraryAsset(c.Context(), accountID, actorID, libraryID, assetID); err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}
