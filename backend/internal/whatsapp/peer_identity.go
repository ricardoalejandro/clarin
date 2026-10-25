package whatsapp

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waLidMigrationSyncPayload"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func peerObservation(jid, alt types.JID, source string, at *time.Time, fields map[string]string) domain.WhatsAppPeerObservation {
	jid, alt = normalizePeerWireJID(jid), normalizePeerWireJID(alt)
	if at != nil && at.IsZero() {
		at = nil
	}
	out := domain.WhatsAppPeerObservation{JID: jid.ToNonAD().String(), Source: source, ObservedAt: at, ReceivedAt: time.Now().UTC(), Fields: fields}
	for _, address := range []types.JID{jid, alt} {
		address = address.ToNonAD()
		if address.Server == types.DefaultUserServer {
			out.PN = address.String()
		} else if address.Server == types.HiddenUserServer {
			out.LID = address.String()
		}
	}
	return out
}

// Persistence errors are observable by recovery epochs as well as direct callers.
func (p *DevicePool) observePeerIdentities(ctx context.Context, instance *DeviceInstance, observations []domain.WhatsAppPeerObservation) error {
	fingerprint := ""
	if instance != nil && instance.Client != nil {
		fingerprint = deviceSessionFingerprint(instance.Client.Store)
	}
	return p.observePeerIdentitiesForSession(ctx, instance, fingerprint, observations)
}

func (p *DevicePool) observePeerIdentitiesForSession(ctx context.Context, instance *DeviceInstance, fingerprint string, observations []domain.WhatsAppPeerObservation) (resultErr error) {
	defer func() {
		recordPeerIdentityPersistence(instance, resultErr)
		if resultErr != nil && instance != nil {
			log.Printf("[PeerIdentity] persistence failed account=%s device=%s: %v", instance.AccountID, instance.ID, resultErr)
		}
	}()
	if len(observations) == 0 {
		return nil
	}
	if p == nil || p.repos == nil || p.repos.Chat == nil || instance == nil || fingerprint == "" {
		return fmt.Errorf("identity persistence unavailable")
	}
	if err := p.requirePeerIdentitySession(instance, fingerprint); err != nil {
		return err
	}
	changed := map[string]bool{}
	for start := 0; start < len(observations); start += 500 {
		end := start + 500
		if end > len(observations) {
			end = len(observations)
		}
		if err := p.requirePeerIdentitySession(instance, fingerprint); err != nil {
			return err
		}
		aliases, err := p.repos.Chat.ObserveWhatsAppPeersForSession(ctx, instance.AccountID, instance.ID, fingerprint, observations[start:end])
		if err != nil {
			return fmt.Errorf("persist peer identity: %w", err)
		}
		for _, alias := range aliases {
			changed[alias] = true
		}
	}
	if len(changed) == 0 {
		return nil
	}
	p.broadcastIdentityRevision(ctx, instance.AccountID, instance.ID)
	if p.hub == nil {
		return nil
	}
	aliases := make([]string, 0, len(changed))
	for alias := range changed {
		aliases = append(aliases, alias)
	}
	ids, err := p.repos.Chat.WhatsAppPeerGroupIDs(ctx, instance.AccountID, instance.ID, aliases)
	if err != nil {
		return fmt.Errorf("load affected identity groups: %w", err)
	}
	for _, id := range ids {
		p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, "chat_group_updated", map[string]interface{}{"chat_id": id, "device_id": instance.ID})
	}
	return nil
}

func (p *DevicePool) observePeerMessage(ctx context.Context, instance *DeviceInstance, evt *events.Message) {
	if evt == nil {
		return
	}
	if evt.Info.IsFromMe {
		p.observePeerIdentities(ctx, instance, peerMigrationObservations(evt))
		return
	}
	if evt.Info.Sender.IsEmpty() {
		return
	}
	at := evt.Info.Timestamp
	fields := map[string]string{}
	if evt.Info.PushName != "" && evt.Info.PushName != "-" {
		fields["push_name"] = evt.Info.PushName
	}
	source := p.messageSourceWithScopedPNAlt(ctx, instance, evt.Info.MessageSource)
	p.observePeerIdentities(ctx, instance, []domain.WhatsAppPeerObservation{peerObservation(source.Sender, source.SenderAlt, "message", &at, fields)})
}

// A decoded own-device migration payload is explicit session-local evidence.
// Its mapping snapshot has no per-pair modification date, so it cannot replace
// a newer observed relationship merely because it was received today.
func peerMigrationObservations(evt *events.Message) []domain.WhatsAppPeerObservation {
	if evt == nil || !evt.Info.IsFromMe || evt.Message == nil {
		return nil
	}
	payload := evt.Message.GetProtocolMessage().GetLidMigrationMappingSyncMessage().GetEncodedMappingPayload()
	if len(payload) == 0 || len(payload) > 4<<20 {
		return nil
	}
	var decoded waLidMigrationSyncPayload.LIDMigrationMappingSyncPayload
	if proto.Unmarshal(payload, &decoded) != nil {
		return nil
	}
	out := make([]domain.WhatsAppPeerObservation, 0, len(decoded.PnToLidMappings))
	for _, entry := range decoded.PnToLidMappings {
		if entry == nil {
			continue
		}
		pn := types.NewJID(strconv.FormatUint(entry.GetPn(), 10), types.DefaultUserServer)
		lid := types.NewJID(strconv.FormatUint(entry.GetAssignedLid(), 10), types.HiddenUserServer)
		if row, ok := peerAliasObservation(pn, lid, "migration_sync", time.Time{}); ok {
			row.ObservedAt = nil
			out = append(out, row)
		}
	}
	return out
}

func peerPushNameObservation(evt *events.PushName) []domain.WhatsAppPeerObservation {
	if evt == nil {
		return nil
	}
	at := time.Now().UTC()
	if evt.Message != nil {
		at = evt.Message.Timestamp
	}
	// JIDAlt may come from the provider-global cache, not the wire.
	return []domain.WhatsAppPeerObservation{peerObservation(evt.JID, types.EmptyJID, "push_name_event", &at, map[string]string{"push_name": evt.NewPushName})}
}
func (p *DevicePool) observePeerPushName(ctx context.Context, instance *DeviceInstance, evt *events.PushName) {
	p.observePeerIdentities(ctx, instance, peerPushNameObservation(evt))
}
func peerBusinessNameObservation(evt *events.BusinessName) []domain.WhatsAppPeerObservation {
	if evt == nil {
		return nil
	}
	at := time.Now().UTC()
	if evt.Message != nil {
		at = evt.Message.Timestamp
	}
	return []domain.WhatsAppPeerObservation{peerObservation(evt.JID, types.EmptyJID, "business_name_event", &at, map[string]string{"business_name": evt.NewBusinessName})}
}
func (p *DevicePool) observePeerBusinessName(ctx context.Context, instance *DeviceInstance, evt *events.BusinessName) {
	p.observePeerIdentities(ctx, instance, peerBusinessNameObservation(evt))
}

func peerContactObservation(evt *events.Contact) []domain.WhatsAppPeerObservation {
	if evt == nil || evt.Action == nil {
		return nil
	}
	action := evt.Action
	fields := map[string]string{}
	if action.FullName != nil {
		fields["full_name"] = action.GetFullName()
	}
	if action.FirstName != nil {
		fields["first_name"] = action.GetFirstName()
	}
	if action.Username != nil {
		fields["username"] = action.GetUsername()
	}
	alt := types.EmptyJID
	for _, raw := range []string{action.GetLidJID(), action.GetPnJID()} {
		jid, _ := types.ParseJID(raw)
		jid = normalizePeerWireJID(jid)
		if !jid.IsEmpty() && jid.Server != normalizePeerWireJID(evt.JID).Server {
			alt = jid
			break
		}
	}
	at := evt.Timestamp
	return []domain.WhatsAppPeerObservation{peerObservation(evt.JID, alt, "contact_action", &at, fields)}
}

// Generic AppState exposes the actual decoded action; it does not add username
// search or infer that an absent username is a deleted username.
func peerAppStateObservations(evt *events.AppState) []domain.WhatsAppPeerObservation {
	if evt == nil || evt.SyncActionValue == nil || len(evt.Index) < 2 {
		return nil
	}
	jid, err := types.ParseJID(evt.Index[1])
	jid = normalizePeerWireJID(jid)
	if err != nil || (jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer) {
		return nil
	}
	at := time.Time{}
	if evt.GetTimestamp() > 0 {
		at = time.UnixMilli(evt.GetTimestamp()).UTC()
	}
	if evt.Index[0] == appstate.IndexContact && evt.GetContactAction() != nil {
		return peerContactObservation(&events.Contact{JID: jid, Timestamp: at, Action: evt.GetContactAction()})
	}
	if evt.Index[0] != appstate.IndexLIDContact || evt.GetLidContactAction() == nil {
		return nil
	}
	action := evt.GetLidContactAction()
	fields := map[string]string{}
	if action.FullName != nil {
		fields["full_name"] = action.GetFullName()
	}
	if action.FirstName != nil {
		fields["first_name"] = action.GetFirstName()
	}
	if action.Username != nil {
		fields["username"] = action.GetUsername()
	}
	return []domain.WhatsAppPeerObservation{peerObservation(jid, types.EmptyJID, "lid_contact_action", &at, fields)}
}

func peerHistoryObservations(data *waHistorySync.HistorySync) []domain.WhatsAppPeerObservation {
	if data == nil {
		return nil
	}
	out := []domain.WhatsAppPeerObservation{}
	add := func(raw, alternate, source string, fields map[string]string) {
		jid, err := types.ParseJID(raw)
		jid = normalizePeerWireJID(jid)
		if err != nil || (jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer) {
			return
		}
		alt, _ := types.ParseJID(alternate)
		out = append(out, peerObservation(jid, alt, source, nil, fields))
	}
	// These pairs were delivered to this device in this history event. Never
	// import the upstream container-global cache as account-local evidence.
	for _, entry := range data.GetPhoneNumberToLidMappings() {
		if entry != nil {
			add(entry.GetLidJID(), entry.GetPnJID(), "history_contact", nil)
		}
	}
	for _, entry := range data.GetInlineContacts() {
		if entry == nil {
			continue
		}
		fields := map[string]string{}
		if entry.FullName != nil {
			fields["full_name"] = entry.GetFullName()
		}
		if entry.FirstName != nil {
			fields["first_name"] = entry.GetFirstName()
		}
		if entry.Username != nil {
			fields["username"] = entry.GetUsername()
		}
		jid, alt := entry.GetLidJID(), entry.GetPnJID()
		if jid == "" {
			jid, alt = alt, ""
		}
		add(jid, alt, "history_contact", fields)
	}
	for _, entry := range data.GetAccounts() {
		if entry == nil {
			continue
		}
		source := "history_account"
		fields := map[string]string{}
		if entry.GetIsUsernameDeleted() {
			fields["username"] = ""
			source = "history_account_deleted"
		} else if entry.Username != nil {
			fields["username"] = entry.GetUsername()
		}
		raw := entry.GetLid()
		if raw != "" && !strings.Contains(raw, "@") {
			raw += "@lid"
		}
		add(raw, "", source, fields)
	}
	for _, entry := range data.GetPushnames() {
		if entry == nil || entry.GetPushname() == "-" || entry.GetPushname() == "" {
			continue
		}
		add(entry.GetID(), "", "history_push_name", map[string]string{"push_name": entry.GetPushname()})
	}
	for _, conv := range data.GetConversations() {
		if conv == nil {
			continue
		}
		alternate := conv.GetLidJID()
		primary, _ := types.ParseJID(conv.GetID())
		if primary.Server == types.HiddenUserServer {
			alternate = conv.GetPnJID()
		}
		fields := map[string]string{}
		if conv.Username != nil {
			fields["username"] = conv.GetUsername()
		}
		// A delivered pair remains evidence even when this conversation has
		// no username. An absent handle still is not an explicit deletion.
		if alternate != "" || len(fields) > 0 {
			add(conv.GetID(), alternate, "history_conversation", fields)
		}
		for _, entry := range conv.GetMessages() {
			if entry == nil || entry.GetMessage() == nil {
				continue
			}
			msg := entry.GetMessage()
			if msg.GetKey().GetFromMe() || msg.GetPushName() == "" || msg.GetPushName() == "-" {
				continue
			}
			raw := msg.GetKey().GetParticipant()
			if raw == "" {
				raw = conv.GetID()
			}
			jid, err := types.ParseJID(raw)
			jid = normalizePeerWireJID(jid)
			if err != nil || (jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer) {
				continue
			}
			var at *time.Time
			if msg.GetMessageTimestamp() > 0 {
				value := time.Unix(int64(msg.GetMessageTimestamp()), 0).UTC()
				at = &value
			}
			out = append(out, peerObservation(jid, types.EmptyJID, "history_message", at, map[string]string{"push_name": msg.GetPushName()}))
		}
	}
	return out
}

func peerIdentityJIDs(members []domain.GroupParticipant) []string {
	unique := map[string]bool{}
	for _, m := range members {
		for _, raw := range []string{m.JID, m.LID} {
			if raw != "" {
				unique[raw] = true
			}
		}
		if m.Phone != "" {
			unique[types.NewJID(m.Phone, types.DefaultUserServer).String()] = true
		}
	}
	out := make([]string, 0, len(unique))
	for jid := range unique {
		out = append(out, jid)
	}
	return out
}

func projectDurablePeer(ctx context.Context, instance *DeviceInstance, member domain.GroupParticipant, contacts map[types.JID]types.ContactInfo, snapshot *domain.WhatsAppPeerIdentitySnapshot) domain.GroupParticipant {
	if snapshot == nil {
		snapshot = &domain.WhatsAppPeerIdentitySnapshot{}
	}
	resolved := resolveCachedGroupParticipant(ctx, instance, member, contacts)
	addressInstance := instance
	if resolved.LID != "" && resolved.Phone != "" {
		phoneJID := types.NewJID(resolved.Phone, types.DefaultUserServer).String()
		if snapshot.LIDForPN[phoneJID] != resolved.LID || snapshot.PNForLID[resolved.LID] != phoneJID {
			// Legacy rows may contain a PN inferred from the old global cache.
			// Without this device's proof, address only the stable LID and do
			// not carry that PN's cached name into the participant projection.
			resolved.JID, resolved.Phone, resolved.Name = resolved.LID, "", ""
			addressInstance = nil
		}
	}
	if resolved.LID == "" {
		resolved.LID = snapshot.LIDForPN[types.NewJID(resolved.Phone, types.DefaultUserServer).String()]
	}
	if resolved.Phone == "" && resolved.LID != "" {
		pn, _ := types.ParseJID(snapshot.PNForLID[resolved.LID])
		if phone := phoneIdentityJID(pn); !phone.IsEmpty() {
			resolved.Phone = phone.User
		}
	}
	aliases := []string{resolved.LID, types.NewJID(resolved.Phone, types.DefaultUserServer).String(), resolved.JID}
	facts := map[string]domain.WhatsAppIdentityField{}
	combined := map[types.JID]types.ContactInfo{}
	reassignedName := false
	for _, raw := range aliases {
		jid, err := types.ParseJID(raw)
		if err != nil || jid.IsEmpty() {
			continue
		}
		info := contacts[jid]
		// Upstream copies these two cache fields through its global aliases.
		// Only an original-JID event/history fact may supply them here.
		info.PushName, info.BusinessName = "", ""
		for field, fact := range snapshot.Fields[raw] {
			if fact.Source == "provider_cache" && (field == "push_name" || field == "business_name") {
				continue
			}
			if fact.Source == "alias_reassigned" {
				// A reused phone invalidates only that alias's cached data. It
				// cannot delete facts observed on the new owner's stable LID.
				switch field {
				case "full_name":
					info.FullName = ""
					reassignedName = true
				case "first_name":
					info.FirstName = ""
					reassignedName = true
				case "business_name":
					info.BusinessName = ""
					reassignedName = true
				case "push_name":
					info.PushName = ""
					reassignedName = true
				case "redacted_phone":
					info.RedactedPhone = ""
				}
				continue
			}
			old, exists := facts[field]
			if !exists || domain.WhatsAppIdentityFieldNewer(fact, old) {
				facts[field] = fact
			}
		}
		combined[jid] = info
	}
	get := func(info types.ContactInfo, field string) string {
		switch field {
		case "full_name":
			return info.FullName
		case "first_name":
			return info.FirstName
		case "business_name":
			return info.BusinessName
		case "push_name":
			return info.PushName
		case "redacted_phone":
			return info.RedactedPhone
		}
		return ""
	}
	for field, fact := range facts {
		if field == "username" {
			continue
		}
		hasCached := false
		for _, info := range combined {
			hasCached = hasCached || get(info, field) != ""
		}
		if fact.ObservedAt == nil && fact.Value != "" && fact.Source != "alias_reassigned" && hasCached {
			continue
		}
		for jid, info := range combined {
			switch field {
			case "full_name":
				info.FullName = fact.Value
			case "first_name":
				info.FirstName = fact.Value
			case "business_name":
				info.BusinessName = fact.Value
			case "push_name":
				info.PushName = fact.Value
			case "redacted_phone":
				info.RedactedPhone = fact.Value
			}
			combined[jid] = info
		}
	}
	seed := resolved
	if seed.NameSource != "full_name" && seed.NameSource != "first_name" {
		seed.Name = ""
	}
	if reassignedName {
		seed.Name = ""
	}
	for _, field := range []string{"full_name", "first_name", "business_name", "push_name"} {
		if _, exists := facts[field]; exists {
			seed.Name = ""
			break
		}
	}
	resolved = resolveCachedGroupParticipant(ctx, addressInstance, seed, combined)
	if field := resolved.NameSource; domain.ValidWhatsAppIdentityField(field) && field != "username" && field != "redacted_phone" {
		if old, exists := facts[field]; !exists || old.Value != resolved.Name {
			facts[field] = domain.WhatsAppIdentityField{Value: resolved.Name, Source: "provider_cache", ReceivedAt: time.Now().UTC()}
		}
	}
	phoneJID := types.NewJID(resolved.Phone, types.DefaultUserServer).String()
	if fact, ok := snapshot.AliasFields[resolved.LID]; ok && fact.Value == phoneJID && resolved.Phone != "" {
		fact.Value = resolved.Phone
		facts["phone"] = fact
	}
	if fact, ok := snapshot.AliasFields[phoneJID]; ok && fact.Value == resolved.LID && resolved.LID != "" {
		facts["lid"] = fact
	}
	resolved.IdentityFields = facts
	if fact, ok := facts["username"]; ok {
		resolved.Username = fact.Value
	}
	return resolved
}

func (p *DevicePool) observePeerGroupMetadata(ctx context.Context, instance *DeviceInstance, info *types.GroupInfo, contacts map[types.JID]types.ContactInfo) error {
	if info == nil {
		return nil
	}
	at := time.Now().UTC()
	observations := make([]domain.WhatsAppPeerObservation, 0, len(info.Participants)*2)
	for _, part := range info.Participants {
		jid := part.JID.ToNonAD()
		alt := part.LID.ToNonAD()
		if jid.Server == types.HiddenUserServer {
			alt = part.PhoneNumber.ToNonAD()
		}
		fields := map[string]string{}
		if part.DisplayName != "" {
			fields["redacted_phone"] = part.DisplayName
		}
		observations = append(observations, peerObservation(jid, alt, "group_metadata", &at, fields))
		for _, address := range []types.JID{jid, alt} {
			if address.IsEmpty() {
				continue
			}
			cached, ok := contacts[address]
			if !ok {
				continue
			}
			names := map[string]string{}
			for field, value := range map[string]string{"full_name": cached.FullName, "first_name": cached.FirstName} {
				if value != "" {
					names[field] = value
				}
			}
			if len(names) > 0 {
				observations = append(observations, peerObservation(jid, alt, "provider_cache", nil, names))
			}
		}
	}
	return p.observePeerIdentities(ctx, instance, observations)
}
