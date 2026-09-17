'use client'

import { useEffect } from 'react'
import {
  getOfflineV5ServiceWorkerStatus,
  retireOfflineV5ServiceWorkerAndCaches,
} from '@/lib/offlineV5ServiceWorker'

export function shouldRetireRootOfflineWorker(status: { enabled?: boolean; mode?: string } | undefined) {
  return status?.enabled === false && status.mode !== 'offline'
}

export default function RootServiceWorkerRuntime() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return
    const retireLegacyDisabledWorker = async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration('/')
        if (!registration) return
        const status = await getOfflineV5ServiceWorkerStatus()
        if (shouldRetireRootOfflineWorker(status)) await retireOfflineV5ServiceWorkerAndCaches()
      } catch { /* A normal online session must never fail because Offline is unavailable. */ }
    }

    if (document.readyState === 'complete') void retireLegacyDisabledWorker()
    else window.addEventListener('load', retireLegacyDisabledWorker, { once: true })
    return () => window.removeEventListener('load', retireLegacyDisabledWorker)
  }, [])

  return null
}
