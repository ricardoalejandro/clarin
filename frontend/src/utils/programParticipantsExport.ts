import * as XLSX from 'xlsx'
import { saveAs } from 'file-saver'
import type { Program, ProgramParticipant } from '@/types/program'

const STATUS_LABELS: Record<ProgramParticipant['status'], string> = {
  active: 'Activo',
  completed: 'Completado',
  dropped: 'Retirado',
}

const formatEnrollmentDate = (value?: string) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
}

const safeFilename = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9 _-]/g, '')
  .trim()
  .replace(/\s+/g, '_') || 'programa'

export function exportProgramParticipants(program: Program, participants: ProgramParticipant[]) {
  const rows = participants.map((participant, index) => ({
    '#': index + 1,
    'Nombre': participant.contact_name || '',
    'Teléfono': participant.contact_phone || '',
    'Estado': STATUS_LABELS[participant.status] || participant.status,
    'Fecha de inscripción': formatEnrollmentDate(participant.enrolled_at),
    'Etapa': participant.stage_name || '',
  }))

  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: ['#', 'Nombre', 'Teléfono', 'Estado', 'Fecha de inscripción', 'Etapa'],
  })
  worksheet['!cols'] = [{ wch: 6 }, { wch: 30 }, { wch: 20 }, { wch: 16 }, { wch: 21 }, { wch: 24 }]
  worksheet['!autofilter'] = { ref: `A1:F${Math.max(rows.length + 1, 1)}` }

  // XLSX must receive an explicit string cell so leading + signs and zeroes are
  // never interpreted as numeric phone data by Excel.
  participants.forEach((participant, index) => {
    const address = XLSX.utils.encode_cell({ c: 2, r: index + 1 })
    worksheet[address] = { t: 's', v: participant.contact_phone || '', z: '@' }
  })

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Participantes')
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true })
  saveAs(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeFilename(program.name)}_participantes.xlsx`)
}
