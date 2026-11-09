import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AD_NAME_TAXONOMY, UNPARSED_GROUP, groupByAdName, parseAdName,
} from '@/lib/creative/ad-name-taxonomy'

/** A synthetic mix of structured and legacy ad names, shaped like a typical account's. */
const AD_NAMES = [
  'Warm | Studio Reel A | March 2026 (7d)',
  'Cold | Open Space C | April 2026 (7d)',
  'studio-tour-video-2',
  'Warm | Walkthrough B | March 2026 (7d)',
  'Cold | Walkthrough B | March 2026 (7d)',
  'legacy-ad-2',
  'Cold | Open Space C | April 2026 (7d) (ADR-056 tagged)',
  'Warm | Walkthrough B | March 2026 (7d) (ADR-056 tagged)',
  'reel-draft-d',
  'Cold | Studio Reel A | March 2026 (7d)',
  'Warm | Studio Reel A | March 2026 (7d) (ADR-056 tagged)',
  'spring-promo-2026',
  'Cold | Studio Reel A | March 2026 (7d) (ADR-056 tagged)',
  'reel-draft-a',
  'reel-draft-c',
]

const LEGACY = ['studio-tour-video-2', 'reel-draft-a', 'legacy-ad-2', 'reel-draft-c', 'reel-draft-d', 'spring-promo-2026']

describe('ad name taxonomy', () => {
  it('parses 9 of the 15 names and leaves the 6 legacy names unparsed', () => {
    const parsed = AD_NAMES.filter((n) => parseAdName(n).parsed)
    expect(parsed).toHaveLength(9)
    expect(AD_NAMES.length - parsed.length).toBe(6)
    for (const legacy of LEGACY) {
      expect(parseAdName(legacy).parsed, legacy).toBe(false)
      expect(parseAdName(legacy).groupKey).toBe(UNPARSED_GROUP)
    }
  })

  it('pulls audience, concept, cohort and attribution window out of a structured name', () => {
    expect(parseAdName('Cold | Open Space C | April 2026 (7d)')).toMatchObject({
      parsed: true, audience: 'Cold', concept: 'Open Space C',
      cohort: 'April 2026', attributionWindow: '7d', annotations: [],
    })
  })

  // Splitting a relaunched creative from its original would halve an already-thin sample.
  it('groups a relaunched creative with its original', () => {
    const original = parseAdName('Cold | Studio Reel A | March 2026 (7d)')
    const relaunch = parseAdName('Cold | Studio Reel A | March 2026 (7d) (ADR-056 tagged)')
    expect(relaunch.groupKey).toBe(original.groupKey)
    expect(relaunch.annotations).toEqual(['ADR-056 tagged'])
    expect(relaunch.attributionWindow).toBe('7d')
  })

  it('keeps audience and concept distinct in the group key', () => {
    expect(parseAdName('Cold | Walkthrough B | March 2026 (7d)').groupKey)
      .not.toBe(parseAdName('Warm | Walkthrough B | March 2026 (7d)').groupKey)
  })

  it('normalises audience casing without gating on the vocabulary', () => {
    expect(parseAdName('cold | X | June 2026').audience).toBe('Cold')
    // An unlisted audience still parses — a new tenant is not silently unparsed.
    expect(parseAdName('Midfunnel | X | June 2026')).toMatchObject({ parsed: true, audience: 'Midfunnel' })
  })

  it('never infers structure from an unstructured name', () => {
    for (const name of ['', '   ', 'Cold', 'Cold | Only Two']) {
      expect(parseAdName(name).parsed, JSON.stringify(name)).toBe(false)
      expect(parseAdName(name).audience).toBeNull()
    }
  })

  it('is tenant-configurable', () => {
    const config = { ...DEFAULT_AD_NAME_TAXONOMY, separator: '::', audienceVocabulary: ['TOF', 'BOF'] }
    expect(parseAdName('tof :: Hero Cut :: Q3', config)).toMatchObject({
      parsed: true, audience: 'TOF', concept: 'Hero Cut', cohort: 'Q3',
    })
  })

  it('groups live rows into 5 real concepts plus one unparsed bucket, unparsed last', () => {
    const groups = groupByAdName(AD_NAMES, (n) => n)
    expect(groups).toHaveLength(6)
    expect(groups.at(-1)).toMatchObject({ groupKey: UNPARSED_GROUP, parsed: false })
    expect(groups.at(-1)!.members).toHaveLength(6)

    const parsedGroups = groups.filter((g) => g.parsed)
    expect(parsedGroups).toHaveLength(5)
    // Cold before Warm, per vocabulary order.
    expect(parsedGroups[0].audience).toBe('Cold')
    expect(parsedGroups.at(-1)!.audience).toBe('Warm')
    // Every live ad lands in exactly one group.
    expect(groups.reduce((n, g) => n + g.members.length, 0)).toBe(AD_NAMES.length)
  })
})
