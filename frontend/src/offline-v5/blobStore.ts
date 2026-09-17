import { OFFLINE_V5_BLOB_CHUNK_BYTES, OfflineV5Error } from './types'

const SAFE_NAME = /^[A-Za-z0-9_-]{8,128}$/

export interface OfflineV5OpaqueBlobStore {
  supported(): boolean
  write(directory: string, chunk: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>
  read(directory: string, chunk: string): Promise<Uint8Array<ArrayBuffer>>
  remove(directory: string): Promise<void>
}

function checkedName(value: string): string {
  if (!SAFE_NAME.test(value)) throw new OfflineV5Error('invalid_blob_path', 'La ruta local del archivo no es válida.')
  return value
}

export class BrowserOPFSBlobStore implements OfflineV5OpaqueBlobStore {
  supported() { return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function' }

  private async root(create: boolean) {
    if (!this.supported()) throw new OfflineV5Error('opfs_unavailable', 'Este navegador no dispone del almacén seguro de archivos offline.')
    const storage = await navigator.storage.getDirectory()
    return storage.getDirectoryHandle('clarin-offline-v5', { create })
  }

  async write(directory: string, chunk: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const root = await this.root(true)
    const folder = await root.getDirectoryHandle(checkedName(directory), { create: true })
    const file = await folder.getFileHandle(checkedName(chunk), { create: true })
    const writer = await file.createWritable({ keepExistingData: false })
    try { await writer.write(bytes); await writer.close() }
    catch (error) { await writer.abort().catch(() => {}); throw error }
  }

  async read(directory: string, chunk: string): Promise<Uint8Array<ArrayBuffer>> {
    try {
      const root = await this.root(false)
      const folder = await root.getDirectoryHandle(checkedName(directory))
      const file = await (await folder.getFileHandle(checkedName(chunk))).getFile()
      if (file.size > OFFLINE_V5_BLOB_CHUNK_BYTES + 16) throw new OfflineV5Error('blob_chunk_too_large', 'Un fragmento local supera el límite permitido.')
      return new Uint8Array(await file.arrayBuffer())
    } catch (error) {
      if (error instanceof OfflineV5Error) throw error
      throw new OfflineV5Error('blob_missing', 'Falta una parte del archivo local.')
    }
  }

  async remove(directory: string): Promise<void> {
    try { await (await this.root(false)).removeEntry(checkedName(directory), { recursive: true }) }
    catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return
      throw error
    }
  }
}

export class MemoryOfflineV5BlobStore implements OfflineV5OpaqueBlobStore {
  private chunks = new Map<string, Uint8Array<ArrayBuffer>>()
  supported() { return true }
  async write(directory: string, chunk: string, bytes: Uint8Array<ArrayBuffer>) { this.chunks.set(`${checkedName(directory)}/${checkedName(chunk)}`, bytes.slice()) }
  async read(directory: string, chunk: string) {
    const value = this.chunks.get(`${checkedName(directory)}/${checkedName(chunk)}`)
    if (!value) throw new OfflineV5Error('blob_missing', 'Falta una parte del archivo local.')
    return value.slice()
  }
  async remove(directory: string) {
    const prefix = `${checkedName(directory)}/`
    for (const key of this.chunks.keys()) if (key.startsWith(prefix)) this.chunks.delete(key)
  }
  count() { return this.chunks.size }
}
