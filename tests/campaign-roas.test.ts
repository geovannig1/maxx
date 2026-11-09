import { describe, it, expect } from 'vitest'
import { campaignTokens, matchGa4Campaign } from '@/lib/analytics/campaign-roas'

const CAMPAIGNS = [
  'QZ Studios | Creators & Videographers | Spring Launch',
  'Holiday Gift Cards 2026',
]

describe('campaignTokens', () => {
  it('keeps significant tokens, drops short tokens and punctuation', () => {
    const t = campaignTokens('QZ Studios | Creators & Videographers | Spring Launch')
    expect(t.has('creators')).toBe(true)
    expect(t.has('videographers')).toBe(true)
    expect(t.has('studios')).toBe(true)
    expect(t.has('qz')).toBe(false) // length < 3 dropped
  })
})

describe('matchGa4Campaign', () => {
  it('matches a slug to the one campaign whose name contains its tokens', () => {
    expect(matchGa4Campaign('creators_videographers', CAMPAIGNS)).toBe(CAMPAIGNS[0])
  })

  it('matches a different slug to its own campaign', () => {
    expect(matchGa4Campaign('holiday_gift', CAMPAIGNS)).toBe('Holiday Gift Cards 2026')
  })

  it('matches a full campaign name exactly', () => {
    expect(matchGa4Campaign(CAMPAIGNS[0], CAMPAIGNS)).toBe(CAMPAIGNS[0])
  })

  it('returns null for GA4 placeholders (unattributed)', () => {
    expect(matchGa4Campaign('(not set)', CAMPAIGNS)).toBeNull()
    expect(matchGa4Campaign('(direct)', CAMPAIGNS)).toBeNull()
    expect(matchGa4Campaign('(organic)', CAMPAIGNS)).toBeNull()
  })

  it('returns null when ambiguous (tokens match more than one campaign)', () => {
    expect(matchGa4Campaign('studios', ['Example Studio Alpha', 'Example Studio Beta'])).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(matchGa4Campaign('completely_unrelated_thing', CAMPAIGNS)).toBeNull()
  })
})
