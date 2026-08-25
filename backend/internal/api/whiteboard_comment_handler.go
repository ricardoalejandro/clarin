package api

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

const whiteboardCommentMutationMaxRequestBytes = 16 * 1024

func (s *Server) guardWhiteboardCommentMutation(c *fiber.Ctx) error {
	if rejected, err := rejectWhiteboardEncodedRequest(c); rejected {
		return err
	}
	if !whiteboardRequestWithinLimit(c, whiteboardCommentMutationMaxRequestBytes) {
		return whiteboardRequestTooLarge(c, "whiteboard_comment_payload_too_large", whiteboardCommentMutationMaxRequestBytes)
	}
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	if err := s.checkAbuseLimits(c, "whiteboard_comment_rate_limited", actorID.String(), []abuseLimit{
		{Key: "abuse:whiteboard-comment:actor-board:minute:" + accountID.String() + ":" + actorID.String() + ":" + boardID.String(), Max: 60, Window: time.Minute},
		{Key: "abuse:whiteboard-comment:actor:hour:" + accountID.String() + ":" + actorID.String(), Max: 600, Window: time.Hour},
		{Key: "abuse:whiteboard-comment:ip-board:minute:" + hashForLog(clientIP(c)) + ":" + boardID.String(), Max: 120, Window: time.Minute},
	}); err != nil {
		return err
	}
	return c.Next()
}

func (s *Server) handleListWhiteboardCommentThreads(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	beforeTime, beforeID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListWhiteboardCommentThreads(c.Context(), accountID, actorID, boardID,
		repository.WhiteboardCommentThreadListOptions{Status: c.Query("status", domain.WhiteboardCommentOpen),
			BeforeUpdatedAt: beforeTime, BeforeID: beforeID, Limit: whiteboardLimit(c)})
	if err != nil {
		return whiteboardError(c, err)
	}
	counts, err := s.repos.Whiteboard.GetWhiteboardCommentThreadCounts(c.Context(), accountID, actorID, boardID)
	if err != nil {
		return whiteboardError(c, err)
	}
	for _, thread := range items {
		if thread.CommentsHasMore && len(thread.Comments) > 0 {
			last := thread.Comments[len(thread.Comments)-1]
			thread.CommentsNextCursor = service.EncodeWhiteboardBoardCursor(last.CreatedAt, last.ID)
		}
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardBoardCursor(last.UpdatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "threads": items, "next_cursor": nextCursor, "counts": counts})
}

func (s *Server) handleListWhiteboardCommentMarkers(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	beforeTime, beforeID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListWhiteboardCommentMarkers(c.Context(), accountID, actorID, boardID,
		repository.WhiteboardCommentMarkerListOptions{BeforeUpdatedAt: beforeTime, BeforeID: beforeID, Limit: whiteboardLimit(c)})
	if err != nil {
		return whiteboardError(c, err)
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardBoardCursor(last.UpdatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "markers": items, "next_cursor": nextCursor})
}

func (s *Server) handleGetWhiteboardCommentThread(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	threadID, err := whiteboardPathID(c, "threadId")
	if err != nil {
		return whiteboardError(c, err)
	}
	thread, err := s.repos.Whiteboard.GetWhiteboardCommentThread(c.Context(), accountID, actorID, boardID, threadID)
	if err != nil {
		return whiteboardError(c, err)
	}
	if thread.CommentsHasMore && len(thread.Comments) > 0 {
		last := thread.Comments[len(thread.Comments)-1]
		thread.CommentsNextCursor = service.EncodeWhiteboardBoardCursor(last.CreatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "thread": thread})
}

func (s *Server) handleListWhiteboardThreadComments(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	threadID, err := whiteboardPathID(c, "threadId")
	if err != nil {
		return whiteboardError(c, err)
	}
	afterTime, afterID, err := service.DecodeWhiteboardBoardCursor(c.Query("cursor"))
	if err != nil {
		return whiteboardError(c, err)
	}
	items, hasMore, err := s.repos.Whiteboard.ListWhiteboardThreadComments(c.Context(), accountID, actorID, boardID, threadID,
		repository.WhiteboardCommentListOptions{AfterCreatedAt: afterTime, AfterID: afterID, Limit: whiteboardLimit(c)})
	if err != nil {
		return whiteboardError(c, err)
	}
	nextCursor := ""
	if hasMore && len(items) > 0 {
		last := items[len(items)-1]
		nextCursor = service.EncodeWhiteboardBoardCursor(last.CreatedAt, last.ID)
	}
	return c.JSON(fiber.Map{"success": true, "comments": items, "next_cursor": nextCursor})
}

func (s *Server) broadcastWhiteboardComment(accountID, boardID uuid.UUID, action string, thread *domain.WhiteboardCommentThread) {
	if thread == nil {
		return
	}
	s.broadcastWhiteboardMemberMessage(accountID, boardID, whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventCommentChanged,
		Data:  fiber.Map{"board_id": boardID, "action": action, "thread": thread},
	}, uuid.Nil)
}

func (s *Server) handleCreateWhiteboardCommentThread(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		OperationID  uuid.UUID `json:"operation_id"`
		ElementID    *string   `json:"element_id"`
		AnchorX      float64   `json:"anchor_x"`
		AnchorY      float64   `json:"anchor_y"`
		AnchorRatioX *float64  `json:"anchor_ratio_x"`
		AnchorRatioY *float64  `json:"anchor_ratio_y"`
		Body         string    `json:"body"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	thread, err := s.repos.Whiteboard.CreateWhiteboardCommentThread(c.Context(), accountID, actorID, boardID,
		repository.WhiteboardCommentThreadCreateInput{OperationID: request.OperationID, ElementID: request.ElementID,
			AnchorX: request.AnchorX, AnchorY: request.AnchorY, AnchorRatioX: request.AnchorRatioX,
			AnchorRatioY: request.AnchorRatioY, Body: request.Body})
	if err != nil {
		return whiteboardError(c, err)
	}
	s.broadcastWhiteboardComment(accountID, boardID, "created", thread)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "thread": thread})
}

func (s *Server) handleReplyWhiteboardCommentThread(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	threadID, err := whiteboardPathID(c, "threadId")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		OperationID uuid.UUID `json:"operation_id"`
		Body        string    `json:"body"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	thread, err := s.repos.Whiteboard.AddWhiteboardCommentReply(c.Context(), accountID, actorID, boardID, threadID,
		repository.WhiteboardCommentReplyInput{OperationID: request.OperationID, Body: request.Body})
	if err != nil {
		return whiteboardError(c, err)
	}
	s.broadcastWhiteboardComment(accountID, boardID, "replied", thread)
	return c.JSON(fiber.Map{"success": true, "thread": thread})
}

func (s *Server) handleEditWhiteboardComment(c *fiber.Ctx) error {
	accountID, actorID, boardID, threadID, commentID, err := whiteboardCommentMutationActor(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		OperationID     uuid.UUID `json:"operation_id"`
		ExpectedVersion int64     `json:"expected_version"`
		Body            string    `json:"body"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	thread, err := s.repos.Whiteboard.EditWhiteboardComment(c.Context(), accountID, actorID, boardID, threadID, commentID,
		repository.WhiteboardCommentEditInput{OperationID: request.OperationID, ExpectedVersion: request.ExpectedVersion, Body: request.Body})
	if err != nil {
		return whiteboardError(c, err)
	}
	s.broadcastWhiteboardComment(accountID, boardID, "edited", thread)
	return c.JSON(fiber.Map{"success": true, "thread": thread})
}

func (s *Server) handleDeleteWhiteboardComment(c *fiber.Ctx) error {
	accountID, actorID, boardID, threadID, commentID, err := whiteboardCommentMutationActor(c)
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		OperationID     uuid.UUID `json:"operation_id"`
		ExpectedVersion int64     `json:"expected_version"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	thread, err := s.repos.Whiteboard.DeleteWhiteboardComment(c.Context(), accountID, actorID, boardID, threadID, commentID,
		repository.WhiteboardCommentDeleteInput{OperationID: request.OperationID, ExpectedVersion: request.ExpectedVersion})
	if err != nil {
		return whiteboardError(c, err)
	}
	s.broadcastWhiteboardComment(accountID, boardID, "deleted", thread)
	return c.JSON(fiber.Map{"success": true, "thread": thread})
}

func whiteboardCommentMutationActor(c *fiber.Ctx) (uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, error) {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, uuid.Nil, uuid.Nil, err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, uuid.Nil, uuid.Nil, err
	}
	threadID, err := whiteboardPathID(c, "threadId")
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, uuid.Nil, uuid.Nil, err
	}
	commentID, err := whiteboardPathID(c, "commentId")
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, uuid.Nil, uuid.Nil, err
	}
	return accountID, actorID, boardID, threadID, commentID, nil
}

func (s *Server) handleUpdateWhiteboardCommentThreadStatus(c *fiber.Ctx) error {
	accountID, actorID, err := whiteboardActor(c)
	if err != nil {
		return err
	}
	boardID, err := whiteboardPathID(c, "id")
	if err != nil {
		return whiteboardError(c, err)
	}
	threadID, err := whiteboardPathID(c, "threadId")
	if err != nil {
		return whiteboardError(c, err)
	}
	var request struct {
		OperationID     uuid.UUID `json:"operation_id"`
		ExpectedVersion int64     `json:"expected_version"`
		Status          string    `json:"status"`
	}
	if err := c.BodyParser(&request); err != nil {
		return whiteboardError(c, repository.ErrWhiteboardInvalid)
	}
	request.Status = strings.ToLower(strings.TrimSpace(request.Status))
	thread, err := s.repos.Whiteboard.UpdateWhiteboardCommentThreadStatus(c.Context(), accountID, actorID, boardID, threadID,
		repository.WhiteboardCommentStatusInput{OperationID: request.OperationID, ExpectedVersion: request.ExpectedVersion, Status: request.Status})
	if err != nil {
		return whiteboardError(c, err)
	}
	action := "resolved"
	if request.Status == domain.WhiteboardCommentOpen {
		action = "reopened"
	}
	s.broadcastWhiteboardComment(accountID, boardID, action, thread)
	return c.JSON(fiber.Map{"success": true, "thread": thread})
}
