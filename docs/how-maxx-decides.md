# How Maxx decides

Maxx exists to stop a confident answer from inventing performance. This page explains the rules that
every number, report and recommendation follows, and where each rule lives in the code. The rules
are business-neutral: they hold whether your results are sales, leads, bookings or sign-ups.

## 1. Three kinds of evidence, never blended

| Kind | Source | What it is | What it is not |
|---|---|---|---|
| Platform-reported | Meta Marketing API | Delivery (spend, impressions, clicks, landing-page views) and Meta's own modelled conversions, reported under Meta's attribution windows (7-day click / 1-day view, shown beside every such number) | Your business results. A Meta "purchase" is Meta's estimate of its own effect. |
| Business outcomes | Your outcome sources ([outcomes.md](outcomes.md)) | What your business recorded: each sale, lead or booking, its status and its value | Proof of which ad caused it. An outcome alone does not name an ad. |
| Web analytics | GA4 (optional) | Sessions and events on your website | An outcome, a revenue figure or a cost per result. A GA4 event has no outcome identity. |

Every number in a report is a claim that carries its source and evidence plane: `meta` /
`meta_delivery`, `outcomes` / `outcome_business`, `ga4` / `ga4_telemetry`, and
`first_party_attribution` / `paid_association` for paid-touch links (`src/lib/reporting/`). Outcome
metrics are keyed `outcomes.*`.

Readers label the source on every number and never substitute one for another: a Meta conversion is
never counted as an outcome, and a GA4 event is never counted as an outcome. Where two sources
describe the same thing, a reconciliation view shows both side by side and names the gap.

## 2. Unknown is never zero

A missing value, a failed read and a true zero are different facts, and Maxx keeps them apart:

- **Money:** an unrecorded value is NULL, not 0. An exact collected total exists only when every
  outcome in it has a recorded value; otherwise the observed part is reported as a lower bound with
  its coverage ([outcomes.md](outcomes.md#unknown-is-not-zero)).
- **No source:** with no outcome source enabled, reports say "no outcome source". They never show
  zero outcomes.
- **Failed or incomplete reads:** a source that cannot prove its window is complete fails the read
  with its reason; a failed Meta or database read makes the affected figure unavailable, with the
  reason, rather than empty.
- **Coverage denominators:** linkage between ads and outcomes is reported with its denominator. A
  source that cannot carry an ad-click token (the CSV import) counts against that denominator: while
  it is enabled, paid cohorts are marked incomplete (`source_cannot_carry_token`), so leaving it out
  can never make the linked share look complete. A signed webhook can carry a token, so it does not
  block by itself; its outcomes sent without one are counted as not linked.
- **Maturity lag:** results arrive after the ad that caused them. Recent windows are marked immature
  (the paid-cohort policy uses a 14-day lag, `src/lib/attribution/paid-cohort-policy.ts`), so a quiet
  last week is not read as a failing ad.
- **Calendar and currency:** business dates use the account timezone, which must equal the ad
  account's; money uses the account currency. A mismatch is refused, never silently mixed, and
  amounts in different currencies are never summed. Totals are floating-point sums with a stated
  error bound ([operations.md](operations.md#money-currency-and-arithmetic)).
- **Spend floors:** an ad, ad set or campaign is too early to judge until it has spent
  `NEXT_PUBLIC_MIN_SPEND_TO_JUDGE` in the account currency (default 20, sized for currencies like USD
  or EUR; set a larger amount such as 3000 for JPY). Every other spend floor (dormancy, alerts, the
  minimum spend of each target range, trend and pattern thresholds) is a fixed multiple of it
  (`src/config/spend-floors.ts`).
- **No target, no cost verdict:** cost targets have no default. Until you set a CPA target in Settings →
  Performance Targets, cost per result is reported but not judged, and the zero-outcome tiers (spend
  of twice the target, or three times the maximum, with no outcomes) do not fire: a fallback from the
  spend floor would invent a commercial threshold. An entity that normally produces outcomes and
  spends without any is still reported by the zero-conversion alert.

## 3. Evidence planes and authority

Every observation that could become advice is tagged with the strongest kind of evidence it actually
rests on (`src/lib/authority/action-authority.ts`), strongest first:

1. **Causal contribution:** an incremental-contribution estimate from a designed experiment for the
   exact target.
2. **Interaction cohort:** paid clicks linked to later outcomes, with complete capture and linkage
   (diagnostic association, not causation).
3. **Exact paid join:** an outcome linked to an ad by identity, counted by the outcome's date.
4. **Business ledger:** outcome facts that say what happened to the business, not which ad caused it.
5. **Platform-modelled:** Meta's own conversion estimates.
6. **Web telemetry:** GA4 events.
7. **Structural:** delivery and configuration state, with no outcome claim at all.

Actions are split by whether they move money:

- **Money actions:** scale a budget, cut a budget, pause, activate.
- **Non-money actions:** refresh creative, structural cleanup, observe.

One module decides what an observation may become, and it is the only place that writes owner-facing
action language. Three tiers exist:

| Tier | Meaning |
|---|---|
| `execution_eligible` | The evidence would support the action. Execution still needs your approval and write mode. |
| `owner_review` | Worth your decision, with the evidence and its limits stated. |
| `diagnostic_only` | Stated as an observation, with no instruction and no authority. |

The rules:

- **A money action needs a decision-grade causal estimate.** Under anything weaker it becomes
  `diagnostic_only`: the observation survives in full, the imperative does not.
- **Completeness is not direction.** Even complete evidence must support the proposed direction: a
  complete cohort showing a cost per result above your target does not support scaling. Without
  trusted directional evidence, every money action fails closed.
- **Pragmatic media-buyer mode** (an owner setting, `ENABLE_MEDIA_BUYER_RECOMMENDATIONS` as the
  default) lets a complete interaction cohort, or Meta's modelled results labelled as an estimate,
  reach `owner_review` for money actions, never `execution_eligible`.
- **Non-money actions** may reach `owner_review` on weaker evidence, with the evidence named in the
  text.
- **No upstream text can smuggle advice.** Producers submit structured observations; if an
  observation is phrased as an instruction ("pause this", "increase budget"), the text is withheld
  and replaced with a note.
- **A budget ceiling bounds every money recommendation** (`DAILY_BUDGET_CEILING`, the owner's
  account-total daily ceiling).

## 4. Changes to the ad account

Nothing changes your ad account by itself:

- Live writes are off unless `WRITE_MODE_ENABLED` is exactly `true`, and the Meta token needs
  `ads_management` for them.
- Every write is a change request with a dry-run preview, the before-state and a risk label, and it
  executes only after you approve it in the app.
- **Who initiated a change decides the evidence bar** ([ADR-059](architecture/adr-059-owner-initiated-changes.md)).
  Maxx itself can request a change only from an `execution_eligible` decision with an exact proposed
  mutation. You can propose one yourself, on the Changes page or with "Propose this change" on a
  decision, from a current `owner_review` or `execution_eligible` decision whose action Maxx can
  apply: pause or activate an ad, set an ad set's daily budget (in the direction the decision
  states), or duplicate an ad set as paused. A `diagnostic_only` decision never becomes a change.
  The request records that you initiated it.
- The same hard guards apply to your proposals: the target must belong to the active account, the
  account currency must match, the live state must be readable, and the account total stays under
  `DAILY_BUDGET_CEILING`. A budget step larger than `MAX_BUDGET_CHANGE_PERCENT` (default 50%) needs
  an explicit override confirmation, which is recorded and raises the risk to high.
- **Approve & apply** applies the change only when `WRITE_MODE_ENABLED=true`, through the executor
  (a lock per account, a re-read of the approved state, verification and an `action_log` row).
  With writes off it records your approval and keeps the change listed to apply later. Requests
  expire after 7 days; an expired request can be rejected, never approved.
- **Rollback** of an applied pause, activate or budget change is a new proposal that restores the
  recorded before-state, which you approve like any other. A duplicated ad set is deleted by hand.
- In the demo (`npm run demo`) approvals run a simulated executor on the sample data, labelled
  "Demo: simulated"; nothing is sent to Meta.
- **New campaigns are campaign plans** ([ADR-062](architecture/adr-062-campaign-plans.md)). From a
  brief (on Campaigns → New campaign, or by asking Maxx), Maxx drafts one campaign with its ad sets,
  audiences, budget and copy. A model may propose the structure and the copy; the budget, objective,
  optimisation, bidding, URLs and status are always Maxx's deterministic choices and your inputs.
  Every version is validated against the account (currency, Meta's minimum, the account ceiling with
  today's live total, the per-change step limit, objective and optimisation, pixel, audiences and
  creatives that exist in this account, landing hosts, tracking parameters, the copy scorer) and
  shown with a launch-readiness checklist. Submitting creates a `create_campaign_paused` change
  request; approving it applies only with write mode on and creates every object **paused**, verified
  by reading it back. Maxx never activates anything: you turn the campaign on in Ads Manager. A
  failed creation can be resumed (only the missing objects) or rolled back (an approved request
  archives what was created).
- **Ask Maxx can act, but never approves.** Asked to, it writes scored copy (copy is creative text,
  not a claim, and still passes the scorer), drafts a plan, or proposes a change from a decision it
  showed you. Each returns a card linking to where you review it; approval stays on Changes.
- Each recommendation carries a generation id, an evaluation and your decision record, so what was
  advised, on which evidence, and what you decided stays auditable.
- Budget amounts are in the ad account's currency. The governed `adjust_budget` and
  `duplicate_adset` change requests take `new_daily_budget` (the MCP server exposes no write tool); the old name `new_daily_budget_usd` is still accepted for
  one release, and giving both is refused. The database accepts a change request under either key,
  exactly one, and only under the key its decision was authorised with.

## 5. Conversions sent to Meta

Maxx can send confirmed website outcomes to Meta's Conversions API so Meta's delivery can learn from
them. This informs Meta; it never feeds Maxx's own outcome counts.

- **By outcome type:** `lead` → `Lead`, `sale` → `Purchase`, `booking` → `Schedule`, `signup` →
  `CompleteRegistration`; other types are not sent.
- **Origin gate:** only outcomes observed to come from your website are sent. CSV outcomes, staff or
  manual entries and unknown origins never are.
- **No double counting:** an event the source already sends to Meta (its `platformNativeEvents`) is
  never mirrored.
- **Send once, never retract:** an outcome is sent at its first confirmation, with a stable event id
  that Meta deduplicates; a later cancellation, refund or change sends nothing, and nothing is ever
  withdrawn.
- **Off by default:** `OUTCOME_CONVERSIONS_SEND` (and `ACUITY_CAPI_SEND` for the Acuity example) start
  at `off`; `test` sends to Meta's Test Events only.

The rules are in `src/lib/conversions/event-mapping.ts` and `src/lib/conversions/outcome-conversions.ts`.

## 6. The role of AI

A model may suggest, summarize and explain. It never establishes a fact:

- Money, counts, deduplication, attribution identities and the authority gates are plain TypeScript
  and SQL with tests. A model reads already-computed evidence; it does not compute it.
- Model output that is stored (creative and competitor analyses) is validated against a schema
  first; a refusal or a truncated answer is surfaced as such, never treated as text.
- Third-party text in prompts (competitor ads, feeds, creative copy) is marked as untrusted data,
  never instructions, and nothing a model returns is executed.
- **AI off** (`AI_PROVIDER=none`): every page and report renders with no model call, which shows that
  no core number depends on a model. See [ai.md](ai.md).

## Where to read more

- [outcomes.md](outcomes.md): the outcome model and sources.
- [security-model.md](security-model.md): the authorization boundary and what to rotate.
- Decision records in [architecture/](architecture/overview.md), in particular ADR-056 (paid
  interaction measurement), ADR-058 (generic outcomes), ADR-059 (owner-initiated changes) and ADR-062
  (campaign plans).
