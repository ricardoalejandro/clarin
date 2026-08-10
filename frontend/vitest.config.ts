import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    server: {
      deps: {
        inline: ['@excalidraw/excalidraw', 'roughjs'],
      },
    },
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/lib/useDebouncedValue.test.tsx',
      'src/lib/searchRequestLifecycle.test.ts',
      'src/lib/cloudChatCapabilities.test.ts',
      'src/lib/chatReactions.test.ts',
      'src/lib/whatsappEditor.test.ts',
      'src/lib/whiteboard*.test.ts',
      'src/lib/useKanbanPan.test.tsx',
      'src/lib/dashboardSidebarState.test.ts',
      'src/lib/adminUserAccountAssignments.test.ts',
      'src/lib/accountSwitcher.test.ts',
      'src/lib/mobileApp.test.ts',
      'src/lib/api.test.ts',
      'src/lib/pwaCache.test.ts',
      'src/lib/chunkRecoveryScript.test.ts',
      'src/lib/survey*.test.ts',
      'src/app/manifest.test.ts',
      'src/app/sw.js/route.test.ts',
      'src/components/TagInput.test.tsx',
      'src/components/AccountSwitcher.test.tsx',
      'src/components/mobile-app/**/*.test.{ts,tsx}',
      'src/components/reports/WhatsAppGroupSelector.test.tsx',
      'src/components/surveys/**/*.test.{ts,tsx}',
      'src/components/task-work/**/*.test.{ts,tsx}',
      'src/components/crm-detail/**/*.test.{ts,tsx}',
      'src/components/drag-interaction/**/*.test.{ts,tsx}',
      'src/components/operational-date/**/*.test.{ts,tsx}',
      'src/components/operational-window/**/*.test.{ts,tsx}',
      'src/components/contact-details/**/*.test.{ts,tsx}',
      'src/components/whiteboards/**/*.test.{ts,tsx}',
    ],
    restoreMocks: true,
  },
})
