package api

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

const leadIntelligenceAIMaxCandidates = 250

type leadIntelligenceParameters struct {
	ObjectiveType       string      `json:"objective_type"`
	ObjectiveName       string      `json:"objective_name"`
	CampaignContext     string      `json:"campaign_context"`
	Scope               string      `json:"scope"`
	ChatHistory         string      `json:"chat_history"`
	PipelineIDs         []uuid.UUID `json:"pipeline_ids"`
	StageIDs            []uuid.UUID `json:"stage_ids"`
	TagIDs              []uuid.UUID `json:"tag_ids"`
	Sources             []string    `json:"sources"`
	CreatedFrom         *time.Time  `json:"created_from,omitempty"`
	CreatedTo           *time.Time  `json:"created_to,omitempty"`
	ActivityFrom        *time.Time  `json:"activity_from,omitempty"`
	ActivityTo          *time.Time  `json:"activity_to,omitempty"`
	IncludeArchivedLost bool        `json:"include_archived_lost"`
	IncludeConverted    bool        `json:"include_converted"`
	ReasoningEffort     string      `json:"reasoning_effort"`
}

type leadIntelligenceFact struct {
	LeadID             uuid.UUID
	ContactID          *uuid.UUID
	Name               string
	Phone              string
	Email              string
	Age                int
	DNI                string
	CreatedAt          time.Time
	LastActivityAt     time.Time
	Source             string
	Status             string
	LeadNotes          string
	ContactNotes       string
	LeadTags           []string
	ContactTags        []string
	IsArchived         bool
	DoNotContact       bool
	DoNotContactReason string
	StageName          string
	StageType          string
	IncomingCount      int
	OutgoingCount      int
	LastIncomingAt     *time.Time
	LastOutgoingAt     *time.Time
	Evidence           string
	Philosophical      bool
	AskedDetails       bool
	NewDate            bool
	Obstacle           bool
	Emotional          bool
	Family             bool
	Rejection          bool
	Confirmation       bool
	GenericInterest    bool
	Events             string
	EventNotes         string
	EventDetails       json.RawMessage
	Attended           bool
	Confirmed          bool
	Missed             bool
	EventCount         int
	Programs           string
	Converted          bool
	Campaigns          string
	CampaignCount      int
	InteractionNotes   string
	PhoneMatches       int
	EmailMatches       int
	DuplicatePrimary   string
}

type leadIntelligenceAnalyzed struct {
	Fact       leadIntelligenceFact
	Row        map[string]any
	Score      int
	Candidate  bool
	HardLocked bool
	AIAnalyzed bool
	Position   int
}

func (s *Server) loadLeadIntelligenceFacts(ctx context.Context, accountID uuid.UUID, params leadIntelligenceParameters) ([]leadIntelligenceFact, error) {
	args := []any{accountID}
	where := []string{"l.account_id=$1", "l.deleted_at IS NULL"}
	addArg := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if params.Scope == "active" || !params.IncludeArchivedLost {
		where = append(where, "l.status='open'", "COALESCE(l.is_archived,FALSE)=FALSE")
	}
	if len(params.PipelineIDs) > 0 {
		where = append(where, "l.pipeline_id=ANY("+addArg(params.PipelineIDs)+")")
	}
	if len(params.StageIDs) > 0 {
		where = append(where, "l.stage_id=ANY("+addArg(params.StageIDs)+")")
	}
	if len(params.TagIDs) > 0 {
		where = append(where, "EXISTS (SELECT 1 FROM contact_tags selected_ct WHERE selected_ct.contact_id=l.contact_id AND selected_ct.tag_id=ANY("+addArg(params.TagIDs)+"))")
	}
	if len(params.Sources) > 0 {
		normalized := make([]string, 0, len(params.Sources))
		for _, source := range params.Sources {
			if value := strings.ToLower(strings.TrimSpace(source)); value != "" {
				normalized = append(normalized, value)
			}
		}
		if len(normalized) > 0 {
			where = append(where, "LOWER(COALESCE(l.source,''))=ANY("+addArg(normalized)+")")
		}
	}
	if params.CreatedFrom != nil {
		where = append(where, "l.created_at>="+addArg(*params.CreatedFrom))
	}
	if params.CreatedTo != nil {
		where = append(where, "l.created_at<"+addArg(*params.CreatedTo))
	}
	messageTimeFilter := ""
	if params.ChatHistory != "all" {
		months := map[string]int{"6m": 6, "12m": 12, "24m": 24}[params.ChatHistory]
		if months > 0 {
			messageTimeFilter = fmt.Sprintf(" AND m.timestamp >= NOW() - INTERVAL '%d months'", months)
		}
	}

	query := `
	WITH base AS (
		SELECT l.id,l.account_id,l.contact_id,l.jid,
			COALESCE(NULLIF(BTRIM(l.name),''),NULLIF(BTRIM(c.custom_name),''),NULLIF(BTRIM(c.name),''),'Sin nombre') name,
			COALESCE(NULLIF(l.phone,''),NULLIF(c.phone,''),'') phone,
			COALESCE(NULLIF(l.email,''),NULLIF(c.email,''),'') email,
			COALESCE(l.age,c.age,0) age,COALESCE(NULLIF(l.dni,''),NULLIF(c.dni,''),'') dni,
			l.created_at,l.updated_at,COALESCE(l.source,'') source,COALESCE(l.status,'') status,COALESCE(l.notes,'') lead_notes,
			COALESCE(c.notes,'') contact_notes,COALESCE(l.tags,'{}'::text[]) lead_tags,COALESCE(c.tags,'{}'::text[]) contact_tags_array,
			COALESCE(l.is_archived,FALSE) is_archived,COALESCE(c.do_not_contact,FALSE) do_not_contact,COALESCE(c.do_not_contact_reason,'') do_not_contact_reason,
			COALESCE(ps.name,'') stage_name,COALESCE(ps.stage_type,'') stage_type
		FROM leads l
		LEFT JOIN contacts c ON c.id=l.contact_id AND c.account_id=l.account_id
		LEFT JOIN pipeline_stages ps ON ps.id=l.stage_id
		WHERE ` + strings.Join(where, " AND ") + `
	), contact_tag_agg AS (
		SELECT b.id lead_id,COALESCE(array_agg(DISTINCT t.name ORDER BY t.name) FILTER (WHERE t.id IS NOT NULL),'{}'::text[]) tags
		FROM base b LEFT JOIN contact_tags ct ON ct.contact_id=b.contact_id
		LEFT JOIN tags t ON t.id=ct.tag_id AND t.account_id=b.account_id GROUP BY b.id
	), lead_chat_map AS (
		SELECT DISTINCT b.id lead_id,ch.id chat_id FROM base b JOIN chats ch ON ch.account_id=b.account_id
		AND (ch.contact_id=b.contact_id OR (ch.contact_id IS NULL AND ch.jid=b.jid))
	), message_rows AS (
		SELECT lcm.lead_id,m.body,m.is_from_me,m.timestamp,
			row_number() OVER (PARTITION BY lcm.lead_id,m.is_from_me ORDER BY m.timestamp DESC,m.id DESC) rn
		FROM lead_chat_map lcm JOIN messages m ON m.chat_id=lcm.chat_id AND m.account_id=$1
		WHERE NOT COALESCE(m.is_revoked,FALSE)` + messageTimeFilter + `
	), message_agg AS (
		SELECT lead_id,
			count(*) FILTER (WHERE NOT is_from_me) incoming_count,count(*) FILTER (WHERE is_from_me) outgoing_count,
			max(timestamp) FILTER (WHERE NOT is_from_me) last_incoming_at,max(timestamp) FILTER (WHERE is_from_me) last_outgoing_at,
			COALESCE(string_agg(left(regexp_replace(COALESCE(body,''),E'[\\n\\r\\t]+',' ','g'),280),' | ' ORDER BY timestamp DESC)
				FILTER (WHERE NOT is_from_me AND rn<=6 AND BTRIM(COALESCE(body,''))<>''),'') evidence,
			COALESCE(bool_or(NOT is_from_me AND COALESCE(body,'') ~* '(conocete|conócete|curso|filosof[ií]a|autoconocimiento|quien soy|quién soy|sentido de vida)'),FALSE) philosophical,
			COALESCE(bool_or(NOT is_from_me AND COALESCE(body,'') ~* '(horario|hora|direcci[oó]n|d[oó]nde|modalidad|virtual|presencial|costo|precio|cu[aá]nto dura|profesor|docente)'),FALSE) asked_details,
			COALESCE(bool_or(NOT is_from_me AND COALESCE(body,'') ~* '(nueva fecha|otra fecha|pr[oó]xima fecha|av[ií]same|av[ií]seme|me gustar[ií]a participar)'),FALSE) new_date,
			COALESCE(bool_or(NOT is_from_me AND COALESCE(body,'') ~* '(disculp|no pude|no podr[eé]|examen|trabajo|lluvia|enferm|horario|reuni[oó]n|clases|universidad|estudi)'),FALSE) obstacle,
			COALESCE(bool_or(NOT is_from_me AND COALESCE(body,'') ~* '(ansiedad|cansad|estr[eé]s|serenidad|fortaleza|dolor|emocion|emoci[oó]n|resilien|equilibrio|triste)'),FALSE) emotional,
			COALESCE(bool_or(NOT is_from_me AND COALESCE(body,'') ~* '(esposa|esposo|hij[oa]|sobrin|amig[oa]|acompa[ñn])'),FALSE) family,
			COALESCE(bool_or(NOT is_from_me AND COALESCE(body,'') ~* '(no me (interesa|escriban|contacten)|no deseo|elimin|baja)'),FALSE) rejection,
			COALESCE(bool_or(NOT is_from_me AND COALESCE(body,'') ~* '(confirmo|confirmad|ah[ií] estar[eé]|voy a ir|asistir[eé]|me inscrib|registr)'),FALSE) confirmation,
			COALESCE(bool_or(NOT is_from_me AND COALESCE(body,'') ~* '(quiero informaci[oó]n|m[aá]s info|me interesa|informes)'),FALSE) generic_interest
		FROM message_rows GROUP BY lead_id
	), event_map AS (
		SELECT DISTINCT b.id lead_id,ep.id participant_id FROM base b
		JOIN event_participants ep ON ep.lead_id=b.id OR (b.contact_id IS NOT NULL AND ep.contact_id=b.contact_id)
		JOIN events e ON e.id=ep.event_id AND e.account_id=b.account_id
	), event_agg AS (
		SELECT em.lead_id,
			string_agg(concat_ws(' — ',e.name,COALESCE(e.event_date::date::text,''),'evento: '||COALESCE(e.status,''),'participante: '||COALESCE(ep.status,'')),' | ' ORDER BY e.event_date DESC NULLS LAST) events,
			COALESCE(string_agg(DISTINCT COALESCE(ep.notes,''),' | ') FILTER (WHERE BTRIM(COALESCE(ep.notes,''))<>''),'') event_notes,
			COALESCE(jsonb_agg(jsonb_build_object('evento',e.name,'fecha',e.event_date,'estado_evento',e.status,'estado_participante',ep.status,'notas',COALESCE(ep.notes,'')) ORDER BY e.event_date DESC NULLS LAST),'[]'::jsonb) event_details,
			COALESCE(bool_or(ep.attended_at IS NOT NULL OR ep.status ~* '(assist|attend)'),FALSE) attended,
			COALESCE(bool_or(ep.confirmed_at IS NOT NULL OR ep.status ~* 'confirm'),FALSE) confirmed,
			COALESCE(bool_or(ep.status ~* '(declin|no_show|absent)'),FALSE) missed,count(*) event_count,
			max(GREATEST(COALESCE(e.updated_at,e.created_at),COALESCE(ep.updated_at,ep.created_at))) last_event_activity
		FROM event_map em JOIN event_participants ep ON ep.id=em.participant_id JOIN events e ON e.id=ep.event_id GROUP BY em.lead_id
	), program_agg AS (
		SELECT b.id lead_id,string_agg(concat_ws(' — ',p.name,pp.status),' | ' ORDER BY p.name) programs,
			COALESCE(bool_or(pp.status ~* '(enroll|active|inscrit|probacion|completed)'),FALSE) converted,max(pp.enrolled_at) last_program_activity
		FROM base b JOIN program_participants pp ON pp.contact_id=b.contact_id
		JOIN programs p ON p.id=pp.program_id AND p.account_id=b.account_id GROUP BY b.id
	), campaign_agg AS (
		SELECT b.id lead_id,string_agg(DISTINCT concat_ws(' — ',ca.name,cr.status),' | ') campaigns,count(DISTINCT cr.id) campaign_count,
			max(COALESCE(cr.sent_at,ca.created_at)) last_campaign_activity
		FROM base b JOIN campaign_recipients cr ON cr.contact_id=b.contact_id OR (cr.contact_id IS NULL AND cr.jid=b.jid)
		JOIN campaigns ca ON ca.id=cr.campaign_id AND ca.account_id=b.account_id GROUP BY b.id
	), interaction_agg AS (
		SELECT b.id lead_id,COALESCE(string_agg(concat_ws(': ',i.type,i.notes),' | ' ORDER BY i.created_at DESC)
			FILTER (WHERE BTRIM(COALESCE(i.notes,''))<>''),'') interaction_notes,max(i.created_at) last_interaction_activity
		FROM base b JOIN interactions i ON i.account_id=b.account_id AND (i.lead_id=b.id OR (b.contact_id IS NOT NULL AND i.contact_id=b.contact_id)) GROUP BY b.id
	), duplicate_counts AS (
		SELECT id,
			count(*) FILTER (WHERE norm_phone<>'') OVER (PARTITION BY norm_phone) phone_matches,
			count(*) FILTER (WHERE norm_email<>'') OVER (PARTITION BY norm_email) email_matches,
			COALESCE(first_value(id) OVER (PARTITION BY NULLIF(norm_phone,'') ORDER BY created_at,id)::text,'') phone_primary,
			COALESCE(first_value(id) OVER (PARTITION BY NULLIF(norm_email,'') ORDER BY created_at,id)::text,'') email_primary
		FROM (SELECT id,created_at,regexp_replace(COALESCE(phone,''),'\\D','','g') norm_phone,lower(BTRIM(COALESCE(email,''))) norm_email FROM base) d
	)
	SELECT b.id,b.contact_id,b.name,b.phone,b.email,b.age,b.dni,b.created_at,
		GREATEST(b.created_at,b.updated_at,COALESCE(ma.last_incoming_at,b.created_at),COALESCE(ma.last_outgoing_at,b.created_at),
			COALESCE(ea.last_event_activity,b.created_at),COALESCE(pa.last_program_activity,b.created_at),
			COALESCE(ca.last_campaign_activity,b.created_at),COALESCE(ia.last_interaction_activity,b.created_at)) last_activity_at,
		b.source,b.status,b.lead_notes,b.contact_notes,b.lead_tags,b.contact_tags_array,
		b.is_archived,b.do_not_contact,b.do_not_contact_reason,b.stage_name,b.stage_type,cta.tags,
		COALESCE(ma.incoming_count,0),COALESCE(ma.outgoing_count,0),ma.last_incoming_at,ma.last_outgoing_at,COALESCE(ma.evidence,''),
		COALESCE(ma.philosophical,FALSE),COALESCE(ma.asked_details,FALSE),COALESCE(ma.new_date,FALSE),COALESCE(ma.obstacle,FALSE),
		COALESCE(ma.emotional,FALSE),COALESCE(ma.family,FALSE),COALESCE(ma.rejection,FALSE),COALESCE(ma.confirmation,FALSE),COALESCE(ma.generic_interest,FALSE),
		COALESCE(ea.events,''),COALESCE(ea.event_notes,''),COALESCE(ea.event_details,'[]'::jsonb),COALESCE(ea.attended,FALSE),COALESCE(ea.confirmed,FALSE),COALESCE(ea.missed,FALSE),COALESCE(ea.event_count,0),
		COALESCE(pa.programs,''),COALESCE(pa.converted,FALSE),COALESCE(ca.campaigns,''),COALESCE(ca.campaign_count,0),COALESCE(ia.interaction_notes,''),
		COALESCE(dc.phone_matches,0),COALESCE(dc.email_matches,0),CASE WHEN COALESCE(dc.phone_matches,0)>1 THEN dc.phone_primary WHEN COALESCE(dc.email_matches,0)>1 THEN dc.email_primary ELSE '' END
	FROM base b LEFT JOIN contact_tag_agg cta ON cta.lead_id=b.id LEFT JOIN message_agg ma ON ma.lead_id=b.id
	LEFT JOIN event_agg ea ON ea.lead_id=b.id LEFT JOIN program_agg pa ON pa.lead_id=b.id LEFT JOIN campaign_agg ca ON ca.lead_id=b.id
	LEFT JOIN interaction_agg ia ON ia.lead_id=b.id LEFT JOIN duplicate_counts dc ON dc.id=b.id ORDER BY b.created_at,b.id`

	rows, err := s.repos.DB().Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	facts := make([]leadIntelligenceFact, 0)
	for rows.Next() {
		var fact leadIntelligenceFact
		var eventDetails []byte
		var contactTags []string
		var phonePrimary string
		if err := rows.Scan(
			&fact.LeadID, &fact.ContactID, &fact.Name, &fact.Phone, &fact.Email, &fact.Age, &fact.DNI, &fact.CreatedAt, &fact.LastActivityAt, &fact.Source, &fact.Status,
			&fact.LeadNotes, &fact.ContactNotes, &fact.LeadTags, &fact.ContactTags, &fact.IsArchived, &fact.DoNotContact, &fact.DoNotContactReason,
			&fact.StageName, &fact.StageType, &contactTags, &fact.IncomingCount, &fact.OutgoingCount, &fact.LastIncomingAt, &fact.LastOutgoingAt, &fact.Evidence,
			&fact.Philosophical, &fact.AskedDetails, &fact.NewDate, &fact.Obstacle, &fact.Emotional, &fact.Family, &fact.Rejection, &fact.Confirmation, &fact.GenericInterest,
			&fact.Events, &fact.EventNotes, &eventDetails, &fact.Attended, &fact.Confirmed, &fact.Missed, &fact.EventCount, &fact.Programs, &fact.Converted,
			&fact.Campaigns, &fact.CampaignCount, &fact.InteractionNotes, &fact.PhoneMatches, &fact.EmailMatches, &phonePrimary,
		); err != nil {
			return nil, err
		}
		fact.ContactTags = append(fact.ContactTags, contactTags...)
		fact.EventDetails = json.RawMessage(eventDetails)
		fact.DuplicatePrimary = phonePrimary
		stageName := strings.ToLower(fact.StageName)
		if !params.IncludeConverted && (fact.Converted || fact.Status == domain.LeadStatusWon || fact.StageType == domain.LeadStatusWon || strings.Contains(stageName, "inscrito") || strings.Contains(stageName, "closed - won")) {
			continue
		}
		if params.ActivityFrom != nil && fact.LastActivityAt.Before(*params.ActivityFrom) {
			continue
		}
		if params.ActivityTo != nil && !fact.LastActivityAt.Before(*params.ActivityTo) {
			continue
		}
		facts = append(facts, fact)
	}
	return facts, rows.Err()
}

func uniqueLeadTags(f leadIntelligenceFact) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(f.LeadTags)+len(f.ContactTags))
	for _, tag := range append(append([]string{}, f.LeadTags...), f.ContactTags...) {
		tag = strings.TrimSpace(tag)
		if tag != "" && !seen[strings.ToLower(tag)] {
			seen[strings.ToLower(tag)] = true
			result = append(result, tag)
		}
	}
	sort.Slice(result, func(i, j int) bool { return strings.ToLower(result[i]) < strings.ToLower(result[j]) })
	return result
}

var internalLeadPattern = regexp.MustCompile(`(?i)(nueva acr[oó]polis iquitos|test[_ ]|prueba|test respuesta)`)

func analyzeLeadIntelligenceFact(f leadIntelligenceFact, position int) leadIntelligenceAnalyzed {
	tags := uniqueLeadTags(f)
	tagText := strings.ToLower(strings.Join(tags, " "))
	stage := strings.ToLower(f.StageName)
	source := strings.ToLower(f.Source)
	hasChat := f.IncomingCount+f.OutgoingCount > 0
	converted := f.Converted || f.Status == domain.LeadStatusWon || f.StageType == domain.LeadStatusWon || strings.Contains(stage, "inscrito") || strings.Contains(stage, "closed - won")
	archivedLost := f.IsArchived || f.Status == domain.LeadStatusLost || f.StageType == domain.LeadStatusLost || strings.Contains(stage, "archivad") || strings.Contains(stage, "closed - lost")
	advanced := strings.Contains(stage, "pre-inscrito") || strings.Contains(stage, "preinscrito")
	interested := strings.Contains(stage, "interesado curso")
	assistant := f.Attended || strings.Contains(tagText, "asis_")
	confirmed := f.Confirmed || strings.Contains(stage, "confirmado") || strings.Contains(tagText, "conf_")
	community := strings.Contains(tagText, "comunidad")
	revived := strings.Contains(tagText, "revivió") || strings.Contains(tagText, "revivio")
	noResponse := strings.Contains(tagText, "no responde")
	coldStage := strings.Contains(stage, "por invitar - frios") || strings.Contains(stage, "por invitar - fríos")
	initialAds := strings.Contains(source+" "+tagText, "ads") || strings.Contains(source, "facebook") || strings.Contains(source, "instagram") || strings.Contains(tagText, "rrss")
	tagDNC := strings.Contains(tagText, "no contactar") || strings.Contains(tagText, "no_contactar") || strings.Contains(tagText, "do_not_contact") || strings.Contains(tagText, "dnc")
	duplicate := f.PhoneMatches > 1 || f.EmailMatches > 1
	minor := f.Age > 0 && f.Age < 18
	internal := internalLeadPattern.MatchString(f.Name + " " + f.Source)
	invalid := strings.TrimSpace(f.Phone) == "" || internal
	hardLocked := f.DoNotContact || tagDNC || f.Rejection || converted || minor || invalid
	chatReal := f.IncomingCount >= 2 || (f.IncomingCount >= 1 && (f.AskedDetails || f.Confirmation || f.NewDate || f.Obstacle || f.Family))

	score := 0
	if advanced {
		score += 25
	}
	if interested {
		score += 25
	}
	if assistant {
		score += 20
	}
	if confirmed && f.IncomingCount > 0 {
		score += 18
	}
	if f.Philosophical {
		score += 15
	}
	if f.Confirmation {
		score += 15
	}
	if f.AskedDetails {
		score += 15
	}
	if f.NewDate {
		score += 12
	}
	if f.Obstacle {
		score += 10
	}
	if community && f.IncomingCount > 0 {
		score += 10
	}
	if revived && f.IncomingCount > 0 {
		score += 8
	}
	if f.Family {
		score += 8
	}
	if strings.Contains(tagText, "dinamica:") && f.IncomingCount > 0 {
		score += 5
	}
	if strings.Contains(source, "whatsapp") && chatReal {
		score += 5
	}
	if initialAds && f.IncomingCount <= 1 && !chatReal {
		score -= 5
	}
	if f.OutgoingCount > 0 && f.IncomingCount == 0 {
		score -= 10
	}
	if noResponse {
		score -= 12
	}
	if f.OutgoingCount >= 2 && f.IncomingCount == 0 {
		score -= 12
	}
	if coldStage && !chatReal && !assistant && !f.Obstacle {
		score -= 15
	}
	if f.Missed && !f.Obstacle && !f.NewDate && !f.Confirmation {
		score -= 10
	}
	if archivedLost && !revived && !chatReal {
		score -= 40
	}
	if f.DoNotContact || tagDNC || f.Rejection {
		score -= 25
	}
	if invalid {
		score -= 30
	}
	if converted {
		score = 0
	}
	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}

	interestScore := 2
	if hardLocked {
		interestScore = 0
	} else if advanced || assistant || f.NewDate || (f.Philosophical && f.AskedDetails) || (f.Confirmation && f.AskedDetails) {
		interestScore = 5
	} else if interested || f.Confirmation || f.AskedDetails || f.Obstacle || (chatReal && f.Philosophical) {
		interestScore = 4
	} else if f.IncomingCount > 0 || confirmed || f.GenericInterest {
		interestScore = 3
	} else if f.OutgoingCount > 0 || initialAds || coldStage {
		interestScore = 1
	}

	replyCategory, replyScore := "No contacto útil", 0
	switch {
	case f.Rejection || f.DoNotContact || tagDNC:
		replyCategory = "Rechazo cordial"
	case f.Obstacle:
		replyCategory, replyScore = "Obstáculo real", 4
	case f.IncomingCount == 0 && f.OutgoingCount > 0:
		replyCategory, replyScore = "Silencioso", 1
	case f.IncomingCount >= 3 && (f.AskedDetails || f.Confirmation || f.NewDate):
		replyCategory, replyScore = "Proactivo sostenido", 5
	case f.IncomingCount >= 1 && (f.AskedDetails || f.Confirmation || f.GenericInterest):
		replyCategory, replyScore = "Reactivo positivo", 4
	case f.IncomingCount >= 2:
		replyCategory, replyScore = "Intermitente", 3
	case f.IncomingCount == 1:
		replyCategory, replyScore = "Proactivo débil", 2
	}

	ideal, emotional := 0, 0
	if f.Philosophical {
		ideal = 4
	}
	if f.Emotional {
		emotional = 4
	}
	evidenceLower := strings.ToLower(f.Evidence)
	if strings.Contains(evidenceLower, "autoconocimiento") || strings.Contains(evidenceLower, "filosof") || strings.Contains(evidenceLower, "conócete") {
		ideal = 5
	}
	if strings.Contains(evidenceLower, "ansiedad") || strings.Contains(evidenceLower, "estrés") || strings.Contains(evidenceLower, "dolor") {
		emotional = 5
	}

	primary, secondary := "No prioritario / sin señales", ""
	switch {
	case converted:
		primary = "Ya convertido / seguimiento académico"
	case internal:
		primary = "Interno/prueba/no lead"
	case minor:
		primary = "Menor / requiere responsable"
	case f.Obstacle && (strings.Contains(evidenceLower, "examen") || strings.Contains(evidenceLower, "universidad") || strings.Contains(evidenceLower, "clases")):
		primary, secondary = "Estudiante / joven con limitación de horario", "Obstáculo real recuperable"
	case f.Obstacle:
		primary, secondary = "Confirmado que no asistió", "Obstáculo real recuperable"
	case assistant:
		primary = "Asistente previo recuperable"
	case f.Family:
		primary = "Familiar / referidor"
	case ideal >= 4:
		primary = "Buscador filosófico / idealista"
	case emotional >= 4:
		primary = "Necesidad emocional / contención"
	case community:
		primary = "Cultural / comunitario"
	case f.AskedDetails:
		primary = "Mejora personal práctica"
	case f.EventCount > 0:
		primary = "Curioso de eventos gratuitos"
	case initialAds && f.IncomingCount <= 1:
		primary = "Lead frío de redes/ads"
	}
	if secondary == "" && ideal >= 3 && primary != "Buscador filosófico / idealista" {
		secondary = "Buscador filosófico / idealista"
	}

	priority, temperature, action, messageType, risk, reason := "D", "Frío real", "Solo broadcast", "Difusión general ocasional", "Medio-alto", "No hay evidencia suficiente de interés real."
	switch {
	case converted:
		priority, temperature, action, messageType, risk, reason = "E", "No insistir", "No contactar", "Seguimiento académico", "Alto: ya convertido", "Ya convertido o inscrito; excluir de captación externa."
	case f.DoNotContact || tagDNC || f.Rejection:
		priority, temperature, action, messageType, risk, reason = "E", "No insistir", "No contactar", "No aplica", "Alto", "Hay una señal explícita de rechazo o restricción de contacto."
	case minor:
		priority, temperature, action, messageType, risk, reason = "E", "No insistir", "No contactar directamente", "Requiere adulto responsable", "Alto", "Menor de edad; requiere revisión y contacto con responsable."
	case invalid || (archivedLost && score < 25):
		priority, temperature, action, messageType, risk, reason = "E", "No insistir", "No contactar", "No aplica", "Alto", "Registro interno, inválido o archivado/perdido sin reactivación."
	case score >= 80 || (score >= 65 && (f.Obstacle || f.AskedDetails || f.Confirmation)):
		priority, temperature, action, messageType, risk, reason = "A+", "Caliente", "Llamada", "Llamada humana inmediata", "Bajo", "Señales concretas de avance y conversación real."
	case score >= 65:
		priority, temperature, action, messageType, risk, reason = "A", "Tibio alto", "WhatsApp personalizado", "Mensaje humano profundo", "Bajo-medio", "Interés respaldado por etapa, tags y respuesta registrada."
	case score >= 45:
		priority, temperature, action, messageType, risk, reason = "B", "Tibio", "WhatsApp personalizado", "Mensaje breve personalizado", "Medio", "Hay interacción o interés, pero aún no suficiente para llamada."
	case score >= 25 || f.EventCount > 0 || f.IncomingCount > 0:
		priority, temperature, action, messageType, risk, reason = "C", "Frío recuperable", "Invitación a evento gratuito", "WhatsApp suave", "Medio", "Señales limitadas; usar contacto segmentado sin presión."
	}
	if duplicate {
		reason += " Posible duplicado: requiere revisión humana."
	}
	if f.Obstacle && priority != "E" {
		messageType = "Mensaje de disculpa/recuperación"
	}

	lastState := "Sin conversación registrada"
	if f.Rejection || f.DoNotContact || tagDNC {
		lastState = "Rechazo"
	} else if f.Obstacle {
		lastState = "Obstáculo real"
	} else if f.LastIncomingAt == nil && f.LastOutgoingAt != nil {
		lastState = "Silencio después de invitación"
	} else if f.LastIncomingAt != nil && (f.LastOutgoingAt == nil || f.LastIncomingAt.After(*f.LastOutgoingAt)) {
		lastState = "Último mensaje fue del lead"
	} else if f.LastOutgoingAt != nil {
		lastState = "Último mensaje fue nuestro"
	}

	notes := strings.Join(nonEmptyStrings(f.DoNotContactReason, f.LeadNotes, f.ContactNotes, f.EventNotes, f.InteractionNotes), " | ")
	evidence := strings.TrimSpace(f.Evidence)
	if evidence == "" {
		if len(tags) > 0 || f.StageName != "" {
			evidence = "Evidencia de tags/etapa: " + strings.Join(tags, ", ") + "; etapa: " + f.StageName
		} else {
			evidence = "Sin evidencia de chat disponible."
		}
	}
	contactID := ""
	if f.ContactID != nil {
		contactID = f.ContactID.String()
	}
	lastWho := lastState
	chatSummary := "Sin chat asociado."
	if hasChat {
		chatSummary = fmt.Sprintf("%d entrantes, %d salientes; %s.", f.IncomingCount, f.OutgoingCount, strings.ToLower(lastState))
	}
	row := map[string]any{
		"lead_id": f.LeadID.String(), "contact_id": contactID, "nombre": f.Name, "telefono": f.Phone, "email": f.Email, "edad": zeroBlank(f.Age), "dni": f.DNI,
		"fecha_creacion": f.CreatedAt.UTC().Format(time.RFC3339), "fuente": f.Source, "etapa_crm": f.StageName, "status": f.Status, "tags": strings.Join(tags, " | "),
		"eventos_asociados": f.Events, "programa_asociado": f.Programs, "campañas_recibidas": f.Campaigns, "notas_lead": f.LeadNotes, "notas_contacto": f.ContactNotes,
		"observaciones_llamada_o_contacto": defaultLeadIntelligenceString(notes, "Sin observaciones formales encontradas."), "tiene_chat": hasChat,
		"total_mensajes_entrantes": f.IncomingCount, "total_mensajes_salientes": f.OutgoingCount, "ultimo_mensaje_entrante_fecha": formatOptionalTime(f.LastIncomingAt),
		"ultimo_mensaje_saliente_fecha": formatOptionalTime(f.LastOutgoingAt), "ultimo_mensaje_de_quien": lastWho, "resumen_chat": chatSummary, "evidencia_chat_clave": evidence,
		"respuesta_whatsapp_categoria": replyCategory, "ultimo_estado_conversacion": lastState, "score_interes_real_0_5": interestScore, "score_respuesta_whatsapp_0_5": replyScore,
		"score_perfil_idealista_0_5": ideal, "score_necesidad_emocional_0_5": emotional, "score_probabilidad_conversion_0_100": score, "score_prioridad_contacto_0_100": score,
		"nivel_prioridad": priority, "temperatura_real": temperature, "perfil_humano_principal": primary, "perfil_humano_secundario": secondary, "razon_prioridad": reason,
		"accion_recomendada": action, "mensaje_sugerido_tipo": messageType, "riesgo_de_insistir": risk, "posible_duplicado": duplicate,
		"lead_principal_sugerido": f.DuplicatePrimary, "requiere_revision_humana": duplicate || minor || f.DoNotContact || tagDNC || internal,
		"comentarios_analista": "Clasificación inferida a partir de metadatos, mensajes agregados y participación.", "eventos_detalle": json.RawMessage(f.EventDetails),
	}
	candidate := !hardLocked && (score >= 25 || duplicate || f.IncomingCount >= 2 || f.AskedDetails || f.Obstacle || f.Philosophical || f.Emotional)
	return leadIntelligenceAnalyzed{Fact: f, Row: row, Score: score, Candidate: candidate, HardLocked: hardLocked, Position: position}
}

func nonEmptyStrings(values ...string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, strings.TrimSpace(value))
		}
	}
	return result
}
func defaultLeadIntelligenceString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
func zeroBlank(value int) any {
	if value == 0 {
		return ""
	}
	return value
}
func formatOptionalTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}

func selectLeadIntelligenceCandidates(rows []leadIntelligenceAnalyzed) []int {
	indices := make([]int, 0)
	for i := range rows {
		if rows[i].Candidate {
			indices = append(indices, i)
		}
	}
	sort.SliceStable(indices, func(i, j int) bool { return rows[indices[i]].Score > rows[indices[j]].Score })
	if len(indices) > leadIntelligenceAIMaxCandidates {
		indices = indices[:leadIntelligenceAIMaxCandidates]
	}
	return indices
}
