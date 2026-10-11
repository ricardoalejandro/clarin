import {defineConfig} from '@playwright/test'
import storage from './playwright.storage.config'
export default defineConfig({...storage,testMatch:/templates-(quality|interactions)-live\.spec\.ts/,timeout:180000,outputDir:'./work/storage-templates-qa/browser-results',reporter:[['list'],['json',{outputFile:'./work/storage-templates-qa/templates-results.json'}]],projects:[{name:'templates-chromium'}]})
