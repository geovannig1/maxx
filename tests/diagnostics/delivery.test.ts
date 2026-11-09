import { describe, it, expect } from 'vitest'
import { buildAdsetDeliverySignals, MAU_BOUNDS_LABEL, type AdsetDeliverySignalsInput } from '@/lib/diagnostics/delivery'

const days = (spends: [string, number][]) => spends.map(([date, spend]) => ({ date, spend }))

function input(overrides: Partial<AdsetDeliverySignalsInput> = {}): AdsetDeliverySignalsInput {
  return {
    name: 'Warm Engagers | Retargeting | $45 (7-day)',
    learningStage: 'LEARNING',
    learningConversions: 2,
    lastSigEditTs: '2026-07-06T00:00:00Z',
    dailyBudget: 45,
    days: days([['2026-07-06', 15], ['2026-07-07', 30], ['2026-07-08', 30], ['2026-07-09', 25]]),
    targeting: { custom_audiences: [{ id: '238' }] },
    ...overrides,
  }
}

describe('learning counter → results_to_exit (the "2 outcomes, needs 48 more" math)', () => {
  it('computes 50 − counter with the last-significant-edit context attached', () => {
    const s = buildAdsetDeliverySignals(input())
    expect(s.learning_conversions).toBe(2)
    expect(s.results_to_exit).toBe(48)
    expect(s.last_sig_edit).toBe('2026-07-06T00:00:00Z')
  })

  it('clamps at 0 when the counter exceeds the threshold', () => {
    const s = buildAdsetDeliverySignals(input({ learningConversions: 61 }))
    expect(s.results_to_exit).toBe(0)
  })

  it('null counter → null results_to_exit (unknown, never fabricated)', () => {
    const s = buildAdsetDeliverySignals(input({ learningConversions: null, lastSigEditTs: null }))
    expect(s.learning_conversions).toBeNull()
    expect(s.results_to_exit).toBeNull()
  })

  it('exited (SUCCESS) → results_to_exit is null, not 50 − counter', () => {
    const s = buildAdsetDeliverySignals(input({ learningStage: 'SUCCESS', learningConversions: 12 }))
    expect(s.results_to_exit).toBeNull()
  })
})

describe('budget overshoot (the "up to 175% of your daily budget on some days" stat)', () => {
  it('reports max and median day % of budget over delivering days only', () => {
    // $20/day budget; days: 10 (50%), 20 (100%), 35 (175%), and a zero-spend day that must be ignored.
    const s = buildAdsetDeliverySignals(input({
      dailyBudget: 20,
      days: days([['2026-07-06', 10], ['2026-07-07', 20], ['2026-07-08', 35], ['2026-07-09', 0]]),
    }))
    expect(s.budget_constrained.max_day_overshoot_pct).toBe(175)
    expect(s.budget_constrained.median_day_pct).toBe(100)
    expect(s.budget_constrained.flag).toBe(true) // median 100 ≥ 95
  })

  it('flag boundary: median just below 95 does not fire', () => {
    const s = buildAdsetDeliverySignals(input({
      dailyBudget: 100,
      days: days([['2026-07-06', 94], ['2026-07-07', 94], ['2026-07-08', 120]]),
    }))
    expect(s.budget_constrained.median_day_pct).toBe(94)
    expect(s.budget_constrained.flag).toBe(false)
  })

  it('no budget or no delivering days → nulls, no flag', () => {
    expect(buildAdsetDeliverySignals(input({ dailyBudget: null })).budget_constrained).toEqual({ flag: false, max_day_overshoot_pct: null, median_day_pct: null })
    expect(buildAdsetDeliverySignals(input({ days: [] })).budget_constrained).toEqual({ flag: false, max_day_overshoot_pct: null, median_day_pct: null })
  })
})

describe('narrow-audience inference (never Ads Manager\'s bucket)', () => {
  it('custom-audience pool without expansion → narrow, with the targeting-inference basis', () => {
    const s = buildAdsetDeliverySignals(input())
    expect(s.narrow_audience.narrow).toBe(true)
    expect(s.narrow_audience.basis).toMatch(/targeting-inference/)
  })

  it('targeting not synced → null (unknown), never a guess', () => {
    const s = buildAdsetDeliverySignals(input({ targeting: null }))
    expect(s.narrow_audience.narrow).toBeNull()
    expect(s.narrow_audience.basis).toMatch(/not synced/)
  })

  it('broad / Advantage-expanded targeting → not narrow', () => {
    const broad = buildAdsetDeliverySignals(input({ targeting: { geo_locations: { custom_locations: [{ radius: 20 }] } } }))
    expect(broad.narrow_audience.narrow).toBe(false)
    const expanded = buildAdsetDeliverySignals(input({ targeting: { custom_audiences: [{ id: '1' }], targeting_automation: { advantage_audience: 1 } } }))
    expect(expanded.narrow_audience.narrow).toBe(false)
  })

  it('MAU bounds always carry the delivery-estimate label (never the Ads-Manager bucket)', () => {
    const s = buildAdsetDeliverySignals(input({ mauBounds: { lower: 195_000, upper: 230_000 } }))
    expect(s.narrow_audience.mau_bounds).toEqual({ lower: 195_000, upper: 230_000, label: MAU_BOUNDS_LABEL })
    expect(MAU_BOUNDS_LABEL).toMatch(/NOT Ads Manager/)
    // absent bounds → no mau_bounds key content
    expect(buildAdsetDeliverySignals(input()).narrow_audience.mau_bounds).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The inference read KEY NAMES out of JSON.stringify(targeting), not values. Meta returns
// `targeting_automation` on EVERY modern ad set (in every payload observed) whether expansion is on
// (advantage_audience: 1) or off (0), so the substring always matched, `narrow: true` was
// unreachable against real payloads, and the "Small audience" learning-limited cause could never
// fire. The fixtures above hid it by omitting `targeting_automation` entirely — a shape Meta never
// actually returns.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A realistic modern Meta targeting spec. `targeting_automation` is ALWAYS present; only its value moves. */
function metaTargeting(over: { advantageAudience?: 0 | 1; audiences?: { id: string; name: string }[] } = {}) {
  return {
    age_min: 25,
    age_max: 65,
    geo_locations: { cities: [{ key: '2999001', radius: 25 }] },
    targeting_automation: {
      advantage_audience: over.advantageAudience ?? 0,
      individual_setting: { age: 1, geo: 0, gender: 1 },
    },
    ...(over.audiences ? { custom_audiences: over.audiences } : {}),
  }
}

// Learning-exit FEASIBILITY. The contract already narrates results_to_exit ("needs 48 more"),
// which silently implies waiting will get there. At small-account economics it will not: the
// arithmetic is the answer, and no control in the 72-item catalog does it.
//
// Cost per optimization event is scoped to spend SINCE THE LAST SIGNIFICANT EDIT, because that is
// exactly the period Meta's learning counter covers — it resets on edits. Using window spend
// against a counter that reset mid-window would overstate cost per event.
describe('learning-exit feasibility (can this budget ever exit learning?)', () => {
  const sevenDays = (perDay: number) =>
    Array.from({ length: 7 }, (_, i) => ({ date: `2026-07-${String(10 + i).padStart(2, '0')}`, spend: perDay }))

  it('derives cost per event and the daily budget that would actually reach 50/week', () => {
    // $42/day × 7 = $294 since the edit, 6 events → $49/event.
    const s = buildAdsetDeliverySignals(input({
      learningStage: 'LEARNING',
      learningConversions: 6,
      lastSigEditTs: '2026-07-10T00:00:00Z',
      dailyBudget: 42,
      days: sevenDays(42),
    }))
    const f = s.learning_exit_feasibility
    expect(f.cost_per_optimization_event).toBe(49)
    // 50 events/wk × $49 ÷ 7 days
    expect(f.required_daily_budget_for_exit).toBe(350)
    // ($42 × 7) ÷ $49
    expect(f.events_per_week_at_current_budget).toBe(6)
    expect(f.reachable_at_current_budget).toBe(false)
  })

  it('refuses feasibility when the learning counter starts before the fetched spend window', () => {
    const s = buildAdsetDeliverySignals(input({
      learningStage: 'LEARNING',
      learningConversions: 7,
      lastSigEditTs: '2026-06-01T00:00:00Z',
      dataWindowStart: '2026-07-10',
      dailyBudget: 42,
      days: sevenDays(42),
    }))

    expect(s.learning_exit_feasibility).toEqual({
      cost_per_optimization_event: null,
      events_per_week_at_current_budget: null,
      required_daily_budget_for_exit: null,
      reachable_at_current_budget: null,
      basis: expect.stringMatching(/incomplete.*2026-06-01.*2026-07-10/i),
    })
  })

  it('reports reachable when the budget genuinely supports 50/week', () => {
    // $500/day × 7 = $3500, 70 events → $50/event → (500×7)/50 = 70 events/wk.
    const s = buildAdsetDeliverySignals(input({
      learningStage: 'LEARNING',
      learningConversions: 70,
      lastSigEditTs: '2026-07-10T00:00:00Z',
      dailyBudget: 500,
      days: sevenDays(500),
    }))
    expect(s.learning_exit_feasibility.reachable_at_current_budget).toBe(true)
  })

  it('never divides by zero: no events yet means unknown, not unreachable', () => {
    const s = buildAdsetDeliverySignals(input({
      learningStage: 'LEARNING',
      learningConversions: 0,
      lastSigEditTs: '2026-07-10T00:00:00Z',
      dailyBudget: 42,
      days: sevenDays(42),
    }))
    const f = s.learning_exit_feasibility
    expect(f.cost_per_optimization_event).toBeNull()
    expect(f.reachable_at_current_budget).toBeNull()
    expect(f.basis).toMatch(/no optimization events/i)
  })

  it('already exited → not applicable, never a budget demand', () => {
    const s = buildAdsetDeliverySignals(input({
      learningStage: 'SUCCESS',
      learningConversions: 60,
      dailyBudget: 42,
      days: sevenDays(42),
    }))
    const f = s.learning_exit_feasibility
    expect(f.reachable_at_current_budget).toBeNull()
    expect(f.required_daily_budget_for_exit).toBeNull()
    expect(f.basis).toMatch(/exited/i)
  })

  it('scopes spend to the counter reset, not the whole window', () => {
    // 3 days before the edit at $100 must be EXCLUDED; only the 4 days after count.
    const s = buildAdsetDeliverySignals(input({
      learningStage: 'LEARNING',
      learningConversions: 4,
      lastSigEditTs: '2026-07-13T00:00:00Z',
      dailyBudget: 50,
      days: [
        { date: '2026-07-10', spend: 100 }, { date: '2026-07-11', spend: 100 }, { date: '2026-07-12', spend: 100 },
        { date: '2026-07-13', spend: 50 }, { date: '2026-07-14', spend: 50 },
        { date: '2026-07-15', spend: 50 }, { date: '2026-07-16', spend: 50 },
      ],
    }))
    // $200 ÷ 4 events = $50, NOT $500 ÷ 4 = $125.
    expect(s.learning_exit_feasibility.cost_per_optimization_event).toBe(50)
    expect(s.learning_exit_feasibility.basis).toMatch(/since the last significant edit/i)
  })
})

describe('narrow-audience inference reads VALUES, not key names', () => {
  it('custom-audience pool with Advantage+ audience OFF is narrow, despite targeting_automation being present', () => {
    const s = buildAdsetDeliverySignals(input({
      targeting: metaTargeting({
        advantageAudience: 0,
        audiences: [{ id: '238', name: 'Site visitors 120d - Spring' }],
      }),
    }))
    expect(s.narrow_audience.narrow).toBe(true)
    expect(s.narrow_audience.basis).toMatch(/no expansion|not expanded/i)
  })

  it('the same pool with Advantage+ audience ON is not narrow', () => {
    const s = buildAdsetDeliverySignals(input({
      targeting: metaTargeting({
        advantageAudience: 1,
        audiences: [{ id: '238', name: 'Site visitors 120d - Spring' }],
      }),
    }))
    expect(s.narrow_audience.narrow).toBe(false)
    expect(s.narrow_audience.basis).toMatch(/advantage/i)
  })

  it('an audience merely NAMED "Lookalike" is reported as a lookalike pool, not as Meta expansion', () => {
    // Owner-authored audience names must never be conflated with a Meta relaxation signal.
    const s = buildAdsetDeliverySignals(input({
      targeting: metaTargeting({
        advantageAudience: 0,
        audiences: [
          { id: '238', name: 'Site visitors 120d - Spring' },
          { id: '239', name: 'Lookalike (1%) - Site visitors 120d - Spring' },
        ],
      }),
    }))
    expect(s.narrow_audience.narrow).toBe(false)
    expect(s.narrow_audience.basis).toMatch(/lookalike/i)
    expect(s.narrow_audience.basis).not.toMatch(/advantage/i)
  })

  it('legacy targeting_optimization="expansion_all" counts as expansion and is labeled as legacy', () => {
    // Older ad sets (e.g. "Lead Form") carry this instead of targeting_automation.
    const s = buildAdsetDeliverySignals(input({
      targeting: {
        ...metaTargeting({ advantageAudience: 0, audiences: [{ id: '1', name: 'Site visitors' }] }),
        targeting_optimization: 'expansion_all',
      },
    }))
    expect(s.narrow_audience.narrow).toBe(false)
    expect(s.narrow_audience.basis).toMatch(/legacy/i)
  })

  it('what Meta ACTUALLY relaxed overrides the configured spec', () => {
    // Sibling ad-set field targeting_optimization_types. Config says no expansion; Meta reports it
    // relaxed to lookalike anyway. Observed reality wins over configured intent.
    const s = buildAdsetDeliverySignals(input({
      targeting: metaTargeting({
        advantageAudience: 0,
        audiences: [{ id: '238', name: 'Site visitors 120d - Spring' }],
      }),
      targetingRelaxation: [{ key: 'lookalike', value: 1 }],
    }))
    expect(s.narrow_audience.narrow).toBe(false)
    expect(s.narrow_audience.basis).toMatch(/meta relaxed/i)
    expect(s.narrow_audience.basis).toMatch(/lookalike/i)
  })

  it('a relaxation entry of value 0 means Meta relaxed NOTHING and does not broaden the verdict', () => {
    const s = buildAdsetDeliverySignals(input({
      targeting: metaTargeting({
        advantageAudience: 0,
        audiences: [{ id: '238', name: 'Site visitors 120d - Spring' }],
      }),
      targetingRelaxation: [{ key: 'lookalike', value: 0 }],
    }))
    expect(s.narrow_audience.narrow).toBe(true)
  })
})

describe('cause hints', () => {
  it('cites the corpus and only fires while learning', () => {
    const learning = buildAdsetDeliverySignals(input())
    expect(learning.cause_hints.length).toBeGreaterThan(0)
    expect(learning.cause_hints.join(' ')).toMatch(/learning-limited-causes/)
    const exited = buildAdsetDeliverySignals(input({ learningStage: 'SUCCESS' }))
    expect(exited.cause_hints).toHaveLength(0)
  })
})

describe('Meta delivery sub-status evidence', () => {
  it('retains exact current status and substatus codes with their observation time', () => {
    const signal = buildAdsetDeliverySignals(input({
      deliverySubStatus: {
        read_available: true,
        payload: {
          status: 'warning',
          substatuses: ['budget_limited_learning_fail', 'auction_overlap'],
        },
        synced_at: '2026-08-01T20:00:00.000Z',
      },
    }))

    expect(signal.delivery_sub_status).toEqual({
      read_available: true,
      payload: {
        status: 'warning',
        substatuses: ['budget_limited_learning_fail', 'auction_overlap'],
      },
      synced_at: '2026-08-01T20:00:00.000Z',
    })
  })

  it('keeps successful omission separate from unavailable evidence', () => {
    expect(buildAdsetDeliverySignals(input({
      deliverySubStatus: {
        read_available: true,
        payload: null,
        synced_at: '2026-08-01T20:00:00.000Z',
      },
    })).delivery_sub_status).toEqual({
      read_available: true,
      payload: null,
      synced_at: '2026-08-01T20:00:00.000Z',
    })

    expect(buildAdsetDeliverySignals(input()).delivery_sub_status).toEqual({
      read_available: false,
      payload: null,
      synced_at: null,
    })
  })
})
