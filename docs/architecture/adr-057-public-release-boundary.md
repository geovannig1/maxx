# ADR-057: Public release boundary

**Status:** accepted. **Date:** 2026-10-21.

## Context

Maxx was built privately for one business. The private repository holds that business's ad
identifiers, booking records, decisions and economics alongside the product code. Releasing it as
open source required deciding what the public project is and what it deliberately is not.

## Decisions

1. **Fresh repository, single initial commit.** History from the private project carries commit
   headers, business narratives and raw evidence that cannot be sanitized reliably. The public
   repository starts from a sanitized export; the private repository stays private as one
   deployment of the tool.
2. **Business facts are configuration.** Everything specific to a business (name, city, timezone,
   URLs, differentiators, pricing, budget ceiling, competitor seed) lives in `src/config/` and is
   overridden by environment variables. Source files contain a fictional example business used by
   tests.
3. **Single-owner, single-account scope.** The authorization model is an owner-email gate over a
   service-role database connection. Multi-tenancy would be a different product; it is out of scope
   and documented as such rather than half-built.
4. **Acuity is the supported booking provider.** The ledger, webhook, CAPI and paid-touch linking
   are Acuity-shaped. A provider abstraction is welcome as a contribution but is not a release
   blocker.
5. **Knowledge corpus ships with provenance.** Paraphrased platform guidance and cited practitioner
   material stay in the repository; account-specific notes are labeled as notes about the example
   account. Raw platform data exports never ship.
6. **No secrets, no owner-only CI.** Continuous integration runs lint, typecheck, unit, database
   and build checks without secrets; owner-side release acceptance (authenticated end-to-end and
   pinned evaluation) stays with each deployment.

## Consequences

Users must supply their own credentials and a business profile. Contributors can run the full gate
locally and in CI without access to any account. Features that depend on one business's history
(the champion benchmark, seeded competitors, default target ranges) are placeholders until an
operator fills them from their own data.

## Alternatives considered

| Alternative | Why it was rejected |
|---|---|
| Flip the private repository to public | Publishes every branch (including raw evaluation evidence), every pull-request description, and every commit header carrying a personal email. None of that can be withdrawn once cached. |
| Rewrite history with `git filter-repo` and keep the commits | Still requires rewriting author headers, stripping trailers, purging GitHub caches through support, and hand-auditing hundreds of commit messages that narrate one business's decisions. The code at `main` is the product; the narrative is not. |
| Publish only `src/` as a library | The product is the application plus its 139 migrations, cron jobs, webhook and MCP server. Without them the code has no runnable value and the security model cannot be documented honestly. |
| Build multi-tenancy before release | Would replace the authorization model (service-role plus owner gate) with row-level ownership across 98 tables. Months of work with new risk; the single-owner model is honest and safe for self-hosting, which is the declared scope. |
| Strip the knowledge corpus and playbooks | They are the part of the tool that encodes media-buying judgment. Provenance was verified (vendored material is MIT-licensed; cited sources are public); account-specific notes were relabeled as notes about the example account. |
| Keep the original competitor seed, champion benchmark and default target ranges | They are one business's market research and history. Shipping them would mislead other operators and expose third-party businesses; they are now placeholders an operator fills from their own data. |

## What this boundary does not solve

- Operators must do their own hardening (owner email, sign-ups off, write mode off); the code cannot
  enforce choices made in a Supabase or Vercel console. `scripts/doctor.ts` reports them.
- The browser-side tracking scripts under `docs/tracking/` run on an operator's own website and
  must be reviewed by them before installation.
- Meta Platform Terms govern any data an operator pulls through the API; the repository ships no
  platform data, and operators are responsible for their own retention and sharing.
