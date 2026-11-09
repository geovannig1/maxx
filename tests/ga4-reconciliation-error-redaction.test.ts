import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The reconciliation block is read by the chat model and the MCP tools. A database failure must reach
// them as a stable code, never as raw database text; the detail goes to the server log.
const DB_TEXT = 'permission denied for relation secret_internal_table (SQLSTATE 42501)'

function supabaseWith({ ledgerError = false, boundaryError = false } = {}) {
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, lte: () => chain, order: () => chain,
    range: async () => (ledgerError ? { data: null, error: { message: DB_TEXT } } : { data: [], error: null }),
  }
  return {
    from: () => chain,
    rpc: async () => (boundaryError ? { data: null, error: { message: DB_TEXT } } : { data: null, error: null }),
  }
}

async function load(healthError?: Error) {
  // the gate is per enabled outcome source (src/lib/outcomes/source-health.ts).
  vi.doMock('@/lib/outcomes/source-health', () => ({
    requireOutcomeLedgerHealth: async () => {
      if (healthError) throw healthError
      return { lastReconciledAt: null, windowEndDate: null, sources: [] }
    },
  }))
  vi.doMock('@/lib/ga4/client', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getGa4IdentifiedBookingEvents: async () => ({ events: [], available: true }),
  }))
  return (await import('@/lib/ga4/booking-reconciliation')).buildGa4ReconciliationBlock
}

describe('GA4 reconciliation never hands database text to the model', () => {
  beforeEach(() => { vi.resetModules(); vi.spyOn(console, 'error').mockImplementation(() => undefined) })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('@/lib/outcomes/source-health')
    vi.doUnmock('@/lib/ga4/client')
  })

  const cases: Array<[string, () => Promise<unknown>]> = [
    ['ledger health read failure', async () => (await load(new Error(`outcome_ledger_health_read_failed: ${DB_TEXT}`)))(
      'account-1', '2026-09-01', '2026-09-30', supabaseWith() as never)],
    ['ledger page read failure', async () => (await load())(
      'account-1', '2026-09-01', '2026-09-30', supabaseWith({ ledgerError: true }) as never)],
    ['identity boundary read failure', async () => (await load())(
      'account-1', '2026-09-01', '2026-09-30', supabaseWith({ boundaryError: true }) as never)],
  ]

  for (const [name, run] of cases) {
    it(`redacts a ${name}`, async () => {
      const out = JSON.stringify(await run())
      expect(out).not.toContain('SQLSTATE')
      expect(out).not.toContain('secret_internal_table')
      // Control: the failure is still reported as unavailable, and the detail is logged.
      expect(out).toMatch(/UNAVAILABLE|unavailable/)
      expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('SQLSTATE 42501')
    })
  }

  it('keeps a domain-authored health reason, which carries no database text (control)', async () => {
    const out = JSON.stringify(await (await load(new Error('ledger last synced 3 days ago')))(
      'account-1', '2026-09-01', '2026-09-30', supabaseWith() as never))
    expect(out).toContain('ledger last synced 3 days ago')
  })
})
