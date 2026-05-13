'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  AudioLines,
  Download,
  ExternalLink,
  File,
  Grid3X3,
  HardDrive,
  Image,
  LayoutList,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Video,
  X,
} from 'lucide-react'

interface StorageUsage {
  limit_bytes: number
  used_bytes: number
  available_bytes: number
  object_count: number
  percent_used: number
  can_manage: boolean
  by_type: Record<string, number>
  by_folder?: Record<string, number>
  associated_bytes?: number
  orphan_bytes?: number
  associated_count?: number
  orphan_count?: number
}

interface StorageFile {
  object_key: string
  media_url: string
  preview_url?: string
  media_type: string
  filename: string
  size_bytes: number
  last_modified?: string
  last_used_at?: string
  references_count: number
  status: 'associated' | 'orphan'
  folder?: string
}

type ViewMode = 'grid' | 'list'

function formatBytes(bytes?: number) {
  const value = bytes || 0
  if (value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let idx = 0
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024
    idx++
  }
  return `${size >= 10 || idx === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[idx]}`
}

function fileDate(file: StorageFile) {
  const raw = file.last_used_at || file.last_modified
  if (!raw) return 'Sin fecha'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return 'Sin fecha'
  return date.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' })
}

function iconForType(type: string, className = 'w-5 h-5 text-emerald-600') {
  if (type === 'image') return <Image className={className} />
  if (type === 'video') return <Video className={className} />
  if (type === 'audio') return <AudioLines className={className} />
  return <File className={className} />
}

function isPreviewableDocument(file: StorageFile) {
  return /\.pdf($|\?)/i.test(file.filename) || /\.pdf($|\?)/i.test(file.media_url)
}

function isOfficeDocument(file: StorageFile) {
  return /\.(doc|docx|xls|xlsx|ppt|pptx)($|\?)/i.test(file.filename) || /\.(doc|docx|xls|xlsx|ppt|pptx)($|\?)/i.test(file.media_url)
}

function documentReason(file: StorageFile) {
  if (isOfficeDocument(file)) {
    return 'Los archivos Word, Excel y PowerPoint no se pueden renderizar de forma confiable dentro del navegador sin convertirlos o enviarlos a un visor externo.'
  }
  return 'Este formato no tiene una vista previa integrada en el navegador. El archivo sigue disponible para abrirlo o descargarlo.'
}

function DocumentFallback({ file }: { file: StorageFile }) {
  return (
    <div className="bg-white rounded-2xl p-8 text-center max-w-md mx-4">
      <div className="w-14 h-14 rounded-2xl bg-amber-50 flex items-center justify-center mx-auto mb-4">
        <AlertCircle className="w-7 h-7 text-amber-600" />
      </div>
      <p className="text-sm font-semibold text-slate-900">No se pudo mostrar la vista previa</p>
      <p className="text-xs text-slate-500 mt-2 leading-relaxed">{documentReason(file)}</p>
      <div className="mt-5 flex flex-col sm:flex-row justify-center gap-2">
        <a href={file.media_url} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
          <ExternalLink className="w-4 h-4" />
          Abrir archivo
        </a>
        <a href={file.media_url} download className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-50">
          <Download className="w-4 h-4" />
          Descargar
        </a>
      </div>
    </div>
  )
}

export default function StoragePage() {
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [files, setFiles] = useState<StorageFile[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [preview, setPreview] = useState<StorageFile | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [type, setType] = useState('')
  const [status, setStatus] = useState('all')
  const [sortBy, setSortBy] = useState('date')
  const [order, setOrder] = useState('desc')

  useEffect(() => {
    const saved = localStorage.getItem('storage_view_mode')
    if (saved === 'grid' || saved === 'list') {
      setViewMode(saved)
    } else {
      localStorage.setItem('storage_view_mode', 'list')
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 500)
    return () => clearTimeout(timer)
  }, [query])

  const changeView = (mode: ViewMode) => {
    setViewMode(mode)
    localStorage.setItem('storage_view_mode', mode)
  }

  const showMessage = useCallback((type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 3000)
  }, [])

  const fetchStorage = useCallback(async () => {
    setLoading(true)
    const token = localStorage.getItem('token')
    const params = new URLSearchParams({
      limit: '200',
      status,
      sort: sortBy,
      order,
    })
    if (debouncedQuery) params.set('q', debouncedQuery)
    if (type) params.set('type', type)

    try {
      const [usageRes, filesRes] = await Promise.all([
        fetch('/api/storage/usage', { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/storage/files?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } }),
      ])
      const usageData = await usageRes.json()
      const filesData = await filesRes.json()
      if (usageData.success) setUsage(usageData)
      if (filesData.success) setFiles(filesData.files || [])
      if (!usageData.success || !filesData.success) {
        showMessage('error', filesData.error || usageData.error || 'No se pudo cargar el almacenamiento')
      }
    } catch {
      showMessage('error', 'No se pudo cargar el almacenamiento')
    } finally {
      setLoading(false)
    }
  }, [debouncedQuery, order, showMessage, sortBy, status, type])

  useEffect(() => {
    fetchStorage()
  }, [fetchStorage])

  const deleteFile = async (file: StorageFile) => {
    const label = file.status === 'orphan' ? 'archivo no asociado' : 'archivo del chat'
    if (!confirm(`¿Eliminar este ${label}: "${file.filename}"? Esta acción libera espacio y no se puede deshacer.`)) return
    setDeleting(file.object_key)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/storage/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ object_keys: [file.object_key], confirmation: 'DELETE_MEDIA' }),
      })
      const data = await res.json()
      if (data.success) {
        showMessage('success', `Archivo eliminado. Liberado: ${formatBytes(data.freed_bytes)}`)
        setPreview(null)
        fetchStorage()
      } else {
        showMessage('error', data.error || 'No se pudo eliminar')
      }
    } catch {
      showMessage('error', 'No se pudo eliminar')
    } finally {
      setDeleting(null)
    }
  }

  const typeCards = useMemo(() => ([
    { key: '', label: 'Todo', value: usage?.used_bytes || 0, icon: HardDrive },
    { key: 'image', label: 'Imágenes', value: usage?.by_type?.image || 0, icon: Image },
    { key: 'video', label: 'Videos', value: usage?.by_type?.video || 0, icon: Video },
    { key: 'audio', label: 'Audios', value: usage?.by_type?.audio || 0, icon: AudioLines },
    { key: 'document', label: 'Documentos', value: usage?.by_type?.document || 0, icon: File },
  ]), [usage])

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {message && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${message.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'}`}>
          {message.text}
        </div>
      )}

      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
            <HardDrive className="w-5 h-5 text-emerald-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Almacenamiento</h1>
            <p className="text-sm text-slate-500">Explora, previsualiza y libera espacio de la cuenta.</p>
          </div>
        </div>
        <button
          onClick={fetchStorage}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Actualizar
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4 min-h-0 xl:flex-1 xl:overflow-hidden">
        <div className="min-w-0 min-h-0 flex flex-col gap-4 overflow-hidden">
          <section className="bg-slate-900 rounded-2xl p-5 text-white">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-emerald-500/15 flex items-center justify-center">
                  <HardDrive className="w-8 h-8 text-emerald-300" />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Usado</p>
                  <div className="text-3xl font-semibold tabular-nums">{formatBytes(usage?.used_bytes)}</div>
                  <p className="text-xs text-slate-400">
                    {usage?.limit_bytes ? `${formatBytes(usage.available_bytes)} disponibles de ${formatBytes(usage.limit_bytes)}` : 'Sin límite configurado'}
                  </p>
                </div>
              </div>
              <div className="md:w-80">
                <div className="flex justify-between text-xs text-slate-400 mb-2">
                  <span>{usage?.object_count || 0} archivos</span>
                  <span>{usage?.limit_bytes ? `${Math.round(usage.percent_used)}%` : 'Ilimitado'}</span>
                </div>
                <div className="h-3 rounded-full bg-slate-700 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${(usage?.percent_used || 0) >= 90 ? 'bg-red-500' : (usage?.percent_used || 0) >= 75 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                    style={{ width: `${usage?.limit_bytes ? Math.min(100, usage.percent_used) : 0}%` }}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {typeCards.map(item => {
              const Icon = item.icon
              return (
                <button
                  key={item.key || 'all'}
                  onClick={() => setType(item.key)}
                  className={`text-left p-4 rounded-xl border bg-white transition-colors ${type === item.key ? 'border-emerald-300 ring-2 ring-emerald-100' : 'border-slate-200 hover:bg-slate-50'}`}
                >
                  <Icon className="w-5 h-5 text-emerald-600 mb-2" />
                  <p className="text-sm font-medium text-slate-900 truncate">{item.label}</p>
                  <p className="text-xs text-slate-500">{formatBytes(item.value)}</p>
                </button>
              )
            })}
          </section>

          <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden min-h-0 flex-1 flex flex-col">
            <div className="p-4 border-b border-slate-200 space-y-3">
              <div className="flex flex-col lg:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Buscar por nombre de archivo..."
                    className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <select value={status} onChange={e => setStatus(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white text-slate-700">
                    <option value="all">Todos</option>
                    <option value="associated">Asociados</option>
                    <option value="orphan">No asociados</option>
                  </select>
                  <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white text-slate-700">
                    <option value="date">Fecha</option>
                    <option value="size">Tamaño</option>
                    <option value="name">Nombre</option>
                  </select>
                  <button onClick={() => setOrder(order === 'desc' ? 'asc' : 'desc')} className="p-2 border border-slate-200 rounded-xl text-slate-500 hover:text-slate-900 hover:bg-slate-50">
                    {sortBy === 'name' ? <ArrowDownAZ className="w-4 h-4" /> : <ArrowDownWideNarrow className="w-4 h-4" />}
                  </button>
                  <div className="flex border border-slate-200 rounded-xl overflow-hidden">
                    <button onClick={() => changeView('grid')} className={`p-2 ${viewMode === 'grid' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`} title="Vista cuadrícula">
                      <Grid3X3 className="w-4 h-4" />
                    </button>
                    <button onClick={() => changeView('list')} className={`p-2 ${viewMode === 'list' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`} title="Vista lista">
                      <LayoutList className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {loading ? (
              <div className={`min-h-0 flex-1 overflow-y-auto ${viewMode === 'grid' ? 'grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 p-4 content-start' : 'p-4 space-y-2'}`}>
                {[...Array(8)].map((_, i) => <div key={i} className={viewMode === 'grid' ? 'aspect-square bg-slate-100 rounded-xl animate-pulse' : 'h-14 bg-slate-100 rounded-xl animate-pulse'} />)}
              </div>
            ) : files.length === 0 ? (
              <div className="min-h-0 flex-1 overflow-y-auto py-16 text-center">
                <HardDrive className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                <p className="text-sm font-medium text-slate-700">No hay archivos para mostrar</p>
                <p className="text-xs text-slate-400">Ajusta los filtros o vuelve a actualizar.</p>
              </div>
            ) : viewMode === 'grid' ? (
              <div className="min-h-0 flex-1 overflow-y-auto grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 p-4 content-start">
                {files.map(file => (
                  <button key={file.object_key} onClick={() => setPreview(file)} className="group text-left border border-slate-200 rounded-xl overflow-hidden bg-white hover:shadow-md transition-all">
                    <div className="aspect-square bg-slate-100 relative overflow-hidden flex items-center justify-center">
                      {file.media_type === 'image' ? (
                        <img src={file.preview_url || file.media_url} alt={file.filename} className="w-full h-full object-cover" loading="lazy" />
                      ) : file.media_type === 'video' ? (
                        <>
                          <video src={file.preview_url || file.media_url} className="w-full h-full object-cover" muted preload="metadata" />
                          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                            <div className="w-10 h-10 rounded-full bg-white/90 flex items-center justify-center">
                              <Play className="w-5 h-5 text-slate-900 ml-0.5" />
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="w-14 h-14 rounded-2xl bg-white flex items-center justify-center shadow-sm">
                          {iconForType(file.media_type, 'w-7 h-7 text-emerald-600')}
                        </div>
                      )}
                      {file.status === 'orphan' && (
                        <span className="absolute top-2 left-2 text-[11px] px-2 py-1 rounded-full bg-amber-100 text-amber-700 font-medium">No asociado</span>
                      )}
                    </div>
                    <div className="p-3">
                      <p className="text-sm font-medium text-slate-900 truncate">{file.filename || 'Archivo'}</p>
                      <p className="text-xs text-slate-500">{formatBytes(file.size_bytes)} · {fileDate(file)}</p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-slate-100">
                {files.map(file => (
                  <div key={file.object_key} className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50">
                    <button onClick={() => setPreview(file)} className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center shrink-0 overflow-hidden">
                      {file.media_type === 'image' ? <img src={file.preview_url || file.media_url} alt="" className="w-full h-full object-cover" loading="lazy" /> : iconForType(file.media_type)}
                    </button>
                    <button onClick={() => setPreview(file)} className="min-w-0 flex-1 text-left">
                      <p className="text-sm font-medium text-slate-900 truncate">{file.filename || 'Archivo'}</p>
                      <p className="text-xs text-slate-500">
                        {formatBytes(file.size_bytes)} · {fileDate(file)} · {file.references_count} referencia{file.references_count === 1 ? '' : 's'}
                        {file.status === 'orphan' ? ' · No asociado' : ''}
                      </p>
                    </button>
                    {usage?.can_manage && (
                      <button onClick={() => deleteFile(file)} disabled={deleting === file.object_key} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-50" title="Eliminar archivo">
                        {deleting === file.object_key ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-4 overflow-y-auto min-h-0">
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Auditoría</h2>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Asociados</span>
                <span className="font-medium text-slate-900">{formatBytes(usage?.associated_bytes)} · {usage?.associated_count || 0}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">No asociados</span>
                <span className="font-medium text-amber-700">{formatBytes(usage?.orphan_bytes)} · {usage?.orphan_count || 0}</span>
              </div>
            </div>
            {!!usage?.orphan_count && (
              <div className="mt-4 flex gap-2 rounded-xl bg-amber-50 border border-amber-100 p-3 text-xs text-amber-800">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p>Los no asociados existen en MinIO pero no tienen mensaje activo. Revísalos antes de eliminarlos.</p>
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Carpetas</h2>
            <div className="space-y-2 text-sm">
              {Object.entries(usage?.by_folder || {}).map(([folder, bytes]) => (
                <div key={folder} className="flex items-center justify-between gap-3">
                  <span className="text-slate-500 capitalize">{folder}</span>
                  <span className="font-medium text-slate-900">{formatBytes(bytes)}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-slate-900 truncate">{preview.filename}</h2>
                <p className="text-xs text-slate-500">{formatBytes(preview.size_bytes)} · {preview.status === 'orphan' ? 'No asociado' : `${preview.references_count} referencia${preview.references_count === 1 ? '' : 's'}`}</p>
              </div>
              <div className="flex items-center gap-2">
                <a href={preview.media_url} target="_blank" rel="noreferrer" className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg" title="Abrir">
                  <ExternalLink className="w-4 h-4" />
                </a>
                <a href={preview.media_url} download className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg" title="Descargar">
                  <Download className="w-4 h-4" />
                </a>
                {usage?.can_manage && (
                  <button onClick={() => deleteFile(preview)} disabled={deleting === preview.object_key} className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Eliminar">
                    {deleting === preview.object_key ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                )}
                <button onClick={() => setPreview(null)} className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg" title="Cerrar">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="bg-slate-950 flex-1 min-h-[420px] max-h-[75vh] flex items-center justify-center">
              {preview.media_type === 'image' ? (
                <img src={preview.preview_url || preview.media_url} alt={preview.filename} className="max-w-full max-h-[75vh] object-contain" />
              ) : preview.media_type === 'video' ? (
                <video src={preview.preview_url || preview.media_url} className="max-w-full max-h-[75vh]" controls autoPlay />
              ) : preview.media_type === 'audio' ? (
                <div className="bg-white rounded-2xl p-6 w-full max-w-lg">
                  <AudioLines className="w-10 h-10 text-emerald-600 mb-4" />
                  <audio src={preview.preview_url || preview.media_url} controls className="w-full" />
                </div>
              ) : isPreviewableDocument(preview) ? (
                <object data={preview.preview_url || preview.media_url} type="application/pdf" className="w-full h-[75vh] bg-white">
                  <DocumentFallback file={preview} />
                </object>
              ) : (
                <DocumentFallback file={preview} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
