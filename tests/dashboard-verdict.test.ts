import { describe, it, expect } from 'vitest'
import { computeAccountVerdict, verdictTone, type VerdictInput } from '@/lib/dashboard/verdict'

const base: VerdictInput = { dataMode: 'sufficient', criticalAlerts: 0, stale: false, pendingApprovals: 0, metaRead: { available: true } }

describe('computeAccountVerdict', () => {
  it('is dormant when pre-launch (nothing to judge)', () => {
    const v = computeAccountVerdict({ ...base, dataMode: 'pre_launch' })
    expect(v.level).toBe('dormant')
    expect(v.needsAttention).toBe(false)
    expect(verdictTone(v.level)).toBe('neutral')
  })

  it('renders read failure as unavailable before interpreting an empty account as dormant', () => {
    const v = computeAccountVerdict({
      ...base,
      dataMode: 'pre_launch',
      metaRead: { available: false, unavailableReason: 'More than one active ad account is configured.' },
    })
    expect(v.level).toBe('needs_attention')
    expect(v.headline).toBe('Meta data unavailable')
    expect(v.factors).toContain('More than one active ad account is configured.')
  })

  it('needs attention on a critical alert', () => {
    const v = computeAccountVerdict({ ...base, criticalAlerts: 2 })
    expect(v.level).toBe('needs_attention')
    expect(v.needsAttention).toBe(true)
    expect(v.factors.some((f) => /2 critical alerts/.test(f))).toBe(true)
    expect(verdictTone(v.level)).toBe('danger')
  })

  it('watches on low-data or stale data', () => {
    expect(computeAccountVerdict({ ...base, dataMode: 'low_data' }).level).toBe('watch')
    expect(computeAccountVerdict({ ...base, stale: true }).level).toBe('watch')
    expect(verdictTone('watch')).toBe('warning')
  })

  it('dormant takes precedence over a critical alert (no delivery to act on)', () => {
    expect(computeAccountVerdict({ ...base, dataMode: 'pre_launch', criticalAlerts: 3 }).level).toBe('dormant')
  })

  it('reports only that no system blockers were observed when data is current', () => {
    const v = computeAccountVerdict(base)
    expect(v.level).toBe('observed')
    expect(v.headline).toMatch(/no system blockers observed/i)
    expect(`${v.detail} ${v.factors.join(' ')}`).not.toMatch(/healthy|keep|scale|raise|cut|pause|winner|loser/i)
    expect(v.needsAttention).toBe(false)
    expect(verdictTone(v.level)).toBe('neutral')
  })

  it('surfaces pending approvals as a reason without overriding the level', () => {
    const v = computeAccountVerdict({ ...base, pendingApprovals: 3 })
    expect(v.level).toBe('watch')
    expect(v.needsAttention).toBe(true)
    expect(v.factors.some((f) => /3 changes awaiting/.test(f))).toBe(true)
  })
})
