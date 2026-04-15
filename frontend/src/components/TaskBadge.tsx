'use client'

import { useEffect, useState, useCallback } from 'react'
import { api, subscribeWebSocket } from '@/lib/api'

export default function TaskBadge() {
  const [count, setCount] = useState(0)

  const fetchStats = useCallback(async () => {
    const result = await api<{ stats?: { overdue?: number; today?: number } }>('/api/tasks/stats')
    if (result.success && result.data?.stats) {
      setCount((result.data.stats.overdue || 0) + (result.data.stats.today || 0))
    }
  }, [])

  useEffect(() => {
    fetchStats()
    const interval = setInterval(fetchStats, 60000)
    return () => clearInterval(interval)
  }, [fetchStats])

  useEffect(() => {
    const unsub = subscribeWebSocket((data: unknown) => {
      const msg = data as { event?: string }
      if (msg.event === 'task_update' || msg.event === 'task_overdue') fetchStats()
    })
    return () => unsub()
  }, [fetchStats])

  if (count <= 0) return null

  return (
    <span className="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
      {count > 99 ? '99+' : count}
    </span>
  )
}
