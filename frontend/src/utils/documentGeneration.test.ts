import { expect, it, vi } from 'vitest'
import { resolveFieldTyped, substituteDocumentFields, generateForLead } from './documentGeneration'
import { renderDocumentSnapshot } from '@/lib/fabric/export'
vi.mock('@/lib/fabric/export', () => ({ renderDocumentSnapshot: vi.fn().mockResolvedValue(new Blob(['png'])) }))
const template = { name: 'Ficha', page_width: 210, page_height: 140, canvas_json: { version: 3, fabricJson: { objects: [{ type: 'Group', objects: [{ type: 'DynamicText', text: '{{bio}}', isDynamic: true, fieldName: 'bio' }] }] }, background: { color: '#ffffff' } } } as any
const lead = { custom_field_values: [{ field_slug: 'bio', value_text: '<img src=x onerror="alert(1)"><b>Perú &amp; café</b>' }] } as any
it('substitutes hostile custom-field data only as inert text without mutating the design', () => {
 const result = substituteDocumentFields(template, lead) as any
 expect(result.fabricJson.objects[0].objects[0].text).toBe('Perú & café')
 expect(template.canvas_json.fabricJson.objects[0].objects[0].text).toBe('{{bio}}')
 expect(resolveFieldTyped('constructor', lead)).toEqual({ type: 'empty', value: '' })
})
it('generation uses the same bounded detached rendering path as the editor', async () => {
 await generateForLead(template, lead, { format: 'png', scale: 4 })
 expect(renderDocumentSnapshot).toHaveBeenCalledWith(expect.objectContaining({ width: 420, height: 280, canvasJson: expect.any(Object) }), expect.objectContaining({ format: 'png', multiplier: 4 }))
})
