'use client'

import { useState, useRef } from 'react'
import { Upload, FileText, X, AlertTriangle, CheckCircle2 } from 'lucide-react'

interface ImportCSVModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
  defaultType?: 'leads' | 'contacts' | 'both'
}

export default function ImportCSVModal({ open, onClose, onSuccess, defaultType = 'leads' }: ImportCSVModalProps) {
  const [importType, setImportType] = useState<'leads' | 'contacts' | 'both'>(defaultType)
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
    formData.append('import_type', importType)

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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-900">Importar CSV</h2>
          <button onClick={handleClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {!result ? (
          <div className="space-y-4">
            {/* Import type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Importar como</label>
              <div className="flex gap-2">
                {(['leads', 'contacts', 'both'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setImportType(t)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                      importType === t
                        ? 'bg-green-50 border-green-500 text-green-700'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {t === 'leads' ? 'Leads' : t === 'contacts' ? 'Contactos' : 'Ambos'}
                  </button>
                ))}
              </div>
            </div>

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
                className="w-full border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-green-400 hover:bg-green-50/50 transition"
              >
                {file ? (
                  <div className="flex items-center justify-center gap-2">
                    <FileText className="w-5 h-5 text-green-600" />
                    <span className="text-sm font-medium text-gray-900">{file.name}</span>
                    <span className="text-xs text-gray-400">({(file.size / 1024).toFixed(1)} KB)</span>
                  </div>
                ) : (
                  <>
                    <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                    <p className="text-sm text-gray-600">Haz clic para seleccionar un archivo CSV</p>
                  </>
                )}
              </button>
            </div>

            {/* Column guide */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
              <p className="font-medium mb-1">Columnas reconocidas:</p>
              <p><strong>Requerida:</strong> phone / telefono / celular</p>
              <p><strong>Opcionales:</strong> name / nombre, email / correo, apellido, empresa / company, notas / notes, tags / etiquetas</p>
            </div>

            <div className="flex gap-3 mt-4">
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleUpload}
                disabled={!file || uploading}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {uploading ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
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
              <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
                <CheckCircle2 className="w-6 h-6 text-green-600 shrink-0" />
                <div>
                  <p className="font-medium text-green-800">{result.imported} registros importados</p>
                  {result.skipped > 0 && (
                    <p className="text-sm text-green-600">{result.skipped} filas omitidas (sin teléfono)</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
                <AlertTriangle className="w-6 h-6 text-red-600 shrink-0" />
                <p className="font-medium text-red-800">No se pudo importar registros</p>
              </div>
            )}

            {result.errors.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-amber-800 mb-1">Errores ({result.errors.length}):</p>
                {result.errors.slice(0, 10).map((e, i) => (
                  <p key={i} className="text-xs text-amber-700">{e}</p>
                ))}
                {result.errors.length > 10 && (
                  <p className="text-xs text-amber-500">...y {result.errors.length - 10} más</p>
                )}
              </div>
            )}

            <button
              onClick={handleClose}
              className="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
            >
              Cerrar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
