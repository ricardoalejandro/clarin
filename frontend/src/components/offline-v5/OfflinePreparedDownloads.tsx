'use client'

import { useEffect, useState } from 'react'
import { useClarinRuntime } from './ClarinRuntimeProvider'

export function preparedTaskDownloadPath(href: string, origin: string): string | undefined {
  let url: URL
  try { url = new URL(href, origin) } catch { return undefined }
  if (url.origin !== origin || url.username || url.password || !/^\/api\/tasks\/[^/]+\/attachments\/[^/]+\/download$/.test(url.pathname)) return undefined
  return url.pathname
}

// Native links do not pass through the page fetch adapter. Preserve the normal
// download controls while sourcing verified bytes from the unlocked local vault.
export default function OfflinePreparedDownloads() {
  const { isOffline, snapshot } = useClarinRuntime()
  const [error, setError] = useState('')
  useEffect(() => {
    setError('')
    if (!isOffline) return
    const controller = new AbortController(), urls = new Set<string>()
    const download = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') as HTMLAnchorElement | null : null
      const path = anchor && preparedTaskDownloadPath(anchor.href, window.location.origin)
      if (!path) return
      event.preventDefault()
      setError('')
      void (async () => {
        try {
          const response = await fetch(path, { credentials: 'include', cache: 'no-store', signal: controller.signal })
          if (!response.ok) throw new Error('Este archivo no está preparado o su copia local no está disponible.')
          const bytes = await response.blob()
          if (controller.signal.aborted) return
          const url = URL.createObjectURL(bytes); urls.add(url)
          const link = document.createElement('a')
          const disposition = response.headers.get('Content-Disposition') || ''
          let filename = 'archivo'
          try { filename = decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || '') || filename } catch {}
          link.href = url; link.download = filename; link.hidden = true
          document.body.append(link); link.click(); link.remove()
          window.setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url) }, 1000)
        } catch (cause) {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'No se pudo descargar la copia local.')
        }
      })()
    }
    document.addEventListener('click', download)
    return () => {
      controller.abort(); document.removeEventListener('click', download)
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [isOffline, snapshot.accountId, snapshot.userId])
  return error ? <div role="alert" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">{error}</div> : null
}
