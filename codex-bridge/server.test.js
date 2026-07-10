import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'

const root = path.dirname(fileURLToPath(import.meta.url))
const fakeCodex = path.join(root, 'test', 'fake-codex.mjs')
const bridgeToken = 'integration-test-token'

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise(resolve => server.close(resolve))
  return port
}

async function requestJSON(baseURL, pathname, options = {}) {
  const response = await fetch(`${baseURL}${pathname}`, options)
  const body = await response.json()
  return { response, body }
}

async function waitForBridge(baseURL, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/auth/status`, {
        headers: { Authorization: `Bearer ${bridgeToken}` }
      })
      if (response.status === 200) return
    } catch {
      // The bridge may still be binding its socket.
    }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error('bridge did not start in time')
}

async function waitForConnected(baseURL, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { body } = await requestJSON(baseURL, '/auth/status', {
      headers: { Authorization: `Bearer ${bridgeToken}` }
    })
    if (body.connection?.connected) return body.connection
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error('device login did not complete in time')
}

test('managed OpenAI device connection lifecycle', async t => {
  const port = await freePort()
  const codexHome = await mkdtemp(path.join(tmpdir(), 'clarin-codex-bridge-test-'))
  await chmod(fakeCodex, 0o755)
  let output = ''
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      CODEX_HOME: codexHome,
      CODEX_BIN: fakeCodex,
      EROS_CODEX_BRIDGE_TOKEN: bridgeToken,
      EROS_MCP_BASE_URL: 'http://clarin.test/mcp',
      EROS_MCP_ACCESS_TOKEN: 'test-mcp-token'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', chunk => { output += chunk.toString('utf8') })
  child.stderr.on('data', chunk => { output += chunk.toString('utf8') })
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await rm(codexHome, { recursive: true, force: true })
  })

  const baseURL = `http://127.0.0.1:${port}`
  await waitForBridge(baseURL)

  const unauthorized = await requestJSON(baseURL, '/auth/status')
  assert.equal(unauthorized.response.status, 401)

  const headers = {
    Authorization: `Bearer ${bridgeToken}`,
    'Content-Type': 'application/json'
  }
  const live = await requestJSON(baseURL, '/live', { headers })
  assert.equal(live.response.status, 200)
  assert.equal(live.body.ok, true)
  const initial = await requestJSON(baseURL, '/auth/status', { headers })
  assert.equal(initial.body.connection.connected, false)

  const [firstLogin, duplicateLogin] = await Promise.all([
    requestJSON(baseURL, '/auth/device/start', { method: 'POST', headers, body: '{}' }),
    requestJSON(baseURL, '/auth/device/start', { method: 'POST', headers, body: '{}' })
  ])
  assert.equal(firstLogin.response.status, 200, output)
  assert.equal(firstLogin.body.login.status, 'pending')
  assert.equal(firstLogin.body.login.verification_url, 'https://auth.openai.com/codex/device')
  assert.equal(firstLogin.body.login.user_code, 'TEST-1')
  assert.equal(duplicateLogin.body.login.login_id, firstLogin.body.login.login_id)

  const cancelled = await requestJSON(baseURL, '/auth/device/cancel', {
    method: 'POST',
    headers,
    body: JSON.stringify({ login_id: firstLogin.body.login.login_id })
  })
  assert.equal(cancelled.body.login.status, 'cancelled')

  const secondLogin = await requestJSON(baseURL, '/auth/device/start', { method: 'POST', headers, body: '{}' })
  assert.equal(secondLogin.body.login.status, 'pending')
  assert.equal(secondLogin.body.login.user_code, 'TEST-2')

  const connection = await waitForConnected(baseURL)
  assert.equal(connection.email, 'owner@example.com')
  assert.equal(connection.plan_type, 'plus')
  assert.equal(connection.login.status, 'completed')

  const health = await requestJSON(baseURL, '/health', { headers })
  assert.equal(health.response.status, 200, output)
  assert.equal(health.body.codex_authenticated, true)
  assert.equal(health.body.mcp_tools_count, 1)

  const logout = await requestJSON(baseURL, '/auth/logout', { method: 'POST', headers, body: '{}' })
  assert.equal(logout.response.status, 200)
  const finalStatus = await requestJSON(baseURL, '/auth/status', { headers })
  assert.equal(finalStatus.body.connection.connected, false)
})
