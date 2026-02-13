package whatsapp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib" // PostgreSQL driver for whatsmeow sqlstore
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/internal/ws"
	"github.com/naperu/clarin/pkg/config"
	qrcode "github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

// strPtr returns a pointer to a string
func strPtr(s string) *string {
	return &s
}

// DeviceInstance represents a single WhatsApp connection
type DeviceInstance struct {
	ID        uuid.UUID
	AccountID uuid.UUID
	Client    *whatsmeow.Client
	JID       string
	Status    string
	QRCode    string
	mu        sync.RWMutex
}

// DevicePool manages multiple WhatsApp connections
type DevicePool struct {
	devices map[uuid.UUID]*DeviceInstance
	store   *sqlstore.Container
	repos   *repository.Repositories
	hub     *ws.Hub
	cfg     *config.Config
	storage *storage.Storage
	mu      sync.RWMutex
}

// NewDevicePool creates a new device pool
func NewDevicePool(cfg *config.Config, repos *repository.Repositories, hub *ws.Hub) (*DevicePool, error) {
	// Initialize whatsmeow store with PostgreSQL
	dbLog := waLog.Stdout("Database", "DEBUG", true)
	container, err := sqlstore.New(context.Background(), "pgx", cfg.DatabaseURL, dbLog)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize whatsmeow store: %w", err)
	}

	// Warm up LID mapping cache for @lid -> phone resolution
	if container.LIDMap != nil {
		if err := container.LIDMap.FillCache(context.Background()); err != nil {
			log.Printf("[DevicePool] Warning: failed to fill LID cache: %v", err)
		} else {
			log.Printf("[DevicePool] LID mapping cache loaded")
		}
	}

	return &DevicePool{
		devices: make(map[uuid.UUID]*DeviceInstance),
		store:   container,
		repos:   repos,
		hub:     hub,
		cfg:     cfg,
	}, nil
}

// SetStorage sets the storage instance for media handling
func (p *DevicePool) SetStorage(s *storage.Storage) {
	p.storage = s
}

// LoadExistingDevices loads all existing devices and connects them
func (p *DevicePool) LoadExistingDevices(ctx context.Context) error {
	devices, err := p.repos.Device.GetAll(ctx)
	if err != nil {
		return fmt.Errorf("failed to get devices: %w", err)
	}

	for _, device := range devices {
		if device.JID != nil && *device.JID != "" {
			// Device was previously connected, try to reconnect
			go func(d *domain.Device) {
				if err := p.ConnectDevice(ctx, d.ID); err != nil {
					log.Printf("[DevicePool] Failed to reconnect device %s: %v", d.ID, err)
				}
			}(device)
		}
	}

	return nil
}

// CreateDevice creates a new device entry and returns it
func (p *DevicePool) CreateDevice(ctx context.Context, accountID uuid.UUID, name string) (*domain.Device, error) {
	status := domain.DeviceStatusDisconnected
	device := &domain.Device{
		AccountID: accountID,
		Name:      &name,
		Status:    &status,
	}

	if err := p.repos.Device.Create(ctx, device); err != nil {
		return nil, fmt.Errorf("failed to create device: %w", err)
	}

	return device, nil
}

// ConnectDevice initializes and connects a WhatsApp client for a device
func (p *DevicePool) ConnectDevice(ctx context.Context, deviceID uuid.UUID) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	// Check if already connected
	if instance, exists := p.devices[deviceID]; exists {
		if instance.Client != nil && instance.Client.IsConnected() {
			return nil // Already connected
		}
	}

	// Get device from database
	device, err := p.repos.Device.GetByID(ctx, deviceID)
	if err != nil {
		return fmt.Errorf("failed to get device: %w", err)
	}
	if device == nil {
		return fmt.Errorf("device not found: %s", deviceID)
	}

	// Update status to connecting
	_ = p.repos.Device.UpdateStatus(ctx, deviceID, domain.DeviceStatusConnecting)
	p.hub.BroadcastDeviceStatus(device.AccountID, deviceID, domain.DeviceStatusConnecting, "")

	// Get or create whatsmeow device store
	var waDevice *store.Device
	if device.JID != nil && *device.JID != "" {
		// Try to get existing device by JID
		jid, _ := types.ParseJID(*device.JID)
		waDevice, err = p.store.GetDevice(ctx, jid)
		if err != nil {
			waDevice = nil // Create new if not found
		}
	}

	if waDevice == nil {
		waDevice = p.store.NewDevice()
	}

	// Configure device properties
	store.DeviceProps.Os = proto.String("Clarin CRM")
	store.DeviceProps.RequireFullSync = proto.Bool(false)

	// Create client
	clientLog := waLog.Stdout("Client", "INFO", true)
	client := whatsmeow.NewClient(waDevice, clientLog)
	client.EnableAutoReconnect = true
	client.AutoTrustIdentity = true

	// Create device instance
	instance := &DeviceInstance{
		ID:        deviceID,
		AccountID: device.AccountID,
		Client:    client,
		Status:    domain.DeviceStatusConnecting,
	}
	p.devices[deviceID] = instance

	// Add event handler
	client.AddEventHandler(func(evt interface{}) {
		p.handleEvent(ctx, instance, evt)
	})

	// Connect
	if client.Store.ID == nil {
		// New device, need QR code
		qrChan, _ := client.GetQRChannel(ctx)
		err = client.Connect()
		if err != nil {
			return fmt.Errorf("failed to connect: %w", err)
		}

		// Handle QR codes in goroutine
		go p.handleQRChannel(ctx, instance, qrChan)
	} else {
		// Existing device, just connect
		err = client.Connect()
		if err != nil {
			return fmt.Errorf("failed to connect: %w", err)
		}
	}

	return nil
}

// handleQRChannel handles QR code events
func (p *DevicePool) handleQRChannel(ctx context.Context, instance *DeviceInstance, qrChan <-chan whatsmeow.QRChannelItem) {
	for evt := range qrChan {
		switch evt.Event {
		case "code":
			// Generate QR code image as base64
			qr, err := qrcode.Encode(evt.Code, qrcode.Medium, 256)
			if err != nil {
				log.Printf("[QR] Failed to generate QR code: %v", err)
				continue
			}
			qrBase64 := "data:image/png;base64," + base64.StdEncoding.EncodeToString(qr)

			instance.mu.Lock()
			instance.QRCode = qrBase64
			instance.Status = domain.DeviceStatusConnecting
			instance.mu.Unlock()

			// Update database
			_ = p.repos.Device.UpdateQRCode(ctx, instance.ID, qrBase64)

			// Broadcast to frontend
			p.hub.BroadcastQRCode(instance.AccountID, instance.ID, qrBase64)
			log.Printf("[QR] New QR code generated for device %s", instance.ID)

		case "success":
			log.Printf("[QR] Login successful for device %s", instance.ID)

		case "timeout":
			log.Printf("[QR] QR code timeout for device %s", instance.ID)
			instance.mu.Lock()
			instance.Status = domain.DeviceStatusDisconnected
			instance.QRCode = ""
			instance.mu.Unlock()
			_ = p.repos.Device.UpdateStatus(ctx, instance.ID, domain.DeviceStatusDisconnected)
			p.hub.BroadcastDeviceStatus(instance.AccountID, instance.ID, domain.DeviceStatusDisconnected, "")
		}
	}
}

// handleEvent processes WhatsApp events
func (p *DevicePool) handleEvent(ctx context.Context, instance *DeviceInstance, rawEvt interface{}) {
	switch evt := rawEvt.(type) {
	case *events.Connected:
		p.handleConnected(ctx, instance)

	case *events.LoggedOut:
		p.handleLoggedOut(ctx, instance, evt)

	case *events.Disconnected:
		p.handleDisconnected(ctx, instance)

	case *events.Message:
		p.handleMessage(ctx, instance, evt)

	case *events.Receipt:
		p.handleReceipt(ctx, instance, evt)

	case *events.Presence:
		p.handlePresence(ctx, instance, evt)

	case *events.PushName:
		p.handlePushName(ctx, instance, evt)

	case *events.Contact:
		p.handleContactEvent(ctx, instance, evt)

	case *events.HistorySync:
		p.handleHistorySync(ctx, instance, evt)
	}
}

// handleConnected processes connection events
func (p *DevicePool) handleConnected(ctx context.Context, instance *DeviceInstance) {
	if instance.Client.Store.ID == nil {
		return
	}

	jid := instance.Client.Store.ID.String()
	phone := strings.Split(instance.Client.Store.ID.User, "@")[0]

	instance.mu.Lock()
	instance.JID = jid
	instance.Status = domain.DeviceStatusConnected
	instance.QRCode = ""
	instance.mu.Unlock()

	// Update database
	_ = p.repos.Device.UpdateJID(ctx, instance.ID, jid, phone)

	// Broadcast status
	p.hub.BroadcastDeviceStatus(instance.AccountID, instance.ID, domain.DeviceStatusConnected, "")

	log.Printf("[Device %s] Connected as %s", instance.ID, jid)

	// Sync contacts in background after connection
	go p.syncContacts(context.Background(), instance)
}

// handleLoggedOut processes logout events
func (p *DevicePool) handleLoggedOut(ctx context.Context, instance *DeviceInstance, evt *events.LoggedOut) {
	instance.mu.Lock()
	instance.Status = domain.DeviceStatusLoggedOut
	instance.JID = ""
	instance.mu.Unlock()

	_ = p.repos.Device.UpdateStatus(ctx, instance.ID, domain.DeviceStatusLoggedOut)
	p.hub.BroadcastDeviceStatus(instance.AccountID, instance.ID, domain.DeviceStatusLoggedOut, "")

	log.Printf("[Device %s] Logged out: %s", instance.ID, evt.Reason)
}

// handleDisconnected processes disconnection events
func (p *DevicePool) handleDisconnected(ctx context.Context, instance *DeviceInstance) {
	instance.mu.Lock()
	instance.Status = domain.DeviceStatusDisconnected
	instance.mu.Unlock()

	_ = p.repos.Device.UpdateStatus(ctx, instance.ID, domain.DeviceStatusDisconnected)
	p.hub.BroadcastDeviceStatus(instance.AccountID, instance.ID, domain.DeviceStatusDisconnected, "")

	log.Printf("[Device %s] Disconnected", instance.ID)
}

// handleMessage processes incoming messages
func (p *DevicePool) handleMessage(ctx context.Context, instance *DeviceInstance, evt *events.Message) {
	// Skip status broadcasts
	if evt.Info.Chat.Server == "broadcast" {
		return
	}

	// Skip group messages - only process 1-to-1 chats
	if evt.Info.Chat.Server == "g.us" {
		return
	}

	// Skip newsletter/channel messages
	if evt.Info.Chat.Server == "newsletter" {
		return
	}

	// Handle reactions separately — they are NOT regular messages
	if reactionMsg := evt.Message.GetReactionMessage(); reactionMsg != nil {
		p.handleReaction(ctx, instance, evt, reactionMsg)
		return
	}

	// Handle poll creation messages
	if pollMsg := evt.Message.GetPollCreationMessage(); pollMsg != nil {
		p.handlePollCreation(ctx, instance, evt, pollMsg)
		return
	}

	// Handle poll vote updates
	if pollUpdate := evt.Message.GetPollUpdateMessage(); pollUpdate != nil {
		p.handlePollUpdate(ctx, instance, evt, pollUpdate)
		return
	}

	// Get message content
	body := ""
	msgType := domain.MessageTypeText
	var mediaURL, mediaMimetype, mediaFilename *string
	var mediaSize *int64

	if evt.Message.GetConversation() != "" {
		body = evt.Message.GetConversation()
	} else if evt.Message.GetExtendedTextMessage() != nil {
		body = evt.Message.GetExtendedTextMessage().GetText()
	} else if imgMsg := evt.Message.GetImageMessage(); imgMsg != nil {
		body = imgMsg.GetCaption()
		msgType = domain.MessageTypeImage
		mediaMimetype = strPtr(imgMsg.GetMimetype())
		// Download and store the image
		if p.storage != nil {
			url, err := p.downloadAndStoreMedia(ctx, instance, imgMsg, evt.Info.Chat.ToNonAD().String(), evt.Info.ID, imgMsg.GetMimetype(), ".jpg")
			if err == nil {
				mediaURL = &url
			}
		}
	} else if vidMsg := evt.Message.GetVideoMessage(); vidMsg != nil {
		body = vidMsg.GetCaption()
		msgType = domain.MessageTypeVideo
		mediaMimetype = strPtr(vidMsg.GetMimetype())
		if p.storage != nil {
			url, err := p.downloadAndStoreMedia(ctx, instance, vidMsg, evt.Info.Chat.ToNonAD().String(), evt.Info.ID, vidMsg.GetMimetype(), ".mp4")
			if err == nil {
				mediaURL = &url
			}
		}
	} else if audMsg := evt.Message.GetAudioMessage(); audMsg != nil {
		msgType = domain.MessageTypeAudio
		mediaMimetype = strPtr(audMsg.GetMimetype())
		ext := ".ogg"
		if audMsg.GetPTT() {
			ext = ".ogg"
		}
		if p.storage != nil {
			url, err := p.downloadAndStoreMedia(ctx, instance, audMsg, evt.Info.Chat.ToNonAD().String(), evt.Info.ID, audMsg.GetMimetype(), ext)
			if err == nil {
				mediaURL = &url
			}
		}
	} else if docMsg := evt.Message.GetDocumentMessage(); docMsg != nil {
		body = docMsg.GetFileName()
		msgType = domain.MessageTypeDocument
		mediaMimetype = strPtr(docMsg.GetMimetype())
		mediaFilename = strPtr(docMsg.GetFileName())
		if docMsg.FileLength != nil {
			size := int64(*docMsg.FileLength)
			mediaSize = &size
		}
		ext := filepath.Ext(docMsg.GetFileName())
		if ext == "" {
			ext = ".bin"
		}
		if p.storage != nil {
			url, err := p.downloadAndStoreMedia(ctx, instance, docMsg, evt.Info.Chat.ToNonAD().String(), evt.Info.ID, docMsg.GetMimetype(), ext)
			if err == nil {
				mediaURL = &url
			}
		}
	} else if stickerMsg := evt.Message.GetStickerMessage(); stickerMsg != nil {
		msgType = domain.MessageTypeSticker
		mediaMimetype = strPtr(stickerMsg.GetMimetype())
		if p.storage != nil {
			url, err := p.downloadAndStoreMedia(ctx, instance, stickerMsg, evt.Info.Chat.ToNonAD().String(), evt.Info.ID, stickerMsg.GetMimetype(), ".webp")
			if err == nil {
				mediaURL = &url
			}
		}
	}

	// Get sender info - normalize JIDs to remove device suffix for consistent chat matching
	// ToNonAD() converts JIDs like "user:5@s.whatsapp.net" to "user@s.whatsapp.net"
	chatJID := evt.Info.Chat.ToNonAD().String()
	senderJID := evt.Info.Sender.ToNonAD().String()
	senderName := evt.Info.PushName
	isFromMe := evt.Info.IsFromMe

	// Resolve phone number BEFORE creating chat — so we use a consistent JID
	phone := evt.Info.Sender.ToNonAD().User
	if evt.Info.Chat.Server == types.HiddenUserServer {
		// Chat JID is @lid — try to resolve to @s.whatsapp.net for consistent chat identity
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, evt.Info.Chat.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			chatJID = pnJID.User + "@s.whatsapp.net"
			phone = pnJID.User
			log.Printf("[Message] Resolved chat LID %s -> %s", evt.Info.Chat.ToNonAD().String(), chatJID)
		}
	}
	if !isFromMe && evt.Info.Sender.Server == types.HiddenUserServer {
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, evt.Info.Sender.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			phone = pnJID.User
		} else if evt.Info.Chat.Server == types.DefaultUserServer {
			phone = evt.Info.Chat.ToNonAD().User
		}
	}

	// Get or create chat - only use sender name for incoming messages (not our own)
	chatName := ""
	if !isFromMe {
		chatName = senderName
	}
	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, chatJID, chatName)
	if err != nil {
		log.Printf("[Message] Failed to get/create chat: %v", err)
		return
	}

	// Extract quoted/reply context from incoming message
	var quotedMessageID, quotedBody, quotedSender *string
	// Check ContextInfo from various message types
	var contextInfo *waE2E.ContextInfo
	if ext := evt.Message.GetExtendedTextMessage(); ext != nil && ext.GetContextInfo() != nil {
		contextInfo = ext.GetContextInfo()
	} else if img := evt.Message.GetImageMessage(); img != nil && img.GetContextInfo() != nil {
		contextInfo = img.GetContextInfo()
	} else if vid := evt.Message.GetVideoMessage(); vid != nil && vid.GetContextInfo() != nil {
		contextInfo = vid.GetContextInfo()
	} else if aud := evt.Message.GetAudioMessage(); aud != nil && aud.GetContextInfo() != nil {
		contextInfo = aud.GetContextInfo()
	} else if doc := evt.Message.GetDocumentMessage(); doc != nil && doc.GetContextInfo() != nil {
		contextInfo = doc.GetContextInfo()
	} else if stk := evt.Message.GetStickerMessage(); stk != nil && stk.GetContextInfo() != nil {
		contextInfo = stk.GetContextInfo()
	}
	if contextInfo != nil && contextInfo.GetStanzaID() != "" {
		quotedMessageID = strPtr(contextInfo.GetStanzaID())
		quotedSender = strPtr(contextInfo.GetParticipant())
		// Extract quoted message body
		if qm := contextInfo.GetQuotedMessage(); qm != nil {
			if qm.GetConversation() != "" {
				quotedBody = strPtr(qm.GetConversation())
			} else if qm.GetExtendedTextMessage() != nil {
				quotedBody = strPtr(qm.GetExtendedTextMessage().GetText())
			} else if qm.GetImageMessage() != nil && qm.GetImageMessage().GetCaption() != "" {
				quotedBody = strPtr(qm.GetImageMessage().GetCaption())
			} else if qm.GetVideoMessage() != nil && qm.GetVideoMessage().GetCaption() != "" {
				quotedBody = strPtr(qm.GetVideoMessage().GetCaption())
			} else if qm.GetDocumentMessage() != nil {
				quotedBody = strPtr(qm.GetDocumentMessage().GetFileName())
			} else {
				quotedBody = strPtr("[media]")
			}
		}
	}

	// Create message
	msg := &domain.Message{
		AccountID:       instance.AccountID,
		DeviceID:        &instance.ID,
		ChatID:          chat.ID,
		MessageID:       evt.Info.ID,
		FromJID:         strPtr(senderJID),
		FromName:        strPtr(senderName),
		Body:            strPtr(body),
		MessageType:     strPtr(msgType),
		MediaURL:        mediaURL,
		MediaMimetype:   mediaMimetype,
		MediaFilename:   mediaFilename,
		MediaSize:       mediaSize,
		IsFromMe:        isFromMe,
		Status:          strPtr("received"),
		Timestamp:       evt.Info.Timestamp,
		QuotedMessageID: quotedMessageID,
		QuotedBody:      quotedBody,
		QuotedSender:    quotedSender,
	}

	if err := p.repos.Message.Create(ctx, msg); err != nil {
		log.Printf("[Message] Failed to save message: %v", err)
		return
	}

	// Update chat last message
	_ = p.repos.Chat.UpdateLastMessage(ctx, chat.ID, body, evt.Info.Timestamp, !isFromMe)

	// Use chatJID for contact in 1-to-1 chats so the LEFT JOIN in queries matches
	contactJID := senderJID
	if !isFromMe {
		contactJID = chatJID
	}
	contact, _ := p.repos.Contact.GetOrCreate(ctx, instance.AccountID, &instance.ID, contactJID, phone, senderName, evt.Info.PushName, false)

	// Fetch and store avatar if contact has no avatar yet
	if contact != nil && contact.AvatarURL == nil && !isFromMe {
		avatarJID := evt.Info.Chat.ToNonAD()
		// If chat JID is @lid, resolve to @s.whatsapp.net for GetProfilePictureInfo
		if avatarJID.Server == types.HiddenUserServer {
			if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, avatarJID); err == nil && !pnJID.IsEmpty() {
				avatarJID = pnJID
			}
		}
		go p.fetchAndStoreAvatar(ctx, instance, contactJID, avatarJID)
	}

	// Auto-create lead if not exists and is incoming message
	if !isFromMe {
		lead, _ := p.repos.Lead.GetByJID(ctx, instance.AccountID, contactJID)
		if lead == nil {
			newLead := &domain.Lead{
				AccountID: instance.AccountID,
				JID:       contactJID,
				Name:      strPtr(senderName),
				Phone:     strPtr(phone),
				Status:    strPtr(domain.LeadStatusNew),
				Source:    strPtr("whatsapp"),
			}
			_ = p.repos.Lead.Create(ctx, newLead)
			log.Printf("[Lead] Auto-created lead for %s", contactJID)
		}
	}

	// Broadcast to frontend
	p.hub.BroadcastNewMessage(instance.AccountID, map[string]interface{}{
		"chat_id":      chat.ID.String(),
		"message":      msg,
		"chat_jid":     chatJID,
		"sender_name":  senderName,
		"is_from_me":   isFromMe,
		"unread_count": chat.UnreadCount + 1,
	})

	log.Printf("[Message] %s -> %s: %s", senderName, chatJID, truncate(body, 50))
}

// fetchAndStoreAvatar fetches a WhatsApp profile picture and stores it
func (p *DevicePool) fetchAndStoreAvatar(ctx context.Context, instance *DeviceInstance, contactJID string, jid types.JID) {
	if p.storage == nil || instance.Client == nil {
		return
	}

	defer func() {
		if r := recover(); r != nil {
			log.Printf("[Avatar] Panic recovering avatar for %s: %v", jid.String(), r)
		}
	}()

	picInfo, err := instance.Client.GetProfilePictureInfo(ctx, jid, &whatsmeow.GetProfilePictureParams{})
	if err != nil || picInfo == nil {
		log.Printf("[Avatar] No profile picture for %s: %v", jid.String(), err)
		return
	}

	// Download the avatar image
	resp, err := http.Get(picInfo.URL)
	if err != nil {
		log.Printf("[Avatar] Failed to download avatar for %s: %v", jid.String(), err)
		return
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil || len(data) == 0 {
		log.Printf("[Avatar] Failed to read avatar for %s: %v", jid.String(), err)
		return
	}

	// Upload to MinIO
	filename := jid.ToNonAD().User + ".jpg"
	_, err = p.storage.UploadFile(ctx, instance.AccountID, "avatars", filename, data, "image/jpeg")
	if err != nil {
		log.Printf("[Avatar] Failed to store avatar for %s: %v", jid.String(), err)
		return
	}

	// Store proxy URL in contact
	proxyURL := fmt.Sprintf("/api/media/file/%s/avatars/%s", instance.AccountID.String(), filename)
	err = p.repos.Contact.UpdateAvatarURL(ctx, instance.AccountID, contactJID, proxyURL)
	if err != nil {
		log.Printf("[Avatar] Failed to update contact avatar: %v", err)
		return
	}

	log.Printf("[Avatar] Stored avatar for %s", jid.String())
}

// downloadAndStoreMedia downloads media from WhatsApp and stores it in MinIO
func (p *DevicePool) downloadAndStoreMedia(ctx context.Context, instance *DeviceInstance, msg whatsmeow.DownloadableMessage, chatJID, msgID, mimetype, extension string) (string, error) {
	if p.storage == nil {
		return "", fmt.Errorf("storage not configured")
	}

	// Download media
	data, err := instance.Client.Download(ctx, msg)
	if err != nil {
		log.Printf("[Media] Failed to download: %v", err)
		return "", err
	}

	// Generate filename
	filename := msgID + extension

	// Upload to storage
	folder := "chats/" + chatJID

	_, err = p.storage.UploadFile(ctx, instance.AccountID, folder, filename, data, mimetype)
	if err != nil {
		log.Printf("[Media] Failed to upload: %v", err)
		return "", err
	}

	// Return proxy URL instead of public URL for reliable frontend loading
	proxyURL := fmt.Sprintf("/api/media/file/%s/%s/%s", instance.AccountID.String(), folder, filename)
	log.Printf("[Media] Stored %s (%d bytes)", proxyURL, len(data))
	return proxyURL, nil
}

// handleReceipt processes read receipts
func (p *DevicePool) handleReceipt(ctx context.Context, instance *DeviceInstance, evt *events.Receipt) {
	status := "delivered"
	if evt.Type == types.ReceiptTypeRead {
		status = "read"
	}

	// Broadcast receipt status - normalize JID for consistent matching
	p.hub.BroadcastToAccount(instance.AccountID, ws.EventMessageStatus, map[string]interface{}{
		"message_ids": evt.MessageIDs,
		"chat_jid":    evt.Chat.ToNonAD().String(),
		"status":      status,
		"timestamp":   evt.Timestamp,
	})
}

// handlePresence processes presence updates
func (p *DevicePool) handlePresence(ctx context.Context, instance *DeviceInstance, evt *events.Presence) {
	p.hub.BroadcastToAccount(instance.AccountID, ws.EventPresence, map[string]interface{}{
		"jid":          evt.From.ToNonAD().String(),
		"available":    evt.Unavailable == false,
		"last_seen_at": evt.LastSeen,
	})
}

// handleContactEvent processes contact update events from WhatsApp
// events.Contact comes from app state sync and has Action (*waSyncAction.ContactAction)
// with GetFullName() and GetFirstName() methods (no BusinessName/PushName here)
func (p *DevicePool) handleContactEvent(ctx context.Context, instance *DeviceInstance, evt *events.Contact) {
	jid := evt.JID.ToNonAD().String()
	phone := evt.JID.User

	// Resolve LID
	if evt.JID.Server == types.HiddenUserServer {
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, evt.JID.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			jid = pnJID.User + "@s.whatsapp.net"
			phone = pnJID.User
		}
	}

	name := evt.Action.GetFullName()
	if name == "" {
		name = evt.Action.GetFirstName()
	}

	contact, err := p.repos.Contact.GetOrCreate(ctx, instance.AccountID, &instance.ID, jid, phone, name, "", false)
	if err != nil {
		log.Printf("[ContactEvent] Failed to upsert contact %s: %v", jid, err)
		return
	}

	// Update per-device name
	cdn := &domain.ContactDeviceName{
		ContactID: contact.ID,
		DeviceID:  instance.ID,
		Name:      strPtr(name),
	}
	_ = p.repos.ContactDeviceName.Upsert(ctx, cdn)

	log.Printf("[ContactEvent] Updated contact %s: %s", jid, name)
}

// handlePushName processes push name updates
func (p *DevicePool) handlePushName(ctx context.Context, instance *DeviceInstance, evt *events.PushName) {
	jid := evt.JID.ToNonAD().String()
	log.Printf("[PushName] %s -> %s", jid, evt.NewPushName)

	// Update contact push name
	contact, _ := p.repos.Contact.GetByJID(ctx, instance.AccountID, jid)
	if contact != nil {
		// Update the per-device name
		cdn := &domain.ContactDeviceName{
			ContactID: contact.ID,
			DeviceID:  instance.ID,
			PushName:  strPtr(evt.NewPushName),
		}
		_ = p.repos.ContactDeviceName.Upsert(ctx, cdn)
	}
}

// handleHistorySync processes history sync events
func (p *DevicePool) handleHistorySync(ctx context.Context, instance *DeviceInstance, evt *events.HistorySync) {
	log.Printf("[HistorySync] Received %d conversations", len(evt.Data.Conversations))
	// TODO: Process historical messages
}

// handleReaction processes incoming reaction messages
func (p *DevicePool) handleReaction(ctx context.Context, instance *DeviceInstance, evt *events.Message, reactionMsg *waE2E.ReactionMessage) {
	key := reactionMsg.GetKey()
	if key == nil {
		return
	}

	targetMsgID := key.GetID()
	emoji := reactionMsg.GetText()
	senderJID := evt.Info.Sender.ToNonAD().String()
	isFromMe := evt.Info.IsFromMe

	// Resolve chat JID
	chatJID := evt.Info.Chat.ToNonAD().String()
	if evt.Info.Chat.Server == types.HiddenUserServer {
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, evt.Info.Chat.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			chatJID = pnJID.User + "@s.whatsapp.net"
		}
	}

	// Get the chat
	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, chatJID, "")
	if err != nil {
		log.Printf("[Reaction] Failed to get chat: %v", err)
		return
	}

	if emoji == "" {
		// Remove reaction
		_ = p.repos.Reaction.Delete(ctx, chat.ID, targetMsgID, senderJID)
		log.Printf("[Reaction] %s removed reaction from %s", senderJID, targetMsgID)
	} else {
		// Upsert reaction
		reaction := &domain.MessageReaction{
			AccountID:       instance.AccountID,
			ChatID:          chat.ID,
			TargetMessageID: targetMsgID,
			SenderJID:       senderJID,
			SenderName:      strPtr(evt.Info.PushName),
			Emoji:           emoji,
			IsFromMe:        isFromMe,
			Timestamp:       evt.Info.Timestamp,
		}
		if err := p.repos.Reaction.Upsert(ctx, reaction); err != nil {
			log.Printf("[Reaction] Failed to save reaction: %v", err)
			return
		}
		log.Printf("[Reaction] %s reacted %s to %s", senderJID, emoji, targetMsgID)
	}

	// Broadcast to frontend
	p.hub.BroadcastToAccount(instance.AccountID, ws.EventMessageReaction, map[string]interface{}{
		"chat_id":           chat.ID.String(),
		"target_message_id": targetMsgID,
		"sender_jid":        senderJID,
		"sender_name":       evt.Info.PushName,
		"emoji":             emoji,
		"is_from_me":        isFromMe,
		"removed":           emoji == "",
	})
}

// handlePollCreation processes incoming poll creation messages
func (p *DevicePool) handlePollCreation(ctx context.Context, instance *DeviceInstance, evt *events.Message, pollMsg *waE2E.PollCreationMessage) {
	chatJID := evt.Info.Chat.ToNonAD().String()
	senderJID := evt.Info.Sender.ToNonAD().String()
	isFromMe := evt.Info.IsFromMe
	phone := evt.Info.Sender.ToNonAD().User

	if evt.Info.Chat.Server == types.HiddenUserServer {
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, evt.Info.Chat.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			chatJID = pnJID.User + "@s.whatsapp.net"
			phone = pnJID.User
		}
	}

	chatName := ""
	if !isFromMe {
		chatName = evt.Info.PushName
	}
	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, chatJID, chatName)
	if err != nil {
		log.Printf("[Poll] Failed to get/create chat: %v", err)
		return
	}

	question := pollMsg.GetName()
	var optionNames []string
	for _, opt := range pollMsg.GetOptions() {
		optionNames = append(optionNames, opt.GetOptionName())
	}
	maxSelections := int(pollMsg.GetSelectableOptionsCount())
	if maxSelections <= 0 {
		maxSelections = 1
	}

	// Build display body
	body := "📊 " + question
	for i, opt := range optionNames {
		body += fmt.Sprintf("\n%d. %s", i+1, opt)
	}

	msg := &domain.Message{
		AccountID:         instance.AccountID,
		DeviceID:          &instance.ID,
		ChatID:            chat.ID,
		MessageID:         evt.Info.ID,
		FromJID:           strPtr(senderJID),
		FromName:          strPtr(evt.Info.PushName),
		Body:              strPtr(body),
		MessageType:       strPtr(domain.MessageTypePoll),
		IsFromMe:          isFromMe,
		Status:            strPtr("received"),
		Timestamp:         evt.Info.Timestamp,
		PollQuestion:      strPtr(question),
		PollMaxSelections: maxSelections,
	}

	if err := p.repos.Message.Create(ctx, msg); err != nil {
		log.Printf("[Poll] Failed to save message: %v", err)
		return
	}

	// Create poll options
	if err := p.repos.Poll.CreateOptions(ctx, msg.ID, optionNames); err != nil {
		log.Printf("[Poll] Failed to save options: %v", err)
	}

	// Load options for response
	msg.PollOptions, _ = p.repos.Poll.GetOptions(ctx, msg.ID)

	_ = p.repos.Chat.UpdateLastMessage(ctx, chat.ID, "📊 "+question, evt.Info.Timestamp, !isFromMe)

	contactJID := senderJID
	if !isFromMe {
		contactJID = chatJID
	}
	p.repos.Contact.GetOrCreate(ctx, instance.AccountID, &instance.ID, contactJID, phone, evt.Info.PushName, evt.Info.PushName, false)

	p.hub.BroadcastNewMessage(instance.AccountID, map[string]interface{}{
		"chat_id":      chat.ID.String(),
		"message":      msg,
		"chat_jid":     chatJID,
		"sender_name":  evt.Info.PushName,
		"is_from_me":   isFromMe,
		"unread_count": chat.UnreadCount + 1,
	})

	log.Printf("[Poll] %s created poll: %s (%d options)", senderJID, question, len(optionNames))
}

// handlePollUpdate processes incoming poll vote updates
func (p *DevicePool) handlePollUpdate(ctx context.Context, instance *DeviceInstance, evt *events.Message, pollUpdate *waE2E.PollUpdateMessage) {
	chatJID := evt.Info.Chat.ToNonAD().String()
	if evt.Info.Chat.Server == types.HiddenUserServer {
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, evt.Info.Chat.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			chatJID = pnJID.User + "@s.whatsapp.net"
		}
	}

	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, chatJID, "")
	if err != nil {
		log.Printf("[PollVote] Failed to get chat: %v", err)
		return
	}

	// Get the poll message stanza ID from the vote's key
	pollKey := pollUpdate.GetPollCreationMessageKey()
	if pollKey == nil {
		log.Printf("[PollVote] No poll key in update")
		return
	}
	pollStanzaID := pollKey.GetID()

	// Decrypt poll vote
	decrypted, err := instance.Client.DecryptPollVote(ctx, evt)
	if err != nil {
		log.Printf("[PollVote] Failed to decrypt vote: %v", err)
		return
	}

	// Find the poll message in DB
	pollMsg, err := p.repos.Message.GetByMessageID(ctx, chat.ID, pollStanzaID)
	if err != nil || pollMsg == nil {
		log.Printf("[PollVote] Poll message not found: %s", pollStanzaID)
		return
	}

	// Match selected option hashes to option names
	// decrypted.GetSelectedOptions() returns SHA256 hashes of option names
	var selectedNames []string
	pollOptions, _ := p.repos.Poll.GetOptions(ctx, pollMsg.ID)

	for _, hashBytes := range decrypted.GetSelectedOptions() {
		for _, opt := range pollOptions {
			optHash := sha256.Sum256([]byte(opt.Name))
			if string(hashBytes) == string(optHash[:]) {
				selectedNames = append(selectedNames, opt.Name)
				break
			}
		}
	}

	voterJID := evt.Info.Sender.ToNonAD().String()
	vote := &domain.PollVote{
		MessageID:     pollMsg.ID,
		VoterJID:      voterJID,
		SelectedNames: selectedNames,
		Timestamp:     evt.Info.Timestamp,
	}
	if err := p.repos.Poll.UpsertVote(ctx, vote); err != nil {
		log.Printf("[PollVote] Failed to save vote: %v", err)
		return
	}

	// Recalculate vote counts
	_ = p.repos.Poll.RecalculateVoteCounts(ctx, pollMsg.ID)

	// Load updated data
	updatedOptions, _ := p.repos.Poll.GetOptions(ctx, pollMsg.ID)
	allVotes, _ := p.repos.Poll.GetVotes(ctx, pollMsg.ID)

	// Broadcast to frontend
	p.hub.BroadcastToAccount(instance.AccountID, ws.EventPollUpdate, map[string]interface{}{
		"chat_id":    chat.ID.String(),
		"message_id": pollMsg.MessageID,
		"options":    updatedOptions,
		"votes":      allVotes,
		"voter_jid":  voterJID,
	})

	log.Printf("[PollVote] %s voted on poll %s: %v", voterJID, pollStanzaID, selectedNames)
}

// syncContacts syncs all contacts from a WhatsApp device
func (p *DevicePool) syncContacts(ctx context.Context, instance *DeviceInstance) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[ContactSync] Panic for device %s: %v", instance.ID, r)
		}
	}()

	if instance.Client == nil || instance.Client.Store == nil || instance.Client.Store.Contacts == nil {
		log.Printf("[ContactSync] Device %s: no contact store available", instance.ID)
		return
	}

	allContacts, err := instance.Client.Store.Contacts.GetAllContacts(ctx)
	if err != nil {
		log.Printf("[ContactSync] Failed to get contacts for device %s: %v", instance.ID, err)
		return
	}

	log.Printf("[ContactSync] Device %s: syncing %d contacts", instance.ID, len(allContacts))

	synced := 0
	for jid, info := range allContacts {
		// Skip non-user contacts (groups, broadcasts, etc.)
		if jid.Server != "s.whatsapp.net" && jid.Server != types.HiddenUserServer {
			continue
		}

		normalizedJID := jid.ToNonAD().String()
		phone := jid.User

		// Resolve LID to phone JID if possible
		if jid.Server == types.HiddenUserServer {
			if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, jid.ToNonAD()); err == nil && !pnJID.IsEmpty() {
				normalizedJID = pnJID.User + "@s.whatsapp.net"
				phone = pnJID.User
			}
		}

		// Determine best name
		name := info.FullName
		if name == "" {
			name = info.FirstName
		}
		if name == "" {
			name = info.BusinessName
		}
		pushName := info.PushName

		// Get or create the contact
		contact, err := p.repos.Contact.GetOrCreate(ctx, instance.AccountID, &instance.ID, normalizedJID, phone, name, pushName, false)
		if err != nil {
			log.Printf("[ContactSync] Failed to upsert contact %s: %v", normalizedJID, err)
			continue
		}

		// Upsert the per-device name
		cdn := &domain.ContactDeviceName{
			ContactID: contact.ID,
			DeviceID:  instance.ID,
			Name:      strPtr(name),
			PushName:  strPtr(pushName),
		}
		if info.BusinessName != "" {
			cdn.BusinessName = strPtr(info.BusinessName)
		}
		_ = p.repos.ContactDeviceName.Upsert(ctx, cdn)

		synced++
	}

	log.Printf("[ContactSync] Device %s: synced %d contacts", instance.ID, synced)

	// Notify frontend that contacts were updated
	p.hub.BroadcastToAccount(instance.AccountID, "contacts_synced", map[string]interface{}{
		"device_id": instance.ID.String(),
		"count":     synced,
	})
}

// SyncDeviceContacts is a public method to trigger contact sync for a device
func (p *DevicePool) SyncDeviceContacts(ctx context.Context, deviceID uuid.UUID) error {
	p.mu.RLock()
	instance, exists := p.devices[deviceID]
	p.mu.RUnlock()

	if !exists || instance.Client == nil || !instance.Client.IsConnected() {
		return fmt.Errorf("device not connected: %s", deviceID)
	}

	go p.syncContacts(ctx, instance)
	return nil
}

// SendMessage sends a text message
func (p *DevicePool) SendMessage(ctx context.Context, deviceID uuid.UUID, to, body string) (*domain.Message, error) {
	p.mu.RLock()
	instance, exists := p.devices[deviceID]
	p.mu.RUnlock()

	if !exists || instance.Client == nil {
		return nil, fmt.Errorf("device not connected: %s", deviceID)
	}

	// Parse recipient JID
	jid, err := types.ParseJID(to)
	if err != nil {
		// Try to construct JID from phone number
		if !strings.Contains(to, "@") {
			jid = types.NewJID(to, types.DefaultUserServer)
		} else {
			return nil, fmt.Errorf("invalid JID: %s", to)
		}
	}

	// Create message
	msg := &waE2E.Message{
		Conversation: proto.String(body),
	}

	// Send message
	resp, err := instance.Client.SendMessage(ctx, jid, msg)
	if err != nil {
		return nil, fmt.Errorf("failed to send message: %w", err)
	}

	// Get or create chat using normalized JID (without device suffix)
	// Resolve @lid to @s.whatsapp.net for consistent chat identity
	normalizedJID := jid.ToNonAD().String()
	if jid.Server == types.HiddenUserServer {
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, jid.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			normalizedJID = pnJID.User + "@s.whatsapp.net"
			log.Printf("[SendMessage] Resolved LID %s -> %s", jid.ToNonAD().String(), normalizedJID)
		}
	}
	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, normalizedJID, "")
	if err != nil {
		return nil, fmt.Errorf("failed to get/create chat: %w", err)
	}

	// Create message record
	message := &domain.Message{
		AccountID:   instance.AccountID,
		DeviceID:    &instance.ID,
		ChatID:      chat.ID,
		MessageID:   resp.ID,
		FromJID:     strPtr(instance.JID),
		FromName:    strPtr("Me"),
		Body:        strPtr(body),
		MessageType: strPtr(domain.MessageTypeText),
		IsFromMe:    true,
		Status:      strPtr("sent"),
		Timestamp:   resp.Timestamp,
	}

	if err := p.repos.Message.Create(ctx, message); err != nil {
		log.Printf("[SendMessage] Failed to save message: %v", err)
	}

	// Update chat
	_ = p.repos.Chat.UpdateLastMessage(ctx, chat.ID, body, resp.Timestamp, false)

	// Broadcast to frontend
	p.hub.BroadcastToAccount(instance.AccountID, ws.EventMessageSent, map[string]interface{}{
		"chat_id": chat.ID.String(),
		"message": message,
	})

	return message, nil
}

// SendReplyMessage sends a text message as a reply to another message
func (p *DevicePool) SendReplyMessage(ctx context.Context, deviceID uuid.UUID, to, body, quotedID, quotedBody, quotedSender string, quotedIsFromMe bool) (*domain.Message, error) {
	p.mu.RLock()
	instance, exists := p.devices[deviceID]
	p.mu.RUnlock()

	if !exists || instance.Client == nil {
		return nil, fmt.Errorf("device not connected: %s", deviceID)
	}

	// Parse recipient JID
	jid, err := types.ParseJID(to)
	if err != nil {
		if !strings.Contains(to, "@") {
			jid = types.NewJID(to, types.DefaultUserServer)
		} else {
			return nil, fmt.Errorf("invalid JID: %s", to)
		}
	}

	// Build the quoted sender JID for ContextInfo
	var quotedParticipant *string
	if quotedSender != "" {
		quotedParticipant = proto.String(quotedSender)
	}

	// Build quoted message proto
	quotedMsg := &waE2E.Message{
		Conversation: proto.String(quotedBody),
	}

	// Create message with ContextInfo for reply
	msg := &waE2E.Message{
		ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: proto.String(body),
			ContextInfo: &waE2E.ContextInfo{
				StanzaID:      proto.String(quotedID),
				Participant:   quotedParticipant,
				QuotedMessage: quotedMsg,
			},
		},
	}

	// Send message
	resp, err := instance.Client.SendMessage(ctx, jid, msg)
	if err != nil {
		return nil, fmt.Errorf("failed to send reply: %w", err)
	}

	// Get or create chat
	normalizedJID := jid.ToNonAD().String()
	if jid.Server == types.HiddenUserServer {
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, jid.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			normalizedJID = pnJID.User + "@s.whatsapp.net"
		}
	}
	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, normalizedJID, "")
	if err != nil {
		return nil, fmt.Errorf("failed to get/create chat: %w", err)
	}

	// Create message record
	message := &domain.Message{
		AccountID:       instance.AccountID,
		DeviceID:        &instance.ID,
		ChatID:          chat.ID,
		MessageID:       resp.ID,
		FromJID:         strPtr(instance.JID),
		FromName:        strPtr("Me"),
		Body:            strPtr(body),
		MessageType:     strPtr(domain.MessageTypeText),
		IsFromMe:        true,
		Status:          strPtr("sent"),
		Timestamp:       resp.Timestamp,
		QuotedMessageID: strPtr(quotedID),
		QuotedBody:      strPtr(quotedBody),
		QuotedSender:    strPtr(quotedSender),
	}

	if err := p.repos.Message.Create(ctx, message); err != nil {
		log.Printf("[SendReplyMessage] Failed to save message: %v", err)
	}

	// Update chat
	_ = p.repos.Chat.UpdateLastMessage(ctx, chat.ID, body, resp.Timestamp, false)

	// Broadcast to frontend
	p.hub.BroadcastToAccount(instance.AccountID, ws.EventMessageSent, map[string]interface{}{
		"chat_id": chat.ID.String(),
		"message": message,
	})

	return message, nil
}

// ForwardMessage forwards a message to another chat
func (p *DevicePool) ForwardMessage(ctx context.Context, deviceID uuid.UUID, to string, originalMsg *domain.Message) (*domain.Message, error) {
	// If it has media, forward as media; otherwise forward as text
	if originalMsg.MediaURL != nil && *originalMsg.MediaURL != "" && originalMsg.MessageType != nil {
		body := ""
		if originalMsg.Body != nil {
			body = *originalMsg.Body
		}
		return p.SendMediaMessage(ctx, deviceID, to, body, *originalMsg.MediaURL, *originalMsg.MessageType)
	}

	body := ""
	if originalMsg.Body != nil {
		body = *originalMsg.Body
	}
	return p.SendMessage(ctx, deviceID, to, body)
}

// SendReaction sends a reaction emoji to a message
func (p *DevicePool) SendReaction(ctx context.Context, deviceID uuid.UUID, to, targetMessageID, emoji string) error {
	p.mu.RLock()
	instance, exists := p.devices[deviceID]
	p.mu.RUnlock()

	if !exists || instance.Client == nil {
		return fmt.Errorf("device not connected: %s", deviceID)
	}

	jid, err := types.ParseJID(to)
	if err != nil {
		if !strings.Contains(to, "@") {
			jid = types.NewJID(to, types.DefaultUserServer)
		} else {
			return fmt.Errorf("invalid JID: %s", to)
		}
	}

	msg := &waE2E.Message{
		ReactionMessage: &waE2E.ReactionMessage{
			Key: &waCommon.MessageKey{
				RemoteJID: proto.String(jid.String()),
				FromMe:    proto.Bool(false),
				ID:        proto.String(targetMessageID),
			},
			Text:              proto.String(emoji),
			SenderTimestampMS: proto.Int64(0),
		},
	}

	_, err = instance.Client.SendMessage(ctx, jid, msg)
	if err != nil {
		return fmt.Errorf("failed to send reaction: %w", err)
	}

	// Get chat for storing reaction
	normalizedJID := jid.ToNonAD().String()
	if jid.Server == types.HiddenUserServer {
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, jid.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			normalizedJID = pnJID.User + "@s.whatsapp.net"
		}
	}
	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, normalizedJID, "")
	if err != nil {
		return err
	}

	senderJID := instance.JID
	if emoji == "" {
		_ = p.repos.Reaction.Delete(ctx, chat.ID, targetMessageID, senderJID)
	} else {
		reaction := &domain.MessageReaction{
			AccountID:       instance.AccountID,
			ChatID:          chat.ID,
			TargetMessageID: targetMessageID,
			SenderJID:       senderJID,
			SenderName:      strPtr("Me"),
			Emoji:           emoji,
			IsFromMe:        true,
			Timestamp:       time.Now(),
		}
		_ = p.repos.Reaction.Upsert(ctx, reaction)
	}

	// Broadcast
	p.hub.BroadcastToAccount(instance.AccountID, ws.EventMessageReaction, map[string]interface{}{
		"chat_id":           chat.ID.String(),
		"target_message_id": targetMessageID,
		"sender_jid":        senderJID,
		"sender_name":       "Me",
		"emoji":             emoji,
		"is_from_me":        true,
		"removed":           emoji == "",
	})

	log.Printf("[Reaction] Sent %s to %s on %s", emoji, targetMessageID, to)
	return nil
}

// SendPoll sends a poll creation message
func (p *DevicePool) SendPoll(ctx context.Context, deviceID uuid.UUID, to, question string, options []string, maxSelections int) (*domain.Message, error) {
	p.mu.RLock()
	instance, exists := p.devices[deviceID]
	p.mu.RUnlock()

	if !exists || instance.Client == nil {
		return nil, fmt.Errorf("device not connected: %s", deviceID)
	}

	jid, err := types.ParseJID(to)
	if err != nil {
		if !strings.Contains(to, "@") {
			jid = types.NewJID(to, types.DefaultUserServer)
		} else {
			return nil, fmt.Errorf("invalid JID: %s", to)
		}
	}

	if maxSelections <= 0 {
		maxSelections = 1
	}

	var pollOptions []*waE2E.PollCreationMessage_Option
	for _, opt := range options {
		pollOptions = append(pollOptions, &waE2E.PollCreationMessage_Option{
			OptionName: proto.String(opt),
		})
	}

	msg := &waE2E.Message{
		PollCreationMessage: &waE2E.PollCreationMessage{
			Name:                   proto.String(question),
			Options:                pollOptions,
			SelectableOptionsCount: proto.Uint32(uint32(maxSelections)),
		},
	}

	resp, err := instance.Client.SendMessage(ctx, jid, msg)
	if err != nil {
		return nil, fmt.Errorf("failed to send poll: %w", err)
	}

	// Build display body
	body := "📊 " + question
	for i, opt := range options {
		body += fmt.Sprintf("\n%d. %s", i+1, opt)
	}

	// Get or create chat
	normalizedJID := jid.ToNonAD().String()
	if jid.Server == types.HiddenUserServer {
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, jid.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			normalizedJID = pnJID.User + "@s.whatsapp.net"
		}
	}
	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, normalizedJID, "")
	if err != nil {
		return nil, fmt.Errorf("failed to get/create chat: %w", err)
	}

	message := &domain.Message{
		AccountID:         instance.AccountID,
		DeviceID:          &instance.ID,
		ChatID:            chat.ID,
		MessageID:         resp.ID,
		FromJID:           strPtr(instance.JID),
		FromName:          strPtr("Me"),
		Body:              strPtr(body),
		MessageType:       strPtr(domain.MessageTypePoll),
		IsFromMe:          true,
		Status:            strPtr("sent"),
		Timestamp:         resp.Timestamp,
		PollQuestion:      strPtr(question),
		PollMaxSelections: maxSelections,
	}

	if err := p.repos.Message.Create(ctx, message); err != nil {
		log.Printf("[SendPoll] Failed to save message: %v", err)
	}

	// Create poll options
	_ = p.repos.Poll.CreateOptions(ctx, message.ID, options)

	// Load options for response
	message.PollOptions, _ = p.repos.Poll.GetOptions(ctx, message.ID)

	_ = p.repos.Chat.UpdateLastMessage(ctx, chat.ID, "📊 "+question, resp.Timestamp, false)

	// Broadcast
	p.hub.BroadcastToAccount(instance.AccountID, ws.EventMessageSent, map[string]interface{}{
		"chat_id": chat.ID.String(),
		"message": message,
	})

	log.Printf("[SendPoll] Sent poll '%s' to %s", question, to)
	return message, nil
}

// publicToProxyURL converts a MinIO public URL to a backend proxy URL
func (p *DevicePool) publicToProxyURL(publicURL string) string {
	if strings.HasPrefix(publicURL, "/api/media/") {
		return publicURL // Already a proxy URL
	}
	// Extract path after bucket name: https://host/bucket/objectKey -> /api/media/file/objectKey
	bucketPrefix := fmt.Sprintf("%s/%s/", p.cfg.MinioPublicURL, p.cfg.MinioBucket)
	if strings.HasPrefix(publicURL, bucketPrefix) {
		objectPath := strings.TrimPrefix(publicURL, bucketPrefix)
		return "/api/media/file/" + objectPath
	}
	// Fallback: try to find bucket name in URL
	marker := "/" + p.cfg.MinioBucket + "/"
	if idx := strings.Index(publicURL, marker); idx >= 0 {
		objectPath := publicURL[idx+len(marker):]
		return "/api/media/file/" + objectPath
	}
	return publicURL
}

// SendMediaMessage sends a media message (image, video, audio, document)
func (p *DevicePool) SendMediaMessage(ctx context.Context, deviceID uuid.UUID, to, caption, mediaURL, mediaType string) (*domain.Message, error) {
	p.mu.RLock()
	instance, exists := p.devices[deviceID]
	p.mu.RUnlock()

	if !exists || instance.Client == nil {
		return nil, fmt.Errorf("device not connected: %s", deviceID)
	}

	// Parse recipient JID
	jid, err := types.ParseJID(to)
	if err != nil {
		if !strings.Contains(to, "@") {
			jid = types.NewJID(to, types.DefaultUserServer)
		} else {
			return nil, fmt.Errorf("invalid JID: %s", to)
		}
	}

	// Download media - handle proxy URLs and public URLs
	var data []byte
	var mimetype string

	if strings.HasPrefix(mediaURL, "/api/media/file/") {
		// Proxy URL: read directly from MinIO storage
		objectKey := strings.TrimPrefix(mediaURL, "/api/media/file/")
		log.Printf("[SendMediaMessage] Reading from storage: %s", objectKey)
		var err2 error
		data, err2 = p.storage.GetFile(ctx, objectKey)
		if err2 != nil {
			return nil, fmt.Errorf("failed to read media from storage: %w", err2)
		}
		// Detect mimetype from extension
		mimetype = "application/octet-stream"
		if dotIdx := strings.LastIndex(objectKey, "."); dotIdx >= 0 {
			ext := strings.ToLower(objectKey[dotIdx:])
			switch ext {
			case ".jpg", ".jpeg":
				mimetype = "image/jpeg"
			case ".png":
				mimetype = "image/png"
			case ".gif":
				mimetype = "image/gif"
			case ".webp":
				mimetype = "image/webp"
			case ".mp4":
				mimetype = "video/mp4"
			case ".webm":
				mimetype = "video/webm"
			case ".mp3":
				mimetype = "audio/mpeg"
			case ".ogg":
				mimetype = "audio/ogg"
			case ".pdf":
				mimetype = "application/pdf"
			}
		}
	} else {
		// Public or external URL: download via HTTP
		downloadURL := mediaURL
		if p.cfg.MinioPublicURL != "" && p.cfg.MinioEndpoint != "" {
			scheme := "http"
			if p.cfg.MinioUseSSL {
				scheme = "https"
			}
			internalURL := fmt.Sprintf("%s://%s", scheme, p.cfg.MinioEndpoint)
			downloadURL = strings.Replace(mediaURL, p.cfg.MinioPublicURL, internalURL, 1)
			log.Printf("[SendMediaMessage] Converted URL: %s -> %s", mediaURL, downloadURL)
		}
		resp, err := http.Get(downloadURL)
		if err != nil {
			return nil, fmt.Errorf("failed to download media: Get %q: %w", downloadURL, err)
		}
		defer resp.Body.Close()
		var err2 error
		data, err2 = io.ReadAll(resp.Body)
		if err2 != nil {
			return nil, fmt.Errorf("failed to read media: %w", err2)
		}
		mimetype = resp.Header.Get("Content-Type")
		if mimetype == "" {
			mimetype = "application/octet-stream"
		}
	}

	// Determine the correct WhatsApp media type for upload
	var waMediaType whatsmeow.MediaType
	switch mediaType {
	case domain.MessageTypeImage:
		waMediaType = whatsmeow.MediaImage
	case domain.MessageTypeVideo:
		waMediaType = whatsmeow.MediaVideo
	case domain.MessageTypeAudio:
		waMediaType = whatsmeow.MediaAudio
	case domain.MessageTypeDocument:
		waMediaType = whatsmeow.MediaDocument
	case domain.MessageTypeSticker:
		waMediaType = whatsmeow.MediaImage
	default:
		return nil, fmt.Errorf("unsupported media type: %s", mediaType)
	}

	// Upload to WhatsApp with the correct media type
	uploaded, err := instance.Client.Upload(ctx, data, waMediaType)
	if err != nil {
		return nil, fmt.Errorf("failed to upload to WhatsApp: %w", err)
	}

	var msg *waE2E.Message

	switch mediaType {
	case domain.MessageTypeImage:
		msg = &waE2E.Message{
			ImageMessage: &waE2E.ImageMessage{
				URL:           proto.String(uploaded.URL),
				DirectPath:    proto.String(uploaded.DirectPath),
				MediaKey:      uploaded.MediaKey,
				Mimetype:      proto.String(mimetype),
				FileEncSHA256: uploaded.FileEncSHA256,
				FileSHA256:    uploaded.FileSHA256,
				FileLength:    proto.Uint64(uint64(len(data))),
				Caption:       proto.String(caption),
			},
		}
	case domain.MessageTypeVideo:
		msg = &waE2E.Message{
			VideoMessage: &waE2E.VideoMessage{
				URL:           proto.String(uploaded.URL),
				DirectPath:    proto.String(uploaded.DirectPath),
				MediaKey:      uploaded.MediaKey,
				Mimetype:      proto.String(mimetype),
				FileEncSHA256: uploaded.FileEncSHA256,
				FileSHA256:    uploaded.FileSHA256,
				FileLength:    proto.Uint64(uint64(len(data))),
				Caption:       proto.String(caption),
			},
		}
	case domain.MessageTypeAudio:
		msg = &waE2E.Message{
			AudioMessage: &waE2E.AudioMessage{
				URL:           proto.String(uploaded.URL),
				DirectPath:    proto.String(uploaded.DirectPath),
				MediaKey:      uploaded.MediaKey,
				Mimetype:      proto.String(mimetype),
				FileEncSHA256: uploaded.FileEncSHA256,
				FileSHA256:    uploaded.FileSHA256,
				FileLength:    proto.Uint64(uint64(len(data))),
				PTT:           proto.Bool(true),
			},
		}
	case domain.MessageTypeDocument:
		filename := filepath.Base(mediaURL)
		msg = &waE2E.Message{
			DocumentMessage: &waE2E.DocumentMessage{
				URL:           proto.String(uploaded.URL),
				DirectPath:    proto.String(uploaded.DirectPath),
				MediaKey:      uploaded.MediaKey,
				Mimetype:      proto.String(mimetype),
				FileEncSHA256: uploaded.FileEncSHA256,
				FileSHA256:    uploaded.FileSHA256,
				FileLength:    proto.Uint64(uint64(len(data))),
				FileName:      proto.String(filename),
				Caption:       proto.String(caption),
			},
		}
	case domain.MessageTypeSticker:
		msg = &waE2E.Message{
			StickerMessage: &waE2E.StickerMessage{
				URL:           proto.String(uploaded.URL),
				DirectPath:    proto.String(uploaded.DirectPath),
				MediaKey:      uploaded.MediaKey,
				Mimetype:      proto.String("image/webp"),
				FileEncSHA256: uploaded.FileEncSHA256,
				FileSHA256:    uploaded.FileSHA256,
				FileLength:    proto.Uint64(uint64(len(data))),
			},
		}
	}

	// Send message
	sendResp, err := instance.Client.SendMessage(ctx, jid, msg)
	if err != nil {
		return nil, fmt.Errorf("failed to send message: %w", err)
	}

	// Get or create chat using normalized JID (without device suffix)
	// Resolve @lid to @s.whatsapp.net for consistent chat identity
	normalizedJID := jid.ToNonAD().String()
	if jid.Server == types.HiddenUserServer {
		if pnJID, err := p.store.LIDMap.GetPNForLID(ctx, jid.ToNonAD()); err == nil && !pnJID.IsEmpty() {
			normalizedJID = pnJID.User + "@s.whatsapp.net"
			log.Printf("[SendMediaMessage] Resolved LID %s -> %s", jid.ToNonAD().String(), normalizedJID)
		}
	}
	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, normalizedJID, "")
	if err != nil {
		return nil, fmt.Errorf("failed to get/create chat: %w", err)
	}

	// Create message record - store proxy URL for reliable frontend display
	proxyMediaURL := p.publicToProxyURL(mediaURL)
	size := int64(len(data))
	message := &domain.Message{
		AccountID:     instance.AccountID,
		DeviceID:      &instance.ID,
		ChatID:        chat.ID,
		MessageID:     sendResp.ID,
		FromJID:       strPtr(instance.JID),
		FromName:      strPtr("Me"),
		Body:          strPtr(caption),
		MessageType:   strPtr(mediaType),
		MediaURL:      strPtr(proxyMediaURL),
		MediaMimetype: strPtr(mimetype),
		MediaSize:     &size,
		IsFromMe:      true,
		Status:        strPtr("sent"),
		Timestamp:     sendResp.Timestamp,
	}

	if err := p.repos.Message.Create(ctx, message); err != nil {
		log.Printf("[SendMediaMessage] Failed to save message: %v", err)
	}

	// Update chat
	lastMsg := caption
	if lastMsg == "" {
		lastMsg = fmt.Sprintf("[%s]", mediaType)
	}
	_ = p.repos.Chat.UpdateLastMessage(ctx, chat.ID, lastMsg, sendResp.Timestamp, false)

	// Broadcast to frontend
	p.hub.BroadcastToAccount(instance.AccountID, ws.EventMessageSent, map[string]interface{}{
		"chat_id": chat.ID.String(),
		"message": message,
	})

	log.Printf("[SendMediaMessage] %s -> %s: [%s]", instance.JID, jid.String(), mediaType)
	return message, nil
}

// GetDevice returns a device instance by ID
func (p *DevicePool) GetDevice(deviceID uuid.UUID) *DeviceInstance {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.devices[deviceID]
}

// GetDeviceStatus returns the status of a device
func (p *DevicePool) GetDeviceStatus(deviceID uuid.UUID) string {
	p.mu.RLock()
	instance, exists := p.devices[deviceID]
	p.mu.RUnlock()

	if !exists {
		return domain.DeviceStatusDisconnected
	}

	instance.mu.RLock()
	defer instance.mu.RUnlock()
	return instance.Status
}

// GetQRCode returns the current QR code for a device
func (p *DevicePool) GetQRCode(deviceID uuid.UUID) string {
	p.mu.RLock()
	instance, exists := p.devices[deviceID]
	p.mu.RUnlock()

	if !exists {
		return ""
	}

	instance.mu.RLock()
	defer instance.mu.RUnlock()
	return instance.QRCode
}

// DisconnectDevice disconnects a device
func (p *DevicePool) DisconnectDevice(ctx context.Context, deviceID uuid.UUID) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	instance, exists := p.devices[deviceID]
	if !exists {
		return nil
	}

	if instance.Client != nil {
		instance.Client.Disconnect()
	}

	instance.mu.Lock()
	instance.Status = domain.DeviceStatusDisconnected
	instance.mu.Unlock()

	_ = p.repos.Device.UpdateStatus(ctx, deviceID, domain.DeviceStatusDisconnected)

	return nil
}

// DeleteDevice removes a device completely
func (p *DevicePool) DeleteDevice(ctx context.Context, deviceID uuid.UUID) error {
	// First disconnect
	_ = p.DisconnectDevice(ctx, deviceID)

	p.mu.Lock()
	instance, exists := p.devices[deviceID]
	if exists {
		if instance.Client != nil {
			instance.Client.Logout(ctx)
		}
		delete(p.devices, deviceID)
	}
	p.mu.Unlock()

	// Delete from database
	return p.repos.Device.Delete(ctx, deviceID)
}

// Shutdown closes all connections gracefully
func (p *DevicePool) Shutdown() {
	p.mu.Lock()
	defer p.mu.Unlock()

	for id, instance := range p.devices {
		if instance.Client != nil {
			instance.Client.Disconnect()
		}
		log.Printf("[DevicePool] Disconnected device %s", id)
	}
}

// GetConnectedCount returns the number of connected devices
func (p *DevicePool) GetConnectedCount() int {
	p.mu.RLock()
	defer p.mu.RUnlock()

	count := 0
	for _, instance := range p.devices {
		if instance.Client != nil && instance.Client.IsConnected() {
			count++
		}
	}
	return count
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
