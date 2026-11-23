import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, useState } from 'react'
import type { AgendaItem, Task, TaskList, TaskWorkflowStatus, WorkEventOccurrence } from '@/types/task'
import TaskCalendarView from './TaskCalendarView'
import { consumeCalendarOpenRequest, type CalendarOpenRequest } from './calendarOpenRequest'
import { EMPTY_TASK_FILTERS } from './TaskFilters'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  subscribe: vi.fn((_listener: (event: unknown) => void) => vi.fn()),
}))

vi.mock('@/lib/api', () => ({
  apiGet: apiMocks.get,
  apiPost: apiMocks.post,
  apiPut: apiMocks.put,
  subscribeWebSocket: apiMocks.subscribe,
}))

vi.mock('./WorkEventEditor', () => ({
  default: ({ open, event, onClose }: { open: boolean; event?: { title: string }; onClose: () => void }) => open
    ? <div role="dialog" aria-label={event?.title || 'Nuevo evento'}><button onClick={onClose}>Cerrar editor</button></div>
    : null,
}))

let resizeMonthRows: ((height: number) => void) | undefined

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
    openRequestContextKey: 'context-1',
    onOpenRequestConsumed: vi.fn(),
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
  resizeMonthRows = undefined
  class ResizeObserverMock {
    constructor(private callback: ResizeObserverCallback) {}
    observe(node: HTMLElement) {
      const report = (height: number) => this.callback([{ target: node, contentRect: new DOMRect(0, 0, 1000, height), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this as unknown as ResizeObserver)
      if (node.hasAttribute('data-calendar-month-rows')) resizeMonthRows = report
      report(660)
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 1000, this.hasAttribute('data-calendar-month-rows') ? 660 : 110)
  })
  apiMocks.get.mockReset()
  apiMocks.post.mockReset()
  apiMocks.put.mockReset()
  apiMocks.subscribe.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('calendar navigation and month density', () => {
  it.each([[2027, 1, 4], [2026, 5, 5], [2026, 10, 6]])('fits %i/%i in %i rows without a forced minimum height', async (year, month, weeks) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(year, month, 1, 12))
    renderCalendar()
    await calendarBlock()
    expect(document.querySelectorAll('[data-calendar-month-week]')).toHaveLength(weeks)
    expect(document.querySelector('[data-calendar-month-rows]')).toHaveStyle({ gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` })
    expect(document.querySelector('[data-calendar-month-rows]')).not.toHaveClass('min-h-[660px]')
    expect(document.querySelector('[data-calendar-scroll]')).toHaveClass('overflow-y-hidden')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it('changes from a 31-day month without skipping February', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2027, 0, 31, 12))
    renderCalendar()
    fireEvent.click(screen.getByRole('button', { name: 'Periodo siguiente' }))
    expect(screen.getByRole('heading', { name: /febrero.*2027/i })).toBeInTheDocument()
    expect(document.querySelector('[data-calendar-month-day="2027-02-28"]')).toBeInTheDocument()
  })

  it('keeps every dense-day item reachable through a bounded keyboard-accessible overflow panel', async () => {
    const task = scheduledTask()
    const items = Array.from({ length: 12 }, (_, index) => agendaItem({ ...task, id: `dense-${index}`, title: `Tarea ${index}` }))
    renderCalendar(task, {}, items)
    await calendarBlock()
    fireEvent.click(screen.getByRole('button', { name: /Ver 12 elementos/ }))
    const agenda = screen.getByRole('dialog', { name: /Agenda del/ })
    expect(agenda.querySelectorAll('[data-calendar-agenda-block]')).toHaveLength(12)
    expect(agenda).toHaveClass('flex-col', 'overflow-hidden')
    expect(agenda.lastElementChild).toHaveClass('min-h-0', 'overflow-y-auto')
    fireEvent.keyDown(agenda, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /Agenda del/ })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /Ver 12 elementos/ })).toHaveFocus())
    expect(screen.queryByText('Crear en este horario')).not.toBeInTheDocument()
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it('uses a compact overflow indicator when the measured rows cannot fit any items', async () => {
    const { container } = renderCalendar()
    await calendarBlock()
    const { act } = await import('@testing-library/react')
    act(() => resizeMonthRows?.(180))
    expect(container.querySelector('[data-calendar-agenda-block]')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ver 1 elemento/ })).toHaveClass('top-1.5')
  })

  it('keeps narrow-month items in the day inventory instead of rendering unreadable bars', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(375)
    const { container } = renderCalendar()
    fireEvent.click(await screen.findByRole('button', { name: /Ver 1 elemento/ }))
    expect(screen.getByRole('dialog', { name: /Agenda del/ })).toBeInTheDocument()
    expect(container.querySelector('[data-calendar-agenda-block]')).not.toBeInTheDocument()
    expect(document.querySelectorAll('[data-calendar-agenda-block]')).toHaveLength(1)
  })

  it('consumes explicit opens once across tab remounts and StrictMode', async () => {
    const base = renderCalendar()
    base.unmount()
    const consumed = vi.fn()
    function Harness() {
      const [visible, setVisible] = useState(false)
      const [request, setRequest] = useState<CalendarOpenRequest | null>(null)
      return <>
        <button onClick={() => setVisible(value => !value)}>Calendario</button>
        <button onClick={() => { setRequest({ id: crypto.randomUUID(), contextKey: 'context-1', kind: 'create' }); setVisible(true) }}>Solicitar evento</button>
        {visible && <TaskCalendarView {...base.props} openRequest={request} onOpenRequestConsumed={id => { consumed(id); setRequest(current => consumeCalendarOpenRequest(current, id)) }} />}
      </>
    }
    render(<StrictMode><Harness /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: 'Calendario' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Calendario' }))
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar evento' }))
    expect(screen.getByRole('dialog', { name: 'Nuevo evento' })).toBeInTheDocument()
    expect(consumed).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar editor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Calendario' }))
    fireEvent.click(screen.getByRole('button', { name: 'Calendario' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Solicitar evento' }))
    expect(consumed).toHaveBeenCalledTimes(2)
    expect(apiMocks.post).not.toHaveBeenCalled()
    expect(apiMocks.put).not.toHaveBeenCalled()
  })

  it('ignores foreign-context commands and cannot open creation without permission', () => {
    const { props, rerender } = renderCalendar(undefined, { openRequest: { id: 'old', contextKey: 'different-context', kind: 'create' } })
    expect(props.onOpenRequestConsumed).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    rerender(<TaskCalendarView {...props} canCreate={false} openRequest={{ id: 'new', contextKey: 'context-1', kind: 'create' }} />)
    expect(props.onOpenRequestConsumed).toHaveBeenCalledWith('new')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens a shared occurrence explicitly without replaying it after close or remount', () => {
    const task = scheduledTask()
    const occurrence = { start_at: task.start_at, occurrence_key: 'shared-occurrence', event: { id: 'shared-event', title: 'Evento compartido' } } as WorkEventOccurrence
    const { props, rerender, unmount } = renderCalendar(task, { canCreate: false, openRequest: { id: 'focus-1', contextKey: 'context-1', kind: 'focus', occurrence } })
    expect(screen.getByRole('dialog', { name: 'Evento compartido' })).toBeInTheDocument()
    expect(props.onOpenRequestConsumed).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar editor' }))
    rerender(<TaskCalendarView {...props} openRequest={null} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    unmount()
    const next = render(<TaskCalendarView {...props} openRequest={null} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    next.rerender(<TaskCalendarView {...props} openRequest={{ id: 'focus-2', contextKey: 'context-1', kind: 'focus', occurrence }} />)
    expect(screen.getByRole('dialog', { name: 'Evento compartido' })).toBeInTheDocument()
    expect(props.onOpenRequestConsumed).toHaveBeenCalledTimes(2)
    expect(apiMocks.post).not.toHaveBeenCalled()
    expect(apiMocks.put).not.toHaveBeenCalled()
  })
})

describe('TaskCalendarView schedule gestures', () => {
  function revokeAccess() {
    apiMocks.get.mockResolvedValue({ success: true, data: { items: [], next_cursor: '' } })
    act(() => apiMocks.subscribe.mock.calls.at(-1)![0]({ event: 'task_update', data: { action: 'access_revoked', target_type: 'task', target_id: 'task-calendar-1' } }))
  }

  it('closes the overflow inventory immediately when access is revoked', async () => {
    const tasks = Array.from({ length: 5 }, (_, index) => agendaItem({ ...scheduledTask(), id: `task-calendar-${index + 1}`, title: `Privada ${index + 1}` }))
    renderCalendar(tasks[0].kind === 'task' ? tasks[0].task : scheduledTask(), {}, tasks)
    fireEvent.click(await screen.findByRole('button', { name: /^Ver 5 elementos del/ }))
    expect(screen.getByTitle('Privada 5')).toBeVisible()
    revokeAccess()
    expect(screen.queryByTitle('Privada 5')).not.toBeInTheDocument()
    expect(document.querySelector('[data-calendar-agenda-block]')).not.toBeInTheDocument()
  })

  it.each(['success', 'conflict', 'network'])('ignores a late schedule %s after revocation', async outcome => {
    let finish!: (result: unknown) => void
    let fail!: (error: Error) => void
    apiMocks.put.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    renderCalendar()
    const trigger = (await calendarBlock()).querySelector('button')!
    fireEvent.keyDown(trigger, { key: ' ', altKey: true })
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    fireEvent.keyDown(trigger, { key: ' ', altKey: true })
    await waitFor(() => expect(apiMocks.put).toHaveBeenCalledTimes(1))
    revokeAccess()
    await act(async () => {
      if (outcome === 'network') fail(new Error('network'))
      else finish(outcome === 'success' ? { success: true, data: { task: scheduledTask(2) } } : { success: false, data: { code: 'schedule_conflict_confirmation_required' } })
    })
    expect(screen.queryByRole('button', { name: 'Deshacer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Guardar de todos modos' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Restauramos exactamente/)).not.toBeInTheDocument()
    expect(screen.queryByText(/se reprogramó/)).not.toBeInTheDocument()
    expect(document.querySelector('[data-calendar-agenda-block]')).not.toBeInTheDocument()
  })

  it('does not reveal a quick-created task after access is revoked during its request', async () => {
    let finish!: (result: unknown) => void
    apiMocks.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { props } = renderCalendar()
    await calendarBlock()
    fireEvent.click(document.querySelector('[data-calendar-month-day]') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Tarea' }))
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Creación privada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear' }))
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(1))
    revokeAccess()
    await act(async () => { finish({ success: true, data: { task: scheduledTask(2) } }) })
    expect(props.onCreated).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the pending quick creation mounted through Escape and backdrop until its outcome is known', async () => {
    let finish!: (result: unknown) => void
    apiMocks.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce({ success: true, data: { task: scheduledTask() } })
    const { props } = renderCalendar()
    await calendarBlock()
    fireEvent.click(document.querySelector('[data-calendar-month-day]') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Tarea' }))
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Creación pendiente' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear' }))
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(window, { key: 'Escape' })
    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(dialog.parentElement!)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cerrar creación del calendario' })).toBeDisabled()
    await act(async () => { finish({ success: false, status: 503, error: 'unknown' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar creación' }))
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledTimes(1))
    expect(apiMocks.post.mock.calls[1]).toEqual(apiMocks.post.mock.calls[0])
  })

  it('retries quick task creation with the same immutable operation after a lost response', async () => {
    const { props } = renderCalendar()
    apiMocks.post.mockResolvedValueOnce({ success: false, error: 'Network' })
      .mockResolvedValueOnce({ success: true, data: { task: scheduledTask() } })
    await waitFor(() => expect(document.querySelector('[data-calendar-month-day]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-calendar-month-day]') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Tarea' }))
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Reintento seguro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear' }))
    await waitFor(() => expect(screen.getByText(/No recibimos confirmación/)).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar creación' }))
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledTimes(1))
    expect(apiMocks.post.mock.calls[1]).toEqual(apiMocks.post.mock.calls[0])
  })

  it('sends settled task filters to agenda while retaining the event source', async () => {
    renderCalendar(scheduledTask(), { search: 'Alfa', filters: { ...EMPTY_TASK_FILTERS, priorities: ['urgent'], include_closed: true } })
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalled())
    const request = apiMocks.get.mock.calls.find(([url]) => String(url).includes('/agenda?'))!
    const query = new URL(String(request[0]), 'http://localhost').searchParams
    expect(query.get('search')).toBe('Alfa')
    expect(query.get('priorities')).toBe('urgent')
    expect(query.get('include_closed')).toBe('true')
    expect(query.get('sources')).toBe('tasks,events')
  })
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
