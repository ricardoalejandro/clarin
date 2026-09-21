package service

import (
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"testing"
)

func TestQuickReplySequenceValidation(t *testing.T) {
	attachmentID := uuid.New()
	valid := func() *domain.QuickReply {
		return &domain.QuickReply{Attachments: []domain.QuickReplyAttachment{{ID: attachmentID, Caption: "*Pie*\n😊"}}, Items: []domain.QuickReplyItem{{ID: uuid.New(), Type: "text", Text: "Hola"}, {ID: uuid.New(), Type: "media", AttachmentID: &attachmentID}, {ID: uuid.New(), Type: "text", Text: "Gracias"}}}
	}
	reply := valid()
	if err := prepareQuickReplyItems(reply); err != nil {
		t.Fatal(err)
	}
	if reply.Body != "Hola\n\nGracias" || reply.Attachments[0].Caption != "*Pie*\n😊" {
		t.Fatal("caption was flattened into searchable text")
	}
	for name, corrupt := range map[string]func(*domain.QuickReply){
		"missing media":   func(q *domain.QuickReply) { q.Attachments = nil },
		"unused media":    func(q *domain.QuickReply) { q.Items = q.Items[:1] },
		"duplicate block": func(q *domain.QuickReply) { q.Items = append(q.Items, q.Items[0]) },
		"empty text":      func(q *domain.QuickReply) { q.Items[0].Text = "  " },
		"media with text": func(q *domain.QuickReply) { q.Items[1].Text = "separate caption" },
		"unknown type":    func(q *domain.QuickReply) { q.Items[0].Type = "html" },
	} {
		t.Run(name, func(t *testing.T) {
			q := valid()
			corrupt(q)
			if prepareQuickReplyItems(q) == nil {
				t.Fatal("accepted invalid sequence")
			}
		})
	}
}
