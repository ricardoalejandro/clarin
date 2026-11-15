'use client'

import { createContext, useContext, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

export type UtilitySlotValue = Blob | string
export type UtilitySlotSource = UtilitySlotValue | (() => UtilitySlotValue)
export interface UtilityDisplayStatus { lightPanels: string[]; chunkedPanels: string[] }

export interface UtilityDocumentSession {
  documentId: string
  initialState: Record<string, unknown>
  searchQuery?: string
  searchRequest?: number
  readSlot: (name: string) => Promise<Blob | null>
  setState: (state: Record<string, unknown>) => void
  setSlot: (name: string, value: UtilitySlotSource) => void
  getSlot: (name: string) => Blob | undefined
  slotNames?: () => string[]
  registerBeforeDeactivate?: (callback: () => void) => () => void
  reportDisplayStatus?: (status: UtilityDisplayStatus) => void
  flush: () => Promise<boolean>
}

const documentContext = createContext<UtilityDocumentSession | null>(null)
export const UtilityDocumentProvider = documentContext.Provider
export const DocumentSessionProvider = documentContext.Provider
export function useUtilityDocument() { return useContext(documentContext) }

/** Outside the library, tools retain their standalone, in-memory behavior. */
export function useUtilityDocumentState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const document = useUtilityDocument()
  const [value, setValue] = useState<T>(() => document && Object.hasOwn(document.initialState, key) ? document.initialState[key] as T : initial)
  const previous = useRef(value)
  useEffect(() => {
    if (Object.is(previous.current, value)) return
    previous.current = value
    document?.setState({ [key]: value })
  }, [document, key, value])
  return [value, setValue]
}

export function useUtilityDocumentText(slot: string): [string, (value: string) => void] {
  const document = useUtilityDocument()
  const [value, setValue] = useState('')
  const changed = useRef(false)
  useEffect(() => {
    if (!document) return
    let alive = true
    void document.readSlot(slot).then(blob => blob?.text()).then(text => {
      if (alive && !changed.current && text !== undefined) setValue(text)
    }).catch(() => { /* The library owns retry and error feedback. */ })
    return () => { alive = false }
  }, [document, slot])
  return [value, next => { changed.current = true; setValue(next); document?.setSlot(slot, next) }]
}
