package api

import (
	"io"
	"log"
	"mime"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

type whiteboardAssetUploadOwner struct {
	AccountID      uuid.UUID
	BoardID        uuid.UUID
	ActorID        *uuid.UUID
	GuestTokenHash string
}

func whiteboardAssetWriteError(c *fiber.Ctx, owner whiteboardAssetUploadOwner, phase, code string, err error) error {
	log.Printf("[WHITEBOARD ASSET] account=%s board=%s phase=%s code=%s err=%v",
		owner.AccountID, owner.BoardID, phase, code, err)
	return whiteboardError(c, err)
}

func (s *Server) handleUploadWhiteboardAsset(c *fiber.Ctx) error {
	if s.storage == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "Storage no está configurado", "code": "storage_unavailable"})
	}
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
	return s.storeWhiteboardAsset(c, whiteboardAssetUploadOwner{AccountID: accountID, BoardID: boardID, ActorID: &actorID})
}

func (s *Server) storeWhiteboardAsset(c *fiber.Ctx, owner whiteboardAssetUploadOwner) error {
	fileID := strings.TrimSpace(c.FormValue("file_id"))
	kind := strings.ToLower(strings.TrimSpace(c.FormValue("kind")))
	if kind == "" {
		kind = "asset"
	}
	if kind == "thumbnail" && fileID == "" {
		fileID = "thumbnail"
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
	objectKey, err := whiteboardcore.AssetObjectKey(owner.AccountID, owner.BoardID, fileID, normalized)
	if err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	contentHash := domain.MediaAssetHashWhiteboardPrefix + normalized.Hash
	filename := strings.TrimSpace(filepath.Base(header.Filename))
	if filename == "" || filename == "." {
		filename = fileID + normalized.Extension
	}
	asset, uploadRequired, err := s.repos.Whiteboard.ReserveWhiteboardAsset(c.Context(), repository.MediaAssetUpsert{
		AccountID: owner.AccountID, ContentHash: contentHash, ObjectKey: objectKey, MediaType: "image",
		ContentType: normalized.ContentType, Filename: filename, SizeBytes: normalized.Size,
	})
	if err != nil {
		return whiteboardAssetWriteError(c, owner, "reserve", whiteboardWriteFailureCode(err), err)
	}
	if uploadRequired {
		if _, err := s.storage.UploadObject(c.Context(), asset.ObjectKey, data, normalized.ContentType); err != nil {
			_ = s.repos.Whiteboard.MarkWhiteboardAssetUploadFailed(c.Context(), owner.AccountID, asset.ID, "storage upload failed")
			log.Printf("[WHITEBOARD ASSET] account=%s board=%s phase=upload code=whiteboard_asset_storage_failed err=%v",
				owner.AccountID, owner.BoardID, err)
			return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "error": "No se pudo guardar el recurso", "code": "whiteboard_asset_storage_failed"})
		}
	}
	var link *domain.WhiteboardAsset
	if owner.ActorID != nil {
		link, err = s.repos.Whiteboard.AttachBoardAsset(c.Context(), owner.AccountID, *owner.ActorID, owner.BoardID, asset.ID, fileID, kind, nil)
	} else {
		link, _, err = s.repos.Whiteboard.AttachBoardAssetAsGuest(c.Context(), owner.GuestTokenHash, asset.ID, fileID, kind, time.Now().UTC())
	}
	if err != nil {
		if uploadRequired {
			_ = s.repos.Whiteboard.MarkWhiteboardAssetUploadFailed(c.Context(), owner.AccountID, asset.ID, "asset attachment failed")
		}
		return whiteboardAssetWriteError(c, owner, "attach", whiteboardWriteFailureCode(err), err)
	}
	if owner.ActorID == nil {
		return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "asset": whiteboardGuestAssetDTO(link), "deduped": !uploadRequired})
	}
	response := fiber.Map{"success": true, "asset": link, "deduped": !uploadRequired}
	if kind == "thumbnail" {
		// Replacing the thumbnail advances the board version in the same transaction.
		// Return that canonical row so clients never issue their next optimistic write
		// with the stale version they held before the upload.
		board, boardErr := s.repos.Whiteboard.GetBoard(c.Context(), owner.AccountID, *owner.ActorID, owner.BoardID)
		if boardErr != nil {
			return whiteboardAssetWriteError(c, owner, "readback", whiteboardWriteFailureCode(boardErr), boardErr)
		}
		response["whiteboard"] = board
		response["board_version"] = board.Version
		response["thumbnail_url"] = board.ThumbnailURL
	}
	return c.Status(fiber.StatusCreated).JSON(response)
}

func (s *Server) handleUploadWhiteboardGuestAsset(c *fiber.Ctx) error {
	if s.storage == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "Storage no está configurado", "code": "storage_unavailable"})
	}
	expectedLinkID, err := whiteboardGuestExpectedLinkID(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	secret, err := whiteboardGuestSecret(c, expectedLinkID)
	if err != nil {
		return whiteboardError(c, err)
	}
	tokenHash := service.HashWhiteboardSecret(secret)
	guest, err := s.repos.Whiteboard.ResolveGuestSession(c.Context(), tokenHash, domain.WhiteboardAccessEdit, time.Now().UTC())
	if err != nil || guest.Session.ShareLinkID != expectedLinkID {
		return whiteboardError(c, repository.ErrWhiteboardSessionUnavailable)
	}
	return s.storeWhiteboardAsset(c, whiteboardAssetUploadOwner{
		AccountID: guest.Session.AccountID, BoardID: guest.Session.BoardID, GuestTokenHash: tokenHash,
	})
}

func (s *Server) handleListWhiteboardAssets(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	afterCreatedAt, afterID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListBoardAssets(c.Context(), accountID, actorID, boardID,
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

func (s *Server) handleListWhiteboardGuestAssets(c *fiber.Ctx) error {
	expectedLinkID, err := whiteboardGuestExpectedLinkID(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	secret, err := whiteboardGuestSecret(c, expectedLinkID)
	if err != nil {
		return whiteboardError(c, err)
	}
	afterCreatedAt, afterID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, guest, err := s.repos.Whiteboard.ListBoardAssetsAsGuest(c.Context(), service.HashWhiteboardSecret(secret),
		repository.WhiteboardAssetListOptions{AfterCreatedAt: afterCreatedAt, AfterID: afterID, Limit: whiteboardLimit(c), ReferencedOnly: c.QueryBool("referenced_only", false)}, time.Now().UTC())
	if err != nil || guest.Session.ShareLinkID != expectedLinkID {
		return whiteboardError(c, repository.ErrWhiteboardSessionUnavailable)
	}
	publicItems := make([]fiber.Map, 0, len(items))
	for _, item := range items {
		publicItems = append(publicItems, whiteboardGuestAssetDTO(item))
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardBoardCursor(last.CreatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "assets": publicItems, "next_cursor": nextCursor})
}

func whiteboardGuestAssetDTO(item *domain.WhiteboardAsset) fiber.Map {
	return fiber.Map{
		"id": item.ID, "file_id": item.FileID, "kind": item.Kind, "filename": item.Filename,
		"content_type": item.ContentType, "media_type": item.MediaType, "size_bytes": item.SizeBytes,
		"created_at": item.CreatedAt,
	}
}

func (s *Server) handleDownloadWhiteboardAsset(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	assetID, err := whiteboardPathID(c, "assetId")
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.ResolveBoardAssetDownload(c.Context(), accountID, actorID, boardID, assetID)
	if err != nil {
		return whiteboardError(c, err)
	}
	return serveWhiteboardAsset(c, s, item)
}

func (s *Server) handleListWhiteboardRevisionAssets(c *fiber.Ctx) error {
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
	afterCreatedAt, afterID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListRevisionAssets(c.Context(), accountID, actorID, boardID, revisionID,
		repository.WhiteboardRevisionAssetListOptions{AfterCreatedAt: afterCreatedAt, AfterID: afterID, Limit: whiteboardLimit(c)})
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

func (s *Server) handleDownloadWhiteboardRevisionAsset(c *fiber.Ctx) error {
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
	assetID, err := whiteboardPathID(c, "assetId")
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.ResolveRevisionAssetDownload(c.Context(), accountID, actorID, boardID, revisionID, assetID)
	if err != nil {
		return whiteboardError(c, err)
	}
	return serveWhiteboardAsset(c, s, item)
}

func serveWhiteboardAsset(c *fiber.Ctx, s *Server, item *repository.WhiteboardAssetDownload) error {
	c.Set(fiber.HeaderContentType, item.ContentType)
	if disposition := mime.FormatMediaType("inline", map[string]string{"filename": item.Filename}); disposition != "" {
		c.Set(fiber.HeaderContentDisposition, disposition)
	}
	c.Set(fiber.HeaderXContentTypeOptions, "nosniff")
	return s.serveStorageObject(c, item.ObjectKey, "private, no-store, max-age=0")
}

func (s *Server) handleDownloadWhiteboardGuestAsset(c *fiber.Ctx) error {
	expectedLinkID, err := whiteboardGuestExpectedLinkID(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	secret, err := whiteboardGuestSecret(c, expectedLinkID)
	if err != nil {
		return whiteboardError(c, err)
	}
	guest, err := s.repos.Whiteboard.ResolveGuestSession(c.Context(), service.HashWhiteboardSecret(secret), domain.WhiteboardAccessView, time.Now().UTC())
	if err != nil || guest.Session.ShareLinkID != expectedLinkID {
		return whiteboardError(c, repository.ErrWhiteboardSessionUnavailable)
	}
	assetID, err := whiteboardPathID(c, "assetId")
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.ResolveBoardAssetDownloadAsGuest(c.Context(), service.HashWhiteboardSecret(secret), assetID, time.Now().UTC())
	if err != nil {
		return whiteboardError(c, err)
	}
	return serveWhiteboardAsset(c, s, item)
}

func (s *Server) handleDeleteWhiteboardAsset(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	assetID, err := whiteboardPathID(c, "assetId")
	if err != nil {
		return whiteboardError(c, err)
	}
	if err := s.repos.Whiteboard.DeleteBoardAsset(c.Context(), accountID, actorID, boardID, assetID); err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}
