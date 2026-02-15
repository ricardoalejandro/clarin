'use client'

import { useState, useRef } from 'react'
import { Upload, FileText, X, AlertTriangle, CheckCircle2 } from 'lucide-react'

interface ImportCSVModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
  defaultType?: 'leads' | 'contacts' | 'both'
}

export default function ImportCSVModal({ open, onClose, onSuccess }: ImportCSVModalProps) {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!open) return null

  const handleUpload = async () => {
    if (!file) return
    setUploading(true)
    setResult(null)

    const token = localStorage.getItem('token')
    const formData = new FormData()
    formData.append('file', file)
    formData.append('import_type', 'leads')

    try {
      const res = await fetch('/api/import/csv', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const data = await res.json()
      if (data.success) {
        setResult({ imported: data.imported, skipped: data.skipped, errors: data.errors || [] })
        onSuccess()
      } else {
        setResult({ imported: 0, skipped: 0, errors: [data.error || 'Error desconocido'] })
      }
    } catch {
      setResult({ imported: 0, skipped: 0, errors: ['Error de conexión'] })
    } finally {
      setUploading(false)
    }
  }

  const handleClose = () => {
    setFile(null)
    setResult(null)
    setUploading(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md border border-gray-100">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Importar Leads</h2>
            <p className="text-sm text-gray-500 mt-0.5">Sube un archivo CSV con los datos</p>
          </div>
          <button onClick={handleClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {!result ? (
          <div className="space-y-4">
            {/* File upload */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={e => setFile(e.target.files?.[0] || null)}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-gray-200 rounded-xl p-8 text-center hover:border-green-400 hover:bg-green-50/30 transition group"
              >
                {file ? (
                  <div className="flex items-center justify-center gap-3">
                    <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                      <FileText className="w-5 h-5 text-green-600" />
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-medium text-gray-900">{file.name}</p>
                      <p className="text-xs text-gray-400">{(file.size / 1024).toFixed(1)} KB</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mx-auto mb-3 group-hover:bg-green-100 transition">
                      <Upload className="w-6 h-6 text-gray-400 group-hover:text-green-600 transition" />
                    </div>
                    <p className="text-sm font-medium text-gray-700">Haz clic para seleccionar un archivo</p>
                    <p className="text-xs text-gray-400 mt-1">CSV, máximo 10MB</p>
                  </>
                )}
              </button>
            </div>

            {/* Column guide */}
            <div className="bg-gray-50 rounded-xl p-3.5 text-xs text-gray-600 space-y-1">
              <p className="font-medium text-gray-700">Columnas reconocidas:</p>
              <p><span className="text-green-600 font-medium">Requerida:</span> phone / telefono / celular</p>
              <p><span className="text-gray-500 font-medium">Opcionales:</span> name, email, apellido, empresa, notas, tags</p>
            </div>

            <div className="flex gap-3 mt-5">
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2.5 border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 font-medium text-sm transition"
              >
                Cancelar
              </button>
              <button
                onClick={handleUpload}
                disabled={!file || uploading}
                className="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-xl hover:bg-green-700 disabled:opacity-50 font-medium text-sm transition"
              >
                {uploading ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                    Importando...
                  </span>
                ) : (
                  'Importar'
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {result.imported > 0 ? (
              <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-100 rounded-xl">
                <div className="w-10 h-10 bg-green-100 rounded-xl flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="font-medium text-green-800">{result.imported} leads importados</p>
                  {result.skipped > 0 && (
                    <p className="text-sm text-green-600">{result.skipped} filas omitidas</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-100 rounded-xl">
                <AlertTriangle className="w-6 h-6 text-red-500 shrink-0" />
                <p className="font-medium text-red-700">No se importaron registros</p>
              </div>
            )}

            {result.errors.length > 0 && (
              <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-amber-700 mb-1">Errores ({result.errors.length}):</p>
                {result.errors.slice(0, 10).map((e, i) => (
                  <p key={i} className="text-xs text-amber-600">{e}</p>
                ))}
              </div>
            )}

            <button
              onClick={handleClose}
              className="w-full px-4 py-2.5 bg-green-600 text-white rounded-xl hover:bg-green-700 font-medium text-sm transition"
            >
              Cerrar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
