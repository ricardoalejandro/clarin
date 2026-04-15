'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { X, FileText, Download, Loader2, Image, FileDown, Sparkles, ArrowLeft, Eye } from 'lucide-react'
import { api } from '@/lib/api'
import type { DocumentTemplate } from '@/types/document'
import type { Lead } from '@/types/contact'
import {
  generateForLead,
  downloadBlob,
  parseCanvasJson,
  substituteFields,
  type RenderOptions,
} from '@/utils/documentGeneration'

interface Props {
  lead: Lead
  onClose: () => void
}

export default function GenerateDocumentModal({ lead, onClose }: Props) {
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
  const [format, setFormat] = useState<'png' | 'pdf'>('pdf')
  const [quality, setQuality] = useState<'normal' | 'hd'>('normal')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null)
  const [previewFilename, setPreviewFilename] = useState('')
  const previewUrlRef = useRef<string | null>(null)

  // Cleanup object URL on unmount or when preview changes
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
      }
    }
  }, [])

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

  const handleGenerate = useCallback(async () => {
    if (!selectedTemplate) return
    setGenerating(true)
    setError('')

    try {
      // Fetch full template with canvas_json (List endpoint omits it)
      const fullRes = await api<{ template: DocumentTemplate }>(`/api/document-templates/${selectedTemplate.id}`)
      if (!fullRes.success || !fullRes.data?.template) {
        setError('Error al cargar la plantilla completa')
        setGenerating(false)
        return
      }
      const fullTemplate = fullRes.data.template

      const opts: RenderOptions = {
        format,
        scale: quality === 'hd' ? 4 : 2,
      }
      const blob = await generateForLead(fullTemplate, lead, opts)
      const leadName = `${lead.name || ''} ${lead.last_name || ''}`.trim() || lead.phone || 'documento'
      const safeName = leadName.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s_-]/g, '').replace(/\s+/g, '_')
      const ext = format === 'png' ? 'png' : 'pdf'
      const filename = `${safeName}_${selectedTemplate.name}.${ext}`

      // Revoke previous preview URL if any
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
      }
      const url = URL.createObjectURL(blob)
      previewUrlRef.current = url
      setPreviewUrl(url)
      setPreviewBlob(blob)
      setPreviewFilename(filename)
    } catch (err) {
      console.error('Document generation error:', err)
      setError('Error al generar el documento')
    } finally {
      setGenerating(false)
    }
  }, [selectedTemplate, format, quality, lead])

  const handleDownload = useCallback(() => {
    if (previewBlob && previewFilename) {
      downloadBlob(previewBlob, previewFilename)
    }
  }, [previewBlob, previewFilename])

  const handleBackToOptions = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setPreviewUrl(null)
    setPreviewBlob(null)
    setPreviewFilename('')
  }, [])

  const leadFullName = `${lead.name || ''} ${lead.last_name || ''}`.trim() || lead.phone

  // Get preview of substituted fields for selected template
  const previewFields = selectedTemplate?.canvas_json ? (() => {
    const { elements } = parseCanvasJson(selectedTemplate)
    const dynamic = elements.filter(el => el.isDynamic && el.fieldName)
    if (dynamic.length === 0) return null
    const substituted = substituteFields(dynamic, lead)
    return dynamic.map((el, i) => ({
      field: el.fieldName!,
      value: substituted[i].content || '—',
    }))
  })() : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full mx-4 max-h-[85vh] overflow-hidden flex flex-col ${previewUrl ? 'max-w-3xl' : 'max-w-lg'}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            {previewUrl && (
              <button onClick={handleBackToOptions} className="p-1.5 hover:bg-slate-100 rounded-lg transition mr-1" title="Volver">
                <ArrowLeft className="w-4 h-4 text-slate-500" />
              </button>
            )}
            <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center">
              {previewUrl ? <Eye className="w-4 h-4 text-emerald-600" /> : <FileText className="w-4 h-4 text-emerald-600" />}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-800">{previewUrl ? 'Vista previa' : 'Generar Documento'}</h3>
              <p className="text-xs text-slate-500">{previewUrl ? previewFilename : leadFullName}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg transition">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {previewUrl ? (
            /* Preview view */
            <div className="flex flex-col items-center">
              {format === 'png' ? (
                <img
                  src={previewUrl}
                  alt="Vista previa del documento"
                  className="max-w-full rounded-lg border border-slate-200 shadow-sm"
                />
              ) : (
                <iframe
                  src={previewUrl}
                  title="Vista previa del documento"
                  className="w-full rounded-lg border border-slate-200 shadow-sm"
                  style={{ height: '60vh' }}
                />
              )}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-emerald-500 animate-spin" />
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-10 text-slate-500">
              <FileText className="w-10 h-10 mx-auto mb-3 text-slate-300" />
              <p className="text-sm font-medium">No hay plantillas disponibles</p>
              <p className="text-xs text-slate-400 mt-1">Crea una plantilla en el editor de documentos</p>
            </div>
          ) : (
            <>
              {/* Template selector */}
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
                          {t.fields_used.length} campo{t.fields_used.length !== 1 ? 's' : ''} dinámico{t.fields_used.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Preview of substituted fields */}
              {selectedTemplate && previewFields && previewFields.length > 0 && (
                <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                  <h4 className="text-xs font-semibold text-slate-500 mb-2 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3" />
                    Campos a sustituir
                  </h4>
                  <div className="space-y-1">
                    {previewFields.map((pf, i) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <span className="text-slate-500">{pf.field}</span>
                        <span className="text-slate-800 font-medium truncate ml-2 max-w-[200px]">{pf.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Options */}
              {selectedTemplate && (
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs font-medium text-slate-600 mb-1.5 block">Formato</label>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => setFormat('pdf')}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition border ${
                          format === 'pdf'
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        <FileDown className="w-3.5 h-3.5" />
                        PDF
                      </button>
                      <button
                        onClick={() => setFormat('png')}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition border ${
                          format === 'png'
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50'
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
                          quality === 'normal'
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        Normal
                      </button>
                      <button
                        onClick={() => setQuality('hd')}
                        className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition border ${
                          quality === 'hd'
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        HD
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {error && (
            <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-end gap-2">
          {previewUrl ? (
            <>
              <button
                onClick={handleBackToOptions}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Volver
              </button>
              <button
                onClick={handleDownload}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition"
              >
                <Download className="w-4 h-4" />
                Descargar
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancelar
              </button>
              <button
                onClick={handleGenerate}
                disabled={!selectedTemplate || generating}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {generating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generando...
                  </>
                ) : (
                  <>
                    <Eye className="w-4 h-4" />
                    Generar y previsualizar
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
