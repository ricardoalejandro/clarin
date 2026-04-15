/**
 * Fabric.js Canvas Export — PNG, JPEG, PDF with quality multiplier
 * Replaces html2canvas entirely. Uses Canvas 2D API natively.
 */

import type { Canvas, StaticCanvas } from 'fabric'

export interface ExportOptions {
  format: 'png' | 'pdf' | 'jpeg'
  multiplier?: number  // default 4 (~200 DPI)
  quality?: number     // 0-1 for JPEG, ignored for PNG
}

/**
 * Export a Fabric canvas to a Blob.
 * Exports only the page area (not the pasteboard).
 */
export async function exportCanvasToBlob(
  canvas: Canvas | StaticCanvas,
  options: ExportOptions
): Promise<Blob> {
  const multiplier = options.multiplier ?? 4
  const quality = options.quality ?? 0.92
  const format = options.format

  // Get page dimensions (pasteboard model)
  const pageW = (canvas as any).__pageWidth || canvas.getWidth()
  const pageH = (canvas as any).__pageHeight || canvas.getHeight()

  if (format === 'pdf') {
    return exportToPdf(canvas, multiplier, pageW, pageH)
  }

  // PNG or JPEG — export only the page area
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png'

  // Save current viewport transform
  const origVpt = [...canvas.viewportTransform!]

  // Reset viewport to identity (1:1) so export covers the page area at origin
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0])

  const dataUrl = canvas.toDataURL({
    format: format === 'jpeg' ? 'jpeg' : 'png',
    multiplier,
    quality: format === 'jpeg' ? quality : 1,
    left: 0,
    top: 0,
    width: pageW,
    height: pageH,
  })

  // Restore viewport
  canvas.setViewportTransform(origVpt as any)
  canvas.requestRenderAll()

  return dataUrlToBlob(dataUrl, mimeType)
}

/**
 * Export canvas to PDF using jsPDF + native canvas export.
 */
async function exportToPdf(
  canvas: Canvas | StaticCanvas,
  multiplier: number,
  pageW: number,
  pageH: number,
): Promise<Blob> {
  const { jsPDF } = await import('jspdf')

  const mmW = pageW / 2 // MM_TO_PX = 2
  const mmH = pageH / 2

  const orientation = mmW > mmH ? 'l' : 'p'
  const pdf = new jsPDF({ orientation, unit: 'mm', format: [mmW, mmH] })

  // Save current viewport transform
  const origVpt = [...canvas.viewportTransform!]

  // Reset viewport to identity for clean export
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0])

  const dataUrl = canvas.toDataURL({
    format: 'jpeg',
    multiplier,
    quality: 0.85,
    left: 0,
    top: 0,
    width: pageW,
    height: pageH,
  })

  // Restore viewport
  canvas.setViewportTransform(origVpt as any)
  canvas.requestRenderAll()

  pdf.addImage(dataUrl, 'JPEG', 0, 0, mmW, mmH)
  return pdf.output('blob')
}

/**
 * Convert a data URL to a Blob.
 */
function dataUrlToBlob(dataUrl: string, mimeType: string): Blob {
  const parts = dataUrl.split(',')
  const byteString = atob(parts[1])
  const ab = new ArrayBuffer(byteString.length)
  const ia = new Uint8Array(ab)
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i)
  }
  return new Blob([ab], { type: mimeType })
}

/**
 * Download a blob as a file.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
