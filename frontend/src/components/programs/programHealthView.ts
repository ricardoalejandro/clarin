import type { ProgramHealthParticipant, ProgramHealthViewColumn } from '@/types/program';
import { calendarDateKey } from '@/utils/calendarDate';

export const PROGRAM_HEALTH_VIEW_DEFAULT_COLUMNS: ProgramHealthViewColumn[] = [
  'health',
  'attendance',
  'signals',
];

export const PROGRAM_HEALTH_VIEW_COLUMN_CATALOG: ReadonlyArray<{
  key: ProgramHealthViewColumn;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  { key: 'health', label: 'Salud', shortLabel: 'Salud', description: 'Estado general de seguimiento.' },
  { key: 'attendance', label: 'Asistencia', shortLabel: 'Asistencia', description: 'Porcentaje y sesiones registradas.' },
  { key: 'signals', label: 'Señales', shortLabel: 'Señales', description: 'Alertas que requieren atención.' },
  { key: 'enrolled_at', label: 'Fecha de incorporación', shortLabel: 'Ingreso', description: 'Fecha real de inicio en el programa.' },
  { key: 'tenure', label: 'Antigüedad', shortLabel: 'Antigüedad', description: 'Tiempo calendario desde el ingreso.' },
];

const PROGRAM_HEALTH_VIEW_COLUMN_KEYS = new Set<ProgramHealthViewColumn>(
  PROGRAM_HEALTH_VIEW_COLUMN_CATALOG.map(column => column.key),
);

export function normalizeProgramHealthViewColumns(value: unknown): ProgramHealthViewColumn[] {
  if (!Array.isArray(value)) return [...PROGRAM_HEALTH_VIEW_DEFAULT_COLUMNS];
  const selected = new Set<ProgramHealthViewColumn>();
  value.forEach(column => {
    if (typeof column === 'string' && PROGRAM_HEALTH_VIEW_COLUMN_KEYS.has(column as ProgramHealthViewColumn)) {
      selected.add(column as ProgramHealthViewColumn);
    }
  });
  return PROGRAM_HEALTH_VIEW_COLUMN_CATALOG
    .map(column => column.key)
    .filter(column => selected.has(column));
}

export type ProgramHealthSortKey = 'participant' | ProgramHealthViewColumn;
export type ProgramHealthSortDirection = 'ascending' | 'descending';

export interface ProgramHealthSortState {
  key: ProgramHealthSortKey;
  direction: ProgramHealthSortDirection;
}

export function nextProgramHealthSort(
  current: ProgramHealthSortState | null,
  key: ProgramHealthSortKey,
): ProgramHealthSortState {
  if (current?.key !== key) return { key, direction: 'ascending' };
  return {
    key,
    direction: current.direction === 'ascending' ? 'descending' : 'ascending',
  };
}

interface CalendarParts {
  year: number;
  month: number;
  day: number;
}

export interface ProgramTenure {
  kind: 'duration' | 'future' | 'invalid';
  years: number;
  months: number;
  days: number;
  compact: string;
  accessible: string;
}

function toCalendarParts(value?: string | null): CalendarParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDateKey(value));
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > daysInMonth(parts.year, parts.month)) return null;
  return parts;
}

function calendarNumber(parts: CalendarParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function addCalendarMonthsClamped(start: CalendarParts, months: number): CalendarParts {
  const absoluteMonth = start.year * 12 + (start.month - 1) + months;
  const year = Math.floor(absoluteMonth / 12);
  const monthIndex = absoluteMonth - year * 12;
  const month = monthIndex + 1;
  return { year, month, day: Math.min(start.day, daysInMonth(year, month)) };
}

function calendarDayDifference(from: CalendarParts, to: CalendarParts): number {
  return Math.round((calendarNumber(to) - calendarNumber(from)) / 86_400_000);
}

function plural(value: number, singular: string, pluralForm: string): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

export function getProgramTenure(enrolledAt?: string | null, asOfDate?: string | null): ProgramTenure {
  const start = toCalendarParts(enrolledAt);
  const end = toCalendarParts(asOfDate);
  if (!start || !end) {
    return { kind: 'invalid', years: 0, months: 0, days: 0, compact: '—', accessible: 'Fecha de ingreso no disponible' };
  }
  if (calendarNumber(start) > calendarNumber(end)) {
    return { kind: 'future', years: 0, months: 0, days: 0, compact: 'Aún no inicia', accessible: 'Aún no inicia' };
  }

  let totalMonths = (end.year - start.year) * 12 + (end.month - start.month);
  let anchor = addCalendarMonthsClamped(start, totalMonths);
  while (totalMonths > 0 && calendarNumber(anchor) > calendarNumber(end)) {
    totalMonths -= 1;
    anchor = addCalendarMonthsClamped(start, totalMonths);
  }
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const days = calendarDayDifference(anchor, end);
  return {
    kind: 'duration',
    years,
    months,
    days,
    compact: `${years}a ${months}m ${days}d`,
    accessible: `${plural(years, 'año', 'años')}, ${plural(months, 'mes', 'meses')} y ${plural(days, 'día', 'días')}`,
  };
}

const spanishCollator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

function normalizedSignalText(participant: ProgramHealthParticipant): string {
  return (participant.reasons || [])
    .map(reason => reason.trim())
    .filter(reason => reason && reason.toLocaleLowerCase('es') !== 'sin alertas')
    .join(' · ');
}

export function actionableProgramSignalCount(participant: ProgramHealthParticipant): number {
  return (participant.reasons || []).filter(reason => {
    const normalized = reason.trim().toLocaleLowerCase('es');
    return normalized !== '' && normalized !== 'sin alertas';
  }).length;
}

function compareNumbers(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareCalendarKeys(left?: string, right?: string): number {
  const leftKey = calendarDateKey(left);
  const rightKey = calendarDateKey(right);
  const leftValid = Boolean(toCalendarParts(leftKey));
  const rightValid = Boolean(toCalendarParts(rightKey));
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  if (!leftValid) return 0;
  return spanishCollator.compare(leftKey, rightKey);
}

function compareTenure(
  left: ProgramHealthParticipant,
  right: ProgramHealthParticipant,
  asOfDate: string,
): number {
  const leftTenure = getProgramTenure(left.enrolled_at, asOfDate);
  const rightTenure = getProgramTenure(right.enrolled_at, asOfDate);
  const rank = { future: 0, duration: 1, invalid: 2 } as const;
  const kindComparison = compareNumbers(rank[leftTenure.kind], rank[rightTenure.kind]);
  if (kindComparison !== 0) return kindComparison;
  if (leftTenure.kind === 'future') {
    return compareCalendarKeys(left.enrolled_at, right.enrolled_at);
  }
  if (leftTenure.kind === 'duration') {
    // A later incorporation date is a shorter tenure.
    return -compareCalendarKeys(left.enrolled_at, right.enrolled_at);
  }
  return 0;
}

function compareProgramHealthPrimary(
  left: ProgramHealthParticipant,
  right: ProgramHealthParticipant,
  key: ProgramHealthSortKey,
  asOfDate: string,
): number {
  switch (key) {
    case 'participant':
      return spanishCollator.compare(left.name || '', right.name || '');
    case 'health': {
      const rank = { critical: 0, watch: 1, healthy: 2 } as const;
      return compareNumbers(rank[left.health], rank[right.health]);
    }
    case 'attendance':
      return compareNumbers(Number(left.attendance_rate) || 0, Number(right.attendance_rate) || 0);
    case 'signals': {
      const countComparison = compareNumbers(actionableProgramSignalCount(left), actionableProgramSignalCount(right));
      return countComparison || spanishCollator.compare(normalizedSignalText(left), normalizedSignalText(right));
    }
    case 'enrolled_at':
      return compareCalendarKeys(left.enrolled_at, right.enrolled_at);
    case 'tenure':
      return compareTenure(left, right, asOfDate);
  }
}

function compareStableIdentity(left: ProgramHealthParticipant, right: ProgramHealthParticipant): number {
  const nameComparison = spanishCollator.compare(left.name || '', right.name || '');
  return nameComparison || spanishCollator.compare(left.participant_id, right.participant_id);
}

export function sortProgramHealthParticipants(
  participants: ProgramHealthParticipant[],
  sort: ProgramHealthSortState | null,
  asOfDate: string,
): ProgramHealthParticipant[] {
  if (!sort) return [...participants];
  const direction = sort.direction === 'ascending' ? 1 : -1;
  return [...participants].sort((left, right) => {
    const primary = compareProgramHealthPrimary(left, right, sort.key, asOfDate);
    return primary === 0 ? compareStableIdentity(left, right) : primary * direction;
  });
}
