# Ad platforms

Maxx supports **Meta** (Facebook and Instagram) today. Core code reaches it only through an
ad-platform interface, so another platform can be added as a second implementation instead of a
rewrite. This page describes the interface, its current limits, and the steps to add a platform.

## The interface

`src/lib/platforms/types.ts` declares `AdPlatform`: only the operations the code actually calls,
grouped by capability. `budgetUnits` (the platform's integer budget units) and `isApiError` are also
required.

| Group | Required | Operations |
|---|---|---|
| `records` | yes | map the platform's wire records into the neutral shapes (see [Record shapes](#record-shapes)) |
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

## Which platform an account uses

Each ad account records its platform in `ad_accounts.platform` (migration `0003_ad_account_platform.sql`):
`NOT NULL`, default `'meta'`, and a `CHECK` that lists exactly the registered platform ids. Core code
resolves the platform from the account through one helper, `adPlatformForAccount` in
`src/lib/platforms/account-platform.ts` (with `loadAccountPlatform(db, accountId)` and
`loadActiveAccountPlatform(db)` reading the column first). It fails closed: an unregistered, missing or
malformed value throws `UnknownAdPlatformError`; nothing falls back to Meta.

The account may also record its country, `ad_accounts.country` (ISO 3166-1 alpha-2, optional). When it is
set, the default phone calling code for conversions matching comes from it
(`phoneCallingCodeFor` in `src/lib/capi/phone.ts`); when it is null, `CONVERSIONS_PHONE_COUNTRY_CODE`
decides, as before. Nothing fills the column automatically. The Acuity reference adapter's own sender
still reads the configured code only.

A few places still name Meta on purpose, each with a comment saying why:

- **The governed write path** (`src/lib/writes/write-preconditions.ts`) validates Meta entity ids, account
  ids and snapshots. Its entry gate, `resolveWriteTargetContext`, resolves the target account's platform
  and refuses any account that is not Meta before any read or write.
- **The reporting packet's `meta` section** (`src/lib/reporting/loader.ts`): the packet contract has a
  section named for Meta with a Meta-shaped schema.
- **The setup/doctor connection check** (`src/lib/setup/network-checks.ts`) checks the `META_*`
  configuration, which exists before any account row.
- **The launch diagnosis's pure builder** (`src/lib/diagnostics/launch-performance.ts`) looks up an event
  in Meta dataset stats; its loader reads those stats through the account's platform.
- **The reporting benchmark script** (`scripts/bench/reporting-packet.ts`) measures Meta's reader offline.

## Record shapes

`src/lib/platforms/records.ts` defines the platform-neutral shapes core code can rely on for any
platform: `PlatformCampaign`, `PlatformAdSet`, `PlatformAd`, `PlatformCreative` and `PlatformInsightRow`
(ids, names, normalised status and the platform's own delivery status, budgets, spend, impressions,
reach, frequency, clicks and link clicks). Money is in major units of the account currency; a value the
platform did not report is `null`, never 0. Platform-modelled conversions are deliberately not in the
neutral shapes: they depend on each platform's attribution windows and event names.

Every platform implements the required `records` group, which maps its own wire records into those
shapes inside its module (Meta: `src/lib/platforms/meta/records.ts`). The entity and insight operations
still return each platform's wire records (`CampaignRecord`, `InsightRecord`, … are Meta's today), because
the warehouse ingest (`src/lib/sync/upsert-*.ts`) and the `daily_insights` columns follow Meta's fields,
including its modelled results. That ingest is the largest piece of Meta-specific core left.

## Current limits

- **The warehouse follows Meta.** The sync's upsert modules and table columns read Meta's wire fields
  (for example Meta's conversion action names in `daily_insights`).
- **`ad_accounts.account_id` is unique on its own**, not per platform, and the sync upserts on it.
- **One ad account per install**, matching the single-owner model.

## What a second platform must implement

1. **Open an issue first** with the platform, the capabilities you intend to implement, and how its
   numbers map to Maxx's evidence kinds (delivery, platform-modelled conversions). See
   [CONTRIBUTING.md](../CONTRIBUTING.md).
2. **Add the platform id** to `AdPlatformId` in `src/lib/platforms/types.ts`, implement `AdPlatform` in
   `src/lib/platforms/<id>/`, and register it in `PLATFORMS` in `src/lib/platforms/registry.ts`.
   Required: `budgetUnits`, `isApiError`, `entities`, `insights` and `records` (the mapping into the
   neutral shapes, tested with offline fixtures of the platform's wire format). Implement only the
   optional groups the platform really supports; `requireCapability` refuses the rest.
3. **Widen the database:** a new migration that adds the id to `ad_accounts_platform_check`, and, before
   two platforms can share an install, makes `ad_accounts.account_id` unique per platform (and moves the
   sync's `onConflict` with it).
4. **Generalise the entity and insight record types** in `types.ts` where the new platform's wire shapes
   differ, and move the warehouse ingest (`src/lib/sync/upsert-*.ts`) onto the neutral records or onto a
   per-platform ingest. Keep the existing golden tests green: a change to a money or count output needs an
   explicit, reviewed justification.
5. **Extend the boundary rule:** add the platform's API hosts to `tests/platform-boundary.test.ts`, so they
   may appear only inside `src/lib/platforms/<id>/`.
6. **Replace the named-Meta places above that the platform needs:** its own governed write path (or a
   generalised one) before `resolveWriteTargetContext` may accept it; its own reporting section in the
   packet contract (`src/lib/reporting/contracts.ts`); its own setup check.
7. **Conversions:** implement `conversions` so it builds the platform's own event for an outcome (using the
   `phoneCallingCode` core passes) and resolves its own credentials; core
   `src/lib/conversions/outcome-conversions.ts` only gates, records and labels.
8. **Configuration:** add the platform's variables to `src/config/env-vars-*.ts` (secret flags, formats,
   setup prompts), run `npm run env:docs`, and implement `connectionCheck` so `npm run doctor` and `/setup`
   can verify the token, permissions, timezone and currency.
9. **Attribution label:** show the platform's own attribution window beside its modelled conversions, as
   Meta's is (`src/lib/platforms/meta/attribution.ts`), and keep them labelled as platform estimates.
10. **Tests first:** extend `tests/ad-platform-registry.test.ts` (delegation of every operation, capability
    flags, refusal of an unsupported capability), add record-mapping fixtures like
    `tests/platform-neutral-records.test.ts`, and run `npm run gate`.

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
