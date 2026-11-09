import { defineConfig, devices } from '@playwright/test'
import { existsSync, statSync } from 'node:fs'

const baseURL = process.env.E2E_BASE_URL
const storageState = process.env.E2E_STORAGE_STATE
const expectedCommitSha = process.env.E2E_EXPECTED_COMMIT_SHA

if (!baseURL || !storageState || !expectedCommitSha) {
  throw new Error('E2E_BASE_URL, E2E_STORAGE_STATE, and E2E_EXPECTED_COMMIT_SHA are required for authenticated cockpit release tests.')
}

try {
  const url = new URL(baseURL)
  if (url.protocol !== 'https:') throw new Error('must use https')
} catch (error) {
  throw new Error(`E2E_BASE_URL must be an absolute HTTPS URL: ${error instanceof Error ? error.message : String(error)}`)
}

if (!existsSync(storageState) || !statSync(storageState).isFile()) {
  throw new Error(`E2E_STORAGE_STATE must name a readable Playwright storage-state file: ${storageState}`)
}

if (!/^[0-9a-f]{40}$/i.test(expectedCommitSha)) {
  throw new Error('E2E_EXPECTED_COMMIT_SHA must be the full 40-character Git commit SHA for the candidate build.')
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL,
    storageState,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mobile-390', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
    { name: 'tablet-768', use: { ...devices['iPad Mini'], viewport: { width: 768, height: 1024 } } },
    { name: 'desktop-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
  ],
})
