export interface BotGraphNode {
  id: string
  type: string
  data: Record<string, unknown>
}

export interface BotGraphEdge {
  id?: string
  source: string
  target: string
  sourceHandle?: string
}

export interface BotGraph {
  nodes: BotGraphNode[]
  edges: BotGraphEdge[]
}

export interface BotFlow {
  id: string
  account_id: string
  name: string
  description: string
  channel: string
  trigger_type: string
  trigger_config: Record<string, unknown>
  graph: BotGraph
  is_active: boolean
  is_published: boolean
  draft_version: number
  published_version: number
  execution_count: number
  last_triggered_at?: string
  published_at?: string
  created_at: string
  updated_at: string
}

export interface BotSimulationStep {
  node_id: string
  node_type: string
  label: string
  status: string
  output: Record<string, unknown>
}

export interface BotSimulationResult {
  flow_id: string
  steps: BotSimulationStep[]
  ended: boolean
  error?: string
}
