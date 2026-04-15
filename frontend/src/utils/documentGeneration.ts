/**
 * Document Generation Engine — Fabric.js v6
 * Renders document templates with lead data substitution using Fabric StaticCanvas.
 * No html2canvas — exports via native Canvas 2D API.
 */

import type { Lead } from '@/types/contact'
import type { DocumentTemplate } from '@/types/document'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Legacy V2 canvas element (kept for backward compat preview). */
export interface CanvasElement {
  id: string
  type: 'text' | 'rect' | 'circle' | 'image' | 'line'
  x: number; y: number; width: number; height: number
  rotation: number
  content?: string
  fontSize?: number; fontFamily?: string; fontWeight?: string; fontStyle?: string
  textAlign?: string; textDecoration?: string; lineHeight?: number
  letterSpacing?: number; verticalAlign?: string; color?: string
  fill?: string; stroke?: string; strokeWidth?: number
  opacity?: number; borderRadius?: number; src?: string
  isDynamic?: boolean; fieldName?: string
  visible?: boolean; locked?: boolean; name?: string
  shadow?: { offsetX: number; offsetY: number; blur: number; spread: number; color: string }
  groupId?: string
}

export interface RenderOptions {
  format: 'png' | 'pdf'
  scale?: number // multiplier for export resolution (default 4 = ~200 DPI)
}

export interface BulkProgress {
  current: number
  total: number
  leadName: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MM_TO_PX = 2

// ─── Field Substitution Map ──────────────────────────────────────────────────

const FIELD_MAP: Record<string, (lead: Lead) => string> = {
  nombre: (l) => l.name || '',
  apellido: (l) => l.last_name || '',
  nombre_completo: (l) => `${l.name || ''} ${l.last_name || ''}`.trim(),
  dni: (l) => l.dni || '',
  telefono: (l) => l.phone || '',
  email: (l) => l.email || '',
  empresa: (l) => l.company || '',
  direccion: (l) => l.address || '',
  distrito: (l) => l.distrito || '',
  ocupacion: (l) => l.ocupacion || '',
  edad: (l) => l.age != null ? String(l.age) : '',
  fecha_nacimiento: (l) => {
    if (!l.birth_date) return ''
    try { return new Date(l.birth_date).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) }
    catch { return l.birth_date }
  },
  etapa: (l) => l.stage_name || '',
  pipeline: (l) => l.pipeline_id || '',
  tags: (l) => l.tags?.join(', ') || '',
  notas: (l) => l.notes || '',
  fecha_actual: () => new Date().toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }),
  asignado: (l) => l.assigned_to || '',
  estado: (l) => l.status || '',
}

function resolveField(key: string, lead: Lead): string {
  const normalized = key.toLowerCase().replace(/\s+/g, '_').replace(/^\{\{|\}\}$/g, '')
  const resolver = FIELD_MAP[normalized]
  return resolver ? resolver(lead) : `[${key}]`
}

// ─── Legacy V2 helpers (for preview and backwards compat) ─────────────────────

export function parseCanvasJson(template: DocumentTemplate): { elements: CanvasElement[], background: { color: string; imageUrl?: string } } {
  const cj = template.canvas_json as any
  if (cj?.version === 3) {
    // V3 Fabric format — extract elements from fabricJson.objects
    const fabricObjs = cj.fabricJson?.objects || []
    const elements: CanvasElement[] = fabricObjs
      .filter((o: any) => o.type === 'DynamicText')
      .map((o: any) => ({
        id: o.id || '',
        type: 'text' as const,
        x: o.left || 0, y: o.top || 0,
        width: o.width || 200, height: o.height || 50,
        rotation: o.angle || 0,
        content: o.text || '',
        isDynamic: o.isDynamic || false,
        fieldName: o.fieldName || '',
        name: o.elementName || '',
        visible: o.visible !== false,
      }))
    return {
      elements,
      background: cj.background || { color: '#ffffff' },
    }
  }
  // V2 legacy
  return {
    elements: cj?.elements || [],
    background: cj?.background || { color: '#ffffff' },
  }
}

export function substituteFields(elements: CanvasElement[], lead: Lead): CanvasElement[] {
  return elements.map(el => {
    if (el.type !== 'text') return el
    const copy = { ...el }
    if (copy.isDynamic && copy.fieldName) {
      copy.content = resolveField(copy.fieldName, lead)
      return copy
    }
    if (copy.content && copy.content.includes('{{')) {
      copy.content = copy.content.replace(/\{\{(\w+)\}\}/g, (_, field: string) => {
        const resolver = FIELD_MAP[field.toLowerCase()]
        return resolver ? resolver(lead) : `{{${field}}}`
      })
    }
    return copy
  })
}

// ─── Fabric.js Rendering Engine ──────────────────────────────────────────────

/**
 * Substitute dynamic fields on a Fabric canvas.
 * Iterates all objects, replacing text on DynamicText instances.
 */
async function substituteFabricFields(
  fabricModule: typeof import('fabric'),
  canvasObjects: any[],
  lead: Lead
): Promise<void> {
  for (const obj of canvasObjects) {
    // Check for DynamicText or objects with isDynamic custom prop
    if (obj.isDynamic && obj.fieldName) {
      const value = resolveField(obj.fieldName, lead)
      obj.set('text', value)
      // Reset fill to black if it was the dynamic marker color
      if (obj.fill === '#059669') {
        obj.set('fill', '#000000')
      }
    } else if (obj.text && typeof obj.text === 'string' && obj.text.includes('{{')) {
      const newText = obj.text.replace(/\{\{(\w+)\}\}/g, (_: string, field: string) => {
        const resolver = FIELD_MAP[field.toLowerCase()]
        return resolver ? resolver(lead) : `{{${field}}}`
      })
      obj.set('text', newText)
    }
    // Handle groups recursively
    if (obj._objects && Array.isArray(obj._objects)) {
      await substituteFabricFields(fabricModule, obj._objects, lead)
    }
  }
}

/**
 * Render a document using Fabric.js StaticCanvas.
 * Works for both V3 (Fabric JSON) and V2 (legacy elements).
 */
export async function renderDocument(
  template: DocumentTemplate,
  _elements: CanvasElement[],  // kept for API compat but not used for V3
  _background: { color: string; imageUrl?: string },
  options: RenderOptions
): Promise<Blob> {
  const fabricModule = await import('fabric')
  const fabricLib = await import('@/lib/fabric')
  await fabricLib.ensureFontsLoaded()

  const multiplier = options.scale || 4
  const pageW = template.page_width * MM_TO_PX
  const pageH = template.page_height * MM_TO_PX

  // Create headless StaticCanvas
  const canvas = new fabricModule.StaticCanvas(undefined, {
    width: pageW,
    height: pageH,
    backgroundColor: '#ffffff',
    renderOnAddRemove: false,
  })

  // Load template into canvas
  const bg = await fabricLib.loadTemplateToCanvas(canvas, template.canvas_json, template.page_width, template.page_height)
  canvas.backgroundColor = bg.color
  canvas.renderAll()

  // Export
  if (options.format === 'png') {
    const dataUrl = canvas.toDataURL({
      format: 'png',
      multiplier,
      quality: 1,
    })
    canvas.dispose()
    return dataUrlToBlob(dataUrl)
  } else {
    const { jsPDF } = await import('jspdf')
    const docW = template.page_width
    const docH = template.page_height
    const orientation = docW > docH ? 'l' : 'p'
    const pdf = new jsPDF({ orientation, unit: 'mm', format: [docW, docH] })
    const dataUrl = canvas.toDataURL({ format: 'png', multiplier, quality: 1 })
    pdf.addImage(dataUrl, 'PNG', 0, 0, docW, docH)
    canvas.dispose()
    return pdf.output('blob')
  }
}

/**
 * Render a Fabric canvas for a specific lead (loads template + substitutes fields).
 * Returns the canvas for further processing or the rendered blob.
 */
async function renderForLead(
  template: DocumentTemplate,
  lead: Lead,
  multiplier: number,
): Promise<{ canvas: InstanceType<typeof import('fabric').StaticCanvas>; bg: { color: string; imageUrl?: string } }> {
  const fabricModule = await import('fabric')
  const fabricLib = await import('@/lib/fabric')
  await fabricLib.ensureFontsLoaded()

  const pageW = template.page_width * MM_TO_PX
  const pageH = template.page_height * MM_TO_PX

  const canvas = new fabricModule.StaticCanvas(undefined, {
    width: pageW,
    height: pageH,
    backgroundColor: '#ffffff',
    renderOnAddRemove: false,
  })

  const bg = await fabricLib.loadTemplateToCanvas(canvas, template.canvas_json, template.page_width, template.page_height)
  canvas.backgroundColor = bg.color

  // Substitute dynamic fields
  const objects = canvas.getObjects()
  await substituteFabricFields(fabricModule, objects, lead)

  // Handle background image
  if (bg.imageUrl) {
    try {
      const bgImg = await fabricModule.FabricImage.fromURL(bg.imageUrl, { crossOrigin: 'anonymous' })
      const scaleX = pageW / (bgImg.width || 1)
      const scaleY = pageH / (bgImg.height || 1)
      const scale = Math.max(scaleX, scaleY) // cover
      bgImg.set({
        left: pageW / 2, top: pageH / 2,
        originX: 'center', originY: 'center',
        scaleX: scale, scaleY: scale,
        selectable: false, evented: false,
      })
      // Insert at index 0 (behind everything)
      canvas.insertAt(0, bgImg)
    } catch (err) {
      console.warn('Failed to load background image:', err)
    }
  }

  canvas.renderAll()
  return { canvas, bg }
}

// ─── Single Document Generation ──────────────────────────────────────────────

export async function generateForLead(
  template: DocumentTemplate,
  lead: Lead,
  options: RenderOptions
): Promise<Blob> {
  const multiplier = options.scale || 4
  const { canvas } = await renderForLead(template, lead, multiplier)

  try {
    if (options.format === 'png') {
      const dataUrl = canvas.toDataURL({ format: 'png', multiplier, quality: 1 })
      return dataUrlToBlob(dataUrl)
    } else {
      const { jsPDF } = await import('jspdf')
      const docW = template.page_width
      const docH = template.page_height
      const orientation = docW > docH ? 'l' : 'p'
      const pdf = new jsPDF({ orientation, unit: 'mm', format: [docW, docH] })
      const dataUrl = canvas.toDataURL({ format: 'png', multiplier, quality: 1 })
      pdf.addImage(dataUrl, 'PNG', 0, 0, docW, docH)
      return pdf.output('blob')
    }
  } finally {
    canvas.dispose()
  }
}

// ─── Bulk Document Generation ────────────────────────────────────────────────

export async function generateBulk(
  template: DocumentTemplate,
  leads: Lead[],
  options: RenderOptions,
  onProgress?: (progress: BulkProgress) => void
): Promise<{ blob: Blob; filename: string }[]> {
  const ext = options.format === 'png' ? 'png' : 'pdf'
  const results: { blob: Blob; filename: string }[] = []

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i]
    const leadName = `${lead.name || ''} ${lead.last_name || ''}`.trim() || lead.phone || lead.id
    const safeName = leadName.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s_-]/g, '').replace(/\s+/g, '_')
    onProgress?.({ current: i + 1, total: leads.length, leadName })

    const blob = await generateForLead(template, lead, options)
    results.push({ blob, filename: `${safeName}_${template.name}.${ext}` })
  }

  return results
}

export async function packageAsZip(files: { blob: Blob; filename: string }[]): Promise<Blob> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  for (const file of files) {
    zip.file(file.filename, file.blob)
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

export async function mergePdfs(
  template: DocumentTemplate,
  leads: Lead[],
  options: Omit<RenderOptions, 'format'> & { format?: 'pdf' },
  onProgress?: (progress: BulkProgress) => void
): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const docW = template.page_width
  const docH = template.page_height
  const orientation = docW > docH ? 'l' : 'p'
  const pdf = new jsPDF({ orientation, unit: 'mm', format: [docW, docH] })
  const multiplier = options.scale || 4

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i]
    const leadName = `${lead.name || ''} ${lead.last_name || ''}`.trim() || lead.phone || lead.id
    onProgress?.({ current: i + 1, total: leads.length, leadName })

    if (i > 0) pdf.addPage([docW, docH], orientation)

    const { canvas } = await renderForLead(template, lead, multiplier)
    try {
      const dataUrl = canvas.toDataURL({ format: 'png', multiplier, quality: 1 })
      pdf.addImage(dataUrl, 'PNG', 0, 0, docW, docH)
    } finally {
      canvas.dispose()
    }
  }

  return pdf.output('blob')
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(',')
  const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/png'
  const byteString = atob(parts[1])
  const ab = new ArrayBuffer(byteString.length)
  const ia = new Uint8Array(ab)
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i)
  }
  return new Blob([ab], { type: mime })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
