import { describe, expect, it } from 'vitest'
import { LogbookSession } from './logbookSession'

describe('logbook request and mutation ownership', () => {
  it('aborts the old detail and preview when selection changes and rejects late responses', () => {
    const session = new LogbookSession()
    session.select('A')
    const detailA = session.begin('detail')
    const previewA = session.begin('preview')
    session.select('B')
    const detailB = session.begin('detail')
    expect(detailA.signal.aborted).toBe(true)
    expect(previewA.signal.aborted).toBe(true)
    expect(session.isCurrent('detail', detailA)).toBe(false)
    expect(session.isCurrent('preview', previewA)).toBe(false)
    expect(session.isCurrent('detail', detailB)).toBe(true)
  })

  it('does not let an old save reopen A or close an editor on B, even after returning to A', () => {
    const session = new LogbookSession()
    session.select('A')
    const savingA = session.selection()
    session.select('B')
    expect(session.isSelected(savingA)).toBe(false)
    session.select('A')
    expect(session.isSelected(savingA)).toBe(false)
  })

  it('replaces an older refresh of the same logbook without changing mutation ownership', () => {
    const session = new LogbookSession()
    session.select('A')
    const mutation = session.selection()
    const older = session.begin('detail')
    const latest = session.begin('detail')
    expect(session.isCurrent('detail', older)).toBe(false)
    expect(session.isCurrent('detail', latest)).toBe(true)
    expect(session.isSelected(mutation)).toBe(true)
  })

  it('keeps list reconciliation independent of selection but rejects superseded lists', () => {
    const session = new LogbookSession()
    const oldList = session.begin('list')
    const latestList = session.begin('list')
    session.select('B')
    expect(session.isCurrent('list', oldList)).toBe(false)
    expect(session.isCurrent('list', latestList)).toBe(true)
  })

  it('destroys requests and rejects all old mutations when the event closes or changes', () => {
    const session = new LogbookSession()
    session.select('A')
    const old = session.selection()
    const read = session.begin('detail')
    session.dispose()
    expect(read.signal.aborted).toBe(true)
    expect(session.isActive()).toBe(false)
    expect(session.isCurrent('detail', read)).toBe(false)
    expect(session.isSelected(old)).toBe(false)
    // React StrictMode can activate the same instance after effect cleanup;
    // prior transport and mutation generations still stay invalid.
    session.activate()
    expect(session.isSelected(old)).toBe(false)
  })
})
