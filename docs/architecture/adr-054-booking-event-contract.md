# ADR-054 — The booking event contract

> **Historical record.** Numbered migrations cited below (for example "migration 050") are pre-release
> history. The schema now ships as one squashed baseline, `supabase/migrations/0001_baseline.sql`, and
> some objects named here were later renamed to generic outcome names (see ADR-058).

**Status:** Accepted in part. Two named limitations remain open and are not claimed as solved: (a) the
lagged window is **historical period evidence, not a matured cohort** — it has no interaction-date
attribution, so an outcome that occurred inside it may have been driven by spend outside it; (b) the
conflicting-window handling is a *refusal*, not a resolution — when the two windows disagree Maxx
declines both directions rather than deciding which is right. Neither is closed until interaction-date
attribution exists. See §3b.

**Context.** Maxx once held several independent "brains" that could each produce money advice: raw flag
rules emitted "Pause." and "Increase budget by 20%" straight from Meta-modelled conversions, the flags
MCP returned those strings verbatim, learned patterns turned modelled `daily_insights.bookings` into
"lean in / scale here", report prompts were told to weight that learning heavily, and
`evaluate_recommendation` ran a separate gate that could never pass. Maxx could truthfully say "no money
action is authorized" in one surface while instructing a budget change in another, and every unit test
passed because each brain was self-consistent. Underneath sat a wrong frame: exact paid evidence
identifies the booking CONFIRMATION date and the booking-session channel, never the date of the ad
interaction responsible for the booking. A "matured" confirmation-date window is therefore not a matured
INTERACTION cohort, and no amount of lag repairs that.

**Decision.**

- **One action-authority pipeline.** `src/lib/authority/action-authority.ts` is the one decision point.
  Producers emit a structured `ActionCandidate` — an observation plus its evidence plane — and only this
  layer decides whether it becomes `diagnostic_only`, `owner_review` or `execution_eligible`, and only
  this layer renders owner-facing action language. Money kinds (budget_scale, budget_cut, pause) require
  `interaction_cohort_complete`; non-money kinds may reach `owner_review` on a weaker plane with the
  provenance named; execution additionally requires owner approval and write mode. Legacy flag rows are
  neutralised on read, with the original text kept under `recommended_action_legacy_raw` for audit.
  `tests/action-authority-matrix.test.ts` asserts the property across the real output surfaces, plus a
  source guard so no rule can quietly reintroduce its own instruction string.
- **Completeness is necessary, direction decides.** `src/lib/authority/directional-policy.ts` owns the
  sufficiency half: a complete cohort with a CPA far above the maximum must not authorise scale.
  Mutual exclusion is structural (scale needs CPA ≤ target, loss needs CPA > max, target ≤ max). The
  legacy action-language detector is clause-scoped and anchored on the verb ("Do not pause; increase
  budget immediately." does not evade it) and is defence-in-depth only; `policy_version` in
  `action_decisions` is the structural legacy cutover. Spend reconciliation is symmetric, with explicit
  zero and missing-row cases.
- **Money authority requires an interaction cohort.** The operating mode carries an explicit
  `authorityBasis`, and ONLY `interaction_cohort_complete` may set `canRecommendBudgetScale` or
  `canRecommendBudgetCut`. Without an interaction/click-time column, money authority is unreachable BY
  CONSTRUCTION rather than by policy. Calendar evidence still produces `healthy_signal_review`,
  `loss_signal_review` and `conflicting_signals_review` — the diagnosis survives in full; only the
  authority is withdrawn. See §3b.
- **External tracking setup.** The scheduler's native GA4 feed belongs in an isolated diagnostic
  property; the scheduler's browser payload must be PII-free; the main GA4 dimensions must be
  registered; and the confirmation listener must trust the exact conversion-frame origin
  (`https://conversion-tracking-sandbox.acuityinnovation.com`, not `https://sandbox.acuityinnovation.com`
  — with the wrong origin, main GA4 receives no `appointment_confirmed`). Server acceptance is claimed
  only from the CAPI delivery-lineage table, never from the legacy `capi_sent_at` marker alone. See §10.

**Scope not covered here.** The persisted `action_decisions` schema and the directional contract are
verified, but this record does not claim that every producer (recommendation generation, reports,
alerts, dashboards, morning brief, watchlist, creative-fatigue, diagnostic tasks) is rewired through the
authority layer, nor that `evaluate_recommendation` refuses caller-supplied spend/bookings. Browser
`appointment_confirmed` delivery and browser/server dedup must be proven empirically on each install.

Supersedes the informal rule that a GA4 event with `eventValue > 0` is a real booking.

---

## 1. Truth hierarchy

| Plane | Owns | Never owns |
|---|---|---|
| **Acuity ledger** (`acuity_appointments`) | booking existence, booking identity, cancel/comp state, **business revenue** | web attribution, delivery |
| **GA4** (`G-EXAMPLE001` / 123456789) | browser & session attribution, landing source, funnel events | booking existence, revenue |
| **Meta** | delivery, modelled attribution, browser/server dedup | any business truth |
| **Maxx** | reconciles the planes, states evidence scope | promoting GA or Meta into business truth |

A plane may only ever **enrich** a plane above it. It may never create or delete a fact there.

## 2. Canonical identifiers

| Thing | Identifier | Owner |
|---|---|---|
| Appointment | Acuity numeric `id` | Acuity |
| Meta conversion | `acuity-<appointment_id>` (deterministic) | Maxx / GTM, shared by browser + server |
| GA confirmation | `appointment_confirmed` + `appointment_id` param | GTM |

`appointment_id` is the **only** join key. Timestamps, minute buckets, and values are not identifiers
and must never be used as one.

## 3. The business vocabulary — six metrics, not one "bookings"

Maxx previously held **two** definitions of a booking in the same report: `acuity/metrics.ts` counted
every active row (including $0), the reconciler counted only value-bearing ones, and both were
labelled "bookings". Neither was wrong; having both unlabelled was. One vocabulary now, defined in
the `v_acuity_business_bookings` view (now `v_business_outcomes`) and mirrored by `lib/outcomes/adapters/acuity/business-facts.ts` (pinned
row-for-row by an integration test, and by an AST test asserting nothing else classifies).

| Term | Definition |
|---|---|
| **confirmed appointment** | not canceled — value-bearing **and** zero-value |
| **value-bearing booking** | not canceled AND `price > 0`; the only class carrying booked value |
| **zero-value appointment** | not canceled AND `price = 0`; a **real** appointment |
| **canceled appointment** | excluded from active performance, reported separately |
| **booked value** | `SUM(price)` over value-bearing. **Not** accounting revenue, **not** cash |
| **Acuity-recorded amount paid** | `SUM(amount_paid)` over active rows. A **different** quantity |

- `price` is the **charged/net** amount; `price_sold` is **nominal** and is never summed. A comp can be
  `price=0 / price_sold=125`, and GA then reports `$125`.
- Exclusion is decided on ledger state, never on a GA `eventValue`.
- **A zero-value appointment is never called a test.** It may be a package redemption, gift
  certificate, staff block, comp or test — the ledger cannot distinguish them, so the state names only
  what is observable. The DB state names are `active_value_bearing` / `active_zero_value` / `canceled`.
- Booked value and recorded payment are never one figure: a **deposit** booking has booked value above
  payment, an **unpaid** booking has booked value with none, and a **canceled paid** appointment may
  still show a payment because Acuity does not necessarily reflect processor refunds.
- Payment coverage is a **coverage** figure, not a collection rate — Acuity does not see offline
  payments, invoices, package draws, refunds or adjustments.

## 3a. Attribution states — exactness is earned, never assumed

A successful GA query is not an exact join. Five states, all reachable:

| State | Meaning | Money? |
|---|---|---|
| `no_events_observed` | GA returned nothing for the window | **no** — an absence of attribution data, not a measured zero |
| `legacy_unlinked` | events exist, **none** carry `appointment_id` | **no** — historical; reporting "0 exact paid bookings" here is a fabricated zero |
| `mixed_partial_coverage` | some events identified, or the window predates the proven boundary | **no** — the identified subset would meet full-window spend |
| `pending_configuration` | the custom dimension is not registered | **no** |
| `exact_appointment_join` | ≥1 event, **every** event identified, window at/after the proven boundary | **yes** |

**The proven boundary** (`ga4_identity_boundary`) is the earliest date an identified event was *observed*.
It is never asserted from configuration and moves only earlier. Direct DML is revoked, the RPC is
`SECURITY DEFINER`, and a trigger blocks a forward move unless it declares
`provenance = 'manual_override'`. The read fails **closed**: no boundary ⇒ nothing is exact.

### Exactness means COMPLETE, not merely identified

Coverage of the events GA *returned* is not enough — the question is whether anything is unresolved.
`exact_appointment_join` additionally requires **all** of:

- every **website-origin** value-bearing booking joined (`web_origin_state`),
- no booking of **unknown origin** (it can be neither required to join nor exempted),
- no **ambiguous** channel/campaign attribution,
- no GA id matching **no** ledger row,
- no **unknown/placeholder** GA channel among joined appointments,
- no **origin contradiction** — a `staff_or_manual` appointment that nonetheless produced a GA
  confirmation event. The origin plane says it had no website session; the GA plane says it did. Both
  cannot be right, so neither is trusted for that appointment until one is corrected.

A **staff or manual** appointment has no website session, so its absence from GA is expected and does
**not** block. Without that distinction, either an unjoined booking silently leaves the numerator while
its spend stays in the denominator, or an ambiguous one produces a fabricated `$0`.

## 3b. Operating authority — three populations, never interchangeable

| Signal | Source | May unlock |
|---|---|---|
| **business volume** | Acuity total (paid + organic + phone + manual) | nothing — **context only** |
| **delivery / learning volume** | Meta modelled conversions | the data mode |
| **proven paid outcomes** | exact, eligible appointment joins | **paid-performance and budget authority** |

**Budget authority is split by action**, because the two directions need different evidence:

**Spend is not evidence of loss.** A gate keyed on "complete measurement + $300 spent" cleared an
account with ten proven bookings at a $30 CPA to *cut*. The rules are performance-based, objective-
aware, and expressed as multiples of the **active** CPA targets so they move when the targets do:

| Action | Requires |
|---|---|
| **Scale** | proven positive outcomes **and** exact CPA at/below `TARGET_CPA` |
| **Cut — review** | zero exact bookings after `2 × MAX_CPA` of spend |
| **Cut — high urgency** | zero exact bookings after `3 × MAX_CPA` |
| **Cut — poor result** | ≥ `MIN_BOOKINGS_PERF_CLAIM` bookings with exact CPA **above** `MAX_CPA` |
| **Execute** | owner approval + write mode, unchanged |

The targets are the **effective** ones, read via `getTargetRange('cpa')` at evaluation time and passed
into the pure function. They were previously captured from `METRIC_RANGES` defaults at module load, so
a Performance-Targets override never reached them — a $200 active maximum was still judged against $100.

Cut evidence comes from a **separate, lagged period** — `LAGGED_PERIOD_DAYS` (14) ending
`MIN_MATURED_DAYS_FOR_CUT` (14) days ago — with spend **and** exact outcomes both read from that same
period. Scale keeps reading the recent window, which is the point of scaling.

An earlier design called this window "matched" and treated the lag as maturity. It is **neither**. Both figures
being drawn from the same dates makes them *co-dated*, not *cohort-matched*: without interaction-date
attribution an appointment landing on day 20 cannot be traced to the impression that caused it, so its
spend may sit outside the period entirely. The 14-day lag is an assumed booking delay, not a
measured one. The correct reading of this window is therefore **historical
period evidence** — it says the account lost money over a past stretch, which is a real and useful
signal, but it is not proof that the specific spend in that stretch produced the specific outcomes in
it. It is kept because the alternative (judging cuts on unmatured recent days) is worse, and because
cuts require a *second*, independent corroboration before they are authorised.

Off-by-one is easy here: `nyDaysAgo(44)..nyDaysAgo(14)` inclusive is **31** days, not 30.
The period is built as `nyDaysAgo(LAG + PERIOD - 1)..nyDaysAgo(LAG)` and pinned by a test.

**Continuity is PROVEN, not assumed.** An earlier design asked `ad_setup_decisions` for rows and
read an empty result as proof the setup had not changed. Three defects, each alone sufficient to
authorise a cut against a rebuilt account: (1) it filtered on `setting_category = 'targeting'`, which
the setup ledger vocabulary never defines — the real categories are `audience | geo | age_gender | placements |
advantage_plus | retargeting | exclusions` — and since the column is free text with NO check
constraint, the typo matched zero rows in silence; (2) `ad_setup_decisions` is an INTENT ledger, so a
change made in Ads Manager and never written down was invisible; (3) the filter started at the
period's END, ignoring changes made DURING it, although those are exactly what makes the period a
mixture of configurations. Continuity is now read from SYNCED META STATE — `meta_updated_time` across
campaigns/adsets/ads plus the ad-set `last_sig_edit_ts` significant-edit marker — together with
executed `change_requests`, over the period's START through now. The manual ledger remains a
supplementary POSITIVE signal (a logged row proves a change) but can no longer prove continuity by
its silence. Missing entities, a sync older than 48 hours, a null `meta_updated_time`, or any query
error all yield `null`, which blocks a cut. Observing a change is evidence; failing to observe one
counts only if we were in a position to observe it.

**Corroboration must NOT overlap.** An earlier design corroborated the historical loss with the
trailing 30-day window — which contains the lagged 14-day period outright. The same spend and the same outcomes therefore served as both the loss and its
independent confirmation. That is double evidence, and it could authorise a cut without ever showing
the loss continued past the historical period. Corroboration now comes from a NON-OVERLAPPING slice
running from the day after the lagged period ends through the reporting window's end,
with its own completeness state. Two outcomes are admissible: a measured CPA above
the active maximum, or a zero in a slice that has ITSELF had the assumed conversion lag to settle. An
immature zero corroborates nothing — a slice ending yesterday has had no time to convert, so treating
its zero as confirmation would corroborate a "loss" for a healthy account. Absent admissible
evidence, cut authority stays closed, which is the reviewer's stated alternative and is accepted.

**Direction exclusivity.** An earlier design could authorise scale and cut in the same evaluation — a
$30 recent CPA beside a $200 historical one produced `{scale: true, cut: true}` with a narrative that
said both. Two windows disagreeing is not a licence to move the budget in whichever direction is read
first. A cut now requires the historical loss **and** recent corroboration (`recentCorroboratesLoss`)
**and** structural continuity — no objective, optimisation-event, targeting, budget or bid-strategy
change recorded in `ad_setup_decisions` since the period ended, because a changed setup makes the
historical evidence evidence about a *different* configuration. Unknown continuity fails closed. When
sound historical loss meets a disagreeing recent window, the verdict is `conflicting_windows_review`
and **neither** direction is authorised. This is a refusal to act on contradictory evidence, not a
method for resolving it.

Two earlier shapes were wrong. Using *identity completeness* as maturity ignored that a 30-day
identity-complete window ending yesterday has ~1 matured day. Replacing it with "days since the
window ended" was worse: the reporting window always ends yesterday, so that value was permanently
~1–2 and **cut authority became unreachable** however long the account lost money. A scalar also
cannot mature a *mixed* window — a trailing 30 days holds both matured and immature spend, and
dividing all of it by outcomes only the matured part could have produced understates results.

The required lag is a **declared assumption**, not a measurement of the ad-click-to-booking delay.
Appointment-created → appointment-date delay says nothing about it.

Booking-CPA rules apply **only** to a bookings objective, resolved from the synced
`campaigns.objective` (`lib/modes/objective.ts`). An account holding booking, lead and awareness
campaigns resolves to **`unknown`**, which blocks the rules — one account-level objective cannot
authorise a unit action. Callers that cannot resolve it pass `unknown`, never `bookings`.

Not-proven (`null`) still blocks both directions. A CPA between target and maximum yields
**`hold_watch`**: a measured, mediocre result that triggers diagnosis and a scheduled review while
granting neither scale nor cut authority.

The **effective** targets are hydrated at every authoritative entry point before any target is read.
`getTargetRange()` reads a process-local map, so a cold MCP/Vercel process evaluated on the built-in
defaults even with an override persisted — and the dashboard's client provider hydrates in
`useEffect`, after server data is computed, so it cannot repair a server-rendered decision.

**Per-campaign ROAS** requires, beyond account-level exact outcomes: **campaign spend completeness** —
the campaign rows must reconcile to account spend within 2%, because an authoritative *account* row
does not prove each *campaign* denominator is whole (account $400 with $100 of synced campaign rows
permitted an 8× ROAS) — complete **campaign mapping**
(every exact paid booking maps to exactly one in-scope Meta campaign) and an **authoritative
account-level spend** basis. It previously unlocked on named-campaign *share* alone — a coverage
statistic about telemetry — which made the brain contradict the campaign panel's fail-closed
behaviour. A campaign-row-sum denominator now withholds ROAS and MER everywhere rather than inflating
them, and the panel renders the reason.

**Ledger availability is separate from attribution availability.** A failed ledger read yields *no*
business numbers, never zeros.

### The three money questions, kept apart

| Figure | Availability |
|---|---|
| **Meta estimated CPA** | visible now, explicitly modelled and non-causal |
| **Exact paid CPA / ROAS** | UNAVAILABLE until forward identity covers the complete window |
| **Blended MER** | **available now** — total ledger booked value ÷ Meta spend, labelled blended, never paid performance |

## 4. GA4 event allowlist (main property)

| Event | Status | Role |
|---|---|---|
| `page_view`, session events | keep | traffic |
| intent and lead events (`GA4_INTENT_EVENTS`, default `begin_checkout`; `GA4_LEAD_EVENTS`, default `generate_lead`) | keep | funnel |
| `appointment_confirmed` | keep — **the one** canonical browser confirmation | attribution only |
| native Acuity `purchase` | **must not be a key event in the main property** | scheduler telemetry only |

Native `purchase` and `appointment_confirmed` carried different counts and values in the same window and are two event
families around one booking flow. **N key events is not N bookings.** They are never summed, and
neither is a business booking count.

The website report counts these as three configured cards, Intent, Lead and Confirmation events
(`src/lib/reporting/website-event-groups.ts`); the confirmation card counts `GA4_BOOKING_EVENT`. Event names
are per install; a configured list that breaks the GA4 event-name rule makes its card unavailable, never zero.

## 5. Meta dedup contract

One logical `AppointmentConfirmed` per appointment. Browser and server copies both carry
`event_id = acuity-<appointment_id>` and deduplicate at Meta. The **signed Acuity webhook remains the
sole server-side sender**. The deleted public relay route is not restored.

## 6. Attribution perspectives — kept separate, never collapsed

| Perspective | Mutability | Meaning |
|---|---|---|
| first qualified touch | immutable once set | initial demand creation |
| **last non-direct touch** | mutable until booking | latest qualified acquisition touch |
| booking-session attribution | GA4 | the session confirmation happened in |
| Meta attribution | modelled | platform claim, separate |

**The existing `utm_*` / `fbclid` ledger columns are LAST-NON-DIRECT.** The site snippet
overwrites stored values on a later qualified tagged visit; its comments say
"first ad touched", which is false. The columns keep their existing meaning — they are **not**
silently redefined. First-touch fields are **not added**: no capture or persistence
route exists for them, and schema with no writer is not an implementation.

The **latest** valid Meta click identity before booking remains the CAPI click identity.

A 90-day client-storage guarantee is not claimed. WebKit caps script-writable storage (~7 days in
several cases), so any retention promise beyond "best effort" would be false.

## 7. PII policy

Raw `email` / `full_name` must not appear in the dataLayer or in any browser network payload. The
signed server webhook already holds the identifiers CAPI needs. Meta dedup survives on the shared
deterministic `event_id`, which carries no personal data.

## 8. Legacy-data boundary

GA4 custom dimensions are **not retroactive**. Events before `appointment_id` registration have no
identity, are labelled `legacy_unlinked`, and:
- are never presented as an exact join,
- never become a business booking,
- never unlock an automated money action.

Identifiers are never fabricated for historical rows.

A disputed historical booking value cannot be settled from that data: the events carry no appointment
id, and a minute-bucket query cannot separate same-minute events. Forward-only logic makes this class of
dispute impossible: identity, ledger-state exclusion, and charged-value revenue leave nothing to argue
about.

## 9. Former behaviour → rule now

| Former behaviour | Rule now |
|---|---|
| GA `eventValue <= 0` = "test" | ledger state decides |
| `dateHourMinute` bucket ≈ a booking | join on `appointment_id` |
| Exclusion applied silently, label unused | no value-based exclusion; telemetry named as telemetry, enforced by an AST boundary test over a reviewed allowlist |
| Origin fact writable by payload shape | writer-role allowlist; DB CHECK narrows the **vocabulary** and pair coherence — it cannot verify that a row labelled `webhook` came from the webhook |
| GA telemetry consumed as money across many modules | typed telemetry names; money surfaces use the exact join |
| Two conflicting booking definitions in one report | one vocabulary, one classifier, DB-defined |
| GA adapter discarded `eventCount` | count carried; duplicates and ambiguity surfaced |
| A successful GA query was always "exact", so an all-legacy window produced an exact `{0, $0}` | five-state machine + proven boundary (061) |
| GA telemetry spoke as bookings/revenue in the weekly prompt, reports recap, dashboard cards, ChannelBreakdown, ga4-campaigns MCP and the money-truth diagnostic | all relabelled; the diagnostic is now an estimate-vs-estimate plane conflict |
| GA confirmation events drove the OPERATING MODE, which gates budget/performance recommendations | all three callers use ledger value-bearing bookings |
| `acuity/metrics.ts` was a second classifier and read across accounts | delegates to `business-facts.ts`; account id required |
| Economics turned unavailable into zero (unscoped spend, ignored Supabase `error`, zero-initialised facts) | fails closed; business availability separate from attribution availability |
| `account.mer` was paid ROAS; the client report subtracted GA events from ledger bookings | MER is blended ledger value; the incomparable residual is removed |
| "Exact" ignored unjoined bookings, ambiguity, unmatched ids and unknown channels | eligibility-aware completeness rule (062 `web_origin_state`) |
| Ad authority could be unlocked by organic/phone/manual bookings | three separate populations; only proven paid outcomes unlock money authority |
| A ledger outage rendered as `0 appointments / $0.00` | `business` is nullable with a reason; no counts are emitted |
| Live prompts/tool descriptions still called GA aggregates "actual paid bookings" | runtime surfaces corrected and pinned by test |
| MER died with GA; account spend summed from campaign rows | MER depends only on ledger + account-level spend; `spend_basis` reported |
| Boundary writes could move coverage forward accidentally | browser DML denied; trusted `service_role` DML restored by policy; monotonicity trigger blocks forward updates unless `manual_override` is explicit; real-Supabase tests cover both paths |
| Trust scored GA telemetry equal to the ledger → "Verified (100%)" with no identity | telemetry scores below a Meta estimate and is hard-capped; `exact_appointment_join` added |
| A staff-origin appointment with a GA event became an exact paid booking | origin contradictions freeze the window |
| Unmapped exact bookings silently dropped → lower-bound campaign ROAS | mapping completeness gates all per-campaign ROAS |
| Proven zero could not trigger a cut | budget authority split by action |
| Degraded spend denominator silently inflated ratios | blocks ROAS/MER; reason rendered |
| The money guard scanned 8 hand-listed files | scans every production file |
| The replay gate was a manual shell command | `scripts/verify-replay.sh` + `npm run gate:full` (then named `npm run acceptance`: replay, lint, tsc, mcp, unit, PGlite, integration ×2, build) |
| The cut gate authorised a cut from spend alone — $300 with a $30 CPA | objective-aware loss rules against the active CPA targets, matured-window requirement |
| `provenance` relabelled GA telemetry as "ledger booked value · actual" | one vocabulary; every source labels ITSELF; GA renders `estimated` |
| Campaign-ROAS authority ignored mapping completeness and spend basis | both required; brain now agrees with the panel |
| MER survived a degraded denominator on the normal GA-available path | same condition on all four sites |
| The guard exempted any line containing `not`/`never` | narrow POSITIONAL exemption |
| CPA targets read module-load defaults, so overrides never applied | effective targets passed in; AST forbids reading the constants |
| Identity coverage was used as conversion maturity | measured from the window's end; the lag labelled a declared assumption |
| `objective: 'bookings'` hardcoded everywhere | resolved from synced `campaigns.objective`; mixed ⇒ `unknown` |
| An account spend row did not prove campaign denominators | campaign rows must reconcile within 2% |
| Live prompts still said "judge AD performance on GA4 PAID" | corrected; guard now enforces the vocabulary and key schema |
| The replay verifier was callable but not CI-enforced | `verify:replay` runs in the database-integration workflow |
| ROAS/MER carried a static GA provenance | corrected; `estimate_only` re-keyed on attribution-dependence |
| The maturity fix made cut authority **unreachable** | separate lagged period, co-dated spend/outcomes, documented as historical evidence not a matured cohort (a stated limitation) |
| Saved CPA targets never hydrated at the MCP entry point | `hydrateTargetOverrides()` first; production-path test with a persisted override |
| `campaign_spend_complete` never reached the authority gate | threaded into `ModeSignals` and required |
| `ad-attributed = GA4 PAID` sat beside the exact-join contract | corrected; monitoring relabelled as tag health; further phrase families guarded |
| The acceptance gate was red under ordinary execution | `hookTimeout` + `fileParallelism: false` |
| Continuity resolved `true` from an empty query on a non-existent category in a manual ledger | proven from synced Meta state + significant-edit marker + executed actions, from the period's start, freshness-gated; unknown stays null |
| Corroboration reused the historical observations (lagged period sits inside the trailing window) | non-overlapping post-period slice with its own maturity; immature zero cannot corroborate |
| The conflict state emitted false scale/cut explanations to the LLM | conflict short-circuits both generic branches; absence of the false phrases is asserted |
| Tracking-outage evidence used an all-source population over a mismatched window | website-origin population, identical dates, GA tag health split from Meta CAPI delivery health (063) |
| Numeric appointment IDs bypassed the configured length limit | normalize first, then one digit/length contract for both representations |
| Scale and cut could be authorised in the same evaluation | mutual exclusion; `conflicting_signals_review` (named `conflicting_windows_review` at the time); cut needs recent corroboration + structural continuity |
| The lagged period was 31 days while documented as 30 | `nyDaysAgo(LAG + PERIOD - 1)..nyDaysAgo(LAG)`, pinned by test |
| GA monitoring reported telemetry as bookings and claimed outages GA alone cannot prove | ledger-evidenced outage claims; area renamed `ga_event_value_health` |
| The "persisted override" test proved neither causation nor ordering | hydration mutates the range the getter serves; invocation order asserted |
| Calendar-period correlation was granting real money authority | explicit `authorityBasis`; only `interaction_cohort_complete` may authorise scale/cut; calendar evidence yields review states |
| Continuity was proven by GLOBAL freshness — one fresh campaign covered a 72h-stale ad set, and an account with no synced ad sets passed | cohort-scoped proof over the ads that actually spent, every relevant row individually fresh and present, unresolvable cohort ⇒ null |
| `change_requests` / `ad_setup_decisions` continuity queries were NOT account-scoped | every query filtered on `ad_account_id`; pinned by a test that inspects the filters |
| Tracking health read the BUSINESS population, which drops canceled confirmations whose tag fired | separate `ConfirmationFacts` contract on confirmation-creation ET dates, canceled included, three origin classes never merged |
| Partial CAPI loss was invisible — an accepted-delivery shortfall produced no finding | any accepted-delivery shortfall is reported with exact accepted/missing/percentage; no tolerated-loss threshold; unknown origin gets its own not-evaluable finding |
| 063 described `capi_sent_at` as a send attempt | corrected to the post-050 accepted-live invariant (single writer, same transaction, `events_received = 1`, live only) |
| Several independent brains could each produce money advice, contradicting each other | one `ActionAuthorityDecision` layer; producers emit structured candidates; entry-point matrix test + source guard |
| Legacy `capi_sent_at` was promoted to accepted-live evidence; applying 050-063 does not upgrade pre-050 stamps | acceptance derived from `acuity_capi_deliveries.live_accepted_at`; legacy stamps counted separately as unverified; 047→064 upgrade fixture proves legacy≠accepted, test≠live, live=accepted |
| Continuity proved an INCOMPLETE spend cohort ($1,000 account vs $100 at ad level returned true) | ad-level spend reconciled to authoritative account spend per window, paged; incomplete coverage ⇒ null |
| Campaign parentage came from the denormalized `ads.campaign_id` | resolved through the ad set's authoritative relationship |
| MCP operating-mode totals ran unscoped before the account was resolved | account resolved first; spend, modelled bookings and active-delivery reads all `ad_account_id`-scoped |
| Evidence completeness authorised the WRONG direction (complete cohort + a far-above-maximum CPA ⇒ `execution_eligible` for scale; one state authorised scale+cut+pause) | `directional-policy.ts`: completeness necessary, direction sufficient; mutual exclusion structural; objective gating with unknown/mixed failing closed |
| The matrix test asserted the finding-72 defect as correct behaviour | replaced with per-direction fixtures; losing⇒no scale, profitable⇒no cut, each direction reachable on evidence that supports it |
| Legacy negation lookback let a later directive through ("Do not pause; increase budget immediately.") | clause-scoped lookback anchored on the captured verb; detector demoted to defence-in-depth; `policy_version` is the structural cutover |
| Spend reconciliation was one-sided — $1,200 entity vs $1,000 account reconciled | absolute relative difference within 2% both ways; explicit zero-spend, missing-account-row and duplicate-row cases |

### Which surfaces are actually rewired

Every consumer the compiler forced open was classified. **Exact-join or ledger** (money):
`mcp/tools/economics.ts`, `lib/analytics/campaign-roas.ts`, `lib/recommendations/evidence-gate.ts`,
`lib/report/generator.ts`, `lib/report/weekly.ts`, `app/report/client/page.tsx`.
**Telemetry, renamed and labelled**: `dashboard-data.ts`, `CampaignRoasPanel.tsx`, `ChannelBreakdown.tsx`,
`(dashboard)/dashboard/page.tsx`, `(dashboard)/activity/reports/page.tsx`, `monitoring/run.ts`,
`diagnostics/reconciliation-report.ts`, `diagnostics/launch-performance.ts`, `report/task-revalidation.ts`,
`modes/launch-readiness.ts`, `tracking/utm-validator.ts`, `learning/outcomes.ts`,
`learning/ledger-outcomes.ts`, `mcp/tools/operating-mode.ts`, `mcp/tools/utm-health.ts`,
`mcp/tools/ga4-campaigns.ts`, `api/ga4/bookings/route.ts`. **Deleted**: `getGa4BookingsByAppointmentType`.

### What this costs, until the owner configures GTM/GA4

**Maxx now reports NO paid CPA, NO paid ROAS and NO campaign ROAS anywhere.** Those numbers were
previously computed from GA event counts and values that cannot be deduplicated, checked against
cancel state, or reconciled to a charged amount. Every one of them now reads `unavailable` with a
stated reason.

**Blended MER is the one exception and IS still reported.** It is kept deliberately because it depends
only on the Acuity ledger and account-level Meta spend — neither of which is GA-derived — and it is
labelled blended everywhere it appears: it is total booked value over total spend, not paid
performance, and it is withheld when the spend denominator is not `account_level_insights`. The loss of
the other numbers is deliberate and correct, but it is visible on the dashboard and client report — the
owner should expect it rather than discover it.

## 10. External configuration dependencies

The owner configures these outside Maxx:

1. Register the `appointment_id` custom dimension in the main GA4 property and send it as a GTM event
   parameter on `appointment_confirmed`. GA4 dimensions are not retroactive (§8).
2. Keep the scheduler's native `purchase` out of the main property's key events — send its native feed
   to a separate diagnostic property.
3. Remove any duplicate GA4 tag that double-collects on the site.
4. Install the confirmation listener with the exact conversion-frame origin, a strict payload schema
   and a per-appointment latch (repeated postMessages must not emit repeated events). A scheduler
   `event.source` check is not valid for the nested frame.
5. Pause any obsolete tag that posts personal data, and never reuse a credential that was public.
6. Do not fire a second Meta PageView on contact success; use a lead event or nothing.

Maxx's exact-join path is inert until steps 1–3 are done. Until then it reports
`PENDING CONFIGURATION`, which is explicitly **not** a claim that there were zero bookings, and ledger
totals are unaffected. A published container is not proof that the browser `appointment_confirmed`
fires or that Meta browser/server dedup collapses to one logical event; only a controlled test booking
that reconciles across the ledger, GA4 and Meta establishes that. First-touch capture stays deferred
until a real capture route exists (§6).
