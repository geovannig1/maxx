// Copy studio rules: the constants the deterministic scorer, the generation prompt and the console
// share. PURE and client-safe (no environment, no server-only imports), so the Copy studio form and the
// API validate against the same lists.
//
// Length limits are Meta's published guidance for feed placements, used as TRUNCATION RISK, not as a
// rejection, except the hard caps, which the Ads API itself enforces. Each limit names what it protects.

import { BANNED_WORDS as TONE_BANNED_WORDS } from './banned-words'

export const COPY_GOALS = ['bookings', 'sales', 'leads', 'traffic', 'awareness', 'engagement'] as const
export type CopyGoal = (typeof COPY_GOALS)[number]

export const AUDIENCE_TEMPERATURES = ['cold', 'warm', 'retargeting'] as const
export type AudienceTemperature = (typeof AUDIENCE_TEMPERATURES)[number]

export const COPY_PLACEMENTS = ['feed', 'stories', 'reels', 'explore'] as const
export type CopyPlacement = (typeof COPY_PLACEMENTS)[number]

/** Angles the generator may use. Two ads on the same angle read as one concept to Meta's delivery system. */
export const COPY_ANGLES = [
  'problem_solution', 'specific_benefit', 'offer', 'objection_handling', 'ugc', 'founder_story', 'social_proof',
] as const
export type CopyAngle = (typeof COPY_ANGLES)[number]

export const ANGLE_LABELS: Record<CopyAngle, string> = {
  problem_solution: 'Problem / solution',
  specific_benefit: 'Specific benefit',
  offer: 'Offer',
  objection_handling: 'Objection handling',
  ugc: 'UGC-style',
  founder_story: 'Founder story',
  social_proof: 'Social proof',
}

/**
 * Meta call-to-action button values (the Ads API `call_to_action.type` enum), limited to the ones a
 * single-location business plausibly uses. A value outside this list is reported as invalid.
 */
export const META_CTAS = [
  'BOOK_NOW', 'LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'GET_QUOTE', 'GET_OFFER', 'ORDER_NOW',
  'APPLY_NOW', 'SUBSCRIBE', 'DOWNLOAD', 'SEND_MESSAGE', 'CALL_NOW', 'GET_DIRECTIONS', 'WATCH_MORE',
  'SEE_MENU', 'REQUEST_TIME',
] as const
export type MetaCta = (typeof META_CTAS)[number]

/** The buttons that fit each goal. Another valid button is allowed but flagged as a weaker fit. */
export const GOAL_CTAS: Record<CopyGoal, readonly MetaCta[]> = {
  bookings: ['BOOK_NOW', 'REQUEST_TIME', 'LEARN_MORE', 'CONTACT_US', 'SEND_MESSAGE'],
  sales: ['SHOP_NOW', 'ORDER_NOW', 'GET_OFFER', 'LEARN_MORE'],
  leads: ['SIGN_UP', 'GET_QUOTE', 'CONTACT_US', 'APPLY_NOW', 'SEND_MESSAGE', 'LEARN_MORE'],
  traffic: ['LEARN_MORE', 'SHOP_NOW', 'WATCH_MORE', 'SEE_MENU'],
  awareness: ['LEARN_MORE', 'WATCH_MORE'],
  engagement: ['SEND_MESSAGE', 'LEARN_MORE', 'WATCH_MORE', 'SUBSCRIBE'],
}

export function ctaLabel(cta: string): string {
  return cta.toLowerCase().split('_').map((word, i) => (i === 0 ? word[0]?.toUpperCase() + word.slice(1) : word)).join(' ')
}

/** Field limits. `visible` = what shows before truncation in feed; `max` = the hard cap. */
export const COPY_LIMITS = {
  /** The hook should fit the first mobile line; Meta shows ~125 characters of primary text before "See more". */
  hook: { ideal: 80, visible: 125, max: 125 },
  primary_text: { visible: 125, max: 2200 },
  headline: { visible: 40, max: 255 },
  description: { visible: 30, max: 255 },
} as const

export type CopyField = 'hook' | 'primary_text' | 'headline' | 'description'

/**
 * AI slop and buzzwords. Extends the copy-tone list (the brief generator's) with more clichés seen in
 * generated ad copy. Matched case-insensitively on word boundaries. A banned word inside a VERIFIED
 * brand fact (e.g. "seamless paper backdrops") is the business's own vocabulary and is not flagged.
 */
export const BANNED_COPY_WORDS: readonly string[] = [...new Set([
  ...TONE_BANNED_WORDS,
  'game changing', 'next-level', 'next level', 'must-have', 'one-stop shop', 'one stop shop', 'state-of-the-art',
  'innovative', 'curated', 'bespoke', 'elevated', 'unleashed', 'skyrocket', 'dive in', 'dive into', 'discover the',
  'whether you', 'say goodbye to', 'imagine a world', 'like never before', 'effortless', 'effortlessly',
  'robust', 'holistic', 'journey', 'treat yourself', 'look no further',
])]

/** Openers that read as an ad before they read as a reason to stop. */
export const WEAK_HOOK_OPENERS: readonly string[] = [
  'are you looking for', 'looking for', 'introducing', 'check out', 'we are', "we're", 'welcome to', 'did you know',
  'attention', 'hey', 'hi', 'calling all', 'in today',
]

export const CLICKBAIT_PHRASES: readonly string[] = [
  "you won't believe", 'you will not believe', 'shocking', 'this one trick', 'one weird trick', 'doctors hate',
  'what happens next', 'gone wrong', 'secret they', 'nobody tells you',
]
