# Changelog

All notable changes to Maxx are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Maxx uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): the public surface is the environment
variables, the database schema, the HTTP API, the webhook and CSV contracts, and the MCP tool names.

## [1.0.0] - 2026-11-09

The first public release. Maxx began as a private tool built for one appointment-based business, with
its bookings coming from one scheduling system. This release turns it into a product any business can
self-host. Compared with that private tool:

### Added

- **Owner-approved changes** at Changes: turn a current Maxx decision into a change (pause or
  activate an ad, set an ad set's daily budget, or duplicate an ad set as paused), approve and apply
  it in one click, and roll it back. Writes need `WRITE_MODE_ENABLED`, run one at a time per account,
  cap budget steps at `MAX_BUDGET_CHANGE_PERCENT`, and a stuck run can be recovered
  ([ADR-059](docs/architecture/adr-059-owner-initiated-changes.md)).
- **Copy studio** at Creative → Copy: ad copy variants written by your configured AI provider, each
  scored 0 to 100 by a deterministic scorer (which also works with AI off), saved to a copy bank
  ([ADR-061](docs/architecture/adr-061-ai-copy-engine.md)).
- **Campaign plans:** a brief becomes a versioned campaign, ad set and ad plan; after approval Maxx
  creates it in Meta **paused**, marks every object it created, and never touches objects it did not
  create ([ADR-062](docs/architecture/adr-062-campaign-plans.md)).
- **Ask Maxx actions:** the chat can write copy variants, draft a campaign plan and propose a change,
  each landing as a draft you approve; answers lead with a summary.
- **Generic business outcomes.** Results are outcomes of any type (`lead`, `booking`, `sale`,
  `signup`, `quote`, `subscription`, `custom`) with a status, an origin, exact decimal values where
  "not observed" (NULL) is never 0, and a business date in the account timezone
  ([docs/outcomes.md](docs/outcomes.md), ADR-058).
- **Outcome source adapters** with a declared capability contract and a registry. Readers count only
  enabled sources; push-only sources count as received; reconciled sources must prove their window is
  complete. Sources are switched on and off at Settings → Outcome sources.
- **Signed outcome webhook** (`/api/outcomes/webhook/<source_id>`): per-source secrets shown once,
  `x-maxx-signature` HMAC-SHA256 over timestamp and body, a 5-minute tolerance, replay protection, a
  strict payload schema, an optional sender event id and `updated_at` ordering, and per-source rate
  limits. Signing examples in Node.js, Python and curl are tested against the verifier.
- **CSV import** with a dry-run preview, an all-or-nothing commit, an audit record, and idempotent
  re-imports (the same file twice gives identical counts).
- **Conversions by outcome type** (`Lead`, `Purchase`, `Schedule`, `CompleteRegistration`): only
  confirmed website outcomes, sent once and never retracted, never mirroring an event the source
  already sends (`OUTCOME_CONVERSIONS_SEND`, off by default).
- **AI gateway** with the Anthropic SDK family (Claude API, AWS Bedrock, Google Vertex, Microsoft
  Foundry) and an OpenAI-compatible adapter, provider and model from configuration, and an AI-off
  mode in which every page and report renders with no model call ([docs/ai.md](docs/ai.md)).
- **Ad-platform interface** with Meta as the first implementation and a boundary test that keeps Meta
  API calls inside the Meta module ([docs/platforms.md](docs/platforms.md)).
- **Install experience:** one validated environment schema (`src/config/env.ts`) with generated
  documentation; `npm run setup` (interactive, re-runnable, validates every value, applies the schema,
  creates the owner); `npm run doctor` (read-only checks, `--json`, `--offline`, `--live`); an in-app
  setup checklist at `/setup` with a connection test per integration; `npm run demo` (the full product
  on sample data with no accounts); and a Deploy to Vercel button.
- **Any currency, configurable locale:** timezone and currency come from configuration and must equal
  the ad account's (a mismatch is refused); money may be in any ISO 4217 currency, never converted,
  with the account currency enforced in the database; `NEXT_PUBLIC_ACCOUNT_LOCALE` sets formatting.
  Money totals are floating-point sums with a documented error bound.
- Documentation set: install guide, outcomes reference, how Maxx decides, AI, platforms, operations
  (backups, upgrades, secret rotation, incidents), third-party notices, and a docs smoke test that
  checks every documented command, variable, link and route in CI.

### Changed

- The database starts from one baseline schema plus forward migrations instead of the private
  tool's long migration history; the booking-specific tables became the generic outcome tables.
- Readers, economics, reporting, the cockpit and the MCP tools use outcome vocabulary (claim source
  `outcomes`, evidence plane `outcome_business`, metric keys `outcomes.*`); the MCP
  `get_outcomes` and `get_outcomes_by_label` tools replace the booking-specific ones.
- The scheduling-system integration is now the optional Acuity Scheduling example adapter, off unless
  its credentials are set.
- Report packets build in linear time: a 50-campaign, 90-day report with ad sets and ads went from
  about 8 minutes to about 8 seconds with byte-identical output, guarded by a scaling test.
- Owner emails render with React's server renderer instead of a deprecated email library.

### Removed

- The booking-specific MCP tool `get_acuity_bookings` (a deprecated alias, `get_bookings_by_type`,
  remains for one release).
- Business-specific data: the original business profile, competitor seed, benchmarks and target
  ranges are fictional placeholders you replace with your own.

### Fixed

- `record_conversion_delivery` serializes concurrent writers for one outcome (migration 0002), so
  racing first deliveries merge into one row instead of failing on the (outcome, platform) key.

### Security

- Session cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in production and expire after 7 days of
  inactivity; sign-out is a same-origin `POST` that revokes the session.
- The owner gate requires a confirmed email and can be pinned to one user id (`OWNER_USER_ID`);
  setup and doctor check that public sign-ups are disabled and email confirmation is on.
- A nonce-based Content Security Policy is set per request, with no `'unsafe-inline'` scripts in
  production.
- Browser-facing database roles hold no privileges and every table has Row Level Security; a leaked
  anon key reads nothing.
- The Meta access token is redacted from stored and displayed Ad Library snapshot URLs.
- Model output renders without images or raw HTML; untrusted third-party text is fenced in prompts;
  structured model output is schema-validated.
- API routes and MCP tools return generic messages with stable codes instead of database or provider
  text.
- Cross-site mutations are refused; the public paid-touch endpoint has per-client and global caps.
- See [docs/security-model.md](docs/security-model.md) for the model and its accepted residuals.

[1.0.0]: https://github.com/geovannig1/maxx-ai-media-buyer/releases/tag/v1.0.0
