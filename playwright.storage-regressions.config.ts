import { defineConfig } from '@playwright/test'
import storage from './playwright.storage.config'

export default defineConfig({
  ...storage,
  testMatch: /storage-self-service-regressions-live\.spec\.ts/,
  outputDir: './work/qa-regressions/browser-results',
  reporter: [['list'], ['json', { outputFile: './work/qa-regressions/browser-results.json' }]],
})
