import { expect, it } from 'vitest'
import { activeTabScrollLeft, libraryDrawerBounds, libraryLayout, librarySaveStatus } from './libraryLayout'

it('bases progressive disclosure on the measured editor width after its own library', () => {
  expect(libraryLayout(320)).toEqual({ sidebar: false, overlay: false, compact: true })
  expect(libraryLayout(375, true)).toEqual({ sidebar: false, overlay: true, compact: true })
  expect(libraryLayout(800, true)).toEqual({ sidebar: false, overlay: true, compact: false })
  expect(libraryLayout(1063, true).sidebar).toBe(false)
  expect(libraryLayout(1064, true)).toEqual({ sidebar: true, overlay: false, compact: false })
  expect(libraryLayout(1200)).toEqual({ sidebar: false, overlay: false, compact: false })
  expect(libraryLayout(Number.NaN)).toEqual({ sidebar: false, overlay: false, compact: true })
})

it('reveals the active tab by moving only its strip and clamps both ends after reflow', () => {
  const view = { left: 100, right: 300, scrollLeft: 0, clientWidth: 200, scrollWidth: 800 }
  expect(activeTabScrollLeft(view, { left: 500, right: 680 })).toBe(380)
  expect(activeTabScrollLeft({ ...view, scrollLeft: 380 }, { left: 60, right: 240 })).toBe(340)
  expect(activeTabScrollLeft({ ...view, scrollLeft: 380 }, { left: 120, right: 280 })).toBe(380)
  expect(activeTabScrollLeft({ ...view, scrollLeft: 380, clientWidth: 800 }, { left: 120, right: 280 })).toBe(0)
})

it('keeps the library below the common header and within the measured visual viewport', () => {
  expect(libraryDrawerBounds({ left: 68, top: 0, right: 1263, bottom: 650 }, { left: 0, top: 0, width: 1263, height: 650 }))
    .toEqual({ left: 68, top: 44, width: 1195, height: 606, panelWidth: 224 })
  expect(libraryDrawerBounds({ left: 0, top: -20, right: 320, bottom: 700 }, { left: 4, top: 50, width: 300, height: 400 }))
    .toEqual({ left: 4, top: 50, width: 300, height: 400, panelWidth: 224 })
})

it('keeps save failures ahead of background phases and never calls pending tabs saved', () => {
  expect(librarySaveStatus(undefined, 'saved', true, false, false).label).toBe('Abriendo documento…')
  expect(librarySaveStatus('saved', 'saving', false, true, false).label).toBe('Guardando pestañas…')
  expect(librarySaveStatus('conflict', 'saved', false, true, false)).toEqual({ label: 'Conflicto de versión', tone: 'error' })
  expect(librarySaveStatus('dirty', 'saved', false, false, false).label).toBe('Cambios pendientes')
  expect(librarySaveStatus('saved', 'error', false, false, false).tone).toBe('error')
  expect(librarySaveStatus('saved', 'saved', false, true, false)).toEqual({ label: 'Guardado · Indexando', tone: 'saved' })
})
