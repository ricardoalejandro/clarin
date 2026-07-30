import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/lib/useDebouncedValue.test.tsx',
      'src/lib/useKanbanPan.test.tsx',
      'src/components/task-work/taskWorkspaceState.test.ts',
      'src/components/task-work/taskBoardSelection.test.ts',
      'src/components/task-work/taskCalendarState.test.ts',
    ],
    restoreMocks: true,
  },
})
