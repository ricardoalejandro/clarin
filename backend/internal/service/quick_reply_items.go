package service

import (
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"strings"
)

func prepareQuickReplyItems(reply *domain.QuickReply) error {
	if reply.Items == nil {
		return nil
	} // legacy requests retain their existing interpretation
	if len(reply.Items) == 0 || len(reply.Items) > 20 {
		return ErrQuickReplyValidation
	}
	attachments := make(map[uuid.UUID]bool, len(reply.Attachments))
	for _, att := range reply.Attachments {
		if att.ID == uuid.Nil {
			return ErrQuickReplyValidation
		}
		attachments[att.ID] = true
	}
	seen := map[uuid.UUID]bool{}
	used := map[uuid.UUID]bool{}
	texts := []string{}
	for i := range reply.Items {
		item := &reply.Items[i]
		if item.ID == uuid.Nil || seen[item.ID] {
			return ErrQuickReplyValidation
		}
		seen[item.ID] = true
		switch item.Type {
		case "text":
			item.Text = strings.TrimSpace(item.Text)
			if item.Text == "" || len(item.Text) > 65536 || item.AttachmentID != nil {
				return ErrQuickReplyValidation
			}
			texts = append(texts, item.Text)
		case "media":
			if item.AttachmentID == nil || !attachments[*item.AttachmentID] || used[*item.AttachmentID] || item.Text != "" {
				return ErrQuickReplyValidation
			}
			used[*item.AttachmentID] = true
		default:
			return ErrQuickReplyValidation
		}
	}
	if len(used) != len(attachments) {
		return ErrQuickReplyValidation
	}
	reply.Body = strings.Join(texts, "\n\n") // searchable compatibility projection, never an extra send
	return nil
}
