import '@testing-library/jest-dom/vitest'

// Excalidraw feature-detects Canvas filters while its module is evaluated.
// JSDOM intentionally has no drawing implementation, so expose only the
// capability shape needed by component and scene-serialization unit tests.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => ({ filter: '' }),
})
