package api

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
	"log"
	"time"
)

// Keep the existing canonical message event so open conversations reconcile
// their media flags without resetting history, scroll, text or reactions.
func storageSelfServicePublishMessages(accountID uuid.UUID, messages []*domain.Message, publish func(uuid.UUID, string, string, interface{})) {
	for _, message := range messages {
		if message == nil || message.AccountID != accountID || message.ChatID == uuid.Nil || message.ID == uuid.Nil {
			continue
		}
		publish(accountID, domain.PermChats, ws.EventMessageUpdated, map[string]interface{}{"chat_id": message.ChatID.String(), "message": message})
	}
}
func (s *Server) storageSelfServiceReconcileMessages(accountID uuid.UUID, result storageCleanupResult) {
	if s.hub == nil {
		return
	}
	keys := make([]string, 0)
	for _, item := range result.Items {
		if item.Status == "completed" {
			keys = append(keys, item.ObjectKey)
		}
	}
	if len(keys) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	after := uuid.Nil
	for {
		messages, err := s.repos.Message.ListStorageCleanupMessages(ctx, accountID, keys, after)
		if err != nil {
			log.Printf("[StorageSelfService] realtime reconciliation failed account=%s: %v", accountID, err)
			return
		}
		for _, message := range messages {
			if message.MediaURL != nil && s.storage != nil {
				canonical := s.storage.CanonicalMediaURL(*message.MediaURL)
				message.MediaURL = &canonical
			}
		}
		storageSelfServicePublishMessages(accountID, messages, s.hub.BroadcastToAccountWithPermission)
		if len(messages) < 200 {
			return
		}
		after = messages[len(messages)-1].ID
	}
}
