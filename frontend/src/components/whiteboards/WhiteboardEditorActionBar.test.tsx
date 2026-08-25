import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import {
  WhiteboardEditorActionBar,
  whiteboardLibrarySidebarToggle,
} from './WhiteboardEditorActionBar'

function editorAPI(openSidebar: { name: string; tab?: string } | null = null) {
  return {
    getAppState: vi.fn(() => ({ openSidebar })),
    onChange: vi.fn(() => vi.fn()),
    toggleSidebar: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI
}

function renderBar(overrides: Partial<ComponentProps<typeof WhiteboardEditorActionBar>> = {}) {
  const api = overrides.editorAPI === undefined ? editorAPI() : overrides.editorAPI
  const props: ComponentProps<typeof WhiteboardEditorActionBar> = {
    editorAPI: api,
    showShare: true,
    canManageAccess: true,
    canEdit: true,
    saveState: 'saved',
    moreOpen: false,
    onShare: vi.fn(),
    onRetrySave: vi.fn(),
    onToggleMore: vi.fn(),
    ...overrides,
  }
  return { api, props, ...render(<WhiteboardEditorActionBar {...props} />) }
}

describe('WhiteboardEditorActionBar', () => {
  afterEach(cleanup)

  it('renders one ordered action island without a duplicate manual-save button', () => {
    renderBar()

    expect(screen.getAllByRole('button', { name: 'Biblioteca' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Compartir desde Clarin' })).toHaveLength(1)
    expect(screen.getAllByLabelText('Guardado en Clarin')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Más acciones de Pizarras' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Guardar ahora/ })).not.toBeInTheDocument()
    expect(Array.from(document.querySelectorAll('[data-whiteboard-action]')).map(node => node.getAttribute('data-whiteboard-action')))
      .toEqual(['library', 'share', 'more'])
  })

  it('moves Compartir out of the island when measured space is compact', () => {
    renderBar({ showShare: false })
    expect(screen.queryByRole('button', { name: 'Compartir desde Clarin' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Biblioteca' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Más acciones de Pizarras' })).toBeInTheDocument()
  })

  it('turns only retryable save states into one actionable status', () => {
    const onRetrySave = vi.fn()
    const rendered = renderBar({ onRetrySave })
    expect(screen.getByRole('status', { name: 'Guardado en Clarin' })).toBeInTheDocument()

    rendered.rerender(<WhiteboardEditorActionBar {...rendered.props} saveState="error" />)
    fireEvent.click(screen.getByRole('button', { name: 'No guardado · Reintentar' }))
    expect(onRetrySave).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('[data-whiteboard-save-status]')).toHaveLength(1)
  })

  it('owns the library sidebar toggle without relying on Excalidraw fallback controls', () => {
    const api = editorAPI()
    renderBar({ editorAPI: api })
    fireEvent.click(screen.getByRole('button', { name: 'Biblioteca' }))
    expect(api.toggleSidebar).toHaveBeenCalledWith({ name: 'default', tab: 'library', force: true })
    expect(whiteboardLibrarySidebarToggle({ name: 'default', tab: 'library' })).toEqual({
      name: 'default', tab: 'library', force: false,
    })
  })
})
