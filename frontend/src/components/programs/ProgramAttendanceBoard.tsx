'use client'

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import { createPortal } from 'react-dom'
import { GripVertical, NotebookPen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import OperationalDragOverlay from '@/components/drag-interaction/OperationalDragOverlay'
import { useKanbanPan } from '@/lib/useKanbanPan'
import type { ProgramParticipant } from '@/types/program'
import ProgramAttendanceParticipantAvatar from './ProgramAttendanceParticipantAvatar'
import {
  PROGRAM_ATTENDANCE_STATUS_CATALOG,
  groupProgramAttendanceParticipants,
  nextProgramAttendanceStatus,
  type ProgramAttendanceDraft,
  type ProgramAttendanceStatus,
} from './programAttendance'

interface ProgramAttendanceBoardProps {
  participants: ProgramParticipant[]
  draft: ProgramAttendanceDraft
  disabled?: boolean
  onStatusChange: (participantID: string, status: ProgramAttendanceStatus) => void
  onOpenObservations: (participant: ProgramParticipant, trigger: HTMLElement | null) => void
  onDragStateChange?: (dragging: boolean) => void
}

type AttendanceDragData = {
  kind: 'program-attendance-participant'
  participant: ProgramParticipant
  sourceStatus: ProgramAttendanceStatus
}

export const attendanceCollisionDetection: CollisionDetection = args => (
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)
)

export function programAttendanceDropAnimation(reducedMotion: boolean) {
  return reducedMotion ? null : { duration: 180, easing: 'ease-out' }
}

export function syncProgramAttendanceHeaderScroll(
  board: Pick<HTMLElement, 'scrollLeft'>,
  header: Pick<HTMLElement, 'scrollLeft'> | null,
) {
  if (header) header.scrollLeft = board.scrollLeft
}

function usePrefersReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleChange = () => setReducedMotion(query.matches)
    handleChange()
    query.addEventListener?.('change', handleChange)
    return () => query.removeEventListener?.('change', handleChange)
  }, [])

  return reducedMotion
}

function participantName(participant: ProgramParticipant) {
  return participant.contact_name?.trim() || 'Participante sin nombre'
}

const attendanceKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const direction = event.code === 'ArrowRight' || event.code === 'ArrowDown'
    ? 1
    : event.code === 'ArrowLeft' || event.code === 'ArrowUp'
      ? -1
      : null
  if (!direction) return undefined

  const columns: Array<{ status: ProgramAttendanceStatus; left: number; top: number; width: number; height: number }> = []
  context.droppableContainers.getEnabled().forEach(container => {
    const status = container.data.current?.status as ProgramAttendanceStatus | undefined
    const rect = context.droppableRects.get(container.id)
    if (status !== undefined && rect) columns.push({ status, left: rect.left, top: rect.top, width: rect.width, height: rect.height })
  })
  columns.sort((first, second) => first.left - second.left || first.top - second.top)
  const active = context.active?.data.current as AttendanceDragData | undefined
  const currentStatus = context.over?.data.current?.status as ProgramAttendanceStatus | undefined ?? active?.sourceStatus ?? ''
  const nextStatus = nextProgramAttendanceStatus(currentStatus, direction)
  const target = columns.find(column => column.status === nextStatus)
  if (!target) return undefined
  event.preventDefault()
  return { x: target.left + target.width / 2, y: target.top + Math.min(72, target.height / 2) }
}

function AttendanceParticipantCard({
  participant,
  status,
  draft,
  disabled,
  onOpenObservations,
}: {
  participant: ProgramParticipant
  status: ProgramAttendanceStatus
  draft: ProgramAttendanceDraft
  disabled: boolean
  onOpenObservations: ProgramAttendanceBoardProps['onOpenObservations']
}) {
  const entry = draft[participant.id]
  const name = participantName(participant)
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, isDragging } = useDraggable({
    id: `attendance-participant:${participant.id}`,
    disabled,
    data: { kind: 'program-attendance-participant', participant, sourceStatus: status } satisfies AttendanceDragData,
  })
  const observationCount = entry?.observation_count || 0
  const observationCountID = `attendance-observation-count-${participant.id}`

  return (
    <article
      ref={setNodeRef}
      data-attendance-participant-card={participant.id}
      className={`rounded-2xl border border-slate-200 bg-white p-3 shadow-sm transition-[opacity,box-shadow,border-color] duration-150 motion-reduce:transition-none ${isDragging ? 'opacity-[0.22]' : 'hover:border-slate-300 hover:shadow-md'}`}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <ProgramAttendanceParticipantAvatar participant={participant} />
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="line-clamp-2 break-words text-sm font-semibold leading-5 text-slate-800">{name}</p>
          {participant.contact_phone && <p className="mt-0.5 truncate text-[10px] text-slate-400">{participant.contact_phone}</p>}
        </div>
        <button
          ref={setActivatorNodeRef}
          type="button"
          disabled={disabled}
          {...attributes}
          {...listeners}
          className="flex h-11 w-11 shrink-0 cursor-grab items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Mover a ${name}`}
          title="Arrastrar participante"
        >
          <GripVertical className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2.5 border-t border-slate-100 pt-2">
        <button
          type="button"
          disabled={disabled}
          onClick={event => onOpenObservations(participant, event.currentTarget)}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl bg-slate-50/80 px-3 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={`Abrir observaciones de asistencia de ${name}`}
          aria-describedby={observationCountID}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5"><NotebookPen className="h-3.5 w-3.5 shrink-0" />Observaciones</span>
          <span id={observationCountID} className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-bold tabular-nums text-slate-500 ring-1 ring-slate-200" aria-label={`${observationCount} observaciones registradas`}>· {observationCount}</span>
        </button>
      </div>
    </article>
  )
}

function AttendanceColumnHeader({
  status,
  count,
}: {
  status: ProgramAttendanceStatus
  count: number
}) {
  const presentation = PROGRAM_ATTENDANCE_STATUS_CATALOG.find(item => item.status === status)!

  return (
    <div
      data-attendance-column-header={status || 'unmarked'}
      className={`flex min-h-14 items-center gap-2 rounded-2xl border px-3 py-2 shadow-sm ${presentation.columnClassName}`}
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${presentation.dotClassName}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-xs font-bold text-slate-800">{presentation.label}</h3>
        <p className="truncate text-[10px] text-slate-500">{presentation.description}</p>
      </div>
      <span className="min-w-7 rounded-full bg-white/90 px-2 py-1 text-center text-[10px] font-bold tabular-nums text-slate-600 shadow-sm ring-1 ring-slate-200/70">{count}</span>
    </div>
  )
}

function AttendanceColumn({
  status,
  participants,
  draft,
  disabled,
  highlighted,
  onOpenObservations,
}: {
  status: ProgramAttendanceStatus
  participants: ProgramParticipant[]
  draft: ProgramAttendanceDraft
  disabled: boolean
  highlighted: boolean
  onOpenObservations: ProgramAttendanceBoardProps['onOpenObservations']
}) {
  const presentation = PROGRAM_ATTENDANCE_STATUS_CATALOG.find(item => item.status === status)!
  const { setNodeRef, isOver } = useDroppable({
    id: `attendance-column:${status || 'unmarked'}`,
    disabled,
    data: { kind: 'program-attendance-column', status },
  })
  const activeDestination = highlighted || isOver

  return (
    <section
      ref={setNodeRef}
      data-attendance-column={status || 'unmarked'}
      aria-label={`${presentation.label}: ${participants.length} participante${participants.length === 1 ? '' : 's'}`}
      className={`relative min-h-[160px] self-stretch rounded-2xl transition-[box-shadow,background-color] duration-150 motion-reduce:transition-none ${activeDestination ? 'bg-emerald-50/40 ring-2 ring-inset ring-emerald-400/80 shadow-lg' : ''}`}
    >
      <div data-attendance-column-surface className={`relative z-[1] rounded-2xl border p-2.5 shadow-sm transition-[box-shadow,border-color] duration-150 motion-reduce:transition-none ${presentation.columnClassName} ${activeDestination ? 'border-emerald-300 shadow-md' : ''}`}>
        <div className="space-y-2">
          {participants.map(participant => (
            <AttendanceParticipantCard
              key={participant.id}
              participant={participant}
              status={status}
              draft={draft}
              disabled={disabled}
              onOpenObservations={onOpenObservations}
            />
          ))}
          {participants.length === 0 && (
            <div className={`flex min-h-28 items-center justify-center rounded-xl border border-dashed px-3 text-center text-[11px] leading-5 transition-colors ${activeDestination ? 'border-emerald-400 bg-white/90 text-emerald-700' : 'border-slate-300/80 bg-white/45 text-slate-400'}`}>
              {activeDestination ? `Soltar en ${presentation.label}` : 'Arrastra participantes aquí'}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export default function ProgramAttendanceBoard({
  participants,
  draft,
  disabled = false,
  onStatusChange,
  onOpenObservations,
  onDragStateChange,
}: ProgramAttendanceBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null)
  const headerScrollRef = useRef<HTMLDivElement>(null)
  const [activeData, setActiveData] = useState<AttendanceDragData | null>(null)
  const [activeWidth, setActiveWidth] = useState<number | undefined>()
  const [overStatus, setOverStatus] = useState<ProgramAttendanceStatus | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const grouped = useMemo(() => groupProgramAttendanceParticipants(participants, draft), [draft, participants])
  useKanbanPan(boardRef, headerScrollRef)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 520, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: attendanceKeyboardCoordinates }),
  )

  const resetDrag = () => {
    setActiveData(null)
    setActiveWidth(undefined)
    setOverStatus(null)
    onDragStateChange?.(false)
  }

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as AttendanceDragData | undefined
    if (!data || data.kind !== 'program-attendance-participant') return
    setActiveData(data)
    setActiveWidth(event.active.rect.current.initial?.width)
    setOverStatus(data.sourceStatus)
    onDragStateChange?.(true)
  }

  const handleDragOver = (event: DragOverEvent) => {
    const status = event.over?.data.current?.status as ProgramAttendanceStatus | undefined
    setOverStatus(status ?? null)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const data = event.active.data.current as AttendanceDragData | undefined
    const destination = event.over?.data.current?.status as ProgramAttendanceStatus | undefined
    if (data?.kind === 'program-attendance-participant' && destination !== undefined && destination !== data.sourceStatus) {
      onStatusChange(data.participant.id, destination)
    }
    resetDrag()
  }

  const destination = PROGRAM_ATTENDANCE_STATUS_CATALOG.find(item => item.status === overStatus)

  return (
    <DndContext
      sensors={disabled ? [] : sensors}
      collisionDetection={attendanceCollisionDetection}
      autoScroll
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={resetDrag}
      accessibility={{
        screenReaderInstructions: { draggable: 'Pulsa Espacio para tomar el participante, usa las flechas para elegir un estado, Espacio para soltar o Escape para cancelar.' },
        announcements: {
          onDragStart: ({ active }) => `Moviendo ${participantName((active.data.current as AttendanceDragData).participant)}.`,
          onDragOver: ({ over }) => over ? `Destino ${(over.data.current?.status === '' ? 'Sin estado' : PROGRAM_ATTENDANCE_STATUS_CATALOG.find(item => item.status === over.data.current?.status)?.label) || 'no disponible'}.` : 'Fuera de una columna.',
          onDragEnd: ({ over }) => over ? 'Movimiento aplicado al borrador.' : 'Movimiento cancelado sin cambios.',
          onDragCancel: () => 'Movimiento cancelado sin cambios.',
        },
      }}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-xs text-slate-500">Arrastra desde el asa. Los cambios se aplicarán solo al guardar.</p>
        <p className="hidden text-[10px] font-medium text-slate-400 lg:block">Ctrl + arrastrar o botón central para recorrer el tablero</p>
      </div>
      <div data-testid="program-attendance-board-header" className="sticky -top-4 z-20 -mx-1 mb-2 bg-white/95 px-1 pb-1 pt-1 shadow-[0_8px_16px_-16px_rgba(15,23,42,.7)] backdrop-blur">
        <div ref={headerScrollRef} data-testid="program-attendance-board-header-scroll" className="overflow-hidden">
          <div className="grid w-full min-w-[1180px] grid-cols-5 items-stretch gap-3 p-1">
            {PROGRAM_ATTENDANCE_STATUS_CATALOG.map(item => (
              <AttendanceColumnHeader key={item.status || 'unmarked'} status={item.status} count={grouped[item.status].length} />
            ))}
          </div>
        </div>
      </div>
      <div
        ref={boardRef}
        data-testid="program-attendance-board"
        className="kanban-scroll overflow-x-auto overscroll-x-contain pb-3 focus-within:[scrollbar-color:#94a3b8_transparent]"
        onScroll={event => syncProgramAttendanceHeaderScroll(event.currentTarget, headerScrollRef.current)}
      >
        <div className="grid w-full min-w-[1180px] grid-cols-5 items-stretch gap-3 p-1">
          {PROGRAM_ATTENDANCE_STATUS_CATALOG.map(item => (
            <AttendanceColumn
              key={item.status || 'unmarked'}
              status={item.status}
              participants={grouped[item.status]}
              draft={draft}
              disabled={disabled}
              highlighted={activeData !== null && overStatus === item.status}
              onOpenObservations={onOpenObservations}
            />
          ))}
        </div>
      </div>
      {typeof document !== 'undefined' && createPortal(
        <DragOverlay dropAnimation={programAttendanceDropAnimation(reducedMotion)} style={{ zIndex: 160 }}>
          {activeData ? (
            <OperationalDragOverlay
              label={participantName(activeData.participant)}
              singular="participante"
              plural="participantes"
              destination={destination?.label}
              destinationColor={destination?.color}
              sourceWidth={activeWidth}
              idleLabel="Elige un estado de destino"
              ariaLabel={`Moviendo a ${participantName(activeData.participant)}`}
            />
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  )
}
