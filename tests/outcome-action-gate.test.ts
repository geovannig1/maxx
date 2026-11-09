import { describe, it, expect } from 'vitest'
import {
  requiresConfirmedAction,
  gateOutcomeOnConfirmedAction,
  scoreFlag,
} from '@/lib/learning/outcomes'

// Item 4: the flag-outcome scorer used to INFER implementation from spend — "post-spend ≈ $0 ⇒ the pause
// worked", "held efficient ⇒ scaling worked" — and store those as lessons. A decisive worked/failed
// verdict for an action-requiring flag must now require a RECORDED action; otherwise it is demoted to an
// unconfirmed hypothesis and kept out of agent_memory (learn=false).

describe('requiresConfirmedAction', () => {
  it('is true for action recommendations (pause/refresh/scale), false for keep (winner)', () => {
    expect(requiresConfirmedAction('loser')).toBe(true)
    expect(requiresConfirmedAction('creative_refresh')).toBe(true)
    expect(requiresConfirmedAction('scale_candidate')).toBe(true)
    expect(requiresConfirmedAction('winner')).toBe(false)
  })
})

describe('gateOutcomeOnConfirmedAction', () => {
  it('demotes a decisive verdict to inconclusive + no-learn when the action was NOT recorded', () => {
    const g = gateOutcomeOnConfirmedAction({ outcome: 'worked', note: 'pause acted on (post-spend $0).' }, 'loser', false)
    expect(g.outcome).toBe('inconclusive')
    expect(g.learn).toBe(false)
    expect(g.note).toMatch(/unconfirmed — no recorded action/)
  })

  it('names a missing budget change for scale flags', () => {
    const g = gateOutcomeOnConfirmedAction({ outcome: 'worked', note: 'held efficient.' }, 'scale_candidate', false)
    expect(g.outcome).toBe('inconclusive')
    expect(g.note).toMatch(/no recorded budget change/)
  })

  it('passes a decisive verdict through (and learns) when the action WAS recorded', () => {
    const g = gateOutcomeOnConfirmedAction({ outcome: 'worked', note: 'pause acted on.' }, 'loser', true)
    expect(g).toEqual({ outcome: 'worked', note: 'pause acted on.', learn: true })
  })

  it('never gates a winner (keep is a no-op — no action needed) even without a record', () => {
    const g = gateOutcomeOnConfirmedAction({ outcome: 'worked', note: 'held efficient.' }, 'winner', false)
    expect(g.outcome).toBe('worked')
    expect(g.learn).toBe(true)
  })

  it('leaves an already-inconclusive verdict alone (still learns at low importance)', () => {
    const g = gateOutcomeOnConfirmedAction({ outcome: 'inconclusive', note: 'thin data.' }, 'loser', false)
    expect(g).toEqual({ outcome: 'inconclusive', note: 'thin data.', learn: true })
  })

  it('creative_refresh is NEVER a lesson — learn:false even when confirmed', () => {
    // No replacement-entity linkage exists, so a refresh cannot be scored from the old entity's window.
    const g = gateOutcomeOnConfirmedAction({ outcome: 'inconclusive', note: 'refresh not scorable.' }, 'creative_refresh', true)
    expect(g).toEqual({ outcome: 'inconclusive', note: 'refresh not scorable.', learn: false })
  })
})

describe('scoreFlag — creative_refresh is inconclusive', () => {
  it('never returns worked from the old paused entity, regardless of post-spend', () => {
    // Old behavior credited a "worked" refresh when the flagged ad went quiet (post-spend ~0).
    for (const postSpend of [0, 3, 200]) {
      const r = scoreFlag('creative_refresh', 60, postSpend, 4, postSpend / 4, null, 5)
      expect(r.outcome).toBe('inconclusive')
    }
  })
})
