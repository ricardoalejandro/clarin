'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Archive, Boxes, Check, Eye, FileLock2, FolderTree, Globe2, Layers3, Loader2,
  LockKeyhole, MessageCircle, Pencil, Plus, RotateCcw, Save, ShieldCheck, Trash2, UserRound, Workflow, X,
} from 'lucide-react'
import { api, apiGet, apiPost, apiPut } from '@/lib/api'
import type { TaskAccessGrant, TaskAccessLevel, TaskEnvironment, TaskFolder, TaskList, TaskWorkflow } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import { TaskColorPicker, TaskContainerIcon, TaskIconPicker, normalizeTaskHexColor } from './TaskContainerAppearance'
import TaskDestructiveConfirmDialog from './TaskDestructiveConfirmDialog'
import { TaskSelectPicker, type TaskSelectOption } from './TaskSelectPicker'
import TaskUserCombobox from './TaskUserCombobox'
import TaskWorkWindowShell from './TaskWorkWindowShell'
import { normalizeTaskAccessGrants, TASK_ACCESS_LEVELS, taskAccessLabel, validatePrivateAccessManagers } from './taskEnvironmentAccess'
import { taskEnvironmentSaveError } from './taskEnvironmentErrors'

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

function userName(user?: TaskAccountUser, grant?: TaskAccessGrant) {
  return grant?.display_name || user?.display_name || grant?.username || user?.username || 'Usuario'
}

export default function TaskEnvironmentWindow({
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
}: Props) {
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

  useEffect(() => {
    if (!open) return
    setTab(environment?.archived_at ? 'archive' : 'general')
    setName(environment?.name || '')
    setDescription(environment?.description || '')
    setColor(normalizeTaskHexColor(environment?.color || '#6366F1', '#6366F1'))
    setIcon(environment?.icon || 'layers')
    setVisibility(environment?.visibility || 'restricted')
    setDefaultAccess(environment?.default_access_level || 'none')
    setGrants([])
    setAccessRevision(environment?.access_revision || 1)
    setSelectedUser('')
    setAccessLoaded(false)
    setAccessLoading(false)
    setBusy(false)
    setError('')
    setNotice('')
    setConfirmArchive(false)
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
    setGrants(normalizeTaskAccessGrants(result.data?.grants || []))
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
    setGrants(normalizeTaskAccessGrants(result.data?.grants || canonical))
    setAccessRevision(result.data?.access_revision || accessRevision + 1)
    if (result.data?.environment) onSaved(result.data.environment)
    setNotice('Acceso actualizado y reconciliado con el servidor.')
  }

  const archiveOrRestore = async () => {
    if (!environment) return
    setBusy(true)
    setError('')
    const action = environment.archived_at ? 'restore' : 'archive'
    const result = await apiPost<EnvironmentResponse>(`/api/tasks/environments/${environment.id}/${action}`, {
      version: environment.version,
      operation_id: crypto.randomUUID(),
    })
    setBusy(false)
    if (!result.success || !result.data?.environment) {
      setError(result.status === 409 ? 'Este Entorno tiene tareas activas o cambió en otra sesión. Mueve o envía esas tareas a Papelera antes de archivarlo.' : result.error || `No se pudo ${action === 'archive' ? 'archivar' : 'restaurar'} el Entorno.`)
      return
    }
    onSaved(result.data.environment)
    setConfirmArchive(false)
    setNotice(action === 'archive' ? 'Entorno archivado.' : 'Entorno restaurado.')
  }

  const canAdmin = creating || Boolean(environment?.permissions?.can_delete)
  const canManageAccess = creating || Boolean(environment?.permissions?.can_manage_access)
  const archiveBlocked = Boolean(environment?.is_default || (!environment?.archived_at && (environment?.task_count || 0) > 0))
  const availableUsers = users.filter(user => !grants.some(grant => grant.user_id === user.id))

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
      onRequestClose={onClose}
      contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      dataAttribute="task-environment-window"
      footer={<div className="flex items-center gap-3">
        <div className="min-w-0 flex-1" aria-live="polite">{error ? <p className="truncate text-xs font-semibold text-rose-700">{error}</p> : notice ? <p className="flex items-center gap-1.5 truncate text-xs font-semibold text-emerald-700"><Check className="h-3.5 w-3.5" />{notice}</p> : <p className="text-xs text-slate-400">Los permisos se validan nuevamente en el servidor.</p>}</div>
        <button type="button" disabled={busy} onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-white disabled:opacity-40">Cerrar</button>
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
        ].map(item => <div key={item.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><item.icon className="h-5 w-5 text-emerald-600" /><p className="mt-4 text-2xl font-black text-slate-900">{item.value}</p><p className="mt-1 text-xs font-semibold text-slate-400">{item.label}</p></div>)}</div><section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><h3 className="text-base font-black text-slate-900">Carpetas y listas del Entorno</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Las carpetas y listas permanecen dentro de este Entorno y heredan sus permisos. La Bandeja general permanece fija en la raíz.</p><button type="button" disabled={!environment?.permissions?.can_delete} onClick={onOpenStructure} className="mt-5 flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-35"><FolderTree className="h-4 w-4" />Administrar estructura</button></section></div>}

        {tab === 'workflows' && <div className="mx-auto max-w-4xl space-y-3">{selectedEnvironmentWorkflows.map(workflow => <section key={workflow.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-700"><Workflow className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-black text-slate-800">{workflow.name}</p><p className="mt-0.5 text-[11px] text-slate-400">{workflow.statuses?.length || 0} estados{workflow.is_default ? ' · predeterminado' : ''}</p></div></div><div className="mt-4 flex flex-wrap gap-2">{(workflow.statuses || []).sort((left, right) => left.sort_order - right.sort_order).map(status => <span key={status.id} className="flex items-center gap-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] font-bold text-slate-600"><i className="h-2 w-2 rounded-full" style={{ backgroundColor: status.color }} />{status.name}</span>)}</div></section>)}{!selectedEnvironmentWorkflows.length && <div className="rounded-3xl border border-dashed border-slate-300 py-16 text-center"><Workflow className="mx-auto h-7 w-7 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">No hay flujos disponibles.</p></div>}<button type="button" disabled={!environment?.permissions?.can_delete} onClick={onOpenStructure} className="flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-35"><Workflow className="h-4 w-4" />Configurar flujos</button></div>}

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

        {tab === 'archive' && environment && <div className="mx-auto max-w-3xl"><section className={`rounded-3xl border p-6 shadow-sm ${environment.archived_at ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-white'}`}><span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${environment.archived_at ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{environment.archived_at ? <RotateCcw className="h-5 w-5" /> : <Archive className="h-5 w-5" />}</span><h3 className="mt-4 text-lg font-black text-slate-900">{environment.archived_at ? 'Restaurar Entorno' : 'Archivar Entorno'}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{environment.archived_at ? 'Restaurar recupera la estructura y el acceso, sin crear ni mover tareas.' : 'Para proteger el trabajo, no se puede archivar un Entorno mientras tenga tareas activas. Primero muévelas a otro Entorno o envíalas a Papelera.'}</p>{environment.is_default && <p className="mt-4 rounded-xl bg-blue-50 px-3 py-2.5 text-xs font-semibold text-blue-700">General es el Entorno de compatibilidad de la cuenta y no puede archivarse.</p>}{!environment.archived_at && environment.task_count > 0 && <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-800">Quedan {environment.task_count} tarea{environment.task_count === 1 ? '' : 's'} activa{environment.task_count === 1 ? '' : 's'}.</p>}<button type="button" disabled={busy || archiveBlocked || !canAdmin} onClick={() => environment.archived_at ? void archiveOrRestore() : setConfirmArchive(true)} className={`mt-5 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black text-white disabled:opacity-35 ${environment.archived_at ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-600 hover:bg-amber-700'}`}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : environment.archived_at ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}{environment.archived_at ? 'Restaurar Entorno' : 'Archivar Entorno'}</button></section><div className="mt-4 flex gap-3 rounded-2xl border border-rose-100 bg-rose-50/60 p-4"><Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" /><p className="text-xs leading-5 text-rose-700">Archivar no elimina tareas, historiales ni archivos. La eliminación permanente continúa siendo una operación administrativa separada y sujeta a retención.</p></div></div>}
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
  </>
}
