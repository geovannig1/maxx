import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Real-Postgres integration tests for the durable-generation RPCs, run in-process against
// PGlite (Postgres compiled to WASM — no Docker). Verifies transaction/rollback, CAS, lineage,
// stale-closure, same-day upsert, empty generations, and report races. True CONCURRENT interleaving
// (two live connections racing the advisory lock) is the one property PGlite's single connection can't
// prove — run that against multi-connection Postgres (Supabase CLI) before deploy.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    // The Docker-gated integration vitest tests (real local Supabase, mocked Meta) run under
    // vitest.integration.config.ts, NOT here — this PGlite config is hermetic and env-free.
    exclude: ['node_modules/**', 'tests/db/integration/**'],
    testTimeout: 30000,
    // testTimeout was raised but hookTimeout kept Vitest's 10s default, and freshDb()
    // rebuilds the whole schema in beforeEach — so ordinary acceptance runs hit setup timeouts that
    // looked like SQL failures. A serial run with a 30s hook allowance passed 128/128. Deterministic
    // single-fork execution also removes the PGlite instances-competing-for-CPU variance.
    hookTimeout: 60000,
    // Vitest 4 dropped `poolOptions` from InlineConfig; `fileParallelism: false` is the supported way
    // to serialise, and it is what removes the PGlite-instances-competing-for-CPU variance.
    fileParallelism: false,
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
