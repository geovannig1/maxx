import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

// Separate from release acceptance. Real app/proxy, loopback test auth and synthetic source fixtures.
export default defineConfig({
  // Specs import fixtures that reach `import 'server-only'` modules; this config maps the marker to Next's no-op.
  tsconfig: '../../tsconfig.scripts.json',
  testDir: '.', testMatch: '*.spec.ts', fullyParallel: false, workers: 1, retries: 0, timeout: 60_000,
  outputDir: '../../test-results/reporting-browser', reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:3147', viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure', actionTimeout: 10_000 },
  webServer: { command: 'node tests/reporting-browser/server.mjs', url: 'http://127.0.0.1:3147/login',
    cwd: resolve(__dirname, '../..'), timeout: 120_000, reuseExistingServer: false },
})
