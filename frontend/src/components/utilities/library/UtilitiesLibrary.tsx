'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { flushSync } from 'react-dom'
import { useRouter } from 'next/navigation'
import { Braces, Check, ChevronLeft, ChevronRight, Copy, Download, Folder, FolderPlus, ListFilter, Loader2, Menu, Pencil, Plus, Save, Search, Star, Trash2, X } from 'lucide-react'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { getAuthScope, subscribeAuthScope } from '@/lib/authScope'
import { subscribeWebSocket } from '@/lib/api'
import { useUtilitiesWorkspacePreferences } from '@/lib/utilitiesWorkspacePreferences'
import EditorPopover from '@/components/documents/EditorPopover'
import { installEditorNavigationGuard } from '@/lib/fabric/editorNavigation'
import { useDialogTabTrap } from '@/components/programs/useDialogTabTrap'
import { SessionTimingSummary } from '@/components/admin/SessionTimingSummary'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import { utilities, utilityById, type Utility } from '../catalog'
import { UtilityWorkspace } from '../UtilityWorkspace'
import { UtilityDocumentProvider } from './UtilityDocumentContext'
import { duplicateCryptoDocument } from '../crypto/duplicateCryptoDocument'
import { UtilityDraft } from './UtilityDraft'
import { DocumentModeIndicator } from './DocumentModeIndicator'
import { documentExportExtension, isDocumentFormat } from '../json/documentFormats'
import { prepareUtf8XmlDownload } from '../json/documentFile'
import { activeTabScrollLeft, libraryDrawerBounds, libraryLayout, librarySaveStatus } from './libraryLayout'
import '../utility-density.css'
import { UtilityActionMenu, type UtilityMenuAction } from './UtilityActionMenu'
import { closeOpenDocument, deletedWorkspaceMatches, jsonRequest, libraryRequest, moveOpenDocument, operationId, UtilityRequestError, type LibraryPage, type UtilityDocument, type UtilityFolder, type UtilityWorkspaceState } from './libraryApi'

const buttonBase = 'utility-control inline-flex items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-wait disabled:opacity-50'
const button = `${buttonBase} hover:bg-slate-100`
const field = 'utility-field w-full rounded-lg border border-slate-200 bg-white px-2.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100'
const emptyWorkspace: UtilityWorkspaceState = { open_ids: [], active_id: null, version: 0 }
type Dialog = { kind: 'rename' | 'delete' | 'move'; document: UtilityDocument } | { kind: 'folder' } | null

function LibraryDialog({ dialog, folders, onClose, onSubmit, busy, error }: { dialog: NonNullable<Dialog>; folders: UtilityFolder[]; onClose: () => void; onSubmit: (value: string) => Promise<void>; busy: boolean; error?: string }) {
  const [value, setValue] = useState(dialog.kind === 'rename' ? dialog.document.title : dialog.kind === 'move' ? dialog.document.folder_id ?? '' : '')
  const ref = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  useDialogTabTrap(true, ref)
  const title = dialog.kind === 'rename' ? 'Renombrar documento' : dialog.kind === 'delete' ? 'Eliminar documento' : dialog.kind === 'move' ? 'Mover a carpeta' : 'Nueva carpeta'
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input,select,button')?.focus()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); onClose() } }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
      else document.querySelector<HTMLElement>('[aria-label="Buscar documentos por nombre o contenido"], [role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
    }
  }, [onClose])
  function submit(event: FormEvent) { event.preventDefault(); if (!busy) void onSubmit(value.trim()) }
  return createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-sm" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.confirmation }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="utility-dialog-title" className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
      <h2 id="utility-dialog-title" className="text-base font-semibold text-slate-900">{title}</h2>
      <form onSubmit={submit} className="mt-4 space-y-4">
        {error && <p role="alert" className="rounded-lg bg-rose-50 p-2 text-xs text-rose-800">{error}</p>}
        {dialog.kind === 'delete' ? <p className="text-sm leading-6 text-slate-600">Se eliminará <strong className="break-words text-slate-900">{dialog.document.title}</strong> y sus archivos guardados en Clarin. Esta acción es permanente.</p>
          : dialog.kind === 'move' ? <label className="block text-sm text-slate-700">Carpeta<select className={`${field} mt-2`} value={value} onChange={event => setValue(event.target.value)}><option value="">Sin carpeta</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
            : <label className="block text-sm text-slate-700">Nombre<input className={`${field} mt-2`} value={value} maxLength={160} required onChange={event => setValue(event.target.value)} /></label>}
        <div className="flex justify-end gap-2"><button type="button" disabled={busy} className={button} onClick={onClose}>Cancelar</button><button disabled={busy || ((dialog.kind === 'rename' || dialog.kind === 'folder') && !value.trim())} type="submit" className={`${buttonBase} ${dialog.kind === 'delete' ? 'bg-rose-600 text-white hover:bg-rose-700' : 'bg-emerald-700 text-white hover:bg-emerald-800'}`}>{busy ? 'Procesando…' : dialog.kind === 'delete' ? 'Eliminar definitivamente' : 'Guardar'}</button></div>
      </form>
    </div>
  </div>, document.body)
}

export function UtilitiesLibrary({ initialTool }: { initialTool?: Utility['id'] }) {
  const [scope, setScope] = useState(getAuthScope)
  const [historyGeneration, setHistoryGeneration] = useState(0)
  useEffect(() => subscribeAuthScope(() => setScope(getAuthScope())), [])
  useEffect(() => {
    const clearBeforeHistory = (event: PageTransitionEvent) => { if (event.persisted) flushSync(() => setHistoryGeneration(value => value + 1)) }
    window.addEventListener('pagehide', clearBeforeHistory)
    return () => window.removeEventListener('pagehide', clearBeforeHistory)
  }, [])
  return <LibrarySession key={`${scope}:${historyGeneration}`} initialTool={initialTool} />
}

function LibrarySession({ initialTool }: { initialTool?: Utility['id'] }) {
  const router = useRouter()
  const [page, setPage] = useState<LibraryPage>({ documents: [], has_more: false })
  const [workspace, setWorkspace] = useState(emptyWorkspace)
  const workspaceRef = useRef(workspace)
  const [documents, setDocuments] = useState<Record<string, UtilityDocument>>({})
  const documentsRef = useRef(documents)
  documentsRef.current = documents
  const [folders, setFolders] = useState<UtilityFolder[]>([])
  const [query, setQuery] = useState('')
  const [settledQuery, settleQuery] = useDebouncedValue(query)
  const [type, setType] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [favorite, setFavorite] = useState(false)
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const transitionLock = useRef(false)
  const deferredDeletedTabs = useRef(new Map<string, boolean>())
  const editorSurface = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saveConfirmation, setSaveConfirmation] = useState<{ documentId: string } | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  const [dialogError, setDialogError] = useState('')
  const pendingMetadata = useRef(new Map<string, { changes: string; request: RequestInit }>())
  const actionInFlight = useRef(false)
  const { preferences: layoutPreferences, updatePreferences } = useUtilitiesWorkspacePreferences()
  const libraryOpen = layoutPreferences.libraryOpen
  const setLibraryOpen = (open: boolean) => updatePreferences({ libraryOpen: open })
  const [wide, setWide] = useState(false)
  const [compact, setCompact] = useState(true)
  const [drawerBounds, setDrawerBounds] = useState<ReturnType<typeof libraryDrawerBounds>>({ left: 0, top: 44, width: 0, height: 0, panelWidth: 224 })
  const libraryTrigger = useRef<HTMLButtonElement>(null)
  const librarySurface = useRef<HTMLElement>(null)
  const tabsViewport = useRef<HTMLDivElement>(null)
  const libraryFocus = useRef<{ label: string | null; index: number; start: number | null; end: number | null } | null>(null)
  const libraryFocusRestored = useRef(false)
  const dockedRef = useRef(false)
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null)
  const [statusAnchor, setStatusAnchor] = useState<HTMLElement | null>(null)
  const host = useRef<HTMLElement>(null)
  const [reload, setReload] = useState(0)
  const [editorGeneration, setEditorGeneration] = useState(0)
  const [indexRetry, setIndexRetry] = useState(0)
  const [indexSlow, setIndexSlow] = useState(false)
  const [workspacePhase, setWorkspacePhase] = useState<'saved' | 'saving' | 'error'>('saved')
  const [workspaceError, setWorkspaceError] = useState('')
  const [, redraw] = useState(0)
  const sessions = useRef(new Map<string, UtilityDraft>())
  const mounted = useRef(true)
  const firstDirty = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearSaveConfirmation = useCallback(() => {
    if (saveNoticeTimer.current) clearTimeout(saveNoticeTimer.current)
    saveNoticeTimer.current = null
    setSaveConfirmation(null)
  }, [])
  const workspaceQueue = useRef<Promise<void>>(Promise.resolve())
  const workspacePending = useRef(0)
  const workspaceFailed = useRef(false)
  const collectionGeneration = useRef(0)
  const pendingDeletionIds = useRef(new Set<string>())
  const active = workspace.active_id ? sessions.current.get(workspace.active_id) : undefined
  const activeDocument = active?.document
  const indexingIds = [...new Set([...page.documents, ...(activeDocument ? [activeDocument] : [])].filter(document => document.slots.some(slot => slot.indexing)).map(document => document.id))].sort().join(',')
  const overlay = libraryOpen && !wide
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay
  const closeTransientLibrary = () => { if (overlayRef.current) setLibraryOpen(false) }
  const confirmedActiveSave = saveConfirmation?.documentId === workspace.active_id
  const saveStatus = librarySaveStatus(active?.phase, workspacePhase, !ready || Boolean(active?.loading), Boolean(indexingIds), transitioning, confirmedActiveSave)
  const saveCommand = useRef<() => void>(() => {})
  saveCommand.current = () => { void saveActive() }

  useLayoutEffect(() => { clearSaveConfirmation() }, [workspace.active_id, clearSaveConfirmation])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's' || !host.current?.contains(event.target as Node)) return
      event.preventDefault(); event.stopPropagation()
      if (!event.repeat) saveCommand.current()
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [])
  useEffect(() => { setDialogError('') }, [dialog?.kind, dialog && 'document' in dialog ? dialog.document.id : null])

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect(), viewport = window.visualViewport
      const layout = libraryLayout(rect.width, libraryOpen)
      if (layout.sidebar !== dockedRef.current) {
        const target = document.activeElement
        if (target instanceof HTMLElement && librarySurface.current?.contains(target)) {
          const controls = Array.from(librarySurface.current.querySelectorAll<HTMLElement>('input,button,select,a[href]'))
          libraryFocus.current = { label: target.getAttribute('aria-label'), index: controls.indexOf(target), start: target instanceof HTMLInputElement ? target.selectionStart : null, end: target instanceof HTMLInputElement ? target.selectionEnd : null }
        }
        dockedRef.current = layout.sidebar
      }
      setWide(layout.sidebar); setCompact(layout.compact)
      const bounds = libraryDrawerBounds(rect, { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0, width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight })
      setDrawerBounds(current => Object.keys(bounds).every(key => current[key as keyof typeof bounds] === bounds[key as keyof typeof bounds]) ? current : bounds)
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    measure(); observer?.observe(element)
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true)
    window.visualViewport?.addEventListener('resize', measure); window.visualViewport?.addEventListener('scroll', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); window.visualViewport?.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('scroll', measure) }
  }, [libraryOpen])

  useLayoutEffect(() => {
    const previous = libraryFocus.current
    libraryFocus.current = null
    if (!libraryOpen || !previous || !librarySurface.current) return
    const controls = Array.from(librarySurface.current.querySelectorAll<HTMLElement>('input,button,select,a[href]'))
    const target = (previous.label ? controls.find(control => control.getAttribute('aria-label') === previous.label) : undefined) ?? controls[previous.index]
    target?.focus({ preventScroll: true })
    if (target instanceof HTMLInputElement && previous.start !== null && previous.end !== null) target.setSelectionRange(previous.start, previous.end)
    libraryFocusRestored.current = Boolean(target)
  }, [wide, libraryOpen])

  useEffect(() => {
    if (!overlay) { libraryFocusRestored.current = false; return }
    const restored = libraryFocusRestored.current
    libraryFocusRestored.current = false
    const frame = requestAnimationFrame(() => { if (!restored) librarySurface.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }) })
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || dialogRef.current) return
      const target = event.target === document ? document.activeElement : event.target as Node | null
      if (!target || (!librarySurface.current?.contains(target) && !libraryTrigger.current?.contains(target))) return
      // A nested portaled menu or picker owns the first Escape, even while its
      // focus transfer is pending. The library then owns its own focused Escape.
      if (librarySurface.current?.querySelector('[aria-haspopup][aria-expanded="true"]')) return
      event.preventDefault(); event.stopImmediatePropagation()
      setLibraryOpen(false); libraryTrigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', escape, true)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', escape, true) }
  }, [overlay])
  useEffect(() => { setFilterAnchor(null) }, [wide, libraryOpen])
  useLayoutEffect(() => {
    const viewport = tabsViewport.current
    const tab = viewport && Array.from(viewport.querySelectorAll<HTMLElement>('[data-utility-tab-id]')).find(element => element.dataset.utilityTabId === workspace.active_id)
    if (!viewport || !tab) return
    const reveal = () => {
      const rect = viewport.getBoundingClientRect(), item = tab.getBoundingClientRect()
      viewport.scrollLeft = activeTabScrollLeft({ left: rect.left, right: rect.right, scrollLeft: viewport.scrollLeft, clientWidth: viewport.clientWidth, scrollWidth: viewport.scrollWidth }, item)
    }
    reveal()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reveal) : null
    observer?.observe(viewport); observer?.observe(tab)
    window.addEventListener('resize', reveal)
    return () => { observer?.disconnect(); window.removeEventListener('resize', reveal) }
  }, [workspace.active_id, workspace.open_ids.join(',')])

  const refreshDrafts = useCallback(() => {
    if (!mounted.current) return
    const activeId = workspaceRef.current.active_id
    if (activeId && sessions.current.get(activeId)?.dirty) clearSaveConfirmation()
    setPage(current => ({ ...current, documents: current.documents.map(document => {
      const draft = sessions.current.get(document.id)
      return draft && draft.document.version >= document.version ? { ...draft.document, snippet: document.snippet } : document
    }) }))
    redraw(value => value + 1)
  }, [clearSaveConfirmation])
  const makeDraft = useCallback((document: UtilityDocument) => {
    let draft = sessions.current.get(document.id)
    if (!draft) { draft = new UtilityDraft(document, refreshDrafts); sessions.current.set(document.id, draft) }
    return draft
  }, [refreshDrafts])

  useEffect(() => {
    const controller = new AbortController()
    const release = subscribeWebSocket(message => {
      const event = message as { event?: string; type?: string; data?: { kind?: string; id?: string; document_id?: string } }
      if ((event.event || event.type) !== 'utility_updated' || !event.data) return
      const { id, kind } = event.data
      setReload(value => value + 1)
      if (kind === 'vault_deleted' && id && event.data.document_id) {
        void sessions.current.get(event.data.document_id)?.session.reconcileVaultDeletion?.(id)
        return
      }
      if (kind === 'folder') {
        void libraryRequest<{ folders: UtilityFolder[] }>('/folders', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setFolders(result.folders) }).catch(() => {})
      }
      if (id && kind === 'deleted' && !pendingDeletionIds.current.has(id)) {
        const draft = sessions.current.get(id)
        if (draft?.dirty) { draft.markExternalConflict('Este documento fue eliminado en otra sesión. Guarda tu borrador en una copia independiente.'); return }
        void libraryRequest<{ workspace: UtilityWorkspaceState }>('/workspace', { signal: controller.signal }).then(result => {
          if (!controller.signal.aborted && mounted.current) void closeDocument(id, adoptDeletedWorkspace(id, result.workspace), true)
        }).catch(() => { if (!controller.signal.aborted && mounted.current) void closeDocument(id, adoptDeletedWorkspace(id, null), true) })
        setNotice('El documento fue eliminado en otra sesión.')
        return
      }
      if (!id || kind !== 'document') return
      void libraryRequest<{ document: UtilityDocument }>(`/documents/${id}`, { signal: controller.signal }).then(result => {
        if (controller.signal.aborted || !mounted.current) return
        const draft = sessions.current.get(id)
        if (!draft || draft.dirty || draft.pendingMutation || draft.reconcilingVault || result.document.version <= draft.document.version) return
        draft.dispose(); sessions.current.delete(id)
        setDocuments(current => ({ ...current, [id]: result.document }))
        if (workspaceRef.current.active_id === id) { makeDraft(result.document); setEditorGeneration(value => value + 1) }
      }).catch(() => {})
    })
    return () => { controller.abort(); release() }
  }, [makeDraft])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    void Promise.all([
      libraryRequest<{ workspace: UtilityWorkspaceState }>('/workspace', { signal: controller.signal }),
      libraryRequest<{ folders: UtilityFolder[] }>('/folders', { signal: controller.signal }),
    ]).then(async ([saved, folderPage]) => {
      if (!mounted.current) return
      setFolders(folderPage.folders)
      const opened = await Promise.all(saved.workspace.open_ids.map(id => libraryRequest<{ document: UtilityDocument }>(`/documents/${id}`, { signal: controller.signal }).catch(() => null)))
      if (!mounted.current) return
      const valid = opened.flatMap(item => item ? [item.document] : [])
      setDocuments(Object.fromEntries(valid.map(document => [document.id, document])))
      const next = { ...saved.workspace, open_ids: valid.map(document => document.id), active_id: valid.some(document => document.id === saved.workspace.active_id) ? saved.workspace.active_id : valid[0]?.id ?? null }
      if (next.active_id) makeDraft(valid.find(document => document.id === next.active_id)!)
      workspaceRef.current = next; setWorkspace(next); setReady(true)
    }).catch(reason => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : 'No se pudo abrir tu biblioteca.'); setReady(true) } })
    return () => {
      mounted.current = false; controller.abort()
      if (timer.current) clearTimeout(timer.current)
      if (saveNoticeTimer.current) clearTimeout(saveNoticeTimer.current)
      saveNoticeTimer.current = null
      sessions.current.forEach(draft => draft.dispose()); sessions.current.clear()
    }
  }, [makeDraft])

  useEffect(() => {
    const controller = new AbortController()
    collectionGeneration.current++
    setLoading(true)
    const params = new URLSearchParams()
    if (settledQuery) params.set('q', settledQuery)
    if (type) params.set('type', type)
    if (folder !== null) params.set('folder_id', folder)
    if (favorite) params.set('favorite', 'true')
    void libraryRequest<LibraryPage>(`/documents?${params}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      if (!Array.isArray(result.documents)) throw new Error('La biblioteca devolvió una respuesta incompleta.')
      setPage(result)
      setDocuments(current => ({ ...current, ...Object.fromEntries(result.documents.map(document => [document.id, document])) }))
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'No se pudo buscar.') }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [settledQuery, type, folder, favorite, reload])

  useEffect(() => {
    if (!indexingIds) { setIndexSlow(false); return }
    const controller = new AbortController()
    let attempts = 0
    let timer: ReturnType<typeof setTimeout>
    setIndexSlow(false)
    const poll = async () => {
      attempts++
      const results = await Promise.allSettled(indexingIds.split(',').map(id => libraryRequest<{ document: UtilityDocument }>(`/documents/${id}`, { signal: controller.signal })))
      if (controller.signal.aborted || !mounted.current) return
      const canonical = results.flatMap(result => result.status === 'fulfilled' ? [result.value.document] : [])
      for (const document of canonical) sessions.current.get(document.id)?.reconcileIndexing(document)
      setPage(current => ({ ...current, documents: current.documents.map(document => canonical.find(candidate => candidate.id === document.id && candidate.version >= document.version) ?? document) }))
      const pending = results.some(result => result.status === 'rejected') || canonical.some(document => document.slots.some(slot => slot.indexing))
      if (pending && attempts < 30) timer = setTimeout(() => void poll(), 2000)
      else if (pending) setIndexSlow(true)
      else setReload(value => value + 1)
    }
    timer = setTimeout(() => void poll(), 2000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [indexingIds, indexRetry])

  useEffect(() => {
    if (!active?.dirty || active.phase === 'error' || active.phase === 'conflict') { firstDirty.current = null; return }
    firstDirty.current ??= Date.now()
    const wait = Math.max(0, Math.min(2000, 5000 - (Date.now() - firstDirty.current)))
    timer.current = setTimeout(() => { firstDirty.current = null; void active.flush() }, wait)
    return () => { if (timer.current) clearTimeout(timer.current) }
  })

  useEffect(() => {
    const navigationPending = () => workspacePending.current > 0 || workspaceFailed.current || [...sessions.current.values()].some(draft => draft.dirty || draft.pendingMutation)
    const beforeUnload = (event: BeforeUnloadEvent) => { if (navigationPending()) { event.preventDefault(); event.returnValue = '' } }
    const flushAll = async () => {
      if (!beginTransition()) return false
      let leaving = false
      try {
      for (const draft of sessions.current.values()) {
        if (!draft.freezeSources()) return false
        if (!(await draft.flush())) {
          if (mounted.current) setError('No se pudo guardar antes de salir. Reintenta, descarga el borrador o guarda una copia.')
          return false
        }
      }
      await workspaceQueue.current
      if (workspaceFailed.current) {
        if (mounted.current) setError('No se pudieron guardar las pestañas antes de salir. Reintenta guardar las pestañas de esta ventana.')
        return false
      }
      leaving = mounted.current
      return leaving
      } finally { if (!leaving) finishTransition() }
    }
    const guardLinks = (event: MouseEvent) => {
      if (!navigationPending()) return
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download') || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return
      const target = new URL(anchor.href, location.href)
      if (target.href === location.href) return
      if (target.origin === location.origin && target.pathname === location.pathname) return
      event.preventDefault(); event.stopPropagation()
      void flushAll().then(saved => { if (saved) { if (target.origin === location.origin) router.push(target.pathname + target.search + target.hash); else location.assign(target.href) } })
    }
    const releaseHistory = installEditorNavigationGuard(window, navigationPending, resume => { void flushAll().then(saved => { if (saved) resume() }) })
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', guardLinks, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', guardLinks, true); releaseHistory() }
  }, [router])

  function persistWorkspace(next: UtilityWorkspaceState) {
    workspaceRef.current = next; setWorkspace(next)
    workspacePending.current++; setWorkspacePhase('saving'); setWorkspaceError('')
    workspaceQueue.current = workspaceQueue.current.then(async () => {
      if (!mounted.current) return
      const save = (version: number) => libraryRequest<{ workspace: UtilityWorkspaceState }>('/workspace', { ...jsonRequest('PUT', { open_ids: next.open_ids, active_id: next.active_id, base_version: version }), keepalive: true })
      let result: { workspace: UtilityWorkspaceState }
      try { result = await save(workspaceRef.current.version) }
      catch (reason) {
        if (!mounted.current || reason instanceof UtilityRequestError && (reason.status === 401 || reason.status === 403)) throw reason
        const current = await libraryRequest<{ workspace: UtilityWorkspaceState }>('/workspace')
        if (current.workspace.active_id === next.active_id && JSON.stringify(current.workspace.open_ids) === JSON.stringify(next.open_ids)) result = current
        else {
          workspaceRef.current = { ...workspaceRef.current, version: current.workspace.version }
          throw new UtilityRequestError('Las pestañas no se confirmaron o cambiaron en otra ventana. Puedes guardar las de esta ventana.', reason instanceof UtilityRequestError ? reason.status : undefined)
        }
      }
      workspaceRef.current = { ...workspaceRef.current, version: result.workspace.version }
      workspaceFailed.current = false
      if (mounted.current) setWorkspace(current => ({ ...current, version: result.workspace.version }))
    }).catch(reason => {
      workspaceFailed.current = true
      if (mounted.current) setWorkspaceError(reason instanceof Error ? reason.message : 'No se pudieron guardar las pestañas.')
    }).finally(() => {
      workspacePending.current--
      if (mounted.current) setWorkspacePhase(workspacePending.current > 0 ? 'saving' : workspaceFailed.current ? 'error' : 'saved')
    })
  }

  async function retryWorkspace() {
    try {
      const current = await libraryRequest<{ workspace: UtilityWorkspaceState }>('/workspace')
      if (!mounted.current) return
      persistWorkspace({ ...workspaceRef.current, version: current.workspace.version })
    } catch (reason) { if (mounted.current) setWorkspaceError(reason instanceof Error ? reason.message : 'No se pudieron comprobar las pestañas.') }
  }

  async function leaveActive() {
    const current = workspaceRef.current.active_id ? sessions.current.get(workspaceRef.current.active_id!) : undefined
    if (!current) return true
    const success = await current.flush()
    if (!success) setError(current.phase === 'conflict' ? 'Este documento cambió en otra sesión. Descarga tu borrador o guarda una copia antes de cerrarlo.' : 'No se pudo guardar. Tu documento sigue abierto para reintentar o descargarlo.')
    return success
  }

  function beginTransition() {
    if (transitionLock.current) return false
    transitionLock.current = true
    if (editorSurface.current) editorSurface.current.inert = true
    setTransitioning(true); setBusy(true)
    const current = workspaceRef.current.active_id ? sessions.current.get(workspaceRef.current.active_id!) : undefined
    if (current && !current.prepareDeactivate()) { finishTransition(); return false }
    return true
  }

  function finishTransition() {
    transitionLock.current = false
    if (editorSurface.current) editorSurface.current.inert = false
    if (mounted.current) { setTransitioning(false); setBusy(false) }
    const pending = deferredDeletedTabs.current.entries().next().value as [string, boolean] | undefined
    if (pending && mounted.current) { deferredDeletedTabs.current.delete(pending[0]); queueMicrotask(() => { if (mounted.current) void closeDocument(pending[0], pending[1], true) }) }
  }

  function releaseInactive(nextActiveId: string) {
    for (const [id, draft] of sessions.current) {
      if (id === nextActiveId) continue
      if (!draft.freezeSources()) return false
      if (draft.dirty) continue
      setDocuments(current => ({ ...current, [id]: draft.document }))
      draft.dispose(); sessions.current.delete(id)
    }
    return true
  }

  async function openDocument(document: UtilityDocument) {
    const requestSearch = (draft: UtilityDraft) => {
      if (!settledQuery || !document.snippet) return
      draft.session.searchQuery = settledQuery; draft.session.searchRequest = (draft.session.searchRequest ?? 0) + 1
      refreshDrafts()
    }
    if (document.id === workspaceRef.current.active_id) { const draft = sessions.current.get(document.id); if (draft) requestSearch(draft); closeTransientLibrary(); return }
    if (!beginTransition()) return
    try {
      if (!(await leaveActive())) return
      const canonical = sessions.current.get(document.id)?.document ?? (await libraryRequest<{ document: UtilityDocument }>(`/documents/${document.id}`)).document
      if (!mounted.current) return
      if (!(await leaveActive())) return
      requestSearch(makeDraft(canonical)); setDocuments(current => ({ ...current, [canonical.id]: canonical }))
      if (!releaseInactive(canonical.id)) return
      const current = workspaceRef.current
      flushSync(() => persistWorkspace({ ...current, open_ids: current.open_ids.includes(canonical.id) ? current.open_ids : [...current.open_ids, canonical.id], active_id: canonical.id }))
      closeTransientLibrary(); setError('')
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'No se pudo abrir el documento.') } finally { finishTransition() }
  }

  async function createDocument(kind: Utility['id']) {
    if (!beginTransition()) return
    try {
      if (!(await leaveActive())) return
      const result = await libraryRequest<{ document: UtilityDocument }>('/documents', jsonRequest('POST', { type: kind, title: `Sin título · ${utilityById(kind)?.title}`, folder_id: folder || null, operation_id: operationId() }))
      if (!mounted.current) return
      if (!(await leaveActive())) return
      makeDraft(result.document); setDocuments(current => ({ ...current, [result.document.id]: result.document }))
      if (!releaseInactive(result.document.id)) return
      flushSync(() => persistWorkspace({ ...workspaceRef.current, open_ids: [...workspaceRef.current.open_ids, result.document.id], active_id: result.document.id })); setReload(value => value + 1); closeTransientLibrary()
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'No se pudo crear el documento.') } finally { finishTransition() }
  }

  const createdInitial = useRef(false)
  useEffect(() => {
    if (!ready || !initialTool || createdInitial.current) return
    createdInitial.current = true
    const existing = workspaceRef.current.open_ids.map(id => documents[id]).find(document => document?.type === initialTool)
    if (existing) void openDocument(existing)
    else void createDocument(initialTool)
  }, [ready, initialTool]) // A direct tool link opens one working document, once.

  async function closeDocument(id: string, persist = true, deleted = false) {
    if (!beginTransition()) { if (deleted) deferredDeletedTabs.current.set(id, persist); return }
    try {
    const current = workspaceRef.current
    const closing = sessions.current.get(id)
    if (deleted) { closing?.dispose(); sessions.current.delete(id) }
    if (!deleted && closing && !(await closing.flush())) { setError('No se pudo guardar. Tu documento sigue abierto para reintentar o descargarlo.'); return }
    let next = closeOpenDocument(workspaceRef.current, id)
    if (next.active_id && !sessions.current.has(next.active_id)) {
      const nextId = next.active_id
      try {
        const result = await libraryRequest<{ document: UtilityDocument }>(`/documents/${nextId}`)
        if (!mounted.current) return
        next = closeOpenDocument(workspaceRef.current, id)
        if (next.active_id === nextId) makeDraft(result.document)
        setDocuments(values => ({ ...values, [nextId]: result.document }))
      } catch (reason) {
        if (!mounted.current) return
        // A lightweight list row is never a source snapshot. Keep the neighboring
        // tab available for Retry rather than displaying an empty saved editor.
        next = { ...next, active_id: null }
        setError(reason instanceof Error ? reason.message : 'No se pudo abrir la pestaña vecina. Puedes volver a seleccionarla.')
      }
    }
    if (!deleted && closing && !(await closing.flush())) { setError('Los últimos cambios no se pudieron guardar. El documento sigue abierto.'); return }
    if (!releaseInactive(next.active_id ?? '')) return
    flushSync(() => {
      if (persist) persistWorkspace(next)
      else { workspaceRef.current = next; setWorkspace(next) }
    })
    sessions.current.get(id)?.dispose(); sessions.current.delete(id)
    } finally { finishTransition() }
  }

  function adoptDeletedWorkspace(id: string, canonical: UtilityWorkspaceState | null | undefined) {
    if (canonical && deletedWorkspaceMatches(workspaceRef.current, id, canonical)) {
      workspaceRef.current = { ...workspaceRef.current, version: canonical.version }
      setWorkspace(values => ({ ...values, version: canonical.version }))
      return true
    }
    workspaceFailed.current = true; setWorkspacePhase('error')
    setWorkspaceError('El documento fue eliminado. Las pestañas cambiaron en otra ventana o no se pudieron comprobar; puedes guardar las de esta ventana.')
    return false
  }

  async function retryActive() {
    if (!active || !activeDocument) return
    if (active.dirty || active.pendingMutation) {
      const draft = active, attemptedError = draft.error
      const saved = await draft.flush()
      if (saved && mounted.current && workspaceRef.current.active_id === draft.document.id) announceSaved(attemptedError)
      return
    }
    if (!beginTransition()) return
    try {
      if (!(await leaveActive())) return
      const result = await libraryRequest<{ document: UtilityDocument }>(`/documents/${activeDocument.id}`)
      if (!mounted.current) return
      active.dispose(); sessions.current.delete(activeDocument.id); makeDraft(result.document)
      flushSync(() => setEditorGeneration(value => value + 1))
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'No se pudo volver a abrir el documento.') } finally { finishTransition() }
  }

  async function saveActive() {
    if (!active || !ready || busy || active.loading || transitioning) return
    if (active.phase === 'error' && !active.dirty) { await retryActive(); return }
    const draft = active
    if (timer.current) clearTimeout(timer.current)
    firstDirty.current = null
    const saved = await draft.flush()
    if (!mounted.current || workspaceRef.current.active_id !== draft.document.id) return
    if (saved) announceSaved()
  }

  function announceSaved(matchingError?: string) {
    const documentId = workspaceRef.current.active_id
    if (!documentId) return
    setError(current => matchingError === undefined || current === matchingError ? '' : current)
    const confirmation = { documentId }
    setSaveConfirmation(confirmation)
    if (saveNoticeTimer.current) clearTimeout(saveNoticeTimer.current)
    saveNoticeTimer.current = setTimeout(() => {
      saveNoticeTimer.current = null
      if (mounted.current) setSaveConfirmation(current => current === confirmation ? null : current)
    }, 2000)
  }

  async function changeMetadata(document: UtilityDocument, changes: Record<string, unknown>) {
    if (actionInFlight.current) return
    actionInFlight.current = true
    const draft = sessions.current.get(document.id)
    setDialogError('')
    setBusy(true)
    try {
      const mutate = async (canonical: UtilityDocument) => {
        const desired = JSON.stringify(changes)
        // A lost acknowledgement may have committed. Replay its exact identity
        // before accepting a different rename/favorite/folder request.
        let current = canonical
        for (;;) {
          const retained = pendingMetadata.current.get(document.id)
          if (!retained && Object.entries(changes).every(([key, value]) => JSON.stringify((current as unknown as Record<string, unknown>)[key]) === JSON.stringify(value))) return { document: current }
          const pending = retained ?? { changes: desired, request: jsonRequest('PATCH', { base_version: current.version, operation_id: operationId(), ...changes }) }
          pendingMetadata.current.set(document.id, pending)
          const response = await libraryRequest<{ document: UtilityDocument }>(`/documents/${document.id}`, pending.request)
          draft?.acceptMetadata(response.document)
          pendingMetadata.current.delete(document.id)
          if (pending.changes === desired) return response
          current = response.document
        }
      }
      const result = await (draft ? draft.mutate(mutate) : mutate(document))
      if (!mounted.current) return
      setDocuments(current => ({ ...current, [document.id]: result.document }))
      setPage(current => ({ ...current, documents: current.documents.map(item => item.id === document.id ? { ...result.document, snippet: item.snippet } : item) }))
      setReload(value => value + 1); setDialog(null); setError('')
    } catch (reason) {
      if (reason instanceof UtilityRequestError && reason.status && reason.status >= 400 && reason.status < 500 && ![408, 429].includes(reason.status)) pendingMetadata.current.delete(document.id)
      const message = reason instanceof Error ? reason.message : 'No se pudo guardar el cambio.'
      if (mounted.current) { setDialogError(message); setError(message) }
      if (!draft && reason instanceof UtilityRequestError && reason.status === 409) await refreshDialogDocument(document.id)
    } finally { actionInFlight.current = false; if (mounted.current) setBusy(false) }
  }

  async function submitDialog(value: string) {
    if (!dialog) return
    if (dialog.kind === 'rename' || dialog.kind === 'move') return changeMetadata(dialog.document, dialog.kind === 'rename' ? { title: value } : { folder_id: value || null })
    if (actionInFlight.current) return
    actionInFlight.current = true
    setDialogError('')
    setBusy(true)
    try {
      if (dialog.kind === 'folder') {
        const result = await libraryRequest<{ folder: UtilityFolder }>('/folders', jsonRequest('POST', { name: value }))
        setFolders(current => [...current, result.folder]); setFolder(result.folder.id)
      } else {
        const document = dialog.document
        const draft = sessions.current.get(document.id)
        const mutate = (canonical: UtilityDocument) => {
          pendingDeletionIds.current.add(document.id)
          return libraryRequest<{ cleanup_pending: boolean; workspace?: UtilityWorkspaceState | null }>(`/documents/${document.id}?version=${canonical.version}`, { method: 'DELETE' })
        }
        const result = await (draft ? draft.mutate(mutate, { deleting: true }) : mutate(document))
        await closeDocument(dialog.document.id, adoptDeletedWorkspace(dialog.document.id, result.workspace), true)
        setDocuments(current => { const next = { ...current }; delete next[dialog.document.id]; return next })
        setPage(current => ({ ...current, documents: current.documents.filter(item => item.id !== document.id) })); setReload(value => value + 1)
        setNotice(result.cleanup_pending ? 'Documento eliminado. La limpieza de sus archivos está pendiente de confirmación.' : 'Documento y archivos eliminados.')
      }
      setDialog(null)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'No se pudo completar la operación.'
      if (mounted.current) { setDialogError(message); setError(message) }
      if ('document' in dialog && !sessions.current.has(dialog.document.id) && reason instanceof UtilityRequestError && reason.status === 409) await refreshDialogDocument(dialog.document.id)
    } finally { actionInFlight.current = false; if (dialog && 'document' in dialog) pendingDeletionIds.current.delete(dialog.document.id); if (mounted.current) setBusy(false) }
  }

  async function refreshDialogDocument(id: string) {
    try {
      const current = await libraryRequest<{ document: UtilityDocument }>(`/documents/${id}`)
      if (!mounted.current) return
      setDocuments(items => ({ ...items, [id]: current.document }))
      setPage(page => ({ ...page, documents: page.documents.map(item => item.id === id ? current.document : item) }))
      setDialog(dialog => dialog && 'document' in dialog && dialog.document.id === id ? { ...dialog, document: current.document } : dialog)
      setDialogError('El documento cambió. Se actualizó su versión; revisa la operación y vuelve a confirmar.')
    } catch { /* Keep the existing error and exact user-entered name for a later retry. */ }
  }

  async function duplicateDocument(document: UtilityDocument, loadOriginalAfter = false) {
    const draft = sessions.current.get(document.id) ?? makeDraft(document)
    if (!beginTransition()) return
    let savedCopy: UtilityDocument | undefined
    try {
      if (!draft.freezeSources()) return
      // A conflict must still allow preserving the user's unsaved work as a copy.
      if (draft.phase !== 'conflict' && draft.phase !== 'error' && !(await draft.flush())) return
      const result = document.type === 'criptografia'
        ? await duplicateCryptoDocument(draft.document, draft.phase === 'conflict' || draft.phase === 'error')
        : await libraryRequest<{ document: UtilityDocument }>('/documents', jsonRequest('POST', { type: document.type, title: `${document.title} · copia`, folder_id: document.folder_id, config: draft.document.config, operation_id: operationId() }))
      const copy = makeDraft(result.document)
      const slots = new Set([...(draft.session.slotNames?.() ?? draft.document.slots.map(slot => slot.slot))])
      for (const slot of slots) { const blob = draft.session.getSlot(slot) ?? await draft.session.readSlot(slot); if (blob) copy.session.setSlot(slot, blob) }
      if (!(await copy.flush())) throw new Error(copy.error)
      savedCopy = copy.document
      setDocuments(current => ({ ...current, [copy.document.id]: copy.document }))
      setError('')
      if (loadOriginalAfter) {
        // The independent copy is durable before any original model is replaced.
        // A failed canonical reload keeps the original draft and the saved copy.
        const canonical = await libraryRequest<{ document: UtilityDocument }>(`/documents/${document.id}`)
        if (!mounted.current) return
        if (canonical.document.id !== document.id) throw new Error('No se pudo confirmar la versión guardada. Tu borrador y su copia siguen disponibles.')
        draft.dispose(); sessions.current.delete(document.id)
        makeDraft(canonical.document)
        setDocuments(current => ({ ...current, [document.id]: canonical.document }))
        flushSync(() => {
          persistWorkspace({ ...workspaceRef.current, open_ids: [...new Set([...workspaceRef.current.open_ids, copy.document.id, document.id])], active_id: document.id })
          setEditorGeneration(value => value + 1)
        })
        setNotice('Tu borrador se guardó en una copia. Se cargó la versión guardada del documento original.')
        setReload(value => value + 1)
        return
      }
      const replacingConflict = draft.phase === 'conflict' || draft.phase === 'error'
      if (!draft.freezeSources()) return
      if (draft.phase !== 'conflict' && draft.phase !== 'error' && !(await draft.flush())) return
      flushSync(() => persistWorkspace({ ...workspaceRef.current, open_ids: [...workspaceRef.current.open_ids.filter(id => !replacingConflict || id !== draft.document.id), copy.document.id], active_id: copy.document.id }))
      if (replacingConflict) { draft.dispose(); sessions.current.delete(draft.document.id); setNotice('Tu borrador se guardó en una copia independiente.') }
      releaseInactive(copy.document.id); setReload(value => value + 1)
    } catch (reason) {
      if (mounted.current) {
        if (savedCopy) {
          persistWorkspace({ ...workspaceRef.current, open_ids: [...new Set([...workspaceRef.current.open_ids, savedCopy.id])] })
          setNotice('La copia está guardada y disponible en otra pestaña. Tu borrador original sigue abierto.')
          setReload(value => value + 1)
        }
        setError(reason instanceof Error ? reason.message : 'No se pudo guardar la copia.')
      }
    } finally { finishTransition() }
  }

  async function loadMore() {
    if (!page.next_cursor || loading) return
    setLoading(true)
    const generation = collectionGeneration.current
    try {
      const params = new URLSearchParams({ cursor: page.next_cursor })
      if (settledQuery) params.set('q', settledQuery); if (type) params.set('type', type); if (folder !== null) params.set('folder_id', folder); if (favorite) params.set('favorite', 'true')
      const result = await libraryRequest<LibraryPage>(`/documents?${params}`)
      if (!mounted.current || generation !== collectionGeneration.current) return
      setPage(current => ({ ...result, documents: [...current.documents, ...result.documents.filter(document => !current.documents.some(existing => existing.id === document.id))] }))
      setDocuments(current => ({ ...current, ...Object.fromEntries(result.documents.map(document => [document.id, document])) }))
    } catch (reason) { if (mounted.current && generation === collectionGeneration.current) setError(reason instanceof Error ? reason.message : 'No se pudo cargar la siguiente página.') } finally { if (mounted.current && generation === collectionGeneration.current) setLoading(false) }
  }

  async function downloadDraft() {
    if (!active) return
    const draft = active
    try {
      const slots = new Set(draft.session.slotNames?.() ?? draft.document.slots.map(slot => slot.slot))
      for (const name of slots) {
        const blob = draft.session.getSlot(name) ?? await draft.session.readSlot(name)
        if (!blob || !mounted.current || workspaceRef.current.active_id !== draft.document.id) continue
        const panel = name === 'panel-b' || name === 'original-b' ? 'b' : 'a'
        const formats = draft.document.config['json.formats'] as Record<string, unknown> | undefined
        const originals = draft.document.config['json.originalNames'] as Record<string, unknown> | undefined
        const plain = draft.document.config['json.plainText'] as Record<string, unknown> | undefined
        const format = formats?.[panel]
        const originalName = typeof originals?.[panel] === 'string' ? originals[panel] as string : undefined
        const extension = name.startsWith('panel-') && isDocumentFormat(format) ? documentExportExtension(format, originalName, plain?.[panel] === true) : blob.type.startsWith('image/') ? blob.type.split('/')[1] : 'txt'
        let downloadBlob = blob
        if (name.startsWith('panel-') && format === 'xml' && extension !== 'txt') {
          const source = await blob.text()
          const prepared = prepareUtf8XmlDownload(source, source.includes('http://www.w3.org/2000/09/xmldsig#'))
          if (!mounted.current || workspaceRef.current.active_id !== draft.document.id) return
          if (!prepared.ok) { setError(prepared.message); continue }
          if (prepared.source !== source) downloadBlob = new Blob([prepared.source], { type: 'application/xml;charset=utf-8' })
        }
        const url = URL.createObjectURL(downloadBlob), link = document.createElement('a')
        link.href = url; link.download = name.startsWith('original-') && originalName ? originalName : `${draft.document.title}-${name}.${extension}`
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'No se pudo descargar el borrador. Reintenta.') }
  }

  const closeDialog = useCallback(() => setDialog(null), [])
  const newActions: UtilityMenuAction[] = utilities.map(utility => ({ id: utility.id, label: utility.title, icon: Plus, disabled: busy || !ready, onSelect: () => { void createDocument(utility.id) } }))
  const documentActions: UtilityMenuAction[] = activeDocument ? [
    { id: 'rename', label: 'Renombrar documento', icon: Pencil, disabled: busy, onSelect: () => setDialog({ kind: 'rename', document: activeDocument }) },
    { id: 'left', label: 'Mover pestaña a la izquierda', icon: ChevronLeft, disabled: busy || workspace.open_ids[0] === activeDocument.id, onSelect: () => persistWorkspace({ ...workspaceRef.current, open_ids: moveOpenDocument(workspaceRef.current.open_ids, activeDocument.id, -1) }) },
    { id: 'right', label: 'Mover pestaña a la derecha', icon: ChevronRight, disabled: busy || workspace.open_ids.at(-1) === activeDocument.id, onSelect: () => persistWorkspace({ ...workspaceRef.current, open_ids: moveOpenDocument(workspaceRef.current.open_ids, activeDocument.id, 1) }) },
    { id: 'favorite', label: activeDocument.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos', icon: Star, disabled: busy, onSelect: () => { void changeMetadata(activeDocument, { favorite: !activeDocument.favorite }) } },
    { id: 'folder', label: 'Mover documento a carpeta', icon: Folder, disabled: busy, onSelect: () => setDialog({ kind: 'move', document: activeDocument }) },
    { id: 'duplicate', label: 'Duplicar documento', icon: Copy, disabled: busy, onSelect: () => { void duplicateDocument(activeDocument) } },
    { id: 'download', label: 'Descargar borrador', icon: Download, onSelect: () => { void downloadDraft() } },
    { id: 'delete', label: 'Eliminar documento', icon: Trash2, destructive: true, disabled: busy, onSelect: () => setDialog({ kind: 'delete', document: activeDocument }) },
  ] : []
  const libraryPanel = <aside key="library" ref={librarySurface} className="flex h-full min-h-0 shrink-0 flex-col border-r border-slate-200 bg-slate-50" style={{ width: wide ? 224 : drawerBounds.panelWidth }} aria-label="Mis documentos">
    <div className="flex h-11 shrink-0 items-center justify-between gap-1 px-2"><h2 className="text-xs font-semibold text-slate-700">Documentos</h2><button type="button" className={`${button} ${type || folder !== null ? 'bg-emerald-50 text-emerald-800' : ''}`} aria-label="Filtrar documentos" aria-haspopup="dialog" aria-expanded={Boolean(filterAnchor)} onClick={event => { const target = event.currentTarget; setFilterAnchor(current => current ? null : target) }}><ListFilter size={15} aria-hidden /></button></div>
    <div className="space-y-1 px-2 pb-2">
      <label className="relative block"><Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" /><input aria-label="Buscar documentos por nombre o contenido" className={`${field} pl-8 text-xs`} placeholder="Nombre o contenido" value={query} maxLength={128} onChange={event => { setQuery(event.target.value); if (!event.target.value) settleQuery('') }} /></label>
      {query !== settledQuery && <p role="status" className="px-1 text-[11px] text-slate-500">Preparando búsqueda…</p>}
      <div className="grid grid-cols-2 gap-1"><button type="button" className={`${button} ${!favorite && folder === null ? 'bg-white text-emerald-800 shadow-sm' : ''}`} onClick={() => { setFavorite(false); setFolder(null) }}>Recientes</button><button type="button" aria-pressed={favorite} className={`${button} ${favorite ? 'bg-white text-emerald-800 shadow-sm' : ''}`} onClick={() => { setFavorite(value => !value); setFolder(null) }}><Star size={13} aria-hidden />Favoritos</button></div>
      {(type || folder !== null) && <p className="truncate px-1 text-[11px] text-emerald-700">{[type ? utilityById(type)?.title : '', folder ? folders.find(item => item.id === folder)?.name : folder === '' ? 'Sin carpeta' : ''].filter(Boolean).join(' · ')}</p>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto border-t border-slate-200 p-1" aria-live="polite">
      {loading && page.documents.length === 0 && <p role="status" className="p-2 text-xs text-slate-500">Cargando documentos…</p>}
      {!loading && page.documents.length === 0 && <p className="p-2 text-xs leading-5 text-slate-500">{settledQuery ? 'No hay documentos que coincidan.' : 'Tus documentos aparecerán aquí. Crea uno para comenzar.'}</p>}
      {page.documents.map(document => <div key={document.id} className={`utility-library-row flex w-full min-w-0 items-start rounded-lg ${workspace.active_id === document.id ? 'bg-emerald-50' : 'hover:bg-slate-100'}`}>
        <button type="button" className="flex min-w-0 flex-1 items-start gap-2 rounded-lg p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald-600" disabled={busy} onClick={() => void openDocument(document)}><Braces size={14} aria-hidden className="mt-0.5 shrink-0 text-slate-400" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-slate-800">{document.favorite && '★ '}{document.title}</span><span className="block truncate text-[10px] leading-4 text-slate-500">{utilityById(document.type)?.title} · {new Date(document.updated_at).toLocaleDateString('es-PE')}</span>{document.snippet && <span className="mt-1 block line-clamp-2 break-all text-[11px] text-slate-600">{document.snippet}</span>}</span></button>
        <UtilityActionMenu label={`Acciones de ${document.title}`} className={`${button} mt-1 shrink-0 px-1`} actions={[
          { id: 'rename', label: 'Renombrar documento', icon: Pencil, disabled: busy, onSelect: () => setDialog({ kind: 'rename', document }) },
          { id: 'delete', label: 'Eliminar documento', icon: Trash2, disabled: busy, destructive: true, onSelect: () => setDialog({ kind: 'delete', document }) },
        ]} />
      </div>)}
      {page.has_more && <button className={`${button} w-full`} disabled={loading} onClick={() => void loadMore()}>{loading ? 'Cargando…' : 'Cargar más'}</button>}
    </div>
    <footer className="shrink-0"><SessionTimingSummary compact /></footer>
  </aside>
  return <section ref={host} aria-label="Biblioteca personal de Utilitarios" data-library-layout={wide ? 'wide' : 'narrow'} data-library-compact={compact} className="utility-density-scope relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
    <h1 className="sr-only">Utilitarios</h1>
    <header data-utility-workspace-header className="flex h-11 min-h-11 min-w-0 shrink-0 items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-1">
      <button ref={libraryTrigger} type="button" disabled={busy} className={`${button} shrink-0 ${libraryOpen ? 'bg-emerald-50 text-emerald-800' : ''}`} aria-label={libraryOpen ? 'Cerrar biblioteca' : 'Abrir biblioteca'} aria-expanded={libraryOpen} title={libraryOpen ? 'Cerrar biblioteca' : 'Abrir biblioteca'} onClick={() => setLibraryOpen(!libraryOpen)}><Menu size={16} aria-hidden /></button>
      <div ref={tabsViewport} role="tablist" aria-label="Documentos abiertos" className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden" style={{ containerType: 'inline-size', scrollbarWidth: 'none' }}>
        {workspace.open_ids.map(id => { const document = sessions.current.get(id)?.document ?? documents[id]; if (!document) return null; return <div key={id} data-utility-tab-id={id} style={{ maxWidth: 'min(240px, 100cqw)' }} className={`flex shrink-0 items-center border-r border-slate-200 ${id === workspace.active_id ? 'border-b-2 border-b-emerald-600 bg-white' : ''}`}><button role="tab" type="button" aria-selected={id === workspace.active_id} aria-controls="utility-active-document" title={document.title} style={{ minWidth: 0, flex: '1 1 0%' }} className={`${button} max-w-44 justify-start rounded-none`} disabled={busy} onDoubleClick={() => { if (id === workspace.active_id && !busy) setDialog({ kind: 'rename', document }) }} onClick={() => void openDocument(document)}><span className="truncate">{document.title}</span>{sessions.current.get(id)?.dirty && <span aria-label="Cambios pendientes" className="text-amber-600">●</span>}</button><DocumentModeIndicator status={sessions.current.get(id)?.displayStatus} /><button type="button" className={`${button} shrink-0 px-1`} aria-label={`Cerrar pestaña ${document.title}`} disabled={busy} onClick={() => void closeDocument(id)}><X size={13} aria-hidden /></button></div> })}
      </div>
      <UtilityActionMenu label="Nuevo documento" actions={newActions} className={`${button} shrink-0`} icon={Plus} />
      <button type="button" className={`${button} shrink-0`} aria-label="Guardar documento" aria-keyshortcuts="Control+S Meta+S" title="Guardar documento (Ctrl+S / ⌘S)" disabled={!activeDocument || !ready || busy || Boolean(active?.loading)} onClick={() => void saveActive()}><Save size={15} aria-hidden /><span className={compact ? 'sr-only' : ''}>Guardar</span></button>
      <button type="button" style={{ width: compact ? 'var(--utility-control-size)' : 160 }} className={`${button} min-w-0 shrink-0 ${saveStatus.tone === 'error' ? 'text-rose-700' : saveStatus.tone === 'pending' ? 'text-amber-700' : confirmedActiveSave ? 'text-emerald-700' : 'text-slate-500'}`} aria-label="Estado del guardado" title={saveStatus.label} aria-haspopup="dialog" aria-expanded={Boolean(statusAnchor)} onClick={event => { const target = event.currentTarget; setStatusAnchor(current => current ? null : target) }}>{saveStatus.tone === 'pending' ? <Loader2 size={14} className={active?.phase === 'dirty' ? '' : 'motion-safe:animate-spin'} aria-hidden /> : <Check size={14} aria-hidden />}<span role="status" className={compact ? 'sr-only' : 'min-w-0 flex-1 truncate text-[11px]'}>{saveStatus.label}</span></button>
      {activeDocument && <UtilityActionMenu key={activeDocument.id} label="Acciones del documento" actions={documentActions} className={`${button} shrink-0`} />}
    </header>
    <div className="flex min-h-0 min-w-0 flex-1">
      {wide && libraryPanel}
      <div key="workspace" inert={overlay || undefined} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {error && <div role="alert" className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-900"><span>{error}</span><button type="button" className={button} aria-label="Cerrar aviso" onClick={() => setError('')}><X size={14} /></button></div>}
        {notice && <div role="status" className="flex shrink-0 items-center justify-between gap-2 border-b border-emerald-100 bg-emerald-50 px-3 py-1 text-xs text-emerald-900"><span>{notice}</span><button type="button" className={button} aria-label="Cerrar confirmación" onClick={() => setNotice('')}><X size={14} /></button></div>}
        {workspacePhase === 'error' && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-100 bg-amber-50 px-3 py-1 text-xs text-amber-900"><span>{workspaceError}</span><button type="button" className={button} onClick={() => void retryWorkspace()}>Guardar pestañas de esta ventana</button></div>}
        {indexSlow && <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 bg-amber-50 px-3 py-1 text-xs text-amber-900">La indexación está tardando. El documento está guardado y puedes seguir trabajando.<button type="button" className={button} onClick={() => setIndexRetry(value => value + 1)}>Reintentar comprobación</button></div>}
        {active && activeDocument ? <>
          {(active.phase === 'error' || active.phase === 'conflict') && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 bg-rose-50 px-3 py-1 text-xs text-rose-800"><span>{active.error} Tu borrador sigue disponible.</span>{active.phase === 'error' && <button className={button} disabled={busy} onClick={() => void retryActive()}>Reintentar</button>}<button className={button} disabled={busy} onClick={() => void duplicateDocument(activeDocument)}>Guardar una copia</button>{active.phase === 'conflict' && <button className={button} disabled={busy} onClick={() => void duplicateDocument(activeDocument, true)}>Guardar copia y cargar versión guardada</button>}<button className={button} disabled={busy} onClick={() => void downloadDraft()}>Descargar borrador</button></div>}
          <div id="utility-active-document" role="tabpanel" aria-busy={transitioning || undefined} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <div ref={editorSurface} inert={transitioning || undefined} className="flex min-h-0 min-w-0 flex-1 overflow-hidden"><UtilityDocumentProvider key={`${activeDocument.id}:${editorGeneration}`} value={active.session}><UtilityWorkspace utility={utilityById(activeDocument.type)!} embedded /></UtilityDocumentProvider></div>
            {transitioning && <div className="absolute inset-0 flex items-center justify-center bg-slate-100/70 p-4"><p role="status" className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm">Guardando y abriendo documento…</p></div>}
          </div>
        </> : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><Braces size={32} className="text-emerald-600" /><h2 className="text-lg font-semibold text-slate-900">Un lugar para cada trabajo</h2><p className="max-w-sm text-sm leading-6 text-slate-500">Crea un documento o abre uno de tu biblioteca. Puedes trabajar en varias pestañas y volver a ellas después.</p><p className="max-w-sm text-xs leading-5 text-slate-500">Los documentos se guardan en tu cuenta, solo para ti. Cerrar una pestaña conserva su contenido.</p></div>}
      </div>
    </div>
    {overlay && createPortal(<div data-utility-library-overlay className="fixed bg-slate-950/20" style={{ left: drawerBounds.left, top: drawerBounds.top, width: drawerBounds.width, height: drawerBounds.height, zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover }} onMouseDown={event => { if (event.target === event.currentTarget) { setLibraryOpen(false); libraryTrigger.current?.focus({ preventScroll: true }) } }}>{libraryPanel}</div>, document.body)}
    {filterAnchor && <EditorPopover anchor={filterAnchor} label="Filtros de documentos" onClose={() => setFilterAnchor(null)} width={256}><div className="utility-density-scope space-y-2"><label className="block text-xs font-medium">Tipo<select aria-label="Filtrar por tipo" className={`${field} mt-1`} value={type} onChange={event => setType(event.target.value)}><option value="">Todos los tipos</option>{utilities.map(utility => <option key={utility.id} value={utility.id}>{utility.title}</option>)}</select></label><div className="flex items-center justify-between text-xs font-medium"><span>Carpetas</span><button className={button} aria-label="Nueva carpeta" onClick={() => { setFilterAnchor(null); setDialog({ kind: 'folder' }) }}><FolderPlus size={15} /></button></div><div className="max-h-40 overflow-y-auto"><button type="button" className={`${button} w-full justify-start`} onClick={() => setFolder(null)}>Todas las carpetas</button><button type="button" className={`${button} w-full justify-start`} onClick={() => setFolder('')}>Sin carpeta</button>{folders.map(item => <button type="button" key={item.id} className={`${button} w-full justify-start ${folder === item.id ? 'bg-emerald-50 text-emerald-800' : ''}`} onClick={() => { setFolder(item.id); setFavorite(false) }}><Folder size={14} /><span className="truncate">{item.name}</span></button>)}</div><button type="button" className={`${button} w-full`} onClick={() => setFilterAnchor(null)}>Cerrar filtros</button></div></EditorPopover>}
    {statusAnchor && <EditorPopover anchor={statusAnchor} label="Estado del documento y las pestañas" onClose={() => setStatusAnchor(null)} width={280}><div className="utility-density-scope space-y-2 p-1 text-xs leading-5"><p className="font-semibold">{saveStatus.label}</p><p>{workspacePhase === 'saved' ? 'Pestañas confirmadas en el servidor.' : workspacePhase === 'saving' ? 'Guardando el orden y la pestaña activa.' : workspaceError}</p>{indexingIds && <p>Indexando contenido para la búsqueda. El contenido ya guardado sigue disponible.</p>}{active?.loading && <p>Abriendo el contenido guardado…</p>}<SessionTimingSummary /><button type="button" className={button} onClick={() => setStatusAnchor(null)}>Cerrar detalle</button></div></EditorPopover>}
    {dialog && <LibraryDialog key={dialog.kind + ('document' in dialog ? dialog.document.id : '')} dialog={dialog} folders={folders} busy={busy} error={dialogError} onClose={closeDialog} onSubmit={submitDialog} />}
  </section>
}
