#!/usr/bin/env node

import { createInterface } from 'node:readline'

let connected = false
let loginSequence = 0
let pendingLogin = null

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function completeLogin(loginId) {
  if (!pendingLogin || pendingLogin.id !== loginId) return
  connected = true
  pendingLogin = null
  send({ method: 'account/login/completed', params: { loginId, success: true, error: null } })
  send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } })
}

const rl = createInterface({ input: process.stdin })

rl.on('line', line => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return

  switch (message.method) {
    case 'initialize':
    case 'config/batchWrite':
      send({ id: message.id, result: {} })
      break
    case 'account/read':
      send({
        id: message.id,
        result: {
          account: connected ? { type: 'chatgpt', email: 'owner@example.com', planType: 'plus' } : null,
          requiresOpenaiAuth: true
        }
      })
      break
    case 'account/login/start': {
      loginSequence += 1
      const loginId = `login-${loginSequence}`
      const timer = setTimeout(() => completeLogin(loginId), 180)
      pendingLogin = { id: loginId, timer }
      send({
        id: message.id,
        result: {
          type: 'chatgptDeviceCode',
          loginId,
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: `TEST-${loginSequence}`
        }
      })
      break
    }
    case 'account/login/cancel':
      if (pendingLogin?.id === message.params?.loginId) {
        clearTimeout(pendingLogin.timer)
        pendingLogin = null
      }
      send({ id: message.id, result: {} })
      break
    case 'account/logout':
      connected = false
      send({ id: message.id, result: {} })
      send({ method: 'account/updated', params: { authMode: null, planType: null } })
      break
    case 'mcpServerStatus/list':
      send({
        id: message.id,
        result: {
          data: [{ name: 'clarin', authStatus: 'bearer', tools: { test_tool: { name: 'test_tool' } } }]
        }
      })
      break
    default:
      send({ id: message.id, result: {} })
  }
})

rl.on('close', () => process.exit(0))
