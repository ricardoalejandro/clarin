import { describe, expect, it } from 'vitest';
import type { ProgramHealthParticipant } from '@/types/program';
import {
  actionableProgramSignalCount,
  getProgramTenure,
  nextProgramHealthSort,
  normalizeProgramHealthViewColumns,
  sortProgramHealthParticipants,
} from './programHealthView';

function participant(overrides: Partial<ProgramHealthParticipant> & Pick<ProgramHealthParticipant, 'participant_id' | 'name'>): ProgramHealthParticipant {
  return {
    contact_id: `contact-${overrides.participant_id}`,
    status: 'active',
    health: 'healthy',
    attendance_rate: 100,
    present: 1,
    late: 0,
    absent: 0,
    excused: 0,
    eligible_sessions: 1,
    marked_sessions: 1,
    pending: 0,
    recovery_sessions: 0,
    notes_count: 0,
    reasons: [],
    ...overrides,
  };
}

describe('program health view columns', () => {
  it('normalizes defaults, catalog order, duplicates, unknown keys, and an explicit empty selection', () => {
    expect(normalizeProgramHealthViewColumns(undefined)).toEqual(['health', 'attendance', 'signals']);
    expect(normalizeProgramHealthViewColumns([])).toEqual([]);
    expect(normalizeProgramHealthViewColumns(['tenure', 'health', 'tenure', 'unknown', 'enrolled_at'])).toEqual([
      'health',
      'enrolled_at',
      'tenure',
    ]);
  });

  it('starts a new sort ascending and toggles only the active header', () => {
    expect(nextProgramHealthSort(null, 'participant')).toEqual({ key: 'participant', direction: 'ascending' });
    expect(nextProgramHealthSort({ key: 'participant', direction: 'ascending' }, 'participant')).toEqual({ key: 'participant', direction: 'descending' });
    expect(nextProgramHealthSort({ key: 'participant', direction: 'descending' }, 'health')).toEqual({ key: 'health', direction: 'ascending' });
  });
});

describe('program tenure', () => {
  it.each([
    ['2026-08-23', '2026-08-23', '0a 0m 0d'],
    ['2026-01-31', '2026-02-28', '0a 1m 0d'],
    ['2024-02-29', '2025-02-28', '1a 0m 0d'],
    ['2023-02-28', '2024-02-29', '1a 0m 1d'],
    ['2024-01-31', '2025-03-12', '1a 1m 12d'],
  ])('calculates calendar duration from %s through %s', (start, end, compact) => {
    expect(getProgramTenure(start, end).compact).toBe(compact);
  });

  it('reports future and invalid dates honestly', () => {
    expect(getProgramTenure('2026-08-24', '2026-08-23')).toMatchObject({ kind: 'future', compact: 'Aún no inicia' });
    expect(getProgramTenure('2026-02-31', '2026-08-23')).toMatchObject({ kind: 'invalid', compact: '—' });
    expect(getProgramTenure('', '2026-08-23')).toMatchObject({ kind: 'invalid', compact: '—' });
  });
});

describe('program health sorting', () => {
  const asOfDate = '2026-08-23';
  const rows = [
    participant({ participant_id: 'b', name: 'Álvaro', health: 'healthy', attendance_rate: 90, enrolled_at: '2024-01-01', reasons: ['Sin alertas'] }),
    participant({ participant_id: 'c', name: 'Berta', health: 'critical', attendance_rate: 70, enrolled_at: '2026-08-30', reasons: ['Llamar', 'Ausencias'] }),
    participant({ participant_id: 'a', name: 'alvaro', health: 'watch', attendance_rate: 80, enrolled_at: '2026-07-23', reasons: ['Revisar'] }),
    participant({ participant_id: 'd', name: 'Celia', health: 'watch', attendance_rate: 80, enrolled_at: '2026-08-24', reasons: ['Sin alertas'] }),
  ];

  it('sorts participant names in Spanish and uses ID as the stable final tie', () => {
    const sorted = sortProgramHealthParticipants(rows, { key: 'participant', direction: 'ascending' }, asOfDate);
    expect(sorted.map(row => row.participant_id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sorts health, attendance, and actionable signals in both directions', () => {
    expect(sortProgramHealthParticipants(rows, { key: 'health', direction: 'ascending' }, asOfDate).map(row => row.health)).toEqual(['critical', 'watch', 'watch', 'healthy']);
    expect(sortProgramHealthParticipants(rows, { key: 'attendance', direction: 'descending' }, asOfDate).map(row => row.attendance_rate)).toEqual([90, 80, 80, 70]);
    expect(sortProgramHealthParticipants(rows, { key: 'signals', direction: 'ascending' }, asOfDate).map(row => actionableProgramSignalCount(row))).toEqual([0, 0, 1, 2]);
  });

  it('sorts enrollment oldest first and tenure shortest first with nearest futures first', () => {
    expect(sortProgramHealthParticipants(rows, { key: 'enrolled_at', direction: 'ascending' }, asOfDate).map(row => row.participant_id)).toEqual(['b', 'a', 'd', 'c']);
    expect(sortProgramHealthParticipants(rows, { key: 'tenure', direction: 'ascending' }, asOfDate).map(row => row.participant_id)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('does not mutate the filtered source array', () => {
    const source = [...rows];
    sortProgramHealthParticipants(source, { key: 'attendance', direction: 'ascending' }, asOfDate);
    expect(source.map(row => row.participant_id)).toEqual(rows.map(row => row.participant_id));
  });
});
