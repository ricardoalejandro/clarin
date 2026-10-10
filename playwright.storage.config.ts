import { defineConfig, devices } from '@playwright/test'

// Focused storage acceptance. The frontend must already be running locally.
// A prepared environment may use its installed Chromium without downloading
// browsers or changing application dependencies.
export default defineConfig({
  testDir: './tests',
  testMatch: /storage-self-service(?:-live)?\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: './work/qa-acceptance/browser-results',
  reporter: [['list'], ['json', { outputFile: './work/qa-acceptance/browser-results.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    trace: 'off', // Native login credentials must never enter exported traces.
    video: 'off',
    screenshot: 'only-on-failure',
    launchOptions: process.env.CLARIN_QA_CHROMIUM_PATH
      ? { executablePath: process.env.CLARIN_QA_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: 'storage-chromium' }],
})
