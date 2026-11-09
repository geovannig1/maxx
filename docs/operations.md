# Operations

Running Maxx after it is installed: scheduled jobs, backups, upgrades, secret rotation, monitoring,
the demo, scaling and what to do in an incident. Installation is in [install.md](install.md).

## Scheduled jobs

| Job | Path | When (UTC) | What |
|---|---|---|---|
| Daily sync | `/api/cron/daily-sync` | 10:00 | Meta entities and insights, reconciliation of enabled reconciling outcome sources (Acuity example), GA4, conversions retry sweep, alerts, recommendations, daily digest; optional AI enrichment (creative vision, competitor analysis, Monday expert signals) when time allows |
| Midday refresh | `/api/sync/midday` | 17:00 | lightweight refresh of today's delivery and pacing |

Both require `Authorization: Bearer <CRON_SECRET>` (constant-time compare; 503 when `CRON_SECRET` is
unset or shorter than 32 characters). Vercel adds the header when `CRON_SECRET` is set in the
project. To run them elsewhere, call the URLs from any scheduler with that header (the scheduler's
environment holds `CRON_SECRET`; it is not in your interactive shell unless you export it):

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://maxx.example.com/api/cron/daily-sync
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://maxx.example.com/api/sync/midday
```

The daily sync records each step's result, skips optional steps when its time budget runs short
(recording why), and never lets an optional step fail the whole run. A cron retry never sends an
email twice (see [Email](#email)) and never sends a conversion twice.

## Manual tools

```bash
npm run sync:manual    # last 30 days from Meta
# rebuild the Acuity example's outcomes from the Acuity API
npx tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/backfill-acuity.ts
# placement/device breakdowns
npx tsx --tsconfig tsconfig.scripts.json scripts/backfill-breakdowns.ts
# fbclid-based paid-touch fallback links
npx tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/backfill-fbclid-fallback.ts
npx tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/regenerate-daily-reports.ts YYYY-MM-DD
# what the sync fetches, run through the real readers
npx tsx --tsconfig tsconfig.scripts.json scripts/diagnose-value-gate.ts
# validates stored paid-cohort rows against the schemas
npx tsx --tsconfig tsconfig.scripts.json scripts/audit-paid-cohort-rows.ts
```

Always pass `--tsconfig tsconfig.scripts.json`: server modules start with `import 'server-only'`, which
plain Node cannot resolve, and that config maps it to Next's no-op. Scripts without `--env-file` load
`.env.local` themselves. The three `backfill-*` scripts write to the database; `diagnose-value-gate`
and `audit-paid-cohort-rows` only read (the first caches its fetch locally); `regenerate-daily-reports`
refuses to run, because daily reports are committed only by a complete sync.

## Backups

Your Supabase database is the only copy of several things Maxx cannot rebuild:

- outcomes from CSV imports and webhooks, and their value and status history;
- your decisions, approvals, change requests and their audit records;
- paid-touch captures and links, and conversion delivery records.

Meta delivery data can be synced again from Meta (within Meta's own retention), so it matters less.

1. **Platform backups.** Supabase takes database backups according to your plan (see **Database →
   Backups** in your project). Confirm the schedule and retention fit you, and consider point-in-time
   recovery for a business-critical install.
2. **Your own copy.** A logical dump with the Supabase CLI, run from a machine you trust:

   ```bash
   read -rs SUPABASE_DB_URL
   npx --yes supabase@2.109.1 db dump --db-url "$SUPABASE_DB_URL" -f maxx-schema.sql
   npx --yes supabase@2.109.1 db dump --db-url "$SUPABASE_DB_URL" --data-only -f maxx-data.sql
   ```

   The first line reads the connection string (Project Settings → Database) without echoing it;
   setup never saves it, so it is not in `.env.local`.

   The data dump contains customer details sent by your outcome sources (`outcomes` holds names,
   emails and phone numbers when a webhook sends them). Encrypt it and store it like the service-role
   key.
3. **Test a restore** into a scratch project before you need it. A restore brings back the data as of
   the backup; run the daily sync afterwards to refresh Meta data.

## Upgrades

1. Read the release's entry in [CHANGELOG.md](../CHANGELOG.md), in particular anything marked as
   needing a migration or a configuration change.
2. Take a backup (above).
3. Update the code and dependencies:

   ```bash
   git pull
   npm ci
   ```

4. Apply new migrations. `supabase db push` applies only the migrations your database has not run
   (through the pinned CLI; give it the connection string from Project Settings → Database):

   ```bash
   SUPABASE_DB_URL="<connection string>" npm run setup -- --apply-schema
   ```

5. Deploy the application, then check it:

   ```bash
   npm run doctor
   ```

v1 ships a single baseline; databases created from pre-release migration chains are not upgradable by migration.
The baseline is `supabase/migrations/0001_baseline.sql`; it is regenerated only by
`scripts/db/squash-baseline.sh`, which proves the result equivalent before writing it.
Migrations in `supabase/migrations/` are applied in filename order and never edited after release;
a change is always a new migration. Deploy migrations and the matching application code together: a
release whose code expects a new column fails until its migration has run. If an upgrade goes wrong,
redeploy the previous release and restore the backup; there is no automatic down-migration.
Rollback material for the decision-generation tables is in `scripts/create-rollback-snapshot.sql`
and `scripts/rollback-flag-generation.sql`, rehearsed by
`tests/db/integration/rollback-rehearsal.test.ts`.

For a schema change of your own: add a migration under `supabase/migrations/`, replay it locally with
`scripts/sb.sh db reset`, and run `npm run verify:replay`.

## Rotating secrets

Rotate on any suspicion, when someone with access leaves, and on a schedule that suits you. After
changing a variable in your host, redeploy; `NEXT_PUBLIC_*` values need a rebuild. Generate internal
secrets with a strong random source:

```bash
openssl rand -hex 32
```

| Secret | Where to rotate | Effect while switching |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API keys | The app fails its database reads until the new key is deployed. Rotating the project's JWT signing secret also ends every session. |
| `CRON_SECRET` | Your host's environment (32+ characters) | Scheduled jobs answer 401 until the host and the scheduler use the same new value. |
| `PAID_TOUCH_TOKEN_SECRET` | Your host's environment (32+ bytes) | Tokens signed with the old secret no longer verify, so visitors captured before the switch are not linked. |
| Webhook source secrets | **Rotate secret** on `/settings/outcomes` (route `POST /api/outcomes/webhook-sources/<source_id>/rotate`; [outcomes.md](outcomes.md#2-rotate-the-secret)) | **No grace period**: the old secret stops verifying immediately; deliveries signed with it get 404 and must be re-sent. |
| `META_ACCESS_TOKEN` | Business Settings → System Users: generate a new token, then revoke the old one | Syncs fail until the new token is deployed. |
| `META_APP_SECRET` | The Meta app's Basic settings (reset the app secret) | With "Require App Secret" on, every Graph call fails until the new secret is deployed. |
| `META_CAPI_ACCESS_TOKEN` | Events Manager → the dataset's settings | Conversions fail and are retried by the daily sync within its window. |
| `ACUITY_API_KEY` | Acuity → Integrations → API | Also the key Acuity signs webhooks with: webhooks are refused until both sides use the new key. |
| `ACUITY_WEBHOOK_SECRET` | Your host's environment and the webhook URL in Acuity | Webhooks are refused until both match. |
| `GA4_SERVICE_ACCOUNT_JSON` | Google Cloud → the service account → Keys: add a key, deploy it, delete the old key | GA4 reads fail until the new key is deployed. |
| AI keys (`ANTHROPIC_API_KEY`, `ANTHROPIC_FOUNDRY_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, AWS or Google credentials) | The provider's console | AI features switch off (reports keep working) until the new key is deployed. |
| `CREATIFY_API_KEY` | Creatify | Video generation fails until deployed. |
| `GMAIL_SMTP_APP_PASSWORD`, `RESEND_API_KEY` | Google account App Passwords, or Resend | Emails fail and are retried on the next run. |
| `SENTRY_AUTH_TOKEN` | Sentry → auth tokens (build time only) | Source-map upload fails on the next build. |
| `SUPABASE_DB_URL` password | Supabase → Project Settings → Database | Used only by setup and your own scripts; never stored by Maxx. |

If the owner changes, create the new user, set `OWNER_EMAIL` and `OWNER_USER_ID`, redeploy, then
delete the old user in Supabase.

## Monitoring

- **Sentry:** set `SENTRY_DSN` (and `NEXT_PUBLIC_SENTRY_DSN` at build time) so request errors reach
  someone.
- **In the app:** Settings shows sync freshness and which integrations are configured, without
  revealing values; `/api/health` returns the same to the owner session; `/setup` runs every check.
- **From a machine:** `npm run doctor -- --json` prints one JSON document and exits non-zero when a
  check fails, so a scheduled job can alert on it. It needs the same environment as the app.
- **What to watch:** a daily sync that did not run or failed, an outcome source with no new outcomes
  for longer than your business normally goes without one, a reconciliation that cannot prove its
  window, and conversion sends stuck in error.

## The demo

```bash
npm run demo
npm run demo -- --port 4000
npm run demo:check
```

`npm run demo` starts four loopback servers (a sample backend over an in-memory database with the
shipped schema and a fictional seed, the app with Meta and AI off, a sample-media server for the
creatives' image, and a gateway that signs you in as the fictional owner) at http://127.0.0.1:3000.
Open that exact address: the gateway redirects http://localhost:3000 pages to it (the app accepts saves
only from that origin) and refuses a save sent to another host name. It uses ports 3000 to 3003; `--port` moves the gateway and the other three follow it (`--port 4000`
uses 4000 to 4003). When one of them is busy it stops before starting anything and names the port.
It sets every variable itself, so a real `.env.local` is never read, it never contacts Meta or an AI
provider (approvals run a simulated executor; a sync request is refused), and it refuses to start on Vercel or in production. `npm run demo:check` starts its own
demo on ports 3300 to 3303 (`npm run demo:check -- --port 4300` moves it), checks the pages, the
charts and the CSP in a headless browser, and stops it.

## Scaling notes

- **One owner, one ad account per install.** For several businesses or accounts, run several
  installs, each with its own Supabase project.
- **Report size:** report build time grows linearly with campaigns and days (measurements below), but
  the serialized report packet is large: at 50 campaigns × 90 days it exceeds the 64 MB limit for a
  saved report. A compact, versioned packet format is in progress.
- **Function time:** the daily sync runs on a serverless function with a time limit; optional AI
  steps are skipped, with the reason recorded, when time is short.
- **Request limits:** webhook sources accept 600 signed deliveries per minute each; CSV imports are
  limited to 60 previews and 30 imports per owner per hour, 4 MiB and 10,000 rows per file; the public
  paid-touch endpoint has a per-client and a global hourly cap.

## Incident basics

1. **Contain.** If a secret may have leaked, rotate it (table above). If live writes are on and
   anything looks wrong, set `WRITE_MODE_ENABLED` to anything but `true` and redeploy. To stop
   scheduled jobs, remove `CRON_SECRET` (the endpoints answer 503). To stop an outcome source, disable
   it at `/settings/outcomes` or rotate its secret.
2. **Look.** Sentry, your host's logs, the sync results in the app, and Meta's account activity log
   for ad-account changes. Logs name variables and codes, never secret values.
3. **Recover.** Redeploy a known-good release, restore a backup if data was damaged, run the daily
   sync, and confirm with `npm run doctor`.
4. **Report** a vulnerability in Maxx itself privately, as described in [SECURITY.md](../SECURITY.md).

## Report build performance

`scripts/bench/reporting-packet.ts` builds a Meta report packet in-process with the Graph API stubbed
(no network, no credentials), runs `validateReportingPacket` and `validateScopedReportingPacket` as the
stress tests do, serialises it and prints the
packet's sha256. It also encodes the stored form (packetVersion 2, below), prints its plain and gzip
size, and fails unless the expansion has the same sha256. Shapes are `campaigns x days`; `h` adds 3 ad sets x 3 ads per campaign and a selected
campaign history.

```bash
npx tsx --tsconfig tsconfig.scripts.json scripts/bench/reporting-packet.ts --shapes 12x28,50x90h --runs 3
# add --stages to split reader CPU into fetch, normalisation, claim construction and assembly
```

Measured 2026-11-07 on an Apple-silicon laptop, Node 24, with other work running. Times are the read
followed by the total (read + both validations + serialisation). Before is one timed run; after is the
median of three. Packet bytes and sha256 are identical before and after at every shape.

| Shape | Campaign-days | Packet | Before | After |
|---|---:|---:|---:|---:|
| 12x28 | 336 | 15 MB | 16.1 s / 17.8 s | 0.21 s / 0.50 s |
| 25x56 | 1,400 | 42 MB | 81.2 s / 85.4 s | 0.59 s / 1.32 s |
| 50x90 | 4,500 | 108 MB | 440.5 s / 475.4 s | 1.63 s / 3.53 s |
| 50x90h | 4,500 + 150 ad sets, 450 ads | 219 MB | 447.5 s / 480.0 s | 2.82 s / 8.06 s |
| 100x90h | 9,000 + 300 ad sets, 900 ads | 394 MB | not run | 4.44 s / 13.1 s |

Before, the build was super-linear: every claim window constructed an `Intl.DateTimeFormat`, every
campaign day built and validated the full ~120-claim catalogue to keep 8, and rows were filtered once
per entity. `tests/reporting-meta-scaling.test.ts` now fails if claims built, native-row reads or
validated claims stop scaling linearly in campaigns or days. The stub excludes real Graph latency and
pagination (the read session's own deadline is 80 s).

### Report packet format (packetVersion 2)

The plain (v1) packet repeats every claim in full wherever it appears: at 50x90h, 161,598 claim
objects (133,338 distinct IDs) are 197 MB of the 219 MB. Their per-metric fields (source, formula,
freshness, authority, availability, attribution scope, metric key, label, as-of, kind, setup
fingerprint, definition version, unit) are ~105 MB, the per-occurrence fields (window, comparison,
inputs, claim ID, coverage, maturity, entity, value) ~89 MB, and metric metadata (key, label,
definition, event) another 17 MB. Campaign series and comparison series are 42% of the bytes, ad
totals 31%.

New snapshots, refresh progress and live responses therefore use packetVersion 2
(`src/lib/reporting/packet-format.ts`, codec in `src/lib/reporting/compact-json.ts`): the complete v1
packet is stored as one table of distinct values, each written once and referenced by position;
claim and metric metadata share one tuple per metric, and colon-separated identifiers share their
segments. The top level repeats the fields storage triggers read (section, context, result state,
source time, notes, Meta detail state), and expansion refuses a packet whose repeated fields differ
from the packet. `expandPacket` returns JSON byte-identical to the v1 packet (the benchmark fails
otherwise), and every reader validates that expansion with the unchanged v1 validators. Expansion
checks the whole table (references only to earlier entries, arity, shapes) and refuses an expansion
above 500 MiB of JSON.

Stored v1 snapshots and progress are never rewritten: the reader dispatches on `packetVersion` and
reads v1 as before. Fingerprints cover the stored bytes, so a prepared reply sends a v2 packet exactly
as stored and the browser checks the fingerprint on it before using the expansion. Opened saved
reports carry their assembled data as `dataVersion: 2`; the saved data identity is checked on the
expansion, so it is unchanged. Packets are encoded from validated packets, whose key order is the
schema's, so the same evidence always produces the same stored bytes.

| Shape | v1 packet | v2 packet | v2 gzip | Encode | Expand |
|---|---:|---:|---:|---:|---:|
| 12x28 | 15.0 MB | 1.0 MB | 0.20 MB | 0.18 s | 0.06 s |
| 25x56 | 42.4 MB | 2.8 MB | 0.55 MB | 0.58 s | 0.17 s |
| 50x90 | 107.7 MB | 7.4 MB | 1.42 MB | 1.69 s | 0.61 s |
| 50x90h | 218.9 MB | 16.2 MB | 2.91 MB | 3.47 s | 1.21 s |

Sizes are bytes of the serialised packet (MB = 10^6); encode and expand are medians of three runs
measured with the same benchmark, 2026-11-07, with other work running. Every shape is under the
64 MB save cap; compression is relied on only for transfer. Residuals: validation still parses the
expanded packet in full on the server and in the browser (the same work and memory as a v1 packet of
that size), and a v1 packet already stored above the cap could never have been saved.

## Money: currency and arithmetic

**Currency.** Money is in the ad account's ISO 4217 currency (`ad_accounts.currency`, mirrored by
`NEXT_PUBLIC_ACCOUNT_CURRENCY`); owner screens format it in `NEXT_PUBLIC_ACCOUNT_LOCALE` (BCP 47, default
`en-US`) through `formatMoney` in `src/lib/utils/format-currency.ts`. Claims carry the unit `money`. The
economics and causal ledgers accept any upper-case ISO code but a trigger requires it to equal the account
currency, and causal materialization refuses a settlement or cost in another currency. Currencies are
never converted.

**Names.** No key, column or parameter is named after one currency. Stored report and evidence
documents carrying the old keys (`spendUsd`, `daily_usd`, ...), such as fingerprinted snapshots and saved
reports, are upgraded when read (`src/lib/outcomes/legacy-money-keys.ts`). Budget evidence names its amount
`majorUnits` (the native minor units in the account currency's major units: JPY 0 digits, KWD 3);
packets written before the v1 release keyed it `usd` beside `minorUnits` and are upgraded the same way when read. Text Maxx writes for you or for a
model prints money through `formatMoney`, never a literal currency sign.

**Arithmetic (decision).** Totals are IEEE-754 double sums. Exact decimal sums would change the
golden snapshots (`bookedValue: 7649.849999999994` is the double sum of the golden population; the exact
total is 7649.85), so floats are kept. Stored money has at most 15 integer and 6 fraction digits. Each
value converts to a double within u·|x| (u = 2^-53) and a left-to-right sum of n terms adds at most
(n−1)·u·Σ|x|, so a total is within n·u·Σ|x| of the exact decimal total. That is below half a minor unit h
whenever n·Σ|x| < h/u: 4.5e13 for a two-digit currency (h = 0.005), 4.5e12 for a three-digit one (for
example 100,000 outcomes totalling 100 million: 1e13). `tests/money-sum-bound.test.ts` checks totals
against exact BigInt sums at small, enterprise and large-ticket sizes, and shows the guarantee failing for
fifteen-integer-digit values outside the bound.

## Email

Daily digest and weekly executive email are delivered once per report per recipient through a
delivery ledger (`daily_digest_delivery_attempts`, `weekly_executive_delivery_attempts`), so a cron
retry can never send twice. Gmail clips messages near 100 KB; the renderer stays under that.
