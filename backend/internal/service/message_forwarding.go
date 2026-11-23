package service

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func (s *ChatService) NewWhatsAppMessageID(deviceID uuid.UUID) (string, error) {
	if err := s.ensureWhatsAppWebOutbound(context.Background(), deviceID); err != nil {
		return "", err
	}
	return s.pool.NewWhatsAppMessageID(deviceID)
}

func (s *ChatService) ForwardMessageWithID(ctx context.Context, deviceID uuid.UUID, to string, source *domain.Message, providerID string) (*domain.Message, error) {
	return s.ShareMessageWithID(ctx, deviceID, to, source, providerID, domain.MessageSharingNative, domain.MessageContentOriginal)
}

func (s *ChatService) ShareMessageWithID(ctx context.Context, deviceID uuid.UUID, to string, source *domain.Message, providerID, mode, variant string) (*domain.Message, error) {
	if err := s.ensureWhatsAppWebOutbound(ctx, deviceID); err != nil {
		return nil, &domain.ForwardSendError{Code: "device_unavailable", Err: err}
	}
	return s.pool.ShareMessageWithID(ctx, deviceID, to, source, providerID, mode, variant)
}
