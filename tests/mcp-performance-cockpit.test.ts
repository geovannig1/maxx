import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  load: vi.fn(),
  db: { marker: 'mcp-db' },
}))

vi.mock('@/mcp/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }))
vi.mock('@/mcp/lib/supabase', () => ({ getSupabaseClient: () => state.db }))
vi.mock('@/lib/cockpit/builder', () => ({
  loadPerformanceCockpitData: state.load,
}))

describe('getPerformanceCockpit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T16:00:00.000Z'))
    state.load.mockReset()
  })

  it('returns the canonical selected-window cockpit claims without a hidden window', async () => {
    const cockpit = {
      claims: { 'meta.spend:2026-08-01:2026-08-20': { claimId: 'meta.spend:2026-08-01:2026-08-20' } },
      decisionIds: ['decision-1'],
    }
    state.load.mockResolvedValue(cockpit)

    const { getPerformanceCockpit } = await import('@/mcp/tools/performance-cockpit')
    const result = await getPerformanceCockpit({
      start_date: '2026-08-01',
      end_date: '2026-08-20',
    })

    expect(state.load).toHaveBeenCalledWith({
      range: { from: '2026-08-01', to: '2026-08-20' },
      db: state.db,
    })
    expect(result).toEqual(cockpit)
    expect(result).not.toHaveProperty('action_decision_ids')
  })

  it('clamps current/future dates to the last closed New York day', async () => {
    state.load.mockResolvedValue({ claims: {}, decisionIds: [] })

    const { getPerformanceCockpit } = await import('@/mcp/tools/performance-cockpit')
    await getPerformanceCockpit({ start_date: '2026-08-21', end_date: '2026-08-21' })

    expect(state.load).toHaveBeenCalledWith({
      range: { from: '2026-08-20', to: '2026-08-20' },
      db: state.db,
    })
  })
})
