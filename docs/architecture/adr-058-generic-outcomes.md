# ADR-058: Generic outcomes layer

Status: accepted 2026-11-07. Supersedes the booking-specific parts of ADR-054 and ADR-056.

## Context

Maxx judges ads against a business's real results. Until now those results were appointments from
one scheduling system (Acuity): eleven appointment tables, eight foreign keys into
`acuity_appointments`, and booking vocabulary in about a third of the source files. A shop, a SaaS
product or a service business with a CRM could not use the core value. The correctness rules around
those results (no zero for unknown, coverage denominators, send-once conversions, money authority
gates) are business-neutral and must survive the change unchanged.

## Decision

### Domain model

- **`outcome_sources`** — `id`, `ad_account_id`, `kind` (`csv`, `webhook`, `acuity`, …), `enabled`
  (default false), `config` (no secrets; names the environment variable that holds one),
  `source_head`, `last_success_at`.
- **`outcomes`** — one row per business result:
  - identity: `id uuid`, `ad_account_id`, `source_id`, `external_id`, unique per
    (account, source, external id);
  - kind: `outcome_type` (`lead`, `booking`, `sale`, `signup`, `quote`, `subscription`, `custom`)
    and `outcome_label` (product, service or appointment type);
  - time: `occurred_at` (the conversion instant; attribution and conversions `event_time`),
    `business_date` (computed in the account timezone), optional `fulfilment_at`,
    `fulfilment_minutes`, `fulfilment_status` (`scheduled`, `fulfilled`, `no_show`);
  - lifecycle: `status` (`pending`, `confirmed`, `cancelled`, `refunded`), `status_changed_at`;
  - money: `currency char(3)`, `gross_value numeric`, `collected_value numeric` (exact decimals, as
    today; converting to integer minor units would impose a rounding rule the current code never
    applies, which the golden tests would rightly reject). Processor settlement keeps its
    minor-unit ledger. **NULL means not observed; 0 means observed zero.** Totals across currencies
    are refused;
  - origin: `website`, `staff_or_manual`, `unknown`;
  - customer: `customer_key` = HMAC of the normalized email under a per-install salt;
  - diagnostics and lineage: `attribution_token`, `utm_*`, `fbclid`, `landing_page`, `referrer`,
    `raw`, `observation_source`, `initial_*`, `first_seen_at`.
- **`outcome_contacts`** — optional PII, service role only.
- **`outcome_observations`** — append-only value and status history (generalizes the appointment
  observation trigger and the amount-paid observations).
- **`outcome_touch_links`** (keeps the touch-before-outcome check), **`conversion_deliveries`**
  (with `platform`), **`paid_outcome_*`**, **`causal_outcome_*`**; settlement and variable-cost rows
  reference `outcome_id`.
- **`v_business_outcomes`** replaces the appointment business view with the same business-state and
  web-origin logic.

| Former concept | Generic field |
|---|---|
| price | `gross_value` |
| amount paid | `collected_value` (same coverage rules) |
| booking created / booking date | `occurred_at` / `business_date` |
| appointment time | `fulfilment_at` |
| cancelled | `status = cancelled` |
| refund | `refunded`, from the processor settlement ledger only |
| reschedule | same `external_id`, same row |
| cancel and rebook | two rows, one cancelled |
| first vs repeat customer | window over `customer_key` ordered by `occurred_at` |

### Source adapters

```ts
interface OutcomeSourceAdapter {
  kind: string
  capabilities: { pull: boolean; push: boolean; backfill: boolean; carriesToken: boolean
    originKnown: boolean; collectedValue: boolean; platformNativeEvents: string[] }
  validateConfig(env, config): Result<void>
  verifyPush?(req: { rawBody: string; headers: Headers; url: URL }): Promise<VerifyResult>
  parsePush?(rawBody: string): PushEnvelope[]
  fetchById?(externalId: string): Promise<NormalizedOutcome | null>
  pull?(w: { start: string; endExclusive: string }): Promise<{ rows: NormalizedOutcome[]
    windowBasis: 'occurred_at' | 'fulfilment_at'; truncated: boolean }>
  backfill?(w): AsyncIterable<NormalizedOutcome[]>
  health(): Promise<SourceHealth>
}
```

The core, not adapters, owns upsert, observations, touch linking, conversions eligibility, ledger
health and the link-evaluation ledger. Code lives in `src/lib/outcomes/` (model, store, facts,
registry) with adapters in `src/lib/outcomes/adapters/{csv,webhook,acuity}/` and one push route,
`/api/outcomes/webhook/[sourceId]`.

- **CSV** — authenticated upload; idempotent on `external_id`; origin `unknown`, so never sent to Meta.
- **Generic webhook** — header `x-maxx-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`,
  5-minute tolerance, replay protection on (source, delivery id), body validated against
  `NormalizedOutcome`.
- **Acuity (example)** — off unless enabled and its credentials are set. Keeps its event id format
  so it still deduplicates against an existing pixel copy.

### Website touch capture and Meta conversions are general

Any business with a website, Meta ads and a place to carry a token (hidden form field, checkout
metadata, CRM field) can use touch capture. Conversions sending applies to outcomes with origin
`website`. The event name maps by outcome type (lead → Lead, sale → Purchase, booking → Schedule,
signup → CompleteRegistration); an adapter's `platformNativeEvents` lists events the source already
sends, which Maxx never mirrors. "Send once on first confirmation, never on a status change" stays a
core rule.

### Schema history

The public repository starts from one baseline migration produced by replaying the forward
migrations and dumping the resulting schema, including policies, grants and revokes. Historical
migrations are not shipped. Existing private deployments upgrade with the forward migrations, not
the baseline.

## Consequences

- Fresh installs contain no appointment or Acuity tables; enabling the Acuity example creates rows in
  the generic tables only.
- With no outcome source enabled, every report states "no outcome source" rather than zero.
- Tests that loaded historical migration files load the baseline; tests whose only subject was an
  upgrade path are removed.
- Sources that cannot carry an attribution token count against linkage coverage, so they can never
  unlock money authority by being left out of the denominator.

## Implementation notes

- The adapter contract lives in `src/lib/outcomes/adapter.ts`; `verifyPush` takes the source's secret
  as an argument (it is resolved from the database by the route, never held by the adapter) and is
  synchronous. The Acuity webhook keeps its URL (`/api/webhooks/acuity`) so existing Acuity
  configurations keep working; only generic sources use `/api/outcomes/webhook/[sourceId]`.
- Webhook replay protection keys on the signature digest (the timestamp is inside it), claimed before
  the write and released if the write fails. A webhook delivery is the source's full current state.
- Owner-only `POST /api/outcomes/webhook-sources` creates a source (disabled unless asked) and returns
  its secret once; `POST /api/outcomes/webhook-sources/[id]/rotate` replaces it and returns it once.
- Conversions for non-Acuity sources: event id `maxx-<outcome uuid>`, gated by
  `OUTCOME_CONVERSIONS_SEND` (off | test | true) independently of `ACUITY_CAPI_SEND`, sent only on an
  outcome's first confirmation, retried by the daily sweep within 46 hours, never after. A source's
  `config.platformNativeEvents` adds to its adapter's list. The Acuity sender is unchanged; its event
  name agrees with the shared mapping through the adapter's `conversionEventNames` override.

## Implementation notes

- CSV column contract: `src/lib/outcomes/adapters/csv/contract.ts` (rendered on `/settings/outcomes/import`).
  Required: `external_id`, `outcome_type`, `status`, `occurred_at`; unknown columns are refused. Money is
  an exact decimal string (empty = NULL, `0` = observed zero); a date alone is the start of that day in
  the business timezone; a time needs `Z` or an offset. Customer columns are not accepted.
- A CSV row's `origin` is stored as stated, but never as an observed origin (`origin_observed_at` stays
  NULL), so `v_business_outcomes.web_origin_state` is never `website` for it. The adapter declares
  `originKnown: false` and `carriesToken: false`; the conversions sender refuses any source without a
  known origin, and an enabled tokenless source adds `source_cannot_carry_token` to every paid cohort.
- Owner-only `POST /api/outcomes/csv-imports/preview` (dry run) and `.../commit` (must name the previewed
  SHA-256; refuses any invalid row). One database function writes new and changed rows and the audit row
  (`outcome_csv_imports`) in a transaction; an identical row is not written, so a re-import records no
  observation. A CSV source counts in readers as received (`push_as_received`); it has no reconciliation.

## Implementation notes (data contracts)

- Shared code no longer names the reference adapter: `tests/acuity-vocabulary-boundary.test.ts` is strict over
  all of `src` (the debt list is gone). Allowed: the adapter folder, its webhook route, the registry, and
  `src/lib/capi/acuity-capi.ts` (path pinned by the golden import).
- Generic pieces moved out of the adapter: `src/lib/outcomes/business-facts.ts` (keys `observedCollectedValue`,
  `recordedOutcomeValue`; the adapter keeps the golden-pinned `acuityRecorded*` keys as a field-for-field view),
  `business-facts-reader.ts`, `confirmation-facts.ts`, `ledger-account.ts`, `reconciliation.ts`, and
  `src/lib/capi/conversion-events.ts`. The adapter's link evaluation moved into the adapter.
- Adapter contract additions: `reconcile` (the nightly reconcile and its own ledger-health head),
  `storedLedgerHealth`, `conversionSendMode`, `legacyVocabulary`, and capabilities `ownConversionSender`,
  `derivedEventIdPrefix`. The sync orchestrator, daily cron, cockpit, health route, webhook payload check and
  evidence reader use these instead of naming the adapter.
- Persisted vocabulary: claim system `outcomes`, evidence plane `outcome_business`, metric keys `outcomes.*`,
  report/evidence key `outcomes`, blocker codes `outcome_*`, paid-cohort metric `outcome_recorded_revenue`,
  entity ids `outcome-type:` / `outcome-label:`. A pre-squash vocabulary migration
  rewrote stored JSON documents (folded into the v1 baseline in the v1 release, which holds no stored documents); fingerprinted documents (reporting snapshots, saved reports) keep their
  bytes and are upgraded on read after their integrity check (`src/lib/outcomes/legacy-vocabulary.ts`).

## Implementation notes (currency and money arithmetic)

- Money carries the ad account's ISO 4217 currency. The claim unit is `money` (was `usd`; stored documents are
  rewritten and fingerprinted ones upgraded on read). Economics and causal CHECKs accept any upper-case code
  and a trigger (`enforce_account_currency`) requires it to equal `ad_accounts.currency`; causal functions
  write the design's currency and materialization refuses a settlement or cost in another currency.
- One formatter, `formatMoney` (`src/lib/utils/format-currency.ts`), uses `NEXT_PUBLIC_ACCOUNT_CURRENCY` and
  `NEXT_PUBLIC_ACCOUNT_LOCALE`.
- Totals stay double sums (exact sums would change the goldens); the bound is in docs/operations.md.
