import type { KnowledgeEntry } from '../corpus'

// Strategy + measurement + economics + landing: structure/audience doctrine, creative doctrine,
// measurement/signal quality, profit framing, and post-click. Sources: docs/meta-knowledge distillation,
// the 2026-07 primary-source verification pass (docs/research/meta-official-2026-07.md), and named
// principle/practitioner works. Practitioner-tier entries here were owner-cleared for the corpus per the
// 2026-07-09 knowledge-gate decision (Meta-official pre-approved; these carry named sources + fit notes).

const V = '2026-07-10'

export const STRATEGY_MEASUREMENT_ENTRIES: readonly KnowledgeEntry[] = [
  // ── structure_audience ──────────────────────────────────────────────────────────────────────────
  {
    key: 'auction-overlap',
    domain: 'structure_audience',
    claim: 'Ad sets with overlapping audiences from the same account exclude each other from auctions — causing under-delivery, budget under-spend, and Learning Limited.',
    detail: 'Meta enters only the highest-total-value ad from your account per auction. Fixes: combine similar ad sets (consolidates learning) or turn off the overlapping/learning-limited one. Diagnose via Account Overview opportunity score or Ads Manager Audience Overlap.',
    source: { name: 'Meta Business Help Center — Auction Overlap (docs/meta-knowledge/auction_overlap.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'auction_overlap.md',
  },
  {
    key: 'account-simplification',
    domain: 'structure_audience',
    claim: "Account simplification is a Performance 5 pillar: fewer campaigns/ad sets concentrate optimization signal, exit learning faster, and avoid fragmenting budget.",
    detail: 'Each additional ad set splits the event stream that trains delivery. Meta frames simplification as the first structural lever, ahead of targeting sophistication.',
    source: { name: 'Meta for Business — Performance 5', url: 'https://www.facebook.com/business/news/meta-performance-5-techniques', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'andromeda-creative-led',
    domain: 'structure_audience',
    claim: "Meta's Andromeda retrieval engine made delivery creative-signal-led: the system reads the creative to predict audience match, and Advantage+ audience treats inputs as suggestions.",
    detail: 'Announced Dec 2024 (Meta Engineering), rollout reported complete early 2026. Practical consequence: creative diversity does the targeting work interest-stacking used to do.',
    source: { name: 'Meta Engineering — Andromeda', url: 'https://engineering.fb.com/2024/12/02/production-engineering/meta-andromeda-advantage-automation-next-gen-personalized-ads-retrieval-engine', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'broad-guidance-nontransfer',
    domain: 'structure_audience',
    claim: 'Generic "go broader / 2–10M audience" sizing guidance does NOT transfer to a hyper-local service business whose service radius is a hard business constraint.',
    detail: 'The guidance assumes geography is expandable (national ecom). For a drive-to studio, radius is set by customer behavior; forcing broader geo buys unusable reach.',
    source: { name: 'Primary-source verification pass — fit analysis (docs/research/meta-official-2026-07.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'cbo-funnel-caveat',
    domain: 'structure_audience',
    claim: 'Meta prefers campaign-budget optimization (CBO) by default, but CBO across a deliberate cold/warm split starves prospecting — warm converts more easily and absorbs the budget.',
    detail: 'CBO adds value when ad sets are comparable competitors for the same job. Cold prospecting vs warm retargeting are different jobs; keep them on separate budgets (ABO) or consolidate deliberately.',
    source: { name: 'Meta CBO guidance + practitioner consensus (Jon Loomer Digital)', url: 'https://www.jonloomer.com/', tier: 'practitioner', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'retargeting-share-norm',
    domain: 'structure_audience',
    claim: 'Post-Advantage+ practitioner consensus puts retargeting at roughly 10–20% of spend — Advantage+ delivery already reaches warm users inside prospecting.',
    detail: 'Dedicated retargeting earns a larger share only with a big, fast-refreshing warm pool. Small local pools fatigue quickly and overlap with expanded prospecting.',
    source: { name: 'Practitioner consensus (Common Thread Collective / Foxwell community)', url: 'https://commonthreadco.com/', tier: 'practitioner', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },

  // ── creative ────────────────────────────────────────────────────────────────────────────────────
  {
    key: 'creative-diversification',
    domain: 'creative',
    claim: 'Creative diversification (formats AND concepts) is a Performance 5 pillar — and under Andromeda, creative variety is the targeting.',
    detail: 'Different concepts recruit different audience pockets; format variety (Reels 9:16, feed 4:5) unlocks placement liquidity. Diversify concepts before duplicating ad sets.',
    source: { name: 'Meta for Business — Performance 5', url: 'https://www.facebook.com/business/news/meta-performance-5-techniques', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'hook-first-3s',
    domain: 'creative',
    claim: 'The first ~3 seconds decide whether video creative retains or is scrolled past; hook quality is the highest-leverage creative variable.',
    detail: 'Reels-era delivery ranks on early engagement signals. 9:16 (1080×1920) for Reels/Stories, 4:5 for feed. Iterate hooks before rebuilding whole concepts.',
    source: { name: 'Meta creative guidance + creative-analytics practitioners (Motion)', url: 'https://motionapp.com/', tier: 'practitioner', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'fatigue-signals',
    domain: 'creative',
    claim: 'Creative fatigue = frequency climbing while CTR erodes from peak (−20–30%) with rising CPA; the fix is refresh/rotation, not higher bids or budget.',
    detail: 'For retargeting pools <10k, frequency >2.5 is warning and >3.5 critical; broad cold audiences sustain more. Refresh means a new hook/first-3s or a new concept — keep the proven structure.',
    source: { name: 'Meta guidance + target-ranges consensus (docs/meta-knowledge/performance_fluctuations.md)', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'performance_fluctuations.md',
  },
  {
    key: 'flexible-format-deprecation',
    domain: 'creative',
    claim: 'The standalone Flexible ad format is being deprecated (~March 2026), absorbed into Advantage+ creative automation.',
    detail: 'Ads using the standalone format need migration to Advantage+ creative rather than like-for-like replacement.',
    source: { name: 'Meta Business Help Center — Flexible Ad Format (deprecation reported 2026)', url: 'https://www.facebook.com/business/help/835561738423867', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },

  // ── measurement ─────────────────────────────────────────────────────────────────────────────────
  {
    key: 'standard-over-custom-events',
    domain: 'measurement',
    claim: "Meta recommends standard events over custom events where one fits — standard events carry Meta's cross-advertiser training priors that custom events lack.",
    detail: 'The standard "Schedule" event = booking an appointment WITHOUT payment; "Purchase" = with payment. Custom events/conversions are best as an additive reporting layer, not a replacement for a fitting standard event.',
    source: { name: 'Meta Pixel Standard Events specification', url: 'https://www.facebook.com/business/help/402791146561655', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'capi-dedup-spec',
    domain: 'measurement',
    claim: 'Running Pixel + Conversions API in parallel requires dedup: identical event_name plus event_id (or external_id + fbp); all events need action_source, website events need event_source_url + client_user_agent.',
    detail: 'Match-quality (EMQ, 0–10) improves with email/phone/name/IP; ~6/10 is the commonly-referenced benchmark with diminishing returns above. CAPI Gateway is a Meta-built self-service middle path (own cloud account required).',
    source: { name: 'Meta Developers — Conversions API best practices', url: 'https://developers.facebook.com/documentation/ads-commerce/conversions-api/best-practices', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'attribution-windows-2026',
    domain: 'measurement',
    claim: 'Since 2026-01-12 Meta offers only 1-day click, 7-day click, 1-day view, and 1-day engaged-view attribution windows (7-day and 28-day view were removed).',
    detail: 'Accounts on removed windows were migrated; settings should be re-confirmed in Ads Manager after platform window changes since silent defaults shift.',
    source: { name: 'Platform-change tracking (Supermetrics docs + corroborating sources; not primary-fetched)', url: 'https://docs.supermetrics.com/', tier: 'practitioner', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'value-optimization-volume-gate',
    domain: 'measurement',
    claim: 'Value optimization requires (trailing 14 days) ~30 attributed Purchase conversions with ≥5 distinct values — or ~100 events for custom/non-purchase events.',
    detail: 'Below the gate, value optimization is unavailable or ineffective; volume must rise first.',
    source: { name: 'Jon Loomer Digital — Value Optimization requirements', url: 'https://www.jonloomer.com/', tier: 'practitioner', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'lift-testing-unreachable',
    domain: 'measurement',
    claim: "Conversion Lift (Meta's RCT incrementality product) needs holdout sizes and event volume far beyond a small local account's budget.",
    detail: 'The Performance 5 "results verification" pillar is right in principle; at small scale the honest substitute is a governed on/off test read against complete interaction-date paid outcomes and the outcome business baseline. GA event channel splits are telemetry only.',
    source: { name: 'Meta Business — Conversion Lift', url: 'https://www.facebook.com/business/measurement/conversion-lift', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'truth-hierarchy',
    domain: 'measurement',
    claim: 'Outcome source is authoritative for active appointments and booked value. GA4 is confirmation-event/session telemetry; Meta is modelled attribution. Paid money requires a complete exact appointment-id join, and causal money authority requires interaction-date cohorts.',
    detail: 'The three planes measure different populations. GA events may duplicate, include later-canceled appointments, or carry nominal values; Meta may under- or over-attribute; neither replaces the ledger.',
    source: { name: 'Account measurement architecture (validated against the outcome source, 2026-07)', tier: 'principle', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },

  // ── profit_economics ────────────────────────────────────────────────────────────────────────────
  {
    key: 'profit-first-frame',
    domain: 'profit_economics',
    claim: 'Judge ad performance on contribution margin per booking vs CPA over 2–4 week windows — not on learning status, ROAS vanity, or platform state.',
    detail: 'Max acceptable CPA derives from margin × AOV × (1 + repeat rate). High-margin service businesses can profitably pay more per booking than retail ROAS intuition suggests.',
    source: { name: 'Profit-first ad management (Common Thread Collective — profit over ROAS framing)', url: 'https://commonthreadco.com/blogs/coachs-corner', tier: 'practitioner', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'mer-context-only',
    domain: 'profit_economics',
    claim: 'MER (all revenue ÷ ad spend) is an account-level blended ratio — useful context, never a per-campaign paid ROAS.',
    detail: 'MER includes organic revenue; attributing it to campaigns credits ads with outcomes they may not have caused. Per-campaign ROAS requires the complete exact paid join, campaign mapping, and authoritative campaign spend.',
    source: { name: 'Blended-measurement practitioner consensus (Common Thread Collective)', url: 'https://commonthreadco.com/', tier: 'practitioner', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },

  // ── landing_offer ───────────────────────────────────────────────────────────────────────────────
  {
    key: 'message-match',
    domain: 'landing_offer',
    claim: 'The landing page is part of the ads system: a low conversion-rate ranking with healthy CTR localizes the problem to post-click — message match, load, and offer clarity.',
    detail: 'The hero must repeat the ad\'s exact promise; mismatch resets the visitor\'s context and they leave. Mobile-first (nearly all Meta traffic), price anchored, proof visible.',
    source: { name: 'Meta Ad Relevance Diagnostics (conversion ranking) + landing-page CRO principle', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
    doc_ref: 'ad_relevance_diagnostics.md',
  },
  {
    key: 'low-commitment-first-conversion',
    domain: 'landing_offer',
    claim: 'Cold visitors rarely complete a high-commitment booking on first touch; a lower-commitment first conversion (availability check, tour view, lead form) converts cold traffic better AND generates a denser optimization event.',
    detail: 'The intermediate step serves twice: better cold conversion AND more frequent conversion signal for delivery optimization — funnel design IS the signal fix at low volume.',
    source: { name: 'Direct-response funnel principle (classic lead-gen laddering; Breakthrough Advertising lineage)', tier: 'principle', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
]
