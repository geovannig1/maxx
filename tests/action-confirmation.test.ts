import { describe, it, expect } from 'vitest'
import { actionConfirmsFlag, isActionConfirmed, type RecordedAction, type FlagActionContext } from '@/lib/learning/action-confirmation'

// Review finding: "confirmed action" must be a real match — right entity, right action type, successful
// status (loaders filter), inside the flag's post-window — and must include the owner's "acted on"
// control (recommendation_decisions), which with write mode off is the only source that ever fires.

const EVAL = 7

const flag = (over: Partial<FlagActionContext> = {}): FlagActionContext => ({
  flagType: 'loser',
  flagDate: '2026-07-01',
  metaEntityId: 'meta-ad-1',
  dbEntityKey: 'db-uuid-1',
  recommendationId: 'rec-1',
  ...over,
})

const write = (over: Partial<RecordedAction> = {}): RecordedAction => ({
  kind: 'write', entityKey: 'meta-ad-1', actionType: 'pause_ad', day: '2026-07-03', ...over,
})

describe('actionConfirmsFlag — window', () => {
  it('accepts the flag day through flagDate+window; rejects before and after', () => {
    expect(actionConfirmsFlag(write({ day: '2026-07-01' }), flag(), EVAL)).toBe(true)
    expect(actionConfirmsFlag(write({ day: '2026-07-08' }), flag(), EVAL)).toBe(true)
    expect(actionConfirmsFlag(write({ day: '2026-06-30' }), flag(), EVAL)).toBe(false)
    // An action AFTER the scored post-window confirms nothing about this window.
    expect(actionConfirmsFlag(write({ day: '2026-07-09' }), flag(), EVAL)).toBe(false)
    expect(actionConfirmsFlag(write({ day: '2026-09-15' }), flag(), EVAL)).toBe(false)
  })
})

describe('actionConfirmsFlag — action type must match the flag', () => {
  it('a budget change does NOT confirm a pause flag', () => {
    expect(actionConfirmsFlag(write({ actionType: 'adjust_budget' }), flag({ flagType: 'loser' }), EVAL)).toBe(false)
  })
  it('only the proving write confirms: pause→loser, adjust_budget→scale; a PAUSED duplicate and pause→refresh do NOT', () => {
    expect(actionConfirmsFlag(write({ actionType: 'pause_ad' }), flag({ flagType: 'loser' }), EVAL)).toBe(true)
    expect(actionConfirmsFlag(write({ actionType: 'adjust_budget' }), flag({ flagType: 'scale_candidate' }), EVAL)).toBe(true)
    // A duplicate is created PAUSED — it adds no spend and replaces no creative, so it proves neither.
    expect(actionConfirmsFlag(write({ actionType: 'duplicate_adset' }), flag({ flagType: 'scale_candidate' }), EVAL)).toBe(false)
    expect(actionConfirmsFlag(write({ actionType: 'duplicate_adset' }), flag({ flagType: 'creative_refresh' }), EVAL)).toBe(false)
    // A pause does not prove a creative refresh; creative_refresh has no proving write action.
    expect(actionConfirmsFlag(write({ actionType: 'pause_ad' }), flag({ flagType: 'creative_refresh' }), EVAL)).toBe(false)
    expect(actionConfirmsFlag(write({ actionType: 'activate_ad' }), flag({ flagType: 'loser' }), EVAL)).toBe(false)
  })
})

describe('actionConfirmsFlag — entity must match', () => {
  it('a write on a DIFFERENT entity never confirms', () => {
    expect(actionConfirmsFlag(write({ entityKey: 'meta-ad-OTHER' }), flag(), EVAL)).toBe(false)
  })
  it('null metaEntityId on the flag → writes can never confirm it', () => {
    expect(actionConfirmsFlag(write(), flag({ metaEntityId: null }), EVAL)).toBe(false)
  })
})

describe('actionConfirmsFlag — owner decisions (recommendation_decisions)', () => {
  const decision = (over: Partial<RecordedAction> = {}): RecordedAction => ({
    kind: 'decision', entityKey: 'db-uuid-1', actionType: 'pause', day: '2026-07-02', recommendationId: 'rec-1', ...over,
  })
  it('confirms via the exact recommendation id, regardless of entity key', () => {
    expect(actionConfirmsFlag(decision({ entityKey: 'unrelated' }), flag(), EVAL)).toBe(true)
  })
  it('confirms via db entity key + matching recommendation type', () => {
    expect(actionConfirmsFlag(decision({ recommendationId: null }), flag(), EVAL)).toBe(true)
  })
  it('a matching recommendation id does NOT confirm a WRONG-type decision (closed bypass)', () => {
    // Same rec id (rec-1), but a scale decision on a loser flag — type must still match.
    expect(actionConfirmsFlag(decision({ actionType: 'scale' }), flag({ flagType: 'loser' }), EVAL)).toBe(false)
  })
  it('rejects a decision of the WRONG type on the same entity (scale decision ≠ pause flag)', () => {
    expect(actionConfirmsFlag(decision({ recommendationId: null, actionType: 'scale' }), flag({ flagType: 'loser' }), EVAL)).toBe(false)
  })
  it('rejects a decision on a different rec + different entity', () => {
    expect(actionConfirmsFlag(decision({ recommendationId: 'rec-OTHER', entityKey: 'db-OTHER' }), flag(), EVAL)).toBe(false)
  })
})

describe('actionConfirmsFlag — setup ledger', () => {
  const ledger = (over: Partial<RecordedAction> = {}): RecordedAction => ({
    kind: 'ledger', entityKey: 'meta-ad-1', actionType: 'budget', day: '2026-07-02', ...over,
  })
  it('a recorded budget change confirms ONLY a scale flag', () => {
    expect(actionConfirmsFlag(ledger(), flag({ flagType: 'scale_candidate' }), EVAL)).toBe(true)
    expect(actionConfirmsFlag(ledger(), flag({ flagType: 'loser' }), EVAL)).toBe(false)
    expect(actionConfirmsFlag(ledger(), flag({ flagType: 'creative_refresh' }), EVAL)).toBe(false)
  })
  it('a non-budget setting change never confirms anything', () => {
    expect(actionConfirmsFlag(ledger({ actionType: 'bid_strategy' }), flag({ flagType: 'scale_candidate' }), EVAL)).toBe(false)
  })
})

describe('isActionConfirmed', () => {
  it('true when ANY recorded action matches; false on empty/no-match', () => {
    const actions = [write({ entityKey: 'other' }), write({ day: '2026-07-05' })]
    expect(isActionConfirmed(actions, flag(), EVAL)).toBe(true)
    expect(isActionConfirmed([], flag(), EVAL)).toBe(false)
    expect(isActionConfirmed([write({ actionType: 'adjust_budget' })], flag(), EVAL)).toBe(false)
  })
})
