import { describe, expect, it, vi } from 'vitest'
import { validateDocumentCanvas, validateDocumentTemplate } from './documentValidation'
import { documentPlainText } from './documentText'
import { documentLibraryPath, mergeDocumentPage, safeDocumentFilename } from './documentLibrary'
import { documentExportGeometry, DOCUMENT_EXPORT_PROFILES } from '@/lib/fabric/export'
describe('document boundaries', () => {
 it('keeps legacy text, nested groups, paths, filters and gradients', () => {
  for (const design of [{}, { version: 2, elements: [{ type: 'text', content: 'Perú 🦙' }] }, { version: 3, fabricJson: { objects: [{ type: 'Group', objects: [{ type: 'Image', src: '/api/media/file/account/image.png', filters: [{ type: 'Brightness', brightness: .2 }] }] }, { type: 'Path', path: [['M', 0, 0], ['L', 10, 20]], fill: { type: 'linear', colorStops: [{ offset: 0, color: '#FFF' }] } }] } }]) expect(validateDocumentCanvas(design)).toBeNull()
 })
 it('allows ten real nested groups with gradients and bounds JSON separately',()=>{
  for(const depth of [9,10,11]) { let object:any={type:'Rect',fill:{type:'linear',colorStops:[{offset:0,color:'red'}]}};for(let i=0;i<depth;i++)object={type:'Group',objects:[object]};expect(validateDocumentCanvas({version:3,fabricJson:{objects:[object]}})===null).toBe(depth<=10) }
  expect(validateDocumentCanvas({version:3,fabricJson:{objects:[{type:'Image',clipPath:{type:'Rect',width:4,height:4}}]}})).toBeNull()
 })
 it('rejects unsafe input and bounded canvas dimensions', () => {
  for (const design of [null, [], { version: 99 }, { elements: [{ type: 'image', src: 'javascript:alert(1)' }] }, { elements: [{ type: 'image', src: 'data:image/svg+xml;base64,xxx' }] }, JSON.parse('{"__proto__":{"polluted":true}}'), { elements: Array.from({ length: 1001 }, () => ({ type: 'rect' })) }]) expect(validateDocumentCanvas(design)).not.toBeNull()
  for (const width of [0, 9, 2001, Infinity, NaN]) expect(validateDocumentTemplate({ name: 'Ficha', page_width: width, page_height: 140, canvas_json: {} })).not.toBeNull()
 })
 it('uses inert HTML parsing and preserves legitimate text', () => {
  const create = vi.spyOn(document, 'createElement')
  expect(documentPlainText('<b>Perú &amp; café</b>\n<img src=x onerror="alert(1)">🦙')).toBe('Perú & café\n🦙')
  expect(create.mock.calls.every(([tag]) => tag === 'template')).toBe(true)
  expect(documentPlainText('Línea 1\nLínea 2')).toBe('Línea 1\nLínea 2')
  expect(document.querySelector('img')).toBeNull()
 })
 it('bounds pixels and exports resolution consistently', () => {
  expect(DOCUMENT_EXPORT_PROFILES.print).toMatchObject({ dpi: 300, quality: .95 })
  const normal = documentExportGeometry(420, 594, { dpi: 150 }); expect(normal.clamped).toBe(false); expect(normal.width).toBe(1240)
  const huge = documentExportGeometry(4000, 4000, { dpi: 300 }); expect(huge.clamped).toBe(true); expect(huge.width * huge.height).toBeLessThanOrEqual(32_000_000)
  expect(() => documentExportGeometry(0, 20, { dpi: 96 })).toThrow()
 })
 it('encodes cursors/search, reconciles rows by id and constrains filenames', () => {
  expect(documentLibraryPath('a&b', 'abc=')).toContain('q=a%26b')
  expect(mergeDocumentPage([{ id: '1', name: 'old' }] as any, [{ id: '1', name: 'new' }, { id: '2' }] as any)).toEqual([{ id: '1', name: 'new' }, { id: '2' }])
  expect(safeDocumentFilename('../Ficha/Perú')).not.toContain('/')
 })
})
