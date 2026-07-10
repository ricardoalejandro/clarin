const http = require('http')
const { URL } = require('url')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { chromium } = require('playwright')

const PORT = Number(process.env.PORT || 8791)
const PROFILE_ROOT = process.env.PROFILE_ROOT || '/data/profiles'
const DISPLAY_BASE = Number(process.env.DISPLAY_BASE || 90)
const VNC_PORT_BASE = Number(process.env.VNC_PORT_BASE || 5900)
const VIEWPORT = {
  width: Number(process.env.BROWSER_VIEWPORT_WIDTH || 1365),
  height: Number(process.env.BROWSER_VIEWPORT_HEIGHT || 768),
}

fs.mkdirSync(PROFILE_ROOT, { recursive: true })

const sessions = new Map()
let nextSlot = 0

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, message) {
  sendJSON(res, status, { success: false, error: message })
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function safeAccountID(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
}

function normalizeHost(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\.$/, '')
}

function hostAllowed(host, allowedDomains) {
  host = normalizeHost(host)
  if (!host) return false
  if (isBlockedHost(host)) return false
  return allowedDomains.some(domain => {
    const allowed = normalizeHost(domain)
    return host === allowed || host.endsWith(`.${allowed}`)
  })
}

function expandedSupportDomains(allowedDomains) {
  const domains = new Set()
  const normalized = allowedDomains.map(normalizeHost).filter(Boolean)
  const hasKommo = normalized.some(domain => domain === 'kommo.com' || domain.endsWith('.kommo.com'))
  if (hasKommo) {
    domains.add('kommo.com')
    // Kommo login/security screens load these as embedded dependencies.
    // They are not accepted as top-level destinations unless Admin approves them.
    domains.add('google.com')
    domains.add('gstatic.com')
    domains.add('recaptcha.net')
  }
  return [...domains]
}

function requestAllowed(request, session) {
  let host
  try {
    host = new URL(request.url()).hostname
  } catch {
    return false
  }
  if (hostAllowed(host, session.allowedDomains)) return true

  const mainFrameNavigation = request.isNavigationRequest() && request.frame() === session.page.mainFrame()
  if (mainFrameNavigation) return false

  return hostAllowed(host, expandedSupportDomains(session.allowedDomains))
}

function isBlockedHost(host) {
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === 'metadata.google.internal' || host.includes('metadata')) return true
  if (host.includes('_')) return true
  if (!host.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true
  const parts = host.split('.').map(v => Number(v))
  if (parts.length === 4 && parts.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
    const [a, b] = parts
    return a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
  }
  return false
}

function isURLAllowed(rawURL, allowedDomains) {
  let parsed
  try {
    parsed = new URL(rawURL)
  } catch {
    return false
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false
  return hostAllowed(parsed.hostname, allowedDomains)
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    ...options,
    env: { ...process.env, ...(options.env || {}) },
  })
  child.stderr.on('data', chunk => {
    const text = String(chunk || '').trim()
    if (text) console.error(`[${command}] ${text}`)
  })
  child.on('error', err => {
    console.error(`[${command}] ${err.message}`)
  })
  return child
}

function killChild(child) {
  if (!child || child.killed) return
  try {
    child.kill('SIGTERM')
  } catch {
    // ignore kill errors
  }
}

async function cleanupProfileProcesses(profileDir) {
  const pids = []
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    if (pid <= 1 || pid === process.pid) continue
    try {
      const cmdline = fs.readFileSync(`/proc/${entry.name}/cmdline`, 'utf8').replace(/\0/g, ' ')
      if (cmdline.includes(`--user-data-dir=${profileDir}`)) pids.push(pid)
    } catch {
      // Process exited while scanning.
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // ignore kill errors
    }
  }
  await delay(250)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ignore kill errors
    }
  }
  for (const filename of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(profileDir, filename))
    } catch {
      // ignore stale lock cleanup errors
    }
  }
}

function allocateSlot() {
  const slot = nextSlot
  nextSlot += 1
  return {
    slot,
    display: `:${DISPLAY_BASE + slot}`,
    vncPort: VNC_PORT_BASE + slot,
  }
}

async function startDisplaySession(accountID, allowedDomains = []) {
  const key = safeAccountID(accountID)
  if (!key) throw new Error('invalid account id')

  let session = sessions.get(key)
  if (session && session.context && session.page && !session.page.isClosed()) {
    if (allowedDomains.length) session.allowedDomains = allowedDomains
    return session
  }

  const allocated = session?.allocated || allocateSlot()
  const env = { DISPLAY: allocated.display }
  const profileDir = path.join(PROFILE_ROOT, key)
  fs.mkdirSync(profileDir, { recursive: true })
  await cleanupProfileProcesses(profileDir)

  const children = []
  let context
  try {
    const xvfb = spawnManaged('Xvfb', [
      allocated.display,
      '-screen',
      '0',
      `${VIEWPORT.width}x${VIEWPORT.height}x24`,
      '-nolisten',
      'tcp',
      '-ac',
    ])
    children.push(xvfb)
    await delay(450)

    const windowManager = spawnManaged('openbox', [], { env })
    children.push(windowManager)
    await delay(250)

    const vnc = spawnManaged('x11vnc', [
      '-display',
      allocated.display,
      '-rfbport',
      String(allocated.vncPort),
      '-forever',
      '-shared',
      '-nopw',
      '-noxdamage',
      '-repeat',
      '-quiet',
    ], { env })
    children.push(vnc)
    await delay(350)

    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: VIEWPORT,
      acceptDownloads: false,
      bypassCSP: false,
      env: { ...process.env, ...env },
      args: [
        '--app=about:blank',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-file-system',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        '--window-position=0,0',
      ],
    })

    session = {
      accountID: key,
      allocated,
      context,
      page: context.pages()[0] || await context.newPage(),
      allowedDomains,
      children,
      createdAt: new Date().toISOString(),
      currentURL: '',
    }
    await attachGuards(session)
    sessions.set(key, session)
    return session
  } catch (err) {
    if (context) {
      try {
        await context.close()
      } catch {
        // ignore close errors
      }
    }
    for (const child of children) killChild(child)
    await cleanupProfileProcesses(profileDir)
    throw err
  }
}

async function attachGuards(session) {
  await session.context.route('**/*', route => {
    if (requestAllowed(route.request(), session)) return route.continue()
    return route.abort('blockedbyclient')
  })
  session.page.on('framenavigated', frame => {
    if (frame === session.page.mainFrame()) session.currentURL = frame.url()
  })
  session.page.on('download', download => {
    download.cancel().catch(() => {})
  })
}

async function closeSession(accountID) {
  const key = safeAccountID(accountID)
  const session = sessions.get(key)
  if (!session) return
  sessions.delete(key)
  try {
    await session.context.close()
  } catch {
    // ignore close errors
  }
  for (const child of session.children || []) killChild(child)
  await cleanupProfileProcesses(path.join(PROFILE_ROOT, key))
}

function sessionPath(pathname) {
  const match = pathname.match(/^\/sessions\/([^/]+)\/([^/]+)$/)
  if (!match) return null
  return { accountID: match[1], action: match[2] }
}

async function handle(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  if (req.method === 'GET' && parsed.pathname === '/health') {
    sendJSON(res, 200, { success: true, service: 'clarin-shared-browser-gateway', sessions: sessions.size })
    return
  }

  const route = sessionPath(parsed.pathname)
  if (!route) {
    sendError(res, 404, 'not found')
    return
  }

  try {
    if (req.method === 'POST' && route.action === 'open') {
      const body = await readJSON(req)
      const allowedDomains = Array.isArray(body.allowed_domains) ? body.allowed_domains.map(normalizeHost).filter(Boolean) : []
      const targetURL = String(body.url || '')
      if (!isURLAllowed(targetURL, allowedDomains)) {
        sendError(res, 403, 'domain not allowed')
        return
      }
      const session = await startDisplaySession(route.accountID, allowedDomains)
      await session.page.goto(targetURL, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await session.page.bringToFront()
      await session.page.setViewportSize(VIEWPORT)
      sendJSON(res, 200, {
        success: true,
        current_url: session.page.url(),
        vnc_port: session.allocated.vncPort,
      })
      return
    }

    if (req.method === 'GET' && route.action === 'vnc-info') {
      const session = sessions.get(safeAccountID(route.accountID))
      if (!session || !session.page || session.page.isClosed()) {
        sendError(res, 404, 'session not started')
        return
      }
      sendJSON(res, 200, {
        success: true,
        current_url: session.page.url(),
        vnc_port: session.allocated.vncPort,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
      })
      return
    }

    if (req.method === 'GET' && route.action === 'screenshot') {
      const session = sessions.get(safeAccountID(route.accountID))
      if (!session || !session.page || session.page.isClosed()) {
        sendError(res, 404, 'session not started')
        return
      }
      const image = await session.page.screenshot({ type: 'png', fullPage: false, timeout: 10000 })
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': image.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(image)
      return
    }

    if (req.method === 'POST' && route.action === 'reload') {
      const session = sessions.get(safeAccountID(route.accountID))
      if (!session) return sendError(res, 404, 'session not started')
      await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
      await session.page.bringToFront()
      sendJSON(res, 200, { success: true })
      return
    }

    if (req.method === 'POST' && route.action === 'restart') {
      await closeSession(route.accountID)
      sendJSON(res, 200, { success: true })
      return
    }

    sendError(res, 404, 'not found')
  } catch (err) {
    sendError(res, 500, err && err.message ? err.message : 'browser error')
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => sendError(res, 500, err.message || 'internal error'))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Clarin shared browser gateway listening on ${PORT}`)
})

async function shutdown() {
  for (const accountID of [...sessions.keys()]) {
    await closeSession(accountID)
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
