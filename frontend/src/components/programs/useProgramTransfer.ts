'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, apiBlob } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { programTransferAllowed, programTransferFilename, transferError } from './programTransfer'

export function useProgramTransferScope() {
  return useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
}

export function useProgramTransferAccess(scope: string, enabled: boolean) {
  const [access, setAccess] = useState<{ scope: string; allowed: boolean }>()
  useEffect(() => {
    if (!enabled || isAuthIdentityChanging(scope) || scope === 'server') return
    const controller = new AbortController()
    void api<{ user?: unknown }>('/api/me', { signal: controller.signal, cache: 'no-store' }).then(response => {
      if (!controller.signal.aborted && scope === getAuthScope()) {
        setAccess({ scope, allowed: response.success && programTransferAllowed(response.data?.user) })
      }
    })
    return () => controller.abort()
  }, [scope, enabled])
  return enabled && access?.scope === scope && access.allowed
}

export function useProgramTransferDownload(scope: string, resourceScope = scope) {
  const [busy, setBusy] = useState<{ id: string; resourceScope: string } | null>(null)
  const current = useRef({ scope, resourceScope })
  const request = useRef<AbortController | null>(null)
  current.current = { scope, resourceScope }
  useEffect(() => () => {
    request.current?.abort()
    request.current = null
  }, [scope, resourceScope])

  const download = async (id: string, name: string, report: (message: string, type: 'success' | 'error') => void) => {
    if (request.current || scope !== getAuthScope() || isAuthIdentityChanging(scope) || resourceScope !== current.current.resourceScope) return
    const controller = new AbortController()
    request.current = controller
    setBusy({ id, resourceScope })
    try {
      const result = await apiBlob(`/api/programs/${encodeURIComponent(id)}/transfer/export`, { signal: controller.signal })
      if (controller.signal.aborted || scope !== getAuthScope() || resourceScope !== current.current.resourceScope) return
      if (!result.success || !result.blob || result.blob.size === 0) {
        report(transferError(result.status, undefined, result.error || 'No se pudo descargar el programa. Vuelve a intentarlo.'), 'error')
        return
      }
      const url = URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = programTransferFilename(name)
      link.style.display = 'none'
      try {
        document.body.append(link)
        link.click()
      } finally {
        link.remove()
        // Leave the URL available until the download starts in the next task.
        window.setTimeout(() => URL.revokeObjectURL(url), 0)
      }
      report('Programa exportado. El archivo contiene datos personales; compártelo solo con personas autorizadas.', 'success')
    } catch {
      if (!controller.signal.aborted && scope === getAuthScope() && resourceScope === current.current.resourceScope) {
        report('No se pudo descargar el programa. Vuelve a intentarlo.', 'error')
      }
    } finally {
      if (request.current === controller) {
        request.current = null
        setBusy(null)
      }
    }
  }

  return { downloadingProgramId: busy?.resourceScope === resourceScope ? busy.id : null, download }
}
