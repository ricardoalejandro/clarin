package repository

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type ReportRepository struct {
	db *pgxpool.Pool
}

func (r *ReportRepository) MatchWhatsAppGroupMembers(ctx context.Context, accountID uuid.UUID, identities []domain.WhatsAppGroupReportIdentity) (map[int][]uuid.UUID, error) {
	result := make(map[int][]uuid.UUID, len(identities))
	if len(identities) == 0 {
		return result, nil
	}
	ordinals := make([]int32, 0, len(identities))
	phones := make([]string, 0, len(identities))
	phoneJIDs := make([]string, 0, len(identities))
	lids := make([]string, 0, len(identities))
	for _, identity := range identities {
		ordinals = append(ordinals, int32(identity.Ordinal))
		phone := ""
		if identity.Phone != nil {
			phone = *identity.Phone
		}
		phones = append(phones, phone)
		phoneJIDs = append(phoneJIDs, identity.PhoneJID)
		lids = append(lids, identity.LID)
	}

	rows, err := r.db.Query(ctx, `
		WITH requested AS (
			SELECT * FROM unnest($2::int4[], $3::text[], $4::text[], $5::text[])
				AS r(ordinal, phone, phone_jid, lid)
		), contact_raw_identity AS (
			SELECT c.id AS contact_id,
			       REGEXP_REPLACE(COALESCE(NULLIF(c.phone, ''), SPLIT_PART(c.jid, '@', 1)), '[^0-9]', '', 'g') AS digits
			FROM contacts c
			WHERE c.account_id = $1 AND c.is_group = FALSE
		), contact_identity AS (
			SELECT contact_id,
			       CASE WHEN LENGTH(digits) = 9 AND digits LIKE '9%' THEN '51' || digits ELSE digits END AS phone
			FROM contact_raw_identity
			WHERE digits <> ''
		), extra_phone_raw AS (
			SELECT cp.contact_id, REGEXP_REPLACE(cp.phone, '[^0-9]', '', 'g') AS digits
			FROM contact_phones cp
			JOIN contacts c ON c.id = cp.contact_id AND c.account_id = $1 AND c.is_group = FALSE
		), extra_phone_identity AS (
			SELECT contact_id,
			       CASE WHEN LENGTH(digits) = 9 AND digits LIKE '9%' THEN '51' || digits ELSE digits END AS phone
			FROM extra_phone_raw
			WHERE digits <> ''
		), candidates AS (
			SELECT req.ordinal, c.id AS contact_id, 0 AS priority
			FROM requested req
			JOIN contacts c ON c.account_id = $1 AND c.is_group = FALSE
			 AND req.phone_jid <> '' AND LOWER(c.jid) = LOWER(req.phone_jid)
			UNION ALL
			SELECT req.ordinal, c.id AS contact_id, 0 AS priority
			FROM requested req
			JOIN contacts c ON c.account_id = $1 AND c.is_group = FALSE
			 AND req.lid <> '' AND LOWER(c.jid) = LOWER(req.lid)
			UNION ALL
			SELECT req.ordinal, ca.contact_id, 1 AS priority
			FROM requested req
			JOIN contact_aliases ca ON ca.account_id = $1 AND ca.alias_type = 'jid'
			 AND ((req.phone_jid <> '' AND ca.normalized_value = LOWER(req.phone_jid))
			   OR (req.lid <> '' AND ca.normalized_value = LOWER(req.lid)))
			JOIN contacts c ON c.id = ca.contact_id AND c.account_id = $1 AND c.is_group = FALSE
			UNION ALL
			SELECT req.ordinal, ci.contact_id, 2 AS priority
			FROM requested req JOIN contact_identity ci ON req.phone <> '' AND ci.phone = req.phone
			UNION ALL
			SELECT req.ordinal, epi.contact_id, 3 AS priority
			FROM requested req JOIN extra_phone_identity epi ON req.phone <> '' AND epi.phone = req.phone
			UNION ALL
			SELECT req.ordinal, ca.contact_id, 4 AS priority
			FROM requested req
			JOIN contact_aliases ca ON ca.account_id = $1 AND ca.alias_type = 'phone'
			 AND req.phone <> '' AND ca.normalized_value = req.phone
			JOIN contacts c ON c.id = ca.contact_id AND c.account_id = $1 AND c.is_group = FALSE
		), deduplicated AS (
			SELECT ordinal, contact_id, MIN(priority) AS priority
			FROM candidates GROUP BY ordinal, contact_id
		), best_priority AS (
			SELECT ordinal, MIN(priority) AS priority
			FROM deduplicated GROUP BY ordinal
		)
		SELECT d.ordinal, d.contact_id
		FROM deduplicated d
		JOIN best_priority bp ON bp.ordinal = d.ordinal AND bp.priority = d.priority
		ORDER BY d.ordinal, d.contact_id
	`, accountID, ordinals, phones, phoneJIDs, lids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ordinal int
		var contactID uuid.UUID
		if err := rows.Scan(&ordinal, &contactID); err != nil {
			return nil, err
		}
		result[ordinal] = append(result[ordinal], contactID)
	}
	return result, rows.Err()
}

func (r *ReportRepository) GetWhatsAppReportContacts(ctx context.Context, accountID uuid.UUID, contactIDs []uuid.UUID) (map[uuid.UUID]*domain.WhatsAppReportContact, error) {
	result := make(map[uuid.UUID]*domain.WhatsAppReportContact, len(contactIDs))
	if len(contactIDs) == 0 {
		return result, nil
	}
	rows, err := r.db.Query(ctx, `
		WITH tag_agg AS (
			SELECT ct.contact_id,
			       JSONB_AGG(JSONB_BUILD_OBJECT('id', t.id, 'name', t.name, 'color', t.color) ORDER BY LOWER(t.name)) AS tags
			FROM contact_tags ct
			JOIN contacts c ON c.id = ct.contact_id AND c.account_id = $1
			JOIN tags t ON t.id = ct.tag_id AND t.account_id = $1
			WHERE ct.contact_id = ANY($2::uuid[])
			GROUP BY ct.contact_id
		), lead_rows AS (
			SELECT l.id, l.contact_id, l.title, l.updated_at,
			       (l.status = 'open' AND COALESCE(l.is_archived, FALSE) = FALSE) AS is_active,
			       COALESCE(p.name, '') AS pipeline_name,
			       COALESCE(ps.name, '') AS stage_name,
			       COALESCE(ps.color, '') AS stage_color,
			       COALESCE(assignee.display_name, '') AS assigned_to_name
			FROM leads l
			LEFT JOIN pipelines p ON p.id = l.pipeline_id AND p.account_id = l.account_id
			LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id AND ps.pipeline_id = l.pipeline_id
			LEFT JOIN LATERAL (
				SELECT COALESCE(NULLIF(u.display_name, ''), u.username, '') AS display_name
				FROM user_accounts ua JOIN users u ON u.id = ua.user_id
				WHERE ua.account_id = l.account_id AND ua.user_id = l.assigned_to
				LIMIT 1
			) assignee ON TRUE
			WHERE l.account_id = $1 AND l.contact_id = ANY($2::uuid[]) AND l.deleted_at IS NULL
		), lead_agg AS (
			SELECT contact_id,
			       COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
				'id', id, 'title', title, 'pipeline_name', pipeline_name,
				'stage_name', stage_name, 'stage_color', stage_color,
				'assigned_to_name', assigned_to_name, 'updated_at', updated_at
			) ORDER BY updated_at DESC, id DESC) FILTER (WHERE is_active), '[]'::jsonb) AS active_leads,
			       COUNT(*) FILTER (WHERE NOT is_active) AS historical_count
			FROM lead_rows GROUP BY contact_id
		), chat_agg AS (
			SELECT ch.contact_id, MAX(ch.last_message_at) AS last_activity
			FROM chats ch
			WHERE ch.account_id = $1 AND ch.contact_id = ANY($2::uuid[])
			GROUP BY ch.contact_id
		)
		SELECT c.id,
		       COALESCE(NULLIF(BTRIM(c.custom_name), ''),
		                NULLIF(BTRIM(CONCAT_WS(' ', c.name, c.last_name)), ''),
		                NULLIF(BTRIM(c.push_name), ''), NULLIF(c.phone, ''), c.jid) AS display_name,
		       COALESCE(c.source, ''), c.do_not_contact, ca.last_activity,
		       COALESCE(ta.tags, '[]'::jsonb), COALESCE(la.active_leads, '[]'::jsonb),
		       COALESCE(la.historical_count, 0)
		FROM contacts c
		LEFT JOIN tag_agg ta ON ta.contact_id = c.id
		LEFT JOIN lead_agg la ON la.contact_id = c.id
		LEFT JOIN chat_agg ca ON ca.contact_id = c.id
		WHERE c.account_id = $1 AND c.id = ANY($2::uuid[]) AND c.is_group = FALSE
	`, accountID, contactIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		contact := &domain.WhatsAppReportContact{}
		var tagsJSON, leadsJSON json.RawMessage
		if err := rows.Scan(
			&contact.ID, &contact.DisplayName, &contact.Source, &contact.DoNotContact,
			&contact.LastDirectActivityAt, &tagsJSON, &leadsJSON, &contact.HistoricalLeadCount,
		); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(tagsJSON, &contact.Tags); err != nil {
			return nil, fmt.Errorf("decode report tags: %w", err)
		}
		if err := json.Unmarshal(leadsJSON, &contact.ActiveLeads); err != nil {
			return nil, fmt.Errorf("decode report leads: %w", err)
		}
		if contact.Tags == nil {
			contact.Tags = []domain.WhatsAppReportTag{}
		}
		if contact.ActiveLeads == nil {
			contact.ActiveLeads = []domain.WhatsAppReportLead{}
		}
		result[contact.ID] = contact
	}
	return result, rows.Err()
}
