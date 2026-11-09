# Ad platforms

Maxx supports **Meta** (Facebook and Instagram) today. Core code reaches it only through an
ad-platform interface, so another platform can be added as a second implementation instead of a
rewrite. This page describes the interface, its current limits, and the steps to add a platform.

## The interface

`src/lib/platforms/types.ts` declares `AdPlatform`: only the operations the code actually calls,
grouped by capability.

| Group | Required | Operations |
|---|---|---|
| `entities` | yes | account, campaigns, ad sets, ads, creatives, custom audiences |
| `insights` | yes | daily insights; period delivery totals |
| `pacing` | no | today's spend by campaign; active campaign and ad set budgets |
| `breakdowns` | no | placement, device and similar breakdowns (fetch and store) |
| `daypart` | no | hour-of-day delivery (fetch and store) |
| `conversions` | no | server-side conversion events (build an outcome's event, test code, credentials, destination, send, interpret, record) |
| `writes` | no | read an entity, read active budgets, apply an approved change |
| `adLibrary` | no | public competitor ads |
| `trackingHealth` | no | pixel status |
| `datasetDiagnostics` | no | event volume and quality |
| `recommendations` | no | the platform's own recommendations |
| `deliveryEstimate` | no | audience delivery estimate |
| `connectionCheck` | no | token, permissions and account check used by `npm run doctor` and `/setup` |
| `reporting` | no | the advertising section of the reporting packet (delivery, inventory, breakdowns) |

`src/lib/platforms/registry.ts` holds the implementations:

- `getAdPlatform(id)` returns a platform or throws `UnknownAdPlatformError`; there is no silent
  default.
- `capabilitiesOf(platform)` derives the capability flags from the groups the platform implements,
  so the flags cannot drift from the code.
- `requireCapability(platform, group)` returns that group's operations or throws
  `UnsupportedCapabilityError` naming the platform and the capability. Callers show the refusal; they
  never pretend the data is empty.

The Meta implementation is `src/lib/platforms/meta/index.ts`, forwarding to the modules beside it.
`tests/platform-boundary.test.ts` enforces the boundary: no Meta API host (`graph.facebook.com` and its
siblings) appears in `src/` or `scripts/` outside `src/lib/platforms/meta/`, and nothing outside
`src/lib/platforms/` imports the Meta modules, except two pure vocabulary modules and a short,
commented list of inherently Meta-specific modules.

Live writes go through `writes` only from the change executor, after its write-mode and approval
gates ([how-maxx-decides.md](how-maxx-decides.md#4-changes-to-the-ad-account)).

## Current limits

These are known and deliberate for v1; each is a step in the guide below.

- **Records are Meta-shaped.** The record types (`CampaignRecord`, `InsightRecord`, …) are Meta's wire
  shapes under neutral names. A second platform must either map into them or, better, generalize
  them first.
- **Ad accounts have no platform column.** Every account is a Meta account, so core callers ask for
  `getAdPlatform('meta')` explicitly (33 calls in 15 files) rather than reading the platform from
  the account.
- **The database columns and metric names follow Meta** (for example Meta's conversion action names in
  the daily insights table).
- **One ad account per install**, matching the single-owner model.

## Adding a second platform

1. **Open an issue first** with the platform, the capabilities you intend to implement, and how its
   numbers map to Maxx's evidence kinds (delivery, platform-modelled conversions). See
   [CONTRIBUTING.md](../CONTRIBUTING.md).
2. **Generalize the record types** in `src/lib/platforms/types.ts` where the new platform's shapes
   differ, keeping Meta's mapping behind its implementation. Keep the existing golden tests green:
   a change to a money or count output needs an explicit, reviewed justification.
3. **Add the platform id** to `AdPlatformId` and implement `AdPlatform` in
   `src/lib/platforms/<id>/`. `entities` and `insights` are required; implement only the optional
   groups the platform really supports, and let the rest be refused by `requireCapability`.
4. **Register it** in the `PLATFORMS` table in `src/lib/platforms/registry.ts`.
5. **Extend the boundary rule:** add the platform's API hosts to `tests/platform-boundary.test.ts`, so
   they may appear only inside `src/lib/platforms/<id>/`.
6. **Record the platform on the account:** add a platform column to the ad-account table in a new
   migration, then replace the explicit `getAdPlatform('meta')` calls with the account's platform.
7. **Implement the reporting capability:** Meta's readers live in `src/lib/platforms/meta/reporting/`
   and map Graph fields into the report packet; a second platform maps its own fields into the same
   packet contract (`src/lib/reporting/contracts.ts`). Likewise `conversions` builds the platform's
   own event for an outcome and resolves its own credentials; core
   `src/lib/conversions/outcome-conversions.ts` only gates, records and labels.
8. **Configuration:** add the platform's variables to the schema in `src/config/env-vars-*.ts` (secret
   flags, formats, setup prompts), run `npm run env:docs`, and implement `connectionCheck` so
   `npm run doctor` and `/setup` can verify the token, permissions, timezone and currency.
9. **Attribution label:** show the platform's own attribution window beside its modelled conversions,
   as Meta's is (`src/lib/platforms/meta/attribution.ts`), and keep them labelled as platform
   estimates, never outcomes.
10. **Tests first:** extend `tests/ad-platform-registry.test.ts` (delegation of every operation,
    capability flags, refusal of an unsupported capability), add fixtures for the new wire shapes
    with no network, and run `npm run gate`.

A second platform is out of scope for v1 itself; the interface exists so it can be added without
touching the evidence and authority rules.

## Meta Ad Library: what Meta returns

Competitor discovery reads Meta's public Ad Library API (`ads_archive`). **Meta's API returns only ads
about social issues, elections or politics, plus ads delivered in the EU and the UK.** Commercial ads
shown elsewhere are visible on Meta's Ad Library website but not through the API. The fetcher asks
for ads reached in the countries of `META_AD_LIBRARY_COUNTRIES` (ISO 3166-1 alpha-2 codes, for example
`DE,AT`); unset, it uses the ad account's business country as Meta reports it, or `US` when Meta
reports none. For a commercial competitor outside the EU and the UK it usually returns nothing. That
is a limit of Meta's API, not something configuration can change: you can add competitors to watch,
but their ads appear only when Meta's API returns them.
