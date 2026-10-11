import type { Canvas, StaticCanvas } from 'fabric'
import { validateDocumentCanvas } from '@/lib/documents/documentValidation'
export const DOCUMENT_EXPORT_PROFILES = {
  compact: { label: 'Ligero', dpi: 96, quality: 0.72 },
  balanced: { label: 'Equilibrado', dpi: 150, quality: 0.85 },
  print: { label: 'Impresión', dpi: 300, quality: 0.95 },
} as const
export interface ExportOptions { format: 'png' | 'pdf' | 'jpeg'; multiplier?: number; dpi?: number; quality?: number; scope?: 'page' | 'selection'; transparent?: boolean; signal?: AbortSignal }
export interface DocumentRenderSnapshot { canvasJson: Record<string, unknown>; width: number; height: number }
export function documentExportGeometry(width: number, height: number, options: Pick<ExportOptions, 'dpi' | 'multiplier'>) {
  if (![width, height].every(n => Number.isFinite(n) && n > 0 && n <= 1e7)) throw new Error('El área de exportación no es válida.')
  const requested = options.dpi !== undefined ? options.dpi / 50.8 : (options.multiplier ?? 150 / 50.8)
  if (!Number.isFinite(requested) || requested <= 0 || requested > 64) throw new Error('La resolución no es válida.')
  const multiplier = Math.min(requested, 16384 / width, 16384 / height, Math.sqrt(32_000_000 / (width * height)))
  return { multiplier, width: Math.max(1, Math.floor(width * multiplier)), height: Math.max(1, Math.floor(height * multiplier)), effectiveDpi: multiplier * 50.8, clamped: multiplier < requested }
}
function abortCheck(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Exportación cancelada', 'AbortError') }
export async function renderDocumentSnapshotWithPreview(snapshot: DocumentRenderSnapshot, options: ExportOptions): Promise<{ blob: Blob; preview: Blob }> {
  abortCheck(options.signal)
  const invalid = validateDocumentCanvas(snapshot.canvasJson); if (invalid) throw new Error(invalid)
  const geometry = documentExportGeometry(snapshot.width, snapshot.height, options)
  if (snapshot.width > 16384 || snapshot.height > 16384 || snapshot.width * snapshot.height > 32_000_000) throw new Error('El área seleccionada es demasiado grande. Acerca los elementos o exporta la página.')
  const { StaticCanvas } = await import('./runtime')
  const { loadTemplateToCanvas, ensureFontsLoaded } = await import('./serialization')
  await ensureFontsLoaded(); abortCheck(options.signal)
  const canvas = new StaticCanvas(undefined, { width: snapshot.width, height: snapshot.height, renderOnAddRemove: false, enableRetinaScaling: false })
  try {
    await loadTemplateToCanvas(canvas, snapshot.canvasJson, snapshot.width / 2, snapshot.height / 2, options.signal)
    if (options.transparent && options.format === 'png') canvas.backgroundColor = ''
    else if (!canvas.backgroundColor) canvas.backgroundColor = '#ffffff'
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]); canvas.renderAll(); abortCheck(options.signal)
    const quality = Math.min(1, Math.max(0.1, options.quality ?? 0.85))
    const element = canvas.toCanvasElement(geometry.multiplier, { left: 0, top: 0, width: snapshot.width, height: snapshot.height })
    try {
      const lossless = options.format === 'png' || (options.format === 'pdf' && (options.dpi ?? geometry.effectiveDpi) >= 300)
      const mime = lossless ? 'image/png' : 'image/jpeg'
      const image = await new Promise<Blob>((resolve, reject) => element.toBlob(blob => blob ? resolve(blob) : reject(new Error('No se pudo codificar la imagen.')), mime, quality))
      abortCheck(options.signal)
      if (options.format !== 'pdf') return { blob: image, preview: image }
      const { jsPDF } = await import('jspdf')
      const pdf = new jsPDF({ orientation: snapshot.width > snapshot.height ? 'l' : 'p', unit: 'mm', format: [snapshot.width / 2, snapshot.height / 2], compress: true })
      const bytes = new Uint8Array(await image.arrayBuffer()); abortCheck(options.signal)
      pdf.addImage(bytes, lossless ? 'PNG' : 'JPEG', 0, 0, snapshot.width / 2, snapshot.height / 2)
      return { blob: pdf.output('blob'), preview: image }
    } finally { element.width = 0; element.height = 0 }
  } finally { await canvas.dispose() }
}
export async function renderDocumentSnapshot(snapshot: DocumentRenderSnapshot, options: ExportOptions): Promise<Blob> { return (await renderDocumentSnapshotWithPreview(snapshot, options)).blob }
/** Every export renders a detached snapshot; live viewport, helpers, selection
 * and history are never temporarily mutated, even when encoding fails. */
export async function exportCanvasToBlob(canvas: Canvas | StaticCanvas, options: ExportOptions): Promise<Blob> {
  const { createDocumentRenderSnapshot } = await import('./editorSnapshot')
  const snapshot = await createDocumentRenderSnapshot(canvas, options.scope ?? 'page', options.transparent === true && options.format === 'png')
  return renderDocumentSnapshot(snapshot, options)
}
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
