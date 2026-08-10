'use client'

import { useRef, useState } from 'react'
import {
  Archive,
  Download,
  FilePlus2,
  LibraryBig,
  Loader2,
  LockKeyhole,
  Pencil,
  RefreshCw,
  Save,
  Share2,
  Upload,
  X,
} from 'lucide-react'
import WhiteboardModal from './WhiteboardModal'

export type WhiteboardLibrarySaveState = 'saved' | 'pending' | 'saving' | 'conflict' | 'error'
export type WhiteboardLibraryCatalogVisibility = 'private' | 'account'

export interface WhiteboardLibraryCatalogSummary {
  id: string
  name: string
  itemCount: number
  description?: string
  visibility?: WhiteboardLibraryCatalogVisibility
  version?: number
  /** Server-derived capability. Never infer mutation authority from visibility. */
  canManage?: boolean
}

export interface WhiteboardLibraryCatalogDraft {
  name: string
  description: string
  visibility: WhiteboardLibraryCatalogVisibility
  /** Present only when a new catalog is being created from .excalidrawlib. */
  sourceFile: File | null
}

export interface WhiteboardLibraryCatalogBusyState {
  action: 'create' | 'update' | 'archive' | 'export'
  catalogID?: string
}

export type WhiteboardLibraryCatalogActionResult = boolean | void | Promise<boolean | void>

interface CatalogFormState {
  mode: 'create' | 'import' | 'edit'
  catalogID: string | null
  name: string
  description: string
  visibility: WhiteboardLibraryCatalogVisibility
  sourceFile: File | null
}

const emptyCatalogForm = (mode: 'create' | 'import'): CatalogFormState => ({
  mode,
  catalogID: null,
  name: '',
  description: '',
  visibility: 'private',
  sourceFile: null,
})

function catalogVisibilityLabel(visibility: WhiteboardLibraryCatalogVisibility | undefined) {
  return visibility === 'private' ? 'Privado' : 'Compartido con la cuenta'
}

export default function WhiteboardLibraryDialog({
  personalItemCount,
  catalogs,
  saveState,
  error,
  onImport,
  onExport,
  onSave,
  onReload,
  onClose,
  canManageCatalogs = false,
  catalogBusy = null,
  catalogError = null,
  onCreateCatalog,
  onUpdateCatalog,
  onArchiveCatalog,
  onExportCatalog,
}: {
  personalItemCount: number
  catalogs: WhiteboardLibraryCatalogSummary[]
  saveState: WhiteboardLibrarySaveState
  error: string | null
  onImport: () => void
  onExport: () => void
  onSave: () => void
  onReload: () => void
  onClose: () => void
  canManageCatalogs?: boolean
  catalogBusy?: WhiteboardLibraryCatalogBusyState | null
  catalogError?: string | null
  onCreateCatalog?: (draft: WhiteboardLibraryCatalogDraft) => WhiteboardLibraryCatalogActionResult
  onUpdateCatalog?: (catalogID: string, draft: Omit<WhiteboardLibraryCatalogDraft, 'sourceFile'>, expectedVersion: number) => WhiteboardLibraryCatalogActionResult
  onArchiveCatalog?: (catalogID: string, expectedVersion: number) => WhiteboardLibraryCatalogActionResult
  onExportCatalog?: (catalogID: string) => WhiteboardLibraryCatalogActionResult
}) {
  const catalogImportRef = useRef<HTMLInputElement>(null)
  const [catalogForm, setCatalogForm] = useState<CatalogFormState | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<WhiteboardLibraryCatalogSummary | null>(null)
  const [localCatalogBusy, setLocalCatalogBusy] = useState(false)
  const [localCatalogError, setLocalCatalogError] = useState<string | null>(null)
  const saving = saveState === 'saving'
  const catalogMutationBusy = Boolean(catalogBusy) || localCatalogBusy

  const beginCreate = () => {
    setArchiveTarget(null)
    setLocalCatalogError(null)
    setCatalogForm(emptyCatalogForm('create'))
  }

  const beginEdit = (catalog: WhiteboardLibraryCatalogSummary) => {
    if (!catalog.canManage || !Number.isInteger(catalog.version)) return
    setArchiveTarget(null)
    setLocalCatalogError(null)
    setCatalogForm({
      mode: 'edit',
      catalogID: catalog.id,
      name: catalog.name,
      description: catalog.description || '',
      visibility: catalog.visibility || 'account',
      sourceFile: null,
    })
  }

  const selectImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null
    event.target.value = ''
    if (!file) return
    if (!file.name.toLocaleLowerCase('en').endsWith('.excalidrawlib') || file.size > 8 * 1024 * 1024) {
      setLocalCatalogError('Selecciona un archivo .excalidrawlib de hasta 8 MB.')
      return
    }
    setArchiveTarget(null)
    setLocalCatalogError(null)
    setCatalogForm({
      ...emptyCatalogForm('import'),
      name: file.name.replace(/\.excalidrawlib$/i, '').trim() || 'Biblioteca importada',
      sourceFile: file,
    })
  }

  const submitCatalog = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!catalogForm || catalogMutationBusy) return
    const name = catalogForm.name.trim()
    const description = catalogForm.description.trim()
    if (!name) {
      setLocalCatalogError('Escribe un nombre para el catálogo.')
      return
    }
    setLocalCatalogBusy(true)
    setLocalCatalogError(null)
    try {
      let result: boolean | void
      if (catalogForm.mode === 'edit') {
        const catalog = catalogs.find(item => item.id === catalogForm.catalogID)
        if (!catalog?.canManage || !Number.isInteger(catalog.version) || !onUpdateCatalog) return
        result = await onUpdateCatalog(catalog.id, {
          name,
          description,
          visibility: catalogForm.visibility,
        }, catalog.version as number)
      } else {
        if (!canManageCatalogs || !onCreateCatalog) return
        result = await onCreateCatalog({
          name,
          description,
          visibility: catalogForm.visibility,
          sourceFile: catalogForm.sourceFile,
        })
      }
      if (result !== false) setCatalogForm(null)
    } catch (actionError) {
      setLocalCatalogError(actionError instanceof Error ? actionError.message : 'No se pudo guardar el catálogo.')
    } finally {
      setLocalCatalogBusy(false)
    }
  }

  const confirmArchive = async () => {
    const catalog = archiveTarget
    if (!catalog?.canManage || !Number.isInteger(catalog.version) || !onArchiveCatalog || catalogMutationBusy) return
    setLocalCatalogBusy(true)
    setLocalCatalogError(null)
    try {
      const result = await onArchiveCatalog(catalog.id, catalog.version as number)
      if (result !== false) setArchiveTarget(null)
    } catch (actionError) {
      setLocalCatalogError(actionError instanceof Error ? actionError.message : 'No se pudo archivar el catálogo.')
    } finally {
      setLocalCatalogBusy(false)
    }
  }

  const exportCatalog = async (catalogID: string) => {
    if (!onExportCatalog || catalogMutationBusy) return
    setLocalCatalogBusy(true)
    setLocalCatalogError(null)
    try {
      await onExportCatalog(catalogID)
    } catch (actionError) {
      setLocalCatalogError(actionError instanceof Error ? actionError.message : 'No se pudo exportar el catálogo.')
    } finally {
      setLocalCatalogBusy(false)
    }
  }

  return <WhiteboardModal
    title="Bibliotecas de Pizarras"
    description="Mi biblioteca es personal. Los catálogos se administran dentro de Clarin y nunca se publican en servicios externos."
    onClose={onClose}
    wide
  >
    <div className="divide-y divide-slate-100">
      {(error || saveState === 'conflict') && <div className={`m-5 rounded-2xl border px-4 py-3 text-sm leading-5 ${saveState === 'conflict' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-rose-200 bg-rose-50 text-rose-800'}`} role="alert">
        {error || 'La biblioteca cambió en otra sesión. Clarin conservó la versión del servidor y añadió únicamente tus elementos nuevos; revisa y confirma la conciliación.'}
      </div>}

      <section className="p-5" aria-labelledby="whiteboard-personal-library-title">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><LibraryBig className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <h3 id="whiteboard-personal-library-title" className="text-sm font-black text-slate-900">Mi biblioteca</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">{personalItemCount} {personalItemCount === 1 ? 'elemento privado' : 'elementos privados'} guardados dentro de tu cuenta de Clarin.</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${saveState === 'saved' ? 'bg-emerald-50 text-emerald-700' : saveState === 'conflict' ? 'bg-amber-100 text-amber-800' : saveState === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-sky-50 text-sky-700'}`}>
            {saveState === 'saved' ? 'Guardada' : saveState === 'saving' ? 'Guardando…' : saveState === 'conflict' ? 'Revisar conflicto' : saveState === 'error' ? 'Error' : 'Pendiente'}
          </span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={onImport} disabled={saving} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"><Upload className="h-4 w-4" />Importar en Mi biblioteca</button>
          <button type="button" onClick={onExport} disabled={personalItemCount === 0 || saving} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"><Download className="h-4 w-4" />Exportar mi biblioteca</button>
          {(saveState === 'pending' || saveState === 'error' || saveState === 'conflict') && <button type="button" onClick={onSave} disabled={saving} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-3 text-sm font-black text-white disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{saveState === 'conflict' ? 'Guardar conciliación' : 'Guardar ahora'}</button>}
          <button type="button" onClick={onReload} disabled={saving || catalogMutationBusy} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-40"><RefreshCw className="h-4 w-4" />Recargar bibliotecas</button>
        </div>
      </section>

      <section className="p-5" aria-labelledby="whiteboard-account-libraries-title" aria-busy={catalogMutationBusy}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 id="whiteboard-account-libraries-title" className="text-sm font-black text-slate-900">Catálogos internos</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">Los compartidos están disponibles para la cuenta. Un catálogo privado sólo lo ve su creador y los administradores autorizados.</p>
          </div>
          {canManageCatalogs && onCreateCatalog && <div className="flex flex-wrap gap-2">
            <button type="button" onClick={beginCreate} disabled={catalogMutationBusy} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-3 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-40"><FilePlus2 className="h-4 w-4" />Nuevo catálogo</button>
            <button type="button" onClick={() => catalogImportRef.current?.click()} disabled={catalogMutationBusy} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"><Upload className="h-4 w-4" />Importar catálogo</button>
            <input ref={catalogImportRef} type="file" accept=".excalidrawlib,application/json" className="hidden" aria-label="Seleccionar archivo de catálogo" onChange={selectImport} />
          </div>}
        </div>

        {(catalogError || localCatalogError) && <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{localCatalogError || catalogError}</p>}

        {catalogForm && <form onSubmit={submitCatalog} className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4" aria-label={catalogForm.mode === 'edit' ? 'Editar catálogo' : catalogForm.mode === 'import' ? 'Importar catálogo' : 'Crear catálogo'}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-black text-slate-900">{catalogForm.mode === 'edit' ? 'Editar catálogo' : catalogForm.mode === 'import' ? 'Importar como catálogo interno' : 'Nuevo catálogo interno'}</p>
              {catalogForm.sourceFile && <p className="mt-1 truncate text-xs text-emerald-800">Archivo: {catalogForm.sourceFile.name}</p>}
            </div>
            <button type="button" onClick={() => setCatalogForm(null)} disabled={catalogMutationBusy} aria-label="Cancelar edición de catálogo" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-white disabled:opacity-40"><X className="h-4 w-4" /></button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-black uppercase tracking-[.1em] text-slate-500">Nombre<input autoFocus value={catalogForm.name} onChange={event => setCatalogForm(current => current ? { ...current, name: event.target.value } : current)} maxLength={160} className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold normal-case tracking-normal text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label>
            <label className="text-xs font-black uppercase tracking-[.1em] text-slate-500">Visibilidad<select value={catalogForm.visibility} onChange={event => setCatalogForm(current => current ? { ...current, visibility: event.target.value as WhiteboardLibraryCatalogVisibility } : current)} className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold normal-case tracking-normal text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"><option value="private">Privado</option><option value="account">Compartido con la cuenta</option></select></label>
          </div>
          <label className="mt-3 block text-xs font-black uppercase tracking-[.1em] text-slate-500">Descripción<textarea value={catalogForm.description} onChange={event => setCatalogForm(current => current ? { ...current, description: event.target.value } : current)} maxLength={1000} rows={3} className="mt-2 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setCatalogForm(null)} disabled={catalogMutationBusy} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-white disabled:opacity-40">Cancelar</button>
            <button type="submit" disabled={catalogMutationBusy || !catalogForm.name.trim()} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-40">{catalogMutationBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{catalogForm.mode === 'edit' ? 'Guardar cambios' : 'Crear catálogo'}</button>
          </div>
        </form>}

        {archiveTarget && <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4" role="alertdialog" aria-label="Confirmar archivo de catálogo">
          <p className="text-sm font-black text-amber-950">Archivar “{archiveTarget.name}”</p>
          <p className="mt-1 text-xs leading-5 text-amber-900">Dejará de ofrecerse en el editor, pero sus datos permanecerán dentro de Clarin para recuperación administrativa.</p>
          <div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => setArchiveTarget(null)} disabled={catalogMutationBusy} className="min-h-11 rounded-xl px-3 text-sm font-bold text-amber-900 hover:bg-white/70 disabled:opacity-40">Cancelar</button><button type="button" onClick={() => void confirmArchive()} disabled={catalogMutationBusy} className="flex min-h-11 items-center gap-2 rounded-xl bg-amber-900 px-3 text-sm font-black text-white disabled:opacity-40">{catalogMutationBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}Archivar catálogo</button></div>
        </div>}

        {catalogs.length === 0
          ? <p className="mt-4 rounded-xl bg-slate-50 px-3 py-4 text-sm text-slate-500">No hay catálogos internos disponibles.</p>
          : <div className="mt-4 grid gap-3 sm:grid-cols-2">{catalogs.map(catalog => {
            const visibility = catalog.visibility || 'account'
            const canManage = Boolean(catalog.canManage && Number.isInteger(catalog.version))
            const busy = catalogBusy?.catalogID === catalog.id || localCatalogBusy
            return <article key={catalog.id} className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
              <div className="flex items-start gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${visibility === 'private' ? 'bg-slate-100 text-slate-600' : 'bg-sky-50 text-sky-700'}`}>{visibility === 'private' ? <LockKeyhole className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-black text-slate-800">{catalog.name}</p><p className="mt-0.5 text-[10px] font-black uppercase tracking-wide text-slate-400">{catalogVisibilityLabel(visibility)} · {canManage ? 'Administrable' : 'Solo lectura'}</p></div>
              </div>
              {catalog.description && <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500">{catalog.description}</p>}
              <p className="mt-3 text-xs text-slate-500">{catalog.itemCount} {catalog.itemCount === 1 ? 'elemento' : 'elementos'}</p>
              <div className="mt-auto flex flex-wrap gap-1 pt-3">
                {onExportCatalog && <button type="button" onClick={() => void exportCatalog(catalog.id)} disabled={catalogMutationBusy} aria-label={`Exportar ${catalog.name}`} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">{busy && catalogBusy?.action === 'export' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Exportar</button>}
                {canManage && onUpdateCatalog && <button type="button" onClick={() => beginEdit(catalog)} disabled={catalogMutationBusy} aria-label={`Editar ${catalog.name}`} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40"><Pencil className="h-4 w-4" />Editar</button>}
                {canManage && onArchiveCatalog && <button type="button" onClick={() => { setCatalogForm(null); setLocalCatalogError(null); setArchiveTarget(catalog) }} disabled={catalogMutationBusy} aria-label={`Archivar ${catalog.name}`} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-bold text-amber-800 hover:bg-amber-50 disabled:opacity-40"><Archive className="h-4 w-4" />Archivar</button>}
              </div>
            </article>
          })}</div>}
      </section>
    </div>
  </WhiteboardModal>
}
