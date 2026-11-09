# Durable-generation real-Supabase integration proofs

These verify the durable-generation RPCs against a **real** Postgres + PostgREST — the
four things PGlite's single in-process connection cannot prove:

1. **Full schema replay** — `supabase start` applies `supabase/migrations/0001_baseline.sql` against real Postgres 17.
2. **Multi-connection concurrency** — CAS rejects all-but-one racing commit; the shared `:decision`
   advisory lock serializes cross-stage (a concurrent flag commit blocks while a rec RPC holds the lock).
3. **PostgREST RPC serialization** — the RPCs round-trip through the REST layer as `service_role`.
4. **Permissions** — `anon` is denied the RPCs and direct manifest writes (RLS); `service_role` works.

`engine-pipeline.ts` (run by `tsx`) is the **end-to-end** proof: it seeds insights, then runs the REAL
`runFlagEngine → generateRecommendationsFromFlags → generateDailyReport` app code against the same local
Postgres — proving the engine publishes a flag generation over PostgREST, recs build from its returned
snapshot and commit with cross-stage lineage, the report pins to that rec generation, a report pinned
to a SUPERSEDED rec generation is rejected (stale) while the prior report row stands, and both
optimization-unit transition directions close structurally via fresh commit-time metadata with ZERO
insight rows for the losing unit.

The vitest integration suite (`vitest.integration.config.ts`) adds `run-daily-sync.test.ts` — SIX
independent orchestration scenarios (happy, rec-failure, flag-failure, single-flight, historical
gating, and campaign-metadata-failure/freeze where campaign B flows through the REAL ingest so its
freshness is genuine while only the engine's metadata read fails) — and `report-api.test.ts`, which
invokes the real route GET and asserts the structured FIVE-state lineage in the response. `npm run
test:db:integration` runs all of it.

The unit-level proofs (rollback, stale-closure, same-day upsert, …) live next door in
`../rpc-generations.test.ts` and run in-process via PGlite (`npm run test:db`) — no Docker needed.

## Run

```bash
scripts/sb.sh start            # brings up Postgres + PostgREST + the anon/authenticated/service_role roles
npm run test:db:integration    # runs tests/db/integration/supabase-integration.mjs
# after changing a migration:   scripts/sb.sh db reset
# when done:                    scripts/sb.sh stop
```

`scripts/sb.sh` wraps the Supabase CLI so it runs from a work dir without the repo's `.env.local` — the
CLI's env parser rejects a line in it (`failed to parse environment file: .env.local`) and aborts
`supabase start`/`db reset` from the project root. (You can also just fix that line in `.env.local`; its
parser is stricter than Next.js's.) `supabase start` directly works too if your `.env.local` parses.

Notes:
- Defaults target the standard local stack (`127.0.0.1:54321/54322`) with the well-known local demo keys.
  Override with `SB_DB_URL` / `SB_API_URL` / `SB_ANON_KEY` / `SB_SERVICE_ROLE_KEY`.
- The suite replicates prod's ambient default-ACL grants on the **existing** tables the RPCs touch
  (`supabase start` doesn't apply them locally) and seeds a test `ad_accounts` row + owned entities.
  `decision_generations`'s own grants come from the baseline (explicit), not from here.
- This requires Docker, so it is intentionally NOT part of `npm test` or `npm run test:db`.
- Since the v1 release money metrics have no built-in target; suites that need a CPA target store the example
  owner's targets (`tests/helpers/example-owner-targets.ts`) in `app_settings.performance_targets`.
- Suites that measure the production privilege contract restore it from the baseline first
  (`shipped-privileges.ts`), because other suites blanket-GRANT tables for their fixtures.
