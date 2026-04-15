'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { X, FileText, Download, Loader2, Image, FileDown, Package, CheckSquare, Square } from 'lucide-react'
import { api } from '@/lib/api'
import type { DocumentTemplate } from '@/types/document'
import type { Lead } from '@/types/contact'
import {
  generateBulk,
  packageAsZip,
  mergePdfs,
  downloadBlob,
  type RenderOptions,
  type BulkProgress,
} from '@/utils/documentGeneration'

type OutputMode = 'zip-individual' | 'pdf-multipage'

interface Props {
  leads: Lead[]
  onClose: () => void
}

export default function BulkGenerateDocumentModal({ leads, onClose }: Props) {
  const [templates, setTemplates] = useState<DocumentTemplate[]>([])
  const [loading, setLoading] = useState(true)

  // Close on Escape — stop propagation so parent handlers don't fire
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [onClose])
  const [selectedTemplate, setSelectedTemplate] = useState<DocumentTemplate | null>(null)
  const [step, setStep] = useState<'template' | 'options' | 'generating'>('template')

  // Options
  const [format, setFormat] = useState<'png' | 'pdf'>('pdf')
  const [quality, setQuality] = useState<'normal' | 'hd'>('normal')
  const [outputMode, setOutputMode] = useState<OutputMode>('zip-individual')

  // Lead selection (subset from passed leads, max 50)
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(() => {
    const ids = new Set<string>()
    leads.slice(0, 50).forEach(l => ids.add(l.id))
    return ids
  })

  // Progress
  const [progress, setProgress] = useState<BulkProgress | null>(null)
  const [error, setError] = useState('')
  const cancelledRef = useRef(false)

  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ templates: DocumentTemplate[] }>('/api/document-templates')
        if (res.success && res.data?.templates) {
          setTemplates(res.data.templates)
        }
      } catch {
        setError('Error al cargar plantillas')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const toggleLead = (id: string) => {
    setSelectedLeadIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else if (next.size < 50) {
        next.add(id)
      }
      return next
    })
  }

  const toggleAll = () => {
    if (selectedLeadIds.size === Math.min(leads.length, 50)) {
      setSelectedLeadIds(new Set())
    } else {
      const ids = new Set<string>()
      leads.slice(0, 50).forEach(l => ids.add(l.id))
      setSelectedLeadIds(ids)
    }
  }

  const selectedLeads = leads.filter(l => selectedLeadIds.has(l.id))

  const handleGenerate = useCallback(async () => {
    if (!selectedTemplate || selectedLeads.length === 0) return

    // Fetch full template with canvas_json (List endpoint omits it)
    let fullTemplate: typeof selectedTemplate
    try {
      const fullRes = await api<{ template: typeof selectedTemplate }>(`/api/document-templates/${selectedTemplate.id}`)
      if (!fullRes.success || !fullRes.data?.template) {
        setError('Error al cargar la plantilla completa')
        return
      }
      fullTemplate = fullRes.data.template
    } catch {
      setError('Error al cargar la plantilla completa')
      return
    }

    setStep('generating')
    setError('')
    cancelledRef.current = false

    try {
      const opts: RenderOptions = {
        format: outputMode === 'pdf-multipage' ? 'pdf' : format,
        scale: quality === 'hd' ? 4 : 2,
      }

      const onProgress = (p: BulkProgress) => {
        if (cancelledRef.current) throw new Error('Cancelled')
        setProgress(p)
      }

      const templateName = fullTemplate.name.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s_-]/g, '').replace(/\s+/g, '_')

      if (outputMode === 'pdf-multipage') {
        const blob = await mergePdfs(fullTemplate, selectedLeads, { scale: opts.scale }, onProgress)
        downloadBlob(blob, `${templateName}_${selectedLeads.length}_leads.pdf`)
      } else {
        const results = await generateBulk(fullTemplate, selectedLeads, opts, onProgress)
        if (results.length === 1) {
          downloadBlob(results[0].blob, results[0].filename)
        } else {
          const zipBlob = await packageAsZip(results)
          downloadBlob(zipBlob, `${templateName}_${results.length}_documentos.zip`)
        }
      }

      onClose()
    } catch (err: any) {
      if (err?.message === 'Cancelled') return
      console.error('Bulk generation error:', err)
      setError('Error al generar documentos')
      setStep('options')
    }
  }, [selectedTemplate, selectedLeads, format, quality, outputMode, onClose])

  const handleCancel = () => {
    cancelledRef.current = true
    setStep('options')
    setProgress(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl mx-4 max-h-[85vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center">
              <Package className="w-4 h-4 text-emerald-600" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Generación Masiva de Documentos</h3>
              <p className="text-xs text-slate-500">{leads.length} lead{leads.length !== 1 ? 's' : ''} disponible{leads.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg transition">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-emerald-500 animate-spin" />
            </div>
          ) : step === 'generating' ? (
            /* Progress */
            <div className="py-8 space-y-4">
              <div className="text-center">
                <Loader2 className="w-8 h-8 text-emerald-500 animate-spin mx-auto mb-3" />
                <p className="text-sm font-medium text-slate-700">Generando documentos...</p>
                {progress && (
                  <p className="text-xs text-slate-500 mt-1">
                    {progress.current} de {progress.total} — {progress.leadName}
                  </p>
                )}
              </div>
              {progress && (
                <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-emerald-500 h-full rounded-full transition-all duration-300"
                    style={{ width: `${(progress.current / progress.total) * 100}%` }}
                  />
                </div>
              )}
              <button
                onClick={handleCancel}
                className="w-full px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancelar
              </button>
            </div>
          ) : step === 'template' ? (
            /* Template selector */
            <>
              {templates.length === 0 ? (
                <div className="text-center py-10 text-slate-500">
                  <FileText className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                  <p className="text-sm font-medium">No hay plantillas disponibles</p>
                </div>
              ) : (
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-2 block">Seleccionar plantilla</label>
                  <div className="grid grid-cols-2 gap-2">
                    {templates.map(t => (
                      <button
                        key={t.id}
                        onClick={() => setSelectedTemplate(t)}
                        className={`flex flex-col items-start p-3 rounded-xl border-2 transition text-left ${
                          selectedTemplate?.id === t.id
                            ? 'border-emerald-500 bg-emerald-50'
                            : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {t.thumbnail_url ? (
                          <img
                            src={t.thumbnail_url}
                            alt={t.name}
                            className="w-full h-20 object-cover rounded-lg mb-2 bg-slate-100"
                          />
                        ) : (
                          <div className="w-full h-20 bg-slate-100 rounded-lg mb-2 flex items-center justify-center">
                            <FileText className="w-6 h-6 text-slate-300" />
                          </div>
                        )}
                        <span className="text-xs font-medium text-slate-700 truncate w-full">{t.name}</span>
                        {t.fields_used && t.fields_used.length > 0 && (
                          <span className="text-[10px] text-slate-400 mt-0.5">
                            {t.fields_used.length} campo{t.fields_used.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Options step */
            <>
              {/* Lead selection */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-medium text-slate-600">
                    Leads seleccionados ({selectedLeadIds.size}/{Math.min(leads.length, 50)})
                  </label>
                  <button
                    onClick={toggleAll}
                    className="text-xs text-emerald-600 hover:text-emerald-700 font-medium"
                  >
                    {selectedLeadIds.size === Math.min(leads.length, 50) ? 'Deseleccionar todos' : 'Seleccionar todos'}
                  </button>
                </div>
                <div className="border border-slate-200 rounded-xl max-h-40 overflow-y-auto">
                  {leads.slice(0, 50).map(l => (
                    <button
                      key={l.id}
                      onClick={() => toggleLead(l.id)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-50 transition text-sm border-b border-slate-50 last:border-b-0"
                    >
                      {selectedLeadIds.has(l.id) ? (
                        <CheckSquare className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                      ) : (
                        <Square className="w-4 h-4 text-slate-300 flex-shrink-0" />
                      )}
                      <span className="text-slate-700 truncate">{l.name} {l.last_name || ''}</span>
                      {l.phone && <span className="text-slate-400 text-xs ml-auto flex-shrink-0">{l.phone}</span>}
                    </button>
                  ))}
                </div>
                {leads.length > 50 && (
                  <p className="text-[10px] text-amber-600 mt-1">Máximo 50 leads por lote. Mostrando los primeros 50.</p>
                )}
              </div>

              {/* Format & Quality */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-xs font-medium text-slate-600 mb-1.5 block">Formato</label>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setFormat('pdf')}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition border ${
                        format === 'pdf' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <FileDown className="w-3.5 h-3.5" />
                      PDF
                    </button>
                    <button
                      onClick={() => { setFormat('png'); if (outputMode === 'pdf-multipage') setOutputMode('zip-individual') }}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition border ${
                        format === 'png' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <Image className="w-3.5 h-3.5" />
                      PNG
                    </button>
                  </div>
                </div>
                <div className="flex-1">
                  <label className="text-xs font-medium text-slate-600 mb-1.5 block">Calidad</label>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setQuality('normal')}
                      className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition border ${
                        quality === 'normal' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      Normal
                    </button>
                    <button
                      onClick={() => setQuality('hd')}
                      className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition border ${
                        quality === 'hd' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      HD
                    </button>
                  </div>
                </div>
              </div>

              {/* Output mode */}
              <div>
                <label className="text-xs font-medium text-slate-600 mb-1.5 block">Salida</label>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setOutputMode('zip-individual')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition border ${
                      outputMode === 'zip-individual' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <Package className="w-3.5 h-3.5" />
                    ZIP (individual)
                  </button>
                  {format === 'pdf' && (
                    <button
                      onClick={() => setOutputMode('pdf-multipage')}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition border ${
                        outputMode === 'pdf-multipage' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <FileDown className="w-3.5 h-3.5" />
                      PDF multi-página
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {error && (
            <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}
        </div>

        {/* Footer */}
        {step !== 'generating' && (
          <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between">
            {step === 'options' ? (
              <button
                onClick={() => setStep('template')}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                ← Volver
              </button>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancelar
              </button>
              {step === 'template' ? (
                <button
                  onClick={() => setStep('options')}
                  disabled={!selectedTemplate}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Siguiente →
                </button>
              ) : (
                <button
                  onClick={handleGenerate}
                  disabled={selectedLeadIds.size === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="w-4 h-4" />
                  Generar {selectedLeadIds.size} documento{selectedLeadIds.size !== 1 ? 's' : ''}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
