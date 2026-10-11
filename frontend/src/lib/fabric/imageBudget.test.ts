import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { util } from './runtime'
import { DOCUMENT_IMAGE_PREFLIGHT_TIMEOUT_MS, preflightDocumentImages } from './imageBudget'
import { DocumentImageLoadError } from '../documents/resourceErrors'

vi.mock('./runtime', () => ({ util: { loadImage: vi.fn() } }))

const loadImage = vi.mocked(util.loadImage)
const fetchMock = vi.fn<typeof fetch>()
const image = (width = 100, height = 100) => ({ naturalWidth: width, naturalHeight: height } as HTMLImageElement)
const composition = (...sources: string[]) => ({ objects: sources.map(src => ({ type: 'image', src })) })
const media = (filename: string) => `/api/media/file/test-account/document-images/${filename}`
const flush = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  loadImage.mockReset().mockResolvedValue(image())
  fetchMock.mockReset().mockResolvedValue({ status: 404 } as Response)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('document image preflight', () => {
  it('loads each unique source once and performs no diagnostic request on success', async () => {
    const src = media('logo.png')
    await expect(preflightDocumentImages({ ...composition(src), background: { imageUrl: src }, group: composition(src) })).resolves.toBeUndefined()
    expect(loadImage).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(preflightDocumentImages({ objects: [] })).resolves.toBeUndefined()
    expect(loadImage).toHaveBeenCalledTimes(1)
  })

  it('reports both missing logos with safe readable names, deduplicating repeated sources', async () => {
    const first = media('20e56c6c-5ce7-4c3e-85fd-ede422f6d23e_Logo%20CATM%20(2).png?access=secret')
    const second = media('360d18a9-b9cf-4fa1-a7bb-8d75ac478bdf_NA_logo_Escuela%20de%20Filosof%C3%ADa.png?token=private')
    loadImage.mockImplementation(async src => { throw new Error(`Error loading ${src}`) })
    const error = await preflightDocumentImages({ ...composition(first, second), background: { imageUrl: first } }).catch(error => error)
    expect(error).toBeInstanceOf(DocumentImageLoadError)
    expect(error.issues).toEqual([
      { name: 'Logo CATM (2).png', reason: 'unavailable' },
      { name: 'NA_logo_Escuela de Filosofía.png', reason: 'unavailable' },
    ])
    expect(error.incomplete).toBe(false)
    expect(JSON.stringify(error)).not.toMatch(/access|token|secret|private|20e56c6c|\/api\//)
    expect(loadImage).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/media/file/'), expect.objectContaining({
      method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
    }))
  })

  it.each([[401, 'unauthorized'], [403, 'forbidden'], [404, 'unavailable'], [500, 'load-failed'], [200, 'load-failed']])('uses only verified HTTP %s evidence for %s', async (status, reason) => {
    loadImage.mockRejectedValue(new Error('Opaque image failure'))
    fetchMock.mockResolvedValue({ status } as Response)
    await expect(preflightDocumentImages(composition(media('logo.png')))).rejects.toMatchObject({ issues: [{ name: 'logo.png', reason }], incomplete: false })
  })

  it('never probes external, embedded or unrelated same-origin sources', async () => {
    loadImage.mockRejectedValue(new Error('Opaque failure'))
    const sources = ['https://remote.invalid/api/media/file/logo.png', 'data:image/png;base64,AA==', 'blob:https://example.invalid/opaque', '/images/logo.png', `http://user:secret@${location.host}/api/media/file/logo.png`]
    await expect(preflightDocumentImages(composition(...sources))).rejects.toMatchObject({ issues: sources.map(() => expect.objectContaining({ reason: 'load-failed' })) })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not infer permission or absence from a failed diagnostic transport', async () => {
    loadImage.mockRejectedValue(new Error('Image failure'))
    fetchMock.mockRejectedValue(new TypeError('Network error with a signed URL'))
    await expect(preflightDocumentImages(composition(media('logo.png')))).rejects.toMatchObject({ issues: [{ name: 'logo.png', reason: 'load-failed' }] })
  })

  it('decodes percent filenames only once while constructing the public error', async () => {
    loadImage.mockRejectedValue(new Error('failure'))
    await expect(preflightDocumentImages(composition(media('100%25%20listo.png')))).rejects.toMatchObject({ issues: [{ name: '100% listo.png', reason: 'unavailable' }] })
  })

  it('keeps at most four image reads running and releases a slot when one settles', async () => {
    const loads = Array.from({ length: 7 }, () => deferred<HTMLImageElement>())
    loadImage.mockImplementation(() => loads[loadImage.mock.calls.length - 1].promise)
    const pending = preflightDocumentImages(composition(...loads.map((_, index) => media(`logo-${index}.png`))))
    expect(loadImage).toHaveBeenCalledTimes(4)
    loads[0].resolve(image()); await flush()
    expect(loadImage).toHaveBeenCalledTimes(5)
    loads.forEach(load => load.resolve(image()))
    await pending
    expect(loadImage).toHaveBeenCalledTimes(7)
  })

  it('stops after eight confirmed failures and cancels remaining work without inventing a total', async () => {
    loadImage.mockRejectedValue(new Error('Image failure'))
    const error = await preflightDocumentImages(composition(...Array.from({ length: 20 }, (_, index) => media(`logo-${index}.png`)))).catch(error => error)
    expect(error).toBeInstanceOf(DocumentImageLoadError)
    expect(error.issues).toHaveLength(8)
    expect(error.incomplete).toBe(true)
    expect(error.message).not.toContain('20')
    expect(loadImage.mock.calls.length).toBeLessThan(20)
    expect(loadImage.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true)
  })

  it('never starts a closed session and preserves external AbortError even after a collected failure', async () => {
    const before = new AbortController(); before.abort()
    await expect(preflightDocumentImages(composition(media('logo.png')), before.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(loadImage).not.toHaveBeenCalled()
    const parent = new AbortController()
    loadImage.mockImplementation(src => src.endsWith('one.png') ? Promise.reject(new Error('failure')) : new Promise(() => {}))
    const pending = preflightDocumentImages(composition(media('one.png'), media('two.png')), parent.signal)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await flush(); expect(fetchMock).toHaveBeenCalledTimes(1)
    parent.abort(); await rejection
    expect(loadImage.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true)
  })

  it('aborts a pending diagnostic on external cancellation without late work or leaked timers', async () => {
    vi.useFakeTimers()
    const parent = new AbortController(), response = deferred<Response>()
    loadImage.mockRejectedValue(new Error('failure')); fetchMock.mockReturnValue(response.promise)
    const pending = preflightDocumentImages(composition(media('logo.png')), parent.signal)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await flush(); parent.abort(); await rejection
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    response.resolve({ status: 404 } as Response); await flush()
    expect(vi.getTimerCount()).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a 30 second deadline as safe timeout diagnostics even for an uncooperative loader', async () => {
    vi.useFakeTimers()
    const late = deferred<HTMLImageElement>()
    loadImage.mockReturnValue(late.promise)
    const pending = preflightDocumentImages(composition(media('one.png'), media('two.png')))
    const rejection = expect(pending).rejects.toMatchObject({ name: 'DocumentImageLoadError', incomplete: true, issues: [
      { name: 'one.png', reason: 'timeout' }, { name: 'two.png', reason: 'timeout' },
    ] })
    await vi.advanceTimersByTimeAsync(DOCUMENT_IMAGE_PREFLIGHT_TIMEOUT_MS - 1)
    expect(loadImage.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await rejection
    late.resolve(image()); await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a failed-image HEAD probe to three seconds', async () => {
    vi.useFakeTimers()
    loadImage.mockRejectedValue(new Error('failure')); fetchMock.mockReturnValue(new Promise(() => {}))
    const pending = preflightDocumentImages(composition(media('logo.png')))
    const rejection = expect(pending).rejects.toMatchObject({ issues: [{ name: 'logo.png', reason: 'timeout' }] })
    await vi.advanceTimersByTimeAsync(3_000); await rejection
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { width: 8_000, height: 5_001, copies: 1, message: '40 megapíxeles' },
    { width: 8_000, height: 4_001, copies: 2, message: '64 megapíxeles' },
  ])('preserves the source and composition pixel budgets: $message', async ({ width, height, copies, message }) => {
    loadImage.mockResolvedValue(image(width, height))
    await expect(preflightDocumentImages(composition(...Array.from({ length: copies }, () => media('logo.png'))))).rejects.toThrow(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts the remaining image loaders immediately on excessive memory or invalid dimensions', async () => {
    loadImage.mockImplementation(src => src.endsWith('big.png') ? Promise.resolve(image(9_000, 5_000)) : new Promise(() => {}))
    await expect(preflightDocumentImages(composition(media('big.png'), media('slow.png')))).rejects.toThrow('40 megapíxeles')
    expect(loadImage.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true)
    loadImage.mockResolvedValue(image(0, 100))
    await expect(preflightDocumentImages(composition(media('empty.png')))).rejects.toThrow('no válido')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects invalid resize filters before fetching and counts valid resize memory', async () => {
    await expect(preflightDocumentImages({ objects: [{ src: media('logo.png'), filters: [{ type: 'Resize', scaleX: NaN, scaleY: 2 }] }] })).rejects.toThrow('no válido')
    expect(loadImage).not.toHaveBeenCalled()
    loadImage.mockResolvedValue(image(4_000, 4_000))
    await expect(preflightDocumentImages({ objects: [{ src: media('logo.png'), filters: [{ type: 'Resize', scaleX: 2, scaleY: 2 }] }] })).rejects.toThrow('40 megapíxeles')
  })

  it('allows a fresh successful retry after failure without retaining old diagnostics or timers', async () => {
    vi.useFakeTimers()
    const document = composition(media('logo.png'))
    loadImage.mockRejectedValueOnce(new Error('failure'))
    await expect(preflightDocumentImages(document)).rejects.toBeInstanceOf(DocumentImageLoadError)
    await expect(preflightDocumentImages(document)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
