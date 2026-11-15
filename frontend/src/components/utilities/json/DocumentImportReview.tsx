'use client'

import { useMemo } from 'react'
import EditorConfirmDialog from '@/components/documents/EditorConfirmDialog'

export const DOCUMENT_IMPORT_PREVIEW_LIMIT = 1200
const PREVIEW_LINES = 8

/** Show a bounded sample near a character that helps distinguish encodings. */
export function documentImportPreview(source: string) {
  const replacement = source.indexOf('\uFFFD')
  const nonAscii = replacement >= 0 ? replacement : source.search(/[^\x09\x0A\x0D\x20-\x7E]/)
  const target = Math.max(0, nonAscii)
  let start = Math.max(0, target - 200)
  // Keep the interesting character inside the line budget, including files
  // with many very short lines immediately before it.
  const before = source.slice(start, target).split('\n')
  if (before.length > 4) start += before.slice(0, before.length - 4).join('\n').length + 1
  if (start > 0 && /[\uDC00-\uDFFF]/.test(source[start] ?? '')) start--
  let end = Math.min(source.length, start + DOCUMENT_IMPORT_PREVIEW_LIMIT - 2)
  let lines = 1
  for (let at = start; at < end; at++) {
    if (source[at] === '\n' && ++lines > PREVIEW_LINES) { end = at; break }
  }
  if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end] ?? '')) end--
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`
}

interface Props {
  fileName: string
  source: string
  encoding?: string
  warnings?: readonly string[]
  busy?: boolean
  onApply: () => void
  onCancel: () => void
  onChooseEncoding: () => void
}

const button = 'utility-control inline-flex max-w-full items-center justify-center rounded-lg border border-slate-200 px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-50'

export function DocumentImportReview({ fileName, source, encoding, warnings = [], busy = false, onApply, onCancel, onChooseEncoding }: Props) {
  const preview = useMemo(() => documentImportPreview(source), [source])
  return <EditorConfirmDialog title="Revisar codificación" onCancel={() => { if (!busy) onCancel() }} actions={<>
    <button type="button" className={button} disabled={busy} onClick={onCancel}>Cancelar</button>
    <button type="button" className={button} disabled={busy} onClick={onChooseEncoding}>Elegir otra codificación</button>
    <button type="button" className={`${button} border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800`} disabled={busy} onClick={onApply}>Usar esta codificación y abrir</button>
  </>}>
    <div className="max-h-[50dvh] min-w-0 space-y-3 overflow-y-auto pr-1">
      <p className="truncate font-medium text-slate-800" title={fileName}>{fileName}</p>
      <p>Vista previa{encoding ? ` en ${encoding.toUpperCase()}` : ''}. Comprueba los acentos y los símbolos antes de abrir.</p>
      {warnings.length > 0 && <ul className="space-y-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-900" aria-label="Avisos de codificación">{warnings.map((warning, index) => <li className="break-words" key={index}>{warning}</li>)}</ul>}
      <label className="block space-y-1 text-xs font-medium text-slate-700">Muestra del contenido
        <textarea aria-label="Vista previa de la codificación" readOnly value={preview} rows={5} spellCheck={false} className="block h-28 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono text-xs font-normal leading-5 text-slate-800" />
      </label>
      <p className="text-xs leading-5">Esta vista previa todavía no se autoguarda. Al aceptar se conservará una copia del archivo original y se abrirá el texto elegido para trabajar.</p>
    </div>
  </EditorConfirmDialog>
}
