import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { jsPDF } from 'jspdf'
import * as XLSX from 'xlsx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// These fixtures exercise installed dependency code. PDF actions are inert text:
// no PDF viewer is opened and popup documents have no browsing context.
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function outsidePDFLiteralStrings(pdf: string) {
  let result = ''
  let depth = 0
  for (let index = 0; index < pdf.length; index += 1) {
    const character = pdf[index]
    if (depth > 0 && character === '\\') {
      index += 1
      continue
    }
    if (character === '(') depth += 1
    else if (depth > 0 && character === ')') depth -= 1
    else if (depth === 0) result += character
  }
  expect(depth).toBe(0)
  return result
}

describe('jsPDF security and export compatibility', () => {
  beforeEach(() => {
    // Vitest exposes JSDOM's window through Node's global object. Restore the
    // browser's class tag so jsPDF reaches its real DOM output implementations.
    vi.stubGlobal(Symbol.toStringTag, 'Window')
  })
  // https://github.com/parallax/jsPDF/security/advisories/GHSA-7x6v-j9x4-qf24
  it.each([
    '000000) /AA <</E <</S /Launch /F (clarin-test.invalid)>>>> (',
    '000000) /A << /S /JavaScript /JS (void(0)) >> (',
  ])('keeps annotation color injection inside the PDF string: %s', color => {
    const pdf = new jsPDF()
    pdf.text('Clarin export control', 10, 10)
    pdf.createAnnotation({ type: 'freetext', bounds: { x: 10, y: 20, w: 80, h: 10 }, contents: 'Safe note', color })
    const output = pdf.output()
    const escapedColor = color.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    expect(output).toContain(`color:#${escapedColor}) /Border [0 0 0]`)
    expect(outsidePDFLiteralStrings(output)).not.toMatch(/\/(?:AA|Launch|JavaScript)\b/)
    expect(output).toContain('/Subtype /FreeText')
  })

  // https://github.com/parallax/jsPDF/security/advisories/GHSA-wfv2-pwc8-crg5
  it.each(['pdfjsnewwindow', 'dataurlnewwindow'] as const)('does not turn a filename into HTML in %s', type => {
    expect(Object.prototype.toString.call(window)).toBe('[object Window]')
    const targetDocument = document.implementation.createHTMLDocument('detached test document')
    const popup = { document: targetDocument } as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    const filename = 'x"></iframe><script data-injected="true">void(0)</script><iframe src="'
    const options = { filename, pdfJsUrl: '/local-pdf-viewer.html' }
    const result = new jsPDF().output(type, options)
    expect(result).toBe(popup)
    expect(open).toHaveBeenCalledOnce()
    expect(targetDocument.querySelectorAll('iframe')).toHaveLength(1)
    expect(targetDocument.querySelector('script')).toBeNull()
    expect(targetDocument.querySelector('iframe')?.getAttribute('src')).toContain(encodeURIComponent(filename))
  })

  it('keeps PDFObject options and script URL out of HTML interpolation', () => {
    const targetDocument = document.implementation.createHTMLDocument('detached test document')
    const embed = vi.fn()
    const popup = { document: targetDocument, PDFObject: { embed } } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const options = {
      filename: '</script><img data-injected="true" src="invalid">',
      pdfObjectUrl: '/local-pdfobject.js"><script data-injected="true">void(0)</script>',
    }
    expect(new jsPDF().output('pdfobjectnewwindow', options)).toBe(popup)
    const scripts = targetDocument.querySelectorAll('script')
    expect(scripts).toHaveLength(1)
    expect(scripts[0].textContent).toBe('')
    expect(scripts[0].getAttribute('src')).toBe(options.pdfObjectUrl)
    expect(targetDocument.querySelector('[data-injected]')).toBeNull()
    // The detached document never loads the script or invokes its onload callback.
    expect(embed).not.toHaveBeenCalled()
  })

  it('still exports PDF bytes, blobs and filename-safe data URLs', () => {
    const pdf = new jsPDF()
    pdf.text('Clarin export control', 10, 10)
    pdf.createAnnotation({ type: 'freetext', bounds: { x: 10, y: 20, w: 80, h: 10 }, contents: 'Legitimate note', color: '00aa00' })
    expect(pdf.output()).toContain('Clarin export control')
    expect(pdf.output()).toContain('color:#00aa00) /Border [0 0 0]')
    expect(new TextDecoder().decode(pdf.output('arraybuffer').slice(0, 8))).toMatch(/^%PDF-1\./)
    const blob = pdf.output('blob')
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(1000)
    expect(pdf.output('datauristring', { filename: 'Informe Perú.pdf' })).toMatch(/^data:application\/pdf;filename=Informe%20Per%C3%BA\.pdf;base64,/)
  })
})

const KOMMO_HEADERS = [
  'ID', 'Nombre del lead', 'Compañía', 'Contacto principal', 'Compañía del lead', 'Responsable', 'Estatus del lead', 'Embudo de ventas', 'Presupuesto', 'Fecha de creación', 'Creado por', 'Última modificación el', 'Modificado por', 'Etiquetas del lead', 'Tareas próximas', 'Cerrado el', 'Próxima cita', 'BOT 1.0', 'Atención', '✅ RED SOCIAL', '‼️MOTIVO PERDIDA', '✅ SEDE', '✅ Acepto invitación?', '✅ Acepto Clase Gratuita', '✅ Desea inscripción?', '✅ Tipo de cliente', '✅ Campaña', '✅ Consulta', '✅ Fecha', 'PRUEBA', 'STATUS', 'DETEC CAM', 'GRUPO', 'OTRAS', '✅ Exportado', 'utm_content', 'utm_medium', 'utm_campaign', 'utm_source', 'utm_term', 'utm_referrer', 'referrer', 'gclientid', 'gclid', 'fbclid', 'ttad_name', 'ttad_id', 'Cargo (contacto)', 'Correo (contacto)', 'E-mail priv. (contacto)', 'Otro e-mail (contacto)', 'Teléfono oficina (contacto)', 'Teléfono oficina directo (contacto)', 'Teléfono celular (contacto)', 'Fax (contacto)', 'Teléfono de casa (contacto)', 'Otro teléfono (contacto)', 'Nota 1', 'Nota 2', 'Nota 3', 'Nota 4', 'Nota 5',
]

describe('SheetJS local workbook security and compatibility', () => {
  it('round-trips the 62-column Sheet1 contract, Unicode, leading zeroes and formatted date cells', () => {
    expect(KOMMO_HEADERS).toHaveLength(62)
    const row = KOMMO_HEADERS.map(() => '')
    row[0] = '00001234'
    row[1] = 'Prueba Perú — 藍'
    row[53] = '0051987654321'
    row[57] = 'Primera línea, "comillas"\nSegunda línea'
    const sheet = XLSX.utils.aoa_to_sheet([KOMMO_HEADERS, row])
    sheet.J2 = { t: 'n', v: 45000.5, z: 'dd/mm/yyyy hh:mm' }
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')
    const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
    const restored = XLSX.read(bytes, { type: 'array', cellDates: false })
    const restoredSheet = restored.Sheets.Sheet1
    const rows = XLSX.utils.sheet_to_json<string[]>(restoredSheet, { header: 1, raw: false, defval: '' })
    expect(restored.SheetNames).toEqual(['Sheet1'])
    expect(rows[0]).toEqual(KOMMO_HEADERS)
    expect(rows[1]).toHaveLength(62)
    expect(rows[1][0]).toBe(row[0])
    expect(rows[1][1]).toBe(row[1])
    expect(rows[1][53]).toBe(row[53])
    expect(rows[1][57]).toBe(row[57])
    expect(restoredSheet.J2.t).toBe('n')
    expect(restoredSheet.J2.v).toBe(45000.5)
    expect(rows[1][9]).toBe('15/03/2023 12:00')
    const csv = XLSX.utils.sheet_to_csv(restoredSheet)
    expect(csv).toContain('0051987654321')
    expect(csv).toContain('"Primera línea, ""comillas""\nSegunda línea"')
  })

  // CVE-2023-30533: an invalid comment address must never resolve a prototype.
  // https://cdn.sheetjs.com/advisories/CVE-2023-30533
  it.each(['__proto__', 'constructor', 'prototype'])('ignores a crafted comment cell address %s without prototype mutation', address => {
    const objectBefore = Object.getOwnPropertyDescriptors(Object.prototype)
    const constructorBefore = Object.getOwnPropertyDescriptors(Object)
    const sheet = XLSX.utils.aoa_to_sheet([['Import control', 'Valid cell']])
    sheet.A1.c = [{ a: 'Synthetic test', t: 'Invalid-address comment' }]
    sheet.B1.c = [{ a: 'Synthetic test', t: 'Retained valid comment' }]
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')
    const entries = unzipSync(new Uint8Array(XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })))
    const commentPath = Object.keys(entries).find(path => /^xl\/comments\d+\.xml$/.test(path))
    expect(commentPath).toBeDefined()
    const comments = strFromU8(entries[commentPath!])
    expect(comments).toContain('<comment ref="A1"')
    entries[commentPath!] = strToU8(comments.replace('<comment ref="A1"', `<comment ref="${address}"`))
    try {
      const result = XLSX.read(zipSync(entries), { type: 'array', cellDates: false })
      expect(result.Sheets.Sheet1.A1.v).toBe('Import control')
      expect(result.Sheets.Sheet1.A1.c).toBeUndefined()
      expect(result.Sheets.Sheet1.B1.c?.[0].t).toBe('Retained valid comment')
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(objectBefore)
      expect(Object.getOwnPropertyDescriptors(Object)).toEqual(constructorBefore)
    } finally {
      // Contain a future regression inside this unit test worker.
      if (!Object.hasOwn(objectBefore, 'c')) Reflect.deleteProperty(Object.prototype, 'c')
      if (!Object.hasOwn(constructorBefore, 'c')) Reflect.deleteProperty(Object, 'c')
    }
  })
})
