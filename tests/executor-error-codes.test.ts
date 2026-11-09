import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// executor results are the HTTP body of POST /api/changes/[id]; database text must never reach
// them. Failures return stable codes and the detail goes to the server log.

const SECRET_DB_TEXT = 'relation "private_table" violates policy for role service_role'
type Result = { data: unknown; error: { message: string } | null }

function database(handler: (table: string, op: string) => Result) {
  return {
    from(table: string) {
      let op = 'select'
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.insert = () => { op = 'insert'; return b }
      b.update = () => { op = 'update'; return b }
      b.eq = () => b
      b.single = async () => handler(table, op)
      b.maybeSingle = async () => handler(table, op)
      return b
    },
    rpc: async () => ({ data: null, error: { message: SECRET_DB_TEXT } }),
  }
}

beforeEach(() => { vi.resetModules(); vi.stubEnv('WRITE_MODE_ENABLED', 'true') })
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  vi.doUnmock('@/lib/supabase/admin'); vi.doUnmock('@/lib/monitoring/alerts'); vi.doUnmock('@sentry/nextjs')
})

async function load(handler: (table: string, op: string) => Result) {
  vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => database(handler) }))
  vi.doMock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))
  vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return import('@/lib/writes/executor')
}

describe('executor results carry codes, not database text', () => {
  it('a failed change-request read is NOT_FOUND without the database message', async () => {
    const { executeApprovedChange } = await load(() => ({ data: null, error: { message: SECRET_DB_TEXT } }))
    const result = await executeApprovedChange('change-1', 'owner', 'account-a')
    expect(result).toEqual({ status: 'NOT_FOUND' })
    expect(console.error).toHaveBeenCalledWith(expect.any(String), SECRET_DB_TEXT)
  })

  it('a failed lookup during proposal is DATABASE_ERROR without the database message', async () => {
    const { proposeChange } = await load(() => ({ data: null, error: { message: SECRET_DB_TEXT } }))
    const result = await proposeChange({
      adAccountDbId: 'account-a', actionDecisionId: 'decision-1', actionType: 'pause_ad',
      entityLevel: 'ad', metaEntityId: 'ad-1', params: {},
    })
    expect(result).toEqual({ status: 'ERROR', error: 'DATABASE_ERROR' })
    expect(JSON.stringify(result)).not.toContain('private_table')
  })
})
