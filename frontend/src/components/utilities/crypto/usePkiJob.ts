'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CryptoInputError } from './cryptoOperations'
import type { PkiJob } from './pki.worker'

export function usePkiJob() {
  const active = useRef<{ worker: Worker; timeout: ReturnType<typeof setTimeout>; reject: (error: Error) => void } | null>(null)
  const sequence = useRef(0)
  const [busy, setBusy] = useState(false)
  const cancel = useCallback(() => {
    sequence.current++
    if (active.current) {
      clearTimeout(active.current.timeout)
      active.current.worker.terminate()
      active.current.reject(new DOMException('Operación cancelada', 'AbortError'))
      active.current = null
    }
    setBusy(false)
  }, [])
  useEffect(() => () => {
    sequence.current++
    if (active.current) {
      clearTimeout(active.current.timeout)
      active.current.worker.terminate()
      active.current.reject(new DOMException('Operación cancelada', 'AbortError'))
      active.current = null
    }
  }, [])
  const run = useCallback(<T,>(job: PkiJob): Promise<T> => {
    cancel()
    const id = ++sequence.current
    setBusy(true)
    return new Promise((resolve, reject) => {
      let worker: Worker
      try { worker = new Worker(new URL('./pki.worker.ts', import.meta.url), { type: 'module' }) }
      catch { setBusy(false); reject(new CryptoInputError('No se pudo iniciar el procesamiento de la clave.')); return }
      const finish = () => {
        worker.terminate()
        if (active.current?.worker === worker) {
          clearTimeout(active.current.timeout)
          active.current = null
          setBusy(false)
        }
      }
      const timeout = setTimeout(() => { finish(); reject(new CryptoInputError('La operación superó 60 segundos. Puedes reintentar.')) }, 60_000)
      active.current = { worker, timeout, reject }
      worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result: T; error: string }>) => {
        if (id !== sequence.current || event.data.id !== id) return
        finish()
        if (event.data.ok) resolve(event.data.result)
        else reject(new CryptoInputError(event.data.error))
      }
      worker.onerror = () => { finish(); reject(new CryptoInputError('No se pudo iniciar el procesamiento de la clave.')) }
      try { worker.postMessage({ ...job, id }, job.task === 'import' ? [job.data] : []) }
      catch { finish(); reject(new CryptoInputError('No se pudo preparar la operación. Vuelve a seleccionar el archivo.')) }
    })
  }, [cancel])
  return { busy, run, cancel }
}
