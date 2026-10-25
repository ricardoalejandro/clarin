package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/types"
)

var peerIdentityAddress = regexp.MustCompile(`^[0-9]{1,32}@(s[.]whatsapp[.]net|lid)$`)

func canonicalPeerAddress(raw string) string {
	jid, err := types.ParseJID(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	jid = jid.ToNonAD()
	if !peerIdentityAddress.MatchString(jid.String()) {
		return ""
	}
	if jid.Server == types.DefaultUserServer && (len(jid.User) < 7 || len(jid.User) > 15) {
		return ""
	}
	return jid.String()
}

func normalizePeerObservation(in domain.WhatsAppPeerObservation, now time.Time) (domain.WhatsAppPeerObservation, bool) {
	in.JID, in.PN, in.LID = canonicalPeerAddress(in.JID), canonicalPeerAddress(in.PN), canonicalPeerAddress(in.LID)
	if in.JID == "" {
		return in, false
	}
	if strings.HasSuffix(in.JID, "@lid") {
		if in.LID != "" && in.LID != in.JID {
			return in, false
		}
		in.LID = in.JID
	} else {
		if in.PN != "" && in.PN != in.JID {
			return in, false
		}
		in.PN = in.JID
	}
	if in.PN != "" && !strings.HasSuffix(in.PN, "@s.whatsapp.net") {
		return in, false
	}
	if in.LID != "" && !strings.HasSuffix(in.LID, "@lid") {
		return in, false
	}
	if domain.WhatsAppIdentitySourcePriority(in.Source) == 0 {
		return in, false
	}
	if in.ReceivedAt.IsZero() {
		in.ReceivedAt = now
	}
	if in.ObservedAt != nil {
		at := in.ObservedAt.UTC().Truncate(time.Microsecond)
		if at.IsZero() {
			in.ObservedAt = nil
		} else {
			if at.After(in.ReceivedAt.Add(5 * time.Minute)) {
				at = in.ReceivedAt
			}
			in.ObservedAt = &at
		}
	}
	clean := make(map[string]string, len(in.Fields))
	for field, value := range in.Fields {
		if value, ok := domain.SanitizeWhatsAppIdentityValue(field, value); ok {
			clean[field] = value
		}
	}
	in.Fields = clean
	return in, len(clean) > 0 || (in.PN != "" && in.LID != "")
}

const peerIdentityFieldUpsert = `INSERT INTO whatsapp_peer_identity_fields
 (account_id,device_id,jid,field,value,source,source_priority,observed_at,received_at,session_generation)
 VALUES($1,$2,$3::text,$4::text,$5::text,$6::text,$7::int,$8::timestamptz,$9::timestamptz,$10::bigint)
 ON CONFLICT(account_id,device_id,jid,field) DO UPDATE SET
 value=EXCLUDED.value,source=EXCLUDED.source,source_priority=EXCLUDED.source_priority,
 observed_at=EXCLUDED.observed_at,received_at=EXCLUDED.received_at,session_generation=EXCLUDED.session_generation
 WHERE (EXCLUDED.session_generation>whatsapp_peer_identity_fields.session_generation) OR (EXCLUDED.session_generation=whatsapp_peer_identity_fields.session_generation AND ( COALESCE(EXCLUDED.observed_at,'-infinity'::timestamptz)>COALESCE(whatsapp_peer_identity_fields.observed_at,'-infinity'::timestamptz)
 OR (COALESCE(EXCLUDED.observed_at,'-infinity'::timestamptz)=COALESCE(whatsapp_peer_identity_fields.observed_at,'-infinity'::timestamptz)
 AND EXCLUDED.observed_at IS NOT NULL AND EXCLUDED.source_priority>whatsapp_peer_identity_fields.source_priority)))`

// ObserveWhatsAppPeers persists provider facts only. It never imports CRM Contacts.
// The account/device barrier makes PN reassignment and field writes one atomic fact.
func (r *ChatRepository) ObserveWhatsAppPeers(ctx context.Context, accountID, deviceID uuid.UUID, observations []domain.WhatsAppPeerObservation) ([]string, error) {
	return r.observeWhatsAppPeers(ctx, accountID, deviceID, "", observations)
}
func (r *ChatRepository) ObserveWhatsAppPeersForSession(ctx context.Context, accountID, deviceID uuid.UUID, fingerprint string, observations []domain.WhatsAppPeerObservation) ([]string, error) {
	if fingerprint == "" {
		return nil, ErrWhatsAppIdentitySessionChanged
	}
	return r.observeWhatsAppPeers(ctx, accountID, deviceID, fingerprint, observations)
}
func (r *ChatRepository) observeWhatsAppPeers(ctx context.Context, accountID, deviceID uuid.UUID, fingerprint string, observations []domain.WhatsAppPeerObservation) ([]string, error) {
	if r == nil || r.db == nil || len(observations) == 0 {
		return nil, nil
	}
	if accountID == uuid.Nil || deviceID == uuid.Nil || len(observations) > 1000 {
		return nil, errors.New("invalid WhatsApp identity scope")
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, "wa-peer|"+accountID.String()+"|"+deviceID.String()); err != nil {
		return nil, err
	}
	var authorized bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE account_id=$1 AND id=$2 AND delete_operation_id IS NULL AND COALESCE(NULLIF(provider,''),'whatsapp_web')='whatsapp_web')`, accountID, deviceID).Scan(&authorized); err != nil {
		return nil, err
	}
	if !authorized {
		return nil, pgx.ErrNoRows
	}
	var generation int64
	initialGeneration := int64(0)
	if fingerprint != "" {
		initialGeneration = 1
	}
	if _, err = tx.Exec(ctx, `INSERT INTO whatsapp_identity_scopes(account_id,device_id,session_fingerprint,session_generation) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,device_id) DO NOTHING`, accountID, deviceID, fingerprint, initialGeneration); err != nil {
		return nil, err
	}
	var currentFingerprint string
	if err = tx.QueryRow(ctx, `SELECT session_generation,session_fingerprint FROM whatsapp_identity_scopes WHERE account_id=$1 AND device_id=$2`, accountID, deviceID).Scan(&generation, &currentFingerprint); err != nil {
		return nil, err
	}
	if fingerprint != "" && currentFingerprint == "" {
		generation++
		if _, err = tx.Exec(ctx, `UPDATE whatsapp_identity_scopes SET session_fingerprint=$3,session_generation=$4 WHERE account_id=$1 AND device_id=$2 AND session_fingerprint=''`, accountID, deviceID, fingerprint, generation); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE whatsapp_peer_identity_fields SET session_generation=$3 WHERE account_id=$1 AND device_id=$2`, accountID, deviceID, generation); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE whatsapp_peer_identity_aliases SET session_generation=$3 WHERE account_id=$1 AND device_id=$2`, accountID, deviceID, generation); err != nil {
			return nil, err
		}
		currentFingerprint = fingerprint
	}
	if fingerprint != currentFingerprint {
		return nil, ErrWhatsAppIdentitySessionChanged
	}
	changed := map[string]bool{}
	now := time.Now().UTC()
	normalized := make([]domain.WhatsAppPeerObservation, 0, len(observations))
	for _, raw := range observations {
		if in, ok := normalizePeerObservation(raw, now); ok {
			normalized = append(normalized, in)
		}
	}
	aliasChanged, err := observePeerAliases(ctx, tx, accountID, deviceID, generation, normalized)
	if err != nil {
		return nil, err
	}
	for _, jid := range aliasChanged {
		changed[jid] = true
	}
	batch := &pgx.Batch{}
	pending := []string{}
	for _, in := range normalized {
		jid := in.JID
		if in.LID != "" {
			jid = in.LID
		}
		fields := make([]string, 0, len(in.Fields))
		for field := range in.Fields {
			fields = append(fields, field)
		}
		sort.Strings(fields)
		for _, field := range fields {
			batch.Queue(peerIdentityFieldUpsert, accountID, deviceID, jid, field, in.Fields[field], in.Source, domain.WhatsAppIdentitySourcePriority(in.Source), in.ObservedAt, in.ReceivedAt, generation)
			pending = append(pending, jid)
		}
	}
	results := tx.SendBatch(ctx, batch)
	for _, jid := range pending {
		tag, err := results.Exec()
		if err != nil {
			results.Close()
			return nil, err
		}
		if tag.RowsAffected() > 0 {
			changed[jid] = true
		}
	}
	if err = results.Close(); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	aliases := make([]string, 0, len(changed))
	for jid := range changed {
		aliases = append(aliases, jid)
	}
	sort.Strings(aliases)
	return aliases, nil
}

type peerAliasFact struct {
	PN         string     `json:"pn"`
	LID        string     `json:"lid"`
	Source     string     `json:"source"`
	Priority   int        `json:"priority"`
	ObservedAt *time.Time `json:"observed_at"`
	ReceivedAt time.Time  `json:"received_at"`
}

func (a peerAliasFact) fact() domain.WhatsAppIdentityField {
	return domain.WhatsAppIdentityField{Source: a.Source, ObservedAt: a.ObservedAt, ReceivedAt: a.ReceivedAt}
}

func observePeerAliases(ctx context.Context, tx pgx.Tx, accountID, deviceID uuid.UUID, generation int64, observations []domain.WhatsAppPeerObservation) ([]string, error) {
	wanted := []string{}
	for _, in := range observations {
		if in.PN != "" && in.LID != "" {
			wanted = append(wanted, in.PN, in.LID)
		}
	}
	if len(wanted) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `SELECT pn_jid,lid_jid,source,source_priority,observed_at,received_at FROM whatsapp_peer_identity_aliases WHERE account_id=$1 AND device_id=$2 AND (pn_jid=ANY($3::text[]) OR lid_jid=ANY($3::text[])) AND session_generation=$4::bigint FOR UPDATE`, accountID, deviceID, wanted, generation)
	if err != nil {
		return nil, err
	}
	byPN, byLID := map[string]peerAliasFact{}, map[string]peerAliasFact{}
	for rows.Next() {
		var a peerAliasFact
		if err = rows.Scan(&a.PN, &a.LID, &a.Source, &a.Priority, &a.ObservedAt, &a.ReceivedAt); err != nil {
			rows.Close()
			return nil, err
		}
		byPN[a.PN], byLID[a.LID] = a, a
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	changed := map[string]bool{}
	changedPN := map[string]bool{}
	retired := map[string]peerAliasFact{}
	refreshed := []peerAliasFact{}
	for _, in := range observations {
		if in.PN == "" || in.LID == "" {
			continue
		}
		next := peerAliasFact{PN: in.PN, LID: in.LID, Source: in.Source, Priority: domain.WhatsAppIdentitySourcePriority(in.Source), ObservedAt: in.ObservedAt, ReceivedAt: in.ReceivedAt}
		oldPN, hasPN := byPN[in.PN]
		oldLID, hasLID := byLID[in.LID]
		if (hasPN && !domain.WhatsAppIdentityFieldNewer(next.fact(), oldPN.fact())) || (hasLID && !domain.WhatsAppIdentityFieldNewer(next.fact(), oldLID.fact())) {
			continue
		}
		if hasPN && hasLID && oldPN.PN == next.PN && oldPN.LID == next.LID && oldLID.PN == next.PN && oldLID.LID == next.LID {
			refreshed = append(refreshed, next)
			byPN[in.PN], byLID[in.LID] = next, next
			continue
		}
		for _, old := range []peerAliasFact{oldPN, oldLID} {
			if old.PN == "" {
				continue
			}
			delete(byPN, old.PN)
			delete(byLID, old.LID)
			changedPN[old.PN] = true
			changed[old.PN], changed[old.LID] = true, true
			if old.PN != in.PN || old.LID != in.LID {
				retired[old.PN] = next
				retired[in.PN] = next
			}
		}
		byPN[in.PN], byLID[in.LID] = next, next
		changedPN[in.PN] = true
		changed[in.PN], changed[in.LID] = true, true
	}
	if len(refreshed) > 0 {
		raw, marshalErr := json.Marshal(refreshed)
		if marshalErr != nil {
			return nil, marshalErr
		}
		if _, err = tx.Exec(ctx, `UPDATE whatsapp_peer_identity_aliases a SET source=x.source,source_priority=x.priority,observed_at=x.observed_at,received_at=x.received_at FROM jsonb_to_recordset($3::jsonb) x(pn text,lid text,source text,priority int,observed_at timestamptz,received_at timestamptz) WHERE a.account_id=$1 AND a.device_id=$2 AND a.pn_jid=x.pn AND a.lid_jid=x.lid AND a.session_generation=$4::bigint`, accountID, deviceID, raw, generation); err != nil {
			return nil, err
		}
	}
	if len(changedPN) == 0 {
		return nil, nil
	}
	phones := []string{}
	facts := []peerAliasFact{}
	for pn := range changedPN {
		phones = append(phones, pn)
		if a, exists := byPN[pn]; exists {
			facts = append(facts, a)
		}
	}
	if len(retired) > 0 {
		batch := &pgx.Batch{}
		for pn, a := range retired {
			batch.Queue(`INSERT INTO whatsapp_peer_identity_fields(account_id,device_id,jid,field,value,source,source_priority,observed_at,received_at,session_generation)
 SELECT $1,$2,$3::text,field,'','alias_reassigned',200,$4::timestamptz,$5::timestamptz,$6::bigint
 FROM unnest(ARRAY['full_name','first_name','business_name','push_name','username','redacted_phone']) AS field
 ON CONFLICT(account_id,device_id,jid,field) DO UPDATE SET value='',source='alias_reassigned',source_priority=200,
 observed_at=GREATEST(whatsapp_peer_identity_fields.observed_at,EXCLUDED.observed_at),received_at=EXCLUDED.received_at,session_generation=EXCLUDED.session_generation`, accountID, deviceID, pn, a.ObservedAt, a.ReceivedAt, generation)
		}
		result := tx.SendBatch(ctx, batch)
		for range retired {
			if _, err = result.Exec(); err != nil {
				result.Close()
				return nil, err
			}
		}
		if err = result.Close(); err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM whatsapp_peer_identity_aliases WHERE account_id=$1 AND device_id=$2 AND pn_jid=ANY($3::text[])`, accountID, deviceID, phones); err != nil {
		return nil, err
	}
	if len(facts) > 0 {
		payload, err := json.Marshal(facts)
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO whatsapp_peer_identity_aliases(account_id,device_id,pn_jid,lid_jid,source,source_priority,observed_at,received_at,session_generation)
 SELECT $1,$2,x.pn,x.lid,x.source,x.priority,x.observed_at,x.received_at,$4::bigint FROM jsonb_to_recordset($3::jsonb) AS x(pn text,lid text,source text,priority int,observed_at timestamptz,received_at timestamptz)`, accountID, deviceID, payload, generation); err != nil {
			return nil, err
		}
	}
	aliases := []string{}
	for jid := range changed {
		aliases = append(aliases, jid)
	}
	return aliases, nil
}

// WhatsAppPeerAliases reads only provider pairs proven for this account and device.
// The upstream LID cache is container-global and must not authorize identity reads.
func (r *ChatRepository) WhatsAppPeerAliases(ctx context.Context, accountID, deviceID uuid.UUID, jids []string) (*domain.WhatsAppPeerIdentitySnapshot, error) {
	out := &domain.WhatsAppPeerIdentitySnapshot{Fields: map[string]map[string]domain.WhatsAppIdentityField{}, PNForLID: map[string]string{}, LIDForPN: map[string]string{}, AliasFields: map[string]domain.WhatsAppIdentityField{}}
	if r == nil || r.db == nil || len(jids) == 0 {
		return out, nil
	}
	unique := map[string]bool{}
	for _, raw := range jids {
		if jid := canonicalPeerAddress(raw); jid != "" {
			unique[jid] = true
		}
	}
	requested := make([]string, 0, len(unique))
	for jid := range unique {
		requested = append(requested, jid)
	}
	if len(requested) == 0 {
		return out, nil
	}
	rows, err := r.db.Query(ctx, `SELECT pn_jid,lid_jid,source,observed_at,received_at FROM whatsapp_peer_identity_aliases WHERE account_id=$1 AND device_id=$2 AND (pn_jid=ANY($3::text[]) OR lid_jid=ANY($3::text[])) AND session_generation=COALESCE((SELECT session_generation FROM whatsapp_identity_scopes WHERE account_id=$1 AND device_id=$2),0)`, accountID, deviceID, requested)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var pn, lid string
		var fact domain.WhatsAppIdentityField
		if err = rows.Scan(&pn, &lid, &fact.Source, &fact.ObservedAt, &fact.ReceivedAt); err != nil {
			rows.Close()
			return out, err
		}
		out.PNForLID[lid], out.LIDForPN[pn] = pn, lid
		fact.Value = lid
		out.AliasFields[pn] = fact
		fact.Value = pn
		out.AliasFields[lid] = fact
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	return out, nil
}

// WhatsAppPeerIdentities loads only requested aliases and their proven counterpart.
// Existing group message push names are a dated fallback, never CRM data.
func (r *ChatRepository) WhatsAppPeerIdentities(ctx context.Context, accountID, deviceID uuid.UUID, jids []string) (*domain.WhatsAppPeerIdentitySnapshot, error) {
	var initialGeneration int64
	if r != nil && r.db != nil && len(jids) > 0 {
		if generationErr := r.db.QueryRow(ctx, `SELECT COALESCE(MAX(session_generation),0) FROM whatsapp_identity_scopes WHERE account_id=$1 AND device_id=$2`, accountID, deviceID).Scan(&initialGeneration); generationErr != nil {
			return nil, generationErr
		}
	}
	out, err := r.WhatsAppPeerAliases(ctx, accountID, deviceID, jids)
	if err != nil || r == nil || r.db == nil || len(jids) == 0 {
		return out, err
	}
	unique := map[string]bool{}
	for _, raw := range jids {
		if jid := canonicalPeerAddress(raw); jid != "" {
			unique[jid] = true
		}
	}
	for pn, lid := range out.LIDForPN {
		unique[pn], unique[lid] = true, true
	}
	if len(unique) == 0 {
		return out, nil
	}
	aliases := make([]string, 0, len(unique))
	for jid := range unique {
		aliases = append(aliases, jid)
	}
	rows, err := r.db.Query(ctx, `SELECT jid,field,value,source,observed_at,received_at FROM whatsapp_peer_identity_fields WHERE account_id=$1 AND device_id=$2 AND jid=ANY($3::text[]) AND session_generation=COALESCE((SELECT session_generation FROM whatsapp_identity_scopes WHERE account_id=$1 AND device_id=$2),0)`, accountID, deviceID, aliases)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var jid, field string
		var fact domain.WhatsAppIdentityField
		if err = rows.Scan(&jid, &field, &fact.Value, &fact.Source, &fact.ObservedAt, &fact.ReceivedAt); err != nil {
			rows.Close()
			return out, err
		}
		if out.Fields[jid] == nil {
			out.Fields[jid] = map[string]domain.WhatsAppIdentityField{}
		}
		out.Fields[jid][field] = fact
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = r.db.Query(ctx, `SELECT DISTINCT ON(m.from_jid) m.from_jid,m.from_name,m.timestamp,COALESCE(m.created_at,m.timestamp)
 FROM messages m JOIN chats c ON c.account_id=m.account_id AND c.id=m.chat_id
 WHERE m.account_id=$1 AND m.device_id=$2 AND m.from_jid=ANY($3::text[]) AND m.is_from_me=FALSE
 AND c.jid LIKE '%@g.us' AND NULLIF(BTRIM(m.from_name),'') IS NOT NULL
 AND m.created_at>=COALESCE((SELECT session_started_at FROM whatsapp_identity_scopes WHERE account_id=$1 AND device_id=$2),'-infinity'::timestamptz)
 ORDER BY m.from_jid,m.timestamp DESC,m.id DESC`, accountID, deviceID, aliases)
	if err != nil {
		return out, fmt.Errorf("load WhatsApp group name history: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var jid, value string
		var at, receivedAt time.Time
		if err = rows.Scan(&jid, &value, &at, &receivedAt); err != nil {
			return out, err
		}
		value, ok := domain.SanitizeWhatsAppIdentityValue("push_name", value)
		if !ok || value == "" {
			continue
		}
		fact := domain.WhatsAppIdentityField{Value: value, Source: "stored_message", ObservedAt: &at, ReceivedAt: receivedAt}
		if out.Fields[jid] == nil {
			out.Fields[jid] = map[string]domain.WhatsAppIdentityField{}
		}
		old, exists := out.Fields[jid]["push_name"]
		if !exists || domain.WhatsAppIdentityFieldNewer(fact, old) {
			out.Fields[jid]["push_name"] = fact
		}
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	var currentGeneration int64
	if err = r.db.QueryRow(ctx, `SELECT COALESCE(MAX(session_generation),0) FROM whatsapp_identity_scopes WHERE account_id=$1 AND device_id=$2`, accountID, deviceID).Scan(&currentGeneration); err != nil {
		return out, err
	}
	if currentGeneration != initialGeneration {
		return nil, ErrWhatsAppIdentitySessionChanged
	}
	return out, nil
}

func (r *ChatRepository) WhatsAppPeerGroupIDs(ctx context.Context, accountID, deviceID uuid.UUID, aliases []string) ([]uuid.UUID, error) {
	if r == nil || r.db == nil || len(aliases) == 0 {
		return nil, nil
	}
	rows, err := r.db.Query(ctx, `WITH scope AS (SELECT unnest($3::text[]) AS jid UNION SELECT pn_jid FROM whatsapp_peer_identity_aliases WHERE account_id=$1 AND device_id=$2 AND lid_jid=ANY($3::text[]) UNION SELECT lid_jid FROM whatsapp_peer_identity_aliases WHERE account_id=$1 AND device_id=$2 AND pn_jid=ANY($3::text[]))
 SELECT g.chat_id FROM chat_groups g JOIN chats c ON c.account_id=g.account_id AND c.id=g.chat_id
 WHERE g.account_id=$1 AND c.device_id=$2 AND g.membership_status='member' AND EXISTS(
 SELECT 1 FROM jsonb_array_elements(g.participants) AS member WHERE member->>'jid' IN(SELECT jid FROM scope) OR member->>'lid' IN(SELECT jid FROM scope))`, accountID, deviceID, aliases)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
