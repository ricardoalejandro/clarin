'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, LockKeyhole, ShieldCheck, X } from 'lucide-react'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import { useWhiteboardDialogFocus } from '@/components/whiteboards/useWhiteboardDialogFocus'
import { loadTaskLocationViewAccess, replaceTaskLocationViewAccess } from '@/lib/taskLocationViewsApi'
import type { TaskLocationView, TaskLocationViewVisibilityMode, TaskLocationViewVisibilityPolicy } from '@/types/task'
import TaskLocationViewVisibilityFields, { selectedVisibilityMembers, type TaskLocationViewSelectedMember } from './TaskLocationViewVisibilityFields'

export default function TaskLocationViewAccessDialog({
  view,
  onBeforeSave,
  onClose,
  onSaved,
}: {
  view: TaskLocationView
  onBeforeSave: () => Promise<string | null>
  onClose: () => void
  onSaved: (policy: TaskLocationViewVisibilityPolicy) => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<TaskLocationViewVisibilityMode>(view.visibility_mode || 'inherit')
  const [originalMode, setOriginalMode] = useState<TaskLocationViewVisibilityMode>(view.visibility_mode || 'inherit')
  const [revision, setRevision] = useState(view.access_revision)
  const [members, setMembers] = useState<TaskLocationViewSelectedMember[]>([])
  const [confirmWiden, setConfirmWiden] = useState(false)
  useWhiteboardDialogFocus(dialogRef, onClose)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void loadTaskLocationViewAccess(view.id, controller.signal).then(result => {
      if (!result.success || !result.data?.access) {
        setLoading(false)
        setError(result.error || 'No se pudo cargar la privacidad de la pizarra.')
        return
      }
      const policy = result.data.access
      setLoading(false)
      setMode(policy.visibility_mode)
      setOriginalMode(policy.visibility_mode)
      setRevision(policy.access_revision)
      setMembers(selectedVisibilityMembers(policy.members || []))
    })
    return () => controller.abort()
  }, [view.id])

  const save = async () => {
    if (saving || loading || mode === 'restricted' && members.length === 0) return
    if (originalMode === 'restricted' && mode === 'inherit' && !confirmWiden) {
      setConfirmWiden(true)
      return
    }
    setSaving(true)
    setError('')
    const preparationError = await onBeforeSave()
    if (preparationError) {
      setSaving(false)
      setError(preparationError)
      return
    }
    const result = await replaceTaskLocationViewAccess({
      viewID: view.id,
      visibilityMode: mode,
      visibleUserIDs: mode === 'restricted' ? members.map(member => member.user_id) : [],
      expectedAccessRevision: revision,
    })
    setSaving(false)
    if (!result.success || !result.data?.access) {
      setConfirmWiden(false)
      setError(result.status === 409
        ? 'La privacidad cambió en otra sesión. Cierra y vuelve a abrir para revisar la versión actual.'
        : result.error || 'No se pudo guardar la privacidad de la pizarra.')
      return
    }
    onSaved(result.data.access)
    onClose()
  }

  return createPortal(<div role="presentation" onMouseDown={event => { if (!saving && event.target === event.currentTarget) onClose() }} className="fixed inset-0 flex items-center justify-center bg-slate-950/50 p-3 backdrop-blur-sm sm:p-5" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.dialog }}>
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="task-location-access-title" className="max-h-[min(760px,calc(100dvh-1.5rem))] w-full max-w-xl overflow-y-auto rounded-3xl border border-slate-200 bg-white shadow-2xl outline-none">
      <header className="flex items-start gap-4 border-b border-slate-100 px-5 py-5"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-50 text-violet-700"><LockKeyhole className="h-5 w-5" /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-black uppercase tracking-[.14em] text-violet-600">Clarin Work</p><h2 id="task-location-access-title" className="truncate text-lg font-black text-slate-900">Privacidad de {view.resource.whiteboard.name}</h2><p className="mt-1 text-sm leading-5 text-slate-500">Define quién puede encontrar esta pizarra sin modificar los permisos de la Lista o Carpeta.</p></div><button type="button" disabled={saving} onClick={onClose} aria-label="Cerrar" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-40"><X className="h-4 w-4" /></button></header>
      <div className="p-5">
        {loading ? <div className="flex min-h-48 items-center justify-center text-sm font-semibold text-slate-500"><Loader2 className="mr-2 h-5 w-5 animate-spin text-violet-600" />Cargando privacidad…</div> : <TaskLocationViewVisibilityFields scopeType={view.scope.scope_type} scopeID={view.scope.scope_id} canManageAccess={view.capabilities.can_manage_access} mode={mode} selected={members} onMode={next => { setMode(next); setConfirmWiden(false) }} onSelected={setMembers} disabled={saving} />}
        {confirmWiden && <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" /><div><p className="text-sm font-black text-amber-900">Esto ampliará la audiencia</p><p className="mt-1 text-xs leading-5 text-amber-800">Todas las personas que puedan ver la ubicación también podrán encontrar esta pizarra. Pulsa Guardar otra vez para confirmar.</p></div></div></div>}
        {error && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">{error}</p>}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={saving} onClick={onClose} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="button" disabled={loading || saving || mode === 'restricted' && members.length === 0} onClick={() => void save()} className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-violet-700 px-4 text-sm font-black text-white hover:bg-violet-800 disabled:opacity-40">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Guardar privacidad</button></div>
      </div>
    </div>
  </div>, document.body)
}
