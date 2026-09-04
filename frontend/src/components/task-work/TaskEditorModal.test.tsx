import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiGet, apiPost, apiPut, apiUpload } from '@/lib/api'
import type { Task, TaskAttachment, TaskList, TaskWorkflow, TaskWorkflowStatus } from '@/types/task'
import TaskEditorModal, { type TaskEditorModalHandle } from './TaskEditorModal'

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiUpload: vi.fn(),
}))

const status = {
  id: 'status-1', account_id: 'account-1', workflow_id: 'workflow-1', name: 'Pendiente', color: '#10B981',
  category: 'not_started', sort_order: 1, is_default: true, created_at: '', updated_at: '',
} satisfies TaskWorkflowStatus
const list = {
  id: 'list-1', account_id: 'account-1', workflow_id: 'workflow-1', name: 'General', color: '#10B981', icon: 'list',
  sort_order: 1, is_default: true, created_by: 'user-1', created_at: '', updated_at: '', task_count: 0,
  open_task_count: 0, completed_task_count: 0, cancelled_task_count: 0,
} satisfies TaskList
const workflow = {
  id: 'workflow-1', account_id: 'account-1', name: 'General', is_default: true, created_by: 'user-1',
  created_at: '', updated_at: '', statuses: [status],
} satisfies TaskWorkflow
const savedTask = {
  id: 'task-1', account_id: 'account-1', created_by: 'user-1', assigned_to: 'user-1', title: 'Nueva tarea',
  description: '', type: 'reminder', priority: 'medium', status: 'pending', status_id: 'status-1', list_id: 'list-1',
  status_detail: status, recurrence_rule: '', notes: '', progress: 0, version: 1, created_at: '', updated_at: '',
} as Task
const attachment = {
  id: 'attachment-1', account_id: 'account-1', task_id: 'task-1', media_asset_id: 'asset-1', filename: 'captura.png',
  content_type: 'image/png', media_type: 'image', size_bytes: 10, url: '/attachment',
} as TaskAttachment

function renderEditor(overrides: Partial<React.ComponentProps<typeof TaskEditorModal>> = {}) {
  const props: React.ComponentProps<typeof TaskEditorModal> = {
    open: true,
    lists: [list],
    folders: [],
    workflows: [workflow],
    users: [{ id: 'user-1', display_name: 'Usuario', username: 'usuario' }],
    defaultListId: list.id,
    defaultStatusId: status.id,
    defaultOwnerId: 'user-1',
    storageScope: 'account-1:user-1',
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  }
  return { ...render(<TaskEditorModal {...props} />), props }
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset()
  vi.mocked(apiPost).mockReset()
  vi.mocked(apiPut).mockReset()
  vi.mocked(apiUpload).mockReset()
  localStorage.clear()
})

afterEach(cleanup)

describe('TaskEditorModal', () => {
  it('requires an explicit discard decision before an external surface can close a dirty draft', async () => {
    const ref = React.createRef<TaskEditorModalHandle>()
    const onClose = vi.fn()
    const modalProps: React.ComponentProps<typeof TaskEditorModal> = {
      open: true,
      lists: [list],
      folders: [],
      workflows: [workflow],
      users: [{ id: 'user-1', display_name: 'Usuario', username: 'usuario' }],
      defaultListId: list.id,
      defaultStatusId: status.id,
      defaultOwnerId: 'user-1',
      defaultTitle: 'Borrador que no debe perderse',
      initialDraftDirty: true,
      onClose,
      onSaved: vi.fn(),
    }
    const rendered = render(<TaskEditorModal ref={ref} {...modalProps} />)
    expect(screen.getByPlaceholderText('¿Qué hay que lograr?')).toHaveValue('Borrador que no debe perderse')

    let cancelled!: Promise<boolean>
    await act(async () => { cancelled = ref.current!.requestClose() })
    expect(await screen.findByRole('alertdialog', { name: '¿Descartar el borrador?' })).toBeVisible()
    const continueEditing = screen.getByRole('button', { name: 'Continuar editando' })
    const discard = screen.getByRole('button', { name: 'Descartar' })
    await waitFor(() => expect(continueEditing).toHaveFocus())
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(discard).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await expect(cancelled).resolves.toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('¿Qué hay que lograr?')).toHaveValue('Borrador que no debe perderse')

    let revoked!: Promise<boolean>
    await act(async () => { revoked = ref.current!.requestClose() })
    expect(await screen.findByRole('alertdialog', { name: '¿Descartar el borrador?' })).toBeVisible()
    rendered.rerender(<TaskEditorModal ref={ref} {...modalProps} open={false} />)
    await expect(revoked).resolves.toBe(false)
    expect(screen.queryByRole('alertdialog', { name: '¿Descartar el borrador?' })).not.toBeInTheDocument()

    rendered.rerender(<TaskEditorModal ref={ref} {...modalProps} open />)
    expect(await screen.findByPlaceholderText('¿Qué hay que lograr?')).toHaveValue('Borrador que no debe perderse')
    let discarded!: Promise<boolean>
    await act(async () => { discarded = ref.current!.requestClose() })
    fireEvent.click(await screen.findByRole('button', { name: 'Descartar' }))
    await expect(discarded).resolves.toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses the shared numeric progress control and preserves automatic mode when editing', async () => {
    const automaticTask = {
      ...savedTask,
      progress: 50,
      progress_mode: 'automatic' as const,
      manual_progress: 35,
      subtask_count: 2,
      subtask_done: 1,
      permissions: { level: 'edit' as const, can_view: true, can_comment: true, can_edit: true, can_delete: false, can_manage_access: false },
    }
    vi.mocked(apiPut).mockResolvedValue({ success: true, data: { task: automaticTask } })
    renderEditor({ task: automaticTask })

    expect(document.querySelector('input[type="range"]')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Automático' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('50% calculado')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({
      progress: 50,
      progress_mode: 'automatic',
      manual_progress: 35,
    })))
  })

  it('restores manual progress on Escape without closing the editor', () => {
    const manualTask = {
      ...savedTask,
      progress: 35,
      progress_mode: 'manual' as const,
      manual_progress: 35,
      permissions: { level: 'edit' as const, can_view: true, can_comment: true, can_edit: true, can_delete: false, can_manage_access: false },
    }
    const { props } = renderEditor({ task: manualTask })
    const input = screen.getByRole('spinbutton', { name: 'Porcentaje manual' })
    fireEvent.change(input, { target: { value: '72' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input).toHaveValue(35)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('creates a real Clarin Work task with the supplied CRM links', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, data: { task: savedTask, operation_id: 'operation-crm' } })
    renderEditor({ relatedScope: { contactId: 'contact-1', leadId: 'lead-1', eventId: 'event-1' } })
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Dar seguimiento' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Crear tarea' }))

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    expect(apiPost).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      contact_id: 'contact-1',
      lead_id: 'lead-1',
      event_id: 'event-1',
      start_at: '',
      due_at: '',
      is_all_day: false,
    }))
  })

  it('creates a due-only all-day task without deriving a start or a 17:00 deadline', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, data: { task: savedTask, operation_id: 'operation-due-only' } })
    const dueAt = '2026-08-26T23:59'
    renderEditor({ defaultDueAt: dueAt, defaultAllDay: true })
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Entregar informe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear tarea' }))

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    expect(apiPost).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      start_at: '',
      due_at: new Date(dueAt).toISOString(),
      is_all_day: true,
    }))
    expect((vi.mocked(apiPost).mock.calls[0]?.[1] as { due_at: string }).due_at).not.toContain('T17:00')
  })

  it('preserves the exact interval supplied by Calendar more options', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, data: { task: savedTask, operation_id: 'operation-calendar' } })
    const startAt = '2026-08-26T09:15'
    const dueAt = '2026-08-26T10:45'
    renderEditor({ defaultStartAt: startAt, defaultDueAt: dueAt, defaultAllDay: false })
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Tarea desde calendario' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear tarea' }))

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    expect(apiPost).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      start_at: new Date(startAt).toISOString(),
      due_at: new Date(dueAt).toISOString(),
      is_all_day: false,
    }))
  })

  it('creates a one-level child through the canonical children endpoint', async () => {
    const child = { ...savedTask, id: 'child-1', parent_task_id: 'parent-1' }
    vi.mocked(apiPost).mockResolvedValue({ success: true, data: { task: child, operation_id: 'operation-child' } })
    const { props } = renderEditor({ parentTaskId: 'parent-1', parentTaskTitle: 'Tarea principal' })

    expect(screen.getByRole('dialog', { name: 'Crear subtarea' })).toBeInTheDocument()
    expect(screen.queryByText('Tipo')).not.toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: 'Porcentaje manual' })).not.toBeInTheDocument()
    expect(document.querySelectorAll('[data-task-date-range-trigger]')).toHaveLength(1)
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Paso verificable' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear subtarea' }))

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    expect(apiPost).toHaveBeenCalledWith('/api/tasks/parent-1/children', expect.objectContaining({
      title: 'Paso verificable',
      assigned_to: 'user-1',
      status_id: 'status-1',
      priority: 'medium',
      start_at: '',
      due_at: '',
      is_all_day: false,
      operation_id: expect.any(String),
      confirm_grants: false,
    }))
    const submitted = vi.mocked(apiPost).mock.calls[0]?.[1] as Record<string, unknown>
    expect(submitted).not.toHaveProperty('parent_task_id')
    expect(submitted).not.toHaveProperty('collaborator_ids')
    expect(submitted).not.toHaveProperty('progress_mode')
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(child, 'operation-child', undefined))
  })

  it('creates once with Ctrl/Command+Enter from the form', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, data: { task: savedTask, operation_id: 'operation-1' } })
    const { props } = renderEditor()
    const title = screen.getByPlaceholderText('¿Qué hay que lograr?')
    fireEvent.change(title, { target: { value: 'Nueva tarea' } })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Crear tarea' })).toBeEnabled())
    fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    expect(apiPost).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({ title: 'Nueva tarea' }))
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores repeated submit shortcuts while a request is active', async () => {
    let resolveCreate!: (value: { success: true; data: { task: Task } }) => void
    vi.mocked(apiPost).mockReturnValue(new Promise(resolve => { resolveCreate = resolve }))
    renderEditor()
    const title = screen.getByPlaceholderText('¿Qué hay que lograr?')
    fireEvent.change(title, { target: { value: 'Una sola tarea' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Crear tarea' })).toBeEnabled())

    fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true, repeat: true })
    expect(apiPost).toHaveBeenCalledTimes(1)

    resolveCreate({ success: true, data: { task: savedTask } })
    await waitFor(() => expect(screen.queryByLabelText('Guardando')).not.toBeInTheDocument())
  })

  it('keeps the expanded description draft and focus after a create conflict', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: false, status: 409, error: 'conflicto temporal' })
    renderEditor()
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Tarea en conflicto' } })
    fireEvent.click(screen.getByRole('button', { name: 'Expandir descripción' }))
    const expanded = document.querySelector('[data-task-description-expanded] textarea') as HTMLTextAreaElement
    fireEvent.change(expanded, { target: { value: 'El borrador debe sobrevivir.' } })

    fireEvent.keyDown(expanded, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getAllByText('conflicto temporal')).not.toHaveLength(0))
    expect(document.querySelector('[data-task-description-expanded]')).toBeInTheDocument()
    expect(expanded).toHaveValue('El borrador debe sobrevivir.')
    await waitFor(() => expect(expanded).toHaveFocus())
  })

  it('does not submit through an open portaled picker', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, data: { task: savedTask } })
    renderEditor()
    const title = screen.getByPlaceholderText('¿Qué hay que lograr?')
    fireEvent.change(title, { target: { value: 'Esperar selector' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Crear tarea' })).toBeEnabled())
    const pickerBackdrop = document.createElement('button')
    pickerBackdrop.dataset.taskPickerBackdrop = ''
    document.body.appendChild(pickerBackdrop)

    fireEvent.keyDown(title, { key: 'Enter', metaKey: true })
    expect(apiPost).not.toHaveBeenCalled()
    pickerBackdrop.remove()
  })

  it('lets the date-range picker own Escape and submit shortcuts', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, data: { task: savedTask } })
    const { props } = renderEditor()
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Programar sin cerrar' } })
    const dateTrigger = screen.getByRole('button', { name: /Fecha de entrega:/ })

    fireEvent.click(dateTrigger)
    const picker = screen.getByRole('dialog', { name: 'Editar Fecha de entrega' })
    fireEvent.keyDown(picker, { key: 'Enter', ctrlKey: true })
    expect(apiPost).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar Fecha de entrega' })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: 'Crear una tarea' })).toBeInTheDocument()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('retries only a failed pasted image after the task already exists', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, data: { task: savedTask, operation_id: 'operation-1' } })
    vi.mocked(apiUpload)
      .mockResolvedValueOnce({ success: false, error: 'sin conexión' })
      .mockResolvedValueOnce({ success: true, data: { success: true, attachment, operation_id: 'attachment-operation' } })
    const { props } = renderEditor()
    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Nueva tarea' } })
    const image = new File(['captura'], 'captura.png', { type: 'image/png', lastModified: 4 })
    fireEvent.paste(screen.getByRole('dialog', { name: 'Crear una tarea' }), {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
        files: [image],
      },
    })

    await waitFor(() => expect(screen.getByText('captura.png')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Crear tarea' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reintentar 1 adjunto' })).toBeEnabled())
    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(apiUpload).toHaveBeenCalledTimes(1)
    expect(props.onSaved).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar 1 adjunto' }))
    await waitFor(() => expect(apiUpload).toHaveBeenCalledTimes(2))
    expect(apiPost).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1))
  })

  it('confirms an explicit Edit grant and retries without losing the draft', async () => {
    vi.mocked(apiPost)
      .mockResolvedValueOnce({
        success: false,
        status: 409,
        data: { code: 'access_change_confirmation_required', affected_user_ids: ['user-2'] },
      })
      .mockResolvedValueOnce({ success: true, data: { task: savedTask, operation_id: 'operation-2' } })
    const { props } = renderEditor({
      users: [
        { id: 'user-1', display_name: 'Usuario', username: 'usuario' },
        { id: 'user-2', display_name: 'Colaboradora', username: 'colaboradora' },
      ],
    })
    const title = screen.getByPlaceholderText('¿Qué hay que lograr?')
    fireEvent.change(title, { target: { value: 'Borrador protegido' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Crear tarea' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Crear tarea' }))
    const confirmation = await screen.findByRole('alertdialog', { name: 'Confirmar acceso para participantes' })
    expect(confirmation).toHaveTextContent('Colaboradora')
    expect(title).toHaveValue('Borrador protegido')
    expect(apiPost).toHaveBeenNthCalledWith(1, '/api/tasks', expect.objectContaining({ confirm_grants: false }))

    fireEvent.click(screen.getByRole('button', { name: 'Conceder Editar y guardar' }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
    expect(apiPost).toHaveBeenNthCalledWith(2, '/api/tasks', expect.objectContaining({
      title: 'Borrador protegido',
      confirm_grants: true,
    }))
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('resolves the first editable list of a collapsed folder without expanding navigation', async () => {
    const remoteList = { ...list, id: 'list-remote', environment_id: 'environment-1', folder_id: 'folder-remote', is_default: false, name: 'Lista remota', permissions: { level: 'full' as const, can_view: true, can_comment: true, can_edit: true, can_delete: true, can_manage_access: true } }
    vi.mocked(apiGet).mockResolvedValue({ success: true, status: 200, data: { lists: [remoteList] } })

    renderEditor({
      environmentId: 'environment-1',
      defaultFolderId: 'folder-remote',
      defaultListId: undefined,
      lists: [],
    })

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(
      '/api/tasks/environments/environment-1/lists?folder_id=folder-remote&limit=50',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    await waitFor(() => expect(screen.getByRole('button', { name: /Lista remota/i })).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('¿Qué hay que lograr?'), { target: { value: 'Crear dentro de carpeta remota' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Crear tarea' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: /Lista remota/i }))
    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Seleccionar lista' })).toBeVisible())
    expect(document.querySelector('[data-task-picker-backdrop]')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByPlaceholderText('¿Qué hay que lograr?'), { key: 'Enter', ctrlKey: true })
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('closes an existing editor fail-closed when edit access is revoked', async () => {
    const editableTask = {
      ...savedTask,
      permissions: { level: 'edit' as const, can_view: true, can_comment: true, can_edit: true, can_delete: false, can_manage_access: false },
    }
    const { props, rerender } = renderEditor({ task: editableTask })
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Editar tarea' })).toBeVisible())

    rerender(<TaskEditorModal {...props} task={{
      ...editableTask,
      permissions: { ...editableTask.permissions, level: 'view', can_edit: false },
    }} />)

    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1))
  })
})
