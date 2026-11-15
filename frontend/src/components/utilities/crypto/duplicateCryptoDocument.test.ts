import { afterEach, expect, it, vi } from 'vitest'
import { duplicateCryptoDocument } from './duplicateCryptoDocument'
import { libraryRequest, type UtilityDocument } from '../library/libraryApi'

vi.mock('../library/libraryApi', () => ({ libraryRequest: vi.fn(), operationId: () => 'copy-operation', jsonRequest: (method: string, value: unknown) => ({ method, body: JSON.stringify(value) }) }))
afterEach(() => vi.mocked(libraryRequest).mockReset())
const source: UtilityDocument = { id: 'source', type: 'criptografia', title: 'Original', config: { key_id: 'key-original', active: 'vault' }, version: 3, slots: [], folder_id: null, favorite: false, created_at: '', updated_at: '' }

it('duplicates all keys atomically through the document endpoint and accepts the remapped canonical reference', async () => {
  const copy = { ...source, id: 'copy', config: { ...source.config, key_id: 'key-copy' } }
  vi.mocked(libraryRequest).mockResolvedValue({ document: copy })
  expect(await duplicateCryptoDocument(source, false)).toEqual({ document: copy })
  expect(libraryRequest).toHaveBeenCalledTimes(1)
  expect(libraryRequest).toHaveBeenCalledWith('/documents/source/duplicate', expect.objectContaining({ method: 'POST', body: JSON.stringify({ base_version: 3, operation_id: 'copy-operation', title: 'Original · copia', config: source.config }) }))
})

it('preserves conflict draft preferences while using the latest canonical version for CAS', async () => {
  vi.mocked(libraryRequest).mockResolvedValueOnce({ document: { ...source, version: 8, config: {} } }).mockResolvedValueOnce({ document: { ...source, id: 'copy' } })
  await duplicateCryptoDocument(source, true)
  expect(libraryRequest).toHaveBeenNthCalledWith(1, '/documents/source')
  const input = JSON.parse(vi.mocked(libraryRequest).mock.calls[1][1]!.body as string)
  expect(input).toMatchObject({ base_version: 8, config: source.config })
  expect(source.version).toBe(3)
})

it('leaves the source draft intact when the snapshot changes again', async () => {
  vi.mocked(libraryRequest).mockResolvedValueOnce({ document: { ...source, version: 8 } }).mockRejectedValueOnce(new Error('Conflicto'))
  await expect(duplicateCryptoDocument(source, true)).rejects.toThrow('Conflicto')
  expect(source.config.key_id).toBe('key-original')
})
