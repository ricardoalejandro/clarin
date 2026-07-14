#!/usr/bin/env node

import { createInterface } from 'node:readline'

let connected = false
let loginSequence = 0
let pendingLogin = null
let threadSequence = 0
let turnSequence = 0
const threads = new Map()

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

function publicThread(thread) {
  return {
    id: thread.id,
    status: { type: 'idle' },
    turns: [...thread.turns.values()].map(turn => {
      const { timer: _timer, ...persisted } = turn
      return { ...persisted, items: [...turn.items] }
    })
  }
}

function publicThreadWithPersistenceLag(thread) {
  const snapshot = publicThread(thread)
  const lagging = [...thread.turns.values()].find(turn => turn.scenario === 'PERSISTENCE_LAG' && (turn.readCount || 0) < 2)
  if (!lagging) return snapshot
  lagging.readCount = (lagging.readCount || 0) + 1
  snapshot.turns = snapshot.turns.filter(turn => turn.id !== lagging.id)
  return snapshot
}

function completeTurn(threadId, turnId) {
  const thread = threads.get(threadId)
  const turn = thread?.turns.get(turnId)
  if (!turn || turn.status !== 'inProgress') return
  turn.status = 'completed'
  turn.completedAt = Math.floor(Date.now() / 1000)
  turn.durationMs = 80
  const agent = {
    id: `agent-${turnId}`,
    type: 'agentMessage',
    phase: 'final_answer',
    text: 'Respuesta durable de Eros'
  }
  if (turn.scenario === 'CLARIFICATION') {
    turn.items = [{ id:`tool-${turnId}`,type:'mcpToolCall',tool:'request_eros_clarification',server:'clarin',status:'completed',result:{content:[{type:'text',text:JSON.stringify({eros_clarification:true,question:'¿Cuál lista deseas usar?',context:'Hay dos listas posibles.',options:[{id:'shown',label:'La mostrada',description:'Usar exactamente los registros visibles.'},{id:'refresh',label:'Recalcular',description:'Ejecutar de nuevo los filtros.'}],allow_custom:true})}]}},agent]
  } else if (turn.scenario === 'ALL_TOOLS_FAIL') {
    turn.items = [{ id:`tool-${turnId}`,type:'mcpToolCall',tool:'query_leads_operational',server:'clarin',status:'failed',result:{content:[{type:'text',text:'error'}]}},agent]
  } else {
    turn.items = [agent]
  }
  for (const item of turn.items) send({ method: 'item/completed', params: { threadId, turnId, item } })
  send({ method: 'turn/completed', params: { threadId, turn: { ...turn, items: [...turn.items] } } })
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
    case 'thread/start': {
      const toolsDisabled = String(message.params?.baseInstructions || '').includes('Todas las herramientas, incluido MCP, están deshabilitadas')
      if (toolsDisabled && (message.params?.config?.mcp_servers?.clarin?.enabled !== false || message.params?.config?.web_search !== 'disabled' || !Array.isArray(message.params?.dynamicTools))) {
        send({ id: message.id, error: { message: 'tool isolation was not applied to the report thread' } })
        break
      }
      threadSequence += 1
      const thread = { id: `thread-${threadSequence}`, turns: new Map() }
      threads.set(thread.id, thread)
      send({ id: message.id, result: { thread: publicThread(thread) } })
      break
    }
    case 'thread/resume': {
      const thread = threads.get(message.params?.threadId)
      if (!thread) {
        send({ id: message.id, error: { message: 'thread not found' } })
        break
      }
      send({ id: message.id, result: { thread: publicThread(thread) } })
      break
    }
    case 'turn/start': {
      const thread = threads.get(message.params?.threadId)
      if (!thread) {
        send({ id: message.id, error: { message: 'thread not found' } })
        break
      }
      turnSequence += 1
      const turn = {
        id: `turn-${turnSequence}`,
        status: 'inProgress',
        startedAt: Math.floor(Date.now() / 1000),
        completedAt: null,
        durationMs: null,
        error: null,
        items: []
      }
      thread.turns.set(turn.id, turn)
      const input = JSON.stringify(message.params?.input || [])
      turn.scenario = input.includes('CLARIFICATION')
        ? 'CLARIFICATION'
        : input.includes('ALL_TOOLS_FAIL')
          ? 'ALL_TOOLS_FAIL'
          : input.includes('PERSISTENCE_LAG')
            ? 'PERSISTENCE_LAG'
            : ''
      if (!input.includes('KEEP_RUNNING')) {
        turn.timer = setTimeout(() => completeTurn(thread.id, turn.id), 80)
      }
      send({ id: message.id, result: { turn: { ...turn, timer: undefined } } })
      break
    }
    case 'thread/read': {
      const thread = threads.get(message.params?.threadId)
      if (!thread) {
        send({ id: message.id, error: { message: 'thread not found' } })
        break
      }
      send({ id: message.id, result: { thread: publicThreadWithPersistenceLag(thread) } })
      break
    }
    case 'turn/interrupt': {
      const thread = threads.get(message.params?.threadId)
      const turn = thread?.turns.get(message.params?.turnId)
      if (turn?.timer) clearTimeout(turn.timer)
      if (turn && turn.status === 'inProgress') {
        turn.status = 'interrupted'
        turn.completedAt = Math.floor(Date.now() / 1000)
        send({ method: 'turn/completed', params: { threadId: thread.id, turn: { ...turn, timer: undefined } } })
      }
      send({ id: message.id, result: {} })
      break
    }
    default:
      send({ id: message.id, result: {} })
  }
})

rl.on('close', () => process.exit(0))
