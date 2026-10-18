import type { Program } from '@/types/program'

export type ProgramStatusScope = 'active' | 'completed' | 'archived'
export const PROGRAM_DELETE_CONFIRMATION = '¿Eliminar este programa vacío? Si contiene datos o actividad, deberás archivarlo para conservar su historial.'

export function programScopeUrls(status: ProgramStatusScope) {
  return { programs: `/api/programs?status=${status}`, folders: `/api/programs/folders?status=${status}` }
}

export function programArchivePayload(program: Program) {
  return { ...program, status: program.status === 'archived' ? program.archived_from_status || 'active' : 'archived',
    description: program.description || '', expected_updated_at: program.updated_at }
}

export type ProgramLifecycleAction = 'complete' | 'reopen' | 'archive' | 'restore'

export function programLifecycleAction(program: Program, action: ProgramLifecycleAction) {
  const status = action === 'complete' ? 'completed' : action === 'reopen' ? 'active' : action === 'restore' ? program.archived_from_status || 'active' : 'archived'
  const label = { complete: 'Concluir programa', reopen: 'Reabrir programa', archive: 'Archivar programa', restore: 'Desarchivar programa' }[action]
  const explanation = {
    complete: 'El programa pasará a Completados. No se podrán añadir participantes ni crear sesiones. Podrás corregir asistencia y añadir observaciones en las sesiones existentes. Las participaciones y sus fechas se conservarán.',
    reopen: 'El programa volverá a Activos y permitirá nuevas inscripciones y sesiones. Se conservará todo su historial.',
    archive: 'El programa pasará a Archivados y conservará su historial. Al desarchivarlo recuperará su estado actual.',
    restore: `El programa saldrá de Archivados y volverá a ${status === 'completed' ? 'Completados' : 'Activos'}.${!program.archived_from_status ? ' Este archivo antiguo no tiene registrado su estado anterior.' : ''}`,
  }[action]
  const allowed = action === 'complete' ? program.status === 'active' : action === 'reopen' ? program.status === 'completed' : action === 'restore' ? program.status === 'archived' : program.status !== 'archived'
  return { status, label, explanation, allowed, payload: { ...program, description: program.description || '', status, expected_updated_at: program.updated_at } }
}
