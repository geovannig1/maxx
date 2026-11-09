# Meta Official Best Practices — research pass (2026-07-10)

Primary-source verification of Meta's current official advertising guidance, for the Example Studio knowledge
corpus (`src/lib/knowledge/`). Confidence tiers: `meta_official` (facebook.com/business, developers.facebook.com,
engineering.fb.com) · `practitioner` (named, long-tenured specialists — e.g. Jon Loomer) · low-confidence
SEO-mill claims were dropped or flagged. Account context (example account): a small capped daily budget,
a fixed local service radius, a low weekly booking-event count (mostly organic), pixel-only, structurally
Learning-Limited.

## Headline verdicts on the three claims Maxx hard-codes

1. **~50 optimization events / ad set / 7 days to exit learning — SURVIVES** (Meta-official, current).
   Sources: facebook.com/business/help/112167992830700, /269269737396981. A circulating "25 for
   Advantage+ Shopping (Apr 2026)" figure is NOT corroborated by Meta — do not encode.
2. **Significant edits reset learning — SURVIVES.** Pausing; changes to optimization event, audience,
   creative, bid strategy; budget changes above ~20% (the exact % held at medium confidence — primary page
   JS-gated). Sources: /316478108955072, /942374239243867. "Andromeda tightened thresholds in 2026"
   claims are uncorroborated secondary — do not encode a new number.
3. **~5× target CPA daily budget to exit learning — FAILS as Meta-official.** Zero primary Meta source
   states any budget-to-CPA ratio; Meta's learning-limited causes are qualitative (small audience, low
   budget, low bid/cost control, high auction overlap, infrequent event, too many ads). The 5× figure is
   an agency heuristic amplified by SEO. Keep only as a labeled INDUSTRY HEURISTIC.

## Key findings by area (condensed; each encoded in the corpus where load-bearing)

**Performance 5 (canonical framework, current):** account simplification · creators for direct response ·
creative diversification · Conversions API quality (redundant events + EMQ) · results validation via
Conversion Lift. Sources: facebook.com/business/news/meta-performance-5-techniques, Blueprint course.
Fit: simplification indicts a 2-set split at a small daily budget; CAPI is the usual gap for a
pixel-only account; Lift is unreachable at this volume.

**Learning phase:** exit bar + learning-limited causes as above. Fit: site-wide volume is below the bar
before splitting — permanent Learning Limited; optimize the controllable levers instead of chasing exit.

**Advantage+/Andromeda:** Andromeda = creative-signal-led retrieval (engineering.fb.com 2024-12-02;
rollout-complete reports early 2026, medium confidence). Advantage+ audience treats inputs as suggestions.
Generic "2–10M audience" sizing guidance is secondary-only and DOES NOT TRANSFER to a hyper-local
drive-to business — geographic ceiling is a business constraint (encoded as fit-discipline).

**Objectives & events for booking businesses:** OUTCOME_LEADS + Website conversion location + custom
pixel event is valid and current (/2035196646663270). Meta recommends STANDARD events over custom where
one fits (global training data; /402791146561655): standard **Schedule** = appointment WITHOUT payment;
**Purchase** = with payment. Account note: when the pixel already fires Schedule + Purchase at parity
with AppointmentConfirmed (same GTM trigger), mapping/optimization on a standard event is a
zero-tracking-work option; Purchase-vs-Schedule hinges on whether Acuity collects payment (owner to confirm). Value
optimization requires ~30 purchases w/ ≥5 distinct values (or ~100 custom events) per 14d (Loomer,
medium) — hard NO at current volume.

**CAPI / signal quality:** dedup spec (identical event_name + event_id, or external_id+fbp; required
action_source, event_source_url, client_user_agent; recommended email/phone/name/IP) —
developers.facebook.com/documentation/ads-commerce/conversions-api/best-practices (primary, high).
EMQ 0–10; ~6 is the commonly-referenced benchmark (medium). CAPI Gateway = Meta-built self-service
middle path (own cloud account; not zero-lift). Circulating "95–99% vs 70–80% capture" percentages are
NOT Meta-sourced — direction is real, numbers are not citable.

**Attribution (2026):** on 2026-01-12 Meta removed 7-day-view and 28-day-view windows; remaining:
1d-click, 7d-click, 1d-view, 1d-engaged-view (renamed March 2026). Medium-high (Supermetrics + broad
corroboration; not primary-fetched). Account fit: 1d-view/7d-click remains valid; owner should confirm
the setting didn't silently shift during the migration.

**Budget & bidding:** platform floors ~$1–5/day are floors, not delivery guidance; CBO is Meta's
default preference (the exact "-4.6% CPA" figure is unverified) — with the practitioner caveat that CBO
across cold/warm starves cold; cost-per-result-goal exists but is volume-hungry.

**Creative:** 9:16 Reels/Stories, 4:5 feed; first ~3 seconds decisive (industry-consistent; specific
engagement-% claims are SEO-inflated). Standalone Flexible ad format deprecating ~March 2026, absorbed
into Advantage+ creative (/835561738423867 + secondary).
