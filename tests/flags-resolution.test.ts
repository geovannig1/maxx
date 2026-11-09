import { describe, it, expect } from 'vitest'
import { selectStaleFlagIds } from '@/lib/flags/engine'

// Run-scoped stale-flag resolution: a flag used to stay is_active until a NEW flag of the SAME type
// replaced it, so an entity that returned to health — or flipped to a different flag type — kept its old
// active flag forever. selectStaleFlagIds closes flags whose (entity+window) WAS evaluated this run but
// whose type was NOT re-proven, while leaving flags for entities absent from this run's data untouched.

type Flag = Parameters<typeof selectStaleFlagIds>[0][number]

const adFlag = (id: string, ad_id: string, window_days: number, flag_type: string): Flag => ({
  id, entity_level: 'ad', campaign_id: null, ad_id, adset_id: null, window_days, flag_type,
})
const adsetFlag = (id: string, adset_id: string, window_days: number, flag_type: string): Flag => ({
  id, entity_level: 'adset', campaign_id: null, ad_id: null, adset_id, window_days, flag_type,
})
const campaignFlag = (id: string, campaign_id: string, window_days: number, flag_type: string): Flag => ({
  id, entity_level: 'campaign', campaign_id, ad_id: null, adset_id: null, window_days, flag_type,
})

describe('selectStaleFlagIds', () => {
  it('closes a flag whose entity+window was evaluated but the type was NOT re-proven (became healthy)', () => {
    const evaluated = new Set(['ad:ad-1:7'])
    const proven = new Set<string>() // healthy this run — no flag produced
    expect(selectStaleFlagIds([adFlag('f1', 'ad-1', 7, 'loser')], evaluated, proven)).toEqual(['f1'])
  })

  it('closes the OLD type when an entity flips (loser → winner)', () => {
    const evaluated = new Set(['ad:ad-1:7'])
    const proven = new Set(['ad:ad-1:7:winner'])
    const flags = [adFlag('old', 'ad-1', 7, 'loser'), adFlag('new', 'ad-1', 7, 'winner')]
    // The freshly re-proven winner survives; the stale loser is closed.
    expect(selectStaleFlagIds(flags, evaluated, proven)).toEqual(['old'])
  })

  it('leaves a flag untouched when its entity+window was NOT evaluated this run (no data → cannot assert health)', () => {
    const evaluated = new Set(['ad:ad-1:7']) // ad-2 not in this run's data at all
    const proven = new Set<string>()
    expect(selectStaleFlagIds([adFlag('f2', 'ad-2', 7, 'loser')], evaluated, proven)).toEqual([])
  })

  it('is window-scoped: a 30d flag survives when only the 7d window was evaluated', () => {
    const evaluated = new Set(['adset:as-1:7'])
    const proven = new Set(['adset:as-1:7:creative_refresh'])
    // The 30d loser was not evaluated this run (only 7d was) → left active.
    expect(selectStaleFlagIds([adsetFlag('f30', 'as-1', 30, 'loser')], evaluated, proven)).toEqual([])
  })

  it('skips rows with a null entity id and handles the ad-set level', () => {
    const evaluated = new Set(['adset:as-1:3'])
    const proven = new Set<string>()
    const flags = [
      adsetFlag('f-adset', 'as-1', 3, 'watchlist'),
      { id: 'f-null', entity_level: 'ad' as const, campaign_id: null, ad_id: null, adset_id: null, window_days: 3, flag_type: 'loser' },
    ]
    expect(selectStaleFlagIds(flags, evaluated, proven)).toEqual(['f-adset'])
  })

  it('resolves campaign-level flags by campaign_id (CBO optimization unit)', () => {
    const evaluated = new Set(['campaign:camp-1:7'])
    const proven = new Set(['campaign:camp-1:7:scale_candidate'])
    // The campaign became a scale_candidate; a stale campaign-level loser is closed.
    const flags = [campaignFlag('c-old', 'camp-1', 7, 'loser'), campaignFlag('c-new', 'camp-1', 7, 'scale_candidate')]
    expect(selectStaleFlagIds(flags, evaluated, proven)).toEqual(['c-old'])
  })
})

describe('selectStaleFlagIds — budget-freeze preservation', () => {
  // Mirrors the engine's isBudgetFrozen: only adset/campaign budget flags in a frozen campaign freeze.
  const isFrozen = (frozen: Set<string>) => (f: Flag) =>
    (f.entity_level === 'adset' || f.entity_level === 'campaign') &&
    (f.flag_type === 'loser' || f.flag_type === 'scale_candidate') &&
    frozen.has(f.campaign_id ?? '')
  const budgetFlag = (id: string, level: 'adset' | 'campaign', flag_type: string): Flag => ({
    id, entity_level: level, campaign_id: 'camp-1', ad_id: null, adset_id: level === 'adset' ? 'as-1' : null, window_days: 7, flag_type,
  })

  it('does NOT close a frozen adset/campaign budget flag, even when evaluated-but-not-proven (healthy)', () => {
    const evaluated = new Set(['adset:as-1:7', 'campaign:camp-1:7'])
    const proven = new Set<string>() // healthy this run — would normally close
    const flags = [budgetFlag('as-loser', 'adset', 'loser'), budgetFlag('camp-scale', 'campaign', 'scale_candidate')]
    expect(selectStaleFlagIds(flags, evaluated, proven, isFrozen(new Set(['camp-1'])))).toEqual([])
  })

  it('still closes a NON-budget flag in a frozen campaign (only budget decisions freeze)', () => {
    const evaluated = new Set(['adset:as-1:7'])
    const proven = new Set<string>()
    const flags = [budgetFlag('as-watch', 'adset', 'watchlist')]
    expect(selectStaleFlagIds(flags, evaluated, proven, isFrozen(new Set(['camp-1'])))).toEqual(['as-watch'])
  })

  it('closes an AD-level scale flag even under freeze (ad-level scale is never frozen)', () => {
    const evaluated = new Set(['ad:ad-1:7'])
    const proven = new Set<string>() // ad-level scale is suppressed, never re-proven
    const flags: Flag[] = [{ id: 'ad-scale', entity_level: 'ad', campaign_id: 'camp-1', ad_id: 'ad-1', adset_id: null, window_days: 7, flag_type: 'scale_candidate' }]
    expect(selectStaleFlagIds(flags, evaluated, proven, isFrozen(new Set(['camp-1'])))).toEqual(['ad-scale'])
  })
})
