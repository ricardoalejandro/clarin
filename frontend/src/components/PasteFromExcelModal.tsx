'use client'

import { useState, useRef, useCallback } from 'react'
import { X, ClipboardPaste, Upload, CheckCircle2, AlertTriangle, Loader2, Trash2, Info } from 'lucide-react'

const COLUMNS = [
  { key: 'phone',     label: 'Teléfono',  required: true,  placeholder: '9XXXXXXXX' },
  { key: 'name',      label: 'Nombre',    required: false, placeholder: 'Juan' },
  { key: 'last_name', label: 'Apellido',  required: false, placeholder: 'Pérez' },
  { key: 'email',     label: 'Correo',    required: false, placeholder: 'email@ej.com' },
  { key: 'company',   label: 'Empresa',   required: false, placeholder: 'Empresa SA' },
  { key: 'tags',      label: 'Etiquetas', required: false, placeholder: 'vip, cliente' },
  { key: 'notes',     label: 'Notas',     required: false, placeholder: 'Nota libre' },
]

type Row = Record<string, string>

interface Result {
  created: number
  skipped: number
  errors: string[]
}

interface Props {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

export default function PasteFromExcelModal({ open, onClose, onSuccess }: Props) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [pasteError, setPasteError] = useState('')
  const pasteZoneRef = useRef<HTMLDivElement>(null)

  const emptyRow = (): Row =>
    Object.fromEntries(COLUMNS.map(c => [c.key, '']))

  const parseTSV = useCallback((text: string) => {
    // Normalize line endings (Google Sheets uses \r\n)
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = normalized.split('\n').filter(l => l.trim())
    if (lines.length === 0) return []

    // Detect separator: prefer tab (Excel/Sheets copy), fallback to comma, then semicolon
    const sample = lines[0]
    const tabCount = (sample.match(/\t/g) || []).length
    const commaCount = (sample.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g) || []).length // commas outside quotes
    const semiCount = (sample.match(/;/g) || []).length
    const sep = tabCount >= commaCount && tabCount >= semiCount ? '\t'
      : commaCount >= semiCount ? ',' : ';'

    // Split a line respecting quoted fields
    const splitLine = (line: string): string[] => {
      const cells: string[] = []
      let cur = ''
      let inQuote = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
          inQuote = !inQuote
        } else if (ch === sep && !inQuote) {
          cells.push(cur.trim().replace(/^["']|["']$/g, ''))
          cur = ''
        } else {
          cur += ch
        }
      }
      cells.push(cur.trim().replace(/^["']|["']$/g, ''))
      return cells
    }

    const firstCells = splitLine(lines[0])

    // Known EXACT header names — anchored with ^ $ so "email@ej.com" or "Empresa SA" DON'T match
    const headerSynonyms: Record<string, RegExp> = {
      phone:     /^(teléfono|telefono|phone|celular|móvil|movil|cel|numero|número)$/i,
      name:      /^(nombre|name|first.?name|nombres)$/i,
      last_name: /^(apellido|apellidos|last.?name)$/i,
      email:     /^(email|correo|e-?mail|correo electr[oó]nico)$/i,
      company:   /^(empresa|company|compañ[ií]a)$/i,
      tags:      /^(etiquetas?|tags?)$/i,
      notes:     /^(notas?|notes?|observaciones?)$/i,
    }

    // Count how many cells match known EXACT header names
    const headerColIndex: Record<string, number> = {}
    firstCells.forEach((cell, i) => {
      const trimmed = cell.trim()
      for (const [key, re] of Object.entries(headerSynonyms)) {
        if (re.test(trimmed) && !(key in headerColIndex)) {
          headerColIndex[key] = i
        }
      }
    })

    // Only consider it a header row if at least 2 cells are exact header matches
    const isHeader = Object.keys(headerColIndex).length >= 2

    let colIndex: Record<string, number>
    if (isHeader) {
      colIndex = headerColIndex
    } else {
      // No headers detected → positional mapping (columns in expected order)
      colIndex = {}
      COLUMNS.forEach((col, i) => { colIndex[col.key] = i })
    }

    const dataStart = isHeader ? 1 : 0

    return lines.slice(dataStart).map(line => {
      const cells = splitLine(line)
      const row: Row = emptyRow()
      COLUMNS.forEach(col => {
        const idx = colIndex[col.key]
        row[col.key] = idx !== undefined ? (cells[idx] ?? '') : ''
      })
      return row
    }).filter(row => row.phone || row.name)
  }, [])

  const handlePaste = useCallback((e: React.ClipboardEvent | ClipboardEvent) => {
    const text = (e as React.ClipboardEvent).clipboardData?.getData('text') ||
      (e as ClipboardEvent).clipboardData?.getData('text/plain') || ''
    if (!text) return
    setPasteError('')
    const parsed = parseTSV(text)
    if (parsed.length === 0) {
      setPasteError('No se detectaron filas válidas. Asegúrate de copiar celdas desde Excel o Google Sheets.')
      return
    }
    setRows(parsed)
    setResult(null)
  }, [parseTSV])

  const updateCell = (rowIdx: number, key: string, value: string) => {
    setRows(prev => {
      const next = [...prev]
      next[rowIdx] = { ...next[rowIdx], [key]: value }
      return next
    })
  }

  const removeRow = (rowIdx: number) => {
    setRows(prev => prev.filter((_, i) => i !== rowIdx))
  }

  const addEmptyRow = () => {
    setRows(prev => [...prev, emptyRow()])
  }

  const handleImport = async () => {
    const validRows = rows.filter(r => r.phone.trim())
    if (validRows.length === 0) {
      setPasteError('Debes tener al menos una fila con teléfono')
      return
    }

    setLoading(true)
    setPasteError('')
    try {
      const contacts = validRows.map(r => ({
        phone: r.phone.trim(),
        name: r.name.trim(),
        last_name: r.last_name.trim(),
        email: r.email.trim(),
        company: r.company.trim(),
        notes: r.notes.trim(),
        tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      }))

      const res = await fetch('/api/contacts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts }),
      })
      const data = await res.json()
      if (!data.success) {
        setPasteError(data.error || 'Error al importar')
        return
      }
      setResult({ created: data.created, skipped: data.skipped, errors: data.errors || [] })
      onSuccess()
    } catch {
      setPasteError('Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    setRows([])
    setResult(null)
    setPasteError('')
    onClose()
  }

  if (!open) return null

  const validCount = rows.filter(r => r.phone.trim()).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />
      <div className="relative bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-5xl mx-4 flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center">
              <ClipboardPaste className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-slate-100 font-semibold text-sm">Pegar desde Excel / Google Sheets</h2>
              <p className="text-slate-500 text-xs">Copia las celdas y pégalas aquí con Ctrl+V</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Result state */}
        {result ? (
          <div className="flex-1 flex items-center justify-center p-10">
            <div className="text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              </div>
              <div>
                <p className="text-slate-100 font-semibold text-lg">
                  {result.created} contacto{result.created !== 1 ? 's' : ''} importado{result.created !== 1 ? 's' : ''}
                </p>
                {result.skipped > 0 && (
                  <p className="text-slate-400 text-sm mt-1">
                    {result.skipped} omitido{result.skipped !== 1 ? 's' : ''} (teléfono inválido o duplicado)
                  </p>
                )}
              </div>
              {result.errors.length > 0 && (
                <div className="text-left bg-red-950/40 border border-red-500/20 rounded-lg p-3 max-h-32 overflow-y-auto">
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-red-400 text-xs">{e}</p>
                  ))}
                </div>
              )}
              <button
                onClick={handleClose}
                className="mt-2 px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Cerrar
              </button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          /* Paste zone */
          <div
            ref={pasteZoneRef}
            tabIndex={0}
            onPaste={handlePaste}
            onClick={() => pasteZoneRef.current?.focus()}
            className="flex-1 flex flex-col items-center justify-center p-10 cursor-pointer focus:outline-none group"
          >
            <div className="w-20 h-20 rounded-2xl bg-slate-800 border-2 border-dashed border-slate-700 group-focus:border-emerald-500/50 group-hover:border-slate-600 flex items-center justify-center mb-5 transition-colors">
              <ClipboardPaste className="w-8 h-8 text-slate-600 group-focus:text-emerald-400 transition-colors" />
            </div>
            <p className="text-slate-300 font-medium text-base mb-1">
              Haz clic aquí y pega con <kbd className="px-1.5 py-0.5 bg-slate-700 rounded text-xs font-mono">Ctrl+V</kbd>
            </p>
            <p className="text-slate-500 text-sm mb-6 text-center max-w-sm">
              Copia las celdas directamente desde Excel o Google Sheets. El orden esperado de columnas es:
            </p>
            <div className="flex flex-wrap gap-2 justify-center mb-6">
              {COLUMNS.map((col, i) => (
                <span key={col.key} className="px-3 py-1 bg-slate-800 rounded-lg text-xs text-slate-400 flex items-center gap-1">
                  <span className="text-slate-600 font-mono">{i + 1}</span>
                  {col.label}
                  {col.required && <span className="text-emerald-400">*</span>}
                </span>
              ))}
            </div>
            <div className="flex items-start gap-2 text-slate-500 text-xs bg-slate-800/50 rounded-lg px-4 py-2.5 max-w-sm">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-blue-400" />
              <span>Si tu hoja tiene encabezados, se detectarán y omitirán automáticamente.</span>
            </div>
            {pasteError && (
              <div className="mt-4 flex items-center gap-2 text-red-400 text-sm bg-red-950/40 border border-red-500/20 rounded-lg px-4 py-2.5">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {pasteError}
              </div>
            )}
          </div>
        ) : (
          /* Table editor */
          <>
            <div className="flex items-center gap-3 px-6 py-3 bg-slate-800/40 border-b border-slate-700/50 shrink-0">
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <span className="text-emerald-400 font-medium">{validCount}</span>
                <span>fila{validCount !== 1 ? 's' : ''} con teléfono</span>
                {rows.length - validCount > 0 && (
                  <span className="text-amber-400/70">· {rows.length - validCount} sin teléfono</span>
                )}
              </div>
              <div className="flex-1" />
              <button
                onClick={() => { setRows([]); setPasteError('') }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-slate-400 hover:text-slate-200 text-xs rounded-lg hover:bg-slate-700/50 transition-colors"
              >
                <ClipboardPaste className="w-3.5 h-3.5" />
                Pegar de nuevo
              </button>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-900 z-10">
                  <tr className="border-b border-slate-700/50">
                    <th className="w-8 py-2.5 px-3 text-slate-600 font-medium text-left">#</th>
                    {COLUMNS.map(col => (
                      <th key={col.key} className="py-2.5 px-2 text-slate-400 font-medium text-left whitespace-nowrap">
                        {col.label}
                        {col.required && <span className="text-emerald-400 ml-0.5">*</span>}
                      </th>
                    ))}
                    <th className="w-8 py-2.5 px-3" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr
                      key={ri}
                      className={`border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors ${!row.phone.trim() ? 'opacity-50' : ''}`}
                    >
                      <td className="py-1.5 px-3 text-slate-600 font-mono">{ri + 1}</td>
                      {COLUMNS.map(col => (
                        <td key={col.key} className="py-1 px-1">
                          <input
                            type="text"
                            value={row[col.key]}
                            placeholder={col.placeholder}
                            onChange={e => updateCell(ri, col.key, e.target.value)}
                            className={`w-full px-2 py-1.5 rounded text-sm font-medium text-slate-50 placeholder-slate-500 focus:outline-none transition-colors ${
                              col.required && !row[col.key]
                                ? 'bg-red-950/50 border border-red-500/40 focus:border-emerald-500/60 focus:bg-slate-600'
                                : 'bg-slate-600 border border-slate-500/50 hover:bg-slate-500 focus:bg-slate-600 focus:border-emerald-500/60'
                            }`}
                          />
                        </td>
                      ))}
                      <td className="py-1.5 px-2">
                        <button
                          onClick={() => removeRow(ri)}
                          className="w-6 h-6 flex items-center justify-center text-slate-700 hover:text-red-400 hover:bg-red-950/30 rounded transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Add row button */}
            <div className="px-6 py-2 border-t border-slate-700/30 shrink-0">
              <button
                onClick={addEmptyRow}
                className="text-xs text-slate-500 hover:text-emerald-400 transition-colors"
              >
                + Agregar fila vacía
              </button>
            </div>
          </>
        )}

        {/* Footer */}
        {rows.length > 0 && !result && (
          <div className="px-6 py-4 border-t border-slate-700/50 flex items-center justify-between shrink-0">
            {pasteError && (
              <div className="flex items-center gap-2 text-red-400 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {pasteError}
              </div>
            )}
            {!pasteError && <div />}
            <div className="flex items-center gap-3">
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleImport}
                disabled={loading || validCount === 0}
                className="flex items-center gap-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                {loading ? 'Importando…' : `Importar ${validCount} contacto${validCount !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
