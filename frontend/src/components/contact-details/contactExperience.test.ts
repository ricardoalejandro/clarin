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
  it.each([54, 280])('anchors an upward picker with content height %i to the input', contentHeight => {
    const rect = { left: 950, top: 730, bottom: 774, width: 300 }
    const viewport = { left: 0, top: 0, width: 1280, height: 900 }
    const geometry = contactTagMenuPosition(rect, viewport)
    const renderedHeight = Math.min(contentHeight, geometry.maxHeight)
    expect(geometry.transform).toBe('translateY(-100%)')
    const renderedTop = geometry.top - renderedHeight
    expect(geometry.top).toBe(rect.top - 6)
    expect(renderedTop).toBeGreaterThanOrEqual(8)
    expect(geometry.top - renderedTop).toBe(renderedHeight)
    expect(rect.top - (renderedTop + renderedHeight)).toBe(6)
  })
  it('flips above the Android keyboard and clamps rendered bounds inside viewport offsets', () => {
    const viewport = { left: 8, top: 40, width: 360, height: 280 }
    for (const rect of [
      { left: 310, top: 270, bottom: 314, width: 260 },
      { left: 20, top: 500, bottom: 544, width: 300 },
    ]) {
      const geometry = contactTagMenuPosition(rect, viewport)
      expect(geometry.transform).toBe('translateY(-100%)')
      expect(geometry.left).toBeGreaterThanOrEqual(16)
      expect(geometry.left + geometry.width).toBeLessThanOrEqual(360)
      for (const contentHeight of [54, 280]) {
        const renderedHeight = Math.min(contentHeight, geometry.maxHeight)
        expect(geometry.top - renderedHeight).toBeGreaterThanOrEqual(48)
        expect(geometry.top).toBeLessThanOrEqual(312)
      }
    }
  })
  it('anchors downward pickers without a transform and clamps the left corner', () => {
    const rect = { left: -40, top: 60, bottom: 104, width: 260 }
    const geometry = contactTagMenuPosition(rect, { left: 8, top: 40, width: 360, height: 640 })
    expect(geometry.left).toBe(16)
    expect(geometry.top).toBe(rect.bottom + 6)
    expect(geometry.transform).toBeUndefined()
    expect(geometry.maxHeight).toBe(280)
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
