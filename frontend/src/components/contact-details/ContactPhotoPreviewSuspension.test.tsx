import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ContactPhotoPreview from '@/components/ContactPhotoPreview'

afterEach(cleanup)

describe('ContactPhotoPreview suspended owner', () => {
  it('closes a transient photo portal and releases scroll instead of reopening it on resume', () => {
    const props = { name: 'Instructor de prueba', url: '/photo-test.png' }
    const view = render(<ContactPhotoPreview {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar foto de Instructor de prueba' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(document.body.style.overflow).toBe('hidden')
    view.rerender(<ContactPhotoPreview {...props} suspended />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.body.style.overflow).not.toBe('hidden')
    expect(screen.getByRole('button', { name: 'Ampliar foto de Instructor de prueba' })).toBeDisabled()
    view.rerender(<ContactPhotoPreview {...props} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
