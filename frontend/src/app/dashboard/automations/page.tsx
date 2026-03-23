'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Zap,
  Plus,
  Search,
  Play,
  Pause,
  Trash2,
  CheckCircle2,
  RefreshCw,
  MoreVertical,
  Tag,
  GitBranch,
  MessageSquare,
  Layers,
  AlertCircle,
  HelpCircle,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import type { Automation, AutoTrigger } from '@/types/automation'

function apiFetch(url: string, options?: RequestInit) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : ''
  return fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options?.headers ?? {}) },
  })
}

const TRIGGER_LABELS: Record<AutoTrigger, string> = {
  lead_created: 'Lead creado',
  lead_stage_changed: 'Etapa cambiada',
  tag_assigned: 'Etiqueta asignada',
  tag_removed: 'Etiqueta removida',
  message_received: 'Mensaje recibido',
  manual: 'Manual',
}

const TRIGGER_ICONS: Record<AutoTrigger, React.ElementType> = {
  lead_created: Plus,
  lead_stage_changed: GitBranch,
  tag_assigned: Tag,
  tag_removed: Tag,
  message_received: MessageSquare,
  manual: Zap,
}

const TRIGGER_BG: Record<AutoTrigger, string> = {
  lead_created: 'bg-emerald-50 text-emerald-600',
  lead_stage_changed: 'bg-sky-50 text-sky-600',
  tag_assigned: 'bg-violet-50 text-violet-600',
  tag_removed: 'bg-amber-50 text-amber-600',
  message_received: 'bg-blue-50 text-blue-600',
  manual: 'bg-slate-100 text-slate-600',
}

const TRIGGER_PILL: Record<AutoTrigger, string> = {
  lead_created: 'bg-emerald-50 text-emerald-700',
  lead_stage_changed: 'bg-sky-50 text-sky-700',
  tag_assigned: 'bg-violet-50 text-violet-700',
  tag_removed: 'bg-amber-50 text-amber-700',
  message_received: 'bg-blue-50 text-blue-700',
  manual: 'bg-slate-100 text-slate-600',
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('es-PE', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function GuideSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
      >
        <span className="font-medium text-sm text-slate-800">{title}</span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      </button>
      {open && <div className="px-4 py-3 text-sm text-slate-600 space-y-3">{children}</div>}
    </div>
  )
}

function GuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-2">
            <HelpCircle className="w-5 h-5 text-emerald-600" />
            <h2 className="text-lg font-bold text-slate-900">Guía de Automatizaciones</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-6 space-y-3 flex-1">
          <p className="text-sm text-slate-500 mb-4">
            Las automatizaciones ejecutan acciones de forma automática cuando ocurren eventos en tus leads. Configura flujos para ahorrar tiempo.
          </p>

          <GuideSection title="¿Qué es un disparador (trigger)?" defaultOpen={true}>
            <p>El disparador determina <strong>cuándo</strong> se ejecuta la automatización:</p>
            <div className="grid gap-2 mt-2">
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded text-xs font-medium shrink-0">Lead creado</span><span>Se activa cuando se crea un nuevo lead en el sistema.</span></div>
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-sky-50 text-sky-700 rounded text-xs font-medium shrink-0">Etapa cambiada</span><span>Se activa cuando un lead cambia de etapa en el pipeline.</span></div>
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-violet-50 text-violet-700 rounded text-xs font-medium shrink-0">Etiqueta asignada</span><span>Se activa cuando se asigna una etiqueta específica a un lead.</span></div>
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-amber-50 text-amber-700 rounded text-xs font-medium shrink-0">Etiqueta removida</span><span>Se activa cuando se quita una etiqueta de un lead.</span></div>
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium shrink-0">Mensaje recibido</span><span>Se activa cuando llega un mensaje de WhatsApp de un lead.</span></div>
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs font-medium shrink-0">Manual</span><span>Se ejecuta solo cuando haces clic en &quot;Ejecutar&quot; manualmente. Ideal para pruebas.</span></div>
            </div>
          </GuideSection>

          <GuideSection title="¿Qué acciones puedo agregar?">
            <p>Las acciones son los pasos que se ejecutan en secuencia:</p>
            <div className="grid gap-2 mt-2">
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-sky-50 text-sky-700 rounded text-xs font-medium shrink-0">Enviar WhatsApp</span><span>Envía un mensaje por WhatsApp al lead. Usa variables como <code className="bg-slate-100 px-1 rounded text-xs">{'{{nombre}}'}</code> y <code className="bg-slate-100 px-1 rounded text-xs">{'{{telefono}}'}</code>.</span></div>
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-violet-50 text-violet-700 rounded text-xs font-medium shrink-0">Cambiar etapa</span><span>Mueve el lead a otra etapa del pipeline.</span></div>
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-amber-50 text-amber-700 rounded text-xs font-medium shrink-0">Asignar etiqueta</span><span>Agrega una etiqueta al lead.</span></div>
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-orange-50 text-orange-700 rounded text-xs font-medium shrink-0">Remover etiqueta</span><span>Quita una etiqueta del lead.</span></div>
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs font-medium shrink-0">Esperar</span><span>Pausa la ejecución por un tiempo (ej: 60 segundos). Útil entre mensajes de WhatsApp.</span></div>
              <div className="flex items-start gap-2"><span className="px-2 py-0.5 bg-pink-50 text-pink-700 rounded text-xs font-medium shrink-0">Condición</span><span>Bifurca el flujo: si la condición se cumple sigue por un camino, si no por otro.</span></div>
            </div>
          </GuideSection>

          <GuideSection title="Ejemplo 1: Bienvenida automática a nuevos leads">
            <div className="bg-slate-50 rounded-lg p-3 space-y-2">
              <p><strong>Objetivo:</strong> Cuando se crea un lead, enviar un saludo por WhatsApp.</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Crea una automatización con disparador <strong>&quot;Lead creado&quot;</strong>.</li>
                <li>En el editor visual, arrastra la acción <strong>&quot;Enviar WhatsApp&quot;</strong> al lienzo.</li>
                <li>Conecta el nodo del disparador con la acción (arrastra desde el punto inferior al superior).</li>
                <li>Haz clic en la acción y configura: selecciona el dispositivo WhatsApp y escribe el mensaje, por ejemplo: <code className="bg-white px-1.5 py-0.5 rounded border text-xs">{'Hola {{nombre}}, gracias por contactarnos. Pronto te atenderemos.'}</code></li>
                <li>Guarda y activa la automatización.</li>
              </ol>
            </div>
          </GuideSection>

          <GuideSection title="Ejemplo 2: Seguimiento con espera">
            <div className="bg-slate-50 rounded-lg p-3 space-y-2">
              <p><strong>Objetivo:</strong> Cuando un lead llega a la etapa &quot;Contactado&quot;, esperar 1 hora y enviar un recordatorio.</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Crea una automatización con disparador <strong>&quot;Etapa cambiada&quot;</strong>.</li>
                <li>Arrastra <strong>&quot;Esperar&quot;</strong> y configura 3600 segundos (1 hora).</li>
                <li>Arrastra <strong>&quot;Enviar WhatsApp&quot;</strong> y escribe el recordatorio.</li>
                <li>Conecta: Disparador → Esperar → Enviar WhatsApp.</li>
                <li>Guarda y activa.</li>
              </ol>
            </div>
          </GuideSection>

          <GuideSection title="Ejemplo 3: Etiquetado automático por mensaje">
            <div className="bg-slate-50 rounded-lg p-3 space-y-2">
              <p><strong>Objetivo:</strong> Cuando un lead envía un mensaje, asignarle la etiqueta &quot;Activo&quot;.</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Crea una automatización con disparador <strong>&quot;Mensaje recibido&quot;</strong>.</li>
                <li>Arrastra <strong>&quot;Asignar etiqueta&quot;</strong> y selecciona la etiqueta &quot;Activo&quot;.</li>
                <li>Conecta el disparador con la acción.</li>
                <li>Guarda y activa.</li>
              </ol>
            </div>
          </GuideSection>

          <GuideSection title="¿Cómo probar una automatización?">
            <div className="space-y-2">
              <p><strong>Opción A: Disparador manual</strong></p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Crea una automatización con disparador <strong>&quot;Manual&quot;</strong>.</li>
                <li>Agrega las acciones que quieras probar.</li>
                <li>Guarda la automatización. No necesitas activarla.</li>
                <li>En el editor, haz clic en el botón <strong>&quot;Probar&quot;</strong> de la barra superior.</li>
                <li>Ingresa el ID de un lead de prueba y ejecuta.</li>
                <li>Revisa la pestaña <strong>&quot;Historial&quot;</strong> del panel derecho para ver el resultado.</li>
              </ol>
              <p className="mt-2"><strong>Opción B: Simular el evento real</strong></p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Crea y activa la automatización con el disparador deseado.</li>
                <li>Realiza la acción que activa el disparador (ej: crea un lead nuevo, cambia una etapa, asigna una etiqueta).</li>
                <li>Vuelve al editor y revisa el <strong>&quot;Historial&quot;</strong> para ver si se ejecutó correctamente.</li>
              </ol>
            </div>
          </GuideSection>

          <GuideSection title="¿Cómo leer el historial de ejecuciones?">
            <div className="space-y-2">
              <p>En el editor de la automatización, la pestaña <strong>&quot;Historial&quot;</strong> muestra cada ejecución:</p>
              <div className="grid gap-1.5 mt-1">
                <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-500" /><span><strong>Completada:</strong> todos los pasos se ejecutaron sin errores.</span></div>
                <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500" /><span><strong>Fallida:</strong> hubo un error. Expande para ver el detalle del error.</span></div>
                <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500" /><span><strong>En ejecución:</strong> la automatización está procesando (puede estar en un paso de espera).</span></div>
                <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-amber-500" /><span><strong>Pendiente:</strong> está en cola, esperando ser procesada.</span></div>
              </div>
              <p className="mt-1">Cada ejecución muestra los logs de cada nodo: tipo de acción, duración y errores si los hubo.</p>
            </div>
          </GuideSection>

          <GuideSection title="Errores comunes y soluciones">
            <div className="space-y-2">
              <div className="bg-red-50 rounded-lg p-2.5">
                <p className="text-xs font-medium text-red-800">Error: &quot;no WhatsApp device connected&quot;</p>
                <p className="text-xs text-red-600">Solución: Ve a Dispositivos y asegúrate de que el dispositivo esté conectado (estado verde).</p>
              </div>
              <div className="bg-red-50 rounded-lg p-2.5">
                <p className="text-xs font-medium text-red-800">Error: &quot;lead not found&quot;</p>
                <p className="text-xs text-red-600">Solución: El lead fue eliminado. Verifica que el lead exista antes de ejecutar.</p>
              </div>
              <div className="bg-red-50 rounded-lg p-2.5">
                <p className="text-xs font-medium text-red-800">Error: &quot;rate limit exceeded&quot;</p>
                <p className="text-xs text-red-600">Solución: Se superó el límite de 500 ejecuciones por hora. Espera o reduce la frecuencia.</p>
              </div>
              <div className="bg-amber-50 rounded-lg p-2.5">
                <p className="text-xs font-medium text-amber-800">La automatización no se ejecuta</p>
                <p className="text-xs text-amber-600">Verifica: (1) que esté activada (switch verde), (2) que el disparador coincida con la acción realizada, (3) que los nodos estén conectados correctamente.</p>
              </div>
            </div>
          </GuideSection>
        </div>
      </div>
    </div>
  )
}

interface CreateModalProps {
  onClose: () => void
  onCreate: (a: Automation) => void
}

function CreateModal({ onClose, onCreate }: CreateModalProps) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [trigger, setTrigger] = useState<AutoTrigger>('lead_created')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError('El nombre es obligatorio'); return }
    setSaving(true); setError('')
    try {
      const res = await apiFetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: desc.trim(), trigger, trigger_config: {}, graph: { nodes: [], edges: [] } }),
      })
      const data = await res.json()
      if (data.success) { onCreate(data.automation) } else { setError(data.error || 'Error al crear') }
    } catch { setError('Error de conexión') } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-50 rounded-lg flex items-center justify-center">
              <Zap className="w-4 h-4 text-emerald-600" />
            </div>
            <h2 className="text-slate-800 font-semibold">Nueva automatización</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <Plus className="w-5 h-5 rotate-45" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />{error}
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Nombre</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Bienvenida a nuevo lead"
              className="w-full border border-slate-200 bg-white text-slate-800 placeholder-slate-400 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Descripción <span className="text-slate-400 font-normal">(opcional)</span></label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="¿Qué hace esta automatización?"
              className="w-full border border-slate-200 bg-white text-slate-800 placeholder-slate-400 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Disparador</label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(TRIGGER_LABELS) as AutoTrigger[]).map(t => {
                const Icon = TRIGGER_ICONS[t]
                const selected = trigger === t
                return (
                  <button key={t} type="button" onClick={() => setTrigger(t)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all ${selected ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'}`}>
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{TRIGGER_LABELS[t]}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium py-2.5 rounded-xl text-sm transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2.5 rounded-xl text-sm shadow-sm transition-colors disabled:opacity-60 flex items-center justify-center gap-2">
              {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Crear
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface AutomationCardProps {
  automation: Automation
  onToggle: (id: string, active: boolean) => void
  onDelete: (id: string) => void
}

function AutomationCard({ automation: a, onToggle, onDelete }: AutomationCardProps) {
  const [menu, setMenu] = useState(false)
  const TriggerIcon = TRIGGER_ICONS[a.trigger]
  const stats = a.stats

  return (
    <div className="group bg-white rounded-xl border border-slate-200 p-5 hover:shadow-lg hover:border-slate-300 transition-all duration-200">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${TRIGGER_BG[a.trigger]}`}>
            <TriggerIcon className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <Link href={`/dashboard/automations/${a.id}`}
              className="text-slate-800 font-semibold text-sm hover:text-emerald-600 transition-colors truncate block">
              {a.name}
            </Link>
            {a.description && <p className="text-slate-500 text-xs mt-0.5 truncate">{a.description}</p>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => onToggle(a.id, !a.is_active)} title={a.is_active ? 'Desactivar' : 'Activar'}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${a.is_active ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' : 'bg-slate-100 text-slate-400 hover:bg-slate-200 hover:text-slate-600'}`}>
            {a.is_active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <div className="relative">
            <button onClick={() => setMenu(v => !v)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors">
              <MoreVertical className="w-3.5 h-3.5" />
            </button>
            {menu && (
              <div className="absolute right-0 top-8 z-10 bg-white border border-slate-200 rounded-xl shadow-lg w-40 overflow-hidden">
                <Link href={`/dashboard/automations/${a.id}`}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                  onClick={() => setMenu(false)}>
                  <Layers className="w-3.5 h-3.5" />Editar flujo
                </Link>
                <button onClick={() => { setMenu(false); onDelete(a.id) }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />Eliminar
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${TRIGGER_PILL[a.trigger]}`}>
          <TriggerIcon className="w-3 h-3" />{TRIGGER_LABELS[a.trigger]}
        </span>
        {a.is_active ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Activa
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-500">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />Inactiva
          </span>
        )}
      </div>

      {stats && (
        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="bg-slate-50 rounded-lg px-3 py-2 text-center">
            <div className="text-slate-800 font-semibold text-sm">{stats.total_executions}</div>
            <div className="text-slate-400 text-xs mt-0.5">Total</div>
          </div>
          <div className="bg-emerald-50 rounded-lg px-3 py-2 text-center">
            <div className="text-emerald-700 font-semibold text-sm">{stats.completed}</div>
            <div className="text-emerald-500 text-xs mt-0.5">OK</div>
          </div>
          <div className="bg-red-50 rounded-lg px-3 py-2 text-center">
            <div className="text-red-600 font-semibold text-sm">{stats.failed}</div>
            <div className="text-red-400 text-xs mt-0.5">Fallidos</div>
          </div>
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
        <span className="text-slate-400 text-xs">Creado {fmtDate(a.created_at)}</span>
        <Link href={`/dashboard/automations/${a.id}`}
          className="text-xs text-emerald-600 hover:text-emerald-700 font-medium transition-colors opacity-0 group-hover:opacity-100">
          Editar flujo →
        </Link>
      </div>
    </div>
  )
}

function StatsBar({ automations }: { automations: Automation[] }) {
  const total = automations.length
  const active = automations.filter(a => a.is_active).length
  const totalExec = automations.reduce((s, a) => s + (a.stats?.total_executions ?? a.execution_count), 0)
  const totalOk = automations.reduce((s, a) => s + (a.stats?.completed ?? 0), 0)

  return (
    <div className="flex items-center gap-4 text-sm text-slate-600 bg-white border border-slate-200 rounded-xl px-4 py-2.5 shrink-0">
      <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-emerald-600" /><span className="font-semibold text-slate-800">{total}</span> total</span>
      <span className="text-slate-200">|</span>
      <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-blue-600" /><span className="font-semibold text-slate-800">{active}</span> activas</span>
      <span className="text-slate-200">|</span>
      <span className="flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5 text-purple-600" /><span className="font-semibold text-slate-800">{totalExec}</span> ejecuciones</span>
      <span className="text-slate-200">|</span>
      <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-amber-600" /><span className="font-semibold text-slate-800">{totalOk}</span> completadas</span>
    </div>
  )
}

export default function AutomationsPage() {
  const [automations, setAutomations] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [filterActive, setFilterActive] = useState<'all' | 'active' | 'inactive'>('all')

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/automations')
      const data = await res.json()
      if (data.success) setAutomations(data.automations ?? [])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleToggle(id: string, active: boolean) {
    await apiFetch(`/api/automations/${id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    })
    setAutomations(prev => prev.map(a => a.id === id ? { ...a, is_active: active } : a))
  }

  async function handleDelete(id: string) {
    await apiFetch(`/api/automations/${id}`, { method: 'DELETE' })
    setAutomations(prev => prev.filter(a => a.id !== id))
    setDeleteId(null)
  }

  const filtered = automations.filter(a => {
    const matchSearch = a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.description.toLowerCase().includes(search.toLowerCase())
    const matchFilter = filterActive === 'all' ? true : filterActive === 'active' ? a.is_active : !a.is_active
    return matchSearch && matchFilter
  })

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden gap-3">
      <div className="flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-emerald-50 rounded-xl flex items-center justify-center">
            <Zap className="w-5 h-5 text-emerald-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Automatizaciones</h1>
            <p className="text-xs text-slate-500">Flujos de trabajo automáticos para tus leads</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowGuide(true)}
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 transition-all font-medium text-xs">
            <HelpCircle className="w-3.5 h-3.5" />Guía
          </button>
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium text-xs">
            <Plus className="w-3.5 h-3.5" />Nueva
          </button>
        </div>
      </div>

      {!loading && automations.length > 0 && <StatsBar automations={automations} />}

      <div className="flex items-center gap-3 shrink-0">
        <div className="flex-1 relative max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar..."
            className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 bg-white text-xs transition-all" />
        </div>
        <div className="flex gap-0.5 bg-white border border-slate-200 rounded-xl p-0.5">
          {(['all', 'active', 'inactive'] as const).map(f => (
            <button key={f} onClick={() => setFilterActive(f)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${filterActive === f ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
              {f === 'all' ? 'Todas' : f === 'active' ? 'Activas' : 'Inactivas'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 p-4 animate-pulse">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 bg-slate-200 rounded-lg" />
                <div className="flex-1"><div className="h-3.5 bg-slate-200 rounded w-3/4 mb-1.5" /><div className="h-3 bg-slate-100 rounded w-1/3" /></div>
              </div>
              <div className="h-3 bg-slate-100 rounded w-full mb-1.5" /><div className="h-3 bg-slate-100 rounded w-2/3" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl border border-slate-200">
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-4">
            <Zap className="w-8 h-8 text-emerald-400" />
          </div>
          <h3 className="text-base font-semibold text-slate-800 mb-1.5">
            {automations.length === 0 ? 'Sin automatizaciones' : 'Sin resultados'}
          </h3>
          <p className="text-slate-500 mb-5 max-w-xs mx-auto text-xs">
            {automations.length === 0 ? 'Crea tu primera automatización para empezar a ahorrar tiempo.' : 'Prueba con otros filtros o términos de búsqueda.'}
          </p>
          {automations.length === 0 && (
            <button onClick={() => setShowCreate(true)}
              className="px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium text-xs">
              Crear automatización
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(a => (
            <AutomationCard key={a.id} automation={a} onToggle={handleToggle} onDelete={id => setDeleteId(id)} />
          ))}
        </div>
      )}
      </div>

      {showCreate && (
        <CreateModal onClose={() => setShowCreate(false)} onCreate={a => { setAutomations(prev => [a, ...prev]); setShowCreate(false) }} />
      )}

      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-red-50 rounded-xl flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h3 className="text-slate-800 font-semibold">Eliminar automatización</h3>
                <p className="text-slate-500 text-sm">Esta acción no se puede deshacer.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)}
                className="flex-1 border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium py-2.5 rounded-xl text-sm transition-colors">
                Cancelar
              </button>
              <button onClick={() => handleDelete(deleteId)}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-medium py-2.5 rounded-xl text-sm transition-colors">
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
