'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive, Boxes, Check, Eye, FileLock2, FolderTree, Globe2, Layers3, Loader2,
  LockKeyhole, MessageCircle, Pencil, Plus, RotateCcw, Save, ShieldCheck, Trash2, UserRound, Workflow, X,
} from 'lucide-react'
import { api, apiDelete, apiGet, apiPost, apiPut } from '@/lib/api'
import type { TaskAccessGrant, TaskAccessLevel, TaskEnvironment, TaskFolder, TaskList, TaskWorkflow } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import { TaskColorPicker, TaskContainerIcon, TaskIconPicker, normalizeTaskHexColor } from './TaskContainerAppearance'
import TaskDestructiveConfirmDialog from './TaskDestructiveConfirmDialog'
import { TaskSelectPicker, type TaskSelectOption } from './TaskSelectPicker'
import TaskUserCombobox from './TaskUserCombobox'
import TaskWorkWindowShell from './TaskWorkWindowShell'
import { normalizeTaskAccessGrants, TASK_ACCESS_LEVELS, taskAccessLabel, validatePrivateAccessManagers } from './taskEnvironmentAccess'
import { taskEnvironmentSaveError } from './taskEnvironmentErrors'
import { taskContainerCanManageStructure } from './taskContainerCapabilities'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

type EnvironmentTab = 'general' | 'structure' | 'workflows' | 'access' | 'archive'

type AccessResponse = {
  access_revision: number
  access_mode?: 'inherit' | 'private'
  grants: TaskAccessGrant[]
}

type EnvironmentResponse = {
  environment: TaskEnvironment
  operation_id?: string
}

const ACCESS_ICONS: Record<TaskAccessLevel, ReactNode> = {
  none: <FileLock2 className="h-4 w-4" />,
  view: <Eye className="h-4 w-4" />,
  comment: <MessageCircle className="h-4 w-4" />,
  edit: <Pencil className="h-4 w-4" />,
  full: <ShieldCheck className="h-4 w-4" />,
}

const accessOptions: TaskSelectOption[] = TASK_ACCESS_LEVELS.map(item => ({
  value: item.value,
  label: item.label,
  description: item.description,
  leading: ACCESS_ICONS[item.value],
}))

const tabs: Array<{ id: EnvironmentTab; label: string; icon: typeof Layers3 }> = [
  { id: 'general', label: 'General', icon: Layers3 },
  { id: 'structure', label: 'Estructura', icon: FolderTree },
  { id: 'workflows', label: 'Flujos', icon: Workflow },
  { id: 'access', label: 'Acceso', icon: ShieldCheck },
  { id: 'archive', label: 'Archivo', icon: Archive },
]

interface Props {
  open: boolean
  environment: TaskEnvironment | null
  users: TaskAccountUser[]
  folders: TaskFolder[]
  lists: TaskList[]
  workflows: TaskWorkflow[]
  storageScope: string
  onClose: () => void
  onSaved: (environment: TaskEnvironment) => void
  onOpenStructure: () => void
}

export interface TaskEnvironmentWindowHandle { requestClose: () => Promise<boolean> }

type EnvironmentGeneralDraft = {
  name: string
  description: string
  color: string
  icon: string
  visibility: 'account' | 'restricted'
  defaultAccess: TaskAccessLevel
}

function environmentGeneralDraft(environment: TaskEnvironment | null): EnvironmentGeneralDraft {
  return {
    name: environment?.name || '',
    description: environment?.description || '',
    color: normalizeTaskHexColor(environment?.color || '#6366F1', '#6366F1'),
    icon: environment?.icon || 'layers',
    visibility: environment?.visibility || 'restricted',
    defaultAccess: environment?.default_access_level || 'none',
  }
}

function environmentAccessDraftKey(grants: TaskAccessGrant[]) {
  return normalizeTaskAccessGrants(grants)
    .map(({ user_id, access_level, can_manage_access }) => `${user_id}:${access_level}:${can_manage_access ? '1' : '0'}`)
    .join('|')
}

function userName(user?: TaskAccountUser, grant?: TaskAccessGrant) {
  return grant?.display_name || user?.display_name || grant?.username || user?.username || 'Usuario'
}

const TaskEnvironmentWindow = forwardRef<TaskEnvironmentWindowHandle, Props>(function TaskEnvironmentWindow({
  open,
  environment,
  users,
  folders,
  lists,
  workflows,
  storageScope,
  onClose,
  onSaved,
  onOpenStructure,
}, forwardedRef) {
  const creating = !environment
  const [tab, setTab] = useState<EnvironmentTab>('general')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('#6366F1')
  const [icon, setIcon] = useState('layers')
  const [visibility, setVisibility] = useState<'account' | 'restricted'>('restricted')
  const [defaultAccess, setDefaultAccess] = useState<TaskAccessLevel>('none')
  const [grants, setGrants] = useState<TaskAccessGrant[]>([])
  const [accessRevision, setAccessRevision] = useState(1)
  const [selectedUser, setSelectedUser] = useState('')
  const [accessLoading, setAccessLoading] = useState(false)
  const [accessLoaded, setAccessLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [confirmTrash, setConfirmTrash] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const generalBaselineRef = useRef<EnvironmentGeneralDraft>(environmentGeneralDraft(environment))
  const accessBaselineRef = useRef<TaskAccessGrant[]>([])
  const discardDialogRef = useRef<HTMLDivElement>(null)
  const discardContinueRef = useRef<HTMLButtonElement>(null)
  const discardReturnFocusRef = useRef<HTMLElement | null>(null)
  const closeDecisionRef = useRef<((allowed: boolean) => void) | null>(null)
  const closeDecisionPromiseRef = useRef<Promise<boolean> | null>(null)

  useEffect(() => {
    if (!open) return
    const baseline = environmentGeneralDraft(environment)
    generalBaselineRef.current = baseline
    accessBaselineRef.current = []
    setTab(environment?.archived_at ? 'archive' : 'general')
    setName(baseline.name)
    setDescription(baseline.description)
    setColor(baseline.color)
    setIcon(baseline.icon)
    setVisibility(baseline.visibility)
    setDefaultAccess(baseline.defaultAccess)
    setGrants([])
    setAccessRevision(environment?.access_revision || 1)
    setSelectedUser('')
    setAccessLoaded(false)
    setAccessLoading(false)
    setBusy(false)
    setError('')
    setNotice('')
    setConfirmArchive(false)
    setConfirmTrash(false)
    setDiscardConfirm(false)
  // Initialize only when the work-window opens or switches to another Entorno.
  // Canonical saves below reconcile their own fields; depending on the whole
  // object would erase success/error feedback every time the parent patches it.
  }, [environment?.id, open]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadAccess = useCallback(async () => {
    if (!environment) return
    setAccessLoading(true)
    setError('')
    const result = await apiGet<AccessResponse>(`/api/tasks/environments/${environment.id}/access`)
    setAccessLoading(false)
    if (!result.success) {
      setError(result.error || 'No se pudo cargar el acceso de este Entorno.')
      return
    }
    const canonicalGrants = normalizeTaskAccessGrants(result.data?.grants || [])
    accessBaselineRef.current = canonicalGrants
    setGrants(canonicalGrants)
    setAccessRevision(result.data?.access_revision || environment.access_revision || 1)
    setAccessLoaded(true)
  }, [environment])

  useEffect(() => {
    if (open && tab === 'access' && environment && !accessLoaded && !accessLoading) void loadAccess()
  }, [accessLoaded, accessLoading, environment, loadAccess, open, tab])

  const selectedEnvironmentFolders = useMemo(
    () => folders.filter(folder => !environment || folder.environment_id === environment.id),
    [environment, folders],
  )
  const selectedEnvironmentLists = useMemo(
    () => lists.filter(list => !environment || list.environment_id === environment.id),
    [environment, lists],
  )
  const selectedEnvironmentWorkflows = useMemo(
    () => workflows.filter(workflow => !environment || workflow.environment_id === environment.id),
    [environment, workflows],
  )

  const saveGeneral = async () => {
    const cleanName = name.trim()
    if (!cleanName) {
      setError('Escribe un nombre para el Entorno.')
      return
    }
    if (cleanName.length > 120) {
      setError('El nombre no puede superar 120 caracteres.')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    const operationID = crypto.randomUUID()
    const body = {
      name: cleanName,
      description: description.trim(),
      color: normalizeTaskHexColor(color, '#6366F1'),
      icon,
      visibility,
      default_access_level: visibility === 'restricted' ? 'none' : defaultAccess,
      version: environment?.version,
      expected_access_revision: environment ? accessRevision : undefined,
      operation_id: operationID,
    }
    const result = creating
      ? await apiPost<EnvironmentResponse>('/api/tasks/environments', body)
      : await api<EnvironmentResponse>(`/api/tasks/environments/${environment.id}`, { method: 'PATCH', body: JSON.stringify(body) })
    setBusy(false)
    if (!result.success || !result.data?.environment) {
      const code = (result.data as unknown as { code?: string } | undefined)?.code
      setError(taskEnvironmentSaveError(result.status, code, result.error))
      return
    }
    const canonical = result.data.environment
    generalBaselineRef.current = environmentGeneralDraft(canonical)
    setName(canonical.name)
    setDescription(canonical.description || '')
    setColor(normalizeTaskHexColor(canonical.color, '#6366F1'))
    setIcon(canonical.icon)
    setVisibility(canonical.visibility)
    setDefaultAccess(canonical.default_access_level)
    setAccessRevision(canonical.access_revision || accessRevision)
    onSaved(canonical)
    setNotice(creating ? 'Entorno creado con su flujo y Bandeja general.' : 'Cambios guardados.')
    if (creating) onClose()
  }

  const addGrant = () => {
    if (!selectedUser || grants.some(grant => grant.user_id === selectedUser)) return
    const user = users.find(item => item.id === selectedUser)
    setGrants(current => normalizeTaskAccessGrants([...current, {
      user_id: selectedUser,
      display_name: user?.display_name,
      username: user?.username,
      access_level: 'view',
      can_manage_access: false,
    }]))
    setSelectedUser('')
  }

  const updateGrant = (userID: string, patch: Partial<TaskAccessGrant>) => {
    setGrants(current => normalizeTaskAccessGrants(current.map(grant => grant.user_id === userID ? { ...grant, ...patch } : grant)))
  }

  const saveAccess = async () => {
    if (!environment) return
    const canonical = normalizeTaskAccessGrants(grants)
    const validation = validatePrivateAccessManagers(environment.visibility === 'restricted', canonical)
    if (validation) {
      setError(validation)
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    const operationID = crypto.randomUUID()
    const result = await apiPut<AccessResponse & { environment?: TaskEnvironment }>(`/api/tasks/environments/${environment.id}/access`, {
      expected_access_revision: accessRevision,
      grants: canonical.map(({ user_id, access_level, can_manage_access }) => ({ user_id, access_level, can_manage_access })),
      operation_id: operationID,
    })
    setBusy(false)
    if (!result.success) {
      setError(result.status === 409 ? 'Los permisos cambiaron en otra sesión. Recarga el acceso y vuelve a aplicar tus cambios.' : result.error || 'No se pudieron guardar los permisos.')
      return
    }
    const canonicalGrants = normalizeTaskAccessGrants(result.data?.grants || canonical)
    accessBaselineRef.current = canonicalGrants
    setGrants(canonicalGrants)
    setAccessRevision(result.data?.access_revision || accessRevision + 1)
    if (result.data?.environment) onSaved(result.data.environment)
    setNotice('Acceso actualizado y reconciliado con el servidor.')
  }

  const archiveOrRestore = async () => {
    if (!environment) return
    setBusy(true)
    setError('')
		const action = environment.archived_at ? 'unarchive' : 'archive'
    const result = await apiPost<EnvironmentResponse>(`/api/tasks/environments/${environment.id}/${action}`, {
      version: environment.version,
      operation_id: crypto.randomUUID(),
    })
    setBusy(false)
    if (!result.success || !result.data?.environment) {
		setError(result.status === 409 ? 'Este Entorno todavía tiene tareas abiertas o cambió en otra sesión. Completa o cancela las tareas abiertas antes de archivarlo.' : result.error || `No se pudo ${action === 'archive' ? 'archivar' : 'restaurar'} el Entorno.`)
      return
    }
    onSaved(result.data.environment)
    setConfirmArchive(false)
    setNotice(action === 'archive' ? 'Entorno archivado.' : 'Entorno restaurado.')
  }

	const moveToTrash = async () => {
		if (!environment || environment.task_count > 0 || environment.is_default) return
		setBusy(true)
		setError('')
		const result = await apiDelete(`/api/tasks/environments/${environment.id}`, {
			confirmation_name: environment.name,
			version: environment.version,
			operation_id: crypto.randomUUID(),
		})
		setBusy(false)
		if (!result.success) {
			setError(result.status === 409 ? 'El Entorno conserva tareas o cambió en otra sesión. Vacía el árbol antes de moverlo a Papelera.' : result.error || 'No se pudo mover el Entorno a Papelera.')
			return
		}
		onSaved({ ...environment, deleted_at: new Date().toISOString(), lifecycle: 'trash', version: environment.version + 1 })
		setConfirmTrash(false)
		onClose()
	}

  const canAdmin = creating || taskContainerCanManageStructure(environment)
  const canManageAccess = creating || Boolean(environment?.permissions?.can_manage_access)
  const archiveBlocked = Boolean(environment?.is_default || (!environment?.archived_at && (environment?.open_task_count || 0) > 0))
  const trashBlocked = Boolean(environment?.is_default || (environment?.task_count || 0) > 0)
  const availableUsers = users.filter(user => !grants.some(grant => grant.user_id === user.id))
  const currentGeneralDraft: EnvironmentGeneralDraft = { name, description, color: normalizeTaskHexColor(color, '#6366F1'), icon, visibility, defaultAccess }
  const generalBaseline = generalBaselineRef.current
  const generalDirty = currentGeneralDraft.name !== generalBaseline.name
    || currentGeneralDraft.description !== generalBaseline.description
    || currentGeneralDraft.color !== generalBaseline.color
    || currentGeneralDraft.icon !== generalBaseline.icon
    || currentGeneralDraft.visibility !== generalBaseline.visibility
    || currentGeneralDraft.defaultAccess !== generalBaseline.defaultAccess
  const accessDirty = accessLoaded && environmentAccessDraftKey(grants) !== environmentAccessDraftKey(accessBaselineRef.current)
  const hasPendingChanges = generalDirty || accessDirty

  const settleCloseDecision = useCallback((allowed: boolean) => {
    const resolve = closeDecisionRef.current
    closeDecisionRef.current = null
    closeDecisionPromiseRef.current = null
    resolve?.(allowed)
  }, [])
  const requestClose = useCallback((): Promise<boolean> => {
    if (busy) return Promise.resolve(false)
    if (hasPendingChanges) {
      setDiscardConfirm(true)
      if (!closeDecisionPromiseRef.current) {
        discardReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        closeDecisionPromiseRef.current = new Promise<boolean>(resolve => {
          closeDecisionRef.current = resolve
        })
      }
      return closeDecisionPromiseRef.current
    }
    onClose()
    return Promise.resolve(true)
  }, [busy, hasPendingChanges, onClose])
  useImperativeHandle(forwardedRef, () => ({ requestClose }), [requestClose])

  const discardDrafts = useCallback(() => {
    const baseline = generalBaselineRef.current
    setName(baseline.name)
    setDescription(baseline.description)
    setColor(baseline.color)
    setIcon(baseline.icon)
    setVisibility(baseline.visibility)
    setDefaultAccess(baseline.defaultAccess)
    setGrants(accessBaselineRef.current)
    setSelectedUser('')
    setError('')
    setNotice('')
  }, [])
  const restoreDiscardFocus = useCallback(() => {
    requestAnimationFrame(() => {
      if (discardReturnFocusRef.current?.isConnected) discardReturnFocusRef.current.focus({ preventScroll: true })
    })
  }, [])

  useEffect(() => {
    if (!discardConfirm) return
    const frame = requestAnimationFrame(() => discardContinueRef.current?.focus({ preventScroll: true }))
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setDiscardConfirm(false)
        settleCloseDecision(false)
        restoreDiscardFocus()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(discardDialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || [])
      if (!focusable.length) return
      const index = focusable.indexOf(document.activeElement as HTMLButtonElement)
      event.preventDefault()
      focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus({ preventScroll: true })
      event.stopImmediatePropagation()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [discardConfirm, restoreDiscardFocus, settleCloseDecision])
  useEffect(() => {
    if (open) return
    setDiscardConfirm(false)
    settleCloseDecision(false)
  }, [open, settleCloseDecision])
  useEffect(() => () => settleCloseDecision(false), [settleCloseDecision])

  const requestOpenStructure = useCallback(async () => {
    if (!await requestClose()) return
    onOpenStructure()
  }, [onOpenStructure, requestClose])

  return <>
    <TaskWorkWindowShell
      open={open}
      storageKey="clarin:tasks:environment-window"
      storageScope={storageScope}
      title={creating ? 'Nuevo Entorno' : environment?.name || 'Entorno'}
      eyebrow={creating ? 'Crear Entorno de trabajo' : 'Configurar Entorno'}
      description={creating ? 'Se creará con un flujo predeterminado y una Bandeja general privada.' : 'Estructura, flujos y permisos dentro de la misma cuenta.'}
      icon={Layers3}
      defaultWidth={980}
      defaultHeight={820}
      minWidth={620}
      minHeight={560}
      busy={busy}
      onRequestClose={() => { void requestClose() }}
      contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      dataAttribute="task-environment-window"
      footer={<div className="flex items-center gap-3">
        <div className="min-w-0 flex-1" aria-live="polite">{error ? <p className="truncate text-xs font-semibold text-rose-700">{error}</p> : notice ? <p className="flex items-center gap-1.5 truncate text-xs font-semibold text-emerald-700"><Check className="h-3.5 w-3.5" />{notice}</p> : <p className="text-xs text-slate-400">Los permisos se validan nuevamente en el servidor.</p>}</div>
        <button type="button" disabled={busy} onClick={() => { void requestClose() }} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-white disabled:opacity-40">Cerrar</button>
        {tab === 'general' && <button type="button" disabled={busy || !canAdmin} onClick={() => void saveGeneral()} className="flex min-w-32 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-slate-200 hover:bg-slate-800 disabled:opacity-35">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{creating ? 'Crear Entorno' : 'Guardar'}</button>}
        {tab === 'access' && !creating && <button type="button" disabled={busy || accessLoading || !canManageAccess} onClick={() => void saveAccess()} className="flex min-w-32 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-slate-200 hover:bg-slate-800 disabled:opacity-35">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}Guardar acceso</button>}
      </div>}
    >
      {!creating && <div className="shrink-0 overflow-x-auto border-b border-slate-100 bg-slate-50/70 px-4 py-2 [scrollbar-width:none] sm:px-6">
        <div role="tablist" aria-label="Configuración del Entorno" className="flex min-w-max gap-1 rounded-2xl bg-slate-100 p-1">
          {tabs.map(item => {
            const Icon = item.icon
            const disabled = item.id === 'access' ? !canManageAccess : !canAdmin
            return <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} disabled={disabled} onClick={() => { setTab(item.id); setError(''); setNotice('') }} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-35 ${tab === item.id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Icon className="h-3.5 w-3.5" />{item.label}</button>
          })}
        </div>
      </div>}

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {tab === 'general' && <div className="mx-auto max-w-3xl space-y-6">
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-start gap-4"><span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-sm" style={{ backgroundColor: color }}><TaskContainerIcon value={icon} className="h-5 w-5" /></span><div><h3 className="text-base font-black text-slate-900">Identidad del Entorno</h3><p className="mt-1 text-xs leading-5 text-slate-400">Un nombre claro permite reconocer el límite de trabajo y acceso.</p></div></div>
            <label className="mt-5 block text-xs font-bold text-slate-600">Nombre<input autoFocus={creating} value={name} maxLength={120} disabled={!canAdmin} onChange={event => setName(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm font-semibold text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100 disabled:bg-slate-50" /></label>
            <label className="mt-4 block text-xs font-bold text-slate-600">Descripción<textarea value={description} disabled={!canAdmin} onChange={event => setDescription(event.target.value)} rows={3} className="mt-2 w-full resize-y rounded-xl border border-slate-200 px-3.5 py-3 text-sm leading-6 text-slate-700 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100 disabled:bg-slate-50" /></label>
            <div className="mt-4 grid gap-3 sm:grid-cols-2"><TaskColorPicker value={color} onChange={setColor} label="Color del Entorno" disabled={!canAdmin} /><TaskIconPicker value={icon} onChange={setIcon} label="Icono del Entorno" disabled={!canAdmin} /></div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><h3 className="text-sm font-black text-slate-900">Privacidad predeterminada</h3><p className="mt-1 text-xs leading-5 text-slate-400">Los Entornos nuevos son privados. El acceso específico siempre puede subir, reducir o negar el nivel predeterminado.</p><div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button type="button" disabled={!canManageAccess || environment?.is_default} onClick={() => { setVisibility('restricted'); setDefaultAccess('none') }} className={`rounded-2xl border p-4 text-left transition disabled:opacity-40 ${visibility === 'restricted' ? 'border-violet-300 bg-violet-50 ring-2 ring-violet-100' : 'border-slate-200 hover:border-slate-300'}`}><span className="flex items-center gap-2 text-sm font-black text-slate-800"><LockKeyhole className="h-4 w-4 text-violet-600" />Privado</span><span className="mt-1.5 block text-xs leading-5 text-slate-500">Solo personas con concesión explícita. El creador conserva Administrar.</span></button>
            <button type="button" disabled={!canManageAccess || environment?.is_default} onClick={() => { setVisibility('account'); if (defaultAccess === 'none') setDefaultAccess('view') }} className={`rounded-2xl border p-4 text-left transition disabled:opacity-40 ${visibility === 'account' ? 'border-emerald-300 bg-emerald-50 ring-2 ring-emerald-100' : 'border-slate-200 hover:border-slate-300'}`}><span className="flex items-center gap-2 text-sm font-black text-slate-800"><Globe2 className="h-4 w-4 text-emerald-600" />Visible en la cuenta</span><span className="mt-1.5 block text-xs leading-5 text-slate-500">Las personas con Clarin Work reciben el nivel predeterminado seleccionado.</span></button>
          </div>{visibility === 'account' && <div className="mt-4"><label className="mb-2 block text-xs font-bold text-slate-600">Nivel predeterminado</label><TaskSelectPicker value={defaultAccess} options={accessOptions.filter(item => item.value !== 'none')} onChange={value => setDefaultAccess(value as TaskAccessLevel)} label="Nivel predeterminado del Entorno" disabled={!canManageAccess || environment?.is_default} /></div>}{!canManageAccess && !environment?.is_default && <p className="mt-4 rounded-xl bg-violet-50 px-3 py-2.5 text-xs leading-5 text-violet-700">Tienes Administrar para la estructura, pero la privacidad requiere la capacidad delegada de gestionar acceso.</p>}{environment?.is_default && <p className="mt-4 rounded-xl bg-blue-50 px-3 py-2.5 text-xs leading-5 text-blue-700">General conserva el acceso funcional migrado. Solo administradores gestionan su ACL hasta delegarlo explícitamente.</p>}</section>
        </div>}

        {tab === 'structure' && <div className="mx-auto max-w-4xl space-y-5"><div className="grid gap-3 sm:grid-cols-3">{[
          { label: 'Carpetas', value: environment?.folder_count ?? selectedEnvironmentFolders.length, icon: FolderTree },
          { label: 'Listas', value: environment?.list_count ?? selectedEnvironmentLists.length, icon: Boxes },
          { label: 'Tareas activas', value: environment?.task_count || 0, icon: Check },
        ].map(item => <div key={item.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><item.icon className="h-5 w-5 text-emerald-600" /><p className="mt-4 text-2xl font-black text-slate-900">{item.value}</p><p className="mt-1 text-xs font-semibold text-slate-400">{item.label}</p></div>)}</div><section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><h3 className="text-base font-black text-slate-900">Carpetas y listas del Entorno</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Las carpetas y listas permanecen dentro de este Entorno y heredan sus permisos. La Bandeja general permanece fija en la raíz.</p><button type="button" disabled={!canAdmin} onClick={() => { void requestOpenStructure() }} className="mt-5 flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-35"><FolderTree className="h-4 w-4" />Administrar estructura</button></section></div>}

        {tab === 'workflows' && <div className="mx-auto max-w-4xl space-y-3">{selectedEnvironmentWorkflows.map(workflow => <section key={workflow.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-700"><Workflow className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-black text-slate-800">{workflow.name}</p><p className="mt-0.5 text-[11px] text-slate-400">{workflow.statuses?.length || 0} estados{workflow.is_default ? ' · predeterminado' : ''}</p></div></div><div className="mt-4 flex flex-wrap gap-2">{(workflow.statuses || []).sort((left, right) => left.sort_order - right.sort_order).map(status => <span key={status.id} className="flex items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] font-bold text-slate-600"><i className="h-2 w-2 rounded-full" style={{ backgroundColor: status.color }} />{status.name}</span>)}</div></section>)}{!selectedEnvironmentWorkflows.length && <div className="rounded-3xl border border-dashed border-slate-300 py-16 text-center"><Workflow className="mx-auto h-7 w-7 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">No hay flujos disponibles.</p></div>}<button type="button" disabled={!canAdmin} onClick={() => { void requestOpenStructure() }} className="flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-35"><Workflow className="h-4 w-4" />Configurar flujos</button></div>}

        {tab === 'access' && <div className="mx-auto max-w-4xl space-y-5">
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><ShieldCheck className="h-5 w-5" /></span><div><h3 className="text-base font-black text-slate-900">Acceso explícito</h3><p className="mt-1 text-xs leading-5 text-slate-400">Administrar acceso es una capacidad de gobernanza y requiere nivel Administrar. Los administradores de cuenta mantienen recuperación total.</p></div></div>
            {accessLoading ? <div className="mt-6 space-y-2">{Array.from({ length: 3 }, (_, index) => <div key={index} className="h-16 animate-pulse rounded-2xl bg-slate-100" />)}</div> : <>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row"><TaskUserCombobox users={availableUsers} value={selectedUser} onChange={setSelectedUser} placeholder="Añadir una persona" disabled={!canManageAccess} /><button type="button" disabled={!selectedUser || !canManageAccess} onClick={addGrant} className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-black text-white disabled:opacity-35"><Plus className="h-3.5 w-3.5" />Añadir</button></div>
              <div className="mt-5 space-y-2">{grants.map(grant => {
                const user = users.find(item => item.id === grant.user_id)
                return <div key={grant.user_id} className="grid gap-3 rounded-2xl border border-slate-200 p-3 sm:grid-cols-[minmax(180px,1fr)_minmax(230px,0.8fr)_auto_auto] sm:items-center"><div className="flex min-w-0 items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-black text-slate-600">{userName(user, grant).slice(0, 2).toUpperCase()}</span><span className="min-w-0"><span className="block truncate text-sm font-bold text-slate-700">{userName(user, grant)}</span><span className="block truncate text-[10px] text-slate-400">@{grant.username || user?.username || 'usuario'}</span></span></div><TaskSelectPicker value={grant.access_level} options={accessOptions} onChange={value => updateGrant(grant.user_id, { access_level: value as TaskAccessLevel, can_manage_access: value === 'full' ? grant.can_manage_access : false })} label={`Nivel de ${userName(user, grant)}`} disabled={!canManageAccess} className="min-h-10" /><label className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold ${grant.access_level === 'full' ? 'bg-violet-50 text-violet-700' : 'bg-slate-50 text-slate-300'}`}><input type="checkbox" checked={grant.can_manage_access} disabled={!canManageAccess || grant.access_level !== 'full'} onChange={event => updateGrant(grant.user_id, { can_manage_access: event.target.checked })} className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-200" />Gestiona acceso</label><button type="button" disabled={!canManageAccess} aria-label={`Quitar acceso de ${userName(user, grant)}`} onClick={() => setGrants(current => current.filter(item => item.user_id !== grant.user_id))} className="justify-self-end rounded-xl p-2 text-slate-300 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-35"><X className="h-4 w-4" /></button></div>
              })}{!grants.length && <div className="rounded-2xl border border-dashed border-slate-300 py-10 text-center"><UserRound className="mx-auto h-6 w-6 text-slate-300" /><p className="mt-2 text-xs text-slate-400">No hay concesiones explícitas.</p></div>}</div>
            </>}
          </section>
          <div className="rounded-2xl bg-slate-900 p-5 text-white"><p className="text-xs font-black uppercase tracking-[.16em] text-emerald-300">Resolución efectiva</p><p className="mt-2 text-sm leading-6 text-slate-300">Administrador de cuenta → tarea → lista → carpeta → Entorno. Ver el Entorno es siempre el requisito mínimo y la UI nunca infiere capacidades.</p></div>
        </div>}

        {tab === 'archive' && environment && <div className="mx-auto max-w-3xl space-y-4"><section className={`rounded-3xl border p-6 shadow-sm ${environment.archived_at ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-white'}`}><span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${environment.archived_at ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{environment.archived_at ? <RotateCcw className="h-5 w-5" /> : <Archive className="h-5 w-5" />}</span><h3 className="mt-4 text-lg font-black text-slate-900">{environment.archived_at ? 'Restaurar Entorno' : 'Archivar como histórico'}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{environment.archived_at ? 'Restaurar devuelve el Entorno al trabajo activo y conserva exactamente el estado propio de sus carpetas y listas.' : 'Archivar conserva la estructura y las tareas completadas o canceladas como histórico consultable en modo solo lectura.'}</p>{environment.is_default && <p className="mt-4 rounded-xl bg-blue-50 px-3 py-2.5 text-xs font-semibold text-blue-700">General es el Entorno de compatibilidad de la cuenta y no puede archivarse.</p>}{!environment.archived_at && environment.open_task_count > 0 && <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-800">Quedan {environment.open_task_count} tarea{environment.open_task_count === 1 ? '' : 's'} abierta{environment.open_task_count === 1 ? '' : 's'}. Complétalas o cancélalas primero.</p>}<button type="button" disabled={busy || archiveBlocked || !canAdmin} onClick={() => environment.archived_at ? void archiveOrRestore() : setConfirmArchive(true)} className={`mt-5 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black text-white disabled:opacity-35 ${environment.archived_at ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-600 hover:bg-amber-700'}`}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : environment.archived_at ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}{environment.archived_at ? 'Restaurar Entorno' : 'Archivar'}</button></section><section className="rounded-3xl border border-rose-100 bg-rose-50/50 p-6"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-100 text-rose-700"><Trash2 className="h-5 w-5" /></span><h3 className="mt-4 text-lg font-black text-slate-900">Mover a Papelera</h3><p className="mt-2 text-sm leading-6 text-slate-600">Inicia la retención y habilita restauración o eliminación permanente. Solo está disponible cuando el Entorno no conserva ninguna tarea, aunque esté completada.</p>{environment.task_count > 0 && <p className="mt-4 rounded-xl bg-white px-3 py-2.5 text-xs font-semibold text-rose-700">El árbol conserva {environment.task_count} tarea{environment.task_count === 1 ? '' : 's'}.</p>}<button type="button" disabled={busy || trashBlocked || !canAdmin} onClick={() => setConfirmTrash(true)} className="mt-5 flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-black text-white hover:bg-rose-700 disabled:opacity-35"><Trash2 className="h-4 w-4" />Mover a Papelera</button></section></div>}
      </div>
    </TaskWorkWindowShell>

    <TaskDestructiveConfirmDialog
      open={confirmArchive}
      title="Archivar Entorno"
      description={`“${environment?.name || ''}” dejará de aparecer en la navegación activa. Su estructura y sus permisos se conservarán.`}
      actionLabel="Archivar"
      busy={busy}
      error={error}
      onClose={() => { if (!busy) setConfirmArchive(false) }}
      onConfirm={() => void archiveOrRestore()}
    />
    <TaskDestructiveConfirmDialog
      open={confirmTrash}
      title="Mover Entorno a Papelera"
      description={`“${environment?.name || ''}” y su estructura vacía iniciarán la retención. Si estaba archivado, restaurarlo desde Papelera lo devolverá al Archivo histórico.`}
      actionLabel="Mover a Papelera"
      confirmationName={!trashBlocked ? environment?.name : undefined}
      blockedReason={trashBlocked ? (environment?.is_default ? 'General debe permanecer activo.' : 'El Entorno todavía conserva tareas.') : undefined}
      busy={busy}
      error={error}
      onClose={() => { if (!busy) setConfirmTrash(false) }}
      onConfirm={() => void moveToTrash()}
    />
    {discardConfirm && createPortal(<div data-task-destructive-dialog className="fixed inset-0 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }} role="presentation"><div ref={discardDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="task-environment-discard-title" aria-describedby="task-environment-discard-description" className="w-full max-w-md rounded-3xl border border-white/70 bg-white p-6 shadow-2xl"><p className="text-[10px] font-black uppercase tracking-[.16em] text-amber-600">Cambios pendientes</p><h2 id="task-environment-discard-title" className="mt-1 text-xl font-black text-slate-900">¿Descartar cambios del Entorno?</h2><p id="task-environment-discard-description" className="mt-2 text-sm leading-6 text-slate-500">La identidad, privacidad o configuración de acceso que todavía no guardaste se perderá.</p><div className="mt-6 flex justify-end gap-2"><button ref={discardContinueRef} type="button" onClick={() => { setDiscardConfirm(false); settleCloseDecision(false); restoreDiscardFocus() }} className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100">Seguir editando</button><button type="button" onClick={() => { setDiscardConfirm(false); discardDrafts(); onClose(); settleCloseDecision(true) }} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-black text-white hover:bg-rose-700">Descartar cambios</button></div></div></div>, document.body)}
  </>
})

export default TaskEnvironmentWindow
