import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// PROVE the single live-write path cannot fire while write mode is off.
// WRITE_MODE_ENABLED is read at module load (a top-level const), so each case stubs the env and
// imports the executor fresh (vi.resetModules) to re-evaluate that const.
//
// Each case does vi.resetModules() + a fresh dynamic import of the executor's graph, which is
// transform-heavy and can exceed the default 5s/test under full-suite CPU contention (it passes in
// isolation). Give these cases generous headroom so the load flake can't false-fail a security test —
// this only widens the timeout; every assertion below is unchanged.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

describe('executeApprovedChange never writes when write mode is off', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.doUnmock('@/lib/monitoring/alerts')
    vi.doUnmock('@/lib/supabase/admin')
    vi.doUnmock('@sentry/nextjs')
  })

  async function loadExecutorWith(writeMode: string) {
    vi.stubEnv('WRITE_MODE_ENABLED', writeMode)
    const fetchSpy = vi.fn(() => {
      throw new Error('NETWORK CALL ATTEMPTED — a live Meta write must never happen with write mode off')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const emitAlert = vi.fn()
    vi.doMock('@/lib/monitoring/alerts', () => ({ emitAlert }))
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({}) }))
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
    const mod = await import('@/lib/writes/executor')
    return { executeApprovedChange: mod.executeApprovedChange, fetchSpy, emitAlert }
  }

  it('env UNSET → WRITE_MODE_DISABLED, no network call, fires the write_attempt tripwire', async () => {
    const { executeApprovedChange, fetchSpy, emitAlert } = await loadExecutorWith('')
    const res = (await executeApprovedChange('CR-1', 'tester', 'acct-1')) as { status: string }
    expect(res.status).toBe('WRITE_MODE_DISABLED')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(emitAlert).toHaveBeenCalledWith(expect.objectContaining({ area: 'write_attempt', severity: 'critical' }))
  })

  it('env="false" → still blocked (strict === "true", no truthiness coercion)', async () => {
    const { executeApprovedChange, fetchSpy } = await loadExecutorWith('false')
    const res = (await executeApprovedChange('CR-2', 'tester', 'acct-1')) as { status: string }
    expect(res.status).toBe('WRITE_MODE_DISABLED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('env="TRUE" (wrong case) and "1" → still blocked (fail-closed casing)', async () => {
    for (const v of ['TRUE', '1', ' true']) {
      vi.resetModules()
      const { executeApprovedChange, fetchSpy } = await loadExecutorWith(v)
      const res = (await executeApprovedChange('CR-3', 'tester', 'acct-1')) as { status: string }
      expect(res.status).toBe('WRITE_MODE_DISABLED')
      expect(fetchSpy).not.toHaveBeenCalled()
    }
  })
})

// proposeChange refuses insane budgets BEFORE creating any request, and never POSTs.
describe('proposeChange enforces budget hard-bounds and never makes a mutating call', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.doUnmock('@/lib/supabase/admin')
  })

  async function loadProposeWithNoExistingRequest() {
    // GET (captureState) is allowed; a mutating POST must never happen. The spy returns a benign entity.
    // The variadic generic so mock.calls tuples expose the options arg (call[1]) for the POST assertion below.
    const fetchSpy = vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; json: () => Promise<{ daily_budget: string }> }>>(
      async () => ({ ok: true, json: async () => ({ daily_budget: '5000' }) }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubEnv('META_ACCESS_TOKEN', 'fake')
    // Admin client: idempotency lookup returns no existing row; nothing else is reached for a BLOCKED budget.
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: null }),
    }
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({ from: () => builder }) }))
    const mod = await import('@/lib/writes/executor')
    return { proposeChange: mod.proposeChange, fetchSpy }
  }

  it('refuses a budget over the owner-approved account daily ceiling', async () => {
    const { proposeChange, fetchSpy } = await loadProposeWithNoExistingRequest()
    const res = (await proposeChange({
      adAccountDbId: 'TEST-ACCT', actionDecisionId: 'DECISION-1', actionType: 'adjust_budget', entityLevel: 'adset',
      metaEntityId: 'TEST-ADSET-1', params: { new_daily_budget_usd: 999999 },
    })) as { status: string }
    expect(res.status).toBe('BLOCKED')
    // No POST (mutating) call — captureState GET is allowed, but never method:'POST'.
    for (const call of fetchSpy.mock.calls) {
      const opts = call[1] as { method?: string } | undefined
      expect(opts?.method).not.toBe('POST')
    }
  })

  it('refuses a budget below $1/day', async () => {
    const { proposeChange } = await loadProposeWithNoExistingRequest()
    const res = (await proposeChange({
      adAccountDbId: 'TEST-ACCT', actionDecisionId: 'DECISION-1', actionType: 'adjust_budget', entityLevel: 'adset',
      metaEntityId: 'TEST-ADSET-1', params: { new_daily_budget_usd: 0.5 },
    })) as { status: string }
    expect(res.status).toBe('BLOCKED')
  })
})
