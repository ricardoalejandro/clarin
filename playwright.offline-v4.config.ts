import { defineConfig, devices } from '@playwright/test'

// Browser binaries are QA infrastructure, never a dependency installed on a
// Clarin user's machine. Both named channels must run; no silently skipped gate.
export default defineConfig({
  testDir: './tests',
  testMatch: /offline-v4.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/offline-v4-browser-report.json' }]],
  use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: process.env.OFFLINE_QA_CHROME || '/opt/google/chrome/chrome' } } },
    { name: 'edge', use: { ...devices['Desktop Edge'], launchOptions: { executablePath: process.env.OFFLINE_QA_EDGE || '/opt/microsoft/msedge/msedge' } } },
  ],
})
