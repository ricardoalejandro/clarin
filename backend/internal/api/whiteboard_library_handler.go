package api

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

var emptyWhiteboardLibrary = json.RawMessage(`{"libraryItems":[]}`)

func (s *Server) handleListWhiteboardLibraries(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	beforeTime, beforeID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListLibraries(c.Context(), accountID, actorID, repository.WhiteboardLibraryListOptions{
		Query: c.Query("q"), IncludeArchived: c.QueryBool("include_archived", false),
		BeforeUpdatedAt: beforeTime, BeforeID: beforeID, Limit: whiteboardLimit(c),
	})
	if err != nil {
		return whiteboardError(c, err)
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardBoardCursor(last.UpdatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "libraries": items, "next_cursor": nextCursor})
}

func parseWhiteboardLibraryInput(c *fiber.Ctx) (repository.WhiteboardLibraryInput, error) {
	var request struct {
		Name            string          `json:"name"`
		Description     string          `json:"description"`
		LibraryJSON     json.RawMessage `json:"library_json"`
		Visibility      string          `json:"visibility"`
		ExpectedVersion int64           `json:"expected_version"`
	}
	if err := c.BodyParser(&request); err != nil {
		return repository.WhiteboardLibraryInput{}, repository.ErrWhiteboardInvalid
	}
	name, err := service.NormalizeWhiteboardName(request.Name, 160)
	if err != nil {
		return repository.WhiteboardLibraryInput{}, err
	}
	if len(request.LibraryJSON) == 0 {
		request.LibraryJSON = emptyWhiteboardLibrary
	}
	libraryJSON, err := service.ValidateWhiteboardLibrary(request.LibraryJSON)
	if err != nil {
		return repository.WhiteboardLibraryInput{}, err
	}
	visibility := strings.ToLower(strings.TrimSpace(request.Visibility))
	if visibility == "" {
		visibility = domain.WhiteboardAccessAccount
	}
	if visibility != domain.WhiteboardAccessPrivate && visibility != domain.WhiteboardAccessAccount {
		return repository.WhiteboardLibraryInput{}, repository.ErrWhiteboardInvalid
	}
	description := strings.TrimSpace(request.Description)
	if !utf8.ValidString(description) || utf8.RuneCountInString(description) > whiteboardcore.MaxLibraryDescriptionRunes {
		return repository.WhiteboardLibraryInput{}, repository.ErrWhiteboardInvalid
	}
	return repository.WhiteboardLibraryInput{Name: name, Description: description,
		LibraryJSON: libraryJSON, Visibility: visibility, ExpectedVersion: request.ExpectedVersion}, nil
}

func (s *Server) handleCreateWhiteboardLibrary(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	input, err := parseWhiteboardLibraryInput(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.CreateLibrary(c.Context(), accountID, actorID, input)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "library": item})
}

func (s *Server) handleGetWhiteboardLibrary(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	libraryID, err := whiteboardPathID(c, "libraryId")
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.GetLibrary(c.Context(), accountID, actorID, libraryID)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "library": item})
}

func (s *Server) handleUpdateWhiteboardLibrary(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	libraryID, err := whiteboardPathID(c, "libraryId")
	if err != nil {
		return whiteboardError(c, err)
	}
	input, err := parseWhiteboardLibraryInput(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	item, err := s.repos.Whiteboard.UpdateLibrary(c.Context(), accountID, actorID, libraryID, input)
	if err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "library": item})
}

func (s *Server) handleArchiveWhiteboardLibrary(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	libraryID, err := whiteboardPathID(c, "libraryId")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		ExpectedVersion int64 `json:"expected_version"`
	}
	_ = c.BodyParser(&request)
	if err := s.repos.Whiteboard.ArchiveLibrary(c.Context(), accountID, actorID, libraryID, request.ExpectedVersion); err != nil {
		return whiteboardError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}
