/**
 * Automation Node Components for ReactFlow — light theme.
 */
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  Zap,
  MessageSquare,
  GitBranch,
  Tag,
  Clock,
  ArrowDownUp,
  X,
} from 'lucide-react'
import type { AutomationNodeData, AutoNodeType } from '@/types/automation'

// ── Shared node shell ────────────────────────────────────────────────────────

interface NodeShellProps {
  icon: React.ElementType
  label: string
  sublabel?: string
  color: string      // e.g. "bg-emerald-50 text-emerald-600"
  border: string     // e.g. "border-emerald-200"
  selected?: boolean
  children?: React.ReactNode
}

function NodeShell({ icon: Icon, label, sublabel, color, border, selected, children }: NodeShellProps) {
  return (
    <div
      className={`relative min-w-[180px] max-w-[220px] bg-white border rounded-xl shadow-sm transition-all ${border} ${
        selected ? 'ring-2 ring-emerald-500/40 shadow-md' : ''
      }`}
    >
      <div className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
            <Icon className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-slate-800 text-xs font-semibold truncate leading-tight">{label}</div>
            {sublabel && <div className="text-slate-500 text-[10px] truncate mt-0.5">{sublabel}</div>}
          </div>
        </div>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  )
}

// ── Trigger node ─────────────────────────────────────────────────────────────

const TRIGGER_LABELS: Record<string, string> = {
  lead_created: 'Lead creado',
  lead_stage_changed: 'Etapa cambiada',
  tag_assigned: 'Etiqueta asignada',
  tag_removed: 'Etiqueta removida',
  message_received: 'Mensaje recibido',
  manual: 'Manual',
}

export function TriggerNode({ data, selected }: NodeProps) {
  const d = data as unknown as AutomationNodeData
  return (
    <>
      <NodeShell
        icon={Zap}
        label="Disparador"
        sublabel={TRIGGER_LABELS[d.trigger ?? ''] ?? d.trigger}
        color="bg-emerald-50 text-emerald-600"
        border="border-emerald-200"
        selected={selected}
      />
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-emerald-500 !border-2 !border-white" />
    </>
  )
}

// ── Send WhatsApp node ────────────────────────────────────────────────────────

export function SendWhatsAppNode({ data, selected }: NodeProps) {
  const d = data as unknown as AutomationNodeData
  const preview = d.message_template
    ? d.message_template.slice(0, 40) + (d.message_template.length > 40 ? '…' : '')
    : 'Sin mensaje'
  return (
    <>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-sky-500 !border-2 !border-white" />
      <NodeShell
        icon={MessageSquare}
        label="Enviar WhatsApp"
        sublabel={preview}
        color="bg-sky-50 text-sky-600"
        border="border-sky-200"
        selected={selected}
      />
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-sky-500 !border-2 !border-white" />
    </>
  )
}

// ── Change Stage node ─────────────────────────────────────────────────────────

export function ChangeStageNode({ data, selected }: NodeProps) {
  const d = data as unknown as AutomationNodeData
  return (
    <>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-violet-500 !border-2 !border-white" />
      <NodeShell
        icon={ArrowDownUp}
        label="Cambiar etapa"
        sublabel={d.stage_id ? `Stage: ${d.stage_id.slice(0, 8)}…` : 'Sin configurar'}
        color="bg-violet-50 text-violet-600"
        border="border-violet-200"
        selected={selected}
      />
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-violet-500 !border-2 !border-white" />
    </>
  )
}

// ── Assign/Remove Tag node ────────────────────────────────────────────────────

export function AssignTagNode({ data, selected }: NodeProps) {
  const d = data as unknown as AutomationNodeData
  return (
    <>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-amber-500 !border-2 !border-white" />
      <NodeShell
        icon={Tag}
        label="Asignar etiqueta"
        sublabel={d.tag_id ? `Tag: ${d.tag_id.slice(0, 8)}…` : 'Sin configurar'}
        color="bg-amber-50 text-amber-600"
        border="border-amber-200"
        selected={selected}
      />
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-amber-500 !border-2 !border-white" />
    </>
  )
}

export function RemoveTagNode({ data, selected }: NodeProps) {
  const d = data as unknown as AutomationNodeData
  return (
    <>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-orange-500 !border-2 !border-white" />
      <NodeShell
        icon={X}
        label="Remover etiqueta"
        sublabel={d.tag_id ? `Tag: ${d.tag_id.slice(0, 8)}…` : 'Sin configurar'}
        color="bg-orange-50 text-orange-600"
        border="border-orange-200"
        selected={selected}
      />
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-orange-500 !border-2 !border-white" />
    </>
  )
}

// ── Delay node ────────────────────────────────────────────────────────────────

function fmtDelay(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

export function DelayNode({ data, selected }: NodeProps) {
  const d = data as unknown as AutomationNodeData
  return (
    <>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-slate-400 !border-2 !border-white" />
      <NodeShell
        icon={Clock}
        label="Esperar"
        sublabel={d.delay_seconds ? fmtDelay(d.delay_seconds) : 'Sin configurar'}
        color="bg-slate-100 text-slate-600"
        border="border-slate-200"
        selected={selected}
      />
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-slate-400 !border-2 !border-white" />
    </>
  )
}

// ── Condition node ────────────────────────────────────────────────────────────

export function ConditionNode({ data, selected }: NodeProps) {
  const d = data as unknown as AutomationNodeData
  const sublabel = d.field && d.operator
    ? `${d.field} ${d.operator} ${d.value ?? ''}`
    : 'Sin configurar'
  return (
    <>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-pink-500 !border-2 !border-white" />
      <NodeShell
        icon={GitBranch}
        label="Condición"
        sublabel={sublabel}
        color="bg-pink-50 text-pink-600"
        border="border-pink-200"
        selected={selected}
      >
        <div className="flex justify-between text-[9px] mt-1 px-0.5">
          <span className="text-emerald-600 font-medium">✓ Sí</span>
          <span className="text-red-500 font-medium">✗ No</span>
        </div>
      </NodeShell>
      <Handle
        type="source"
        position={Position.Bottom}
        id="true"
        style={{ left: '30%', background: '#10b981', border: '2px solid #ffffff' }}
        className="!w-3 !h-3"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        style={{ left: '70%', background: '#ef4444', border: '2px solid #ffffff' }}
        className="!w-3 !h-3"
      />
    </>
  )
}

// ── nodeTypes map for ReactFlow ───────────────────────────────────────────────

export const nodeTypes = {
  trigger: TriggerNode,
  send_whatsapp: SendWhatsAppNode,
  change_stage: ChangeStageNode,
  assign_tag: AssignTagNode,
  remove_tag: RemoveTagNode,
  delay: DelayNode,
  condition: ConditionNode,
}

// ── Palette items for the sidebar ─────────────────────────────────────────────

export interface PaletteItem {
  type: AutoNodeType
  label: string
  icon: React.ElementType
  color: string
  defaultData: AutomationNodeData
}

export const PALETTE: PaletteItem[] = [
  {
    type: 'send_whatsapp',
    label: 'Enviar WhatsApp',
    icon: MessageSquare,
    color: 'bg-sky-50 text-sky-700 border-sky-200',
    defaultData: { label: 'Enviar WhatsApp', message_template: '' },
  },
  {
    type: 'change_stage',
    label: 'Cambiar etapa',
    icon: ArrowDownUp,
    color: 'bg-violet-50 text-violet-700 border-violet-200',
    defaultData: { label: 'Cambiar etapa', stage_id: '' },
  },
  {
    type: 'assign_tag',
    label: 'Asignar etiqueta',
    icon: Tag,
    color: 'bg-amber-50 text-amber-700 border-amber-200',
    defaultData: { label: 'Asignar etiqueta', tag_id: '' },
  },
  {
    type: 'remove_tag',
    label: 'Remover etiqueta',
    icon: X,
    color: 'bg-orange-50 text-orange-700 border-orange-200',
    defaultData: { label: 'Remover etiqueta', tag_id: '' },
  },
  {
    type: 'delay',
    label: 'Esperar',
    icon: Clock,
    color: 'bg-slate-100 text-slate-600 border-slate-200',
    defaultData: { label: 'Esperar', delay_seconds: 3600 },
  },
  {
    type: 'condition',
    label: 'Condición',
    icon: GitBranch,
    color: 'bg-pink-50 text-pink-700 border-pink-200',
    defaultData: { label: 'Condición', field: 'stage_id', operator: 'eq', value: '' },
  },
]
