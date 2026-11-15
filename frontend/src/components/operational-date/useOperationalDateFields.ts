'use client'

import { useCallback, useRef, useState } from 'react'
import type { OperationalDateDraftState } from './operationalDateInput'

/** Keeps the latest typed values available synchronously to explicit Save actions. */
export function useOperationalDateFields() {
  const fields = useRef(new Map<string, OperationalDateDraftState>())
  const callbacks = useRef(new Map<string, (state: OperationalDateDraftState) => void>())
  const [, render] = useState(0)
  const track = useCallback((name: string) => {
    let callback = callbacks.current.get(name)
    if (!callback) {
      callback = state => {
        const previous = fields.current.get(name)
        if (state.active === false) {
          if (previous?.inputId === state.inputId) { fields.current.delete(name); render(value => value + 1) }
          return
        }
        if (previous && previous.inputId === state.inputId && previous.valid === state.valid && previous.value === state.value && previous.dirty === state.dirty && previous.message === state.message) return
        fields.current.set(name, state)
        render(value => value + 1)
      }
      callbacks.current.set(name, callback)
    }
    return callback
  }, [])
  const validate = useCallback(() => {
    for (const state of fields.current.values()) {
      if (state.valid) continue
      if (typeof document !== 'undefined') {
        const input = document.getElementById(state.inputId) as HTMLInputElement | null
        input?.checkValidity()
        input?.focus()
      }
      return false
    }
    return true
  }, [])
  const value = useCallback((name: string, fallback: string) => {
    const current = fields.current.get(name)
    return current?.valid && current.value !== null ? current.value : fallback
  }, [])
  const reset = useCallback(() => {
    fields.current.clear()
    callbacks.current.clear()
    render(value => value + 1)
  }, [])
  return { track, validate, value, reset, valid: [...fields.current.values()].every(field => field.valid), dirty: [...fields.current.values()].some(field => field.dirty) }
}
