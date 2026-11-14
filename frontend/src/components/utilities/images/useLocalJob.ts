import { useEffect, useRef, useState } from 'react'

export type JobState<T> =
  | { status: 'idle' | 'pending' }
  | { status: 'error'; error: string }
  | { status: 'ready'; value: T }

export function useLocalJob<T>() {
  const [state, setState] = useState<JobState<T>>({ status: 'idle' })
  const current = useRef<AbortController | null>(null)

  useEffect(() => () => current.current?.abort(), [])

  function clear() {
    current.current?.abort()
    current.current = null
    setState({ status: 'idle' })
  }

  async function run(task: (signal: AbortSignal) => Promise<T>) {
    current.current?.abort()
    const controller = new AbortController()
    current.current = controller
    setState({ status: 'pending' })
    try {
      const value = await task(controller.signal)
      if (!controller.signal.aborted) setState({ status: 'ready', value })
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({ status: 'error', error: error instanceof Error ? error.message : 'No pudimos completar la operación.' })
      }
    } finally {
      if (current.current === controller) current.current = null
    }
  }

  return { state, clear, run }
}
