import path from 'node:path'
import { defineConfig } from 'vitest/config'

const forkRoot = path.resolve(__dirname, 'vendor/excalidraw-clarin')

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: {
    alias: [
      {
        find: /^@excalidraw\/math$/,
        replacement: path.join(forkRoot, 'packages/math/index.ts'),
      },
      {
        find: /^@excalidraw\/math\/(.*)$/,
        replacement: `${path.join(forkRoot, 'packages/math')}/$1.ts`,
      },
      {
        find: /^@excalidraw\/utils$/,
        replacement: path.join(forkRoot, 'packages/utils/index.ts'),
      },
      {
        find: /^@excalidraw\/utils\/(.*)$/,
        replacement: `${path.join(forkRoot, 'packages/utils')}/$1.ts`,
      },
      {
        find: /^@excalidraw\/excalidraw$/,
        replacement: path.join(forkRoot, 'packages/excalidraw/index.tsx'),
      },
      {
        find: /^@excalidraw\/excalidraw\/(actions|element|scene)$/,
        replacement: `${path.join(forkRoot, 'packages/excalidraw')}/$1/index.ts`,
      },
      {
        find: /^@excalidraw\/excalidraw\/(.*)$/,
        replacement: `${path.join(forkRoot, 'packages/excalidraw')}/$1.ts`,
      },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'vendor/excalidraw-clarin/packages/excalidraw/tests/clarinFreedrawPressure.test.ts',
      'vendor/excalidraw-clarin/packages/excalidraw/tests/clarinTextWysiwyg.test.ts',
    ],
    restoreMocks: true,
  },
})
