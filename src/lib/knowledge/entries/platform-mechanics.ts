import type { KnowledgeEntry } from '../corpus'

// Platform mechanics: learning phase, auctions/bidding, budget/pacing/fluctuations.
// Distilled from docs/meta-knowledge/*.md + the 2026-07 primary-source verification pass
// (docs/research/meta-official-2026-07.md). Every claim cited; fit notes are Example Studio-specific.

const V = '2026-07-10' // verification pass date

export const PLATFORM_MECHANICS_ENTRIES: readonly KnowledgeEntry[] = [
  // ── learning_phase ──────────────────────────────────────────────────────────────────────────────
  {
    key: 'learning-exit-50-events',
    domain: 'learning_phase',
    claim: 'An ad set exits the learning phase after ~50 optimization events within 7 days of the last significant edit.',
    detail: 'Meta-published and still current (re-verified 2026-07-10). During learning, delivery is volatile and CPA typically higher; results are not indicative of long-term performance. A circulating "25 events for Advantage+ Shopping" figure is NOT corroborated by Meta and must not be used.',
    source: { name: 'Meta Business Help Center — About the Learning Phase', url: 'https://www.facebook.com/business/help/112167992830700', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'learning_phase.md',
  },
  {
    key: 'learning-limited-causes',
    domain: 'learning_phase',
    claim: "Meta's published causes of Learning Limited are qualitative — small audience, low budget, low bid/cost goal, high auction overlap, an infrequent optimization event, or too many ads — with no numeric budget-to-CPA ratio.",
    detail: 'Because the official guidance is qualitative, any specific budget multiplier attached to learning exit is third-party, not Meta.',
    source: { name: 'Meta Business Help Center — About Learning Limited', url: 'https://www.facebook.com/business/help/269269737396981', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'learning_phase.md',
  },
  {
    key: 'significant-edits-reset',
    domain: 'learning_phase',
    claim: 'Pausing an ad set or changing its optimization event, audience, creative, or bid strategy resets the learning phase; budget changes above roughly 20% also count as significant.',
    detail: 'The edit-types list is Meta-published; the exact ~20% budget threshold is consistently cited but held at medium confidence (primary page is JS-gated). Practical rule: scale budgets in ≤20% steps spaced days apart, and time deliberate resets (e.g. an optimization-event switch) rather than triggering them casually.',
    source: { name: 'Meta Business Help Center — Significant Edits and the Learning Phase', url: 'https://www.facebook.com/business/help/316478108955072', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'learning_phase.md',
  },
  {
    key: 'learning-budget-5x-heuristic',
    domain: 'learning_phase',
    claim: 'The "~5× target CPA in daily budget per ad set to exit learning" figure is an industry heuristic — no primary Meta source publishes any budget-to-CPA ratio.',
    detail: 'Verified 2026-07-10: zero primary Meta pages state a 5× multiplier; it is an agency rule of thumb amplified by SEO content until it reads as official. It is a reasonable back-of-envelope (spend enough to produce ~7 conversions/day at your CPA) but must always be labeled a heuristic.',
    source: { name: 'Primary-source verification pass (docs/research/meta-official-2026-07.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'learning-limited-profitable',
    domain: 'learning_phase',
    claim: 'Learning Limited is a chronic-but-survivable state: low-volume local advertisers commonly run profitably inside it indefinitely.',
    detail: "Meta's own guidance treats Learning Limited as advisory (consolidate, adjust budget/event) rather than a failure state; the decision metric for a capped-budget local account is CPA vs contribution margin over 2–4 week windows.",
    source: { name: 'Practitioner consensus (Jon Loomer Digital; Meta Learning Limited guidance read together)', url: 'https://www.jonloomer.com/', tier: 'practitioner', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },

  // ── bidding ─────────────────────────────────────────────────────────────────────────────────────
  {
    key: 'auction-total-value',
    domain: 'bidding',
    claim: 'Auctions are won by Total Value = bid × estimated action rate + ad quality — a more relevant ad can beat a higher bid.',
    detail: 'Improving creative relevance and quality raises estimated action rate and quality terms, so better creative frequently beats raising bids or budget. Low delivery can mean low total value, not just low bid.',
    source: { name: 'Meta Business Help Center — About Ad Auctions (docs/meta-knowledge/ad_auctions.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'ad_auctions.md',
  },
  {
    key: 'bid-strategies-menu',
    domain: 'bidding',
    claim: 'Bid strategies: Highest volume (spend-based default), cost-per-result goal (target average cost; adherence not guaranteed), ROAS goal, and manual bid cap.',
    detail: 'Cost/ROAS goals need meaningful conversion volume to steer against; with sparse events the system cannot hold a target and delivery throttles. Bid caps require knowing predicted conversion values — expert-level.',
    source: { name: 'Meta Business Help Center — Bid Strategies (docs/meta-knowledge/bid_strategies.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'bid_strategies.md',
  },
  {
    key: 'relevance-diagnostics',
    domain: 'bidding',
    claim: 'Ad relevance diagnostics (quality / engagement / conversion-rate rankings) localize underperformance to creative, hook, or post-click — but are diagnostics, not auction inputs, and need ≥500 impressions.',
    detail: 'Low quality → improve creative; low engagement → new angles/hook; low conversion ranking → landing/post-click or audience-offer fit; all low → audience-creative mismatch.',
    source: { name: 'Meta Business Help Center — Ad Relevance Diagnostics (docs/meta-knowledge/ad_relevance_diagnostics.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'ad_relevance_diagnostics.md',
  },

  // ── budget_scaling ──────────────────────────────────────────────────────────────────────────────
  {
    key: 'budget-pacing',
    domain: 'budget_scaling',
    claim: 'Pacing spends budget unevenly by design — the system holds back during expensive auctions to buy cheaper results later, so daily spend varies and efficiency must be judged over full windows.',
    detail: 'Budget pacing distributes across the schedule; bid pacing adjusts bids to cost goals. Day-level spend/CPA snapshots misread pacing as instability.',
    source: { name: 'Meta Business Help Center — Pacing (docs/meta-knowledge/pacing.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'pacing.md',
  },
  {
    key: 'budget-floors-not-binding',
    domain: 'budget_scaling',
    claim: "Meta's minimum-budget floors (~$1–5/day by billing event, USD example) are platform floors, not effective-delivery levels — at low conversion volume the binding constraint is event frequency, not budget.",
    detail: 'A large daily budget cannot manufacture bookings that do not exist; extra budget without extra conversion signal mostly buys impressions.',
    source: { name: 'Meta Business Help Center — About Daily Budgets / Minimum Budgets', url: 'https://www.facebook.com/business/help/190490051321426', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'breakdown-effect',
    domain: 'budget_scaling',
    claim: 'Never judge delivery by average CPA in breakdown reports — the system optimizes MARGINAL efficiency, so a segment with higher average CPA may be protecting overall efficiency.',
    detail: 'Evaluate at the unit of optimization: CBO → campaign level; automatic placements without CBO → ad set; multiple ads in one ad set → ad set. Never pause a segment solely on a breakdown average.',
    source: { name: 'Meta delivery-system documentation (docs/meta-knowledge/breakdown_effect.md + MAXX-SKILL.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'breakdown_effect.md',
  },
  {
    key: 'fluctuation-bands',
    domain: 'budget_scaling',
    claim: 'Day-to-day CPA variation of ±20–30% is normal; sustained >50% increases over multiple days, near-zero delivery, or degradation with no changes are the concerning patterns.',
    detail: 'Check learning status, baseline variation, external factors, and sample size before diagnosing; use 7+ day windows for stable ad sets.',
    source: { name: 'Meta Business Help Center — Performance Fluctuations (docs/meta-knowledge/performance_fluctuations.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'performance_fluctuations.md',
  },
  {
    key: 'core-concepts-map',
    domain: 'budget_scaling',
    claim: 'The four platform mechanics to reason from are: auction total value, pacing, the breakdown effect, and the learning phase — most "why did Meta do that?" questions resolve to one of these.',
    detail: 'Auction: relevance beats bid. Pacing: uneven-by-design. Breakdown: marginal beats average. Learning: volatility until ~50 events/7d.',
    source: { name: 'Meta Ads core concepts (docs/meta-knowledge/core_concepts.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'core_concepts.md',
  },
]
