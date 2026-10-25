package whatsapp

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
	"log"
	"time"
)

func (p *DevicePool) broadcastIdentityRevision(ctx context.Context, accountID, deviceID uuid.UUID) {
	if p == nil || p.hub == nil || p.repos == nil || p.repos.Chat == nil {
		return
	}
	revision, err := p.repos.Chat.WhatsAppIdentityRevision(ctx, accountID, deviceID)
	if err != nil {
		log.Printf("[PeerIdentity] revision notice unavailable account=%s device=%s", accountID, deviceID)
		return
	}
	p.hub.BroadcastToAccountWithAnyPermission(accountID, []string{domain.PermChats, domain.PermReports}, ws.EventWhatsAppIdentityUpdated, map[string]interface{}{"device_id": deviceID, "identity_revision": revision})
}

// A committed CRM trigger can be written from any module or background worker.
// Observe only its aggregate revision so Reports subscribers need no CRM data
// permission and never receive Contact fields. Export still validates directly.
func (p *DevicePool) broadcastCRMIdentityRevisions(ctx context.Context, seen map[uuid.UUID]int64) {
	if p == nil || p.hub == nil || p.repos == nil || p.repos.Chat == nil {
		return
	}
	accounts := map[uuid.UUID]bool{}
	p.mu.RLock()
	for _, device := range p.devices {
		if device != nil {
			accounts[device.AccountID] = true
		}
	}
	p.mu.RUnlock()
	for accountID := range accounts {
		if ctx.Err() != nil {
			return
		}
		if !p.GroupsEnabledForAccount(accountID) {
			continue
		}
		readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		revision, err := p.repos.Chat.CRMRevision(readCtx, accountID)
		cancel()
		if err != nil {
			continue
		}
		if advanceCRMIdentityRevision(seen, accountID, revision) {
			p.hub.BroadcastToAccountWithAnyPermission(accountID, []string{domain.PermChats, domain.PermReports}, ws.EventWhatsAppCRMIdentityUpdated, map[string]interface{}{"crm_identity_revision": revision})
		}
	}
}

func advanceCRMIdentityRevision(seen map[uuid.UUID]int64, accountID uuid.UUID, revision int64) bool {
	previous, exists := seen[accountID]
	if revision < 0 || (exists && revision <= previous) {
		return false
	}
	seen[accountID] = revision
	return exists
}
