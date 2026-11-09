// Deterministic ad-copy scorer: no model, no network, same answer every time. Scores a generated
// variant, a pasted piece of copy or an ad that already ran, with the same rules, so AI-off installs
// still get a useful copy review.
//
// Score: 100 minus a fixed penalty per finding (blocker 30, warning 10), capped at 40 when any blocker
// exists. A blocker (unverified claim, policy risk, hard length cap, invalid CTA, empty copy) makes
// the copy not publishable; warnings are fixes, not vetoes. Every finding carries a reason and a fix.

import { extractHook } from './copy-performance'
import { detectPolicyRisks, detectUnverifiedClaims } from './copy-claims'
import {
  BANNED_COPY_WORDS, CLICKBAIT_PHRASES, COPY_LIMITS, GOAL_CTAS, META_CTAS, WEAK_HOOK_OPENERS,
  ctaLabel, type CopyField, type CopyGoal,
} from './copy-rules'
import { containsPhrase, factBigrams, fleschKincaidGrade, normalizeText, similarity, words } from './copy-text'

export interface CopyVariantInput {
  hook?: string | null
  primary_text?: string | null
  headline?: string | null
  description?: string | null
  cta?: string | null
  angle?: string | null
}

/** What the business has verified (may be stated) and what it has not (must never be stated). */
export interface VerifiedFacts {
  statements: readonly string[]
  unverified: readonly string[]
}

export interface ScoreOptions {
  facts: VerifiedFacts
  goal?: CopyGoal
}

export type CopyRuleId =
  | 'empty_field' | 'length_limit' | 'truncation_risk' | 'hook_front_loaded' | 'hook_strength' | 'readability'
  | 'banned_words' | 'em_dash' | 'hype_punctuation' | 'clickbait' | 'unverified_claim' | 'policy_risk'
  | 'cta_invalid' | 'cta_goal_fit' | 'near_duplicate' | 'angle_repeated'

export interface CopyFinding {
  rule: CopyRuleId
  severity: 'blocker' | 'warning'
  field: CopyField | 'cta' | 'variant'
  message: string
  fix: string
}

export interface CopyScore {
  score: number
  verdict: 'strong' | 'good' | 'needs_work' | 'blocked'
  publishable: boolean
  findings: CopyFinding[]
  metrics: {
    hook_strength: number | null
    readability_grade: number | null
    lengths: Record<CopyField, number>
  }
}

const PENALTY = { blocker: 30, warning: 10 } as const
const BLOCKED_CAP = 40
const HOOK_WEAK_BELOW = 50
const READABILITY_MAX_GRADE = 9
export const NEAR_DUPLICATE_AT = 0.5
const IMPERATIVES = ['book', 'stop', 'try', 'see', 'get', 'meet', 'shoot', 'skip', 'bring', 'save', 'grab', 'claim', 'join', 'start', 'make', 'pick', 'come', 'take']
const ACRONYMS = new Set(['UGC', 'DIY', 'USA', 'NYC', 'LED', 'RGB', 'FAQ', 'ASAP', 'HDR', 'POV'])
const TEXT_FIELDS: CopyField[] = ['hook', 'primary_text', 'headline', 'description']

const finding = (rule: CopyRuleId, severity: CopyFinding['severity'], field: CopyFinding['field'], message: string, fix: string): CopyFinding =>
  ({ rule, severity, field, message, fix })

/** 0..100: short, specific, concrete openers score high; generic ad-speak scores low. */
export function hookStrength(hook: string, facts: VerifiedFacts): number {
  const text = normalizeText(hook)
  const ws = words(hook)
  let score = 40
  if (hook.length <= COPY_LIMITS.hook.ideal) score += 10
  if (hook.length > COPY_LIMITS.hook.visible) score -= 30
  if (hook.length < 20) score -= 10
  if (hook.includes('?')) score += 10
  if (/\d/.test(hook)) score += 10
  if ([...factBigrams(facts.statements)].some((pair) => text.includes(pair))) score += 15
  if (ws.includes('you') || ws.includes('your')) score += 5
  if (IMPERATIVES.includes(ws[0] ?? '')) score += 10
  if (WEAK_HOOK_OPENERS.some((opener) => text.startsWith(opener))) score -= 30
  if (BANNED_COPY_WORDS.some((w) => containsPhrase(hook, w))) score -= 15
  if (CLICKBAIT_PHRASES.some((p) => containsPhrase(hook, p))) score -= 20
  return Math.max(0, Math.min(100, score))
}

function lengthFindings(field: CopyField, text: string): CopyFinding[] {
  const limit = COPY_LIMITS[field]
  if (text.length > limit.max) {
    return [finding('length_limit', 'blocker', field, `${field} is ${text.length} characters; the limit is ${limit.max}.`, `Cut it to ${limit.max} characters or fewer.`)]
  }
  const visible = field === 'hook' ? COPY_LIMITS.hook.ideal : limit.visible
  if (field !== 'primary_text' && text.length > visible) {
    return [finding('truncation_risk', 'warning', field, `${field} is ${text.length} characters; about ${visible} show before it is cut off on mobile.`, `Front-load the point in the first ${visible} characters.`)]
  }
  return []
}

/** True when the banned word appears in the text as part of a verified fact ("seamless paper"). */
function usedAsFact(text: string, banned: string, statements: readonly string[]): boolean {
  const target = words(banned)
  return statements.some((statement) => {
    const ws = words(statement)
    for (let i = 0; i + target.length <= ws.length; i++) {
      if (target.some((t, k) => ws[i + k] !== t)) continue
      const before = i > 0 ? [ws[i - 1], ...target] : null
      const after = i + target.length < ws.length ? [...target, ws[i + target.length]] : null
      if ([before, after].some((phrase) => phrase && containsPhrase(text, phrase.join(' ')))) return true
    }
    return false
  })
}

function toneFindings(field: CopyField, text: string, facts: VerifiedFacts): CopyFinding[] {
  const out: CopyFinding[] = []
  const factsText = facts.statements.join(' \n ')
  const banned = BANNED_COPY_WORDS.filter((w) => containsPhrase(text, w))
    .filter((w) => !usedAsFact(text, w, facts.statements))
  if (banned.length) out.push(finding('banned_words', 'warning', field, `Reads as AI slop: ${banned.join(', ')}.`, 'Name the real thing instead (the room, the light, the price).'))
  if (/[—–]/.test(text)) out.push(finding('em_dash', 'warning', field, 'Contains an em or en dash.', 'Use a period or a comma.'))
  const caps = (text.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !ACRONYMS.has(w) && !containsPhrase(factsText, w))
  if (/!{2,}/.test(text) || caps.length > 0) out.push(finding('hype_punctuation', 'warning', field, 'Hype punctuation or ALL-CAPS words.', 'One exclamation mark at most, sentence case.'))
  const bait = CLICKBAIT_PHRASES.filter((p) => containsPhrase(text, p))
  if (bait.length) out.push(finding('clickbait', 'warning', field, `Clickbait phrasing: ${bait.join(', ')}.`, 'Say what they get; Meta demotes engagement bait.'))
  return out
}

function claimFindings(field: CopyField, text: string, facts: VerifiedFacts): CopyFinding[] {
  const out: CopyFinding[] = detectUnverifiedClaims(text, facts.statements, facts.unverified).map((hit) => hit.kind === 'requires_verification'
    ? finding('unverified_claim', 'blocker', field, `"${hit.text}" is listed as requires verification in the business profile.`, 'Remove it, or verify it and add it to the profile as a fact.')
    : finding('unverified_claim', 'blocker', field, `Unverified ${hit.kind.replace(/_/g, ' ')} "${hit.text}": not in the verified brand facts.`, 'Remove it or replace it with a verified fact.'))
  for (const hit of detectPolicyRisks(text)) {
    out.push(finding('policy_risk', hit.severity, field, `Meta policy risk (${hit.kind.replace(/_/g, ' ')}): "${hit.text}".`,
      hit.kind === 'personal_attribute' ? 'Describe the offer, not the person ("for product shoots", not "are you...").' : 'Rephrase without promising or implying a personal outcome.'))
  }
  return out
}

function ctaFindings(cta: string | null | undefined, goal: CopyGoal | undefined): CopyFinding[] {
  if (!cta) return []
  if (!(META_CTAS as readonly string[]).includes(cta)) {
    return [finding('cta_invalid', 'blocker', 'cta', `"${cta}" is not a Meta call-to-action button.`, `Pick one of: ${META_CTAS.slice(0, 6).join(', ')}…`)]
  }
  if (goal && !GOAL_CTAS[goal].includes(cta as (typeof META_CTAS)[number])) {
    return [finding('cta_goal_fit', 'warning', 'cta', `${ctaLabel(cta)} is a weak fit for a ${goal} goal.`, `Use ${ctaLabel(GOAL_CTAS[goal][0])} instead.`)]
  }
  return []
}

function summarize(findings: CopyFinding[], metrics: CopyScore['metrics']): CopyScore {
  const blocked = findings.some((f) => f.severity === 'blocker')
  const raw = 100 - findings.reduce((total, f) => total + PENALTY[f.severity], 0)
  const score = Math.max(0, Math.min(blocked ? BLOCKED_CAP : 100, raw))
  const verdict = blocked ? 'blocked' : score >= 85 ? 'strong' : score >= 70 ? 'good' : 'needs_work'
  return { score, verdict, publishable: !blocked, findings, metrics }
}

/** The score with extra findings folded in (penalties and verdict recomputed). */
export function withFindings(score: CopyScore, extra: readonly CopyFinding[]): CopyScore {
  return extra.length ? summarize([...score.findings, ...extra], score.metrics) : score
}

/** Score one ad variant field by field. Missing fields are skipped; an entirely empty variant is blocked. */
export function scoreCopyVariant(variant: CopyVariantInput, options: ScoreOptions): CopyScore {
  const { facts, goal } = options
  const text = (field: CopyField) => (variant[field] ?? '').trim()
  const lengths = Object.fromEntries(TEXT_FIELDS.map((f) => [f, text(f).length])) as Record<CopyField, number>
  const findings: CopyFinding[] = []
  if (TEXT_FIELDS.every((f) => !text(f))) {
    findings.push(finding('empty_field', 'blocker', 'variant', 'There is no copy to score.', 'Add primary text and a headline.'))
    return summarize(findings, { hook_strength: null, readability_grade: null, lengths })
  }
  const frontLoaded = !text('hook') || !text('primary_text')
    || normalizeText(text('primary_text')).startsWith(normalizeText(text('hook')).replace(/[.!?]+$/, ''))
  for (const field of TEXT_FIELDS) {
    const value = text(field)
    if (!value) continue
    findings.push(...lengthFindings(field, value))
    // A front-loaded hook repeats the opening of the primary text: its tone and claims are read once, there.
    if (field === 'hook' && text('primary_text') && frontLoaded) continue
    findings.push(...toneFindings(field, value, facts), ...claimFindings(field, value, facts))
  }
  const hook = text('hook') || extractHook(text('primary_text')) || ''
  if (!frontLoaded) {
    findings.push(finding('hook_front_loaded', 'warning', 'primary_text', 'The primary text does not open with the hook.', `Start the primary text with the hook; only ~${COPY_LIMITS.primary_text.visible} characters show before "See more".`))
  }
  const strength = hook ? hookStrength(hook, facts) : null
  if (strength !== null && strength < HOOK_WEAK_BELOW) {
    findings.push(finding('hook_strength', 'warning', 'hook', `Weak hook (${strength}/100): generic, long or vague.`, 'Open with a specific detail, a number you can verify, or a direct question.'))
  }
  const grade = fleschKincaidGrade(text('primary_text') || text('hook'))
  if (grade !== null && grade > READABILITY_MAX_GRADE) {
    findings.push(finding('readability', 'warning', 'primary_text', `Reads at grade ${grade}; ad copy lands best around grade 6.`, 'Use shorter sentences and plainer words.'))
  }
  findings.push(...ctaFindings(variant.cta, goal))
  return summarize(findings, { hook_strength: strength, readability_grade: grade, lengths })
}

/** Score pasted copy (treated as primary text, first line as hook) or a full variant. */
export function scoreCopy(input: string | CopyVariantInput, options: ScoreOptions): CopyScore {
  if (typeof input !== 'string') return scoreCopyVariant(input, options)
  return scoreCopyVariant({ primary_text: input, hook: extractHook(input) }, options)
}

export interface CopySetScore {
  variants: CopyScore[]
  duplicates: Array<{ a: number; b: number; similarity: number }>
}

export const comparable = (v: CopyVariantInput) => [v.primary_text || v.hook, v.headline, v.description].filter(Boolean).join(' \n ')

/**
 * Score a set and enforce diversity: Meta's delivery system groups near-identical ads and makes them
 * compete, so a later variant that repeats an earlier one's angle or wording is flagged.
 */
export function scoreCopySet(variants: readonly CopyVariantInput[], options: ScoreOptions): CopySetScore {
  const scores = variants.map((v) => scoreCopyVariant(v, options))
  const duplicates: CopySetScore['duplicates'] = []
  const extra: CopyFinding[][] = variants.map(() => [])
  for (let b = 1; b < variants.length; b++) {
    for (let a = 0; a < b; a++) {
      const sim = similarity(comparable(variants[a]), comparable(variants[b]))
      if (sim >= NEAR_DUPLICATE_AT) {
        duplicates.push({ a, b, similarity: sim })
        extra[b].push(finding('near_duplicate', 'warning', 'variant', `Near-duplicate of variant ${a + 1} (${Math.round(sim * 100)}% shared wording).`, 'Change the angle and the opening line, not just a few words.'))
        break
      }
    }
    const angle = variants[b].angle
    const earlier = angle ? variants.findIndex((v, i) => i < b && v.angle === angle) : -1
    if (earlier >= 0) extra[b].push(finding('angle_repeated', 'warning', 'variant', `Same angle as variant ${earlier + 1}.`, 'Use a different angle so the ads are not grouped as one concept.'))
  }
  return {
    variants: scores.map((score, i) => withFindings(score, extra[i])),
    duplicates,
  }
}
