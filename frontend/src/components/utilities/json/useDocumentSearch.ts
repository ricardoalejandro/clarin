import { useEffect, useRef, useState } from 'react'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import type { DocumentMatch, SearchResponse } from './documentSearch'

export function useDocumentSearch(open: boolean, identity: string, revision: number, source: () => string) {
  const [query, setRawQuery] = useState('')
  const [settled, settle] = useDebouncedValue(query)
  const [settledRevision] = useDebouncedValue(revision)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [matches, setMatches] = useState<DocumentMatch[]>([])
  const [resultVersion, setResultVersion] = useState({ identity, revision, query: '', caseSensitive: false })
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const worker = useRef<{ instance: Worker; identity: string; revision: number } | null>(null)
  const sequence = useRef(0)
  const suspended = useRef(false)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const getSource = useRef(source)
  getSource.current = source

  function stop() {
    sequence.current++
    clearTimeout(timeout.current)
    worker.current?.instance.terminate()
    worker.current = null
  }

  function request(offset = 0) {
    if (suspended.current) return
    if (!settled || !open) { stop(); setMatches([]); setNextOffset(null); setWorking(false); setError(''); return }
    const id = ++sequence.current
    clearTimeout(timeout.current)
    setWorking(true)
    setError('')
    try {
      if (!worker.current || worker.current.identity !== identity || worker.current.revision !== revision) {
        worker.current?.instance.terminate()
        const instance = new Worker(new URL('./documentSearch.worker.ts', import.meta.url), { type: 'module' })
        worker.current = { instance, identity, revision }
        instance.postMessage({ kind: 'load', source: getSource.current() })
      }
      const instance = worker.current.instance
      instance.onmessage = (event: MessageEvent<SearchResponse>) => {
        if (event.data.id !== sequence.current || worker.current?.instance !== instance) return
        clearTimeout(timeout.current)
        setMatches(current => offset ? [...current, ...event.data.matches] : event.data.matches)
        setResultVersion({ identity, revision, query: settled, caseSensitive })
        setNextOffset(event.data.nextOffset)
        setWorking(false)
      }
      const fail = () => {
        if (worker.current?.instance !== instance || sequence.current !== id) return
        stop()
        setMatches([])
        setNextOffset(null)
        setWorking(false)
        setError('No se pudo completar la búsqueda. Modifica el texto para reintentar.')
      }
      instance.onerror = event => { event.preventDefault(); fail() }
      timeout.current = setTimeout(fail, 10_000)
      instance.postMessage({ kind: 'find', id, query: settled, caseSensitive, offset })
    } catch {
      stop()
      setMatches([])
      setNextOffset(null)
      setWorking(false)
      setError('No se pudo iniciar la búsqueda local.')
    }
  }

  useEffect(() => {
    request()
    // The content getter is intentionally lazy; a new query reuses the loaded worker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, identity, settledRevision, settled, caseSensitive])
  useEffect(() => () => stop(), [])

  return {
    query, setQuery: (value: string) => { suspended.current = false; setRawQuery(value); if (!value) settle('') }, caseSensitive,
    setCaseSensitive: (value: boolean | ((current: boolean) => boolean)) => { suspended.current = false; setCaseSensitive(value) },
    resume: () => { suspended.current = false },
    suspend: () => { suspended.current = true; stop(); setWorking(false); setMatches([]); setNextOffset(null) },
    matches: resultVersion.identity === identity && resultVersion.revision === revision ? matches : [], working,
    completed: resultVersion.identity === identity && resultVersion.revision === revision && resultVersion.query === query && resultVersion.caseSensitive === caseSensitive,
    pending: query !== settled || Boolean(open && settled && revision !== settledRevision), error, nextOffset,
    more: () => { if (nextOffset !== null && !working) request(nextOffset) },
  }
}
