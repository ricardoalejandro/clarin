import { format } from 'date-fns';

/**
 * Program/session dates are calendar days, not instants. Never pass a
 * YYYY-MM-DD value directly to new Date(), because browsers interpret it as
 * midnight UTC and users west of UTC see the previous day.
 */
export function calendarDateKey(value?: string | null): string {
  return value ? value.slice(0, 10) : '';
}

export function parseCalendarDate(value?: string | null): Date | null {
  const key = calendarDateKey(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
}

export function formatCalendarDate(value: string | undefined | null, pattern: string, options?: Parameters<typeof format>[2]): string {
  const date = parseCalendarDate(value);
  return date ? format(date, pattern, options) : '';
}

export function localDateInputValue(date = new Date()): string {
  return format(date, 'yyyy-MM-dd');
}
