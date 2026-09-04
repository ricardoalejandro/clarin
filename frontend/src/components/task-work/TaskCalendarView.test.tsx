import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgendaItem, Task, TaskList, TaskWorkflowStatus, WorkEventOccurrence } from '@/types/task'
import TaskCalendarView from './TaskCalendarView'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
}))

vi.mock('@/lib/api', () => ({
  apiGet: apiMocks.get,
  apiPost: apiMocks.post,
  apiPut: apiMocks.put,
  subscribeWebSocket: apiMocks.subscribe,
}))

const status = {
  id: 'status-1',
  account_id: 'account-1',
  workflow_id: 'workflow-1',
  name: 'Por hacer',
  category: 'not_started',
  color: '#64748B',
  sort_order: 0,
} as TaskWorkflowStatus

const list = {
  id: 'list-1',
  account_id: 'account-1',
  workflow_id: 'workflow-1',
  name: 'Bandeja general',
  color: '#10B981',
  icon: 'list',
  sort_order: 0,
  is_default: true,
  created_by: 'user-1',
  created_at: '',
  updated_at: '',
  task_count: 1,
  open_task_count: 1,
  completed_task_count: 0,
  cancelled_task_count: 0,
} as TaskList

function scheduledTask(version = 1) {
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth(), 10, 9, 0, 0, 0)
  const due = new Date(today.getFullYear(), today.getMonth(), 10, 10, 0, 0, 0)
  return {
    id: 'task-calendar-1',
    account_id: 'account-1',
    title: 'Mover esta tarea',
    list_id: list.id,
    list_name: list.name,
    assigned_to: 'user-1',
    assigned_to_name: 'Usuario',
    priority: 'medium',
    status_id: status.id,
    status_detail: status,
    start_at: start.toISOString(),
    due_at: due.toISOString(),
    is_all_day: false,
    version,
    permissions: { can_view: true, can_edit: true, can_comment: true, can_delete: false, can_manage_access: false },
  } as Task
}

function agendaItem(task: Task): AgendaItem {
  return { kind: 'task', key: `task:${task.id}`, task }
}

function renderCalendar(task = scheduledTask(), overrides: Partial<React.ComponentProps<typeof TaskCalendarView>> = {}, agendaItems: AgendaItem[] = [agendaItem(task)]) {
  apiMocks.get.mockResolvedValue({ success: true, data: { items: agendaItems, next_cursor: '' } })
  const props: React.ComponentProps<typeof TaskCalendarView> = {
    lists: [list],
    folders: [],
    statuses: [status],
    users: [{ id: 'user-1', display_name: 'Usuario', username: 'usuario' }],
    currentUserID: 'user-1',
    onOpenTaskDetail: vi.fn(),
    onEditTask: vi.fn(),
    onCreated: vi.fn(),
    onOperation: vi.fn(),
    onMore: vi.fn(),
    ...overrides,
  }
  return { ...render(<TaskCalendarView {...props} />), props, task }
}

async function calendarBlock() {
  await waitFor(() => expect(document.querySelector('[data-calendar-agenda-block]')).not.toBeNull())
  return document.querySelector<HTMLElement>('[data-calendar-agenda-block]')!
}

beforeEach(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  apiMocks.get.mockReset()
  apiMocks.post.mockReset()
  apiMocks.put.mockReset()
  apiMocks.subscribe.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TaskCalendarView schedule gestures', () => {
  it('preserves the selected all-day interval when opening the full task form', async () => {
    const { props } = renderCalendar()
    const selectedDay = new Date()
    const dayKey = [selectedDay.getFullYear(), String(selectedDay.getMonth() + 1).padStart(2, '0'), String(selectedDay.getDate()).padStart(2, '0')].join('-')
    const start = new Date(selectedDay)
    start.setHours(0, 0, 0, 0)
    const due = new Date(selectedDay)
    due.setHours(23, 59, 0, 0)
    await waitFor(() => expect(document.querySelector(`[data-calendar-month-day="${dayKey}"]`)).not.toBeNull())

    fireEvent.click(document.querySelector(`[data-calendar-month-day="${dayKey}"]`) as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Tarea' }))
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Plan desde calendario' } })
    fireEvent.click(screen.getByRole('button', { name: 'Abrir formulario completo' }))

    expect(props.onMore).toHaveBeenCalledWith(status.id, expect.objectContaining({
      title: 'Plan desde calendario',
      startAt: start.toISOString(),
      dueAt: due.toISOString(),
      isAllDay: true,
    }))
  })

  it('keeps a short click as summary-only and never opens the editor automatically', async () => {
    const { props } = renderCalendar()
    const block = await calendarBlock()
    const trigger = block.querySelector('button')!
    fireEvent.click(trigger)

    expect(await screen.findByRole('dialog', { name: /Resumen de tarea: Mover esta tarea/ })).toBeInTheDocument()
    expect(props.onOpenTaskDetail).not.toHaveBeenCalled()
    expect(props.onEditTask).not.toHaveBeenCalled()
    expect(apiMocks.put).not.toHaveBeenCalled()
  })

  it('opens another task directly and marks it as current while the inspector is already open', async () => {
    const task = scheduledTask()
    const { props } = renderCalendar(task, { activeTaskId: 'another-open-task' })
    const block = await calendarBlock()
    const trigger = block.querySelector('button')!

    expect(trigger).not.toHaveAttribute('aria-current')
    fireEvent.click(trigger)

    expect(props.onOpenTaskDetail).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), trigger)
    expect(screen.queryByRole('dialog', { name: /Resumen de tarea/ })).not.toBeInTheDocument()
  })

  it.each(['Enter', ' '] as const)('reserves %s for opening a task without scheduling writes', async key => {
    const task = scheduledTask()
    const { props } = renderCalendar(task, { activeTaskId: 'another-open-task' })
    const block = await calendarBlock()
    const trigger = block.querySelector('button')!
    trigger.focus()

    expect(fireEvent.keyDown(trigger, { key })).toBe(true)
    if (key === ' ') fireEvent.keyUp(trigger, { key })
    fireEvent.click(trigger)

    expect(props.onOpenTaskDetail).toHaveBeenCalledTimes(1)
    expect(props.onOpenTaskDetail).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), trigger)
    expect(apiMocks.put).not.toHaveBeenCalled()
    expect(document.querySelector('[data-calendar-drag-preview]')).not.toBeInTheDocument()
  })

  it('keeps events on their summary path while a task inspector is open', async () => {
    const task = scheduledTask()
    const occurrence = {
      event: {
        id: 'event-calendar-1', account_id: 'account-1', list_id: list.id, environment_id: 'environment-1', organizer_id: 'user-1', organizer_name: 'Usuario', title: 'Evento del equipo', resolved_color: '#0EA5E9', color_source: 'item', availability: 'busy', is_all_day: false, start_at: task.start_at, end_at: task.due_at, timezone: 'America/Lima', status: 'scheduled', version: 1, created_by: 'user-1', created_at: '', updated_at: '', list_visible: true, attendees: [], capabilities: { can_view: true, can_edit: true, can_invite: true, can_cancel: true, can_trash: true, can_restore: false, can_purge: false, can_respond: true, can_set_reminder: true },
      },
      series_id: 'event-calendar-1', occurrence_key: 'event-calendar-1:2026-08-10', start_at: task.start_at, end_at: task.due_at, is_exception: false,
    } as WorkEventOccurrence
    const eventItem = { kind: 'event', key: 'event:event-calendar-1', event: occurrence } as AgendaItem
    const { props } = renderCalendar(task, { activeTaskId: task.id }, [eventItem])
    const block = await calendarBlock()
    fireEvent.click(block.querySelector('button')!)

    expect(await screen.findByRole('dialog', { name: /Resumen de evento: Evento del equipo/ })).toBeInTheDocument()
    expect(props.onOpenTaskDetail).not.toHaveBeenCalled()
  })

  it('keeps an equal-version projected task over an older calendar inventory and exposes priority and status', async () => {
    const canonical = scheduledTask(4)
    const projected = { ...canonical, priority: 'urgent' as const }
    renderCalendar(canonical, { activeTaskId: canonical.id, taskProjection: projected })
    const block = await calendarBlock()
    const trigger = block.querySelector('button')!

    await waitFor(() => expect(trigger).toHaveAttribute('aria-current', 'true'))
    expect(screen.getAllByLabelText('Prioridad: Urgente').length).toBeGreaterThan(0)
    expect(screen.getAllByLabelText('Estado: Por hacer').length).toBeGreaterThan(0)
  })

  it('moves once by keyboard and undo uses the canonical returned version', async () => {
    const initial = scheduledTask(1)
    const nextStart = new Date(initial.start_at!)
    const nextDue = new Date(initial.due_at!)
    nextStart.setDate(nextStart.getDate() + 1)
    nextDue.setDate(nextDue.getDate() + 1)
    const canonical = { ...initial, start_at: nextStart.toISOString(), due_at: nextDue.toISOString(), version: 2 }
    apiMocks.put
      .mockResolvedValueOnce({ success: true, data: { task: canonical } })
      .mockResolvedValueOnce({ success: true, data: { task: { ...initial, version: 3 } } })
    renderCalendar(initial)

    const block = await calendarBlock()
    const trigger = block.querySelector('button')!
    trigger.focus()
    fireEvent.keyDown(trigger, { key: ' ', altKey: true })
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    fireEvent.keyDown(trigger, { key: ' ', altKey: true })

    await waitFor(() => expect(apiMocks.put).toHaveBeenCalledTimes(1))
    expect(apiMocks.put).toHaveBeenNthCalledWith(1, `/api/tasks/${initial.id}`, expect.objectContaining({
      start_at: nextStart.toISOString(),
      due_at: nextDue.toISOString(),
      due_end_at: '',
      version: 1,
    }))

    fireEvent.click(await screen.findByRole('button', { name: 'Deshacer' }))
    await waitFor(() => expect(apiMocks.put).toHaveBeenCalledTimes(2))
    expect(apiMocks.put).toHaveBeenNthCalledWith(2, `/api/tasks/${initial.id}`, expect.objectContaining({
      start_at: initial.start_at,
      due_at: initial.due_at,
      version: 2,
    }))
  })

  it('cancels keyboard movement with Escape without writing', async () => {
    renderCalendar()
    const block = await calendarBlock()
    const trigger = block.querySelector('button')!
    trigger.focus()
    fireEvent.keyDown(trigger, { key: ' ', altKey: true })
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(apiMocks.put).not.toHaveBeenCalled()
    expect(document.querySelector('[data-calendar-drag-preview]')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('does not expose drag or resize affordances without edit permission', async () => {
    const readOnly = { ...scheduledTask(), permissions: { level: 'view' as const, can_view: true, can_edit: false, can_comment: false, can_delete: false, can_manage_access: false } }
    renderCalendar(readOnly)
    const block = await calendarBlock()
    const trigger = block.querySelector('button')!

    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Enter Space')
    expect(trigger).toHaveClass('cursor-pointer')
    expect(block.querySelector('[data-calendar-resize-end]')).toBeNull()
  })
})
