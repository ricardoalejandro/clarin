import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskPriority, TaskWorkflowStatus } from '@/types/task'
import { TaskPriorityIndicator, TaskStatusIndicator } from './TaskSemanticIndicators'

afterEach(cleanup)

describe('Task semantic indicators', () => {
  it('renders all four priorities with flag, text, and an accessible semantic name', () => {
    const priorities: TaskPriority[] = ['low', 'medium', 'high', 'urgent']
    render(<>{priorities.map(priority => <TaskPriorityIndicator key={priority} priority={priority} />)}</>)

    expect(screen.getByLabelText('Prioridad: Baja')).toHaveTextContent('Baja')
    expect(screen.getByLabelText('Prioridad: Media')).toHaveTextContent('Media')
    expect(screen.getByLabelText('Prioridad: Alta')).toHaveTextContent('Alta')
    expect(screen.getByLabelText('Prioridad: Urgente')).toHaveTextContent('Urgente')
    expect(document.querySelectorAll('[data-task-priority] svg')).toHaveLength(4)
  })

  it('keeps compact indicators named without confusing status with identity color', () => {
    const status = {
      id: 'status-urgent-review',
      name: 'En revisión',
      color: '#7C3AED',
    } as TaskWorkflowStatus
    render(<><TaskPriorityIndicator priority="urgent" compact /><TaskStatusIndicator status={status} compact /></>)

    expect(screen.getByLabelText('Prioridad: Urgente')).toHaveAttribute('data-task-priority', 'urgent')
    expect(screen.getByLabelText('Estado: En revisión')).toHaveAttribute('data-task-status', status.id)
    expect(screen.getByLabelText('Estado: En revisión').querySelector('svg')).toHaveStyle({ color: status.color })
  })

  it('provides an explicit fallback for tasks without canonical status detail', () => {
    render(<TaskStatusIndicator />)
    expect(screen.getByLabelText('Estado: Sin estado')).toHaveAttribute('data-task-status', 'none')
  })
})
