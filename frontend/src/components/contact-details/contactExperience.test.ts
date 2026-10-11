import { describe, expect, it } from 'vitest'
import { clearSubmittedNote, contactFieldColumns, contactTagForeground, contactTagMenuPosition, hasContactNoteDraft } from './contactExperience'

describe('Contact experience geometry and drafts', () => {
  it('uses panel width rather than the desktop viewport for data columns', () => {
    expect(contactFieldColumns(0)).toBe(1)
    expect(contactFieldColumns(419)).toBe(1)
    expect(contactFieldColumns(420)).toBe(2)
  })
  it('protects new and edited notes without flagging an unchanged note', () => {
    expect(hasContactNoteDraft('Nuevo texto', '', undefined)).toBe(true)
    expect(hasContactNoteDraft('', 'Cambio', 'Original')).toBe(true)
    expect(hasContactNoteDraft('  ', 'Original', 'Original')).toBe(false)
    expect(clearSubmittedNote('Texto posterior', 'Texto enviado')).toBe('Texto posterior')
    expect(clearSubmittedNote('Texto enviado', 'Texto enviado')).toBe('')
  })
  it('flips and clamps a picker above the Android keyboard and inside viewport offsets', () => {
    const viewport = { left: 8, top: 40, width: 360, height: 280 }
    const geometry = contactTagMenuPosition({ left: 310, top: 270, bottom: 314, width: 260 }, viewport)
    expect(geometry.left).toBeGreaterThanOrEqual(16)
    expect(geometry.left + geometry.width).toBeLessThanOrEqual(360)
    expect(geometry.top).toBeGreaterThanOrEqual(48)
    expect(geometry.top + geometry.maxHeight).toBeLessThanOrEqual(312)
    const offscreen = contactTagMenuPosition({ left: 20, top: 500, bottom: 544, width: 300 }, viewport)
    expect(offscreen.top + offscreen.maxHeight).toBeLessThanOrEqual(312)
  })
  it('keeps tag names readable on light and dark identity colors', () => {
    expect(contactTagForeground('#FFFF00')).toBe('#0F172A')
    expect(contactTagForeground('#123456')).toBe('#FFFFFF')
    expect(contactTagForeground('invalid')).toBe('#FFFFFF')
    expect(contactTagForeground()).toBe('#FFFFFF')
  })
  it('chooses white on indigo and mid-gray where slate has less contrast', () => {
    expect(contactTagForeground('#6366f1')).toBe('#FFFFFF')
    expect(contactTagForeground('#6366F1')).toBe('#FFFFFF')
    expect(contactTagForeground('#777777')).toBe('#FFFFFF')
    expect(contactTagForeground('#808080')).toBe('#0F172A')
    expect(contactTagForeground('#818CF8')).toBe('#0F172A')
  })
})
