import { describe, expect, it, vi } from 'vitest'
import { buildNavigationHistoryScript, installClarinNavigationHistory } from './navigationHistory'

// Explicit asynchronous traversal queue: no jsdom history timing assumptions.
function browser() {
  const target = new EventTarget()
  const location = { href: 'https://clarin.test/list?filter=all#start' }
  const entries = [{ url: location.href, state: { __NA: true, tree: ['initial'] } as Record<string, unknown> }]
  const traversals: number[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  let cursor = 0
  const history = {
    get state() { return entries[cursor].state },
    get length() { return entries.length },
    pushState(state: Record<string, unknown>, _unused: string, url?: string | URL | null) {
      entries.splice(cursor + 1)
      entries.push({ state, url: new URL(url || location.href, location.href).href })
      cursor += 1
      location.href = entries[cursor].url
    },
    replaceState(state: Record<string, unknown>, _unused: string, url?: string | URL | null) {
      entries[cursor] = { state, url: new URL(url || location.href, location.href).href }
      location.href = entries[cursor].url
    },
    go(delta: number) { traversals.push(cursor + delta) },
  }
  const win = { history, location, crypto: { randomUUID: () => 'document-one' }, setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer }, clearTimeout: (id: number) => timers.delete(id), addEventListener: target.addEventListener.bind(target) } as unknown as Window
  const step = () => {
    const next = traversals.shift()
    if (next === undefined || next < 0 || next >= entries.length || next === cursor) return
    cursor = next
    location.href = entries[cursor].url
    target.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
  }
  const tick = () => { const queued = [...timers.values()]; timers.clear(); queued.forEach(callback => callback()) }
  const settle = async () => { for (let i = 0; i < 32; i += 1) { step(); if (!traversals.length) tick(); await Promise.resolve() } }
  return { win, history, location, entries, traversals, step, tick, settle, target }
}
function deferred() {
  let resolve!: (allowed: boolean) => void
  const promise = new Promise<boolean>(done => { resolve = done })
  return { promise, resolve }
}

describe('document history leave controller', () => {
  it('bootstraps without imports and preserves Next state, replacement and history length', () => {
    const b = browser()
    new Function('window', buildNavigationHistoryScript())(b.win)
    const controller = b.win.__CLARIN_NAVIGATION_HISTORY__
    expect(controller).toBeDefined()
    expect(installClarinNavigationHistory(b.win)).toBe(controller)
    expect(b.history.state).toMatchObject({ __NA: true, tree: ['initial'] })
    expect(b.history.length).toBe(1)
    b.history.pushState({ __NA: true, tree: ['board'], custom: 'kept' }, '', '/board?work_view=a#exact')
    b.history.replaceState({ __NA: true, tree: ['updated'] }, '', '/board?work_view=b#exact')
    expect(b.history.state).toMatchObject({ __NA: true, tree: ['updated'], __clarin_history_position: { index: 1 } })
    expect(b.history.length).toBe(2)
  })

  it('cancels Back at the exact URL and preserves Forward and Next state without sentinel entries', async () => {
    const b = browser()
    const controller = installClarinNavigationHistory(b.win)
    b.history.pushState({ __NA: true, tree: ['board'] }, '', '/board?work_view=a#exact')
    const leave = vi.fn().mockResolvedValue(false)
    const unregister = controller.register({ requestLeave: leave, revision: () => 'dirty' })
    const next = vi.fn()
    b.target.addEventListener('popstate', next)
    b.history.go(-1); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/board?work_view=a#exact')
    expect(next).not.toHaveBeenCalled()
    expect(leave).toHaveBeenCalledTimes(1)
    expect(b.history.state).toMatchObject({ tree: ['board'] })
    unregister()
    b.history.go(-1); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/list?filter=all#start')
    b.history.go(1); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/board?work_view=a#exact')
    expect(b.history.length).toBe(2)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('serializes repeated Back while saving and replays the first destination exactly once', async () => {
    const b = browser()
    const controller = installClarinNavigationHistory(b.win)
    b.history.pushState({}, '', '/middle')
    b.history.pushState({}, '', '/board')
    const pending = deferred()
    const leave = vi.fn(() => pending.promise)
    controller.register({ requestLeave: leave, revision: () => '1' })
    const next = vi.fn()
    b.target.addEventListener('popstate', next)
    b.history.go(-1); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/board')
    b.history.go(-2); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/board')
    expect(leave).toHaveBeenCalledTimes(1)
    pending.resolve(true); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/middle')
    expect(next).toHaveBeenCalledTimes(1)
    expect(b.history.length).toBe(3)
  })

  it('guards Forward and repeats validation when a gesture occurs between permission and traversal', async () => {
    const b = browser()
    const controller = installClarinNavigationHistory(b.win)
    b.history.pushState({}, '', '/board')
    b.history.pushState({}, '', '/future?exact=1#hash')
    b.history.go(-1); await b.settle()
    let revision = '1'
    const leave = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    controller.register({ requestLeave: leave, revision: () => revision })
    const next = vi.fn()
    b.target.addEventListener('popstate', next)
    b.history.go(1); b.step(); b.tick(); b.step()
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    expect(b.traversals).toHaveLength(1)
    revision = '2'
    await b.settle()
    expect(leave).toHaveBeenCalledTimes(2)
    expect(next).not.toHaveBeenCalled()
    expect(b.location.href).toBe('https://clarin.test/board')
  })

  it('leaves focus and hash-only layers to their existing popstate owners', async () => {
    const b = browser()
    const controller = installClarinNavigationHistory(b.win)
    b.history.pushState({}, '', '/board')
    const leave = vi.fn().mockResolvedValue(false)
    controller.register({ requestLeave: leave, revision: () => '1' })
    b.history.pushState({ clarinFocus: true }, '', '/board#focus')
    const next = vi.fn()
    b.target.addEventListener('popstate', next)
    b.history.go(-1); await b.settle()
    expect(leave).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending traversal on disposal and ignores its late promise', async () => {
    const b = browser()
    const controller = installClarinNavigationHistory(b.win)
    b.history.pushState({}, '', '/board')
    const pending = deferred()
    const unregister = controller.register({ requestLeave: () => pending.promise, revision: () => '1' })
    b.history.go(-1); await b.settle()
    unregister(); pending.resolve(true); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/board')
    b.history.go(-1); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/list?filter=all#start')
  })

  it('revalidates a changed revision during the guard promise, including comment draft changes', async () => {
    const b = browser()
    const controller = installClarinNavigationHistory(b.win)
    b.history.pushState({}, '', '/board')
    const pending = deferred()
    let revision = 'scene1:library0:comment1'
    const leave = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(false)
    controller.register({ requestLeave: leave, revision: () => revision })
    b.history.go(-1); await b.settle()
    revision = 'scene1:library0:comment2'
    pending.resolve(true); await b.settle()
    expect(leave).toHaveBeenCalledTimes(2)
    expect(b.location.href).toBe('https://clarin.test/board')
  })

  it('does not trap a newly pushed route when the owner unmounts before rewind', async () => {
    const b = browser()
    const controller = installClarinNavigationHistory(b.win)
    b.history.pushState({}, '', '/board')
    const leave = vi.fn().mockResolvedValue(false)
    const unregister = controller.register({ requestLeave: leave, revision: () => '1' })
    b.history.go(-1); b.step()
    b.history.pushState({ tree: ['new'] }, '', '/new-route?exact=1#new')
    unregister(); await b.settle()
    expect(b.history.state).toMatchObject({ __clarin_history_position: { index: 1 } })
    expect(b.history.length).toBe(2)
    expect(b.location.href).toBe('https://clarin.test/new-route?exact=1#new')
    expect(leave).not.toHaveBeenCalled()
    b.history.go(-1); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/list?filter=all#start')
  })

  it('absorbs an already queued replay after an authorized replacement closes the editor', async () => {
    const b = browser()
    const controller = installClarinNavigationHistory(b.win)
    b.history.pushState({}, '', '/board')
    const unregister = controller.register({ requestLeave: async () => true, revision: () => '1' })
    b.history.go(-1); b.step(); b.tick(); b.step()
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    expect(b.traversals).toHaveLength(1)
    b.history.replaceState({ tree: ['new'] }, '', '/replacement?exact=1#new')
    unregister(); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/replacement?exact=1#new')
    expect(b.history.length).toBe(2)
    b.history.go(-1); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/list?filter=all#start')
  })

  it('reuses the existing document ledger after reload and bypasses clean editors', async () => {
    const b = browser()
    b.entries[0].state.__clarin_history_position = { documentID: 'previous-document', index: 7 }
    const controller = installClarinNavigationHistory(b.win)
    expect(b.history.state).toMatchObject({ __clarin_history_position: { documentID: 'previous-document', index: 7 } })
    b.history.pushState({}, '', '/board')
    expect(b.history.state).toMatchObject({ __clarin_history_position: { documentID: 'previous-document', index: 8 } })
    const leave = vi.fn()
    controller.register({ requestLeave: leave, revision: () => '0', shouldBlock: () => false })
    b.history.go(-1); await b.settle()
    expect(leave).not.toHaveBeenCalled()
    expect(b.location.href).toBe('https://clarin.test/list?filter=all#start')
  })

  it('releases a rewind made obsolete by a push onto its exact destination', async () => {
    const b = browser()
    const controller = installClarinNavigationHistory(b.win)
    b.history.pushState({}, '', '/board')
    const unregister = controller.register({ requestLeave: async () => false, revision: () => '1' })
    b.history.go(-1); b.step(); b.tick()
    expect(b.traversals).toHaveLength(1)
    b.history.pushState({}, '', '/forced-destination')
    unregister(); await b.settle()
    b.history.go(-1); await b.settle()
    expect(b.location.href).toBe('https://clarin.test/list?filter=all#start')
    expect(b.traversals).toHaveLength(0)
  })

  it('uses coherent native positions when restoring an entry without a stamp', async () => {
    const b = browser()
    const nativeEntries = () => b.entries.map((entry, index) => ({ index, key: `entry-${index}`, url: entry.url }))
    Object.defineProperty(b.win, 'navigation', { value: {
      get currentEntry() { return nativeEntries().find(entry => entry.url === b.location.href) },
      entries: nativeEntries,
    } })
    const controller = installClarinNavigationHistory(b.win)
    b.history.pushState({}, '', '/board')
    delete b.entries[0].state.__clarin_history_position
    const leave = vi.fn().mockResolvedValue(false)
    controller.register({ requestLeave: leave, revision: () => '1' })
    b.history.go(-1); await b.settle()
    expect(leave).toHaveBeenCalledTimes(1)
    expect(b.location.href).toBe('https://clarin.test/board')
  })
})
