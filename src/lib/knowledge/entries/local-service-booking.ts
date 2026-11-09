import type { KnowledgeEntry } from '../corpus'

// NICHE EXPERTISE — local-service / studio-rental / appointment-booking on Meta at a capped local budget.
//
// The rest of the corpus is generic Meta mechanics; this file is the account's VERTICAL knowledge: how
// radius targeting, Advantage+, small budgets, tiny warm pools, local creative, and Springfield seasonality
// actually behave for a small-radius, small-budget, booking-based studio rental. Distilled ONLY from the
// meta_official + principle claims in docs/research/local-service-booking-2026-07.md — every URL was
// live-verified 2026-07-13. Practitioner/big_player niche claims are NOT here; they belong in PENDING
// expert_insights rows (owner approves on /signals — the `review_status` governance). As always, this corpus INFORMS strategy and NEVER overrides account data (Truth Hierarchy).

const V = '2026-07-13' // research verification pass date

export const LOCAL_SERVICE_BOOKING_ENTRIES: readonly KnowledgeEntry[] = [
  // ── radius / geo targeting (structure_audience) ───────────────────────────────────────────────────
  {
    key: 'radius-recently-in-default',
    domain: 'structure_audience',
    claim: 'Location targeting reaches people who LIVE IN or were RECENTLY IN the area by default — not residents only — so some out-of-radius leads are expected behavior, not a targeting bug.',
    detail: 'Meta states complete accuracy "cannot be guaranteed" and impressions/leads from outside the set location are normal. The Marketing API location_types are "home" and "recent", defaulting to both; custom radius is bounded 0.63–50 miles.',
    source: { name: 'Meta Business Help Center — About location targeting in Meta Ads Manager', url: 'https://www.facebook.com/business/help/202297959811696', tier: 'meta_official', accessed: V },
    applies_when: 'Any geo-targeted ad set (the service-area radius).',
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'location-expansion-default-on',
    domain: 'structure_audience',
    claim: 'The "reach more people likely to respond to your ads" location-expansion box can be CHECKED BY DEFAULT for city/region selections — turning strict geo into interest-based expansion that must be unchecked for a true radius.',
    detail: 'With it on, Meta adds people who merely "showed interest" in the location (searched it, have friends there, live in nearby towns), same-country only. Meta cites a Mar-2024 experiment: median 6.7% lower cost per optimized event — a cross-vertical median, "performance isn\'t guaranteed."',
    source: { name: 'Meta Business Help Center — How to Reach People Interested in Your Selected Cities and Regions', url: 'https://www.facebook.com/business/help/726389026372510', tier: 'meta_official', accessed: V },
    applies_when: 'City/region location selections (a settings-audit item).',
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'advantage-audience-no-geo-expand',
    domain: 'structure_audience',
    claim: 'Advantage+ audience does NOT expand delivery beyond your location settings — locations stay a hard audience control; only the separate location-expansion box (never Advantage+ itself) widens geo.',
    detail: 'The Advantage+ audience-controls page states audience suggestions are never shown outside your audience controls: age/gender/interest SUGGESTIONS are non-binding and can over-deliver, but geo, min-age, excluded customs and languages BIND (the hard "won\'t target beyond your locations" rule is stated on the location-targeting page, help/365561350785642). Separately, Meta\'s "About Advantage+ audience" page (help/273363992030035) recommends A/B testing Advantage+ audience for almost all campaign types EXCEPT retargeting.',
    source: { name: 'Meta Business Help Center — About Audience controls and Audience suggestions in Advantage+ audience (with location-targeting help/365561350785642 + About Advantage+ audience help/273363992030035)', url: 'https://www.facebook.com/business/help/938372127764391', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'advantage-custom-audience-breaks-retargeting',
    domain: 'structure_audience',
    claim: 'The "Advantage+ custom audience" checkbox lets Meta deliver BEYOND the selected custom audience — so a retargeting ad set with it enabled is no longer strict retargeting.',
    detail: 'Meta: it "can enable our systems to deliver ads beyond the original selected audience, if we think it is likely to improve performance." Combined with Meta\'s advice against Advantage+ audience for retargeting campaigns, strict retargeting requires original audience options with this box UNCHECKED.',
    source: { name: 'Meta Business Help Center — Use Advantage+ custom audience', url: 'https://www.facebook.com/business/help/414975413946182', tier: 'meta_official', accessed: V },
    applies_when: 'Auditing the Warm/retargeting ad-set settings.',
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'website-audience-no-backfill-floor',
    domain: 'structure_audience',
    claim: 'Website custom audiences never backfill (they populate from creation forward), and Meta\'s usable-size floor is "several hundred people" — the widely-cited "1,000" figure applies to uploaded CUSTOMER LISTS, not pixel audiences.',
    detail: 'Fixes for a too-small website audience: wait for several hundred, use fewer conditions (all-visitors), and widen the retention window. Page-engagement audiences allow up to 365-day retention. The 1,000-minimum warning is quoted specifically about customer-list audiences.',
    source: { name: 'Meta Business Help Center — Troubleshoot website custom audience size', url: 'https://www.facebook.com/business/help/1523083297982009', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  // ── budget mechanics (budget_scaling) ─────────────────────────────────────────────────────────────
  {
    key: 'cost-goal-5x-rule-unsupported',
    domain: 'budget_scaling',
    claim: 'Meta\'s own rule — daily budget ≥ 5× your cost-per-result goal — means a cost goal needs a daily budget of at least five times that goal; on a small budget a cost-control goal near the real CPA is structurally unsupported, so stay on Highest Volume.',
    detail: 'Official example (USD example): a $5 cost-per-result goal needs ≥$25/day. This applies only when using the cost-per-result-goal bid strategy (not Highest Volume). The highest compliant cost goal is one fifth of the daily budget, which on a small budget is far below a typical local-service CPA. This is DISTINCT from the ~5× learning-exit heuristic (that one is an industry rule of thumb; this 5× is Meta-published and is about the bid-strategy floor).',
    source: { name: 'Meta Business Help Center — Best Practices for Minimum Budgets', url: 'https://www.facebook.com/business/help/203183363050448', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'daily-budget-weekly-average',
    domain: 'budget_scaling',
    claim: 'A daily budget is a WEEKLY AVERAGE: Meta may spend up to 75% over on a given day, capped at 7× the daily budget per calendar week (Sun–Sat).',
    detail: 'So a single day above the daily budget is normal delivery, not an anomaly; the real overspend guardrail is the weekly cap (7× the daily budget). Ad-set budget sharing can shift up to 20% more between ABO ad sets.',
    source: { name: 'Meta Business Help Center — About Daily Budgets', url: 'https://www.facebook.com/business/help/190490051321426', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'cbo-two-adset-tradeoff',
    domain: 'budget_scaling',
    claim: 'CBO (Advantage+ campaign budget) is officially "best suited for campaigns with at least 2 ad sets" and lowers under-delivery risk, but distributes UNEQUALLY by design — it can starve a tiny warm ad set; ABO is the officially-sanctioned choice when a small set must be guaranteed spend.',
    detail: 'Meta: CBO "continuously distributes in real time to ad sets with the best opportunities" and "may not spend your budget equally… analyze results at the campaign level." No official "small accounts use X" rule exists — the small-account mapping is derived.',
    source: { name: 'Meta Business Help Center — About campaign budgets and ad set budgets', url: 'https://www.facebook.com/business/help/458847204894307', tier: 'meta_official', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  // ── creative for local service (creative) ─────────────────────────────────────────────────────────
  {
    key: 'local-creative-format-spec',
    domain: 'creative',
    claim: 'Official creative spec for a small local advertiser: 4:5 for Facebook feed / 9:16 for Reels & Stories, feed video under ~15s with the brand/hook in the first 3 seconds, sound-off design with captions; campaigns running BOTH static and video saw conversion lift at a 17% higher rate than static-only.',
    detail: 'Meta also endorses cheap 5–10s animated-still videos promoting a single benefit, and an IG testing pattern of up to 10 creatives per ad set, keeping the top ~5 evergreen, tests run ≥4 days. Andromeda rewards genuinely DIVERSE concepts (distinct per persona), not minor crops.',
    source: { name: 'Meta Business Help Center — Creative Best Practices for Conversion Testing / aspect-ratio + IG video guidance', url: 'https://www.facebook.com/business/help/565573477186194', tier: 'meta_official', accessed: V },
    applies_when: 'Producing studio creative on a small budget.',
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  // ── niche structure + economics (principle) ───────────────────────────────────────────────────────
  {
    key: 'studio-rental-segments-benchmark',
    domain: 'structure_audience',
    claim: 'Studio renters split into repeatable segments — photographers, videographers/production, podcasters, brands/e-commerce, and consumers (milestone/personal-branding shoots, small events) — and photo studios in the originating market on Peerspace book ~3 hours and peak on Saturdays.',
    detail: 'Peerspace category data for the originating market (250+ listings): typical 3-hour booking with ~5 attendees, Saturday the most popular day, most bookings starting 1–2 PM. The renter segments (photographers, videographers/production, podcasters, brands, consumers) come from the same platform host-facing data.',
    source: { name: 'Peerspace — photo studio listings for your city (market-aggregated; re-derive for your market)', url: 'https://www.peerspace.com/', tier: 'principle', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'marketplace-take-rate-direct-advantage',
    domain: 'profit_economics',
    claim: 'Booking marketplaces take ~19–20% of host revenue (Peerspace 20%, Giggster 19%), so a direct booking keeps the ~20% a marketplace would take — direct-channel ad spend competes against a ~20% marketplace toll, and those platforms also double as discovery channels.',
    detail: 'Peerspace: 20% service fee on the booking plus add-ons; Giggster: 19% commission on the host payout. Direct bookings (which Meta ads drive) avoid the take entirely — but marketplaces bring their own demand pool a direct advertiser has to generate itself.',
    source: { name: 'Peerspace Support Center + Giggster Help Center (published platform pricing)', url: 'https://support.peerspace.com/en/articles/10119442-what-is-the-peerspace-service-fee', tier: 'principle', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  {
    key: 'local-discovery-reviews-and-social',
    domain: 'measurement',
    claim: 'For local businesses, reviews gate conversion (97% of consumers read them; 31% only use 4.5★+ businesses) and young consumers increasingly discover locally on Instagram/TikTok — which is exactly why paid social is a legitimate DISCOVERY channel for a visual product like studio space.',
    detail: 'BrightLocal 2026: Google is still the top recommendation source (71%, down from 83%) while AI tools surged 6%→45%; recency of reviews matters to 44%. Google\'s own research found ~40% of 18–24s use TikTok/Instagram over Maps/Search for local discovery.',
    source: { name: 'BrightLocal Local Consumer Review Survey 2026 + Google internal research (via TechCrunch)', url: 'https://www.brightlocal.com/research/local-consumer-review-survey/', tier: 'principle', accessed: V },
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
  // ── local seasonality (seasonality) ───────────────────────────────────────────────────────────────
  {
    key: 'local-creative-seasonality',
    domain: 'seasonality',
    claim: 'Local creative-production demand swings on a knowable calendar — major art, fashion and tourism events, school and holiday periods, and seasonal weather — so week-over-week swings must be read against that calendar before they are read as ad performance.',
    detail: 'Build the calendar for your market once: event weeks (creator and brand influx), weather seasons (outdoor shoots move indoors or stop), and holiday demand (milestone shoots, gifting). Mark each as likely lift or likely trough for an indoor rental, then annotate the dashboard windows that overlap them.',
    source: { name: 'Local market calendar research (worked-example structure in docs/research/local-service-booking-2026-07.md, Part C — replace with your own market)', url: 'https://www.peerspace.com/', tier: 'principle', accessed: V },
    applies_when: 'Interpreting week-over-week demand/performance swings; planning creative and budget timing.',
    account_relevance: 'Example-account note: re-derive the fit for your own account before relying on this entry.',
  },
]
