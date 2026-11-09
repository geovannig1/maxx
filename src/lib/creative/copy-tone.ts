// N6 — copy-tone governance for AI-generated ad copy. One exported ruleset + a pure validator.
// The ruleset is injected into the copy-generation prompt (so the model writes in-voice) AND used to
// post-check the output (violations are FLAGGED, never silently rewritten). Goal: a human, ghost-written
// voice — no AI slop, no buzzwords, no em dashes.

import { renderBrandFactsLine, renderUnverifiedCaveat } from '@/lib/knowledge/brand-facts'
import { promptBusinessLine } from '@/config/prompt-business'
import { BANNED_WORDS } from './banned-words'

/** AI-slop / buzzwords that must not appear in ad copy (shared list, ./banned-words). */
export { BANNED_WORDS }

/** The tone ruleset — injected verbatim into the copy-generation system prompt. */
export const COPY_TONE_RULES = `COPY TONE RULES (non-negotiable):
- Write like a human ghost-writer who knows this business, not like an AI. Plain, direct, specific.
- NO em dashes. Use a period or a comma instead.
- NO AI buzzwords or slop: unlock, elevate, game-changer, supercharge, unleash, seamless, cutting-edge, leverage, empower, world-class, "take it to the next level", "look no further", "the power of".
- Short sentences. Aim for a ~6th-grade reading level.
- Concrete over abstract: name the real thing (the actual room, product or service), not "premium creative space".
- No hype punctuation (no "!!", no ALL-CAPS words).`

export interface CopyToneViolation {
  rule: 'no_em_dash' | 'banned_words' | 'hype_punctuation'
  detail: string
}

/** PURE: check one piece of copy against the ruleset. Returns the violations found ([] = clean). */
export function checkCopyTone(text: string | null | undefined): CopyToneViolation[] {
  const out: CopyToneViolation[] = []
  if (!text) return out
  if (text.includes('—')) out.push({ rule: 'no_em_dash', detail: 'Contains an em dash (—).' })
  const lower = text.toLowerCase()
  const hits = BANNED_WORDS.filter((w) => lower.includes(w))
  if (hits.length) out.push({ rule: 'banned_words', detail: `Banned buzzwords: ${[...new Set(hits)].join(', ')}.` })
  if (/!{2,}/.test(text)) out.push({ rule: 'hype_punctuation', detail: 'Contains "!!" hype punctuation.' })
  return out
}

/** Run checkCopyTone over the copy-bearing fields of a brief-like object; returns flat violations tagged
 *  by field. Used to surface (never rewrite) slop before a generated brief is stored / sent for approval. */
export function checkBriefTone(brief: Record<string, unknown>): string[] {
  const fields = ['hook', 'headline', 'concept', 'script', 'title', 'angle']
  const msgs: string[] = []
  for (const f of fields) {
    const v = brief[f]
    if (typeof v !== 'string') continue
    for (const viol of checkCopyTone(v)) msgs.push(`${f}: ${viol.detail}`)
  }
  return msgs
}

/** Dedicated system prompt for ad-copy generation — carries the tone ruleset, split off the daily-REPORT
 *  prompt (which had zero copy governance). Facts interpolate from brand-facts (the single source) —
 *  this prompt previously hardcoded "makeup station" as verified while brand-facts lists it as
 *  REQUIRES-VERIFICATION, so the brief generator was grounding copy in a claim Maxx is told never to assert. */
export const COPY_SYSTEM_PROMPT = `You are a senior direct-response copywriter for ${promptBusinessLine()}. You write ad copy that sounds like a real person who knows the business, never like an AI.

${COPY_TONE_RULES}

Ground every claim in verified facts about the business (${renderBrandFactsLine()}). ${renderUnverifiedCaveat()} When asked for JSON, return ONLY the JSON, no markdown, no commentary.`
