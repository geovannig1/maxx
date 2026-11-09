import { defineConfig } from '@playwright/test'
import reliability from './reliability.config'

// Reuse the owner's already-running isolated app/auth fixture; never restart it.
export default defineConfig({ ...reliability, testMatch: 'prepared.spec.ts',
  outputDir: '../../test-results/reporting-prepared' })
