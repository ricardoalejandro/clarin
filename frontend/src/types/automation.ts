// Trigger types
export type AutoTrigger =
  | 'lead_created'
  | 'lead_stage_changed'
  | 'tag_assigned'
  | 'tag_removed'
  | 'message_received'
  | 'manual'

// Node types
export type AutoNodeType =
  | 'trigger'
  | 'send_whatsapp'
  | 'change_stage'
  | 'assign_tag'
  | 'remove_tag'
  | 'delay'
  | 'condition'

// Execution status
export type AutoExecStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed'

// --- Graph types (ReactFlow-compatible) ---

export interface AutomationNodeData {
  label?: string
  // trigger node
  trigger?: AutoTrigger
  trigger_config?: Record<string, string>
  // send_whatsapp node
  device_id?: string
  message_template?: string
  // change_stage node
  stage_id?: string
  // assign_tag / remove_tag node
  tag_id?: string
  // delay node
  delay_seconds?: number
  // condition node
  field?: string
  operator?: 'eq' | 'neq' | 'contains' | 'starts_with' | 'empty' | 'not_empty'
  value?: string
}

export interface AutomationNode {
  id: string
  type: AutoNodeType
  position: { x: number; y: number }
  data: AutomationNodeData
}

export interface AutomationEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string // 'true' | 'false' for condition nodes
  label?: string
}

export interface AutomationGraph {
  nodes: AutomationNode[]
  edges: AutomationEdge[]
}

// --- Domain types ---

export interface Automation {
  id: string
  account_id: string
  name: string
  description: string
  trigger: AutoTrigger
  trigger_config: Record<string, string>
  graph: AutomationGraph
  is_active: boolean
  execution_count: number
  created_at: string
  updated_at: string
  stats?: AutomationStats
}

export interface AutomationExecution {
  id: string
  automation_id: string
  account_id: string
  lead_id?: string
  status: AutoExecStatus
  trigger: AutoTrigger
  trigger_data: Record<string, unknown>
  current_node_id: string
  started_at: string
  completed_at?: string
  error_message?: string
  dedup_key?: string
}

export interface AutomationExecutionLog {
  id: string
  execution_id: string
  node_id: string
  node_type: AutoNodeType
  status: 'success' | 'failed' | 'skipped'
  output: Record<string, unknown>
  error?: string
  duration_ms: number
  created_at: string
}

export interface AutomationStats {
  automation_id: string
  total_executions: number
  completed: number
  failed: number
  pending: number
  running: number
  paused: number
  last_execution?: string
}

// --- API response types ---

export interface AutomationListResponse {
  automations: Automation[]
  total: number
}

export interface AutomationCreateRequest {
  name: string
  description: string
  trigger: AutoTrigger
  trigger_config: Record<string, string>
  graph: AutomationGraph
}
