'use client'

import { useEffect, useMemo, useState } from 'react'
import { Eye, FileLock2, Loader2, LockKeyhole, MessageCircle, Pencil, Plus, ShieldCheck, X } from 'lucide-react'
import { apiGet, apiPut } from '@/lib/api'
import type { TaskAccessGrant, TaskAccessLevel, TaskFolder, TaskList } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import { TaskSelectPicker, type TaskSelectOption } from './TaskSelectPicker'
import TaskUserCombobox from './TaskUserCombobox'
import { normalizeTaskAccessGrants, TASK_ACCESS_LEVELS, validatePrivateAccessManagers } from './taskEnvironmentAccess'
import { eligibleContainerAccessUsers, taskContainerAccessSaveError } from './taskContainerAccess'

type Response = {
  access_mode: 'inherit' | 'private'
  access_revision: number
  grants: TaskAccessGrant[]
  eligible_user_ids?: string[]
}

const icons = {
  none: <FileLock2 className="h-4 w-4" />, view: <Eye className="h-4 w-4" />,
  comment: <MessageCircle className="h-4 w-4" />, edit: <Pencil className="h-4 w-4" />,
  full: <ShieldCheck className="h-4 w-4" />,
} satisfies Record<TaskAccessLevel, React.ReactNode>
const options: TaskSelectOption[] = TASK_ACCESS_LEVELS.map(item => ({ value: item.value, label: item.label, description: item.description, leading: icons[item.value] }))

export default function TaskContainerAccessPanel({ item, type, users, onChanged }: {
  item: TaskFolder | TaskList
  type: 'folder' | 'list'
  users: TaskAccountUser[]
  onChanged: () => Promise<void> | void
}) {
  const [mode, setMode] = useState<'inherit' | 'private'>(item.access_mode || 'inherit')
  const [revision, setRevision] = useState(item.access_revision || 1)
  const [grants, setGrants] = useState<TaskAccessGrant[]>([])
  const [eligibleIDs, setEligibleIDs] = useState<string[]>([])
  const [selectedUser, setSelectedUser] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const endpoint = `/api/tasks/${type === 'folder' ? 'folders' : 'lists'}/${item.id}/access`

  const load = async () => {
    setLoading(true); setError('')
    const result = await apiGet<Response>(endpoint)
    setLoading(false)
    if (!result.success) { setError(result.error || 'No se pudo cargar el acceso.'); return }
    setMode(result.data?.access_mode || item.access_mode || 'inherit')
    setRevision(result.data?.access_revision || item.access_revision || 1)
    setGrants(normalizeTaskAccessGrants(result.data?.grants || []))
    setEligibleIDs(result.data?.eligible_user_ids || [])
  }

  useEffect(() => { void load() }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const availableUsers = useMemo(() => {
    return eligibleContainerAccessUsers(users, eligibleIDs, grants)
  }, [eligibleIDs, grants, users])

  const updateGrant = (userID: string, patch: Partial<TaskAccessGrant>) => setGrants(current => normalizeTaskAccessGrants(current.map(grant => grant.user_id === userID ? { ...grant, ...patch } : grant)))
  const addGrant = () => {
    const user = users.find(candidate => candidate.id === selectedUser)
    if (!user) return
    setGrants(current => normalizeTaskAccessGrants([...current, { user_id: user.id, display_name: user.display_name, username: user.username, access_level: 'view', can_manage_access: false }]))
    setSelectedUser('')
  }
  const save = async () => {
    const canonical = normalizeTaskAccessGrants(grants)
    const validation = validatePrivateAccessManagers(mode === 'private', canonical)
    if (validation) { setError(validation); return }
    setSaving(true); setError(''); setNotice('')
    const result = await apiPut<Response>(endpoint, {
      access_mode: mode, expected_access_revision: revision,
      grants: canonical.map(({ user_id, access_level, can_manage_access }) => ({ user_id, access_level, can_manage_access })),
      operation_id: crypto.randomUUID(),
    })
    setSaving(false)
    if (!result.success) {
      setError(taskContainerAccessSaveError(result.status, result.error))
      return
    }
    setMode(result.data?.access_mode || mode)
    setRevision(result.data?.access_revision || revision + 1)
    setGrants(normalizeTaskAccessGrants(result.data?.grants || canonical))
    setNotice('Acceso actualizado.')
    await onChanged()
  }

  if (loading) return <div className="flex items-center justify-center rounded-2xl bg-slate-50 py-10 text-xs font-semibold text-slate-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Cargando acceso…</div>
  return <section className="rounded-2xl border border-violet-100 bg-violet-50/40 p-4">
    <div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-violet-700 shadow-sm"><ShieldCheck className="h-4 w-4" /></span><div><h3 className="text-sm font-black text-slate-800">Privacidad y acceso</h3><p className="mt-1 text-[10px] leading-4 text-slate-500">La concesión directa puede subir, reducir o negar el nivel heredado. Solo aparecen personas con acceso al Entorno.</p></div></div>
    <div className="mt-4 grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => setMode('inherit')} className={`rounded-xl border p-3 text-left ${mode === 'inherit' ? 'border-emerald-300 bg-emerald-50 ring-2 ring-emerald-100' : 'border-slate-200 bg-white'}`}><span className="flex items-center gap-2 text-xs font-black text-slate-700"><ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />Heredar del nivel superior</span></button><button type="button" onClick={() => setMode('private')} className={`rounded-xl border p-3 text-left ${mode === 'private' ? 'border-violet-300 bg-violet-100/70 ring-2 ring-violet-100' : 'border-slate-200 bg-white'}`}><span className="flex items-center gap-2 text-xs font-black text-slate-700"><LockKeyhole className="h-3.5 w-3.5 text-violet-600" />Privado</span></button></div>
    <div className="mt-3 flex flex-col gap-2 sm:flex-row"><TaskUserCombobox users={availableUsers} value={selectedUser} onChange={setSelectedUser} placeholder="Compartir con una persona" /><button type="button" disabled={!selectedUser} onClick={addGrant} className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-black text-white disabled:opacity-35"><Plus className="h-3.5 w-3.5" />Añadir</button></div>
    <div className="mt-3 space-y-2">{grants.map(grant => {
      const user = users.find(candidate => candidate.id === grant.user_id)
      const name = grant.display_name || user?.display_name || grant.username || user?.username || 'Usuario'
      return <div key={grant.user_id} className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-[minmax(110px,1fr)_minmax(190px,1fr)_auto_auto] sm:items-center"><span className="truncate text-xs font-bold text-slate-700">{name}</span><TaskSelectPicker value={grant.access_level} options={options} onChange={value => updateGrant(grant.user_id, { access_level: value as TaskAccessLevel, can_manage_access: value === 'full' ? grant.can_manage_access : false })} label={`Nivel de ${name}`} /><label className="flex items-center gap-1.5 text-[10px] font-bold text-violet-700"><input type="checkbox" checked={grant.can_manage_access} disabled={grant.access_level !== 'full'} onChange={event => updateGrant(grant.user_id, { can_manage_access: event.target.checked })} />Gestiona</label><button type="button" aria-label={`Quitar acceso de ${name}`} onClick={() => setGrants(current => current.filter(candidate => candidate.user_id !== grant.user_id))} className="rounded-lg p-2 text-slate-300 hover:bg-rose-50 hover:text-rose-600"><X className="h-3.5 w-3.5" /></button></div>
    })}</div>
    {error && <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{error} <button type="button" onClick={() => void load()} className="underline">Recargar</button></p>}
    {notice && <p role="status" className="mt-3 text-xs font-semibold text-emerald-700">{notice}</p>}
    <div className="mt-4 flex justify-end"><button type="button" disabled={saving} onClick={() => void save()} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-violet-700 px-4 text-xs font-black text-white disabled:opacity-40">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Guardar acceso</button></div>
  </section>
}
