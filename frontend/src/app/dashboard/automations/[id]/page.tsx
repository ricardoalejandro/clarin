'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  BackgroundVariant,
  Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

function apiFetch(url: string, options?: RequestInit) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : ''
  return fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options?.headers ?? {}) },
  })
}

import { nodeTypes, PALETTE } from '@/components/automation/AutoNodes'
import type {
  Automation,
  AutomationNode,
  AutomationEdge,
  AutomationExecution,
  AutomationExecutionLog,
  AutoNodeType,
  AutoTrigger,
} from '@/types/automation'
import {
  ArrowLeft,
  Save,
  Play,
  Zap,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Pause,
  ChevronDown,
  ChevronRight,
  Trash2,
  Settings2,
  List,
  AlertCircle,
} from 'lucide-react'

function uid() { return crypto.randomUUID() }

const TRIGGER_LABELS: Record<AutoTrigger, string> = {
  lead_created: 'Lead creado',
  lead_stage_changed: 'Etapa cambiada',
  tag_assigned: 'Etiqueta asignada',
  tag_removed: 'Etiqueta removida',
  message_received: 'Mensaje recibido',
  manual: 'Manual',
}

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-600',
  running: 'bg-sky-50 text-sky-600',
  paused: 'bg-amber-50 text-amber-600',
  pending: 'bg-slate-100 text-slate-500',
}

const STATUS_ICONS: Record<string, React.ElementType> = {
  completed: CheckCircle2,
  failed: XCircle,
  running: RefreshCw,
  paused: Pause,
  pending: Clock,
}

function fmtDate(iso?: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// ── Node Config Panel ─────────────────────────────────────────────────────────

interface NodeConfigProps {
  node: Node
  onUpdate: (id: string, data: Record<string, unknown>) => void
  onDelete: (id: string) => void
}

function NodeConfig({ node, onUpdate, onDelete }: NodeConfigProps) {
  const d = node.data as unknown as Record<string, unknown>
  const type = node.type as AutoNodeType

  const inputCls = 'w-full border border-slate-200 bg-white text-slate-800 placeholder-slate-400 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition'
  const labelCls = 'block text-xs font-medium text-slate-600 mb-1'

  function field(key: string, label: string, placeholder?: string) {
    return (
      <div key={key}>
        <label className={labelCls}>{label}</label>
        <input value={(d[key] as string) ?? ''} onChange={e => onUpdate(node.id, { ...d, [key]: e.target.value })}
          placeholder={placeholder} className={inputCls} />
      </div>
    )
  }

  function numField(key: string, label: string, min = 1) {
    return (
      <div key={key}>
        <label className={labelCls}>{label}</label>
        <input type="number" min={min} value={(d[key] as number) ?? ''} className={inputCls}
          onChange={e => onUpdate(node.id, { ...d, [key]: parseInt(e.target.value) || 0 })} />
      </div>
    )
  }

  function select(key: string, label: string, options: { value: string; label: string }[]) {
    return (
      <div key={key}>
        <label className={labelCls}>{label}</label>
        <select value={(d[key] as string) ?? ''} onChange={e => onUpdate(node.id, { ...d, [key]: e.target.value })}
          className={inputCls}>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-700 uppercase tracking-wider">Configurar nodo</span>
        <button onClick={() => onDelete(node.id)}
          className="w-6 h-6 rounded flex items-center justify-center text-red-500 hover:bg-red-50 transition-colors">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {type === 'trigger' && (
        select('trigger', 'Disparador', Object.entries(TRIGGER_LABELS).map(([v, l]) => ({ value: v, label: l })))
      )}

      {type === 'send_whatsapp' && (
        <>
          {field('device_id', 'ID del dispositivo', 'uuid del dispositivo')}
          <div>
            <label className={labelCls}>Mensaje <span className="text-slate-400">(usa {`{{nombre}}, {{telefono}}`})</span></label>
            <textarea rows={4} value={(d['message_template'] as string) ?? ''}
              onChange={e => onUpdate(node.id, { ...d, message_template: e.target.value })}
              placeholder="Hola {{nombre}}, bienvenido..."
              className="w-full border border-slate-200 bg-white text-slate-800 placeholder-slate-400 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition resize-none" />
          </div>
        </>
      )}

      {type === 'change_stage' && field('stage_id', 'ID de la etapa', 'uuid de la etapa')}

      {(type === 'assign_tag' || type === 'remove_tag') && (
        field('tag_id', 'ID de la etiqueta', 'uuid de la etiqueta')
      )}

      {type === 'delay' && (
        <>
          {numField('delay_seconds', 'Segundos de espera', 1)}
          <p className="text-slate-400 text-[10px]">
            {(() => {
              const s = (d['delay_seconds'] as number) ?? 0
              if (s < 60) return `${s} segundo(s)`
              if (s < 3600) return `${Math.round(s / 60)} minuto(s)`
              return `${(s / 3600).toFixed(1)} hora(s)`
            })()}
          </p>
        </>
      )}

      {type === 'condition' && (
        <>
          {select('field', 'Campo a evaluar', [
            { value: 'stage_id', label: 'Etapa' },
            { value: 'pipeline_id', label: 'Pipeline' },
            { value: 'phone', label: 'Teléfono' },
            { value: 'email', label: 'Email' },
            { value: 'name', label: 'Nombre' },
            { value: 'source', label: 'Fuente' },
          ])}
          {select('operator', 'Operador', [
            { value: 'eq', label: 'Igual a' },
            { value: 'neq', label: 'Distinto de' },
            { value: 'contains', label: 'Contiene' },
            { value: 'starts_with', label: 'Empieza con' },
            { value: 'empty', label: 'Está vacío' },
            { value: 'not_empty', label: 'No está vacío' },
          ])}
          {!['empty', 'not_empty'].includes((d['operator'] as string) ?? '') && (
            field('value', 'Valor', 'valor a comparar')
          )}
          <div className="bg-slate-50 border border-slate-100 rounded-lg p-2 text-[10px] text-slate-500 space-y-0.5">
            <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Handle verde = condición verdadera</div>
            <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500" /> Handle rojo = condición falsa</div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Executions Panel ──────────────────────────────────────────────────────────

function ExecutionsPanel({ automationId }: { automationId: string }) {
  const [executions, setExecutions] = useState<AutomationExecution[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, AutomationExecutionLog[]>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch(`/api/automations/${automationId}/executions`)
      .then(r => r.json())
      .then(d => { if (d.success) setExecutions(d.executions ?? []) })
      .finally(() => setLoading(false))
  }, [automationId])

  async function loadLogs(execId: string) {
    if (logs[execId]) { setExpanded(e => e === execId ? null : execId); return }
    const r = await apiFetch(`/api/automations/${automationId}/executions/${execId}/logs`)
    const d = await r.json()
    if (d.success) setLogs(prev => ({ ...prev, [execId]: d.logs ?? [] }))
    setExpanded(execId)
  }

  if (loading) return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-12 bg-slate-100 border border-slate-200 rounded-lg animate-pulse" />
      ))}
    </div>
  )

  if (executions.length === 0) return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <List className="w-8 h-8 text-slate-300 mb-2" />
      <p className="text-slate-500 text-sm">Sin ejecuciones aún</p>
    </div>
  )

  return (
    <div className="space-y-1.5">
      {executions.map(ex => {
        const StatusIcon = STATUS_ICONS[ex.status] ?? Clock
        const isOpen = expanded === ex.id
        return (
          <div key={ex.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <button onClick={() => loadLogs(ex.id)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-slate-50 transition-colors text-left">
              <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${STATUS_STYLES[ex.status]}`}>
                <StatusIcon className={`w-3 h-3 ${ex.status === 'running' ? 'animate-spin' : ''}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-slate-800 text-xs font-medium truncate">
                  {ex.lead_id ? `Lead: ${ex.lead_id.slice(0, 8)}…` : 'Sin lead'}
                </div>
                <div className="text-slate-400 text-[10px]">{fmtDate(ex.started_at)}</div>
              </div>
              {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
            </button>
            {isOpen && logs[ex.id] && (
              <div className="border-t border-slate-200 px-3 py-2 space-y-1 bg-slate-50">
                {logs[ex.id].length === 0 ? (
                  <p className="text-slate-400 text-[10px] text-center py-1">Sin logs</p>
                ) : logs[ex.id].map(log => (
                  <div key={log.id} className="flex items-start gap-2 text-[10px]">
                    <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${log.status === 'success' ? 'bg-emerald-500' : log.status === 'failed' ? 'bg-red-500' : 'bg-slate-400'}`} />
                    <div>
                      <span className="text-slate-700 font-medium">{log.node_type}</span>
                      {log.error && <span className="text-red-500 ml-1">— {log.error}</span>}
                      <span className="text-slate-400 ml-1">({log.duration_ms}ms)</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Main Editor ───────────────────────────────────────────────────────────────

function AutomationEditorInner() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string

  const [automation, setAutomation] = useState<Automation | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveOk, setSaveOk] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [sidePanel, setSidePanel] = useState<'palette' | 'config' | 'executions'>('palette')
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [error, setError] = useState('')

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const reactFlowWrapper = useRef<HTMLDivElement>(null)

  useEffect(() => {
    apiFetch(`/api/automations/${id}`)
      .then(r => r.json())
      .then(d => {
        if (!d.success) { setError(d.error || 'No encontrado'); return }
        setAutomation(d.automation)
        const g = d.automation.graph
        setNodes((g.nodes ?? []).map((n: AutomationNode) => ({
          id: n.id, type: n.type, position: n.position, data: n.data,
        })))
        setEdges((g.edges ?? []).map((e: AutomationEdge) => ({
          id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, label: e.label,
          style: { stroke: '#94a3b8', strokeWidth: 2 },
          labelStyle: { fill: '#64748b', fontSize: 10 },
          labelBgStyle: { fill: '#f8fafc', fillOpacity: 0.95 },
        })))
      })
      .finally(() => setLoading(false))
  }, [id, setNodes, setEdges])

  const onConnect = useCallback(
    (params: Connection) => setEdges(eds => addEdge({
      ...params,
      style: { stroke: '#94a3b8', strokeWidth: 2 },
      labelStyle: { fill: '#64748b', fontSize: 10 },
      labelBgStyle: { fill: '#f8fafc', fillOpacity: 0.95 },
    }, eds)),
    [setEdges],
  )

  function onNodeClick(_: React.MouseEvent, node: Node) {
    setSelectedNode(node); setSidePanel('config')
  }

  function onPaneClick() {
    setSelectedNode(null)
    setSidePanel(prev => prev === 'config' ? 'palette' : prev)
  }

  function updateNodeData(nodeId: string, data: Record<string, unknown>) {
    setNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data } : n))
    setSelectedNode(prev => prev?.id === nodeId ? { ...prev, data } : prev)
  }

  function deleteNode(nodeId: string) {
    setNodes(nds => nds.filter(n => n.id !== nodeId))
    setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId))
    setSelectedNode(null); setSidePanel('palette')
  }

  function onDragOver(e: React.DragEvent) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/reactflow') as AutoNodeType
    if (!type) return
    const paletteItem = PALETTE.find(p => p.type === type)
    if (!paletteItem) return
    const bounds = reactFlowWrapper.current?.getBoundingClientRect()
    if (!bounds) return
    const newNode: Node = {
      id: uid(), type,
      position: { x: e.clientX - bounds.left - 90, y: e.clientY - bounds.top - 20 },
      data: { ...paletteItem.defaultData },
    }
    setNodes(nds => [...nds, newNode])
  }

  async function handleSave() {
    if (!automation) return
    setSaving(true); setError('')
    try {
      const graph = {
        nodes: nodes.map(n => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
        edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, label: e.label ?? null })),
      }
      const res = await apiFetch(`/api/automations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...automation, graph }),
      })
      const d = await res.json()
      if (d.success) { setSaveOk(true); setTimeout(() => setSaveOk(false), 2500) }
      else { setError(d.error || 'Error al guardar') }
    } finally { setSaving(false) }
  }

  async function handleTrigger() {
    setTriggering(true)
    try { await apiFetch(`/api/automations/${id}/trigger`, { method: 'POST' }); setSidePanel('executions') }
    finally { setTriggering(false) }
  }

  if (loading) return (
    <div className="h-screen bg-slate-50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center">
          <Zap className="w-5 h-5 text-emerald-600" />
        </div>
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 border-t-emerald-500" />
      </div>
    </div>
  )

  if (error && !automation) return (
    <div className="h-screen bg-slate-50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center">
        <AlertCircle className="w-10 h-10 text-red-500" />
        <div>
          <h3 className="text-slate-800 font-semibold">Error</h3>
          <p className="text-slate-500 text-sm mt-1">{error}</p>
        </div>
        <button onClick={() => router.back()} className="text-emerald-600 text-sm hover:underline">Volver</button>
      </div>
    </div>
  )

  return (
    <div className="h-screen bg-slate-50 flex flex-col overflow-hidden">
      {/* Topbar */}
      <div className="h-14 shrink-0 bg-white border-b border-slate-200 flex items-center gap-3 px-4">
        <button onClick={() => router.push('/dashboard/automations')}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-6 h-6 bg-emerald-50 rounded flex items-center justify-center">
            <Zap className="w-3.5 h-3.5 text-emerald-600" />
          </div>
          <span className="text-slate-800 font-semibold text-sm truncate">{automation?.name}</span>
          {automation && (
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ml-1 ${automation.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
              {automation.is_active ? 'Activa' : 'Inactiva'}
            </span>
          )}
        </div>

        {error && (
          <span className="text-red-600 text-xs bg-red-50 border border-red-200 px-3 py-1.5 rounded-lg">
            {error}
          </span>
        )}

        <div className="flex items-center gap-2">
          <button onClick={handleTrigger} disabled={triggering} title="Disparar manualmente"
            className="flex items-center gap-1.5 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium px-3 py-2 rounded-lg text-xs transition-colors disabled:opacity-60">
            {triggering ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Probar
          </button>
          <button onClick={handleSave} disabled={saving}
            className={`flex items-center gap-1.5 font-medium px-4 py-2 rounded-lg text-xs transition-all shadow-sm ${saveOk ? 'bg-emerald-500 text-white' : 'bg-emerald-600 hover:bg-emerald-700 text-white'} disabled:opacity-60`}>
            {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saveOk ? '¡Guardado!' : 'Guardar'}
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Canvas */}
        <div className="flex-1 relative" ref={reactFlowWrapper} onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} onNodeClick={onNodeClick} onPaneClick={onPaneClick}
            nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.2 }}
            minZoom={0.3} maxZoom={2} deleteKeyCode="Delete"
            defaultEdgeOptions={{ style: { stroke: '#94a3b8', strokeWidth: 2 } }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
            <Controls className="[&>button]:bg-white [&>button]:border-slate-200 [&>button]:text-slate-600 [&>button:hover]:bg-slate-50 [&>button]:rounded [&>button]:shadow-sm" />
            <MiniMap className="!bg-white !border-slate-200 !shadow-sm" nodeColor={() => '#e2e8f0'} maskColor="rgba(248,250,252,0.7)" />
            {nodes.length === 0 && (
              <Panel position="top-center" className="pointer-events-none mt-20">
                <div className="flex flex-col items-center gap-3 text-center">
                  <div className="w-14 h-14 bg-white border border-slate-200 rounded-2xl shadow-sm flex items-center justify-center">
                    <Zap className="w-6 h-6 text-slate-300" />
                  </div>
                  <div>
                    <p className="text-slate-500 font-medium text-sm">Lienzo vacío</p>
                    <p className="text-slate-400 text-xs mt-0.5">Arrastra acciones desde la barra lateral</p>
                  </div>
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>

        {/* Right sidebar */}
        <div className="w-72 shrink-0 bg-white border-l border-slate-200 flex flex-col">
          {/* Tabs */}
          <div className="flex border-b border-slate-200">
            {([
              { key: 'palette', label: 'Acciones', icon: Zap },
              { key: 'config', label: 'Config', icon: Settings2 },
              { key: 'executions', label: 'Historial', icon: List },
            ] as const).map(({ key, label, icon: Icon }) => (
              <button key={key} onClick={() => setSidePanel(key)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-medium border-b-2 transition-colors ${sidePanel === key ? 'border-emerald-500 text-emerald-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
                <Icon className="w-3.5 h-3.5" />{label}
              </button>
            ))}
          </div>

          {/* Panel content */}
          <div className="flex-1 overflow-y-auto p-4">
            {sidePanel === 'palette' && (
              <div className="space-y-2">
                <p className="text-slate-400 text-[10px] uppercase tracking-wider font-semibold mb-3">Arrastra al canvas</p>
                {/* Trigger */}
                <div
                  draggable onDragStart={e => e.dataTransfer.setData('application/reactflow', 'trigger')}
                  className="flex items-center gap-2.5 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5 cursor-grab active:cursor-grabbing text-emerald-700 hover:bg-emerald-100 transition-colors">
                  <Zap className="w-3.5 h-3.5 shrink-0" />
                  <div>
                    <div className="text-xs font-semibold">Disparador</div>
                    <div className="text-[10px] text-emerald-500">Punto de inicio</div>
                  </div>
                </div>

                <div className="border-t border-slate-200 pt-2 mt-1">
                  {PALETTE.map(item => {
                    const Icon = item.icon
                    return (
                      <div key={item.type} draggable onDragStart={e => e.dataTransfer.setData('application/reactflow', item.type)}
                        className={`flex items-center gap-2.5 border rounded-xl px-3 py-2.5 cursor-grab active:cursor-grabbing hover:shadow-sm transition-all mb-2 ${item.color}`}>
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <div className="text-xs font-semibold">{item.label}</div>
                      </div>
                    )
                  })}
                </div>

                <div className="mt-4 bg-slate-50 border border-slate-100 rounded-xl p-3 text-[10px] text-slate-500 space-y-1">
                  <p className="font-medium text-slate-600">Atajos de teclado</p>
                  <p><kbd className="bg-white border border-slate-200 px-1 rounded text-slate-600 shadow-sm">Delete</kbd> — Eliminar nodo</p>
                  <p><kbd className="bg-white border border-slate-200 px-1 rounded text-slate-600 shadow-sm">Ctrl+Z</kbd> — Deshacer</p>
                  <p><kbd className="bg-white border border-slate-200 px-1 rounded text-slate-600 shadow-sm">Scroll</kbd> — Zoom</p>
                </div>
              </div>
            )}

            {sidePanel === 'config' && (
              selectedNode ? (
                <NodeConfig node={selectedNode} onUpdate={updateNodeData} onDelete={deleteNode} />
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Settings2 className="w-8 h-8 text-slate-300 mb-2" />
                  <p className="text-slate-500 text-sm">Haz clic en un nodo</p>
                  <p className="text-slate-400 text-xs mt-1">para configurarlo aquí</p>
                </div>
              )
            )}

            {sidePanel === 'executions' && <ExecutionsPanel automationId={id} />}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function AutomationEditorPage() {
  return (
    <ReactFlowProvider>
      <AutomationEditorInner />
    </ReactFlowProvider>
  )
}
