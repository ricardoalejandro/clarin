import { BaseFabricObject, Canvas, Color, Gradient, type GradientOptions } from 'fabric'

// Documents and status overlays store coordinates using Fabric 6's top-left
// defaults. Apply them before any instance or JSON restore, including consumers
// that load Fabric dynamically without opening the document editor first.
Object.assign(BaseFabricObject.ownDefaults, {
  originX: 'left',
  originY: 'top',
})

// Preserve the previous gesture defaults. Individual editors still override
// these explicitly where they implement right-click or stable layer selection.
Object.assign(Canvas.ownDefaults, {
  fireMiddleClick: false,
  fireRightClick: false,
  stopContextMenu: false,
  preserveObjectStacking: false,
})

// Fabric 6 persisted gradient alpha separately. Adapt Fabric 7.4's MIT-licensed
// extensions/data_updaters/gradient contract without importing the extensions
// barrel, which eagerly imports the unrelated, undeclared westures package.
// Source, exact artifact/hash and full license: frontend/THIRD_PARTY_FABRIC.md.
const gradientAdapterMarker = Symbol.for('clarin.fabric.gradient-opacity-v6')
if (!Object.hasOwn(Gradient.fromObject, gradientAdapterMarker)) {
  // Fabric exposes two overloads, while its implementation accepts their union.
  // Preserve both public result types and the receiver used by subclass restores.
  const restoreGradient = Gradient.fromObject as (
    this: typeof Gradient,
    options: GradientOptions<'linear'> | GradientOptions<'radial'>,
  ) => Promise<Gradient<'linear'> | Gradient<'radial'>>
  function restoreLegacyGradient(this: typeof Gradient, options: GradientOptions<'linear'>): Promise<Gradient<'linear'>>
  function restoreLegacyGradient(this: typeof Gradient, options: GradientOptions<'radial'>): Promise<Gradient<'radial'>>
  function restoreLegacyGradient(this: typeof Gradient, options: GradientOptions<'linear'> | GradientOptions<'radial'>) {
    return restoreGradient.call(this, {
      ...options,
      colorStops: options.colorStops?.map(stop => {
        const { opacity, ...current } = stop as typeof stop & { opacity?: number }
        return opacity === undefined || opacity === 1
          ? current
          : { ...current, color: new Color(current.color).setAlpha(opacity).toRgba() }
      }),
    })
  }
  Gradient.fromObject = restoreLegacyGradient
  Object.defineProperty(Gradient.fromObject, gradientAdapterMarker, { value: true })
}

export * from 'fabric'
