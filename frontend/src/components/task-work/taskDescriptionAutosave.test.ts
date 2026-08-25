import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TASK_DESCRIPTION_AUTOSAVE_DELAY_MS,
  TASK_DESCRIPTION_SAVED_VISIBLE_MS,
  TaskDescriptionAutosaveCoordinator,
  type TaskDescriptionSaveOutcome,
} from './taskDescriptionAutosave'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

describe('TaskDescriptionAutosaveCoordinator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('waits exactly 800 ms, saves once and clears the success state after 1.5 seconds', async () => {
    const states: string[] = []
    const save = vi.fn(async request => ({ kind: 'success', description: request.description } as const))
    const coordinator = new TaskDescriptionAutosaveCoordinator({ save, onStateChange: (_taskId, state) => states.push(state.phase) })
    coordinator.hydrate('task-a', 'Inicial')
    coordinator.change('task-a', 'Borrador')

    await vi.advanceTimersByTimeAsync(TASK_DESCRIPTION_AUTOSAVE_DELAY_MS - 1)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ taskId: 'task-a', description: 'Borrador', versionOverride: undefined })
    expect(coordinator.getState('task-a')?.phase).toBe('saved')

    await vi.advanceTimersByTimeAsync(TASK_DESCRIPTION_SAVED_VISIBLE_MS)
    expect(coordinator.getState('task-a')?.phase).toBe('idle')
    expect(states).toContain('dirty')
    expect(states).toContain('saving')
  })

  it('pauses while IME composition is active and saves after composition ends', async () => {
    const save = vi.fn(async request => ({ kind: 'success', description: request.description } as const))
    const coordinator = new TaskDescriptionAutosaveCoordinator({ save })
    coordinator.hydrate('task-a', '')
    coordinator.change('task-a', 'あ', true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(save).not.toHaveBeenCalled()
    coordinator.setComposing('task-a', false)
    await vi.advanceTimersByTimeAsync(TASK_DESCRIPTION_AUTOSAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].description).toBe('あ')
  })

  it('keeps one request active and sends only the latest trailing draft', async () => {
    const first = deferred<TaskDescriptionSaveOutcome>()
    const second = deferred<TaskDescriptionSaveOutcome>()
    const save = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const coordinator = new TaskDescriptionAutosaveCoordinator({ save })
    coordinator.hydrate('task-a', 'Inicial')
    coordinator.change('task-a', 'Uno')
    const flush = coordinator.flush('task-a')
    expect(save).toHaveBeenCalledTimes(1)

    coordinator.change('task-a', 'Dos')
    coordinator.change('task-a', 'Tres')
    expect(save).toHaveBeenCalledTimes(1)
    first.resolve({ kind: 'success', description: 'Uno' })
    await Promise.resolve()
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0].description).toBe('Tres')

    second.resolve({ kind: 'success', description: 'Tres' })
    await expect(flush).resolves.toBe(true)
    expect(coordinator.getState('task-a')).toMatchObject({ canonical: 'Tres', draft: 'Tres', phase: 'saved' })
  })

  it('preserves a conflicting local draft and supports either explicit resolution', async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({
        kind: 'conflict',
        message: 'La descripción cambió en otra sesión.',
        current: { description: 'Remota', version: 7, updated_at: '2026-08-25T12:00:00Z' },
      } satisfies TaskDescriptionSaveOutcome)
      .mockImplementation(async request => ({ kind: 'success', description: request.description } as const))
    const coordinator = new TaskDescriptionAutosaveCoordinator({ save })
    coordinator.hydrate('task-a', 'Inicial')
    coordinator.change('task-a', 'Local')

    await expect(coordinator.flush('task-a')).resolves.toBe(false)
    expect(coordinator.getState('task-a')).toMatchObject({ phase: 'conflict', draft: 'Local', canonical: 'Remota' })
    await expect(coordinator.keepLocal('task-a')).resolves.toBe(true)
    expect(save.mock.calls[1][0]).toEqual({ taskId: 'task-a', description: 'Local', versionOverride: 7 })

    coordinator.change('task-a', 'Edición posterior')
    coordinator.receiveRemote('task-a', { description: 'Otra remota', version: 9 })
    expect(coordinator.getState('task-a')?.phase).toBe('conflict')
    expect(coordinator.useRemote('task-a')).toMatchObject({ description: 'Otra remota', version: 9 })
    expect(coordinator.getState('task-a')).toMatchObject({ phase: 'saved', draft: 'Otra remota', canonical: 'Otra remota' })
  })

  it('keeps an error actionable and retries the same draft without duplication', async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ kind: 'error', message: 'Sin conexión' } satisfies TaskDescriptionSaveOutcome)
      .mockImplementation(async request => ({ kind: 'success', description: request.description } as const))
    const coordinator = new TaskDescriptionAutosaveCoordinator({ save })
    coordinator.hydrate('task-a', '')
    coordinator.change('task-a', 'Pendiente')

    await expect(coordinator.flush('task-a')).resolves.toBe(false)
    expect(coordinator.getState('task-a')).toMatchObject({ phase: 'error', message: 'Sin conexión', draft: 'Pendiente' })
    await expect(coordinator.retry('task-a')).resolves.toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('accepts a clean remote value but turns a newer remote value into a conflict while dirty', () => {
    const coordinator = new TaskDescriptionAutosaveCoordinator({ save: vi.fn() })
    coordinator.hydrate('task-a', 'Inicial')
    coordinator.receiveRemote('task-a', { description: 'Remota limpia', version: 2 })
    expect(coordinator.getState('task-a')).toMatchObject({ phase: 'idle', draft: 'Remota limpia', canonical: 'Remota limpia' })

    coordinator.change('task-a', 'Borrador local')
    coordinator.receiveRemote('task-a', { description: 'Remota nueva', version: 3 })
    expect(coordinator.getState('task-a')).toMatchObject({
      phase: 'conflict',
      draft: 'Borrador local',
      canonical: 'Remota nueva',
      conflict: { description: 'Remota nueva', version: 3 },
    })
  })

  it('deduplicates a remote event that already contains the unsaved local body', () => {
    const save = vi.fn()
    const coordinator = new TaskDescriptionAutosaveCoordinator({ save })
    coordinator.hydrate('task-a', 'Inicial')
    coordinator.change('task-a', 'Mismo contenido')
    coordinator.receiveRemote('task-a', { description: 'Mismo contenido', version: 2 })

    expect(coordinator.getState('task-a')).toMatchObject({ phase: 'idle', draft: 'Mismo contenido', canonical: 'Mismo contenido' })
    expect(save).not.toHaveBeenCalled()
  })

  it('turns a late canonical read into a conflict without flagging unrelated updates', () => {
    const coordinator = new TaskDescriptionAutosaveCoordinator({ save: vi.fn() })
    coordinator.hydrate('task-a', 'Inicial')
    coordinator.change('task-a', 'Borrador local')

    coordinator.syncCanonical('task-a', 'Inicial', { description: 'Inicial', version: 2 })
    expect(coordinator.getState('task-a')).toMatchObject({ phase: 'dirty', draft: 'Borrador local', canonical: 'Inicial' })

    coordinator.syncCanonical('task-a', 'Remota tardía', { description: 'Remota tardía', version: 3, updated_at: '2026-08-25T13:00:00Z' })
    expect(coordinator.getState('task-a')).toMatchObject({
      phase: 'conflict',
      draft: 'Borrador local',
      canonical: 'Remota tardía',
      conflict: { description: 'Remota tardía', version: 3 },
    })
  })

  it('starts every pending save before disposal cancels timers', async () => {
    const save = vi.fn(async request => ({ kind: 'success', description: request.description } as const))
    const coordinator = new TaskDescriptionAutosaveCoordinator({ save })
    coordinator.hydrate('task-a', 'A')
    coordinator.hydrate('task-b', 'B')
    coordinator.change('task-a', 'A pendiente')
    coordinator.change('task-b', 'B pendiente')

    const flushing = coordinator.flushAll()
    coordinator.dispose()
    await expect(flushing).resolves.toBe(true)
    expect(save).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(TASK_DESCRIPTION_AUTOSAVE_DELAY_MS * 2)
    expect(save).toHaveBeenCalledTimes(2)
  })
})
