# ADR-056 — Paid-interaction measurement and appointment linkage

**Status:** Accepted. No browser script, Acuity field, migration, Meta setting, or campaign change is
deployed by this ADR.

**Date:** 2026-07-30

## Context

Maxx can currently reconcile Acuity appointments to GA confirmation telemetry by appointment ID, but
that join identifies a booking confirmation session. It does not persist the paid interaction that may
have caused the booking. Dividing spend selected by impression date by bookings selected by confirmation
date therefore produces a calendar-period ratio, not an interaction cohort. That distinction is why the
current authority layer correctly keeps every money action closed.

The existing Acuity attribution fields preserve readable UTMs and `fbclid`, but they do not preserve a
server-observed interaction time or immutable Meta campaign, ad-set, and ad IDs. The CAPI sender therefore
reconstructs `_fbc` with the appointment creation time. That timestamp is not the click time and must not
be represented as one.

The system also needs to preserve two different questions without collapsing them:

- which paid touch first introduced the customer; and
- which eligible paid touch immediately preceded the booking.

Neither answer is a proof of incrementality. They are governed first-party attribution facts used to
build auditable cohorts; blended Acuity totals, Meta-modelled conversions, and GA events remain separate
planes.

## Primary-source contracts

- Meta describes Conversions API as a direct connection between business data and Meta's measurement and
  optimization systems and recommends using it alongside the Pixel for website events:
  <https://www.facebook.com/business/help/AboutConversionsAPI>.
- Meta's published server-event schema requires the actual event time, says `fbc` is the Facebook click
  identifier from the `_fbc` cookie or `fbclid`, and states that browser/server deduplication uses the
  same `event_name` and `event_id`:
  <https://github.com/facebookincubator/Facebook-Server-Side-API-Swagger/blob/main/server-side-api.yaml>.
- Acuity documents `field:<id>=<value>` dynamic-link parameters and explicitly supports prefilling
  internal-use form fields so referral values persist on appointments:
  <https://help.acuityscheduling.com/hc/en-us/articles/31919067234445-Parameters-for-dynamic-links> and
  <https://help.acuityscheduling.com/hc/en-us/articles/16676933531149-Tracking-appointment-referral-sources>.

Meta's developer site returned HTTP 429 during this review. The implementation therefore pins only the
contracts corroborated by Meta's official Business Help page and official published server-event schema;
it does not invent platform benchmarks or learning-volume rules.

## Decision

### 1. The browser records an interaction, never a conversion

The marketing-site capture calls a dedicated Maxx endpoint only when an incoming paid Meta URL is
present. The endpoint:

- resolves the sole active account server-side;
- validates exact allowed origins, request size, media type, URL host, Meta IDs, click ID, and UTMs;
- rate-limits a non-PII request fingerprint;
- stamps the interaction time in Postgres, never from a browser timestamp;
- appends one immutable paid-touch observation; and
- returns a server-signed, opaque attribution token.

The endpoint never calls Meta, never emits `AppointmentConfirmed`, and never accepts customer identity or
appointment data. Origin checks and rate limits reduce abuse; they are not described as authentication.
The signed token and the later signed Acuity webhook prevent a public caller from fabricating a conversion.

### 2. URL identity is both readable and immutable

Every governed Meta ad URL carries readable UTMs and resolved immutable IDs:

```text
utm_source=meta
utm_medium=paid_social
utm_campaign={{campaign.name}}
utm_content={{ad.name}}
utm_term={{adset.name}}
meta_campaign_id={{campaign.id}}
meta_adset_id={{adset.id}}
meta_ad_id={{ad.id}}
```

Names remain useful to humans and GA. IDs are the durable join keys. A touch without the complete ID
trio may be retained diagnostically but can never make an interaction cohort complete.

### 3. First and last paid touch are retained under one explicit policy

Policy version 1 retains the first valid paid touch for acquisition context and the most recent valid
paid touch for optimization attribution. A new touch may extend a chain only by presenting a valid,
unexpired token issued for the same account. A supplied forged, expired, or cross-account predecessor is
rejected; it is never silently treated as a fresh chain.

The token is a bearer artifact and is stored in Acuity only in a hidden internal-use field. The database
stores its digest and immutable first/last lineage, not a recoverable raw token. Token retention preserves
facts; it does not decide the later campaign attribution window. The exact eligibility window is a
CampaignPlan/policy input, so Maxx does not hard-code a universal 7-, 28-, 30-, or 90-day causal claim.

### 4. The signed Acuity webhook is the only appointment linker

After the webhook verifies Acuity's signature and durably upserts the by-ID appointment, one database
transaction validates the attribution token and appends the appointment link. It requires:

- exact account ownership;
- a client-booked origin observation;
- token and digest agreement;
- first touch no later than last touch;
- last touch no later than appointment creation; and
- an idempotent exact retry, with any conflicting relink rejected.

The browser cannot create a booking link. Cancellations do not rewrite history; cohort readers inspect the
current canonical appointment state and exclude canceled outcomes.

### 5. `_fbc` uses the interaction time or is omitted

The server CAPI sender may construct `_fbc` only from the linked paid touch's unmodified `fbclid` and
server-observed interaction time. It never substitutes appointment creation time. If no eligible linked
touch exists, `_fbc` is absent while hashed first-party identifiers may still be sent. The deterministic
`AppointmentConfirmed` event name and `acuity-<appointment-id>` event ID remain unchanged for browser/
server deduplication.

### 6. Cohort generations are immutable and direction-specific

One scalar `interactionCohortComplete` is insufficient. The daily pipeline commits separate immutable
generations:

- `recent_scale`: recent interaction-date spend and the bookings linked back to those interactions;
- `matured_cut`: an older non-overlapping interaction window whose end is at least the declared
  provisional lag before evaluation.

Each generation records its exact window, evaluation time, activation boundary, policy and contract
versions, source heads, authoritative account spend, entity-spend reconciliation, landing-view capture
coverage, identity coverage, unit rows, outcomes, booked value, and stable blocker codes. Missing landing
views, missing IDs, spend mismatch, pre-activation dates, stale/missing source data, or an unmatured cut
window produce a persisted blocked generation, never a zero-result complete cohort.

The current 14-day cut lag is a declared provisional policy inherited from the existing owner-reviewed
rules. It is not attributed to the observed appointment-created-to-service-date distribution, which is a
different interval. A later measured click-to-book distribution must version the policy instead of
rewriting old generations.

Scale and cut evidence are consumed independently. A recent positive cohort may support scaling only
under the existing governed target and directional gates. A cut additionally requires a complete matured
loss cohort, current corroboration, and structural continuity. Conflicting windows authorize neither.

### 7. No historical backfill is invented

An append-only activation record establishes when the capture contract was actually live. A cohort whose
interaction window begins before that boundary is blocked. Legacy Acuity UTMs and GA sessions remain useful
diagnostics but are not assigned manufactured interaction timestamps or IDs.

## Acceptance conditions

Implementation is accepted only when tests prove:

1. forged, malformed, expired, cross-account, replay-collision, and changed-payload tokens fail closed;
2. browser roles cannot read or write raw touch, token, link, activation, or cohort tables;
3. the capture route derives account/time server-side, is origin- and size-bounded, and cannot send a
   conversion;
4. one exact retry returns the same immutable touch/token lineage;
5. a touch must precede the booking and a conflicting appointment relink is rejected;
6. staff-created and origin-unknown appointments cannot receive paid-touch authority;
7. `_fbc` embeds the linked interaction timestamp and never the booking timestamp;
8. canonical Meta URL parameters include the three immutable IDs and the five readable UTMs;
9. pre-activation, incomplete-ID, incomplete-capture, missing-insight, spend-mismatch, and unmatured
   counterexamples persist blocked cohort generations;
10. complete recent and matured fixtures produce exact, non-overlapping unit metrics;
11. the operating-mode path reads exact cohort generations rather than a hard-coded Boolean;
12. reverting the cohort read or webhook link makes the end-to-end test fail; and
13. a controlled ad-preview click-to-book journey is completed after deployment before money authority
   is enabled.

## Consequences

- This contract can make paid performance measurable without treating Meta or GA as business truth.
- The migration and code remain inert until the capture endpoint, exact URL tags, Acuity hidden field,
  activation record, and controlled journey are deliberately deployed and verified.
- Historical paid CPA/ROAS remains unavailable; no timestamp is fabricated to fill that gap.
- CampaignPlan construction may consume this measurement contract, but the contract by itself cannot
  create or change a campaign.

