'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function DevicesRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/dashboard/settings?tab=devices')
  }, [router])
  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-200 border-t-emerald-600" />
    </div>
  )
}
