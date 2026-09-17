import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: /offline-v3-shell\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90000,
  reporter: [['list']],
  outputDir: '/tmp/clarin-offline-v3-playwright',
  use: { ...devices['Desktop Chrome'], serviceWorkers: 'allow', trace: 'retain-on-failure' },
  projects: [{ name: 'offline-shell-chromium' }],
})
