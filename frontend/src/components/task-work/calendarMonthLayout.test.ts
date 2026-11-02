import { describe, expect, it } from 'vitest'
import { calendarMonthGrid, calendarMonthRowCapacity, MONTH_ITEMS_TOP, MONTH_ITEM_HEIGHT, MONTH_ITEM_GAP } from './calendarMonthLayout'
import { calendarPointerDelta } from './calendarScheduleInteraction'

describe('calendar month layout', () => {
  it.each([[2027, 1, 4], [2026, 5, 5], [2026, 10, 6]])('renders every date in %i/%i using %i complete weeks', (year, month, weeks) => {
    const actual = calendarMonthGrid(new Date(year, month, 1))
    expect(actual.weekCount).toBe(weeks)
    expect(actual.days).toHaveLength(weeks * 7)
    expect(actual.from.getDay()).toBe(1)
    expect(actual.days.at(-1)?.getDay()).toBe(0)
    expect(actual.days.filter(day => day.getMonth() === month)).toHaveLength(new Date(year, month + 1, 0).getDate())
    expect(actual.to.getTime()).toBeGreaterThan(actual.days.at(-1)!.getTime())
  })

  it('includes leap day and changes months without retaining the cursor day', () => {
    const february = calendarMonthGrid(new Date(2028, 1, 29))
    expect(february.days.some(day => day.getMonth() === 1 && day.getDate() === 29)).toBe(true)
    expect(calendarMonthGrid(new Date(2026, 11, 1)).to.getFullYear()).toBe(2027)
  })

  it('reserves room for overflow and bounds every visible lane to its measured row', () => {
    for (const height of [44, 63, 64, 80, 85.5, 96, 110, 150, 250]) {
      for (const lanes of [0, 1, 2, 3, 20]) {
        const layout = calendarMonthRowCapacity(height, lanes, 1000)
        expect(layout.visibleLanes).toBeLessThanOrEqual(3)
        if (layout.visibleLanes) {
          const bottom = MONTH_ITEMS_TOP + layout.visibleLanes * MONTH_ITEM_HEIGHT + (layout.visibleLanes - 1) * MONTH_ITEM_GAP
          expect(bottom + (lanes > layout.visibleLanes ? 28 : 4)).toBeLessThanOrEqual(height)
        }
        if (layout.inlineOverflow) expect(layout.visibleLanes).toBe(0)
      }
    }
    expect(calendarMonthRowCapacity(250, 20, 750).visibleLanes).toBe(2)
    expect(calendarMonthRowCapacity(250, 1, 375).visibleLanes).toBe(0)
    expect(calendarMonthRowCapacity(85.5, 20, 1000).visibleLanes).toBe(1)
    expect(calendarMonthRowCapacity(Number.NaN, 20, 1000).visibleLanes).toBe(0)
  })

  it('maps a measured row move to exactly one calendar week at any month density', () => {
    for (const weekCount of [4, 5, 6]) {
      const rowHeight = 420 / weekCount
      expect(calendarPointerDelta('month', { x: 0, y: 0 }, { x: 100, y: rowHeight }, { columnWidth: 100, rowHeight })).toEqual({ days: 8, minutes: 0 })
    }
  })
})
