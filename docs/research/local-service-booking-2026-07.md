# Local-Service Booking / Studio-Rental Niche Research — July 2026

**Purpose:** cited source material for the niche expert corpus. Every claim below carries a real, live-verified source. Corpus entries (`src/lib/knowledge/entries/local-service-booking.ts`) may only be distilled from claims here tiered `meta_official` or `principle`; `practitioner`/`big_player` claims route to PENDING `expert_insights` rows instead (the owner approves them on /signals per the `expert_insights.review_status` governance).

**Provenance:** gathered 2026-07-13 by three research agents. Meta-official article bodies retrieved via Meta's Help Center API with every URL independently fetched and title-matched; practitioner/niche URLs fetched live. Two secondary corroborations (Ken Jones NYC, SPIN) were search-surfaced but not independently fetched — marked inline. Claims that could NOT be sourced are explicitly listed as **unsourced — do not use** (do not launder them into entries).

---

## PART A — META OFFICIAL (tier: `meta_official`; corpus-eligible via git PR)

### A1. Local / radius targeting mechanics

**A1.1 — Location targeting includes "recently in", not residents only.**
Default reach = people who live in OR recently spent time in the location; Meta states complete accuracy isn't guaranteed and out-of-area leads are expected behavior.
Source: About location targeting in Meta Ads Manager — https://www.facebook.com/business/help/202297959811696 (accessed 2026-07-13).
Account note (example account): some booking leads from outside the service radius are normal, not a targeting bug; "recently in" includes tourists who can't book recurring sessions.

**A1.2 — Locations are a hard audience CONTROL.**
"Because locations is an audience control, we won't target beyond your locations unless reach more people likely to respond to your ads is selected." Radius never crosses a country border; no radius on zip/state selections.
Source: Use Location Targeting (error 1870194) — https://www.facebook.com/business/help/365561350785642.

**A1.3 — The location-expansion checkbox may be ON BY DEFAULT for city/region selections.**
"Reach more people likely to respond to your ads" adds people who merely showed interest in the location (searched it, friends there, nearby towns), same-country only. Meta cites a Mar 2024 experiment: median 6.7% lower cost per optimized event — cross-vertical, "performance isn't guaranteed."
Source: How to Reach People Interested in Your Selected Cities and Regions — https://www.facebook.com/business/help/726389026372510.
Account note (example account): a drive-to-location studio gains little from people who "showed interest in Springfield" from elsewhere — this is a SETTINGS-AUDIT item (uncheck for strict geo).

**A1.4 — API radius bounds: 0.63–50 miles; location_types = home | recent (defaults to both).**
Documented only in the Marketing API reference, not the Help Center.
Source: Basic Targeting (Marketing API) — https://developers.facebook.com/docs/marketing-api/audiences/reference/basic-targeting.

**A1.5 — "Local awareness ads" no longer exist as an objective.**
Current official local surface = "Promote your business locally" Page ad type (boost-style; awareness-tier, does not optimize for website bookings).
Source: About Advertising From Your Facebook Page — https://www.facebook.com/business/help/198653350887222.

**A1.6 — Meta officially warns GA4 geo reports won't match Meta's location reporting** (different location methods); organic engagement can surface ads outside the geo.
Source: same as A1.1.
Account note (example account): directly relevant to Maxx's Meta↔GA4 reconciliation doctrine.

### A2. Advantage+ audience for local at small budgets

**A2.1 — Advantage+ audience does NOT expand geo.** Audience controls (locations, min age, excluded customs, languages) bind; "Audience suggestions won't be shown outside your audience controls." Geo expansion happens ONLY via the separate checkbox (A1.3).
Source: About Audience controls and Audience suggestions in Advantage+ audience — https://www.facebook.com/business/help/938372127764391.
Account note (example account): answers the standing "does broad leak outside the service radius" question — NO.

**A2.2 — Suggestions are non-binding hints.** Suggesting women can still deliver to men; to bind a criterion you must "further limit your audience" and uncheck "use as a suggestion."
Source: same as A2.1.

**A2.3 — Meta recommends A/B testing Advantage+ audience for almost all campaign types EXCEPT retargeting campaigns.**
Source: About Advantage+ audience — https://www.facebook.com/business/help/273363992030035.
Account note (example account): prospecting → Advantage+ audience is fine; the Warm/retargeting ad set should stay on original audience options.

**A2.4 — Meta's claimed Advantage+ audience lift:** 14.8% (awareness) / 9.7% (traffic, engagement, leads) / 7.2% (sales, app) lower cost per result — meta-analysis of 469 A/B studies, Jan 2023–Aug 2024, global, all verticals.
Source: same as A2.3.
Does-not-transfer: cross-vertical, mostly large advertisers; inside a fixed small-radius geo the expansion room is small — effect size at $50/day unproven.

**A2.5 — Official setup guidance: target "as broadly as possible" within controls;** lookalike exclusions not possible with Advantage+ audience.
Source: Create a Campaign Using Advantage+ Audience — https://www.facebook.com/business/help/793748385630490.

**A2.6 — EXPLICIT GAP: no official Meta doc addresses "local business + small budget + Advantage+" as a scenario.** Any "Meta says local businesses should go broad" claim is an INFERENCE from A2.5 + A3.4, not a quote. Label derived claims as derived.

### A3. Budget mechanics at low daily budgets

**A3.1 — No universal minimum-budget dollar table exists.** Minimums are dynamic (vertical, budget type, buying type, bid strategy, optimization, currency, schedule) and surfaced as Ads Manager alerts. Old "$1/day impressions, $5/day clicks" tables are NOT current official doc — do not enter as meta_official.
Source: Best Practices for Minimum Budgets — https://www.facebook.com/business/help/203183363050448 (error article: https://www.facebook.com/business/help/1870791083202806).

**A3.2 — Official 5x rule: daily budget ≥ 5× your cost-per-result goal** (only when using that bid strategy). For example, at $50/day a compliant cost-per-result goal caps at $10; a $45 booking-cost control would require $225/day.
Source: same as A3.1.
Account note (example account): stay on Highest Volume — Meta's own math says a $45 CPA cost-control is structurally unsupported at this budget.

**A3.3 — Learning phase exits after ~50 optimization events within 7 days of last significant edit;** learning-phase ad sets are less stable with usually-higher CPA.
Source: About the Learning Phase — https://www.facebook.com/business/help/112167992830700.
Account note (example account): at $50/day and ~$45/booking ≈ 7–8 events/week — permanently below 50; "learning limited" is the predicted steady state (matches Maxx's structurally_starved diagnosis). Structural, not a defect.

**A3.4 — "Learning limited" official causes and fixes:** causes = small audience, low budget, low bid/cost control, high auction overlap, infrequent optimization event, too many ads. Official fixes = combine ad sets/campaigns, expand audience, raise budget, raise bid/cost control, or switch to a MORE FREQUENT optimization event (example given: purchases → add to cart). "Learning limited isn't a penalty."
Source: About Learning Limited — https://www.facebook.com/business/help/269269737396981.
Account note (example account): "expand audience" conflicts with a fixed service radius — usable levers are consolidation and optimization-event choice.

**A3.5 — Official learning best practices: FEWER ad sets/ads.** "When you create many ads and ad sets, the delivery system learns less about each... By combining similar ad sets, you also combine learnings." No numeric ad-sets-per-dollar rule exists — any "1–2 ad sets max at a small daily budget" claim is DERIVED from the 50-event math.
Source: same as A3.3.

**A3.6 — Significant edits that reset learning:** any targeting change, any creative change, optimization-event change, adding a new ad to the ad set, 7+ day pause, bid-strategy change. Budget changes reset only if large ($100→$1000 yes; $100→$101 no). CBO redistribution does NOT re-trigger learning; sibling ad sets unaffected by ad-set-level edits.
Source: Significant Edits and Learning Phase — https://www.facebook.com/business/help/316478108955072.

**A3.7 — CBO vs ABO official guidance:** CBO (Advantage+ campaign budget) = flexibility/simplicity, "best suited for campaigns with at least 2 ad sets," lower under-delivery risk, may spend unequally by design — analyze at campaign level. ABO = per-ad-set control, for greatly differing ad-set values/audience sizes/optimization goals. Ad set budget sharing lets ABO ad sets share up to 20%. CBO is default for sales/leads campaigns. No official "small accounts should use X" sentence exists.
Sources: About campaign budgets and ad set budgets — https://www.facebook.com/business/help/458847204894307; About Advantage+ campaign budget — https://www.facebook.com/business/help/153514848493595; Set up — https://www.facebook.com/business/help/343242619559352.
Account note (example account): CBO can starve a tiny warm ad set (unequal spend is by design); ABO with explicit budgets is the defensible choice when retargeting must be guaranteed spend.

**A3.8 — Daily budget is a weekly average:** up to 75% over on a given day, capped at 7× daily budget per calendar week (Sun–Sat).
Source: About Daily Budgets — https://www.facebook.com/business/help/190490051321426.
Account note (example account): single days above a $50 budget (up to 175%) are NOT anomalies; flag weekly overspend, not ≤175% daily spikes (anomaly-detection threshold input).

### A4. Retargeting / custom audiences for small local pools

**A4.1 — Website custom audiences never backfill** — they populate from creation forward only; must show "Ready" before use.
Source: Create a website custom audience — https://www.facebook.com/business/help/1474662202748341.
Account note (example account): create audiences before you need them; a low-traffic local site takes weeks to populate.

**A4.2 — Official floor for a usable website audience: "several hundred people";** fixes = wait, fewer conditions (all-visitors), longer retention window. Audiences < pixel fires because only Meta-matched unique visitors count.
Source: Troubleshoot website custom audience size — https://www.facebook.com/business/help/1523083297982009.
Account note (example account): all-visitors/180-day is the realistic config; a 7-day high-intent audience will not clear the floor.

**A4.3 — The "at least 1,000" recommendation applies to CUSTOMER-LIST audiences** (upload), where Ads Manager warns below it; lists stale 30+ days flag "Outdated." Do NOT generalize 1,000 to pixel/engagement audiences.
Source: How to Use Custom or Lookalike Audiences — https://www.facebook.com/business/help/572787736078838.

**A4.4 — Page-engagement custom audiences: up to 365-day retention;** official use cases include retargeting engagers and excluding them from prospecting.
Source: Create a Facebook Page Engagement Custom Audience — https://www.facebook.com/business/help/221146184973131.
Account note (example account): the engagement pool is usually larger than the website pool for a local business; geo control filters non-local engagers at delivery (further shrinking effective size).

**A4.5 — No official numeric frequency cap exists.** Frequency "may average 1 to 2 per ad set or may be much higher"; the official signal is performance dropping AS frequency rises → change creative or targeting.
Source: Frequency — https://www.facebook.com/business/help/1546570362238584.
Account note (example account): do not attribute any numeric cap (e.g., "3x") to Meta in the corpus.

**A4.6 — Creative-limited / creative-fatigue official definitions:** flagged when cost per result runs above (creative limited) or ≥2× (fatigue) your past ads — counting ALL recent exposures of the same image/video across ALL campaigns from the Page. Remedies: materially different new ad (keeping the original active "may maximize results"), audience expansion, Advantage+ creative.
Source: Creative Fatigue Recommendations — https://www.facebook.com/business/help/1346816142327858.
Account note (example account): reusing one hero video across Cold + Warm accelerates SHARED fatigue; absence of the flag ≠ absence of fatigue (status availability is limited).

**A4.7 — Advantage+ custom audience checkbox breaks strict retargeting** — it lets Meta deliver beyond the selected custom audience. Strict retargeting = original audience options + box unchecked (pairs with A2.3).
Source: Use Advantage+ custom audience — https://www.facebook.com/business/help/414975413946182.
Account note (example account): settings-audit item for the Warm ad set.

### A5. Creative guidance (formats, video, diversification / Andromeda)

**A5.1 — Aspect ratios: 4:5 for Facebook feed, 1:1 IG feed images, 9:16 Stories/Reels, consistent 1:1 or 4:5 across carousel cards, 16:9 in-stream.** Media should cover as much screen as possible. IG Explore retires as a placement Jan 2026.
Sources: Best practices for aspect ratios — https://www.facebook.com/business/help/103816146375741; placement table — https://www.facebook.com/business/help/682655495435254.

**A5.2 — Shorter is better on mobile: feed videos <15s, Stories <10s perform best; brand/hook within first 3 seconds; design for sound-off with subtitles; 98% hold phones vertically.**
Sources: Video length specifications — https://www.facebook.com/business/help/817989058548892; Best Practices for Instagram Video Ads — https://www.facebook.com/business/help/188534925073536.

**A5.3 — Static+video mix: campaigns running BOTH achieved conversion lift at a 17% higher rate than static-only** (Meta direct-response research); official endorsement of 5–10s animated-still videos promoting a single benefit, animation in first 3s, CTA + end card.
Source: Creative Best Practices for Conversion Testing — https://www.facebook.com/business/help/565573477186194.
Account note (example account): animating existing studio stills is a cheap officially-endorsed path to video format mix.

**A5.4 — Creative DIVERSIFICATION ≠ iteration (Andromeda-era, Dec 2025):** officially defined as distinctly different assets for different personas/use cases across visuals, messaging, formats — not minor variant crops. Andromeda retrieves from tens of millions of ads; more genuinely distinct creatives = more eligible candidates for per-user personalization.
Source: Demystifying Creative Diversification — https://www.facebook.com/business/news/demystifying-creative-diversification (published 2025-12-16).
Account note (example account): distinct concepts per persona (podcasters vs photographers vs consumers) beats N crops of one video. Platform-average stats cited there (+11% CTR image gen etc.) are unmeasurable on a small monthly budget — don't quote as expected lift.

**A5.5 — Andromeda official framing (Apr 2025):** "8% improvement in ads quality"; more volume AND diversity of creative "creating more eligible ads for personalization."
Source: The Creative Advantage: Unlocking the Power of Diversification with Meta Andromeda — https://www.facebook.com/business/news/the-creative-advantage-unlocking-the-power-of-diversification-with-meta-andromeda.
Does-not-transfer: enterprise case scaled to ~50 new creatives/week; the transferable principle at $50/day is diversity of CONCEPTS, not volume.

**A5.6 — Official IG testing numbers: start with up to 10 creatives per ad set, keep top ~5 evergreen, run tests ≥4 days, mix video+static to reduce fatigue;** native-feeling creative performs better.
Source: Best Practices for Instagram Video Ads — https://www.facebook.com/business/help/188534925073536.
Account note (example account): at a handful of bookings per week, 4 days gives delivery-level signal (CTR/CPM) only — booking-level test conclusions need upstream metrics.

### A6. Explicit official-doc gaps (do not fabricate)
1. No numeric minimum-budget dollar table (A3.1).
2. No "ad sets per budget" formula — only 50-events math + consolidation guidance (A3.3–A3.5).
3. No numeric frequency cap (A4.5).
4. No local-business-specific Advantage+/small-budget doc (A2.6).
5. "Local awareness ads" objective no longer exists (A1.5).
6. Radius numeric bounds live only in the API reference (A1.4).

---

## PART B — PRACTITIONER / INDUSTRY (tier: `practitioner` / `big_player`; route through expert_insights PENDING seeds)

### B1. Budget structure at ~$50–100/day

**B1.1 — Consolidation doctrine (Loomer):** "Create fewer campaigns. Create fewer ad sets. But spend the same amount." Splitting drives auction overlap + audience fragmentation and keeps you in learning.
Source: Jon Loomer — A Simplified Meta Ads Strategy for Optimal Results — https://www.jonloomer.com/simplified-meta-ads-strategy/ (2024-05-23, updated 2025-03-06). Tier: practitioner. Confidence: high (verbatim, flagship doctrine).
Caveat: general Meta advice, not local-specific.

**B1.2 — Only two objectives worth money for virtually every business: Sales and Leads** (Loomer). Traffic/engagement/awareness yield "empty clicks."
Source: same. Tier: practitioner.
Account mapping (example account): booking event = Sales; assumes working pixel signal.

**B1.3 — One Advantage+ ad set instead of audience-segmented ad sets** (Loomer): "Once the audience expands, those multiple ad sets will be nothing but overlap."
Source: same. Tier: practitioner. Caveat: written for unconstrained geo; a small fixed radius still binds.

**B1.4 — Post-Andromeda structure (Foxwell):** one prospecting campaign, one broad ad set, many CONCEPTUALLY diverse creatives (Meta raised per-ad-set ad limit 50→150); "creative differentiation IS the targeting."
Source: Courtney Fritts — Meta Andromeda Explained — https://www.foxwelldigital.com/blog/how-andromeda-has-changed-meta-advertising-a-practical-guide (~2025-11-06). Tier: practitioner.
Caveat: DTC at large budgets; the consolidation transfers, the creative VOLUME does not.

**B1.5 — Ad-set count capped by conversion volume (CTC):** ~50 conversions/week per ad set determines max ad sets; keep ≥30% of budget out of learning.
Source: Adrianne Austin — Facebook Ads Campaigns: High-Growth Account Set-Up, Common Thread Collective — https://commonthreadco.com/blogs/coachs-corner/facebook-ads-campaign (2020-07-09). Tier: practitioner. Confidence: medium-high (pre-Advantage+ era; the volume math holds, the 2020 audience stacks don't).

**B1.6 — Small-account case (Perpetual Traffic Ep 705, 2025-06-13):** 1 campaign / 1 ad set / 50 ads Advantage+ on ~$1k/month: CPA $42→$13 (~70% cut); ads that looked dead converted after 3+ weeks — don't pause fast at small spend; "99% of your job is creative."
Source: Ralph Burns & John Moran — https://perpetualtraffic.com/podcast/episode-705-killer-meta-advantage-case-study-1-campaign-1-ad-set-50-adswhaa/. Tier: practitioner. Confidence: medium (single ecommerce case; structural lesson transfers, 50 ads doesn't).

**B1.7 — ABO for testing/control, CBO for scaling; hybrid common; at $50/day with 1–2 ad sets the distinction is nearly moot.**
Source: AdAmigo.ai — CBO vs ABO — https://www.adamigo.ai/blog/cbo-vs-abo-choosing-the-right-budget-strategy (vendor page, ~2025-2026). Tier: big_player. Confidence: medium (vendor content, consistent with consensus).

**B1.8 — At low budget, 2–3 ads per ad set (Loomer):** Meta itself says no benefit beyond ~6 ads/ad set, and at low budgets even 6 chops spend into meaninglessness.
Source: Loomer, same article. Tier: practitioner. Confidence: high.
NOTE the preserved tension: Loomer's "≤6 at low budget" vs Foxwell/Tier-11 "50–150 ads" — budget-conditional; Loomer's applies at $50/day.

### B2. Appointment/booking funnels

**B2.1 — Instant forms vs landing pages (Till Agency head-to-head):** instant forms 4,165 registrations @ $4.40 vs website forms 2,057 @ $9.51 — volume/cheap vs fewer/higher-intent; quality not guaranteed.
Source: https://till.agency/facebook-ads-instant-forms-vs-landing-page-forms/ (undated agency blog). Tier: practitioner.
Account caveat (example account): event-registration context; a $60/hr studio needs booking intent — instant forms require heavy follow-up.

**B2.2 — Optimize for the exact action, never a proxy** (Loomer): link-click/LPV optimization buys junk clicks; "Set a performance goal that defines exactly what you want."
Source: Loomer, same article. Tier: practitioner. Confidence: high.
Pair with A3.4's official upstream-event exception when volume can't hit 50/wk.

**B2.3 — Conversion Leads goal (CRM feedback via CAPI) cuts cost per QUALITY lead ~19% but needs ~200+ leads/month.**
Source: Marco Cirillo — LeadsBridge (Meta Business Partner) — https://leadsbridge.com/blog/conversion-leads-optimization-facebook/ (2025-12-22). Tier: big_player.
Account caveat (example account): 200/month floor is above a small account's volume — a "when you scale" pattern, not a now-action.

**B2.4 — Offer design: price-led intro offers fill the calendar with non-returners; experience/value-positioned offers convert fewer but retain dramatically better.** Med-spa case: price offer = 80 patients/mo, 79% never returned; experience offer = 28 patients, 91% retention; short-dated intro offers OK, permanent discounting not.
Source: Mike Funkhouser — Meta Ads for Med Spas, Practice Growth Co — https://practicegrowthco.com/blog/meta-ads-for-med-spas (2026-05-18). Tier: practitioner. Confidence: medium-high (proprietary case data).
Account mapping (example account): the studio's "experience-positioned offer" analog is showing the space/results, not discounting the hour.

**B2.5 — Cross-vertical appointment benchmarks (med-spa, 2025-26 agency data):** CPL $15–68 by service; lead→consult 22–55% (cost per booked consult ≈ 2–3× CPL); monthly budget floor for meaningful volume $2,500–4,500/location.
Source: same as B2.4. Tier: practitioner. **CROSS-VERTICAL HEURISTIC ONLY — never a target for this account.**

**B2.6 — Speed-to-lead dominates lead-form funnels:** immediate calls convert 40–60%; 24h+ waits drop to 15–25% — "larger than creative quality, larger than targeting."
Source: same as B2.4. Tier: practitioner.
Account caveat (example account): applies only if lead forms are ever tested — the self-serve Acuity flow bypasses callback loops.

**B2.7 — "The offer is the ad" (fitness/wellness local):** specific, time-bound, risk-reversed intro offers are the biggest lever; $35–80 per BOOKED trial via paid social; >$100 = funnel problem, not ad problem.
Source: Chinmay — Fitness Marketing: 15 Strategies, Optimized Growth — https://optimizedgrowth.com/blog/fitness-marketing/ (2026-04-28). Tier: practitioner. Confidence: medium.
Account caveat (example account): fitness LTV supports paid trials; transferable idea = offer specificity + risk reversal, and the rare cost-per-BOOKED benchmark brackets a $45 example target.

**B2.8 — Local case study existence-proof (2019):** boutique yoga/cycle studio: 177 leads/60 days @ $5.67 CPL ($1,003 spend), free-first-class offer, lead forms, local geo; retargeting leads $1.63.
Source: Rahul Alim — Custom Creatives — https://customcreatives.com/local-gym-facebook-case-study/ (~2019-04). Tier: practitioner. Confidence: medium — **2019 costs, roughly 2× cheaper era; existence-proof only, not a benchmark.**

**B2.9 — Price IN the ad = lower CTR, higher lead quality:** clickers pre-qualify; cleaner click signal helps optimization post-iOS14.
Source: Meredith Kallaher — Always Include the Price — https://meredithkallaher.com/blog/always-include-the-price-in-your-facebook-and-instagram-advertisements-in-2023/ (2023-01-12). Tier: practitioner. Confidence: medium (argument, not controlled data).
Account note (example account): good fit for a transparent $60/hr offer.

### B3. Local-service creative mix

**B3.1 — "Ugly"/native ads bypass ad-blindness (Barry Hott):** less-polished variants beat polished in a brand-lift test (~30% lift in action intent, Lone Ranch Water); caveat from Hott himself: "ugly ads can still be bad ads" — storytelling decides.
Source: Barry Hott — hottgrowth.com — https://www.hottgrowth.com/post/ugly-ads-dont-mean-bad-ads-try-these-expert-tips-for-high-intent-ads (~2022-23). Tier: practitioner.
Account transfer (example account): phone-shot walkthroughs of the space, not degraded quality for its own sake — a premium studio still sells on aesthetics.

**B3.2 — Hook-first iteration (Savannah Sanchez via Motion):** most creative leverage lives in the first ~3s; hold body constant, swap hooks; Meta treats a variation as "new" only when the first 3–5s differ visually; high-performing hooks decay (~37% drop after 7 days at DTC spend).
Source: Melissa Rosen (Motion) citing Savannah Sanchez — https://motionapp.com/blog/best-dtc-meta-ad-hooks-2025 (~2025-06). Tier: practitioner. Confidence: high on doctrine, medium on percentages.
Account caveat (example account): 7-day fatigue cycles assume high spend — a $50/day local account fatigues much slower; hook discipline transfers, refresh cadence does not.

**B3.3 — Creative diversity replaced audience targeting (Foxwell):** build for personas/angles (founder story vs testimonial, problem vs aspirational, studio vs UGC) in ONE ad set; each creative is its own targeting.
Source: Foxwell Andromeda guide (B1.4 URL). Tier: practitioner.
Account mapping (example account): podcaster angle vs photographer angle vs consumer-event angle as separate concepts.

**B3.4 — Local fitness/wellness: vertical Reels-style 15–30s video (sound-off readable) outperforming statics 2–3×; real facility footage + real testimonials beat stock/polished.**
Source: Optimized Growth (B2.7 URL) (2026-04-28). Tier: practitioner. Confidence: medium (agency observation).
Account note (example account): closest published analog to "show the space" doctrine.

**B3.5 — "99% of your job is creative" at consolidated small accounts** (John Moran, PT Ep 705): once structure is consolidated, performance differences come almost entirely from creative.
Source: B1.6 URL. Tier: practitioner. Confidence: medium (rhetorical; competes with B2.7 "the offer is the ad" — preserve both, let evidence decide).

### B4. Retargeting for small local audiences

**B4.1 — "Remarketing is mostly dead" as a separate ad set (Loomer):** the algorithm already auto-targets pixel/engagement history when you go broad; feed warm audiences as Advantage+ suggestions instead of dedicated warm ad sets. "You can't keep targeting your email list and website visitors while spending $100 per day and expect good results beyond a short window."
Source: Loomer (B1.1 URL). Tier: practitioner. Confidence: high — the single most relevant published claim for a tiny small-radius warm pool.
NOTE: directly challenges the account's current Cold/Warm 2-ad-set split — surface as a hypothesis for the owner, not a directive; some large accounts still prove out separated retargeting via holdouts.

**B4.2 — Consolidate remarketing INTO evergreen full-funnel campaigns (CTC, 2020):** separate warm structures mainly for seasonal/sale moments.
Source: Adrianne Austin — Facebook Retargeting Ads in Ecommerce, CTC — https://commonthreadco.com/blogs/coachs-corner/facebook-ads-retargeting (2020-10-02). Tier: practitioner. Confidence: medium (pre-iOS14 era, but direction later vindicated).

**B4.3 — Exclude existing customers from paid; let email/SMS carry repeat business (Foxwell).**
Source: B1.4 URL. Tier: practitioner.
Account caveat (example account): repeat bookings are core studio revenue and the customer list is tiny — the transferable point is free owned-channel rebooking, not the exclusion itself.

**B4.4 — Frequency bands by audience size (AdAdvisor, 2026-06-24):** healthy ~1.5–3 cold (500K+); 5–15 site-visitor retargeting (10K–100K); 10–25 small customs (1K–10K). High frequency alone ≠ problem; act on frequency + declining CTR/ROAS + single stale creative.
Source: Wissam Hallak — https://adadvisor.ai/blog/frequency-cap-facebook. Tier: big_player. Confidence: medium (vendor, but the most concretely parameterized guidance found).
Account caveat (example account): a small-radius warm pool may be <1K, where delivery gets erratic regardless.

**B4.5 — Survey heuristic (Databox):** plurality of ~70 marketers put optimal retargeting frequency at 5–10/month; observed median overall ~2.4–2.5; price-tier guidance $100–500 products: 5–7×/30d.
Source: Filip Stojanovic — https://databox.com/facebook-ads-frequency (2023-01, updated ~2024-02). Tier: big_player. Confidence: medium (small n, self-reported).

### B5. Published benchmarks (cross-vertical heuristics, NEVER account targets)

**B5.1 — WordStream/LocaliQ 2025 US leads-campaign benchmarks:** avg CPL $27.66 (+20.9% YoY), CTR 2.59%, CPC $1.92 (726 US leads campaigns, Apr 2024–Jun 2025).
Source: Susie Marino — https://www.wordstream.com/blog/facebook-ads-benchmarks-2025 (2025-09-15). Tier: big_player. Confidence: high (largest recent public SMB dataset).

**B5.2 — Closest-vertical 2025 CPL/CVR:** Arts & Entertainment $18.17 CPL / 9.34% CVR / 3.92% CTR; Personal Services $30.57 / 6.51%; Beauty & Personal Care $51.42 / 5.29%; Health & Fitness $52.98 / 5.63%.
Source: LocaliQ — https://localiq.com/blog/facebook-advertising-benchmarks/ (2025-10-24). Tier: big_player.
**These are LEAD costs, not booking costs — sanity band only.** (Matches the already-seeded vertical-benchmarks governance.)

**B5.3 — Appointment-vertical cost-per-BOOKED benchmarks:** med-spa consult path (B2.5) and fitness $35–80/booked trial (B2.7) — the only published cost-per-BOOKED bands found; they bracket a $45 example target from neighboring verticals.

### B-X. Folklore checked and NOT sourceable — DO NOT USE
1. **"70/20/10 (or 70/30, 80/20) prospecting/testing/retargeting split"** — circulates on low-authority vendor blogs with contradictory numbers, no primary source; credible practitioners (Loomer, CTC, Foxwell) now argue AGAINST fixed splits. If a split heuristic is wanted, cite B4.1 instead.
2. **"UGC beats studio-shot by ~25% CPA for local"** — traces to an unverifiable DTC skincare anecdote on aggregators. Use B3.1/B3.4 instead.
3. **"~50 events/week to exit learning"** — TRUE but it's Meta's own guidance (A3.3): tier as meta_official, never as an independent practitioner finding.

---

## PART C — NICHE STRUCTURE + LOCAL SEASONALITY (tier: `principle`)

The original research in this part was built from one city's public event calendar and marketplace
listings. It has been replaced with the structure to rebuild it for your own market, because the
specifics do not transfer.

### C1. Segment structure
Studio renters split into repeatable segments — photographers, videographers/production, podcasters,
brands/e-commerce, and consumers (milestone and personal-branding shoots, small events). Pull your
market's marketplace listings (Peerspace, Giggster) to read typical hourly rates, booking length and
attendee counts per segment; the example business's pricing should be compared with that median.

### C2. Marketplace economics
Booking marketplaces take roughly 19–20% of host revenue (Peerspace 20% service fee, Giggster 19%
commission; see their published pricing pages). A direct booking driven by your own ads avoids the
take, which widens the CPA headroom versus a naive comparison.

### C3. Local discovery
Reviews gate conversion for local businesses and discovery increasingly happens on Instagram and
TikTok (BrightLocal Local Consumer Review Survey; Google research via TechCrunch). A below-4.5★ profile
suppresses paid conversion regardless of creative.

### C4. Seasonality calendar (rebuild for your market)
List: major art/fashion/tourism event weeks (creator and brand influx), weather seasons (outdoor shoots
move indoors or stop), holiday demand windows (milestone shoots, gifting), and local school calendars.
Mark each as likely lift or likely trough for an indoor rental and annotate the dashboard windows that
overlap them before reading any week-over-week swing as ad performance.
