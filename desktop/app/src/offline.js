'use strict'

const state = { accounts: [], accountID: '', data: null, module: 'all', query: '' }
const moduleLabels = { whiteboards: 'Pizarras', tasks: 'Tareas', contacts: 'Contactos', programs: 'Programas' }

const accountList = document.getElementById('accountList')
const accountTitle = document.getElementById('accountTitle')
const leaseStatus = document.getElementById('leaseStatus')
const moduleTabs = document.getElementById('moduleTabs')
const content = document.getElementById('content')
const notice = document.getElementById('notice')
const searchInput = document.getElementById('searchInput')
const syncButton = document.getElementById('syncButton')

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function showNotice(message, error = false) {
  notice.textContent = message
  notice.className = error ? 'notice error' : 'notice'
  notice.hidden = !message
}

function formatDate(value) {
  if (!value) return 'Sin fecha'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Sin fecha' : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function hasAction(module, action) {
  try { return Boolean(state.data?.actions && JSON.parse(typeof state.data.actions === 'string' ? state.data.actions : JSON.stringify(state.data.actions))[module]?.[action]) } catch { return false }
}

function inventoryWithPayload() {
  if (!state.data) return []
  return state.data.inventory.map(item => ({ ...item, payload: state.data.snapshots[item.selection_id] })).filter(item => item.payload)
}

function renderAccounts() {
  accountList.replaceChildren()
  for (const account of state.accounts) {
    const button = node('button', `account-button${account.account_id === state.accountID ? ' active' : ''}${account.available ? '' : ' unavailable'}`)
    button.type = 'button'
    button.disabled = !account.available
    button.append(node('strong', '', account.name || account.account_id), node('span', '', account.available ? `${account.resources} recursos · ${account.pending} pendientes` : account.error || 'No disponible'))
    button.addEventListener('click', () => selectAccount(account.account_id))
    accountList.append(button)
  }
}

function renderTabs() {
  moduleTabs.replaceChildren()
  const available = new Set(inventoryWithPayload().map(item => item.module))
  for (const [value, label] of [['all', 'Todo'], ...Object.entries(moduleLabels)]) {
    if (value !== 'all' && !available.has(value)) continue
    const button = node('button', `tab${state.module === value ? ' active' : ''}`, label)
    button.type = 'button'
    button.addEventListener('click', () => { state.module = value; renderTabs(); renderContent() })
    moduleTabs.append(button)
  }
}

function searchable(item) {
  if (!state.query) return true
  return JSON.stringify(item.payload).toLocaleLowerCase('es').includes(state.query)
}

function renderContent() {
  content.replaceChildren()
  const items = inventoryWithPayload().filter(item => (state.module === 'all' || item.module === state.module) && searchable(item))
  if (!items.length) {
    content.append(node('div', 'empty', state.query ? 'No hay coincidencias en los datos locales.' : 'No hay recursos sincronizados para este módulo.'))
    return
  }
  for (const item of items) {
    if (item.module === 'tasks') content.append(renderTaskList(item))
    else if (item.module === 'contacts') content.append(renderContact(item))
    else if (item.module === 'programs') content.append(renderProgram(item))
    else if (item.module === 'whiteboards') content.append(renderWhiteboard(item))
  }
}

function cardHeader(title, subtitle, badge) {
  const header = node('div', 'card-header')
  const copy = node('div')
  copy.append(node('h2', '', title || 'Sin título'), node('p', 'muted', subtitle || ''))
  header.append(copy, node('span', 'badge', badge))
  return header
}

function pendingFor(selectionID) {
  return (state.data?.outbox || []).filter(operation => operation.selection_id === selectionID)
}

function renderTaskList(item) {
  const payload = item.payload || {}
  const list = payload.list || {}
  const card = node('article', 'card')
  card.append(cardHeader(list.name || 'Lista de tareas', list.description, `${(payload.tasks || []).length} tareas`))
  const tasks = [...(payload.tasks || [])]
  for (const operation of pendingFor(item.selection_id)) {
    if (operation.operation_type === 'task.create') tasks.push({ id: operation.resource_id, title: operation.patch.title, priority: operation.patch.priority || 'medium', version: 0, _pending: true })
    if (operation.operation_type === 'task.complete') {
      const task = tasks.find(value => value.id === operation.resource_id)
      if (task) task._pendingComplete = true
    }
  }
  const listElement = node('div', 'task-list')
  for (const task of tasks) {
    const done = task.status === 'completed' || task.status_detail?.category === 'done' || task._pendingComplete
    const row = node('div', `task${done ? ' done' : ''}`)
    const complete = node('button', 'task-check', done ? '✓' : '')
    complete.type = 'button'
    complete.disabled = done || task._pending || !hasAction('tasks', 'complete')
    complete.title = complete.disabled && !done ? 'Edición offline desactivada' : 'Completar tarea'
    complete.addEventListener('click', () => queueOperation(item, { module: 'tasks', resource_type: 'task', resource_id: task.id, operation_type: 'task.complete', base_version: task.version || 1, patch: {} }))
    const copy = node('div')
    copy.append(node('div', 'task-title', task.title || 'Sin título'), node('div', 'task-meta', `${task.priority || 'medium'}${task.due_at ? ` · ${formatDate(task.due_at)}` : ''}`))
    row.append(complete, copy, task._pending || task._pendingComplete ? node('span', 'badge pending', 'Pendiente') : node('span', 'badge', done ? 'Hecha' : 'Local'))
    listElement.append(row)
  }
  card.append(listElement)
  if (hasAction('tasks', 'create')) {
    const form = node('form', 'create-task')
    const input = node('input')
    input.name = 'title'; input.required = true; input.maxLength = 2000; input.placeholder = 'Nueva tarea offline'
    const button = node('button', 'button primary small', 'Agregar')
    button.type = 'submit'
    form.append(input, button)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      const title = input.value.trim()
      if (!title) return
      button.disabled = true
      await queueOperation(item, { module: 'tasks', resource_type: 'task', resource_id: crypto.randomUUID(), operation_type: 'task.create', base_version: 0, patch: { title, priority: 'medium' } })
    })
    card.append(form)
  }
  return card
}

function renderContact(item) {
	const envelope = item.payload || {}
	const value = envelope.contact || envelope
  const name = value.custom_name || [value.name, value.last_name].filter(Boolean).join(' ') || value.phone || 'Contacto'
  const card = node('article', 'card')
  card.append(cardHeader(name, value.company || value.ocupacion || '', 'Contacto local'))
  const details = node('dl', 'details')
  for (const [label, detail] of [['Teléfono', value.phone], ['Correo', value.email], ['Dirección', value.address], ['Notas', value.notes], ['Etiquetas', (value.tags || []).map(tag => tag.name).join(', ')]]) {
    details.append(node('dt', '', label), node('dd', '', detail || '—'))
  }
	card.append(details)
	if (Array.isArray(envelope.observations) && envelope.observations.length) card.append(node('p', 'muted', `${envelope.observations.length} observaciones recientes disponibles localmente`))
  return card
}

function renderProgram(item) {
  const value = item.payload || {}
  const card = node('article', 'card')
  card.append(cardHeader(value.name || 'Programa', value.description || '', value.status || 'Programa local'))
  const metrics = node('div', 'metric-row')
  metrics.append(node('span', '', `${(value.participants || []).length} participantes`), node('span', '', `${(value.sessions || []).length} sesiones`), node('span', '', `${(value.attendance || []).length} registros de asistencia`))
  card.append(metrics)
  return card
}

function renderWhiteboard(item) {
  const value = item.payload || {}
  const scene = value.scene_json || {}
  const card = node('article', 'card')
  card.append(cardHeader(value.name || 'Pizarra', value.description || '', 'Pizarra local'))
  const metrics = node('div', 'metric-row')
  metrics.append(node('span', '', `${Array.isArray(scene.elements) ? scene.elements.length : 0} elementos`), node('span', '', `Versión ${value.scene_sequence || value.version || item.head_version}`), node('span', '', `Actualizada ${formatDate(value.updated_at)}`))
  card.append(metrics)
  return card
}

async function queueOperation(item, partial) {
  try {
    showNotice('')
    const operation = { operation_id: crypto.randomUUID(), depends_on: [], selection_id: item.selection_id, ...partial, client_occurred_at: new Date().toISOString() }
    await window.clarinOffline.enqueue(state.accountID, operation)
    await selectAccount(state.accountID, true)
    showNotice('Cambio guardado localmente. Se enviará en la próxima sincronización.')
  } catch (error) {
    showNotice(error.message || 'No se pudo guardar el cambio local.', true)
  }
}

async function selectAccount(accountID, preserveModule = false) {
  state.accountID = accountID
  if (!preserveModule) state.module = 'all'
  renderAccounts()
  content.replaceChildren(node('div', 'empty', 'Descifrando datos locales…'))
  try {
    state.data = await window.clarinOffline.getState(accountID)
    const account = state.accounts.find(value => value.account_id === accountID)
    accountTitle.textContent = account?.name || accountID
    leaseStatus.textContent = `Autorización vigente hasta ${formatDate(state.data.expires_at)} · ${(state.data.outbox || []).length} cambios pendientes`
    renderTabs()
    renderContent()
  } catch (error) {
    state.data = null
    content.replaceChildren(node('div', 'empty error-title', error.message || 'La autorización offline no está disponible.'))
  }
}

function renderEnrollment(message) {
	syncButton.disabled = true
	accountTitle.textContent = 'Este equipo necesita conexión'
	leaseStatus.textContent = 'El alta se realiza dentro de tu sesión de Clarín.'
	moduleTabs.replaceChildren()
	content.replaceChildren()
	const card = node('section', 'card')
	card.append(cardHeader('Solicita el acceso desde Configuración', 'Vuelve al modo en línea, inicia sesión y abre Configuración → Offline. La aplicación identifica el equipo automáticamente.', 'Alta segura'))
	if (message) card.append(node('p', 'muted', message))
	const button = node('button', 'button primary', 'Volver a Clarín en línea')
	button.type = 'button'
	button.addEventListener('click', () => window.clarinOffline.openOnline())
	card.append(button)
	content.append(card)
}

async function initialize() {
  if (!window.clarinOffline) {
    showNotice('El puente local seguro no está disponible.', true)
    return
  }
  try {
    const result = await window.clarinOffline.listAccounts()
    state.accounts = result.accounts || []
	syncButton.disabled = false
    renderAccounts()
    const first = state.accounts.find(account => account.available)
    if (first) await selectAccount(first.account_id)
    else content.replaceChildren(node('div', 'empty', 'No existe una cuenta con autorización offline vigente. Conéctate para renovar la sesión.'))
  } catch (error) {
		renderEnrollment(error.message || 'Este equipo todavía no está vinculado.')
  }
}

searchInput.addEventListener('input', () => { state.query = searchInput.value.trim().toLocaleLowerCase('es'); renderContent() })
document.getElementById('onlineButton').addEventListener('click', () => window.clarinOffline.openOnline())
syncButton.addEventListener('click', async () => {
  if (!state.accountID) return
  syncButton.disabled = true
  showNotice('Sincronizando con Clarin…')
  try {
    await window.clarinOffline.sync(state.accountID)
    const result = await window.clarinOffline.listAccounts()
    state.accounts = result.accounts || []
    await selectAccount(state.accountID, true)
    showNotice('Sincronización completada.')
  } catch (error) {
    showNotice(`No hay conexión o la sincronización fue rechazada: ${error.message || 'error desconocido'}`, true)
  } finally {
    syncButton.disabled = false
  }
})

if (typeof window.clarinOffline?.onAutoSyncCompleted === 'function') {
	window.clarinOffline.onAutoSyncCompleted(async () => {
		try {
			const result = await window.clarinOffline.listAccounts()
			state.accounts = result.accounts || []
			renderAccounts()
			if (state.accountID && state.accounts.some(account => account.account_id === state.accountID && account.available)) {
				await selectAccount(state.accountID, true)
			}
			showNotice('Conexión restablecida. Los cambios locales se sincronizaron automáticamente.')
		} catch {
			// The signed local lease continues to govern access; the next automatic
			// synchronization will retry without discarding the user's current view.
		}
	})
}

void initialize()
