import {defineConfig,devices} from '@playwright/test'
import {isolatedOfflineQAOrigin,isolatedOfflineQARoot} from './scripts/offline/isolated-qa-guard.mjs'
isolatedOfflineQARoot(process.cwd())
export default defineConfig({testDir:'./tests',testMatch:'offline-v5-modules.spec.ts',fullyParallel:false,workers:1,timeout:180_000,expect:{timeout:30_000},outputDir:'test-results/offline-isolated',reporter:[['list'],['html',{outputFolder:'test-results/offline-isolated-report',open:'never'}]],use:{baseURL:isolatedOfflineQAOrigin(process.env.OFFLINE_QA_ORIGIN),...devices['Desktop Chrome'],viewport:{width:1440,height:1000},serviceWorkers:'allow',trace:'retain-on-failure',screenshot:'only-on-failure'}})
