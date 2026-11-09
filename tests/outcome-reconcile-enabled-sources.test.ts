import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reconcileOutcomeSources, reconcilePartialErrors, type SourceReconcileResult } from '@/lib/outcomes/reconciliation'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'

// the sync reconciles only ENABLED outcome sources whose adapter can reconcile. A push-only install
// (signed webhook, CSV) used to run the unconfigured reference adapter's reconcile every sync and log the
// run as partial; now it reconciles nothing and records no partial error, while an enabled reconciling
// source still reconciles (and still fails loudly when it cannot).

function db(rows: Array<{ id: string; kind: string; enabled: boolean }>): SupabaseClient {
  const query = {
    filters: {} as Record<string, unknown>,
    select() { return this },
    eq(column: string, value: unknown) { this.filters[column] = value; return this },
    order() {
      const enabled = rows.filter((r) => this.filters.enabled === undefined || r.enabled === this.filters.enabled)
      return Promise.resolve({ data: enabled.map(({ id, kind }) => ({ id, kind })), error: null })
    },
  }
  return { from: () => query } as unknown as SupabaseClient
}

const reconciling = () => {
  const adapter = getOutcomeAdapter('acuity')!
  expect(typeof adapter.reconcile).toBe('function')
  return vi.spyOn(adapter, 'reconcile')
}
const COVERING: SourceReconcileResult = {
  available: true, truncated: false, completedAt: '2026-11-07T10:00:00Z', sourceWindowBasis: 'booking_date_et',
  windowStartDate: '2020-01-01', windowEndDate: '2026-11-06',
}

afterEach(() => vi.restoreAllMocks())

describe('reconcile only enabled, reconciling sources', () => {
  it('a push-only install reconciles nothing and its sync records no partial error', async () => {
    const spy = reconciling()
    const result = await reconcileOutcomeSources({ supabase: db([{ id: 's1', kind: 'webhook', enabled: true }, { id: 's2', kind: 'csv', enabled: true }]), adAccountId: 'acct' })
    expect(spy).not.toHaveBeenCalled()
    expect(result).toMatchObject({ available: false, noReconcilingSource: true })
    expect(reconcilePartialErrors(result)).toEqual([])
  })

  it('a disabled reconciling source is not reconciled', async () => {
    const spy = reconciling()
    await reconcileOutcomeSources({ supabase: db([{ id: 's1', kind: 'acuity', enabled: false }, { id: 's2', kind: 'webhook', enabled: true }]), adAccountId: 'acct' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('an enabled reconciling source still reconciles (control)', async () => {
    const spy = reconciling().mockResolvedValue(COVERING)
    const result = await reconcileOutcomeSources({ supabase: db([{ id: 's1', kind: 'acuity', enabled: true }, { id: 's2', kind: 'webhook', enabled: true }]), adAccountId: 'acct' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result).toEqual(COVERING)
    expect(reconcilePartialErrors(result)).toEqual([])
  })

  it('an enabled reconciling source that cannot reconcile is still partial (control)', async () => {
    reconciling().mockResolvedValue({ available: false, reason: 'not configured' })
    const result = await reconcileOutcomeSources({ supabase: db([{ id: 's1', kind: 'acuity', enabled: true }]), adAccountId: 'acct' })
    expect(reconcilePartialErrors(result)).toEqual(['outcome-reconcile: not configured'])
    expect(reconcilePartialErrors({ ...COVERING, truncated: true, warnings: ['head write failed'] }))
      .toEqual(['outcome-reconcile: source window was truncated', 'outcome-reconcile: head write failed'])
  })

  it('the sync records reconcile partial errors through reconcilePartialErrors', () => {
    const src = readFileSync('src/lib/sync/orchestrator.ts', 'utf8')
    expect(src).toContain('partialErrors.push(...reconcilePartialErrors(outcomeReconcile))')
  })
})
