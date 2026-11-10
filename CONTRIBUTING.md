# Contributing to Maxx

Thanks for considering a contribution. Maxx is small and opinionated; please read this page before
opening a pull request so your work lands quickly.

## Ground rules

- **Money, counts and attribution stay deterministic.** A language model may suggest a hypothesis;
  it never computes a metric, decides an attribution or authorizes a change.
- **Separate the sources.** Business outcomes are business truth, GA4 is web telemetry, Meta numbers
  are platform-reported estimates. Do not sum them, blend them, or label one as another.
- **Fail closed.** Unset secrets, missing configuration and partial data produce an explicit
  "unavailable", never a silent zero. NULL means not observed; 0 means an observed zero.
- **No live writes by default.** Anything that changes the ad account must go through the
  change-request flow and respect `WRITE_MODE_ENABLED`.

[docs/how-maxx-decides.md](docs/how-maxx-decides.md) explains these rules in full.

## Development setup

You need Node.js 24 and npm. Docker and the Supabase CLI are needed only for the real-Postgres
tests.

```bash
git clone https://github.com/geovannig1/maxx-ai-media-buyer.git maxx
cd maxx
npm ci
npm run demo
```

The demo runs the app on sample data with no accounts. To work against your own data, follow
[docs/install.md](docs/install.md) (`npm run setup`, then `npm run dev`).

## The gate

```bash
npm run gate
```

`npm run gate` is what CI runs on every pull request, with no secrets: lint, the app and MCP type
checks, unit tests, PGlite database tests and a production build. CI also runs `npm run demo:check`
in its own job: it starts the sample-data demo, requests the main pages and APIs and renders the
dashboard in headless Chromium. To run it locally, install the browser once with
`npx playwright install chromium`. The unit tests include the docs
smoke test (`tests/docs-smoke.test.ts`), so a documented command, variable, link or route that does
not exist fails the gate.

`npm run gate:full` adds a migration replay and real-Postgres proofs. It needs Docker and the
Supabase CLI and **drops and rebuilds the public schema of your local database**, so nothing runs it
for you.

Run `npm run gate` on a third-party pull request only in a checkout that has no `.env.local`: the
production build reads that file, so build-time code in the change could read your secrets.

## Tests

- **Test first.** For a behaviour change, write a test that fails on the current code, then make it
  pass. For a fix, the test reproduces the bug.
- **Every check needs a control.** A test that accepts a good case must also reject a relevant bad
  one (a planted violation, a mutated input), so it cannot pass vacuously.
- **Goldens are never updated with `-u`.** `tests/golden/` freezes money, count, deduplication and
  conversions semantics. If a golden snapshot changes, that is a semantic change: justify it in the
  pull request and the relevant decision record, and update the snapshot deliberately, never to make
  CI green.
- **No network in tests.** Inject `fetch` or stub it, and use the PGlite schema (`npm run test:db`)
  for database behaviour. Tests must pass offline and without credentials.
- **Fixtures are fictional.** Use the example business, `example.com` or `example.test` hosts and
  synthetic ids. Never paste real account ids, customer data or tokens.
- Unit tests: `npm test` (watch: `npm run test:watch`). Database tests: `npm run test:db`.
- Mutation testing: `npm run mutate` and `npm run mutate:check` mutate source files and restore them
  from git, so both refuse to run while a file they would touch has uncommitted changes. Commit or
  stash first.
  Integration proofs: `npm run test:db:integration` (Docker). End to end: `npm run test:e2e`.

## Secrets and private data

CI scans the full history with gitleaks. The maintainers' pre-commit check also rejects an added
line that assigns a quoted value of 12 or more characters to a name such as `secret`, `token`,
`password` or `api_key` (pattern: `(?i)\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*['"][^'"]{12,}['"]`),
so please keep your changes clear of it too. In code and documentation examples, use a placeholder
such as `<your-webhook-secret>` or read the value from an environment variable. Never bypass a hook to
land a change.

## Style

TypeScript strict mode, ESLint (`npm run lint`), no default exports in `src/lib`, small focused files
and functions, comments that say why rather than what. Keep user-facing copy plain and free of
business-specific assumptions; anything specific belongs in configuration or the business profile.

Database migrations in `supabase/migrations/` are applied in filename order and never edited after
they land on `main`; add a new migration instead. Row Level Security is enabled on every table; new
tables must enable it and grant only what the service role needs.

## Commit messages

Conventional prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`. Say
what changed and why in the body, and how it was verified.

## Workflow

1. Open an issue first for anything larger than a bug fix, so the design can be agreed.
2. Fork, branch from `main`, and keep the change focused: one concern per pull request.
3. Add or update tests and documentation.
4. Run `npm run gate`.
5. Fill in the pull request template: what changed, why, how it was verified, and what a reviewer
   should look at first.

## Proposing an outcome adapter or an ad platform

Open an issue before writing code.

- **Outcome adapter:** first check whether a small relay that sends signed webhook deliveries would
  do; it usually does. If an adapter is needed, describe the system, how outcomes arrive (push, pull,
  backfill), and its honest capabilities (can it carry an ad-click token, does it know whether a
  result came from the website). Follow [docs/outcomes.md](docs/outcomes.md#writing-a-new-adapter).
- **Ad platform:** describe the capabilities you will implement and how the platform's numbers map to
  Maxx's evidence kinds. Follow [docs/platforms.md](docs/platforms.md#adding-a-second-platform).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
