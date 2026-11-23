/// <reference lib="webworker" />
import { createCertificateRequest, exportVaultKey, generateVaultKey, importVaultFile, parseKeyMaterial, signJwt, verifyJwt } from './pkiOperations'
import { CryptoInputError } from './cryptoOperations'

export type PkiJob =
  | { task: 'generate'; kind: 'aes' | 'rsa' | 'ec'; size: number | string }
  | { task: 'import'; data: ArrayBuffer; filename: string; password: string }
  | { task: 'export'; material: string; format: Parameters<typeof exportVaultKey>[1]; password: string }
  | { task: 'csr' | 'certificate'; material: string; commonName: string; dns: string[] }
  | { task: 'sign' | 'verify'; material: string; source: string }

self.onmessage = async (event: MessageEvent<PkiJob & { id: number }>) => {
  const job = event.data
  try {
    let result: unknown
    switch (job.task) {
      case 'generate': result = await generateVaultKey(job.kind, job.size); break
      case 'import': result = await importVaultFile(job.data, job.filename, job.password); break
      case 'export': result = await exportVaultKey(parseKeyMaterial(job.material), job.format, job.password); break
      case 'csr': case 'certificate': result = await createCertificateRequest(parseKeyMaterial(job.material), job.commonName, job.dns, job.task === 'certificate'); break
      case 'sign': result = await signJwt(parseKeyMaterial(job.material), job.source); break
      case 'verify': result = await verifyJwt(parseKeyMaterial(job.material), job.source); break
    }
    self.postMessage({ id: job.id, ok: true, result })
  } catch (error) {
    self.postMessage({ id: job.id, ok: false, error: error instanceof CryptoInputError ? error.message : 'No se pudo procesar el archivo o la clave. Comprueba su formato y algoritmo.' })
  }
}
