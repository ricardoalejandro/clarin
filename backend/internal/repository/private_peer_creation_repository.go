package repository

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

// A provider pair is usable only while its observing device's authenticated
// session remains current. Durable CRM aliases do not establish provider proof.
type verifiedPrivatePeer struct {
	requested, pn, lid string
	verified           bool
}
type privatePeerCreation struct {
	contactID uuid.UUID
	chat      *domain.Chat
	created   bool
}

func verifiedPrivatePeerTx(ctx context.Context, tx pgx.Tx, accountID, deviceID uuid.UUID, requested string) (*verifiedPrivatePeer, error) {
	requested = canonicalPeerAddress(requested)
	if requested == "" {
		return nil, nil
	}
	if err := lockWhatsAppIdentityScope(ctx, tx, accountID, deviceID); err != nil {
		return nil, err
	}
	var peer verifiedPrivatePeer
	err := tx.QueryRow(ctx, `SELECT a.pn_jid,a.lid_jid
 FROM whatsapp_peer_identity_aliases a
 JOIN whatsapp_identity_scopes s ON s.account_id=a.account_id AND s.device_id=a.device_id AND s.session_generation=a.session_generation
 JOIN devices d ON d.account_id=s.account_id AND d.id=s.device_id
 WHERE a.account_id=$1 AND a.device_id=$2 AND (a.pn_jid=$3::text OR a.lid_jid=$3::text)
 AND s.session_fingerprint<>'' AND d.delete_operation_id IS NULL
 AND COALESCE(NULLIF(d.provider,''),'whatsapp_web')='whatsapp_web'`, accountID, deviceID, requested).Scan(&peer.pn, &peer.lid)
	if errors.Is(err, pgx.ErrNoRows) {
		var ownedWebDevice bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE account_id=$1 AND id=$2 AND delete_operation_id IS NULL AND COALESCE(NULLIF(provider,''),'whatsapp_web')='whatsapp_web')`, accountID, deviceID).Scan(&ownedWebDevice); err != nil {
			return nil, err
		}
		if !ownedWebDevice {
			return nil, nil
		}
		peer.requested = requested
		if strings.HasSuffix(requested, "@lid") {
			peer.lid = requested
		} else {
			peer.pn = requested
		}
	} else {
		peer.verified = err == nil
	}
	if err != nil {
		return nil, err
	}
	peer.requested = requested
	// Both entry addresses and all observing devices share these account locks.
	// Lock each address in stable order, including the PN used by exact creates.
	addresses := privatePeerAddresses(&peer)
	sort.Strings(addresses)
	for _, address := range addresses {
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,71142))`, accountID.String()+"|"+address); err != nil {
			return nil, err
		}
	}
	return &peer, nil
}

func privatePeerAddresses(peer *verifiedPrivatePeer) []string {
	addresses := []string{}
	for _, address := range []string{peer.pn, peer.lid} {
		if address != "" {
			addresses = append(addresses, address)
		}
	}
	return addresses
}

type privateContactCandidate struct {
	id         uuid.UUID
	jid        string
	exactRoute bool
}

// createVerifiedPrivatePeer serializes exact Web creates and reuses a unique verified representation. Existing divergent
// CRM identities or two histories remain separate and keep their exact routes.
// It never deletes or moves Contact, Lead, Chat, Message or media records.
func createVerifiedPrivatePeer(ctx context.Context, db *pgxpool.Pool, accountID, deviceID uuid.UUID, jid, name, pushName string, wantChat bool) (*privatePeerCreation, bool, error) {
	if deviceID == uuid.Nil || canonicalPeerAddress(jid) == "" {
		return nil, false, nil
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, true, err
	}
	defer tx.Rollback(ctx)
	peer, err := verifiedPrivatePeerTx(ctx, tx, accountID, deviceID, jid)
	if err != nil {
		return nil, true, err
	}
	if peer == nil {
		return nil, false, nil
	}
	phone := phoneFromJID(peer.pn)
	addresses := privatePeerAddresses(peer)
	rows, err := tx.Query(ctx, `SELECT c.id,c.jid,EXISTS(SELECT 1 FROM chats exact_chat WHERE exact_chat.account_id=c.account_id AND exact_chat.contact_id=c.id AND exact_chat.channel_key='whatsapp_web' AND LOWER(BTRIM(exact_chat.jid))=$5::text) FROM contacts c
 WHERE c.account_id=$1 AND c.is_group=FALSE AND (
 LOWER(BTRIM(c.jid))=ANY($2::text[])
 OR EXISTS(SELECT 1 FROM chats exact_chat WHERE exact_chat.account_id=c.account_id AND exact_chat.contact_id=c.id AND exact_chat.channel_key='whatsapp_web' AND LOWER(BTRIM(exact_chat.jid))=$5::text)
 OR ($4::bool AND EXISTS(SELECT 1 FROM contact_aliases a WHERE a.account_id=c.account_id AND a.contact_id=c.id AND ((a.alias_type='jid' AND a.normalized_value=ANY($2::text[])) OR (a.alias_type='phone' AND a.normalized_value=$3::text))))
 OR ($3::text<>'' AND CASE WHEN LENGTH(REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g'))=9 AND REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g') LIKE '9%' THEN '51'||REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g') ELSE REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g') END=$3::text)
 OR EXISTS(SELECT 1 FROM contact_phones p WHERE p.contact_id=c.id AND $3::text<>'' AND CASE WHEN LENGTH(REGEXP_REPLACE(p.phone,'[^0-9]','','g'))=9 AND REGEXP_REPLACE(p.phone,'[^0-9]','','g') LIKE '9%' THEN '51'||REGEXP_REPLACE(p.phone,'[^0-9]','','g') ELSE REGEXP_REPLACE(p.phone,'[^0-9]','','g') END=$3::text)
 ) ORDER BY c.id FOR UPDATE OF c`, accountID, addresses, phone, peer.verified || phone != "", peer.requested)
	if err != nil {
		return nil, true, err
	}
	candidates := []privateContactCandidate{}
	for rows.Next() {
		var c privateContactCandidate
		if err = rows.Scan(&c.id, &c.jid, &c.exactRoute); err != nil {
			rows.Close()
			return nil, true, err
		}
		candidates = append(candidates, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, true, err
	}
	result := &privatePeerCreation{}
	ambiguous := len(candidates) > 1
	if ambiguous {
		// Never let an alias chosen by LIMIT 1 steal a legacy exact identity.
		for _, c := range candidates {
			if c.exactRoute {
				result.contactID = c.id
				break
			}
		}
		for _, c := range candidates {
			if result.contactID == uuid.Nil && strings.EqualFold(strings.TrimSpace(c.jid), peer.requested) {
				result.contactID = c.id
				break
			}
		}
		if result.contactID == uuid.Nil {
			return nil, true, ErrContactIdentityConflict
		}
	} else if len(candidates) == 1 {
		c := candidates[0]
		// A stable LID belonging to a different person is not phone reassignment
		// proof. Leave that historical identity untouched for explicit resolution.
		if !c.exactRoute && strings.HasSuffix(strings.ToLower(c.jid), "@lid") && !strings.EqualFold(c.jid, peer.lid) {
			return nil, true, ErrContactIdentityConflict
		}
		result.contactID = c.id
	} else {
		contactJID := peer.pn
		if contactJID == "" {
			contactJID = peer.requested
		}
		err = tx.QueryRow(ctx, `INSERT INTO contacts(account_id,device_id,jid,phone,name,push_name,is_group)
 VALUES($1,$2,$3::text,$4::text,NULLIF($5::text,''),NULLIF($6::text,''),FALSE)
 ON CONFLICT(account_id,jid) DO UPDATE SET updated_at=contacts.updated_at
 RETURNING id,(xmax=0)`, accountID, deviceID, contactJID, phone, name, pushName).Scan(&result.contactID, &result.created)
		if err != nil {
			return nil, true, err
		}
	}
	if !ambiguous && peer.verified {
		for _, address := range addresses {
			conflict, e := contactIdentityConflictsWithOwner(ctx, tx, accountID, result.contactID, address, phone)
			if e != nil {
				return nil, true, e
			}
			if conflict {
				return nil, true, ErrContactIdentityConflict
			}
		}
		for _, alias := range []struct{ kind, value string }{{"jid", peer.pn}, {"jid", peer.lid}, {"phone", phone}} {
			tag, e := tx.Exec(ctx, `INSERT INTO contact_aliases(account_id,contact_id,alias_type,alias_value,normalized_value)
 VALUES($1,$2,$3::text,$4::text,$4::text)
 ON CONFLICT(account_id,alias_type,normalized_value) DO UPDATE SET alias_value=EXCLUDED.alias_value
 WHERE contact_aliases.contact_id=EXCLUDED.contact_id`, accountID, result.contactID, alias.kind, alias.value)
			if e != nil {
				return nil, true, e
			}
			if tag.RowsAffected() != 1 {
				return nil, true, ErrContactIdentityConflict
			}
		}
	}
	// In an existing conflict the LID side must not acquire the PN side's phone.
	confirmedPhone := phone
	if ambiguous {
		confirmedPhone = ""
	}
	if _, err = tx.Exec(ctx, `UPDATE contacts SET device_id=COALESCE(device_id,$3),
 name=COALESCE(NULLIF($4::text,''),name),push_name=COALESCE(NULLIF($5::text,''),push_name),
 phone=COALESCE(NULLIF(phone,''),NULLIF($6::text,'')),updated_at=NOW()
 WHERE account_id=$1 AND id=$2`, accountID, result.contactID, deviceID, name, pushName, confirmedPhone); err != nil {
		return nil, true, err
	}
	if _, err = applyDurableSuppressionToContact(ctx, tx, accountID, result.contactID); err != nil {
		return nil, true, err
	}
	if wantChat {
		chatJID := peer.pn
		if chatJID == "" {
			chatJID = peer.requested
		}
		if ambiguous {
			chatJID = peer.requested
		}
		// A Contact can own multiple phones. Only this verified pair is eligible;
		// never reuse an arbitrary chat merely because contact_id happens to match.
		chats, e := tx.Query(ctx, `SELECT id,contact_id,jid FROM chats WHERE account_id=$1 AND channel_key='whatsapp_web' AND LOWER(BTRIM(jid))=ANY($2::text[]) ORDER BY id FOR UPDATE`, accountID, addresses)
		if e != nil {
			return nil, true, e
		}
		type existingChat struct {
			id, contact uuid.UUID
			jid         string
		}
		existing := []existingChat{}
		for chats.Next() {
			var c existingChat
			if e = chats.Scan(&c.id, &c.contact, &c.jid); e != nil {
				chats.Close()
				return nil, true, e
			}
			existing = append(existing, c)
		}
		e = chats.Err()
		chats.Close()
		if e != nil {
			return nil, true, e
		}
		var chosen *existingChat
		for i := range existing {
			if strings.EqualFold(existing[i].jid, peer.requested) {
				chosen = &existing[i]
				break
			}
		}
		if chosen == nil && len(existing) == 1 && !ambiguous {
			chosen = &existing[0]
		}
		if chosen != nil {
			if chosen.contact != result.contactID {
				return nil, true, ErrChatContactConflict
			}
			chatJID = chosen.jid
		} else if len(existing) > 0 && !ambiguous {
			return nil, true, ErrChatContactConflict
		}
		chat := &domain.Chat{}
		err = tx.QueryRow(ctx, `INSERT INTO chats(account_id,device_id,contact_id,jid,name,channel_key)
 VALUES($1,$2,$3,$4::text,NULLIF($5::text,''),'whatsapp_web')
 ON CONFLICT(account_id,channel_key,jid) DO UPDATE SET device_id=EXCLUDED.device_id,
 name=COALESCE(NULLIF(EXCLUDED.name,''),chats.name),updated_at=NOW()
 RETURNING id,account_id,device_id,contact_id,jid,name,last_message,last_message_at,unread_count,is_archived,is_pinned,created_at,updated_at`, accountID, deviceID, result.contactID, chatJID, name).Scan(&chat.ID, &chat.AccountID, &chat.DeviceID, &chat.ContactID, &chat.JID, &chat.Name, &chat.LastMessage, &chat.LastMessageAt, &chat.UnreadCount, &chat.IsArchived, &chat.IsPinned, &chat.CreatedAt, &chat.UpdatedAt)
		if err != nil {
			return nil, true, err
		}
		if chat.ContactID == nil || *chat.ContactID != result.contactID {
			return nil, true, ErrChatContactConflict
		}
		chat.ContactCreated = result.created
		setChatIdentityState(chat)
		if !ambiguous && phone != "" {
			chat.ContactPhone = &phone
			// The transport JID stays historical; pending describes whether
			// this device can identify it, not the spelling of that JID.
			if peer.verified {
				chat.IdentityPending = false
			}
		}
		result.chat = chat
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, true, err
	}
	return result, true, nil
}

// Selected-Contact creation keeps its explicit parent and sender validation.
// Reuse is limited to the current verified peer and never changes that parent.
func reuseVerifiedPrivateChatForContact(ctx context.Context, tx pgx.Tx, accountID, deviceID, contactID uuid.UUID, jid, name string) (*domain.Chat, bool, error) {
	peer, err := verifiedPrivatePeerTx(ctx, tx, accountID, deviceID, jid)
	if err != nil {
		return nil, true, err
	}
	if peer == nil || !peer.verified {
		return nil, false, nil
	}
	conflict, err := contactIdentityConflictsWithOwner(ctx, tx, accountID, contactID, peer.requested, phoneFromJID(peer.pn))
	if err != nil {
		return nil, true, err
	}
	if conflict {
		return nil, true, ErrContactIdentityConflict
	}

	rows, err := tx.Query(ctx, `SELECT id,contact_id,jid FROM chats WHERE account_id=$1 AND channel_key='whatsapp_web' AND LOWER(BTRIM(jid))=ANY($2::text[]) ORDER BY (LOWER(BTRIM(jid))=$3::text) DESC,id FOR UPDATE`, accountID, privatePeerAddresses(peer), peer.requested)
	if err != nil {
		return nil, true, err
	}
	type route struct {
		id, contact uuid.UUID
		jid         string
	}
	routes := []route{}
	for rows.Next() {
		var c route
		if err = rows.Scan(&c.id, &c.contact, &c.jid); err != nil {
			rows.Close()
			return nil, true, err
		}
		routes = append(routes, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, true, err
	}
	if len(routes) == 0 {
		return nil, false, nil
	}
	chosen := routes[0]
	if len(routes) > 1 && !strings.EqualFold(chosen.jid, peer.requested) {
		return nil, true, ErrChatContactConflict
	}
	if chosen.contact != contactID {
		return nil, true, ErrChatContactConflict
	}
	chat := &domain.Chat{}
	err = tx.QueryRow(ctx, `UPDATE chats SET device_id=$3,name=COALESCE(NULLIF($4::text,''),name),updated_at=NOW() WHERE account_id=$1 AND id=$2 AND contact_id=$5
 RETURNING id,account_id,device_id,contact_id,jid,name,last_message,last_message_at,unread_count,is_archived,is_pinned,created_at,updated_at`, accountID, chosen.id, deviceID, name, contactID).Scan(&chat.ID, &chat.AccountID, &chat.DeviceID, &chat.ContactID, &chat.JID, &chat.Name, &chat.LastMessage, &chat.LastMessageAt, &chat.UnreadCount, &chat.IsArchived, &chat.IsPinned, &chat.CreatedAt, &chat.UpdatedAt)
	if err != nil {
		return nil, true, err
	}
	setChatIdentityState(chat)
	return chat, true, nil
}

// HydratePrivatePeerIdentity is read-only and batched. Historical LID spelling
// alone must not hide a phone which this exact authenticated device has proven.
// Divergent CRM parents remain pending; no Contact identity is inferred/merged.
func (r *ChatRepository) HydratePrivatePeerIdentity(ctx context.Context, accountID uuid.UUID, chats []*domain.Chat) error {
	ids := []uuid.UUID{}
	byID := map[uuid.UUID]*domain.Chat{}
	for _, chat := range chats {
		if chat != nil && chat.AccountID == accountID && strings.HasSuffix(strings.ToLower(chat.JID), "@lid") {
			chat.IdentityPending = true
			chat.ContactPhone = nil
			ids = append(ids, chat.ID)
			byID[chat.ID] = chat
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.db.Query(ctx, `SELECT c.id,SPLIT_PART(a.pn_jid,'@',1)
 FROM chats c
 JOIN devices d ON d.account_id=c.account_id AND d.id=c.device_id AND d.delete_operation_id IS NULL AND COALESCE(NULLIF(d.provider,''),'whatsapp_web')='whatsapp_web'
 JOIN whatsapp_identity_scopes s ON s.account_id=d.account_id AND s.device_id=d.id AND s.session_fingerprint<>''
 JOIN whatsapp_peer_identity_aliases a ON a.account_id=s.account_id AND a.device_id=s.device_id AND a.session_generation=s.session_generation AND a.lid_jid=LOWER(BTRIM(c.jid))
 WHERE c.account_id=$1 AND c.id=ANY($2::uuid[]) AND c.channel_key='whatsapp_web'
 AND NOT EXISTS(SELECT 1 FROM contacts other WHERE other.account_id=c.account_id AND other.id<>c.contact_id AND (
 LOWER(BTRIM(other.jid))=ANY(ARRAY[a.pn_jid,a.lid_jid])
 OR CASE WHEN LENGTH(REGEXP_REPLACE(COALESCE(other.phone,''),'[^0-9]','','g'))=9 AND REGEXP_REPLACE(COALESCE(other.phone,''),'[^0-9]','','g') LIKE '9%' THEN '51'||REGEXP_REPLACE(COALESCE(other.phone,''),'[^0-9]','','g') ELSE REGEXP_REPLACE(COALESCE(other.phone,''),'[^0-9]','','g') END=SPLIT_PART(a.pn_jid,'@',1)
 OR EXISTS(SELECT 1 FROM contact_aliases ca WHERE ca.account_id=other.account_id AND ca.contact_id=other.id AND ((ca.alias_type='jid' AND ca.normalized_value=ANY(ARRAY[a.pn_jid,a.lid_jid])) OR (ca.alias_type='phone' AND ca.normalized_value=SPLIT_PART(a.pn_jid,'@',1))))
 OR EXISTS(SELECT 1 FROM contact_phones cp WHERE cp.contact_id=other.id AND CASE WHEN LENGTH(REGEXP_REPLACE(cp.phone,'[^0-9]','','g'))=9 AND REGEXP_REPLACE(cp.phone,'[^0-9]','','g') LIKE '9%' THEN '51'||REGEXP_REPLACE(cp.phone,'[^0-9]','','g') ELSE REGEXP_REPLACE(cp.phone,'[^0-9]','','g') END=SPLIT_PART(a.pn_jid,'@',1))
 ))`, accountID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var phone string
		if err = rows.Scan(&id, &phone); err != nil {
			return err
		}
		if chat := byID[id]; chat != nil {
			chat.ContactPhone = &phone
			chat.IdentityPending = false
		}
	}
	return rows.Err()
}
