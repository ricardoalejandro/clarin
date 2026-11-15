import { expect, it } from 'vitest'
import { libraryLayout } from './libraryLayout'

it('bases progressive disclosure on the measured editor width after its own library', () => {
  expect(libraryLayout(320)).toEqual({ sidebar: false, compact: true })
  expect(libraryLayout(375)).toEqual({ sidebar: false, compact: true })
  expect(libraryLayout(800)).toEqual({ sidebar: false, compact: false })
  expect(libraryLayout(900)).toEqual({ sidebar: true, compact: true })
  expect(libraryLayout(1200)).toEqual({ sidebar: true, compact: false })
  expect(libraryLayout(Number.NaN)).toEqual({ sidebar: false, compact: true })
})
