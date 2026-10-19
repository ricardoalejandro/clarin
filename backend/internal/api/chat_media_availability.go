package api

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

const chatMediaAvailabilityBatchSize = 200

type deletedChatMediaLookup func(context.Context, uuid.UUID, []string) (map[string]bool, error)

// Project availability without repairing historical message rows or probing S3.
// Unknown inventory/remote URLs stay unchanged; only explicit same-account
// deletion facts remove a URL from this response.
func projectChatMediaAvailability(ctx context.Context, accountID uuid.UUID, messages []*domain.Message, resolve func(string) (string, bool), lookup deletedChatMediaLookup) error {
	byKey := make(map[string][]*domain.Message)
	keys := make([]string, 0)
	for _, message := range messages {
		if message == nil || message.AccountID != accountID {
			continue
		}
		if message.MediaDeleted {
			message.MediaURL = nil
			continue
		}
		if message.MediaURL == nil {
			continue
		}
		key, ok := resolve(*message.MediaURL)
		owner, valid := ordinaryMediaKeyAccount(key)
		if !ok || !valid || owner != accountID {
			continue
		}
		if _, exists := byKey[key]; !exists {
			keys = append(keys, key)
		}
		byKey[key] = append(byKey[key], message)
	}
	// Apply only after every bounded lookup succeeds, so failures cannot expose
	// a partially projected response.
	deleted := make(map[string]bool)
	for start := 0; start < len(keys); start += chatMediaAvailabilityBatchSize {
		end := start + chatMediaAvailabilityBatchSize
		if end > len(keys) {
			end = len(keys)
		}
		batch, err := lookup(ctx, accountID, keys[start:end])
		if err != nil {
			return err
		}
		for key, value := range batch {
			if value {
				deleted[key] = true
			}
		}
	}
	for key := range deleted {
		for _, message := range byKey[key] {
			message.MediaDeleted = true
			message.MediaURL = nil
		}
	}
	return nil
}

func (s *Server) projectChatMedia(ctx context.Context, accountID uuid.UUID, messages []*domain.Message) error {
	return projectChatMediaAvailability(ctx, accountID, messages, s.ordinaryObjectKeyFromURL, s.repos.Message.DeletedMediaKeys)
}

// Cached history still rechecks explicit deletion facts. Other response fields
// remain raw JSON so pagination/contract additions survive this projection.
func (s *Server) projectCachedChatMedia(ctx context.Context, accountID uuid.UUID, cached []byte) ([]byte, error) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(cached, &envelope); err != nil {
		return nil, err
	}
	var messages []*domain.Message
	if err := json.Unmarshal(envelope["messages"], &messages); err != nil {
		return nil, err
	}
	// Older cache entries may contain null for a valid empty history. Keep the
	// collection contract identical to a fresh empty page.
	if messages == nil {
		messages = []*domain.Message{}
	}
	if err := s.projectChatMedia(ctx, accountID, messages); err != nil {
		return nil, err
	}
	if s.repos != nil && s.repos.Message != nil {
		byChat := make(map[uuid.UUID][]*domain.Message)
		for _, message := range messages {
			if message != nil && message.AccountID == accountID {
				byChat[message.ChatID] = append(byChat[message.ChatID], message)
			}
		}
		for chatID, group := range byChat {
			if err := s.repos.Message.HydrateLinkPreviews(ctx, accountID, chatID, group); err != nil {
				return nil, err
			}
		}
	}
	raw, err := json.Marshal(messages)
	if err != nil {
		return nil, err
	}
	envelope["messages"] = raw
	return json.Marshal(envelope)
}
