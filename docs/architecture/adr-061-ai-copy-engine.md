# ADR-061: AI copy engine (Copy studio)

Status: accepted 2026-11-08 (owner decision: Maxx writes and scores Meta ad copy in the brand's voice).
Numbering: 059 and 060 are left for the changes-loop and chat-UI work landing in parallel; this record
takes 061 so the three cannot collide.

## Context

Maxx already held the pieces of a copywriter without the copywriter: verified brand facts and a
requires-verification list (`src/config/business-profile.ts`, `src/lib/knowledge/brand-facts.ts`),
tone rules and a slop list (`copy-tone.ts`), a cited hook-pattern corpus (`hook-corpus.ts`), and a
ranking of the copy that actually ran (`copy-performance.ts`). The copy bank (`copy_variations`)
stored drafts typed by hand. Nothing turned a brief into ad copy, and nothing checked copy before it
ran, so an install with AI off had no copy review at all.

## Decision

1. **Scoring is deterministic and comes first.** `src/lib/creative/copy-scorer.ts` (with
   `copy-claims.ts`, `copy-text.ts`, `copy-rules.ts`) scores a variant, pasted text or an existing ad
   with the same rules: Meta length limits and truncation risk (hook 80 ideal / 125 visible, headline
   40, description 30, hard caps 125/2200/255/255), hook front-loading and strength, Flesch-Kincaid
   grade, slop words (a banned word inside a verified fact, such as "seamless paper backdrops", is the
   business's vocabulary), em dashes, hype, clickbait, unverified claims (numbers, superlatives,
   guarantees, social proof not stated in the verified facts, anything on the requires-verification
   list), Meta policy risk (personal attributes, health and money promises, guaranteed outcomes,
   before/after), CTA validity against the Ads API enum and goal fit, and near-duplicates plus
   repeated angles across a set (Meta's delivery system groups near-identical ads). Score = 100 minus
   30 per blocker and 10 per warning, capped at 40 with any blocker; a blocker makes copy not
   publishable. Every finding has a reason and a fix.
2. **Generation is one structured call through the gateway** (`copy-generator.ts`, feature
   `copy_generation`), grounded in the profile's verified facts (the same `promptBrandFacts` rule as
   every prompt: an unconfigured example profile states nothing), up to five ranked hooks from the
   last 30 days, and the hook corpus. The output schema fixes the fields, the CTA enum and the allowed
   angles. Social proof is an allowed angle only when a verified fact carries reviews, ratings or
   clients. The model's JSON is untrusted: each variant is validated alone; repeated angles,
   near-duplicates (including of the variant being regenerated) and unbacked social proof are dropped
   with a reason; every kept variant is scored; one with a blocker, or one the model itself reports an
   unverified claim for, is returned `blocked`.
3. **AI off answers before any work.** The generate route returns 409 `AI_OFF` ("connect a provider
   in Settings") before the rate limit, the database or the provider; the page disables the button
   with the same reason. Scoring, the bank and the existing-ads review keep working.
4. **The bank is the existing `copy_variations` table**: no schema change. A saved variant is one row
   per field (`hook`, `primary_text`, `headline`, `description`, `cta`, so the Hooks library tabs show
   them), inserted in one statement so the rows share `created_at`, which is how they regroup.
   `model_used` is `copy_studio` (or `copy_studio:sample` for the demo's hand-written examples); the
   notes carry audience and goal. The server re-scores on save and refuses blocked copy (422).
5. **Routes** (`/api/creative/copy/{generate,score,bank}`): same-origin, signed-in owner, per-owner
   rate limits (10/10 min, 120/10 min, 60/hour), bodies capped before buffering (8 KB, 64 KB, 16 KB)
   and validated with strict zod schemas (`copy-brief.ts`). No route writes to Meta.
6. **Server functions for the chat wave**: `generateCopy(input)` and `scoreCopy(text | variant)`
   (`src/lib/creative/copy-studio.ts`) return typed results and never throw for AI outcomes.
7. **Demo**: four hand-written variants in `scripts/demo/sample/demo-copy.ts`, seeded into the
   copy bank and labelled "Sample example (demo data, not AI)". The demo runs with AI off, so the page
   shows the AI-off state; the gateway allows the score route (it stores nothing) and still refuses
   generate and save.

## Consequences

- Any install gets a copy review of its running ads with no model and no cost.
- The claim detector is conservative: every number not in the verified facts blocks, including
  harmless ones ("15-second tour"). That is deliberate (a false alarm costs a rewrite; an unverified
  claim can cost an ad account) and is fixed by adding the fact to the business profile.
- Grouping bank rows by `created_at` relies on one insert per variant. Rows typed on the Hooks page
  are not Copy-studio rows (`model_used` is null) and never regroup with them.
- Policy and slop lexicons are English. Other locales get length, CTA, duplicate and number checks;
  the word lists need translation before they mean anything there.
- Not done here: chat integration (later wave), A/B launch of variants, learning weights from
  delivery. Copy scores say nothing about results; delivery and outcomes stay on the reports.
