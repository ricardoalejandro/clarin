package whatsapp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/contactavatar"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

const profilePictureTimeout = 12 * time.Second

type ProfilePictureError struct {
	Code string
	Err  error
}

func (e *ProfilePictureError) Error() string {
	if e == nil || e.Err == nil {
		return "WhatsApp profile picture unavailable"
	}
	return e.Err.Error()
}

func profilePictureError(code, message string) error {
	return &ProfilePictureError{Code: code, Err: fmt.Errorf("%s", message)}
}

func ProfilePictureErrorCode(err error) string {
	if typed, ok := err.(*ProfilePictureError); ok && typed.Code != "" {
		return typed.Code
	}
	return "whatsapp_photo_unavailable"
}

func (p *DevicePool) ConnectedAvatarDeviceIDs(accountID uuid.UUID) []uuid.UUID {
	p.mu.RLock()
	defer p.mu.RUnlock()
	ids := make([]uuid.UUID, 0)
	for id, instance := range p.devices {
		if instance == nil || instance.AccountID != accountID || instance.Client == nil || !instance.Client.IsConnected() {
			continue
		}
		ids = append(ids, id)
	}
	return ids
}

// FetchProfilePicture retrieves the current WhatsApp profile picture without
// persisting it. The API uses this to provide an explicit compare-and-confirm
// step before replacing the Contact photo.
func (p *DevicePool) FetchProfilePicture(ctx context.Context, accountID, deviceID uuid.UUID, contactJID string) ([]byte, error) {
	instance := p.GetDevice(deviceID)
	if instance == nil || instance.AccountID != accountID {
		return nil, profilePictureError("device_not_found", "El dispositivo no pertenece a esta cuenta")
	}
	if instance.Client == nil || !instance.Client.IsConnected() {
		return nil, profilePictureError("device_disconnected", "El dispositivo de WhatsApp está desconectado")
	}
	jid, err := types.ParseJID(strings.TrimSpace(contactJID))
	if err != nil || jid.IsEmpty() {
		return nil, profilePictureError("contact_without_whatsapp", "El contacto no tiene una identidad de WhatsApp válida")
	}
	jid = jid.ToNonAD()
	if jid.Server == types.HiddenUserServer && p.store != nil && p.store.LIDMap != nil {
		if pnJID, resolveErr := p.store.LIDMap.GetPNForLID(ctx, jid); resolveErr == nil && !pnJID.IsEmpty() {
			jid = pnJID.ToNonAD()
		}
	}
	if jid.Server != types.DefaultUserServer {
		return nil, profilePictureError("contact_without_whatsapp", "La foto solo está disponible para contactos individuales de WhatsApp")
	}

	fetchCtx, cancel := context.WithTimeout(ctx, profilePictureTimeout)
	defer cancel()
	picture, err := instance.Client.GetProfilePictureInfo(fetchCtx, jid, &whatsmeow.GetProfilePictureParams{})
	if err != nil || picture == nil || strings.TrimSpace(picture.URL) == "" {
		return nil, profilePictureError("whatsapp_photo_not_set", "WhatsApp no devolvió una foto visible para este contacto")
	}
	pictureURL, err := url.Parse(strings.TrimSpace(picture.URL))
	if err != nil || pictureURL.Scheme != "https" || pictureURL.Hostname() == "" {
		return nil, profilePictureError("whatsapp_photo_unavailable", "WhatsApp devolvió una ubicación de foto inválida")
	}

	request, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, pictureURL.String(), nil)
	if err != nil {
		return nil, profilePictureError("whatsapp_photo_unavailable", "No se pudo preparar la descarga de la foto")
	}
	client := &http.Client{
		Timeout: profilePictureTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 || req.URL.Scheme != "https" {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, profilePictureError("whatsapp_photo_unavailable", "No se pudo descargar la foto de WhatsApp")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, profilePictureError("whatsapp_photo_unavailable", "WhatsApp rechazó la descarga de la foto")
	}
	if response.ContentLength > contactavatar.MaxInputBytes {
		return nil, profilePictureError("whatsapp_photo_invalid", "La foto de WhatsApp supera el tamaño permitido")
	}
	limited := io.LimitReader(response.Body, contactavatar.MaxInputBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil || len(data) == 0 {
		return nil, profilePictureError("whatsapp_photo_unavailable", "La foto de WhatsApp no pudo leerse")
	}
	if len(data) > contactavatar.MaxInputBytes {
		return nil, profilePictureError("whatsapp_photo_invalid", "La foto de WhatsApp supera el tamaño permitido")
	}
	return data, nil
}

// FetchInitialContactAvatar is intentionally invoked only from a Contact
// creation flow. ClaimAutomaticFetch makes the behavior one-shot even when
// duplicate events race. Save(OnlyIfEmpty) prevents a late automatic request
// from overwriting a manual upload.
func (p *DevicePool) FetchInitialContactAvatar(instance *DeviceInstance, contactID uuid.UUID, contactJID string) {
	if p == nil || instance == nil || p.repos == nil || p.repos.ContactAvatar == nil || p.storage == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), profilePictureTimeout+5*time.Second)
	defer cancel()
	claimed, err := p.repos.ContactAvatar.ClaimAutomaticFetch(ctx, instance.AccountID, contactID)
	if err != nil || !claimed {
		return
	}
	raw, err := p.FetchProfilePicture(ctx, instance.AccountID, instance.ID, contactJID)
	if err != nil {
		_ = p.repos.ContactAvatar.MarkWhatsAppCheck(ctx, instance.AccountID, contactID, ProfilePictureErrorCode(err))
		return
	}
	normalized, err := contactavatar.Normalize(raw)
	if err != nil {
		_ = p.repos.ContactAvatar.MarkWhatsAppCheck(ctx, instance.AccountID, contactID, "whatsapp_photo_invalid")
		return
	}
	record, err := p.repos.ContactAvatar.Save(ctx, p.storage, instance.AccountID, contactID, "whatsapp", normalized, repository.SaveContactAvatarOptions{OnlyIfEmpty: true})
	if err != nil || record == nil || record.AvatarURL == nil {
		return
	}
	p.invalidateChatCaches(instance.AccountID, uuid.Nil)
	if p.cache != nil {
		_ = p.cache.DelPattern(context.Background(), "contacts:"+instance.AccountID.String()+":*")
	}
	if p.hub != nil {
		payload := map[string]interface{}{
			"action":        "avatar_updated",
			"contact_id":    contactID,
			"jid":           contactJID,
			"avatar_url":    record.AvatarURL,
			"revision":      record.Revision,
			"avatar_source": "whatsapp",
		}
		p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermContacts, ws.EventContactUpdate, payload)
		p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, ws.EventChatUpdate, payload)
		p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermLeads, ws.EventContactUpdate, payload)
		p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermEvents, ws.EventContactUpdate, payload)
		p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermPrograms, ws.EventContactUpdate, payload)
	}
}
