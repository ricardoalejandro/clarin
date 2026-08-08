'use client'

import { useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'

export default function useCrmWindowStorageScope(surface: 'leads' | 'events') {
  const [actorScope, setActorScope] = useState(`pending:pending:${surface}`)

  useEffect(() => {
    let active = true
    void apiGet<{ user: { id: string; account_id: string } }>('/api/me').then(result => {
      if (!active || !result.success || !result.data?.user) return
      setActorScope(`${result.data.user.account_id}:${result.data.user.id}:${surface}`)
    })
    return () => { active = false }
  }, [surface])

  return actorScope
}
