package ws

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
)

const (
	// Time allowed to write a message to the peer
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer
	pongWait = 60 * time.Second

	// Send pings to peer with this interval (must be < pongWait)
	pingInterval = 30 * time.Second
)

// Event types for WebSocket communication
const (
	EventNewMessage       = "new_message"
	EventMessageSent      = "message_sent"
	EventMessageStatus    = "message_status"
	EventDeviceStatus     = "device_status"
	EventQRCode           = "qr_code"
	EventChatUpdate       = "chat_update"
	EventPresence         = "presence"
	EventTyping           = "typing"
	EventLeadUpdate       = "lead_update"
	EventNotification     = "notification"
	EventMessageReaction  = "message_reaction"
	EventPollUpdate       = "poll_update"
)

// Message represents a WebSocket message
type Message struct {
	Event     string      `json:"event"`
	AccountID string      `json:"account_id,omitempty"`
	DeviceID  string      `json:"device_id,omitempty"`
	Data      interface{} `json:"data"`
}

// Client represents a connected WebSocket client
type Client struct {
	ID        string
	AccountID uuid.UUID
	UserID    uuid.UUID
	Conn      *websocket.Conn
	Send      chan []byte
	Hub       *Hub
}

// Hub maintains the set of active clients and broadcasts messages
type Hub struct {
	// Registered clients
	clients map[*Client]bool

	// Clients indexed by account ID for targeted broadcasts
	accountClients map[uuid.UUID]map[*Client]bool

	// Inbound messages from clients
	broadcast chan *Message

	// Register requests from clients
	register chan *Client

	// Unregister requests from clients
	unregister chan *Client

	// Mutex for thread-safe operations
	mu sync.RWMutex
}

// NewHub creates a new Hub instance
func NewHub() *Hub {
	return &Hub{
		clients:        make(map[*Client]bool),
		accountClients: make(map[uuid.UUID]map[*Client]bool),
		broadcast:      make(chan *Message, 256),
		register:       make(chan *Client),
		unregister:     make(chan *Client),
	}
}

// Run starts the hub's main loop
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			if _, ok := h.accountClients[client.AccountID]; !ok {
				h.accountClients[client.AccountID] = make(map[*Client]bool)
			}
			h.accountClients[client.AccountID][client] = true
			h.mu.Unlock()
			log.Printf("[WS Hub] Client registered: %s (Account: %s)", client.ID, client.AccountID)

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				if accountClients, ok := h.accountClients[client.AccountID]; ok {
					delete(accountClients, client)
					if len(accountClients) == 0 {
						delete(h.accountClients, client.AccountID)
					}
				}
				close(client.Send)
			}
			h.mu.Unlock()
			log.Printf("[WS Hub] Client unregistered: %s", client.ID)

		case message := <-h.broadcast:
			h.broadcastMessage(message)
		}
	}
}

// broadcastMessage sends a message to relevant clients
func (h *Hub) broadcastMessage(msg *Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[WS Hub] Error marshaling message: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	// If AccountID is specified, only send to that account's clients
	if msg.AccountID != "" {
		accountID, err := uuid.Parse(msg.AccountID)
		if err == nil {
			if clients, ok := h.accountClients[accountID]; ok {
				for client := range clients {
					select {
					case client.Send <- data:
					default:
						// Client buffer full, remove it
						go func(c *Client) {
							h.unregister <- c
						}(client)
					}
				}
			}
		}
		return
	}

	// Broadcast to all clients
	for client := range h.clients {
		select {
		case client.Send <- data:
		default:
			go func(c *Client) {
				h.unregister <- c
			}(client)
		}
	}
}

// Register adds a client to the hub
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Unregister removes a client from the hub
func (h *Hub) Unregister(client *Client) {
	h.unregister <- client
}

// Broadcast sends a message to all clients or specific account clients
func (h *Hub) Broadcast(msg *Message) {
	h.broadcast <- msg
}

// BroadcastToAccount sends a message to all clients of a specific account
func (h *Hub) BroadcastToAccount(accountID uuid.UUID, event string, data interface{}) {
	h.broadcast <- &Message{
		Event:     event,
		AccountID: accountID.String(),
		Data:      data,
	}
}

// BroadcastDeviceStatus sends device status update to account clients
func (h *Hub) BroadcastDeviceStatus(accountID, deviceID uuid.UUID, status string, qrCode string) {
	h.BroadcastToAccount(accountID, EventDeviceStatus, map[string]interface{}{
		"device_id": deviceID.String(),
		"status":    status,
		"qr_code":   qrCode,
	})
}

// BroadcastNewMessage sends new message notification to account clients
func (h *Hub) BroadcastNewMessage(accountID uuid.UUID, message interface{}) {
	h.BroadcastToAccount(accountID, EventNewMessage, message)
}

// BroadcastQRCode sends QR code to account clients
func (h *Hub) BroadcastQRCode(accountID, deviceID uuid.UUID, qrCode string) {
	h.BroadcastToAccount(accountID, EventQRCode, map[string]interface{}{
		"device_id": deviceID.String(),
		"qr_code":   qrCode,
	})
}

// GetClientCount returns the total number of connected clients
func (h *Hub) GetClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// GetAccountClientCount returns the number of clients for a specific account
func (h *Hub) GetAccountClientCount(accountID uuid.UUID) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if clients, ok := h.accountClients[accountID]; ok {
		return len(clients)
	}
	return 0
}

// ReadPump reads messages from the WebSocket connection
func (c *Client) ReadPump() {
	defer func() {
		c.Hub.Unregister(c)
		c.Conn.Close()
	}()

	// Set read deadline — reset on every pong
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure, websocket.CloseNoStatusReceived) {
				log.Printf("[WS Client] Read error: %v", err)
			}
			break
		}

		// Handle incoming messages from client
		var msg Message
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("[WS Client] Invalid message format: %v", err)
			continue
		}

		// Process client message (e.g., typing indicators, read receipts)
		c.handleMessage(&msg)
	}
}

// WritePump writes messages to the WebSocket connection
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub closed the channel
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
				log.Printf("[WS Client] Write error: %v", err)
				return
			}

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("[WS Client] Ping error: %v", err)
				return
			}
		}
	}
}

// handleMessage processes incoming messages from the client
func (c *Client) handleMessage(msg *Message) {
	switch msg.Event {
	case EventTyping:
		// Broadcast typing indicator to other clients
		c.Hub.BroadcastToAccount(c.AccountID, EventTyping, msg.Data)
	case "ping":
		// Respond to ping with pong
		c.Send <- []byte(`{"event":"pong"}`)
	default:
		log.Printf("[WS Client] Unknown event: %s", msg.Event)
	}
}
