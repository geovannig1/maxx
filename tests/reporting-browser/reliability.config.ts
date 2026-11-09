import { defineConfig } from '@playwright/test'

// Uses the explicitly isolated test app started by npm run preview:sample.
// Kept separate from ordinary preview checks: these tests inject source failures.
export default defineConfig({
  // Specs import fixtures that reach `import 'server-only'` modules; this config maps the marker to Next's no-op.
  tsconfig: '../../tsconfig.scripts.json',
  testDir: '.', testMatch: ['reporting.spec.ts', 'reliability.spec.ts', 'progressive.spec.ts'], workers: 1, retries: 0, timeout: 60_000,
  outputDir: '../../test-results/reporting-reliability', reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:3147', viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure', actionTimeout: 10_000 },
})
