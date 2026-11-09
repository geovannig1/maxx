import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Docker-gated integration vitest tests: the REAL app code (runDailySync orchestration, engine, RPCs)
// against a running LOCAL Supabase, with the Meta API layer mocked. Kept OUT of the hermetic PGlite
// config (vitest.db.config.ts) and the pure-unit config. `test.env` pins the admin client to the LOCAL
// stack (the demo service key) so a run can never touch a remote/prod project; the tests also assert the
// URL is loopback before writing. Requires `supabase start`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/integration/**/*.test.ts'],
    // SERIAL file execution: these suites share ONE local database (grants, advisory locks, the
    // account-agnostic acuity ledger, single-flight sync rows). Parallel beforeAll GRANT statements
    // race Postgres catalogs ("tuple concurrently updated").
    fileParallelism: false,
    testTimeout: 60000,
    // Loopback-only. Overridable via the SB_* env for a non-default local stack, but never a remote.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.SB_API_URL || 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SB_SERVICE_ROLE_KEY ||
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
      SB_DB_URL: process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
      // No LLM provider → the report persists metrics-only, deterministically.
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
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
