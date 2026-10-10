import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_APP_MODULES } from '@/lib/mobileApp'
import { MobileAppBottomNavigation, MobileAppHeader, MobileUnavailableSurface } from './MobileAppChrome'

vi.mock('@/components/TaskBadge', () => ({ default: () => <span>3</span> }))
vi.mock('@/components/AccountSwitcher', () => ({ default: () => <span>Cuenta activa de prueba</span> }))

afterEach(cleanup)

describe('Clarin mobile app chrome', () => {
  const user = { username: 'qa', display_name: 'Usuario', role: 'user', account_id: 'account-a', account_name: 'Cuenta A', is_admin: false, is_super_admin: false }

  it('opens the single storage experience from the account panel and closes that panel', () => {
    render(<MobileAppHeader user={user} accountCount={1} activeLabel="Chats" version="test" hidden={false} onSwitchAccount={async () => null} onLogout={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir cuenta' }))
    const link = screen.getByRole('link', { name: /Almacenamiento/ })
    expect(link).toHaveAttribute('href', '/dashboard/storage')
    // jsdom cannot perform a Next navigation; keep testing the actual panel close.
    link.addEventListener('click', event => event.preventDefault())
    fireEvent.click(link)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not offer storage actions in offline mode', () => {
    render(<MobileAppHeader user={user} accountCount={1} activeLabel="Chats" version="test" hidden={false} storageAvailable={false} onSwitchAccount={async () => null} onLogout={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Abrir cuenta' }))
    expect(screen.queryByRole('link', { name: /Almacenamiento/ })).not.toBeInTheDocument()
  })

  it('renders the five allowed modules and marks nested routes as active', () => {
    render(<MobileAppBottomNavigation modules={MOBILE_APP_MODULES} pathname="/dashboard/programs/123" hidden={false} />)

    const navigation = screen.getByRole('navigation', { name: 'Módulos de Clarin móvil' })
    expect(navigation).toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(5)
    expect(screen.getByRole('link', { name: 'Programas' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /Tareas/ })).not.toHaveAttribute('aria-current')
  })

  it('does not reserve navigation space while the chat keyboard owns the surface', () => {
    const { container } = render(<MobileAppBottomNavigation modules={MOBILE_APP_MODULES} pathname="/dashboard/chats" hidden />)
    expect(container).toBeEmptyDOMElement()
  })

  it('explains excluded and permission-restricted routes without mounting their module', () => {
    const { rerender } = render(<MobileUnavailableSurface returnHref="/dashboard/chats" />)
    expect(screen.getByRole('heading', { name: 'Disponible en la versión completa' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Volver a Clarin móvil' })).toHaveAttribute('href', '/dashboard/chats')

    rerender(<MobileUnavailableSurface returnHref="/dashboard/contacts" permissionDenied />)
    expect(screen.getByRole('heading', { name: 'No tienes acceso a este módulo' })).toBeInTheDocument()
  })
})
