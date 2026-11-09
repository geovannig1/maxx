import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  latestRows: [{ date_start: '2026-08-22' }] as Array<Record<string, unknown>>,
  coverageRows: [] as Array<Record<string, unknown>>,
  metricRows: [] as Array<Record<string, unknown>>,
  closedCap: null as string | null,
  coverageRange: null as { start: string | null; end: string | null } | null,
  metricRange: null as { start: string | null; end: string | null } | null,
}))

function dates(start: string, count: number): string[] {
  const first = new Date(`${start}T00:00:00Z`)
  return Array.from({ length: count }, (_, index) => {
    const value = new Date(first)
    value.setUTCDate(value.getUTCDate() + index)
    return value.toISOString().slice(0, 10)
  })
}

function query() {
  let selected = ''
  let start: string | null = null
  let end: string | null = null
  const chain: Record<string, unknown> = {}
  chain.select = (columns: string) => { selected = columns; return chain }
  chain.eq = () => chain
  chain.gte = (column: string, value: string) => {
    if (column === 'date_start') start = value
    return chain
  }
  chain.lte = (column: string, value: string) => {
    if (column === 'date_start') {
      end = value
      if (selected === 'date_start') state.closedCap = value
    }
    return chain
  }
  chain.order = () => chain
  chain.limit = async () => {
    if (selected === 'date_start') return { data: state.latestRows, error: null }
    state.coverageRange = { start, end }
    return { data: state.coverageRows, error: null }
  }
  chain.then = (
    resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => {
    state.metricRange = { start, end }
    return Promise.resolve({ data: state.metricRows, error: null }).then(resolve, reject)
  }
  return chain
}

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: () => query() }),
}))
vi.mock('@/lib/outcomes/ledger-account', () => ({
  resolveAdAccountId: vi.fn(async () => 'account-1'),
}))
vi.mock('@/mcp/tools/operating-mode', () => ({
  getOperatingModeSignalsBasis: vi.fn(async () => 'unavailable'),
}))

import { evaluateRecommendation } from '@/mcp/tools/evaluate-recommendation'

const args = {
  recommendation_type: 'scale' as const,
  target_entity_type: 'ad' as const,
  target_entity_id: 'ad-1',
  observed_fact: 'Delivery changed in the selected window.',
  reason_for_action: 'Gather governed evidence before any change.',
  basis: 'observed_performance' as const,
  window_days: 30,
}

describe('evaluate_recommendation closed-window evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T16:00:00.000Z'))
    state.latestRows = [{ date_start: '2026-08-22' }]
    state.coverageRows = dates('2026-07-24', 30).map((date) => ({
      date_start: date, date_stop: date, spend: 0,
    }))
    state.metricRows = [{
      date_start: '2026-08-22', date_stop: '2026-08-22', spend: 40,
      bookings: 1, impressions: 1_000, clicks: 25, synced_at: '2026-08-23T12:00:00.000Z',
    }]
    state.closedCap = null
    state.coverageRange = null
    state.metricRange = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('evaluates the same inclusive window ending on the latest closed warehouse day', async () => {
    const result = await evaluateRecommendation(args) as {
      evidence_resolution: string
      evidence_window: { start: string; end: string }
      recommendation: unknown
      formatted: unknown
    }

    expect(state.closedCap).toBe('2026-08-23')
    expect(state.coverageRange).toEqual({ start: '2026-07-24', end: '2026-08-22' })
    expect(state.metricRange).toEqual({ start: '2026-07-24', end: '2026-08-22' })
    expect(result.evidence_resolution).toMatch(/2026-07-24\.\.2026-08-22/)
    expect(result.evidence_window).toEqual({ start: '2026-07-24', end: '2026-08-22' })
    expect(result.recommendation).toBeNull()
    expect(result.formatted).toBeNull()
  })

  it('leaves evidence unsourced when the closed account window is incomplete', async () => {
    state.coverageRows = state.coverageRows.slice(1)

    const result = await evaluateRecommendation(args) as {
      recommendation: unknown
      formatted: unknown
      evidence_resolution: string
      gate_passed: boolean
    }

    expect(result.evidence_resolution).toMatch(/closed account delivery window is incomplete/i)
    expect(result.gate_passed).toBe(false)
    expect(result.recommendation).toBeNull()
    expect(result.formatted).toBeNull()
    expect(JSON.stringify(result)).not.toMatch(/\$0|0 bookings|dormant\/pre-launch/i)
    expect(state.metricRange).toBeNull()
  })

  it('does not turn a missing entity metric into a sourced zero', async () => {
    state.metricRows = [{
      date_start: '2026-08-22', date_stop: '2026-08-22', spend: 40,
      bookings: null, impressions: 1_000, clicks: 25, synced_at: '2026-08-23T12:00:00.000Z',
    }]

    const result = await evaluateRecommendation(args) as {
      recommendation: unknown
      formatted: unknown
      evidence_resolution: string
      gate_passed: boolean
    }

    expect(result.evidence_resolution).toMatch(/metric values are incomplete/i)
    expect(result.gate_passed).toBe(false)
    expect(result.recommendation).toBeNull()
    expect(result.formatted).toBeNull()
    expect(JSON.stringify(result)).not.toMatch(/\$0|0 bookings|dormant\/pre-launch/i)
  })

  it('withholds model-authored action wording when authority remains diagnostic-only', async () => {
    const result = await evaluateRecommendation({
      ...args,
      recommendation_type: 'change_optimization_event',
      observed_fact: 'Switch the optimization event to Purchase.',
      reason_for_action: 'Switch the optimization event to Purchase.',
    }) as {
      recommendation: unknown
      formatted: unknown
      action_authority: { tier: string }
    }

    expect(result.action_authority.tier).toBe('diagnostic_only')
    expect(result.recommendation).toBeNull()
    expect(result.formatted).toBeNull()
    expect(JSON.stringify(result)).not.toContain('Switch the optimization event to Purchase.')
  })
})
