import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TaskDescriptionEditor, { taskDescriptionHeightStorageKey } from './TaskDescriptionEditor'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function ControlledDescription(props: Omit<React.ComponentProps<typeof TaskDescriptionEditor>, 'value' | 'onChange'>) {
  const [value, setValue] = useState('Borrador inicial')
  return <TaskDescriptionEditor {...props} value={value} onChange={setValue} />
}

describe('TaskDescriptionEditor', () => {
  it('shares one draft between inline and expanded modes and closes after a successful commit', async () => {
    const commit = vi.fn().mockResolvedValue(true)
    render(<ControlledDescription onCommit={commit} />)

    fireEvent.change(screen.getByPlaceholderText('Añade contexto, criterios de éxito o instrucciones…'), { target: { value: 'Detalle compartido' } })
    fireEvent.click(screen.getByRole('button', { name: 'Expandir descripción' }))

    const expanded = document.querySelector('[data-task-description-expanded] textarea') as HTMLTextAreaElement
    expect(expanded.value).toBe('Detalle compartido')
    fireEvent.keyDown(expanded, { key: 'Escape' })

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(document.querySelector('[data-task-description-expanded]')).not.toBeInTheDocument())
    expect((document.querySelector('[data-task-description]') as HTMLTextAreaElement).value).toBe('Detalle compartido')
  })

  it('keeps the expanded editor open when persistence fails', async () => {
    render(<ControlledDescription onCommit={() => Promise.resolve(false)} error={<div role="alert">No se pudo guardar</div>} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expandir descripción' }))
    fireEvent.click(screen.getByRole('button', { name: 'Listo' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No se pudo guardar'))
    expect(document.querySelector('[data-task-description-expanded]')).toBeInTheDocument()
  })

  it('submits with Ctrl/Command+Enter without losing the shared draft', async () => {
    const submit = vi.fn().mockResolvedValue(true)
    render(<ControlledDescription onSubmit={submit} />)
    const inline = document.querySelector('[data-task-description]') as HTMLTextAreaElement

    fireEvent.keyDown(inline, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(inline, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(inline, { key: 'Enter', ctrlKey: true, isComposing: true })

    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('closes the expanded editor after a successful task submission', async () => {
    const submit = vi.fn().mockResolvedValue(true)
    render(<ControlledDescription onSubmit={submit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expandir descripción' }))

    const expanded = document.querySelector('[data-task-description-expanded] textarea') as HTMLTextAreaElement
    fireEvent.keyDown(expanded, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(document.querySelector('[data-task-description-expanded]')).not.toBeInTheDocument())
    expect((document.querySelector('[data-task-description]') as HTMLTextAreaElement).value).toBe('Borrador inicial')
  })

  it('keeps the expanded draft and restores its focus when task submission fails', async () => {
    const submit = vi.fn().mockResolvedValue(false)
    render(<ControlledDescription onSubmit={submit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expandir descripción' }))

    const expanded = document.querySelector('[data-task-description-expanded] textarea') as HTMLTextAreaElement
    fireEvent.keyDown(expanded, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(document.querySelector('[data-task-description-expanded]')).toBeInTheDocument())
    await waitFor(() => expect(expanded).toHaveFocus())
    expect(expanded).toHaveValue('Borrador inicial')
  })

  it('persists preferred height per account/user scope', () => {
    const { rerender } = render(<ControlledDescription storageScope="account-a:user-a" />)
    const handle = screen.getByRole('slider', { name: 'Ajustar altura de la descripción' })
    fireEvent.keyDown(handle, { key: 'ArrowDown' })

    expect(handle).toHaveAttribute('aria-valuenow', '136')
    expect(localStorage.getItem(taskDescriptionHeightStorageKey('account-a:user-a'))).toBe('136')

    rerender(<ControlledDescription storageScope="account-b:user-a" />)
    expect(screen.getByRole('slider', { name: 'Ajustar altura de la descripción' })).toHaveAttribute('aria-valuenow', '112')
  })
})
