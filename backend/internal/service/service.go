package service

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/whatsapp"
	"github.com/naperu/clarin/internal/ws"
	"golang.org/x/crypto/bcrypt"
)

type Services struct {
	Auth        *AuthService
	Device      *DeviceService
	Chat        *ChatService
	Contact     *ContactService
	Lead        *LeadService
	Pipeline    *PipelineService
	Tag         *TagService
	Campaign    *CampaignService
	Event       *EventService
	Interaction *InteractionService
}

func NewServices(repos *repository.Repositories, pool *whatsapp.DevicePool, hub *ws.Hub) *Services {
	return &Services{
		Auth:        &AuthService{repos: repos},
		Device:      &DeviceService{repos: repos, pool: pool, hub: hub},
		Chat:        &ChatService{repos: repos, pool: pool},
		Contact:     &ContactService{repos: repos, pool: pool},
		Lead:        &LeadService{repos: repos},
		Pipeline:    &PipelineService{repos: repos},
		Tag:         &TagService{repos: repos},
		Campaign:    &CampaignService{repos: repos, pool: pool, hub: hub},
		Event:       &EventService{repos: repos, hub: hub},
		Interaction: &InteractionService{repos: repos, hub: hub},
	}
}

// AuthService handles authentication
type AuthService struct {
	repos *repository.Repositories
}

type JWTClaims struct {
	UserID    uuid.UUID `json:"user_id"`
	AccountID uuid.UUID `json:"account_id"`
	Username  string    `json:"username"`
	IsAdmin   bool      `json:"is_admin"`
	jwt.RegisteredClaims
}

func (s *AuthService) Login(ctx context.Context, username, password, jwtSecret string) (string, *domain.User, error) {
	user, err := s.repos.User.GetByUsername(ctx, username)
	if err != nil {
		return "", nil, fmt.Errorf("failed to get user: %w", err)
	}
	if user == nil {
		return "", nil, fmt.Errorf("invalid credentials")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return "", nil, fmt.Errorf("invalid credentials")
	}

	// Generate JWT
	claims := &JWTClaims{
		UserID:    user.ID,
		AccountID: user.AccountID,
		Username:  user.Username,
		IsAdmin:   user.IsAdmin,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * 7 * time.Hour)), // 7 days
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "clarin",
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString([]byte(jwtSecret))
	if err != nil {
		return "", nil, fmt.Errorf("failed to sign token: %w", err)
	}

	return tokenString, user, nil
}

func (s *AuthService) ValidateToken(tokenString, jwtSecret string) (*JWTClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &JWTClaims{}, func(token *jwt.Token) (interface{}, error) {
		return []byte(jwtSecret), nil
	})
	if err != nil {
		return nil, fmt.Errorf("invalid token: %w", err)
	}

	claims, ok := token.Claims.(*JWTClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}

	return claims, nil
}

func (s *AuthService) GetUser(ctx context.Context, userID uuid.UUID) (*domain.User, error) {
	return s.repos.User.GetByID(ctx, userID)
}

// DeviceService handles WhatsApp devices
type DeviceService struct {
	repos *repository.Repositories
	pool  *whatsapp.DevicePool
	hub   *ws.Hub
}

func (s *DeviceService) Create(ctx context.Context, accountID uuid.UUID, name string) (*domain.Device, error) {
	return s.pool.CreateDevice(ctx, accountID, name)
}

func (s *DeviceService) Connect(ctx context.Context, deviceID uuid.UUID) error {
	return s.pool.ConnectDevice(ctx, deviceID)
}

func (s *DeviceService) Disconnect(ctx context.Context, deviceID uuid.UUID) error {
	return s.pool.DisconnectDevice(ctx, deviceID)
}

func (s *DeviceService) Delete(ctx context.Context, deviceID uuid.UUID) error {
	return s.pool.DeleteDevice(ctx, deviceID)
}

func (s *DeviceService) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Device, error) {
	devices, err := s.repos.Device.GetByAccountID(ctx, accountID)
	if err != nil {
		return nil, err
	}

	// Add live status from pool
	for _, device := range devices {
		status := s.pool.GetDeviceStatus(device.ID)
		device.Status = &status
		qr := s.pool.GetQRCode(device.ID)
		if qr != "" {
			device.QRCode = &qr
		}
	}

	return devices, nil
}

func (s *DeviceService) GetByID(ctx context.Context, deviceID uuid.UUID) (*domain.Device, error) {
	device, err := s.repos.Device.GetByID(ctx, deviceID)
	if err != nil || device == nil {
		return nil, err
	}

	status := s.pool.GetDeviceStatus(device.ID)
	device.Status = &status
	qr := s.pool.GetQRCode(device.ID)
	if qr != "" {
		device.QRCode = &qr
	}

	return device, nil
}

// ChatService handles chat operations
type ChatService struct {
	repos *repository.Repositories
	pool  *whatsapp.DevicePool
}

func (s *ChatService) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Chat, error) {
	return s.repos.Chat.GetByAccountID(ctx, accountID)
}

func (s *ChatService) GetByAccountIDWithFilters(ctx context.Context, accountID uuid.UUID, filter domain.ChatFilter) ([]*domain.Chat, int, error) {
	return s.repos.Chat.GetByAccountIDWithFilters(ctx, accountID, filter)
}

func (s *ChatService) GetByID(ctx context.Context, chatID uuid.UUID) (*domain.Chat, error) {
	return s.repos.Chat.GetByID(ctx, chatID)
}

func (s *ChatService) GetChatDetails(ctx context.Context, chatID uuid.UUID) (*domain.ChatDetails, error) {
	chat, err := s.repos.Chat.GetByID(ctx, chatID)
	if err != nil || chat == nil {
		return nil, err
	}

	details := &domain.ChatDetails{
		Chat: chat,
	}

	// Get contact if exists
	if chat.ContactID != nil {
		// We need to get contact by ID, but for now get by JID
	}
	contact, _ := s.repos.Contact.GetByJID(ctx, chat.AccountID, chat.JID)
	if contact != nil {
		details.Contact = contact
	}

	// Get lead
	lead, _ := s.repos.Lead.GetByJID(ctx, chat.AccountID, chat.JID)
	if lead != nil {
		details.Lead = lead
	}

	return details, nil
}

func (s *ChatService) CreateNewChat(ctx context.Context, accountID, deviceID uuid.UUID, phone string) (*domain.Chat, error) {
	// Normalize phone number to JID
	jid := phone
	if !strings.Contains(phone, "@") {
		// Remove any non-numeric characters except +
		phone = strings.TrimPrefix(phone, "+")
		jid = phone + "@s.whatsapp.net"
	}

	// Create or get existing chat
	chat, err := s.repos.Chat.GetOrCreate(ctx, accountID, deviceID, jid, "")
	if err != nil {
		return nil, err
	}

	return chat, nil
}

func (s *ChatService) GetMessages(ctx context.Context, chatID uuid.UUID, limit, offset int) ([]*domain.Message, error) {
	if limit <= 0 {
		limit = 50
	}
	return s.repos.Message.GetByChatID(ctx, chatID, limit, offset)
}

func (s *ChatService) SendMessage(ctx context.Context, deviceID uuid.UUID, to, body string) (*domain.Message, error) {
	return s.pool.SendMessage(ctx, deviceID, to, body)
}

func (s *ChatService) SendMediaMessage(ctx context.Context, deviceID uuid.UUID, to, caption, mediaURL, mediaType string) (*domain.Message, error) {
	return s.pool.SendMediaMessage(ctx, deviceID, to, caption, mediaURL, mediaType)
}

func (s *ChatService) SendReplyMessage(ctx context.Context, deviceID uuid.UUID, to, body, quotedID, quotedBody, quotedSender string, quotedIsFromMe bool) (*domain.Message, error) {
	return s.pool.SendReplyMessage(ctx, deviceID, to, body, quotedID, quotedBody, quotedSender, quotedIsFromMe)
}

func (s *ChatService) ForwardMessage(ctx context.Context, deviceID uuid.UUID, to string, originalMsg *domain.Message) (*domain.Message, error) {
	return s.pool.ForwardMessage(ctx, deviceID, to, originalMsg)
}

func (s *ChatService) GetMessageByID(ctx context.Context, chatID uuid.UUID, messageID string) (*domain.Message, error) {
	return s.repos.Message.GetByMessageID(ctx, chatID, messageID)
}

func (s *ChatService) MarkAsRead(ctx context.Context, chatID uuid.UUID) error {
	return s.repos.Chat.MarkAsRead(ctx, chatID)
}

func (s *ChatService) Delete(ctx context.Context, chatID uuid.UUID) error {
	return s.repos.Chat.Delete(ctx, chatID)
}

func (s *ChatService) DeleteBatch(ctx context.Context, ids []uuid.UUID) error {
	return s.repos.Chat.DeleteBatch(ctx, ids)
}

func (s *ChatService) DeleteAll(ctx context.Context, accountID uuid.UUID) error {
	return s.repos.Chat.DeleteAll(ctx, accountID)
}

func (s *ChatService) GetContacts(ctx context.Context, accountID uuid.UUID) ([]*domain.Contact, error) {
	return s.repos.Contact.GetByAccountID(ctx, accountID)
}

func (s *ChatService) GetRecentStickers(ctx context.Context, accountID uuid.UUID) ([]string, error) {
	return s.repos.Message.GetRecentStickers(ctx, accountID, 50)
}

func (s *ChatService) GetSavedStickers(ctx context.Context, accountID uuid.UUID) ([]string, error) {
	return s.repos.SavedSticker.GetAll(ctx, accountID)
}

func (s *ChatService) SaveSticker(ctx context.Context, accountID uuid.UUID, mediaURL string) error {
	return s.repos.SavedSticker.Save(ctx, accountID, mediaURL)
}

func (s *ChatService) DeleteSavedSticker(ctx context.Context, accountID uuid.UUID, mediaURL string) error {
	return s.repos.SavedSticker.Delete(ctx, accountID, mediaURL)
}

// ContactService handles contact operations
type ContactService struct {
	repos *repository.Repositories
	pool  *whatsapp.DevicePool
}

func (s *ContactService) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Contact, error) {
	return s.repos.Contact.GetByAccountID(ctx, accountID)
}

func (s *ContactService) GetByAccountIDWithFilters(ctx context.Context, accountID uuid.UUID, filter domain.ContactFilter) ([]*domain.Contact, int, error) {
	return s.repos.Contact.GetByAccountIDWithFilters(ctx, accountID, filter)
}

func (s *ContactService) GetByID(ctx context.Context, contactID uuid.UUID) (*domain.Contact, error) {
	contact, err := s.repos.Contact.GetByID(ctx, contactID)
	if err != nil || contact == nil {
		return nil, err
	}

	// Load device names
	deviceNames, err := s.repos.ContactDeviceName.GetByContactID(ctx, contactID)
	if err == nil {
		contact.DeviceNames = deviceNames
	}

	return contact, nil
}

func (s *ContactService) Update(ctx context.Context, contact *domain.Contact) error {
	return s.repos.Contact.Update(ctx, contact)
}

func (s *ContactService) SyncToParticipants(ctx context.Context, contact *domain.Contact) error {
	return s.repos.Contact.SyncToParticipants(ctx, contact)
}

func (s *ContactService) Delete(ctx context.Context, id uuid.UUID) error {
	return s.repos.Contact.Delete(ctx, id)
}

func (s *ContactService) DeleteBatch(ctx context.Context, ids []uuid.UUID) error {
	return s.repos.Contact.DeleteBatch(ctx, ids)
}

func (s *ContactService) FindDuplicates(ctx context.Context, accountID uuid.UUID) ([][]*domain.Contact, error) {
	return s.repos.Contact.FindDuplicates(ctx, accountID)
}

func (s *ContactService) MergeContacts(ctx context.Context, keepID uuid.UUID, mergeIDs []uuid.UUID) error {
	return s.repos.Contact.MergeContacts(ctx, keepID, mergeIDs)
}

func (s *ContactService) ResetFromDevice(ctx context.Context, contactID uuid.UUID) error {
	contact, err := s.repos.Contact.GetByID(ctx, contactID)
	if err != nil || contact == nil {
		return fmt.Errorf("contact not found")
	}

	// Get latest device name
	deviceNames, err := s.repos.ContactDeviceName.GetByContactID(ctx, contactID)
	if err != nil || len(deviceNames) == 0 {
		return fmt.Errorf("no device names available to reset from")
	}

	// Use the first (most recent) device name
	latest := deviceNames[0]
	contact.CustomName = nil // Clear custom name
	if latest.Name != nil {
		contact.Name = latest.Name
	}
	if latest.PushName != nil {
		contact.PushName = latest.PushName
	}

	return s.repos.Contact.Update(ctx, contact)
}

func (s *ContactService) SyncDevice(ctx context.Context, deviceID uuid.UUID) error {
	return s.pool.SyncDeviceContacts(ctx, deviceID)
}

// LeadService handles lead operations
type LeadService struct {
	repos *repository.Repositories
}

func (s *LeadService) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Lead, error) {
	return s.repos.Lead.GetByAccountID(ctx, accountID)
}

func (s *LeadService) GetByID(ctx context.Context, leadID uuid.UUID) (*domain.Lead, error) {
	return s.repos.Lead.GetByID(ctx, leadID)
}

func (s *LeadService) Create(ctx context.Context, lead *domain.Lead) error {
	return s.repos.Lead.Create(ctx, lead)
}

func (s *LeadService) Update(ctx context.Context, lead *domain.Lead) error {
	return s.repos.Lead.Update(ctx, lead)
}

func (s *LeadService) UpdateStatus(ctx context.Context, leadID uuid.UUID, status string) error {
	return s.repos.Lead.UpdateStatus(ctx, leadID, status)
}

func (s *LeadService) GetByJID(ctx context.Context, accountID uuid.UUID, jid string) (*domain.Lead, error) {
	return s.repos.Lead.GetByJID(ctx, accountID, jid)
}

func (s *LeadService) Delete(ctx context.Context, id uuid.UUID) error {
	return s.repos.Lead.Delete(ctx, id)
}

func (s *LeadService) DeleteBatch(ctx context.Context, ids []uuid.UUID) error {
	return s.repos.Lead.DeleteBatch(ctx, ids)
}

func (s *LeadService) DeleteAll(ctx context.Context, accountID uuid.UUID) error {
	return s.repos.Lead.DeleteAll(ctx, accountID)
}

// PipelineService handles pipeline operations
type PipelineService struct {
	repos *repository.Repositories
}

func (s *PipelineService) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Pipeline, error) {
	return s.repos.Pipeline.GetByAccountID(ctx, accountID)
}

// TagService handles tag operations
type TagService struct {
	repos *repository.Repositories
}

func (s *TagService) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Tag, error) {
	return s.repos.Tag.GetByAccountID(ctx, accountID)
}

func (s *TagService) Create(ctx context.Context, tag *domain.Tag) error {
	return s.repos.Tag.Create(ctx, tag)
}

func (s *TagService) Update(ctx context.Context, tag *domain.Tag) error {
	return s.repos.Tag.Update(ctx, tag)
}

func (s *TagService) Delete(ctx context.Context, id uuid.UUID) error {
	return s.repos.Tag.Delete(ctx, id)
}

func (s *TagService) Assign(ctx context.Context, entityType string, entityID, tagID uuid.UUID) error {
	switch entityType {
	case "contact":
		return s.repos.Tag.AssignToContact(ctx, entityID, tagID)
	case "lead":
		return s.repos.Tag.AssignToLead(ctx, entityID, tagID)
	case "chat":
		return s.repos.Tag.AssignToChat(ctx, entityID, tagID)
	case "participant":
		return s.repos.Tag.AssignToParticipant(ctx, entityID, tagID)
	default:
		return fmt.Errorf("invalid entity type: %s", entityType)
	}
}

func (s *TagService) Remove(ctx context.Context, entityType string, entityID, tagID uuid.UUID) error {
	switch entityType {
	case "contact":
		return s.repos.Tag.RemoveFromContact(ctx, entityID, tagID)
	case "lead":
		return s.repos.Tag.RemoveFromLead(ctx, entityID, tagID)
	case "chat":
		return s.repos.Tag.RemoveFromChat(ctx, entityID, tagID)
	case "participant":
		return s.repos.Tag.RemoveFromParticipant(ctx, entityID, tagID)
	default:
		return fmt.Errorf("invalid entity type: %s", entityType)
	}
}

func (s *TagService) GetByEntity(ctx context.Context, entityType string, entityID uuid.UUID) ([]*domain.Tag, error) {
	switch entityType {
	case "contact":
		return s.repos.Tag.GetByContact(ctx, entityID)
	case "lead":
		return s.repos.Tag.GetByLead(ctx, entityID)
	case "chat":
		return s.repos.Tag.GetByChat(ctx, entityID)
	case "participant":
		return s.repos.Tag.GetByParticipant(ctx, entityID)
	default:
		return nil, fmt.Errorf("invalid entity type: %s", entityType)
	}
}

// CampaignService handles campaign operations
type CampaignService struct {
	repos *repository.Repositories
	pool  *whatsapp.DevicePool
	hub   *ws.Hub
}

func (s *CampaignService) Create(ctx context.Context, campaign *domain.Campaign) error {
	return s.repos.Campaign.Create(ctx, campaign)
}

func (s *CampaignService) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.Campaign, error) {
	return s.repos.Campaign.GetByAccountID(ctx, accountID)
}

func (s *CampaignService) GetByID(ctx context.Context, id uuid.UUID) (*domain.Campaign, error) {
	return s.repos.Campaign.GetByID(ctx, id)
}

func (s *CampaignService) Update(ctx context.Context, campaign *domain.Campaign) error {
	return s.repos.Campaign.Update(ctx, campaign)
}

func (s *CampaignService) Delete(ctx context.Context, id uuid.UUID) error {
	return s.repos.Campaign.Delete(ctx, id)
}

func (s *CampaignService) AddRecipients(ctx context.Context, recipients []*domain.CampaignRecipient) error {
	return s.repos.Campaign.AddRecipients(ctx, recipients)
}

func (s *CampaignService) GetRecipients(ctx context.Context, campaignID uuid.UUID) ([]*domain.CampaignRecipient, error) {
	return s.repos.Campaign.GetRecipients(ctx, campaignID)
}

func (s *CampaignService) Start(ctx context.Context, campaignID uuid.UUID) error {
	campaign, err := s.repos.Campaign.GetByID(ctx, campaignID)
	if err != nil {
		return err
	}
	if campaign.Status != domain.CampaignStatusDraft && campaign.Status != domain.CampaignStatusPaused && campaign.Status != domain.CampaignStatusScheduled {
		return fmt.Errorf("campaign cannot be started from status: %s", campaign.Status)
	}
	now := time.Now()
	campaign.Status = domain.CampaignStatusRunning
	campaign.StartedAt = &now
	return s.repos.Campaign.Update(ctx, campaign)
}

func (s *CampaignService) Pause(ctx context.Context, campaignID uuid.UUID) error {
	campaign, err := s.repos.Campaign.GetByID(ctx, campaignID)
	if err != nil {
		return err
	}
	if campaign.Status != domain.CampaignStatusRunning {
		return fmt.Errorf("campaign is not running")
	}
	campaign.Status = domain.CampaignStatusPaused
	return s.repos.Campaign.Update(ctx, campaign)
}

func (s *CampaignService) GetRunningCampaigns(ctx context.Context) ([]*domain.Campaign, error) {
	return s.repos.Campaign.GetRunningCampaigns(ctx)
}

func (s *CampaignService) ProcessNextRecipient(ctx context.Context, campaignID uuid.UUID) (bool, error) {
	campaign, err := s.repos.Campaign.GetByID(ctx, campaignID)
	if err != nil {
		return false, err
	}
	if campaign.Status != domain.CampaignStatusRunning {
		return false, nil
	}

	rec, err := s.repos.Campaign.GetNextPendingRecipient(ctx, campaignID)
	if err != nil {
		// No more recipients
		now := time.Now()
		campaign.Status = domain.CampaignStatusCompleted
		campaign.CompletedAt = &now
		s.repos.Campaign.Update(ctx, campaign)
		return false, nil
	}

	// Personalize message
	msg := campaign.MessageTemplate
	if rec.Name != nil && *rec.Name != "" {
		msg = strings.Replace(msg, "{{nombre}}", *rec.Name, -1)
		msg = strings.Replace(msg, "{{name}}", *rec.Name, -1)
	}
	if rec.Phone != nil {
		msg = strings.Replace(msg, "{{telefono}}", *rec.Phone, -1)
		msg = strings.Replace(msg, "{{phone}}", *rec.Phone, -1)
	}

	// Send message
	var sendErr error
	if campaign.MediaURL != nil && *campaign.MediaURL != "" && campaign.MediaType != nil {
		_, sendErr = s.pool.SendMediaMessage(ctx, campaign.DeviceID, rec.JID, msg, *campaign.MediaURL, *campaign.MediaType)
	} else {
		_, sendErr = s.pool.SendMessage(ctx, campaign.DeviceID, rec.JID, msg)
	}

	if sendErr != nil {
		errMsg := sendErr.Error()
		s.repos.Campaign.UpdateRecipientStatus(ctx, rec.ID, "failed", &errMsg)
		s.repos.Campaign.IncrementFailedCount(ctx, campaignID)
	} else {
		s.repos.Campaign.UpdateRecipientStatus(ctx, rec.ID, "sent", nil)
		s.repos.Campaign.IncrementSentCount(ctx, campaignID)
	}

	return true, nil
}

// EventService handles event operations
type EventService struct {
	repos *repository.Repositories
	hub   *ws.Hub
}

func (s *EventService) Create(ctx context.Context, event *domain.Event) error {
	return s.repos.Event.Create(ctx, event)
}

func (s *EventService) GetByAccountID(ctx context.Context, accountID uuid.UUID, filter domain.EventFilter) ([]*domain.Event, int, error) {
	return s.repos.Event.GetByAccountID(ctx, accountID, filter)
}

func (s *EventService) GetByID(ctx context.Context, id uuid.UUID) (*domain.Event, error) {
	return s.repos.Event.GetByID(ctx, id)
}

func (s *EventService) Update(ctx context.Context, event *domain.Event) error {
	return s.repos.Event.Update(ctx, event)
}

func (s *EventService) Delete(ctx context.Context, id uuid.UUID) error {
	return s.repos.Event.Delete(ctx, id)
}

func (s *EventService) GetByContactID(ctx context.Context, accountID, contactID uuid.UUID) ([]*domain.Event, error) {
	return s.repos.Event.GetByContactID(ctx, accountID, contactID)
}

func (s *EventService) GetParticipants(ctx context.Context, eventID uuid.UUID, search, status string, tagIDs []uuid.UUID, hasPhone *bool) ([]*domain.EventParticipant, error) {
	return s.repos.Participant.GetByEventID(ctx, eventID, search, status, tagIDs, hasPhone)
}

func (s *EventService) AddParticipant(ctx context.Context, p *domain.EventParticipant) error {
	return s.repos.Participant.Add(ctx, p)
}

func (s *EventService) BulkAddParticipants(ctx context.Context, eventID uuid.UUID, participants []*domain.EventParticipant) error {
	return s.repos.Participant.BulkAdd(ctx, eventID, participants)
}

func (s *EventService) GetParticipant(ctx context.Context, id uuid.UUID) (*domain.EventParticipant, error) {
	return s.repos.Participant.GetByID(ctx, id)
}

func (s *EventService) UpdateParticipant(ctx context.Context, p *domain.EventParticipant) error {
	return s.repos.Participant.Update(ctx, p)
}

func (s *EventService) SyncParticipantToContact(ctx context.Context, p *domain.EventParticipant) error {
	return s.repos.Participant.SyncToContact(ctx, p)
}

func (s *EventService) UpdateParticipantStatus(ctx context.Context, id uuid.UUID, status string) error {
	return s.repos.Participant.UpdateStatus(ctx, id, status)
}

func (s *EventService) DeleteParticipant(ctx context.Context, id uuid.UUID) error {
	return s.repos.Participant.Delete(ctx, id)
}

func (s *EventService) GetUpcomingActions(ctx context.Context, accountID uuid.UUID, limit int) ([]*domain.EventParticipant, error) {
	return s.repos.Participant.GetUpcomingActions(ctx, accountID, limit)
}

// InteractionService handles interaction operations
type InteractionService struct {
	repos *repository.Repositories
	hub   *ws.Hub
}

func (s *InteractionService) LogInteraction(ctx context.Context, interaction *domain.Interaction) error {
	if err := s.repos.Interaction.Create(ctx, interaction); err != nil {
		return err
	}

	// Auto-update participant status based on outcome
	if interaction.ParticipantID != nil && interaction.Outcome != nil {
		switch *interaction.Outcome {
		case domain.InteractionOutcomeConfirmed:
			s.repos.Participant.UpdateStatus(ctx, *interaction.ParticipantID, domain.ParticipantStatusConfirmed)
		case domain.InteractionOutcomeDeclined:
			s.repos.Participant.UpdateStatus(ctx, *interaction.ParticipantID, domain.ParticipantStatusDeclined)
		case domain.InteractionOutcomeAnswered, domain.InteractionOutcomeCallback, domain.InteractionOutcomeRescheduled:
			// Move to contacted if still invited
			p, _ := s.repos.Participant.GetByID(ctx, *interaction.ParticipantID)
			if p != nil && p.Status == domain.ParticipantStatusInvited {
				s.repos.Participant.UpdateStatus(ctx, *interaction.ParticipantID, domain.ParticipantStatusContacted)
			}
		}
	}

	// Update next_action on participant if provided
	if interaction.ParticipantID != nil && (interaction.NextAction != nil || interaction.NextActionDate != nil) {
		p, _ := s.repos.Participant.GetByID(ctx, *interaction.ParticipantID)
		if p != nil {
			p.NextAction = interaction.NextAction
			p.NextActionDate = interaction.NextActionDate
			s.repos.Participant.Update(ctx, p)
		}
	}

	return nil
}

func (s *InteractionService) GetByParticipantID(ctx context.Context, participantID uuid.UUID) ([]*domain.Interaction, error) {
	return s.repos.Interaction.GetByParticipantID(ctx, participantID)
}

func (s *InteractionService) GetByContactID(ctx context.Context, contactID uuid.UUID, limit, offset int) ([]*domain.Interaction, error) {
	return s.repos.Interaction.GetByContactID(ctx, contactID, limit, offset)
}

func (s *InteractionService) GetByEventID(ctx context.Context, eventID uuid.UUID, limit, offset int) ([]*domain.Interaction, error) {
	return s.repos.Interaction.GetByEventID(ctx, eventID, limit, offset)
}

func (s *InteractionService) GetByLeadID(ctx context.Context, leadID uuid.UUID, limit, offset int) ([]*domain.Interaction, error) {
	return s.repos.Interaction.GetByLeadID(ctx, leadID, limit, offset)
}

func (s *InteractionService) Delete(ctx context.Context, id uuid.UUID) error {
	return s.repos.Interaction.Delete(ctx, id)
}
