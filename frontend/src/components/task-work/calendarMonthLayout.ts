export const MONTH_WEEKDAY_HEIGHT = 34
export const MONTH_ITEMS_TOP = 32
export const MONTH_ITEM_HEIGHT = 22
export const MONTH_ITEM_GAP = 4

/** Calendar dates stay local; a DST change must never skip or duplicate a day. */
export function calendarMonthGrid(cursor: Date) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  const monthLength = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
  const weekCount = Math.ceil((offset + monthLength) / 7)
  const from = new Date(first)
  from.setDate(1 - offset)
  const days = Array.from({ length: weekCount * 7 }, (_, index) => {
    const day = new Date(from)
    day.setDate(from.getDate() + index)
    return day
  })
  const to = new Date(from)
  to.setDate(from.getDate() + days.length)
  return { from, to, days, weekCount }
}

/** Reserve overflow space before choosing lanes, so dense days never grow a row. */
export function calendarMonthRowCapacity(rowHeight: number, laneCount: number, width: number) {
  const height = Number.isFinite(rowHeight) ? Math.max(0, rowHeight) : 0
  const inlineOverflow = height < MONTH_ITEMS_TOP + 28
  const maximum = width < 560 ? 0 : width < 900 ? 2 : 3
  const fit = (reserved: number) => Math.max(0, Math.floor((height - MONTH_ITEMS_TOP - 4 - reserved + MONTH_ITEM_GAP) / (MONTH_ITEM_HEIGHT + MONTH_ITEM_GAP)))
  let visibleLanes = inlineOverflow ? 0 : Math.min(maximum, laneCount, fit(0))
  if (laneCount > visibleLanes && !inlineOverflow) visibleLanes = Math.min(visibleLanes, fit(24))
  return { visibleLanes, inlineOverflow }
}
