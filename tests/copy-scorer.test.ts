import { describe, expect, it } from 'vitest'
import { scoreCopy, scoreCopySet, scoreCopyVariant, type CopyScore, type VerifiedFacts } from '@/lib/creative/copy-scorer'
import { fleschKincaidGrade, similarity } from '@/lib/creative/copy-text'

// Every rule is pinned both ways: it fires on a bad case and stays quiet on a good one, so a rule that
// silently stopped matching (or started matching everything) fails here.

const FACTS: VerifiedFacts = {
  statements: [
    'north-facing daylight windows', '1,200 sq ft loft', 'seamless paper backdrops in twelve colours',
    'studio rental from $60/hr', 'half-day blocks from $200',
  ],
  unverified: ['specific customer counts (e.g. "1,000 happy clients")', '"same-day booking guaranteed"', '"largest studio in the city"'],
}
const NO_FACTS: VerifiedFacts = { statements: [], unverified: [] }

const GOOD = {
  hook: 'Shooting products this week? Use our north-facing daylight windows.',
  primary_text: 'Shooting products this week? Use our north-facing daylight windows.\nBring your gear. The light is soft all day. Book an hour or a half day.',
  headline: 'Daylight studio by the hour',
  description: 'Book online in minutes',
  cta: 'BOOK_NOW',
  angle: 'specific_benefit',
}

const rules = (score: CopyScore) => score.findings.map((f) => f.rule)
const opts = { facts: FACTS, goal: 'bookings' as const }

describe('scoreCopyVariant: a clean variant', () => {
  it('scores high, is publishable and has no blocker', () => {
    const score = scoreCopyVariant(GOOD, opts)
    expect(score.publishable).toBe(true)
    expect(score.findings.filter((f) => f.severity === 'blocker')).toEqual([])
    expect(score.score).toBeGreaterThanOrEqual(85)
    expect(score.verdict).toBe('strong')
  })

  it('returns a reason and a fix for every finding', () => {
    const score = scoreCopyVariant({ ...GOOD, headline: 'Unlock the best studio in town — book today!!' }, opts)
    expect(score.findings.length).toBeGreaterThan(0)
    for (const f of score.findings) {
      expect(f.message.length).toBeGreaterThan(5)
      expect(f.fix.length).toBeGreaterThan(5)
    }
  })
})

describe('length limits and truncation risk', () => {
  it('flags a headline past the visible limit and accepts one within it', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'A very long headline that keeps going well past forty characters' }, opts))).toContain('truncation_risk')
    expect(rules(scoreCopyVariant(GOOD, opts))).not.toContain('truncation_risk')
  })
  it('blocks a field past the hard cap', () => {
    const score = scoreCopyVariant({ ...GOOD, headline: 'x'.repeat(256) }, opts)
    expect(score.findings.find((f) => f.rule === 'length_limit')?.severity).toBe('blocker')
    expect(score.publishable).toBe(false)
  })
  it('flags a description past 30 characters', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, description: 'Book online today and save time on your next shoot' }, opts))).toContain('truncation_risk')
  })
})

describe('hook front-loading and strength', () => {
  it('flags primary text that does not open with the hook', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, primary_text: 'We have a studio. ' + GOOD.hook }, opts))).toContain('hook_front_loaded')
    expect(rules(scoreCopyVariant(GOOD, opts))).not.toContain('hook_front_loaded')
  })
  it('rates a generic opener weak and a specific question strong', () => {
    const weak = scoreCopyVariant({ ...GOOD, hook: 'Are you looking for a studio?', primary_text: 'Are you looking for a studio? We have one.' }, opts)
    expect(rules(weak)).toContain('hook_strength')
    expect(weak.metrics.hook_strength!).toBeLessThan(scoreCopyVariant(GOOD, opts).metrics.hook_strength!)
    expect(rules(scoreCopyVariant(GOOD, opts))).not.toContain('hook_strength')
  })
  it('flags a hook longer than the first visible line', () => {
    const long = 'Shooting products this week and wondering where to go when the light in your apartment is flat and cramped and grey all day?'
    expect(rules(scoreCopyVariant({ ...GOOD, hook: long, primary_text: long }, opts))).toContain('truncation_risk')
  })
})

describe('readability', () => {
  it('computes a low grade for short plain sentences and a high one for dense prose', () => {
    expect(fleschKincaidGrade('Book the room. Bring your gear. Shoot all day.')).toBeLessThan(5)
    expect(fleschKincaidGrade('Our comprehensively configurable photographic environment accommodates professional productions requiring sophisticated illumination methodologies.')).toBeGreaterThan(12)
  })
  it('flags dense primary text and accepts plain text', () => {
    const dense = 'Our comprehensively configurable photographic environment accommodates professional productions requiring sophisticated illumination methodologies and considerable logistical flexibility.'
    expect(rules(scoreCopyVariant({ ...GOOD, hook: dense.slice(0, 60), primary_text: dense }, opts))).toContain('readability')
    expect(rules(scoreCopyVariant(GOOD, opts))).not.toContain('readability')
  })
})

describe('tone: banned words, em dashes, hype, clickbait', () => {
  it('flags slop words and accepts the business own vocabulary from verified facts', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Elevate your shoots' }, opts))).toContain('banned_words')
    // "seamless" is banned slop, but "seamless paper backdrops" is a verified differentiator.
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Seamless paper backdrops' }, opts))).not.toContain('banned_words')
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'A seamless booking flow' }, opts))).toContain('banned_words')
  })
  it('flags an em dash and accepts a comma', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Daylight — by the hour' }, opts))).toContain('em_dash')
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Daylight, by the hour' }, opts))).not.toContain('em_dash')
  })
  it('flags hype punctuation and all-caps words', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Book NOW!!' }, opts))).toContain('hype_punctuation')
    expect(rules(scoreCopyVariant(GOOD, opts))).not.toContain('hype_punctuation')
  })
  it('reads only a single shouted word as all caps, not short abbreviations side by side', () => {
    // Mutation testing let the pattern span spaces ("NY LA" read as one shouted word) unnoticed.
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Daylight studios in NY LA' }, opts))).not.toContain('hype_punctuation')
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Daylight studios TODAY' }, opts))).toContain('hype_punctuation')
  })
  it('flags clickbait', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, headline: "You won't believe this studio" }, opts))).toContain('clickbait')
    expect(rules(scoreCopyVariant(GOOD, opts))).not.toContain('clickbait')
  })
})

describe('unverified claims', () => {
  it('blocks a number that is not in the verified facts and accepts one that is', () => {
    const bad = scoreCopyVariant({ ...GOOD, headline: 'Studio from $45/hr' }, opts)
    expect(bad.findings.find((f) => f.rule === 'unverified_claim')?.severity).toBe('blocker')
    expect(bad.publishable).toBe(false)
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Studio from $60/hr' }, opts))).not.toContain('unverified_claim')
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'A 1,200 sq ft loft' }, opts))).not.toContain('unverified_claim')
  })
  it('treats every number as unverified when no facts are configured', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Studio from $60/hr' }, { facts: NO_FACTS }))).toContain('unverified_claim')
  })
  it('blocks superlatives, guarantees and review claims the facts do not state', () => {
    for (const headline of ['The best studio in town', 'Satisfaction guaranteed', 'Rated 5 stars by creators', 'Trusted by local brands']) {
      expect(rules(scoreCopyVariant({ ...GOOD, headline }, opts)), headline).toContain('unverified_claim')
    }
  })
  it('blocks a claim the profile lists as requiring verification', () => {
    const score = scoreCopyVariant({ ...GOOD, description: 'Same-day booking guaranteed' }, opts)
    expect(score.findings.some((f) => f.rule === 'unverified_claim' && /requires verification/i.test(f.message))).toBe(true)
  })
  // Each kind of claim gets its own guidance. Mutation testing swapped them and the suite stayed green,
  // because the test above only asks whether ANY finding mentions "requires verification".
  it('tells the owner to verify a listed claim and to remove or replace any other', () => {
    const listed = scoreCopyVariant({ ...GOOD, description: 'Same-day booking guaranteed' }, opts).findings
      .filter((f) => f.rule === 'unverified_claim' && /requires verification/.test(f.message))
    expect(listed.length).toBeGreaterThan(0)
    for (const f of listed) expect(f.fix).toBe('Remove it, or verify it and add it to the profile as a fact.')

    const price = scoreCopyVariant({ ...GOOD, headline: 'Studio from $45/hr' }, opts).findings.filter((f) => f.rule === 'unverified_claim')
    expect(price.length).toBeGreaterThan(0)
    for (const f of price) {
      expect(f.message).toMatch(/^Unverified .*not in the verified brand facts\.$/)
      expect(f.fix).toBe('Remove it or replace it with a verified fact.')
    }
  })
})

describe('policy risk', () => {
  it('blocks personal-attribute targeting and accepts a neutral second person', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Are you overweight?' }, opts))).toContain('policy_risk')
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Struggling with your debt?' }, opts))).toContain('policy_risk')
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Your products, in daylight' }, opts))).not.toContain('policy_risk')
  })
  it('flags before/after framing, guaranteed outcomes, health and money claims', () => {
    for (const headline of ['See the before and after', 'Guaranteed results in a day', 'Lose 10 lbs fast', 'Make money from home']) {
      expect(rules(scoreCopyVariant({ ...GOOD, headline }, opts)), headline).toContain('policy_risk')
    }
  })
  it('gives the fix that matches the policy risk', () => {
    const fixes = (headline: string) => scoreCopyVariant({ ...GOOD, headline }, opts).findings
      .filter((f) => f.rule === 'policy_risk').map((f) => f.fix)
    expect(fixes('Are you overweight?')).toEqual(['Describe the offer, not the person ("for product shoots", not "are you...").'])
    expect(fixes('Guaranteed results in a day')).toContain('Rephrase without promising or implying a personal outcome.')
    expect(fixes('Guaranteed results in a day')).not.toContain('Describe the offer, not the person ("for product shoots", not "are you...").')
  })
  it('does not read a black backdrop as a personal attribute', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, headline: 'Your black backdrop is ready' }, opts))).not.toContain('policy_risk')
  })
})

describe('CTA validity and goal fit', () => {
  it('blocks a CTA outside the Meta enum and accepts a valid one', () => {
    const bad = scoreCopyVariant({ ...GOOD, cta: 'CLICK_HERE' }, opts)
    expect(bad.findings.find((f) => f.rule === 'cta_invalid')?.severity).toBe('blocker')
    expect(rules(scoreCopyVariant(GOOD, opts))).not.toContain('cta_invalid')
  })
  it('warns when the CTA fits the goal poorly', () => {
    expect(rules(scoreCopyVariant({ ...GOOD, cta: 'SHOP_NOW' }, opts))).toContain('cta_goal_fit')
    expect(rules(scoreCopyVariant(GOOD, opts))).not.toContain('cta_goal_fit')
  })
})

describe('near-duplicates and angle diversity', () => {
  it('measures similarity between near-identical and different copy', () => {
    expect(similarity('Book the daylight studio by the hour today', 'Book the daylight studio by the hour now')).toBeGreaterThan(0.6)
    expect(similarity('Book the daylight studio by the hour', 'Bring products, leave with a catalogue')).toBeLessThan(0.2)
  })
  it('flags a near-duplicate and a repeated angle in a set, and accepts a diverse set', () => {
    const twin = { ...GOOD, headline: 'Daylight studio by the hour.', angle: 'offer' }
    const dup = scoreCopySet([GOOD, twin], opts)
    expect(rules(dup.variants[1])).toContain('near_duplicate')
    expect(dup.duplicates).toEqual([{ a: 0, b: 1, similarity: expect.any(Number) }])
    const sameAngle = scoreCopySet([GOOD, { ...GOOD, hook: 'Skip the flat apartment light.', primary_text: 'Skip the flat apartment light. Bring the props and shoot by the window.', headline: 'Shoot in real daylight' }], opts)
    expect(rules(sameAngle.variants[1])).toContain('angle_repeated')
    const diverse = scoreCopySet([GOOD, {
      hook: 'Worried an hour is not enough?', primary_text: 'Worried an hour is not enough? Half-day blocks give you room to reset between looks.',
      headline: 'Half-day blocks', description: 'Plan a longer shoot', cta: 'BOOK_NOW', angle: 'objection_handling',
    }], opts)
    expect(diverse.duplicates).toEqual([])
    expect(diverse.variants.flatMap(rules)).not.toContain('angle_repeated')
  })
})

describe('scoreCopy on pasted text', () => {
  it('scores a pasted body as primary text with its first line as the hook', () => {
    const score = scoreCopy('Shooting products this week?\nOur daylight studio is open. Book an hour.', { facts: FACTS })
    expect(score.metrics.lengths.primary_text).toBeGreaterThan(0)
    expect(score.metrics.hook_strength).not.toBeNull()
    expect(rules(score)).not.toContain('hook_front_loaded')
  })
  it('blocks empty copy', () => {
    const score = scoreCopy('   ', { facts: FACTS })
    expect(rules(score)).toContain('empty_field')
    expect(score.publishable).toBe(false)
  })
})
