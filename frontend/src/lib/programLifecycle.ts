import type { Program } from '@/types/program'

export type ProgramStatusScope = 'active' | 'completed' | 'archived'
export const PROGRAM_DELETE_CONFIRMATION = '¿Eliminar este programa vacío? Si contiene datos o actividad, deberás archivarlo para conservar su historial.'

export function programScopeUrls(status: ProgramStatusScope) {
  return { programs: `/api/programs?status=${status}`, folders: `/api/programs/folders?status=${status}` }
}

export function programArchivePayload(program: Program) {
  return { ...program, status: program.status === 'archived' ? 'active' : 'archived',
    description: program.description || '', expected_updated_at: program.updated_at }
}
