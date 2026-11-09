import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Pure-function unit tests run in a node environment. The `@/` alias mirrors tsconfig paths
// so modules under test resolve their imports the same way the app does.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup/env.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Real-Postgres (PGlite) integration tests run under their own config (`npm run test:db`) so the
    // main unit suite stays pure-function and fast.
    exclude: ['tests/db/**', 'node_modules/**'],
    // Several suites call `await import('@/...')` INSIDE a test, after registering vi.mock factories.
    // Vitest charges that module transform + graph load to the TEST's budget. With the expanded
    // 200+ file suite, the heaviest mocked server graphs can exceed 30s under full parallel load even
    // though the same assertions pass in focused batches. Keep the aggregate gate deterministic while
    // still finite; true hangs remain bounded at two minutes.
    testTimeout: 120_000,
    // Six suites build the full PGlite schema in a beforeAll hook. Under full parallel load that
    // takes longer than the 10s hook default and the suite fails before any assertion runs, so the
    // gate went red at random. Hooks get the same finite budget as tests.
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Next resolves the `server-only` marker itself (it is not an npm dependency here). Tests are
      // server code, so map it to Next's own server-layer no-op, exactly what a Server Component gets.
      'server-only': fileURLToPath(new URL('./node_modules/next/dist/compiled/server-only/empty.js', import.meta.url)),
    },
  },
})
