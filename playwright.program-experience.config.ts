import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// These scenarios replace authentication and API responses with synthetic data.
// Keep the runner explicitly bound to the isolated local production build.
if (process.env.CLARIN_E2E_MOCK_AUTH !== '1' || process.env.PLAYWRIGHT_BASE_URL !== 'http://127.0.0.1:3023') {
  throw new Error('Program experience QA requires the loopback server on port 3023 and synthetic API authentication')
}

export default defineConfig(base, {
  testDir: './tests',
  testMatch: /responsive-dashboard\.spec\.ts/,
  grep: /Clarin responsive authenticated matrix (Programas|Asistencia) /,
  projects: base.projects?.filter(project => ['responsive-desktop', 'responsive-mobile-safari'].includes(project.name || '')),
  outputDir: './test-results/program-experience',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { serviceWorkers: 'block', trace: 'off' },
  webServer: undefined,
})
