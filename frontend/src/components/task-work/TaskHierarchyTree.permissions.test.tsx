import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskFolder, TaskList, TaskPermissions } from '@/types/task'
import TaskHierarchyTree, { taskHierarchyCanManageStructure, taskHierarchyCanReceiveTasks } from './TaskHierarchyTree'

const full: TaskPermissions = { level: 'full', can_view: true, can_comment: true, can_edit: true, can_delete: true, can_manage_access: true }
const edit: TaskPermissions = { level: 'edit', can_view: true, can_comment: true, can_edit: true, can_delete: false, can_manage_access: false }
const view: TaskPermissions = { level: 'view', can_view: true, can_comment: false, can_edit: false, can_delete: false, can_manage_access: false }

function list(id: string, name: string, permissions?: TaskPermissions, isDefault = false): TaskList {
  return {
    id,
    account_id: 'account-1',
    environment_id: 'environment-1',
    name,
    color: '#10B981',
    icon: isDefault ? 'inbox' : 'list',
    sort_order: isDefault ? 0 : 1,
    is_default: isDefault,
    created_by: 'user-1',
    created_at: '',
    updated_at: '',
    task_count: 0,
    open_task_count: 0,
    completed_task_count: 0,
    cancelled_task_count: 0,
    permissions,
  }
}

function folder(permissions?: TaskPermissions): TaskFolder {
  return {
    id: 'folder-view',
    account_id: 'account-1',
    environment_id: 'environment-1',
    name: 'Carpeta visible',
    color: '#8B5CF6',
    icon: 'folder',
    sort_order: 1,
    created_by: 'user-1',
    created_at: '',
    updated_at: '',
    task_count: 0,
    open_task_count: 0,
    completed_task_count: 0,
    cancelled_task_count: 0,
    permissions,
    lists: [],
  }
}

function tree(collapsed: boolean) {
  return render(<TaskHierarchyTree
    folders={[folder(view)]}
    rootLists={[list('default', 'Bandeja general', full, true), list('edit', 'Editar solamente', edit), list('unknown', 'Sin capability')]}
    scope={{ type: 'environment', id: 'environment-1' }}
    collapsed={collapsed}
    onSelect={vi.fn()}
    onChanged={vi.fn()}
    onError={vi.fn()}
  />)
}

afterEach(cleanup)

describe('TaskHierarchyTree permissions', () => {
  it('exposes task drop targets only with explicit Edit capability in the collapsed rail', () => {
    const { container } = tree(true)
    expect(Array.from(container.querySelectorAll('[data-task-drop-list]')).map(item => item.getAttribute('data-task-drop-list'))).toEqual(['default', 'edit'])
    expect(container.querySelector('[data-task-drop-folder]')).not.toBeInTheDocument()
  })

  it('keeps Edit destinations droppable while hiding structure controls without Administrar', () => {
    const { container } = tree(false)
    const row = container.querySelector('[data-task-hierarchy-list="edit"]') as HTMLElement
    expect(row).toHaveAttribute('data-task-drop-list', 'edit')
    expect(within(row).queryByRole('button', { name: 'Personalizar Editar solamente' })).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Mover Editar solamente' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Personalizar Carpeta visible' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mover carpeta Carpeta visible' })).not.toBeInTheDocument()
  })

  it('fails closed when capabilities are absent', () => {
    const unknown = list('unknown', 'Sin capability')
    expect(taskHierarchyCanReceiveTasks(unknown)).toBe(false)
    expect(taskHierarchyCanManageStructure(unknown)).toBe(false)
  })
})
