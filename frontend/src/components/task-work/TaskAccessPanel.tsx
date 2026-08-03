'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Eye, FileLock2, Loader2, LockKeyhole, MessageCircle, Pencil, Plus, ShieldCheck, UserRound, X } from 'lucide-react'
import { apiGet, apiPut } from '@/lib/api'
import type { Task, TaskAccessGrant, TaskAccessLevel } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import { TaskSelectPicker, type TaskSelectOption } from './TaskSelectPicker'
import TaskUserCombobox from './TaskUserCombobox'
import { normalizeTaskAccessGrants, TASK_ACCESS_LEVELS, taskAccessLabel, validatePrivateAccessManagers } from './taskEnvironmentAccess'
import { eligibleContainerAccessUsers, taskContainerAccessSaveError } from './taskContainerAccess'

type AccessResponse = {
  access_mode: 'inherit' | 'private'
  access_revision: number
  grants: TaskAccessGrant[]
  task?: Task
  operation_id?: string
  eligible_user_ids?: string[]
}

const accessIcons = {
  none: <FileLock2 className="h-4 w-4" />,
  view: <Eye className="h-4 w-4" />,
  comment: <MessageCircle className="h-4 w-4" />,
  edit: <Pencil className="h-4 w-4" />,
  full: <ShieldCheck className="h-4 w-4" />,
} satisfies Record<TaskAccessLevel, React.ReactNode>

const options: TaskSelectOption[] = TASK_ACCESS_LEVELS.map(item => ({
  value: item.value,
  label: item.label,
  description: item.description,
  leading: accessIcons[item.value],
}))

interface Props {
  task: Task
  users: TaskAccountUser[]
  onChanged?: (task?: Task, operationID?: string) => void
}

function displayName(user?: TaskAccountUser, grant?: TaskAccessGrant) {
  return grant?.display_name || user?.display_name || grant?.username || user?.username || 'Usuario'
}

export default function TaskAccessPanel({ task, users, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<'inherit' | 'private'>(task.access_mode || 'inherit')
  const [revision, setRevision] = useState(1)
  const [grants, setGrants] = useState<TaskAccessGrant[]>([])
  const [eligibleUserIDs, setEligibleUserIDs] = useState<string[]>([])
  const [selectedUser, setSelectedUser] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    setOpen(false)
    setLoaded(false)
    setLoading(false)
    setSaving(false)
    setMode(task.access_mode || 'inherit')
    setRevision(1)
    setGrants([])
    setEligibleUserIDs([])
    setSelectedUser('')
    setError('')
    setNotice('')
  }, [task.id])

  const load = async () => {
    if (task.parent_task_id || !task.permissions?.can_manage_access) return
    setLoading(true)
    setError('')
    const result = await apiGet<AccessResponse>(`/api/tasks/${task.id}/access`)
    setLoading(false)
    if (!result.success) {
      setError(result.error || 'No se pudo cargar el acceso de la tarea.')
      return
    }
    setMode(result.data?.access_mode || task.access_mode || 'inherit')
    setRevision(result.data?.access_revision || 1)
    setGrants(normalizeTaskAccessGrants(result.data?.grants || []))
    setEligibleUserIDs(result.data?.eligible_user_ids || [])
    setLoaded(true)
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !loaded && !loading) void load()
  }

  const updateGrant = (userID: string, patch: Partial<TaskAccessGrant>) => {
    setGrants(current => normalizeTaskAccessGrants(current.map(grant => grant.user_id === userID ? { ...grant, ...patch } : grant)))
  }

  const availableUsers = useMemo(
    () => eligibleContainerAccessUsers(users, eligibleUserIDs, grants),
    [eligibleUserIDs, grants, users],
  )

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

  const save = async () => {
    const canonical = normalizeTaskAccessGrants(grants)
    const validation = validatePrivateAccessManagers(mode === 'private', canonical)
    if (validation) {
      setError(validation)
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    const operationID = crypto.randomUUID()
    const result = await apiPut<AccessResponse>(`/api/tasks/${task.id}/access`, {
      access_mode: mode,
      expected_access_revision: revision,
      grants: canonical.map(({ user_id, access_level, can_manage_access }) => ({ user_id, access_level, can_manage_access })),
      operation_id: operationID,
    })
    setSaving(false)
    if (!result.success) {
      setError(taskContainerAccessSaveError(result.status, result.error || 'No se pudo guardar el acceso.'))
      return
    }
    setMode(result.data?.access_mode || mode)
    setRevision(result.data?.access_revision || revision + 1)
    setGrants(normalizeTaskAccessGrants(result.data?.grants || canonical))
    setNotice('Acceso actualizado.')
    onChanged?.(result.data?.task, result.data?.operation_id || operationID)
  }

  if (task.parent_task_id) return <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
    <div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-slate-500 shadow-sm"><LockKeyhole className="h-4 w-4" /></span><div><h3 className="text-sm font-bold text-slate-800">Acceso heredado</h3><p className="mt-1 text-xs leading-5 text-slate-400">Esta subtarea hereda siempre la privacidad y las concesiones de su tarea principal.</p></div></div>
  </section>

  const canManage = Boolean(task.permissions?.can_manage_access)
  const displayedMode = loaded ? mode : task.access_mode || 'inherit'
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
    <button type="button" aria-expanded={open} onClick={toggle} className="flex w-full items-center gap-3 p-4 text-left hover:bg-slate-50">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${displayedMode === 'private' ? 'bg-violet-50 text-violet-700' : 'bg-emerald-50 text-emerald-700'}`}>{displayedMode === 'private' ? <LockKeyhole className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}</span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-bold text-slate-800">Privacidad y acceso</span><span className="mt-0.5 block truncate text-[11px] text-slate-400">{displayedMode === 'private' ? 'Privada' : 'Hereda del Entorno'} · {taskAccessLabel(task.permissions?.level || task.effective_access_level)}</span></span>
      {!canManage && <span className="rounded-lg bg-slate-100 px-2 py-1 text-[9px] font-bold text-slate-500">Solo lectura</span>}
      <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className="border-t border-slate-100 bg-slate-50/60 p-4">
      {!canManage ? <p className="text-xs leading-5 text-slate-500">Tu acceso efectivo es <strong>{taskAccessLabel(task.permissions?.level || task.effective_access_level)}</strong>. Solo una persona con Administrar y gestión de acceso puede cambiar estas reglas.</p> : loading ? <div className="space-y-2">{Array.from({ length: 3 }, (_, index) => <div key={index} className="h-14 animate-pulse rounded-xl bg-slate-200/60" />)}</div> : <>
        <div className="grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => setMode('inherit')} className={`rounded-xl border p-3 text-left ${mode === 'inherit' ? 'border-emerald-300 bg-emerald-50 ring-2 ring-emerald-100' : 'border-slate-200 bg-white'}`}><span className="flex items-center gap-2 text-xs font-black text-slate-700"><ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />Heredar Entorno</span><span className="mt-1 block text-[10px] leading-4 text-slate-400">Usa el Entorno salvo una concesión específica.</span></button><button type="button" onClick={() => setMode('private')} className={`rounded-xl border p-3 text-left ${mode === 'private' ? 'border-violet-300 bg-violet-50 ring-2 ring-violet-100' : 'border-slate-200 bg-white'}`}><span className="flex items-center gap-2 text-xs font-black text-slate-700"><LockKeyhole className="h-3.5 w-3.5 text-violet-600" />Privada</span><span className="mt-1 block text-[10px] leading-4 text-slate-400">Niega la herencia y conserva solo grants directos.</span></button></div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row"><TaskUserCombobox users={availableUsers} value={selectedUser} onChange={setSelectedUser} placeholder="Compartir con una persona" /><button type="button" disabled={!selectedUser} onClick={addGrant} className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-black text-white disabled:opacity-35"><Plus className="h-3.5 w-3.5" />Añadir</button></div>
        <div className="mt-3 space-y-2">{grants.map(grant => {
          const user = users.find(item => item.id === grant.user_id)
          const name = displayName(user, grant)
          return <div key={grant.user_id} className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-[minmax(140px,1fr)_minmax(220px,1fr)_auto_auto] sm:items-center"><div className="flex min-w-0 items-center gap-2"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[9px] font-black text-slate-600">{name.slice(0, 2).toUpperCase()}</span><span className="min-w-0 truncate text-xs font-bold text-slate-700">{name}</span></div><TaskSelectPicker value={grant.access_level} options={options} onChange={value => updateGrant(grant.user_id, { access_level: value as TaskAccessLevel, can_manage_access: value === 'full' ? grant.can_manage_access : false })} label={`Nivel de ${name}`} /><label className={`flex items-center gap-1.5 rounded-lg px-2 py-2 text-[10px] font-bold ${grant.access_level === 'full' ? 'bg-violet-50 text-violet-700' : 'bg-slate-50 text-slate-300'}`}><input type="checkbox" checked={grant.can_manage_access} disabled={grant.access_level !== 'full'} onChange={event => updateGrant(grant.user_id, { can_manage_access: event.target.checked })} />Gestiona</label><button type="button" aria-label={`Quitar acceso de ${name}`} onClick={() => setGrants(current => current.filter(item => item.user_id !== grant.user_id))} className="justify-self-end rounded-lg p-2 text-slate-300 hover:bg-rose-50 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button></div>
        })}{loaded && !grants.length && <div className="rounded-xl border border-dashed border-slate-300 py-7 text-center"><UserRound className="mx-auto h-5 w-5 text-slate-300" /><p className="mt-2 text-[11px] text-slate-400">Sin concesiones directas.</p></div>}</div>
        {error && <div role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{error}{!loaded && <button type="button" onClick={() => void load()} className="ml-2 underline">Reintentar</button>}</div>}
        {notice && <p role="status" className="mt-3 text-xs font-semibold text-emerald-700">{notice}</p>}
        <div className="mt-4 flex justify-end"><button type="button" disabled={saving || !loaded} onClick={() => void save()} className="flex min-w-36 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-black text-white disabled:opacity-35">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}Guardar acceso</button></div>
      </>}
    </div>}
  </section>
}
