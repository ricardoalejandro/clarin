import { describe, expect, it } from 'vitest'
import {
  normalizeTaskHexColor,
  taskColorContrast,
  taskHexToHsl,
  taskHslToHex,
} from './TaskContainerAppearance'

describe('task appearance helpers', () => {
  it('normalizes only safe six-digit hexadecimal colors', () => {
    expect(normalizeTaskHexColor(' #0b98b1 ')).toBe('#0B98B1')
    expect(normalizeTaskHexColor('#fff')).toBe('#10B981')
    expect(normalizeTaskHexColor('linear-gradient(red, blue)')).toBe('#10B981')
    expect(normalizeTaskHexColor('invalid', '#334155')).toBe('#334155')
  })

  it('round-trips the HSL controls to a normalized color', () => {
    const hsl = taskHexToHsl('#10B981')
    expect(hsl).toEqual({ h: 160, s: 84, l: 39 })
    expect(taskHslToHex(hsl.h, hsl.s, hsl.l)).toBe('#10B77F')
    expect(taskHslToHex(0, 100, 50)).toBe('#FF0000')
  })

  it('chooses readable foregrounds and exposes the contrast result', () => {
    expect(taskColorContrast('#0F172A')).toMatchObject({ textColor: '#FFFFFF', passesAA: true })
    expect(taskColorContrast('#F8FAFC')).toMatchObject({ textColor: '#0F172A', passesAA: true })
  })
})
