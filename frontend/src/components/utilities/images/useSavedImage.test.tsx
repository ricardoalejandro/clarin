import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useSavedImage } from './useSavedImage'

const fixture = vi.hoisted(() => ({ document: null as unknown }))
vi.mock('../library/UtilityDocumentContext', () => ({ useUtilityDocument: () => fixture.document }))

it.each(['select', 'clear'])('never lets a delayed saved image override a newer %s action', async action => {
  let complete!: (blob: Blob) => void
  fixture.document = { documentId: 'document-a', initialState: {}, readSlot: () => new Promise(resolve => { complete = resolve }), setSlot: vi.fn(), setState: vi.fn() }
  const source = { state: { status: 'idle' as const }, clear: vi.fn(), run: vi.fn(async () => {}) }
  const hook = renderHook(() => useSavedImage('source', source))
  act(() => { if (action === 'select') hook.result.current.select(new File(['new'], 'new.png', { type: 'image/png' })); else hook.result.current.clear() })
  await act(async () => { complete(new Blob(['old'], { type: 'image/png' })); await Promise.resolve() })
  expect(source.run).toHaveBeenCalledTimes(action === 'select' ? 1 : 0)
  expect(source.clear).toHaveBeenCalledTimes(action === 'clear' ? 1 : 0)
})
