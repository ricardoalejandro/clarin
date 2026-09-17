import { defineConfig, devices } from '@playwright/test'

// The QA browser is test infrastructure on the server. Clarín users install
// nothing: production uses the Chrome/Edge already present on their machine.
export default defineConfig({
  testDir: './tests',
  testMatch: /offline-v5-shell\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 210_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/offline-v5-browser-report.json' }]],
  use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{
    name: 'chromium-engine',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: {
        executablePath: process.env.OFFLINE_QA_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
      },
    },
  }],
})
