package repository

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

// BotRepository handles persistence for dedicated chat bot flows.
type BotRepository struct {
	db *pgxpool.Pool
}

func defaultBotGraph() json.RawMessage {
	return json.RawMessage(`{"nodes":[{"id":"trigger","type":"trigger","data":{"label":"Mensaje recibido"}}],"edges":[]}`)
}

func normalizeBotMaps(flow *domain.BotFlow) {
	if flow.TriggerConfig == nil {
		flow.TriggerConfig = map[string]interface{}{}
	}
	if len(flow.Graph) == 0 || string(flow.Graph) == "null" {
		flow.Graph = defaultBotGraph()
	}
	if flow.Channel == "" {
		flow.Channel = domain.BotChannelWhatsApp
	}
	if flow.TriggerType == "" {
		flow.TriggerType = domain.BotTriggerMessageReceived
	}
}

func (r *BotRepository) List(ctx context.Context, accountID uuid.UUID) ([]*domain.BotFlow, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, name, description, channel, trigger_type, trigger_config, graph,
		       is_active, is_published, draft_version, published_version, execution_count,
		       last_triggered_at, published_at, created_at, updated_at
		FROM bot_flows
		WHERE account_id = $1
		ORDER BY updated_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var flows []*domain.BotFlow
	for rows.Next() {
		flow, err := scanBotFlow(rows)
		if err != nil {
			return nil, err
		}
		flows = append(flows, flow)
	}
	return flows, rows.Err()
}

func (r *BotRepository) GetByID(ctx context.Context, id, accountID uuid.UUID) (*domain.BotFlow, error) {
	flow, err := scanBotFlow(r.db.QueryRow(ctx, `
		SELECT id, account_id, name, description, channel, trigger_type, trigger_config, graph,
		       is_active, is_published, draft_version, published_version, execution_count,
		       last_triggered_at, published_at, created_at, updated_at
		FROM bot_flows
		WHERE id = $1 AND account_id = $2
	`, id, accountID))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return flow, err
}

func (r *BotRepository) Create(ctx context.Context, flow *domain.BotFlow) error {
	normalizeBotMaps(flow)
	triggerConfig, _ := json.Marshal(flow.TriggerConfig)
	return r.db.QueryRow(ctx, `
		INSERT INTO bot_flows (account_id, name, description, channel, trigger_type, trigger_config, graph, is_active)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, draft_version, published_version, execution_count, created_at, updated_at
	`, flow.AccountID, flow.Name, flow.Description, flow.Channel, flow.TriggerType, triggerConfig, flow.Graph, flow.IsActive).
		Scan(&flow.ID, &flow.DraftVersion, &flow.PublishedVersion, &flow.ExecutionCount, &flow.CreatedAt, &flow.UpdatedAt)
}

func (r *BotRepository) Update(ctx context.Context, flow *domain.BotFlow) error {
	normalizeBotMaps(flow)
	triggerConfig, _ := json.Marshal(flow.TriggerConfig)
	_, err := r.db.Exec(ctx, `
		UPDATE bot_flows
		SET name = $1, description = $2, channel = $3, trigger_type = $4, trigger_config = $5,
		    graph = $6, is_active = $7, draft_version = draft_version + 1, updated_at = NOW()
		WHERE id = $8 AND account_id = $9
	`, flow.Name, flow.Description, flow.Channel, flow.TriggerType, triggerConfig, flow.Graph, flow.IsActive, flow.ID, flow.AccountID)
	return err
}

func (r *BotRepository) Delete(ctx context.Context, id, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM bot_flows WHERE id = $1 AND account_id = $2`, id, accountID)
	return err
}

func (r *BotRepository) Publish(ctx context.Context, id, accountID uuid.UUID, userID *uuid.UUID) (*domain.BotFlow, error) {
	flow, err := r.GetByID(ctx, id, accountID)
	if err != nil || flow == nil {
		return flow, err
	}
	version := flow.DraftVersion
	_, err = r.db.Exec(ctx, `
		INSERT INTO bot_flow_versions (flow_id, version, graph, created_by)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (flow_id, version) DO UPDATE SET graph = EXCLUDED.graph
	`, id, version, flow.Graph, userID)
	if err != nil {
		return nil, err
	}
	_, err = r.db.Exec(ctx, `
		UPDATE bot_flows
		SET is_published = TRUE, published_version = draft_version, published_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND account_id = $2
	`, id, accountID)
	if err != nil {
		return nil, err
	}
	return r.GetByID(ctx, id, accountID)
}

func (r *BotRepository) LogExecution(ctx context.Context, logEntry *domain.BotExecutionLog) error {
	input, _ := json.Marshal(logEntry.Input)
	output, _ := json.Marshal(logEntry.Output)
	return r.db.QueryRow(ctx, `
		INSERT INTO bot_execution_logs (account_id, flow_id, session_id, node_id, node_type, status, input, output, error)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, created_at
	`, logEntry.AccountID, logEntry.FlowID, logEntry.SessionID, logEntry.NodeID, logEntry.NodeType,
		logEntry.Status, input, output, logEntry.Error).Scan(&logEntry.ID, &logEntry.CreatedAt)
}

func (r *BotRepository) ListLogs(ctx context.Context, flowID, accountID uuid.UUID, limit int) ([]*domain.BotExecutionLog, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, flow_id, session_id, node_id, node_type, status, input, output, error, created_at
		FROM bot_execution_logs
		WHERE flow_id = $1 AND account_id = $2
		ORDER BY created_at DESC
		LIMIT $3
	`, flowID, accountID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []*domain.BotExecutionLog
	for rows.Next() {
		logEntry := &domain.BotExecutionLog{}
		var inputRaw, outputRaw []byte
		if err := rows.Scan(&logEntry.ID, &logEntry.AccountID, &logEntry.FlowID, &logEntry.SessionID, &logEntry.NodeID,
			&logEntry.NodeType, &logEntry.Status, &inputRaw, &outputRaw, &logEntry.Error, &logEntry.CreatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(inputRaw, &logEntry.Input)
		_ = json.Unmarshal(outputRaw, &logEntry.Output)
		logs = append(logs, logEntry)
	}
	return logs, rows.Err()
}

func scanBotFlow(row pgx.Row) (*domain.BotFlow, error) {
	flow := &domain.BotFlow{}
	var triggerConfigRaw []byte
	err := row.Scan(&flow.ID, &flow.AccountID, &flow.Name, &flow.Description, &flow.Channel, &flow.TriggerType,
		&triggerConfigRaw, &flow.Graph, &flow.IsActive, &flow.IsPublished, &flow.DraftVersion,
		&flow.PublishedVersion, &flow.ExecutionCount, &flow.LastTriggeredAt, &flow.PublishedAt,
		&flow.CreatedAt, &flow.UpdatedAt)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(triggerConfigRaw, &flow.TriggerConfig)
	normalizeBotMaps(flow)
	return flow, nil
}
