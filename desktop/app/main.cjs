'use strict'

const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { DEFAULT_SERVER, normalizeServerURL, offlinePageURL, isOfflinePage, isAllowedNavigation, isSafeAccountID, shouldStartOffline, nextUnavailableChecks, enrollmentErrorResponse } = require('./lib/policy.cjs')

const serverOrigin = normalizeServerURL(process.env.CLARIN_SERVER_URL || DEFAULT_SERVER)
const localPage = offlinePageURL()
let mainWindow
let agentBusy = false
let connectivityTimer
let unavailableChecks = 0
let lastAutomaticSync = 0
let bootstrapState = 'unregistered'

function agentPath() {
  if (process.env.CLARIN_OFFLINE_AGENT_PATH) return path.resolve(process.env.CLARIN_OFFLINE_AGENT_PATH)
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'clarin-offline-agent.exe')
    : path.join(__dirname, 'resources', 'bin', 'clarin-offline-agent.exe')
}

function assertLocalSender(event) {
  const source = event.senderFrame?.url || ''
  if (!isOfflinePage(source, localPage)) throw new Error('offline bridge is available only to the bundled Clarin page')
}

function assertOnlineSender(event) {
  const source = event.senderFrame?.url || ''
  let sourceOrigin = ''
  try { sourceOrigin = new URL(source).origin } catch {}
  if (sourceOrigin !== serverOrigin) throw new Error('desktop enrollment bridge is available only to Clarin')
}

function runAgent(command, args = [], input = '') {
  if (agentBusy) return Promise.reject(new Error('El agente ya está procesando otra operación'))
  agentBusy = true
  return new Promise((resolve, reject) => {
    const child = spawn(agentPath(), [command, ...args], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLARIN_DESKTOP_PARENT_PID: String(process.pid) }
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    const timer = setTimeout(() => child.kill(), 90_000)
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > 70 * 1024 * 1024) child.kill()
      else stdout.push(chunk)
    })
    child.stderr.on('data', chunk => {
      if (stderr.reduce((size, item) => size + item.length, 0) < 64 * 1024) stderr.push(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      agentBusy = false
      if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `El agente terminó con código ${code}`))
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')))
      } catch {
        reject(new Error('El agente devolvió una respuesta local inválida'))
      }
    })
    child.stdin.end(input)
  }).finally(() => { agentBusy = false })
}

async function loadOnline() {
  try {
    await mainWindow.loadURL(`${serverOrigin}/dashboard`)
  } catch {
    await loadOffline()
  }
}

async function loadOffline() {
	await mainWindow.loadURL(localPage)
}

async function loadInitialPage() {
	try {
		const status = await runAgent('bootstrap-status')
		bootstrapState = status?.state || 'blocked'
	} catch {
		bootstrapState = 'blocked'
	}
	if (shouldStartOffline(bootstrapState)) await loadOffline()
	else await loadOnline()
}

async function serverIsReachable() {
	if (!net.isOnline()) return false
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 5000)
	try {
		const response = await net.fetch(`${serverOrigin}/api/version`, { method: 'GET', redirect: 'manual', signal: controller.signal })
		return response.status < 500
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}

async function monitorConnectivity() {
	if (!mainWindow || mainWindow.isDestroyed() || agentBusy) return
	const reachable = await serverIsReachable()
	if (!reachable) {
		unavailableChecks = nextUnavailableChecks(unavailableChecks, false)
		if (unavailableChecks >= 2 && mainWindow.webContents.getURL().startsWith(serverOrigin)) await loadOffline()
		return
	}
	unavailableChecks = nextUnavailableChecks(unavailableChecks, true)
	if (Date.now() - lastAutomaticSync < 60_000) return
	lastAutomaticSync = Date.now()
	try {
		const status = await runAgent('bootstrap-status')
		bootstrapState = status?.state || 'blocked'
		if (bootstrapState !== 'enrolled') return
		await runAgent('sync')
		if (isOfflinePage(mainWindow.webContents.getURL(), localPage)) mainWindow.webContents.send('offline:auto-sync-completed')
	} catch {
		// Local leases remain authoritative. A transient network failure never
		// deletes data and the next monitor interval retries the synchronization.
	}
}

function installConnectivityMonitor() {
	connectivityTimer = setInterval(() => { void monitorConnectivity() }, 10_000)
}

function installOfflineProtocol() {
	const allowedFiles = new Set(['/offline.html', '/offline.js', '/styles.css'])
	protocol.handle('clarin-offline', request => {
		const url = new URL(request.url)
		if (url.hostname !== 'app' || !allowedFiles.has(url.pathname)) return new Response('Not found', { status: 404 })
		return net.fetch(pathToFileURL(path.join(__dirname, 'src', url.pathname.slice(1))).href)
	})
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
		allowRunningInsecureContent: false,
		devTools: !app.isPackaged
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (isAllowedNavigation(url, serverOrigin, localPage) && new URL(url).origin === serverOrigin) void mainWindow.loadURL(url)
		return { action: 'deny' }
	})
	mainWindow.webContents.on('will-attach-webview', event => event.preventDefault())
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, serverOrigin, localPage)) event.preventDefault()
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, _description, validatedURL, isMainFrame) => {
    if (isMainFrame && code !== -3 && validatedURL.startsWith(serverOrigin)) void loadOffline()
  })
	void loadInitialPage()
}

function installIPC() {
	ipcMain.handle('desktop:bootstrap-status', event => {
		assertOnlineSender(event)
		return runAgent('bootstrap-status')
	})
	ipcMain.handle('desktop:prepare-enrollment', async event => {
		assertOnlineSender(event)
		try {
			return await runAgent('prepare-enrollment', ['--server', serverOrigin])
		} catch (error) {
			return enrollmentErrorResponse(error)
		}
	})
	ipcMain.handle('desktop:complete-enrollment', async (event, approval) => {
		assertOnlineSender(event)
		if (!approval || typeof approval !== 'object' || !isSafeAccountID(approval.terminal_id)) throw new Error('Aprobación offline inválida')
		const result = await runAgent('complete-enrollment', ['--server', serverOrigin], JSON.stringify(approval))
		bootstrapState = 'enrolled'
		try {
			await runAgent('sync')
		} catch {
			// Activation is already durable. The connectivity monitor retries the
			// first data sync without making the user repeat enrollment.
		}
		return result
	})
  ipcMain.handle('offline:list-accounts', event => {
    assertLocalSender(event)
    return runAgent('local-accounts')
  })
  ipcMain.handle('offline:get-state', (event, accountID) => {
    assertLocalSender(event)
    if (!isSafeAccountID(accountID)) throw new Error('Cuenta local inválida')
    return runAgent('local-state', ['--account', accountID])
  })
  ipcMain.handle('offline:enqueue', (event, accountID, operation) => {
    assertLocalSender(event)
    if (!isSafeAccountID(accountID) || !operation || typeof operation !== 'object') throw new Error('Operación local inválida')
    return runAgent('enqueue', ['--account', accountID], JSON.stringify(operation))
  })
  ipcMain.handle('offline:sync', (event, accountID) => {
    assertLocalSender(event)
    if (!isSafeAccountID(accountID)) throw new Error('Cuenta local inválida')
	return runAgent('sync', ['--account', accountID]).then(() => {
		lastAutomaticSync = Date.now()
		return { success: true }
	})
  })
  ipcMain.handle('offline:open-online', event => {
    assertLocalSender(event)
    void loadOnline()
    return { success: true }
  })
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'Clarin',
    submenu: [
      { label: 'Volver al modo en línea', click: () => void loadOnline() },
      { label: 'Abrir datos offline', click: () => void loadOffline() },
      { type: 'separator' },
      { role: 'quit', label: 'Salir' }
    ]
  }]))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
	protocol.registerSchemesAsPrivileged([{ scheme: 'clarin-offline', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }])
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
	app.whenReady().then(() => {
    if (process.platform !== 'win32') {
      void dialog.showMessageBox({ type: 'error', title: 'Clarin', message: 'Clarin Offline requiere Windows 11 x64.' }).finally(() => app.quit())
		return
	}
		installOfflineProtocol()
		session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
		session.defaultSession.setPermissionCheckHandler(() => false)
    installIPC()
    installMenu()
    createWindow()
	installConnectivityMonitor()
  })
	app.on('window-all-closed', () => {
		if (connectivityTimer) clearInterval(connectivityTimer)
		app.quit()
	})
}
