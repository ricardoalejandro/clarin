import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import AdminPasswordFields, { type AdminPasswordFieldsProps } from './AdminPasswordFields'

afterEach(cleanup)

const GENERATED_PASSWORD = 'Abcdefgh2!JKmnpqrs7@'

interface HarnessProps extends Pick<
  AdminPasswordFieldsProps,
  'copyText' | 'generatePassword' | 'onGenerated' | 'error' | 'disabled' | 'layout'
> {
  initialPassword?: string
  initialConfirmation?: string
}

function Harness({
  initialPassword = '',
  initialConfirmation = '',
  ...props
}: HarnessProps) {
  const [password, setPassword] = useState(initialPassword)
  const [confirmation, setConfirmation] = useState(initialConfirmation)
  return (
    <>
      <AdminPasswordFields
        password={password}
        confirmation={confirmation}
        onPasswordChange={setPassword}
        onConfirmationChange={setConfirmation}
        passwordId="test-password"
        confirmationId="test-confirmation"
        {...props}
      />
      <button type="button" onClick={() => { setPassword(''); setConfirmation('') }}>
        Limpiar prueba
      </button>
    </>
  )
}

describe('AdminPasswordFields', () => {
  it('generates both controlled values, reveals them, and announces the result', () => {
    const onGenerated = vi.fn()
    render(
      <Harness
        generatePassword={() => GENERATED_PASSWORD}
        onGenerated={onGenerated}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Generar clave' }))

    expect(screen.getByLabelText('Contraseña')).toHaveValue(GENERATED_PASSWORD)
    expect(screen.getByLabelText('Confirmar contraseña')).toHaveValue(GENERATED_PASSWORD)
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('Confirmar contraseña')).toHaveAttribute('type', 'text')
    expect(screen.getByRole('status')).toHaveTextContent('Clave segura generada')
    expect(screen.getByRole('progressbar', { name: 'Requisitos de contraseña cumplidos' })).toHaveAttribute('aria-valuenow', '7')
    expect(onGenerated).toHaveBeenCalledWith(GENERATED_PASSWORD)
  })

  it('fails closed and leaves both fields empty when secure generation is unavailable', () => {
    const onGenerated = vi.fn()
    render(
      <Harness
        generatePassword={() => { throw new Error('secure_random_unavailable') }}
        onGenerated={onGenerated}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Generar clave' }))

    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo generar una clave segura')
    expect(screen.getByLabelText('Contraseña')).toHaveValue('')
    expect(screen.getByLabelText('Confirmar contraseña')).toHaveValue('')
    expect(onGenerated).not.toHaveBeenCalled()
  })

  it('shows and hides both values with one accessible pressed control', () => {
    render(<Harness initialPassword={GENERATED_PASSWORD} initialConfirmation={GENERATED_PASSWORD} />)

    const showButton = screen.getByRole('button', { name: 'Mostrar claves' })
    expect(showButton).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'password')

    fireEvent.click(showButton)
    const hideButton = screen.getByRole('button', { name: 'Ocultar claves' })
    expect(hideButton).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('Confirmar contraseña')).toHaveAttribute('type', 'text')

    fireEvent.click(hideButton)
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'password')
  })

  it('copies only after the explicit action and exposes success through a live status', async () => {
    const copyText = vi.fn().mockResolvedValue(undefined)
    render(
      <Harness
        initialPassword={GENERATED_PASSWORD}
        initialConfirmation={GENERATED_PASSWORD}
        copyText={copyText}
      />,
    )

    expect(copyText).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Copiar clave' }))

    await waitFor(() => expect(copyText).toHaveBeenCalledWith(GENERATED_PASSWORD))
    expect(await screen.findByRole('status')).toHaveTextContent('Clave copiada al portapapeles')
    expect(screen.getByRole('button', { name: 'Clave copiada' })).toBeInTheDocument()
  })

  it('reveals a focused selectable fallback when Clipboard API fails and clears it with the secret', async () => {
    const copyText = vi.fn().mockRejectedValue(new Error('clipboard denied'))
    render(
      <Harness
        initialPassword={GENERATED_PASSWORD}
        initialConfirmation={GENERATED_PASSWORD}
        copyText={copyText}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copiar clave' }))

    const fallback = await screen.findByRole('textbox', { name: 'Clave para copiar manualmente' })
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo copiar automáticamente')
    expect(fallback).toHaveValue(GENERATED_PASSWORD)
    expect(fallback).toHaveFocus()
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'text')

    fireEvent.click(screen.getByRole('button', { name: 'Limpiar prueba' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Clave para copiar manualmente' })).not.toBeInTheDocument())
    expect(screen.getByLabelText('Contraseña')).toHaveValue('')
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'password')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores a stale clipboard completion after the password changes', async () => {
    let finishCopy: (() => void) | undefined
    const copyText = vi.fn(() => new Promise<void>(resolve => { finishCopy = resolve }))
    render(
      <Harness
        initialPassword={GENERATED_PASSWORD}
        initialConfirmation={GENERATED_PASSWORD}
        copyText={copyText}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copiar clave' }))
    expect(screen.getByRole('button', { name: 'Copiando…' })).toBeDisabled()
    expect(copyText).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'Different2!Password' } })
    finishCopy?.()

    await waitFor(() => expect(copyText).toHaveBeenCalledOnce())
    expect(screen.queryByText('Clave copiada al portapapeles.')).not.toBeInTheDocument()
  })

  it('wires persistent field errors and disables every mutation control while pending', () => {
    render(
      <Harness
        initialPassword={GENERATED_PASSWORD}
        initialConfirmation={GENERATED_PASSWORD}
        error="La contraseña no cumple la política."
        disabled
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('La contraseña no cumple la política.')
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Confirmar contraseña')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Generar clave' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Mostrar claves' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Copiar clave' })).toBeDisabled()
  })
})
