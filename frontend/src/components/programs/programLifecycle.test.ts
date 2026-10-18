import { describe, expect, it } from 'vitest'
import type { Program } from '@/types/program'
import { programArchivePayload, programLifecycleAction, programScopeUrls } from '@/lib/programLifecycle'

describe('program lifecycle contracts', () => {
  it.each(['active', 'completed', 'archived'] as const)('uses the same %s scope for programs and folders', scope => {
    expect(programScopeUrls(scope)).toEqual({ programs: `/api/programs?status=${scope}`, folders: `/api/programs/folders?status=${scope}` })
  })
  it('archives with the canonical configuration version and preserves the snapshot', () => {
    const program = { id: 'program', status: 'active', updated_at: '2026-10-07T12:00:00Z', description: '', name: 'Program', health_view_columns: ['health'] } as Program
    expect(programArchivePayload(program)).toEqual({ ...program, status: 'archived', expected_updated_at: program.updated_at })
    expect(program.status).toBe('active')
    expect(programArchivePayload({ ...program, status: 'archived' }).status).toBe('active')
  })
  it('restores the completed state and does not imply completion of participants', () => {
    const archived = { id: 'p', status: 'archived', archived_from_status: 'completed', updated_at: 'v2' } as Program
    expect(programArchivePayload(archived).status).toBe('completed')
    expect(programLifecycleAction(archived, 'restore').status).toBe('completed')
    expect(programLifecycleAction(archived, 'reopen').allowed).toBe(false)
    const complete = programLifecycleAction({ ...archived, status: 'active' }, 'complete')
    expect(complete.explanation).toContain('Las participaciones y sus fechas se conservarán')
    expect(complete.payload).not.toHaveProperty('completed_at')
  })
})
