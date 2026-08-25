import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportToSvg } from '@excalidraw/excalidraw'

type Variability = 'constant' | 'variable'

const nativePath2D = globalThis.Path2D

beforeAll(() => {
  // jsdom does not implement Path2D. Static SVG export only needs the
  // constructor while it builds the cached freedraw shape; the SVG geometry
  // itself is emitted from the same outline points into the `d` attribute.
  globalThis.Path2D = class Path2DStub {} as typeof Path2D
})

afterAll(() => {
  globalThis.Path2D = nativePath2D
})

function freedrawElement(input: {
  id: string
  pressures: number[]
  simulatePressure?: boolean
  variability?: Variability
}) {
  return {
    id: input.id,
    type: 'freedraw',
    x: 0,
    y: 0,
    width: 60,
    height: 24,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    index: 'a0',
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    points: [[0, 12], [12, 4], [28, 20], [44, 6], [60, 12]],
    pressures: input.pressures,
    simulatePressure: input.simulatePressure ?? false,
    lastCommittedPoint: [60, 12],
    ...(input.variability
      ? { strokeOptions: { variability: input.variability, streamline: 0.5 } }
      : {}),
  }
}

async function exportedFreedrawPath(element: ReturnType<typeof freedrawElement>) {
  const svg = await exportToSvg({
    elements: [element] as never,
    files: {},
    appState: {
      exportBackground: false,
      viewBackgroundColor: '#ffffff',
    },
    exportPadding: 0,
    skipInliningFonts: true,
  })
  const path = (svg as SVGSVGElement).querySelector<SVGPathElement>('path[fill="#1e1e1e"]')
  expect(path).not.toBeNull()
  return path!.getAttribute('d')
}

describe('freedraw pressure renderer', () => {
  const lowToHighPressure = [0.1, 0.2, 0.45, 0.75, 0.95]
  const highToLowPressure = [...lowToHighPressure].reverse()

  it('keeps constant strokes identical when physical pressure samples change', async () => {
    const first = await exportedFreedrawPath(freedrawElement({
      id: 'constant-low-high',
      pressures: lowToHighPressure,
      variability: 'constant',
    }))
    const second = await exportedFreedrawPath(freedrawElement({
      id: 'constant-high-low',
      pressures: highToLowPressure,
      variability: 'constant',
    }))
    const simulated = await exportedFreedrawPath(freedrawElement({
      id: 'constant-simulated',
      pressures: [],
      simulatePressure: true,
      variability: 'constant',
    }))

    expect(first).toBe(second)
    expect(simulated).toBe(first)
  })

  it('keeps pressure-sensitive strokes variable and legacy rendering equivalent', async () => {
    const variable = await exportedFreedrawPath(freedrawElement({
      id: 'variable-low-high',
      pressures: lowToHighPressure,
      variability: 'variable',
    }))
    const reversed = await exportedFreedrawPath(freedrawElement({
      id: 'variable-high-low',
      pressures: highToLowPressure,
      variability: 'variable',
    }))
    const legacy = await exportedFreedrawPath(freedrawElement({
      id: 'legacy-low-high',
      pressures: lowToHighPressure,
    }))

    expect(variable).not.toBe(reversed)
    expect(legacy).toBe(variable)
  })
})
