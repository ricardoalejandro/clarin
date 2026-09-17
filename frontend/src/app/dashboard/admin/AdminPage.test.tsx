import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPage from './page'

vi.mock('@/components/admin/OfflineAccessAdminV5', () => ({ default: () => <section aria-label="Autorizaciones offline del navegador" /> }))

interface TestRouteOptions {
  createAccount?: (init: RequestInit) => Response | Promise<Response>
  createRole?: (init: RequestInit) => Response | Promise<Response>
  createUser?: (init: RequestInit) => Response | Promise<Response>
}

const accounts = [
  {
    id: 'account-los-olivos',
    name: 'Filial Los Olivos',
    slug: 'los-olivos',
    plan: 'basic',
    max_devices: 5,
    max_users_override: null,
    max_users_effective: 10,
    storage_limit_bytes: 0,
    is_active: true,
    subscription_status: 'active',
    user_count: 0,
    device_count: 0,
    chat_count: 0,
    created_at: '2026-08-01T00:00:00Z',
  },
  {
    id: 'account-centro',
    name: 'Filial Centro',
    slug: 'centro',
    plan: 'pro',
    max_devices: 12,
    max_users_override: 25,
    max_users_effective: 25,
    storage_limit_bytes: 10 * 1024 * 1024 * 1024,
    is_active: true,
    subscription_status: 'active',
    user_count: 0,
    device_count: 0,
    chat_count: 0,
    created_at: '2026-08-01T00:00:00Z',
  },
]

const plans = [
  { code: 'basic', name: 'Basic', description: '', trial_days: 0, is_public: true, sort_order: 1 },
  { code: 'pro', name: 'Pro', description: '', trial_days: 14, is_public: true, sort_order: 2 },
]

const roles = [
  {
    id: 'role-support',
    name: 'Soporte',
    description: 'Atiende conversaciones',
    is_system: false,
    permissions: ['chats', 'contacts'],
    created_at: '2026-08-01T00:00:00Z',
  },
]

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response
}

function installFetch(options: TestRouteOptions = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, rawInit?: RequestInit) => {
    const url = String(input)
    const init = rawInit || {}
    const method = init.method || 'GET'

    if (url === '/api/admin/accounts' && method === 'GET') {
      return Promise.resolve(jsonResponse({ success: true, accounts }))
    }
    if (url === '/api/admin/plans' && method === 'GET') {
      return Promise.resolve(jsonResponse({ success: true, plans }))
    }
    if (url.startsWith('/api/admin/users') && method === 'GET') {
      return Promise.resolve(jsonResponse({ success: true, users: [] }))
    }
    if (url === '/api/admin/roles' && method === 'GET') {
      return Promise.resolve(jsonResponse({ success: true, roles }))
    }
    if (url.startsWith('/api/admin/storage/orphans?') && method === 'GET') {
      const emptyGroup = { objects: 0, bytes: 0, accounts: [] }
      return Promise.resolve(jsonResponse({
        success: true,
        summary: {
          total_objects: 0,
          total_bytes: 0,
          referenced_objects: 0,
          min_age_days: 30,
          deleted_account_orphans: emptyGroup,
          active_account_orphans: emptyGroup,
          active_eligible_orphans: emptyGroup,
        },
      }))
    }
    if (url === '/api/admin/accounts' && method === 'POST') {
      return Promise.resolve(options.createAccount?.(init) || jsonResponse({ success: true }))
    }
    if (url === '/api/admin/users' && method === 'POST') {
      return Promise.resolve(options.createUser?.(init) || jsonResponse({ success: true }))
    }
    if (url === '/api/admin/roles' && method === 'POST') {
      return Promise.resolve(options.createRole?.(init) || jsonResponse({ success: true }))
    }

    return Promise.resolve(jsonResponse({ success: false }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function matchingCalls(fetchMock: ReturnType<typeof vi.fn>, url: string, method: string) {
  return fetchMock.mock.calls.filter(([input, init]) =>
    String(input) === url && ((init as RequestInit | undefined)?.method || 'GET') === method,
  )
}

async function renderAdminPage() {
  render(<AdminPage />)
  await screen.findByRole('button', { name: 'Nueva Cuenta' })
}

async function openCreateUserDialog() {
  fireEvent.click(screen.getByRole('button', { name: /^Usuarios\b/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Nuevo Usuario' }))
  return screen.findByRole('dialog', { name: 'Crear usuario' })
}

let offsetParentSpy: ReturnType<typeof vi.spyOn>
let originalClipboardDescriptor: PropertyDescriptor | undefined
let originalScrollIntoViewDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('token', 'unit-test-token')
  offsetParentSpy = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
})

afterEach(() => {
  cleanup()
  offsetParentSpy.mockRestore()
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
  if (originalScrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoViewDescriptor)
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('AdminPage administrative creation flows', () => {
  it('removes the unrelated global search from the self-contained offline approval panel', async () => {
    installFetch()
    await renderAdminPage()
    expect(screen.getByPlaceholderText('Buscar cuentas...')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Offline' }))
    expect(screen.getByRole('region', { name: 'Autorizaciones offline del navegador' })).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Cuentas\b/ }))
    expect(screen.getByPlaceholderText('Buscar cuentas...')).toBeVisible()
  })
  it('reports and focuses the first invalid account assignment before later fields', async () => {
    const fetchMock = installFetch()
    await renderAdminPage()
    const dialog = await openCreateUserDialog()

    const account = within(dialog).getByRole('combobox', { name: 'Cuenta 1' })
    fireEvent.change(account, { target: { value: '' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear usuario' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Selecciona una cuenta en cada asignación')
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Cuenta 1' })).toHaveFocus())
    expect(within(dialog).getByLabelText('Nombre de usuario')).not.toHaveFocus()
    expect(within(dialog).getByLabelText('Contraseña')).not.toHaveFocus()
    expect(matchingCalls(fetchMock, '/api/admin/users', 'POST')).toHaveLength(0)
  })

  it('keeps Crear usuario actionable, explains an invalid password, focuses it, and sends no POST', async () => {
    const fetchMock = installFetch()
    await renderAdminPage()
    await openCreateUserDialog()

    fireEvent.change(screen.getByLabelText('Nombre de usuario'), { target: { value: 'nuevo-agente' } })
    fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'Ab1!' } })
    fireEvent.change(screen.getByLabelText('Confirmar contraseña'), { target: { value: 'Ab1!' } })

    const submit = screen.getByRole('button', { name: 'Crear usuario' })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    expect(await screen.findByRole('alert')).toHaveTextContent('Completa los requisitos de contraseña')
    await waitFor(() => expect(screen.getByLabelText('Contraseña')).toHaveFocus())
    expect(matchingCalls(fetchMock, '/api/admin/users', 'POST')).toHaveLength(0)
  })

  it('generates and copies a secret explicitly, then clears it after closing the one-time summary', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    vi.stubGlobal('crypto', {
      getRandomValues: vi.fn((target: Uint8Array) => {
        target.fill(0)
        return target
      }),
    })
    installFetch()
    await renderAdminPage()
    const dialog = await openCreateUserDialog()

    fireEvent.change(within(dialog).getByLabelText('Nombre de usuario'), { target: { value: 'agente-generado' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generar clave' }))

    const generatedPassword = (within(dialog).getByLabelText('Contraseña') as HTMLInputElement).value
    expect(generatedPassword).toHaveLength(20)
    expect(within(dialog).getByLabelText('Confirmar contraseña')).toHaveValue(generatedPassword)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Copiar clave' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(generatedPassword))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear usuario' }))

    const summary = await screen.findByRole('dialog', { name: 'Usuario creado' })
    expect(within(summary).getByLabelText('Contraseña inicial')).toHaveValue(generatedPassword)
    await waitFor(() => expect(within(summary).getByLabelText('Usuario')).toHaveFocus())
    fireEvent.click(within(summary).getByRole('button', { name: 'Copiar credenciales' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`Usuario: agente-generado\nContraseña: ${generatedPassword}`))

    fireEvent.click(within(summary).getByRole('button', { name: 'He guardado las credenciales' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Usuario creado' })).not.toBeInTheDocument())

    const reopened = await openCreateUserDialog()
    expect(within(reopened).getByLabelText('Contraseña')).toHaveValue('')
    expect(within(reopened).getByLabelText('Confirmar contraseña')).toHaveValue('')
    expect(screen.queryByDisplayValue(generatedPassword)).not.toBeInTheDocument()
    const storedValues = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.getItem(localStorage.key(index) || ''),
    )
    expect(storedValues).not.toContain(generatedPassword)
  })

  it('reveals advanced account fields and sends identity, limits, and subscription once', async () => {
    const fetchMock = installFetch()
    await renderAdminPage()
    fireEvent.click(screen.getByRole('button', { name: 'Nueva Cuenta' }))

    const dialog = await screen.findByRole('dialog', { name: 'Crear cuenta' })
    const advanced = within(dialog).getByRole('button', { name: /Límites y suscripción/ })
    expect(advanced).toHaveAttribute('aria-expanded', 'false')
    expect(within(dialog).queryByLabelText('Máximo de dispositivos')).not.toBeInTheDocument()
    fireEvent.click(advanced)
    expect(advanced).toHaveAttribute('aria-expanded', 'true')

    fireEvent.change(within(dialog).getByLabelText('Nombre'), { target: { value: '  Cuenta Norte  ' } })
    fireEvent.change(within(dialog).getByLabelText(/Slug/), { target: { value: 'cuenta-norte' } })
    fireEvent.change(within(dialog).getByLabelText('Plan'), { target: { value: 'pro' } })
    fireEvent.change(within(dialog).getByLabelText('Máximo de dispositivos'), { target: { value: '8' } })
    fireEvent.change(within(dialog).getByLabelText('Límite de usuarios'), { target: { value: '25' } })
    fireEvent.change(within(dialog).getByLabelText('Almacenamiento (GB)'), { target: { value: '2' } })
    fireEvent.change(within(dialog).getByLabelText('Estado de suscripción'), { target: { value: 'trialing' } })
    fireEvent.change(within(dialog).getByLabelText('Prueba hasta'), { target: { value: '2026-09-15' } })
    fireEvent.change(within(dialog).getByLabelText('Periodo hasta'), { target: { value: '2026-10-01' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear cuenta' }))

    await waitFor(() => expect(matchingCalls(fetchMock, '/api/admin/accounts', 'POST')).toHaveLength(1))
    const [, init] = matchingCalls(fetchMock, '/api/admin/accounts', 'POST')[0]
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      name: 'Cuenta Norte',
      slug: 'cuenta-norte',
      plan: 'pro',
      max_devices: 8,
      max_users_override: 25,
      storage_limit_bytes: 2 * 1024 * 1024 * 1024,
      subscription_status: 'trialing',
      trial_ends_at: '2026-09-15',
      current_period_end: '2026-10-01',
    })
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).includes('/subscription') && Boolean((init as RequestInit | undefined)?.method),
    )).toBe(false)
  })

  it('renders exactly 20 permission controls and protects role creation from double submission', async () => {
    let resolveCreateRole: ((response: Response) => void) | undefined
    const pendingCreateRole = new Promise<Response>(resolve => { resolveCreateRole = resolve })
    const fetchMock = installFetch({ createRole: () => pendingCreateRole })
    await renderAdminPage()
    fireEvent.click(screen.getByRole('button', { name: /^Roles\b/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo Rol' }))

    const dialog = await screen.findByRole('dialog', { name: 'Crear rol' })
    const permissionControls = within(dialog).getAllByRole('button').filter(control => control.hasAttribute('aria-pressed'))
    expect(permissionControls).toHaveLength(20)
    expect(permissionControls.every(control => control.getAttribute('aria-pressed') === 'false')).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('Nombre del rol'), { target: { value: 'Supervisor local' } })
    fireEvent.click(permissionControls[0])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear rol' }))

    const pendingButton = within(dialog).getByRole('button', { name: 'Guardando…' })
    expect(pendingButton).toBeDisabled()
    fireEvent.click(pendingButton)
    expect(matchingCalls(fetchMock, '/api/admin/roles', 'POST')).toHaveLength(1)

    await act(async () => {
      resolveCreateRole?.(jsonResponse({ success: true }))
      await pendingCreateRole
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Crear rol' })).not.toBeInTheDocument())
  })

  it('exposes named controls for multiple account assignments and keeps one principal account', async () => {
    installFetch()
    await renderAdminPage()
    const dialog = await openCreateUserDialog()

    expect(within(dialog).getByRole('combobox', { name: 'Cuenta 1' })).toHaveValue('account-los-olivos')
    expect(within(dialog).getByRole('combobox', { name: 'Nivel de acceso 1' })).toHaveValue('agent')
    expect(within(dialog).getByRole('combobox', { name: 'Rol de permisos 1' })).toBeEnabled()
    expect(within(dialog).getByRole('button', { name: 'Principal' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(dialog).getByRole('button', { name: 'Quitar cuenta 1' })).toBeDisabled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar cuenta' }))
    expect(within(dialog).getByRole('combobox', { name: 'Cuenta 2' })).toHaveValue('account-centro')
    expect(within(dialog).getByRole('combobox', { name: 'Nivel de acceso 2' })).toBeEnabled()
    expect(within(dialog).getByRole('combobox', { name: 'Rol de permisos 2' })).toBeEnabled()
    expect(within(dialog).getByRole('button', { name: 'Quitar cuenta 2' })).toBeEnabled()

    const principals = within(dialog).getAllByRole('button', { name: 'Principal' })
    expect(principals[0]).toHaveAttribute('aria-pressed', 'true')
    expect(principals[1]).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(principals[1])
    expect(principals[0]).toHaveAttribute('aria-pressed', 'false')
    expect(principals[1]).toHaveAttribute('aria-pressed', 'true')

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Rol de permisos 2' }), { target: { value: 'role-support' } })
    expect(within(dialog).getByRole('combobox', { name: 'Rol de permisos 2' })).toHaveValue('role-support')
  })
})
