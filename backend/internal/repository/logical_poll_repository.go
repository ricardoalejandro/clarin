package repository

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// Poll replicas retain their original IDs and FKs. Reads derive one current
// vote per proven voter; older snapshots never add another vote or undo an
// explicit later empty selection. Provider aliases are scoped to the same
// conversation owner and an authenticated current companion session.
const logicalPollScopeSQL = `WITH seed AS(
 SELECT m.account_id,COALESCE(a.canonical_message_id,m.id) keeper,COALESCE(c.canonical_chat_id,c.id) chat_id
 FROM messages m JOIN chats c ON c.account_id=m.account_id AND c.id=m.chat_id
 LEFT JOIN whatsapp_message_aliases a ON a.account_id=m.account_id AND a.alias_message_id=m.id WHERE m.id=$1
 ),candidate_ids AS(SELECT keeper id FROM seed UNION SELECT a.alias_message_id FROM whatsapp_message_aliases a JOIN seed s ON s.account_id=a.account_id AND s.keeper=a.canonical_message_id),
 scope AS(SELECT m.id FROM messages m JOIN candidate_ids ids ON ids.id=m.id JOIN chats c ON c.account_id=m.account_id AND c.id=m.chat_id CROSS JOIN seed s WHERE m.account_id=s.account_id AND COALESCE(c.canonical_chat_id,c.id)=s.chat_id),
 identity AS(SELECT s.*,c.whatsapp_owner_id owner_id,o.own_pn,o.own_lid FROM seed s JOIN chats c ON c.account_id=s.account_id AND c.id=s.chat_id LEFT JOIN whatsapp_conversation_owners o ON o.account_id=c.account_id AND o.id=c.whatsapp_owner_id),
 raw_votes AS(SELECT v.*,REGEXP_REPLACE(LOWER(BTRIM(v.voter_jid)),':[0-9]+@','@') voter FROM poll_votes v JOIN scope s ON s.id=v.message_id),
 normalized_votes AS(SELECT v.*,CASE WHEN v.voter IN(i.own_pn,i.own_lid) THEN '@self'
 WHEN v.voter ~ '^[0-9]+@(s[.]whatsapp[.]net|lid)$' THEN COALESCE(alias.pn_jid,v.voter)
 ELSE 'unproven:'||v.message_id::text||':'||v.voter END voter_key
 FROM raw_votes v CROSS JOIN identity i LEFT JOIN LATERAL(
 SELECT MIN(a.pn_jid) pn_jid FROM whatsapp_peer_identity_aliases a
 JOIN whatsapp_identity_scopes s ON s.account_id=a.account_id AND s.device_id=a.device_id AND s.session_generation=a.session_generation AND s.session_fingerprint<>''
 JOIN whatsapp_device_owner_epochs e ON e.account_id=s.account_id AND e.device_id=s.device_id AND e.session_fingerprint=s.session_fingerprint AND e.owner_id=i.owner_id AND e.ended_at IS NULL
 JOIN devices d ON d.account_id=e.account_id AND d.id=e.device_id AND d.delete_operation_id IS NULL
 WHERE a.account_id=i.account_id AND a.lid_jid=v.voter HAVING COUNT(DISTINCT a.pn_jid)=1
 ) alias ON TRUE),
 votes AS(SELECT DISTINCT ON(voter_key) v.* FROM normalized_votes v CROSS JOIN seed s ORDER BY voter_key,v.timestamp DESC NULLS LAST,(v.message_id=s.keeper) DESC,v.id DESC)`

func (r *PollRepository) logicalOptions(ctx context.Context, messageID uuid.UUID) ([]*domain.PollOption, error) {
	rows, err := r.db.Query(ctx, logicalPollScopeSQL+`,options AS(SELECT DISTINCT ON(o.name) o.* FROM poll_options o JOIN scope ids ON ids.id=o.message_id CROSS JOIN seed s ORDER BY o.name,(o.message_id=s.keeper) DESC,o.id)
 SELECT o.id,s.keeper,o.name,(SELECT COUNT(*)::int FROM votes v WHERE o.name=ANY(v.selected_names)) FROM options o CROSS JOIN seed s ORDER BY o.id`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var options []*domain.PollOption
	for rows.Next() {
		o := &domain.PollOption{}
		if err = rows.Scan(&o.ID, &o.MessageID, &o.Name, &o.VoteCount); err != nil {
			return nil, err
		}
		options = append(options, o)
	}
	return options, rows.Err()
}
func (r *PollRepository) logicalVotes(ctx context.Context, messageID uuid.UUID) ([]*domain.PollVote, error) {
	rows, err := r.db.Query(ctx, logicalPollScopeSQL+` SELECT v.id,s.keeper,v.voter_jid,v.selected_names,v.timestamp FROM votes v CROSS JOIN seed s ORDER BY v.timestamp,v.id`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var votes []*domain.PollVote
	for rows.Next() {
		v := &domain.PollVote{}
		if err = rows.Scan(&v.ID, &v.MessageID, &v.VoterJID, &v.SelectedNames, &v.Timestamp); err != nil {
			return nil, err
		}
		votes = append(votes, v)
	}
	return votes, rows.Err()
}
