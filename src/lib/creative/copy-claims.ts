// Claim and policy detectors for ad copy. PURE.
//
// Unverified claims: a number, superlative, guarantee or social-proof statement is a CLAIM; it passes
// only when the business's verified facts state it. A claim the profile lists as requiring
// verification is always blocked. Policy risk: phrasing Meta's advertising standards restrict
// (asserting personal attributes, health or money promises, guaranteed outcomes, before/after framing).
// Both are deliberately conservative: a false alarm costs a rewrite, a miss can cost an ad account.

import { containsPhrase, normalizeText } from './copy-text'

export interface ClaimHit {
  kind: 'number' | 'superlative' | 'guarantee' | 'social_proof' | 'requires_verification'
  text: string
}

export interface PolicyHit {
  kind: 'personal_attribute' | 'before_after' | 'guaranteed_outcome' | 'health_claim' | 'financial_claim'
  text: string
  severity: 'blocker' | 'warning'
}

const NUMBER = /(?:[$€£¥]\s?)?\d[\d,.]*(?:\s?(?:%|percent|k\b|x\b|\+))?/gi

/** Digits of each number in the text, commas dropped ("$1,200.00" -> "1200"). */
function numberCores(text: string): string[] {
  return [...text.matchAll(NUMBER)].map((m) => m[0].replace(/[^\d.]/g, '').replace(/\.0+$/, '').replace(/\.$/, '')).filter(Boolean)
}

const SUPERLATIVES = [
  'best', '#1', 'number one', 'no. 1', 'largest', 'biggest', 'cheapest', 'lowest price', 'fastest', 'top-rated',
  'top rated', 'highest-rated', 'highest rated', 'leading', 'most popular', 'the only', 'award-winning',
  'award winning', 'unbeatable', 'favorite', 'favourite',
]
const GUARANTEES = ['guarantee', 'guaranteed', 'guarantees', 'money-back', 'money back', 'risk-free', 'risk free', 'we promise', 'no risk', 'warranty']
const SOCIAL_PROOF = [
  'review', 'reviews', 'rated', 'stars', '5-star', 'five-star', 'five star', 'testimonial', 'trusted by', 'loved by',
  'happy clients', 'happy customers', 'satisfied customers', 'thousands of', 'hundreds of', 'as seen on', 'featured in',
]

/** Phrases a requires-verification entry names: its quoted examples, or the entry itself when short. */
export function requiresVerificationPhrases(entries: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    const quoted = [...entry.matchAll(/"([^"]{3,})"|“([^”]{3,})”/g)].map((m) => m[1] ?? m[2])
    if (quoted.length > 0) out.push(...quoted)
    else if (entry.length <= 60) out.push(entry.replace(/\([^)]*\)/g, '').trim())
  }
  return out.filter((p) => p.length >= 3)
}

export function detectUnverifiedClaims(text: string, verified: readonly string[], unverified: readonly string[]): ClaimHit[] {
  const factsText = verified.join(' \n ')
  const hits: ClaimHit[] = []
  for (const phrase of requiresVerificationPhrases(unverified)) {
    if (containsPhrase(text, phrase)) hits.push({ kind: 'requires_verification', text: phrase })
  }
  const factNumbers = new Set(numberCores(factsText))
  for (const match of text.matchAll(NUMBER)) {
    const core = numberCores(match[0])[0]
    if (core && !factNumbers.has(core)) hits.push({ kind: 'number', text: match[0].trim() })
  }
  const lists: Array<[ClaimHit['kind'], string[]]> = [['superlative', SUPERLATIVES], ['guarantee', GUARANTEES], ['social_proof', SOCIAL_PROOF]]
  for (const [kind, phrases] of lists) {
    for (const phrase of phrases) {
      const inText = phrase.startsWith('#') ? normalizeText(text).includes(phrase) : containsPhrase(text, phrase)
      if (inText && !containsPhrase(factsText, phrase)) hits.push({ kind, text: phrase })
    }
  }
  // One finding per phrase: "guarantee" inside "same-day booking guaranteed" is already the blocked claim.
  const blocked = hits.filter((h) => h.kind === 'requires_verification').map((h) => h.text.toLowerCase())
  const seen = new Set<string>()
  return hits.filter((h) => {
    if (h.kind !== 'requires_verification' && blocked.some((phrase) => containsPhrase(phrase, h.text))) return false
    const key = `${h.kind === 'requires_verification' ? 'rv' : 'c'}|${h.text.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const ATTRIBUTES = [
  'overweight', 'fat', 'obese', 'depressed', 'anxious', 'diabetic', 'bankrupt', 'broke', 'in debt', 'divorced',
  'single', 'pregnant', 'disabled', 'gay', 'lesbian', 'bisexual', 'transgender', 'christian', 'muslim', 'jewish',
  'hindu', 'catholic', 'black', 'latino', 'latina', 'asian', 'an immigrant', 'unemployed', 'poor', 'elderly',
  'bald', 'balding', 'infertile', 'an alcoholic', 'an addict',
]
const CONDITIONS = [
  'debt', 'weight', 'belly fat', 'acne', 'depression', 'anxiety', 'diabetes', 'credit score', 'bad credit',
  'divorce', 'disability', 'bald spot', 'hair loss', 'addiction', 'illness', 'diagnosis', 'religion', 'sexuality',
]
const alt = (list: readonly string[]) => list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
const BOUNDARY = '(?![\\p{L}\\p{N}])'

const POLICY_PATTERNS: Array<{ kind: PolicyHit['kind']; severity: PolicyHit['severity']; pattern: RegExp }> = [
  { kind: 'personal_attribute', severity: 'blocker', pattern: new RegExp(`\\b(?:are you|you're|you are|aren't you|as an?|other|fellow)\\s+(?:an?\\s+)?(?:${alt(ATTRIBUTES)})${BOUNDARY}`, 'iu') },
  { kind: 'personal_attribute', severity: 'blocker', pattern: new RegExp(`\\byour\\s+(?:${alt(CONDITIONS)})${BOUNDARY}`, 'iu') },
  { kind: 'before_after', severity: 'warning', pattern: /\bbefore\s*(?:and|&|\/|-|vs\.?)\s*after\b/i },
  { kind: 'guaranteed_outcome', severity: 'blocker', pattern: /\b(?:guaranteed?|100%)\s+(?:results?|outcomes?|success|income|returns?|bookings|sales|leads|clients)\b|\bresults\s+guaranteed\b/i },
  { kind: 'health_claim', severity: 'blocker', pattern: /\b(?:cures?|heals?|treats? (?:your|anxiety|depression|pain)|lose \d+\s*(?:lbs?|pounds|kg|kilos)|weight loss|burn fat|fat burning|detox|anti-aging)\b/i },
  { kind: 'financial_claim', severity: 'blocker', pattern: /\b(?:make money|earn \$?\d|passive income|get rich|double your (?:income|money)|financial freedom|guaranteed returns?|quit your job)\b/i },
]

export function detectPolicyRisks(text: string): PolicyHit[] {
  const hits: PolicyHit[] = []
  for (const { kind, severity, pattern } of POLICY_PATTERNS) {
    const match = text.match(pattern)
    if (match && !hits.some((h) => h.kind === kind)) hits.push({ kind, severity, text: match[0] })
  }
  return hits
}
