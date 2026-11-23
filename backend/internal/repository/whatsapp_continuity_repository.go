package repository

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrWhatsAppOwnerConflict = errors.New("whatsapp owner identity conflict")
var ErrChatBindingChanged = errors.New("chat binding changed")

// Call before locking a Chat or Message row. Repair uses this same owner/group
// barrier before it locks perspective rows, so a delayed ingress cannot write
// into an alias and cannot reverse the repair's row/advisory lock order.
func LockMessageConversationTx(ctx context.Context, tx pgx.Tx, accountID, chatID uuid.UUID) error {
	var jid string
	var owner, canonical *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT jid,whatsapp_owner_id,canonical_chat_id FROM chats WHERE account_id=$1 AND id=$2`, accountID, chatID).Scan(&jid, &owner, &canonical); err != nil {
		return err
	}
	if canonical != nil {
		return ErrChatBindingChanged
	}
	if !domain.IsGroupJID(jid) || owner == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,71140))`, accountID.String()+":"+owner.String()+":"+jid); err != nil {
		return err
	}
	var currentOwner, currentCanonical *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT whatsapp_owner_id,canonical_chat_id FROM chats WHERE account_id=$1 AND id=$2`, accountID, chatID).Scan(&currentOwner, &currentCanonical); err != nil {
		return err
	}
	if currentCanonical != nil || currentOwner == nil || *currentOwner != *owner {
		return ErrChatBindingChanged
	}
	return nil
}

// Only authenticated Store.ID/Store.LID may enter this method. A user-entered
// phone, a group peer, or the SDK's shared LID map is never ownership evidence.
func (r *ChatRepository) BindWhatsAppOwner(ctx context.Context, accountID, deviceID uuid.UUID, ownPN, ownLID, fingerprint string) (uuid.UUID, error) {
	ownPN, ownLID = normalizeOwnJID(ownPN), normalizeOwnJID(ownLID)
	if !strings.HasSuffix(ownPN, "@s.whatsapp.net") {
		ownPN = ""
	}
	if !strings.HasSuffix(ownLID, "@lid") {
		ownLID = ""
	}
	if (ownPN == "" && ownLID == "") || fingerprint == "" {
		return uuid.Nil, ErrWhatsAppOwnerConflict
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,71139))`, accountID.String()); err != nil {
		return uuid.Nil, err
	}
	var device uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM devices WHERE account_id=$1 AND id=$2 AND delete_operation_id IS NULL AND COALESCE(NULLIF(provider,''),'whatsapp_web')='whatsapp_web' FOR UPDATE`, accountID, deviceID).Scan(&device); err != nil {
		return uuid.Nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id,COALESCE(own_pn,''),COALESCE(own_lid,'') FROM whatsapp_conversation_owners WHERE account_id=$1 AND (($2::text<>'' AND own_pn=$2) OR ($3::text<>'' AND own_lid=$3)) FOR UPDATE`, accountID, ownPN, ownLID)
	if err != nil {
		return uuid.Nil, err
	}
	type owner struct {
		id      uuid.UUID
		pn, lid string
	}
	owners := []owner{}
	for rows.Next() {
		var o owner
		if err = rows.Scan(&o.id, &o.pn, &o.lid); err != nil {
			rows.Close()
			return uuid.Nil, err
		}
		owners = append(owners, o)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return uuid.Nil, err
	}
	if len(owners) > 1 {
		return uuid.Nil, ErrWhatsAppOwnerConflict
	}
	ownerID := uuid.New()
	if len(owners) == 1 {
		o := owners[0]
		ownerID = o.id
		if (o.pn != "" && ownPN != "" && o.pn != ownPN) || (o.lid != "" && ownLID != "" && o.lid != ownLID) {
			return uuid.Nil, ErrWhatsAppOwnerConflict
		}
		_, err = tx.Exec(ctx, `UPDATE whatsapp_conversation_owners SET own_pn=COALESCE(own_pn,NULLIF($3::text,'')),own_lid=COALESCE(own_lid,NULLIF($4::text,'')),updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, ownerID, ownPN, ownLID)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO whatsapp_conversation_owners(id,account_id,own_pn,own_lid) VALUES($1,$2,NULLIF($3::text,''),NULLIF($4::text,''))`, ownerID, accountID, ownPN, ownLID)
	}
	if err != nil {
		return uuid.Nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE whatsapp_device_owner_epochs SET ended_at=NOW() WHERE account_id=$1 AND device_id=$2 AND ended_at IS NULL AND session_fingerprint<>$3`, accountID, deviceID, fingerprint); err != nil {
		return uuid.Nil, err
	}
	var recorded uuid.UUID
	if err = tx.QueryRow(ctx, `INSERT INTO whatsapp_device_owner_epochs(account_id,device_id,owner_id,session_fingerprint) VALUES($1,$2,$3,$4)
 ON CONFLICT(account_id,device_id,session_fingerprint) DO UPDATE SET ended_at=NULL WHERE whatsapp_device_owner_epochs.owner_id=EXCLUDED.owner_id RETURNING owner_id`, accountID, deviceID, ownerID, fingerprint).Scan(&recorded); err != nil {
		return uuid.Nil, err
	}
	// Re-pairing the same Clarin UUID with another own identity must not make
	// that new number the sender of the prior identity's group history.
	if _, err = tx.Exec(ctx, `UPDATE chats SET device_id=NULL,binding_revision=binding_revision+1,binding_state='pending',updated_at=NOW() WHERE account_id=$1 AND device_id=$2 AND jid LIKE '%@g.us' AND whatsapp_owner_id IS NOT NULL AND whatsapp_owner_id<>$3`, accountID, deviceID, ownerID); err != nil {
		return uuid.Nil, err
	}
	return ownerID, tx.Commit(ctx)
}

func normalizeOwnJID(jid string) string {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(jid)), "@")
	if len(parts) != 2 {
		return ""
	}
	if i := strings.IndexByte(parts[0], ':'); i >= 0 {
		parts[0] = parts[0][:i]
	}
	if parts[0] == "" {
		return ""
	}
	for _, c := range parts[0] {
		if c < '0' || c > '9' {
			return ""
		}
	}
	if parts[1] != "s.whatsapp.net" && parts[1] != "lid" {
		return ""
	}
	return parts[0] + "@" + parts[1]
}

func OwnerGroupChannelKey(ownerID uuid.UUID) string { return "whatsapp_web_owner:" + ownerID.String() }

func (r *ChatRepository) deviceWhatsAppOwner(ctx context.Context, accountID, deviceID uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := r.db.QueryRow(ctx, `SELECT e.owner_id FROM whatsapp_device_owner_epochs e JOIN devices d ON d.account_id=e.account_id AND d.id=e.device_id WHERE e.account_id=$1 AND e.device_id=$2 AND e.ended_at IS NULL AND d.delete_operation_id IS NULL`, accountID, deviceID).Scan(&id)
	if err == pgx.ErrNoRows {
		return uuid.Nil, nil
	}
	return id, err
}

func (r *ChatRepository) ResolveCanonicalChatID(ctx context.Context, accountID, chatID uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := r.db.QueryRow(ctx, `SELECT COALESCE(canonical_chat_id,id) FROM chats WHERE account_id=$1 AND id=$2`, accountID, chatID).Scan(&id)
	return id, err
}
func (r *ChatRepository) ConversationChatIDs(ctx context.Context, accountID, chatID uuid.UUID) ([]uuid.UUID, error) {
	canonical, err := r.ResolveCanonicalChatID(ctx, accountID, chatID)
	if err != nil {
		return nil, err
	}
	rows, err := r.db.Query(ctx, `SELECT id FROM chats WHERE account_id=$1 AND (id=$2 OR canonical_chat_id=$2) ORDER BY id`, accountID, canonical)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (r *ChatRepository) HydrateContinuity(ctx context.Context, accountID uuid.UUID, chats []*domain.Chat) error {
	ids := []uuid.UUID{}
	byID := map[uuid.UUID]*domain.Chat{}
	for _, c := range chats {
		if c != nil && c.AccountID == accountID {
			ids = append(ids, c.ID)
			byID[c.ID] = c
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.db.Query(ctx, `SELECT c.id,c.device_id,c.jid,c.whatsapp_owner_id,c.canonical_chat_id,c.binding_revision,c.binding_state,COALESCE((SELECT array_agg(a.id ORDER BY a.id) FROM chats a WHERE a.account_id=c.account_id AND a.canonical_chat_id=c.id),'{}'::uuid[]) FROM chats c WHERE c.account_id=$1 AND c.id=ANY($2::uuid[])`, accountID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var owner, canonical *uuid.UUID
		var device *uuid.UUID
		var jid string
		var revision int64
		var state string
		var aliases []uuid.UUID
		if err = rows.Scan(&id, &device, &jid, &owner, &canonical, &revision, &state, &aliases); err != nil {
			return err
		}
		c := byID[id]
		c.DeviceID = device
		c.JID = jid
		c.WhatsAppOwnerID = owner
		if canonical == nil {
			self := id
			canonical = &self
		}
		c.CanonicalChatID = canonical
		c.BindingRevision = revision
		c.BindingState = state
		if owner == nil {
			c.BindingState = ""
		}
		c.AliasChatIDs = aliases
	}
	if err = rows.Err(); err != nil {
		return err
	}
	rows.Close()
	if err = r.HydrateConversationState(ctx, accountID, chats); err != nil {
		return err
	}
	return r.HydratePrivatePeerIdentity(ctx, accountID, chats)
}

// Historical proof is local to one conversation. Every saved self identity must
// agree; one matching own message cannot justify other groups of an old UUID.
func groupOwnershipEvidenceMatches(ownPN, ownLID string, fromMe []string, members []domain.GroupParticipant) bool {
	allowed := map[string]bool{}
	for _, v := range []string{ownPN, ownLID} {
		if n := normalizeOwnJID(v); n != "" {
			allowed[n] = true
		}
	}
	proof := 0
	for _, v := range fromMe {
		n := normalizeOwnJID(v)
		if n == "" || !allowed[n] {
			return false
		}
		proof++
	}
	for _, m := range members {
		if !m.IsSelf {
			continue
		}
		seen := false
		for _, v := range []string{m.JID, m.LID} {
			if strings.TrimSpace(v) == "" {
				continue
			}
			n := normalizeOwnJID(v)
			if n == "" || !allowed[n] {
				return false
			}
			seen = true
		}
		if !seen {
			return false
		}
		proof++
	}
	return proof > 0
}

type continuityGroupCandidate struct {
	id        uuid.UUID
	device    *uuid.UUID
	connected bool
	created   time.Time
	owner     *uuid.UUID
	state     string
	revision  int64
}

// reconcileOwnerGroupTx leaves all Chat/Message rows and their provenance in
// place. Aliases only change the logical read projection, never CRM identity.
func reconcileOwnerGroupTx(ctx context.Context, tx pgx.Tx, accountID, deviceID, ownerID uuid.UUID, jid, subject string, create bool) (uuid.UUID, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,71140))`, accountID.String()+":"+ownerID.String()+":"+jid); err != nil {
		return uuid.Nil, err
	}
	var pn, lid string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(own_pn,''),COALESCE(own_lid,'') FROM whatsapp_conversation_owners WHERE account_id=$1 AND id=$2`, accountID, ownerID).Scan(&pn, &lid); err != nil {
		return uuid.Nil, err
	}
	rows, err := tx.Query(ctx, `SELECT c.id,c.device_id,COALESCE(d.status='connected' AND d.delete_operation_id IS NULL AND EXISTS(SELECT 1 FROM whatsapp_device_owner_epochs e WHERE e.account_id=c.account_id AND e.device_id=c.device_id AND e.owner_id=$3 AND e.ended_at IS NULL),FALSE),c.created_at,c.whatsapp_owner_id,c.binding_state,c.binding_revision,
 COALESCE((SELECT array_agg(DISTINCT COALESCE(m.from_jid,'')) FROM messages m WHERE m.account_id=c.account_id AND m.chat_id=c.id AND m.is_from_me),'{}'::text[]),COALESCE(g.participants,'[]'::jsonb)
 FROM chats c LEFT JOIN devices d ON d.account_id=c.account_id AND d.id=c.device_id LEFT JOIN chat_groups g ON g.account_id=c.account_id AND g.chat_id=c.id
 WHERE c.account_id=$1 AND c.jid=$2 AND c.canonical_chat_id IS NULL AND (c.whatsapp_owner_id=$3 OR c.whatsapp_owner_id IS NULL) ORDER BY c.id FOR UPDATE OF c`, accountID, jid, ownerID)
	if err != nil {
		return uuid.Nil, err
	}
	candidates := []continuityGroupCandidate{}
	for rows.Next() {
		var c continuityGroupCandidate
		var own []string
		var raw []byte
		if err = rows.Scan(&c.id, &c.device, &c.connected, &c.created, &c.owner, &c.state, &c.revision, &own, &raw); err != nil {
			rows.Close()
			return uuid.Nil, err
		}
		var members []domain.GroupParticipant
		if err = json.Unmarshal(raw, &members); err != nil {
			rows.Close()
			return uuid.Nil, err
		}
		if c.owner != nil || groupOwnershipEvidenceMatches(pn, lid, own, members) {
			candidates = append(candidates, c)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return uuid.Nil, err
	}
	if len(candidates) == 0 {
		if !create {
			return uuid.Nil, nil
		}
		var id uuid.UUID
		err = tx.QueryRow(ctx, `WITH contact AS(INSERT INTO contacts(account_id,device_id,jid,name,is_group) VALUES($1,$2,$3,NULLIF($4::text,''),TRUE) ON CONFLICT(account_id,jid) DO UPDATE SET name=COALESCE(NULLIF(EXCLUDED.name,''),contacts.name),is_group=TRUE,phone=NULL RETURNING id)
 INSERT INTO chats(account_id,device_id,contact_id,jid,name,channel_key,whatsapp_owner_id,binding_state,binding_revision) SELECT $1,$2,id,$3,NULLIF($4::text,''),$5,$6,'verified_continuity',1 FROM contact RETURNING id`, accountID, deviceID, jid, subject, OwnerGroupChannelKey(ownerID), ownerID).Scan(&id)
		return id, err
	}
	for _, candidate := range candidates {
		if candidate.device != nil {
			if _, err = tx.Exec(ctx, `INSERT INTO whatsapp_group_device_bindings(account_id,owner_id,jid,device_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, accountID, ownerID, jid, *candidate.device); err != nil {
				return uuid.Nil, err
			}
		}
	}
	// Connected operational perspective wins only if unique. Otherwise retain
	// the oldest history but expose a conflict rather than choose a sender.
	connected := 0
	connectedDevices := map[uuid.UUID]bool{}
	hadConflict := false
	for _, c := range candidates {
		if c.state == "conflict" {
			hadConflict = true
		}
		if c.connected {
			if c.device != nil {
				connectedDevices[*c.device] = true
			}
		}
	}
	connected = len(connectedDevices)
	var conflictDevices []uuid.UUID
	if hadConflict {
		if err = tx.QueryRow(ctx, `SELECT COALESCE(array_agg(b.device_id),'{}'::uuid[]) FROM whatsapp_group_device_bindings b JOIN devices d ON d.account_id=b.account_id AND d.id=b.device_id JOIN whatsapp_device_owner_epochs e ON e.account_id=b.account_id AND e.device_id=b.device_id AND e.owner_id=b.owner_id AND e.ended_at IS NULL WHERE b.account_id=$1 AND b.owner_id=$2 AND b.jid=$3 AND d.status='connected' AND d.delete_operation_id IS NULL`, accountID, ownerID, jid).Scan(&conflictDevices); err != nil {
			return uuid.Nil, err
		}
		connected = len(conflictDevices)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if connected == 1 && candidates[i].connected != candidates[j].connected {
			return candidates[i].connected
		}
		if !candidates[i].created.Equal(candidates[j].created) {
			return candidates[i].created.Before(candidates[j].created)
		}
		return candidates[i].id.String() < candidates[j].id.String()
	})
	canonical := candidates[0]
	if hadConflict && connected == 1 {
		canonical.device = &conflictDevices[0]
	}
	aliases := []uuid.UUID{}
	maxRevision := canonical.revision
	for _, c := range candidates {
		if c.revision > maxRevision {
			maxRevision = c.revision
		}
	}
	for _, c := range candidates[1:] {
		aliases = append(aliases, c.id)
	}
	if len(aliases) > 0 {
		if _, err = tx.Exec(ctx, `UPDATE chats SET canonical_chat_id=$3,whatsapp_owner_id=$4,binding_state='verified_continuity',binding_revision=binding_revision+1,updated_at=NOW() WHERE account_id=$1 AND id=ANY($2::uuid[]) AND canonical_chat_id IS DISTINCT FROM $3`, accountID, aliases, canonical.id, ownerID); err != nil {
			return uuid.Nil, err
		}
		// Preserve earlier aliases when the preferred operational row changes.
		if _, err = tx.Exec(ctx, `UPDATE chats SET canonical_chat_id=$3,whatsapp_owner_id=$4,binding_revision=binding_revision+1 WHERE account_id=$1 AND canonical_chat_id=ANY($2::uuid[])`, accountID, aliases, canonical.id, ownerID); err != nil {
			return uuid.Nil, err
		}
	}
	var target *uuid.UUID
	state := "verified_continuity"
	if connected == 1 {
		target = canonical.device
	} else if connected > 1 {
		state = "conflict"
	} else if deviceID != uuid.Nil {
		d := deviceID
		target = &d
	}
	if _, err = tx.Exec(ctx, `UPDATE chats SET whatsapp_owner_id=$3,canonical_chat_id=NULL,device_id=$4,binding_state=$5::text,binding_revision=CASE WHEN whatsapp_owner_id IS DISTINCT FROM $3 OR device_id IS DISTINCT FROM $4 OR binding_state<>$5::text OR $6::bool THEN GREATEST(binding_revision,$7::bigint)+1 ELSE binding_revision END,updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, canonical.id, ownerID, target, state, len(aliases) > 0, maxRevision); err != nil {
		return uuid.Nil, err
	}
	if len(aliases) > 0 {
		if err = recordDuplicateGroupMessages(ctx, tx, accountID, canonical.id); err != nil {
			return uuid.Nil, err
		}
	}
	return canonical.id, nil
}

func recordDuplicateGroupMessages(ctx context.Context, tx pgx.Tx, accountID, canonical uuid.UUID) error {
	return recordDuplicateConversationMessages(ctx, tx, accountID, canonical, "")
}

func recordDuplicateConversationMessages(ctx context.Context, tx pgx.Tx, accountID, canonical uuid.UUID, providerID string) error {
	// The provider stanza identity is stable even if history enriches text or
	// stores another media URL. PN/LID authors may collapse only with proof in
	// this owner's live scoped session, or its authenticated own pair.
	_, err := tx.Exec(ctx, `WITH conversation AS(SELECT c.whatsapp_owner_id FROM chats c WHERE c.account_id=$1 AND c.id=$2 AND c.jid LIKE '%@g.us'),ids AS(SELECT id FROM chats WHERE account_id=$1 AND (id=$2 OR canonical_chat_id=$2)),source AS(
 SELECT m.*,REGEXP_REPLACE(LOWER(BTRIM(COALESCE(m.from_jid,''))),':[0-9]+@','@') author FROM messages m WHERE m.account_id=$1 AND m.chat_id IN(SELECT id FROM ids) AND ($3::text='' OR m.message_id=$3)),authors AS(
 SELECT m.id,m.chat_id,m.message_id,m.is_from_me,m.created_at,
 EXISTS(SELECT 1 FROM whatsapp_message_aliases existing WHERE existing.account_id=$1 AND existing.alias_message_id=m.id) existing_alias,
 EXISTS(SELECT 1 FROM whatsapp_message_aliases existing WHERE existing.account_id=$1 AND existing.canonical_message_id=m.id) existing_keeper,
 COALESCE(m.media_deleted,FALSE) media_removed,
 (NULLIF(m.media_url,'') IS NOT NULL AND NOT COALESCE(m.media_deleted,FALSE)) has_media,
 EXISTS(SELECT 1 FROM chat_group_media_recovery recovery WHERE recovery.account_id=$1 AND recovery.message_id=m.id) has_recovery,
 (EXISTS(SELECT 1 FROM poll_options options WHERE options.message_id=m.id) OR EXISTS(SELECT 1 FROM poll_votes votes WHERE votes.message_id=m.id)) has_poll,
 CASE WHEN m.is_from_me AND m.author IN(o.own_pn,o.own_lid) THEN '@self' ELSE COALESCE(a.pn_jid,m.author) END author
 FROM source m CROSS JOIN conversation c JOIN whatsapp_conversation_owners o ON o.account_id=$1 AND o.id=c.whatsapp_owner_id
 LEFT JOIN LATERAL(SELECT MIN(a.pn_jid) pn_jid FROM whatsapp_peer_identity_aliases a JOIN whatsapp_identity_scopes s ON s.account_id=a.account_id AND s.device_id=a.device_id AND s.session_generation=a.session_generation
 JOIN whatsapp_device_owner_epochs e ON e.account_id=a.account_id AND e.device_id=a.device_id AND e.ended_at IS NULL AND e.owner_id=o.id AND e.session_fingerprint=s.session_fingerprint
 WHERE a.account_id=$1 AND a.lid_jid=m.author HAVING COUNT(DISTINCT a.pn_jid)=1) a ON TRUE),ranked AS(
 SELECT id,FIRST_VALUE(id) OVER(PARTITION BY message_id,is_from_me,author ORDER BY existing_alias,existing_keeper DESC,media_removed DESC,has_media DESC,has_recovery DESC,has_poll DESC,(chat_id=$2) DESC,created_at,id) keeper,
 ROW_NUMBER() OVER(PARTITION BY message_id,is_from_me,author ORDER BY existing_alias,existing_keeper DESC,media_removed DESC,has_media DESC,has_recovery DESC,has_poll DESC,(chat_id=$2) DESC,created_at,id) n FROM authors WHERE author<>'')
 INSERT INTO whatsapp_message_aliases(account_id,alias_message_id,canonical_message_id) SELECT $1,id,keeper FROM ranked WHERE n>1
 ON CONFLICT(account_id,alias_message_id) DO UPDATE SET canonical_message_id=EXCLUDED.canonical_message_id`, accountID, canonical, providerID)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT a.alias_message_id,a.canonical_message_id FROM whatsapp_message_aliases a JOIN messages m ON m.account_id=a.account_id AND m.id=a.alias_message_id JOIN chats c ON c.account_id=m.account_id AND c.id=m.chat_id WHERE a.account_id=$1 AND (c.id=$2 OR c.canonical_chat_id=$2) AND ($3::text='' OR m.message_id=$3) ORDER BY a.alias_message_id`, accountID, canonical, providerID)
	if err != nil {
		return err
	}
	pairs := [][2]uuid.UUID{}
	for rows.Next() {
		var pair [2]uuid.UUID
		if err = rows.Scan(&pair[0], &pair[1]); err != nil {
			rows.Close()
			return err
		}
		pairs = append(pairs, pair)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	batch := &pgx.Batch{}
	const mergeRestrictions = `UPDATE messages k SET is_revoked=COALESCE(k.is_revoked,FALSE) OR COALESCE(a.is_revoked,FALSE),
 is_view_once=COALESCE(k.is_view_once,FALSE) OR COALESCE(a.is_view_once,FALSE),
 forwarding_source=CASE WHEN k.forwarding_source='legacy' OR k.forwarding IS DISTINCT FROM clarin_merge_message_forwarding(k.forwarding,a.forwarding) THEN a.forwarding_source ELSE k.forwarding_source END,
 forwarding=clarin_merge_message_forwarding(k.forwarding,a.forwarding),sharing_limits=clarin_min_message_sharing_limits(k.sharing_limits,a.sharing_limits)
 FROM messages a WHERE k.account_id=$1 AND a.account_id=$1 AND k.id=$2 AND a.id=$3`
	for _, pair := range pairs {
		batch.Queue(mergeRestrictions, accountID, pair[1], pair[0])
	}
	// A raw historical UUID remains a valid reference. Restrictive flags must
	// agree on every replica; physical content and origin are preserved.
	for _, pair := range pairs {
		batch.Queue(mergeRestrictions, accountID, pair[0], pair[1])
	}
	if batch.Len() == 0 {
		return nil
	}
	results := tx.SendBatch(ctx, batch)
	return results.Close()
}

func (r *MessageRepository) ReconcileConversationMessage(ctx context.Context, accountID, chatID uuid.UUID, providerID string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var canonical uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT COALESCE(canonical_chat_id,id) FROM chats WHERE account_id=$1 AND id=$2`, accountID, chatID).Scan(&canonical); err != nil {
		return err
	}
	if err = LockMessageConversationTx(ctx, tx, accountID, canonical); err != nil {
		return err
	}
	if err = tx.QueryRow(ctx, `SELECT id FROM chats WHERE account_id=$1 AND id=$2 AND canonical_chat_id IS NULL FOR UPDATE`, accountID, canonical).Scan(&canonical); err != nil {
		return err
	}
	if err = ReconcileConversationMessageTx(ctx, tx, accountID, chatID, providerID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func ReconcileConversationMessageTx(ctx context.Context, tx pgx.Tx, accountID, chatID uuid.UUID, providerID string) error {
	var canonical uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT COALESCE(canonical_chat_id,id) FROM chats WHERE account_id=$1 AND id=$2`, accountID, chatID).Scan(&canonical); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,71141))`, accountID.String()+":"+canonical.String()); err != nil {
		return err
	}
	return recordDuplicateConversationMessages(ctx, tx, accountID, canonical, providerID)
}

func (r *ChatRepository) ReconcileWhatsAppGroups(ctx context.Context, accountID, deviceID uuid.UUID, ownPN, ownLID string) ([]uuid.UUID, error) {
	ownerID, err := r.deviceWhatsAppOwner(ctx, accountID, deviceID)
	if err != nil || ownerID == uuid.Nil {
		return nil, err
	}
	// Bound each transaction to one actual group. A large account does not hold
	// all histories locked while resolving a single conversation.
	rows, err := r.db.Query(ctx, `SELECT DISTINCT jid FROM chats WHERE account_id=$1 AND jid LIKE '%@g.us' AND canonical_chat_id IS NULL AND (whatsapp_owner_id=$2 OR whatsapp_owner_id IS NULL) ORDER BY jid`, accountID, ownerID)
	if err != nil {
		return nil, err
	}
	jids := []string{}
	for rows.Next() {
		var jid string
		if err = rows.Scan(&jid); err != nil {
			rows.Close()
			return nil, err
		}
		jids = append(jids, jid)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	changed := []uuid.UUID{}
	for _, jid := range jids {
		tx, e := r.db.Begin(ctx)
		if e != nil {
			return changed, e
		}
		e = lockCurrentWhatsAppOwner(ctx, tx, accountID, deviceID, ownerID)
		var id uuid.UUID
		if e == nil {
			id, e = reconcileOwnerGroupTx(ctx, tx, accountID, deviceID, ownerID, jid, "", false)
		}
		if e == nil {
			e = tx.Commit(ctx)
		}
		_ = tx.Rollback(ctx)
		if e != nil {
			return changed, e
		}
		if id != uuid.Nil {
			changed = append(changed, id)
		}
	}
	return changed, nil
}

// Ending a companion epoch never clears the conversation's immutable owner.
func (r *ChatRepository) EndWhatsAppOwnerEpoch(ctx context.Context, accountID, deviceID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE whatsapp_device_owner_epochs SET ended_at=NOW() WHERE account_id=$1 AND device_id=$2 AND ended_at IS NULL`, accountID, deviceID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE chats SET device_id=NULL,binding_revision=binding_revision+1,binding_state='pending',updated_at=NOW() WHERE account_id=$1 AND device_id=$2 AND whatsapp_owner_id IS NOT NULL`, accountID, deviceID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *ChatRepository) ownerGroup(ctx context.Context, accountID, deviceID uuid.UUID, jid, subject string, create bool) (uuid.UUID, bool, error) {
	ownerID, err := r.deviceWhatsAppOwner(ctx, accountID, deviceID)
	if err != nil || ownerID == uuid.Nil {
		return uuid.Nil, false, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, true, err
	}
	defer tx.Rollback(ctx)
	// Lock the companion before claiming a conversation, just as deletion does.
	if err = lockCurrentWhatsAppOwner(ctx, tx, accountID, deviceID, ownerID); err != nil {
		return uuid.Nil, true, err
	}
	id, err := reconcileOwnerGroupTx(ctx, tx, accountID, deviceID, ownerID, jid, subject, create)
	if err != nil {
		return uuid.Nil, true, err
	}
	return id, true, tx.Commit(ctx)
}

// Used by scoped repositories that need the currently verified owner without
// accessing or exposing authentication/session material.
func (r *ChatRepository) WhatsAppDeviceOwner(ctx context.Context, accountID, deviceID uuid.UUID) (uuid.UUID, error) {
	return r.deviceWhatsAppOwner(ctx, accountID, deviceID)
}

func lockCurrentWhatsAppOwner(ctx context.Context, tx pgx.Tx, accountID, deviceID, ownerID uuid.UUID) error {
	var active uuid.UUID
	return tx.QueryRow(ctx, `SELECT d.id FROM devices d JOIN whatsapp_device_owner_epochs e ON e.account_id=d.account_id AND e.device_id=d.id AND e.ended_at IS NULL WHERE d.account_id=$1 AND d.id=$2 AND e.owner_id=$3 AND d.delete_operation_id IS NULL FOR SHARE OF d,e`, accountID, deviceID, ownerID).Scan(&active)
}
