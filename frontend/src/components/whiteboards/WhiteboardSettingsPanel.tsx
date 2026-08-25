'use client'

import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Check,
  Copy,
  ExternalLink,
  Folder,
  FolderPlus,
  Home,
  Loader2,
  Save,
  Search,
  Settings2,
  Share2,
  X,
} from 'lucide-react'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/lib/useDebouncedValue'
import {
  currentWhiteboardFolderBeforeID,
  whiteboardFolderDestinationOptions,
  whiteboardFolderPositionOptions,
  whiteboardMoveDestinationOptions,
  type WhiteboardFolderRelocationInput,
} from '@/lib/whiteboardFolders'
import type { WhiteboardFolder, WhiteboardManagerLayout, WhiteboardSummary } from '@/lib/whiteboards'

export type WhiteboardSettingsTarget =
  | { kind: 'folder'; value: WhiteboardFolder }
  | { kind: 'board'; value: WhiteboardSummary }

export interface WhiteboardSettingsSaveResult {
  success: boolean
  error?: string
}

interface WhiteboardSettingsPanelProps {
  target: WhiteboardSettingsTarget
  folders: readonly WhiteboardFolder[]
  layout: WhiteboardManagerLayout
  canCreateBoard: boolean
  canManageFolders: boolean
  onClose: () => void
  onSaveFolder: (folder: WhiteboardFolder, input: WhiteboardFolderRelocationInput) => Promise<WhiteboardSettingsSaveResult>
  onSaveBoard: (board: WhiteboardSummary, input: { name: string; description: string; folder_id: string | null; expected_version: number }) => Promise<WhiteboardSettingsSaveResult>
  onOpenBoard: (board: WhiteboardSummary) => void
  onShareBoard: (board: WhiteboardSummary) => void
  onDuplicateBoard: (board: WhiteboardSummary) => void
  onArchiveBoard: (board: WhiteboardSummary) => void
  onCreateSubfolder: (folder: WhiteboardFolder) => void
  onArchiveFolder: (folder: WhiteboardFolder) => void
}

export default function WhiteboardSettingsPanel({
  target,
  folders,
  layout,
  canCreateBoard,
  canManageFolders,
  onClose,
  onSaveFolder,
  onSaveBoard,
  onOpenBoard,
  onShareBoard,
  onDuplicateBoard,
  onArchiveBoard,
  onCreateSubfolder,
  onArchiveFolder,
}: WhiteboardSettingsPanelProps) {
  const value = target.value
  const initialParentID = target.kind === 'folder' ? target.value.parent_id || '' : target.value.folder_id || ''
  const initialBeforeID = target.kind === 'folder' ? currentWhiteboardFolderBeforeID(folders, target.value) || '' : ''
  const [name, setName] = useState(value.name)
  const [description, setDescription] = useState(value.description || '')
  const [parentID, setParentID] = useState(initialParentID)
  const [beforeFolderID, setBeforeFolderID] = useState(initialBeforeID)
  const [rawSearch, setRawSearch] = useState('')
  const [settledSearch, setSettledSearch] = useDebouncedValue(rawSearch, SEARCH_DEBOUNCE_MS)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDiscard, setShowDiscard] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true })
  }, [target.kind, value.id])

  const folderDestinations = useMemo(() => {
    if (target.kind === 'folder') {
      const query = settledSearch.trim().toLocaleLowerCase('es')
      return whiteboardFolderDestinationOptions(folders, target.value)
        .filter(option => !query || option.label.toLocaleLowerCase('es').includes(query))
        .map(option => ({ ...option, path: option.id ? option.label : 'Nivel principal de Pizarras' }))
    }
    return whiteboardMoveDestinationOptions(folders, settledSearch).map(option => ({
      ...option,
      disabled: false,
      reason: undefined,
    }))
  }, [folders, settledSearch, target])

  const positionOptions = useMemo(() => target.kind === 'folder'
    ? whiteboardFolderPositionOptions(folders, target.value, parentID || null)
    : [], [folders, parentID, target])

  useEffect(() => {
    if (target.kind !== 'folder') return
    if (!positionOptions.some(option => (option.beforeFolderID || '') === beforeFolderID)) {
      setBeforeFolderID(positionOptions.at(-1)?.beforeFolderID || '')
    }
  }, [beforeFolderID, positionOptions, target.kind])

  const dirty = name.trim() !== value.name
    || description.trim() !== (value.description || '')
    || parentID !== initialParentID
    || (target.kind === 'folder' && beforeFolderID !== initialBeforeID)
  const searchPending = rawSearch !== settledSearch

  const requestClose = () => {
    if (saving) return
    if (dirty) {
      setShowDiscard(true)
      return
    }
    onClose()
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    const normalizedName = name.trim()
    if (!normalizedName || saving || !dirty) return
    setSaving(true)
    setError(null)
    const result = target.kind === 'folder'
      ? await onSaveFolder(target.value, {
          name: normalizedName,
          description: description.trim(),
          placement: {
            parent_id: parentID || null,
            before_folder_id: beforeFolderID || null,
          },
          expected_version: target.value.version,
        })
      : await onSaveBoard(target.value, {
          name: normalizedName,
          description: description.trim(),
          folder_id: parentID || null,
          expected_version: target.value.version,
        })
    setSaving(false)
    if (!result.success) {
      setError(result.error || 'No se pudieron guardar los cambios.')
      return
    }
    onClose()
  }

  return <>
    <aside
      aria-label={`Configuración de ${value.name}`}
      className={`${layout === 'narrow' ? 'absolute inset-0 z-[70] w-full' : 'relative z-20 w-[400px] max-w-[42%] shrink-0 border-l'} flex min-h-0 flex-col border-slate-200 bg-white shadow-[-12px_0_30px_rgba(15,23,42,0.08)]`}
    >
      <div className="flex shrink-0 items-start gap-3 border-b border-slate-200 px-4 py-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white"><Settings2 className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-black uppercase tracking-[.13em] text-emerald-600">{target.kind === 'folder' ? 'Carpeta' : 'Pizarra'}</p>
          <h2 className="truncate text-lg font-black text-slate-900">Configuración</h2>
          <p className="mt-0.5 truncate text-xs text-slate-500">{value.name}</p>
        </div>
        <button ref={closeButtonRef} type="button" onClick={requestClose} disabled={saving} aria-label="Cerrar configuración" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40"><X className="h-4 w-4" /></button>
      </div>

      <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <section aria-labelledby="whiteboard-settings-general">
            <h3 id="whiteboard-settings-general" className="text-xs font-black uppercase tracking-[.12em] text-slate-500">Información general</h3>
            <label className="mt-3 block text-xs font-bold text-slate-600">Nombre
              <input value={name} onChange={event => setName(event.target.value)} maxLength={120} disabled={saving || Boolean(value.archived_at)} className="mt-1.5 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:bg-slate-50 disabled:text-slate-400" />
            </label>
            <label className="mt-3 block text-xs font-bold text-slate-600">Descripción
              <textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={1000} rows={4} disabled={saving || Boolean(value.archived_at)} placeholder="Añade contexto para el equipo…" className="mt-1.5 w-full resize-y rounded-xl border border-slate-200 px-3 py-2.5 text-sm leading-5 text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:bg-slate-50 disabled:text-slate-400" />
            </label>
          </section>

          {!value.archived_at && <section className="mt-6 border-t border-slate-100 pt-5" aria-labelledby="whiteboard-settings-location">
            <h3 id="whiteboard-settings-location" className="text-xs font-black uppercase tracking-[.12em] text-slate-500">{target.kind === 'folder' ? 'Organización' : 'Carpeta'}</h3>
            <label className="relative mt-3 block">
              <span className="sr-only">Buscar carpeta</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input value={rawSearch} onChange={event => { const next = event.target.value; setRawSearch(next); if (!next) setSettledSearch('') }} placeholder="Buscar carpeta…" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm outline-none focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100" />
              {searchPending ? <Loader2 aria-label="Buscando carpetas" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" /> : rawSearch ? <button type="button" onClick={() => { setRawSearch(''); setSettledSearch('') }} aria-label="Limpiar búsqueda de carpetas" className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button> : null}
            </label>
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-1" role="radiogroup" aria-label={target.kind === 'folder' ? 'Carpeta superior' : 'Carpeta de la pizarra'}>
              {folderDestinations.map(option => {
                const optionID = option.id || ''
                const selected = parentID === optionID
                const Icon = option.id ? Folder : Home
                return <label key={option.id || 'root'} title={option.reason} className={`relative flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 ${selected ? 'bg-white text-emerald-900 shadow-sm ring-1 ring-emerald-200' : option.disabled ? 'cursor-not-allowed text-slate-300' : 'cursor-pointer text-slate-600 hover:bg-white hover:text-slate-900'}`}>
                  <input type="radio" checked={selected} disabled={saving || option.disabled} onChange={() => { setParentID(optionID); setBeforeFolderID(''); setError(null) }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${selected ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}><Icon className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{option.label}</span><span className="mt-0.5 block truncate text-[10px] text-slate-400">{option.path}</span>{option.reason && <span className="mt-0.5 block text-[10px] leading-4 text-amber-700">{option.reason}</span>}</span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}
                </label>
              })}
              {!folderDestinations.length && <p className="px-3 py-6 text-center text-xs font-bold text-slate-500">No hay carpetas que coincidan.</p>}
            </div>
            {target.kind === 'folder' && <label className="mt-3 block text-xs font-bold text-slate-600">Posición en este nivel
              <select value={beforeFolderID} onChange={event => setBeforeFolderID(event.target.value)} disabled={saving} className="mt-1.5 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100">
                {positionOptions.map(option => <option key={`${option.beforeFolderID || 'end'}-${option.label}`} value={option.beforeFolderID || ''}>{option.label}</option>)}
              </select>
            </label>}
          </section>}

          <section className="mt-6 border-t border-slate-100 pt-5" aria-labelledby="whiteboard-settings-actions">
            <h3 id="whiteboard-settings-actions" className="text-xs font-black uppercase tracking-[.12em] text-slate-500">Acciones</h3>
            <div className="mt-3 space-y-2">
              {target.kind === 'board' ? <>
                <button type="button" onClick={() => onOpenBoard(target.value)} className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-200 px-3 text-left text-sm font-bold text-slate-700 hover:bg-slate-50"><ExternalLink className="h-4 w-4 text-slate-400" />Abrir pizarra</button>
                {target.value.effective_access.can_manage_access && <button type="button" onClick={() => onShareBoard(target.value)} className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-200 px-3 text-left text-sm font-bold text-slate-700 hover:bg-sky-50 hover:text-sky-800"><Share2 className="h-4 w-4 text-sky-600" />Administrar acceso y enlaces</button>}
                {canCreateBoard && !target.value.archived_at && <button type="button" onClick={() => onDuplicateBoard(target.value)} className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-200 px-3 text-left text-sm font-bold text-slate-700 hover:bg-slate-50"><Copy className="h-4 w-4 text-slate-400" />Duplicar pizarra</button>}
                {target.value.effective_access.can_manage_access && !target.value.archived_at && <button type="button" onClick={() => onArchiveBoard(target.value)} className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-200 px-3 text-left text-sm font-bold text-slate-600 hover:bg-slate-50"><Archive className="h-4 w-4 text-slate-400" />Mover a Papelera</button>}
              </> : <>
                {canManageFolders && <button type="button" onClick={() => onCreateSubfolder(target.value)} className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-200 px-3 text-left text-sm font-bold text-slate-700 hover:bg-emerald-50 hover:text-emerald-800"><FolderPlus className="h-4 w-4 text-emerald-600" />Crear subcarpeta</button>}
                {canManageFolders && <button type="button" onClick={() => onArchiveFolder(target.value)} className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-200 px-3 text-left text-sm font-bold text-slate-600 hover:bg-slate-50"><Archive className="h-4 w-4 text-slate-400" />Archivar si está vacía</button>}
              </>}
            </div>
          </section>

          {error && <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-5 text-rose-800" role="alert">{error}</p>}
        </div>
        {!value.archived_at && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-8px_20px_rgba(15,23,42,0.04)]">
          <button type="button" onClick={requestClose} disabled={saving} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button>
          <button type="submit" disabled={saving || !dirty || !name.trim()} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-35">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Guardar</button>
        </div>}
      </form>
    </aside>

    {showDiscard && typeof document !== 'undefined' && createPortal(
      <div className="fixed inset-0 z-[280] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" role="presentation">
        <div role="alertdialog" aria-modal="true" aria-labelledby="whiteboard-settings-discard-title" className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl">
          <h2 id="whiteboard-settings-discard-title" className="text-lg font-black text-slate-900">¿Descartar cambios?</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">La configuración todavía no se ha guardado.</p>
          <div className="mt-5 flex justify-end gap-2"><button type="button" autoFocus onClick={() => setShowDiscard(false)} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100">Seguir editando</button><button type="button" onClick={onClose} className="min-h-11 rounded-xl bg-slate-900 px-4 text-sm font-black text-white hover:bg-slate-800">Descartar</button></div>
        </div>
      </div>,
      document.body,
    )}
  </>
}
