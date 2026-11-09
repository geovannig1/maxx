import { describe, it, expect } from 'vitest'
import { getRecLineageStatus, lineageNotice } from '@/lib/flags/generations'
import type { getAdminClient } from '@/lib/supabase/admin'

// Durable generations — the READ-TIME lineage resolver. The prior implementation compared the
// rec generation's parent flag gen to the GLOBAL current flag head, so every new day's sync falsely marked
// yesterday's valid report "last-known-complete". These pin the corrected contract: DATE-SCOPED comparison
// (latest flag gen for the rec gen's OWN reference_date), account+kind-scoped reads, and FIVE honest states
// where "unable to verify" is never presented as "current".

type Client = ReturnType<typeof getAdminClient>
const ACCT = 'acct-1'

// Minimal supabase stand-in for the two decision_generations reads the resolver makes. Records the .eq()
// filters of each query so we can assert the flag lookup is scoped to the rec gen's reference_date.
function makeClient(responses: Array<{ data: unknown; error: unknown }>) {
  const queries: Array<Record<string, string>> = []
  let call = 0
  const mkBuilder = () => {
    const filters: Record<string, string> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select() { return b },
      eq(col: string, val: string) { filters[col] = val; return b },
      is(col: string, val: unknown) { filters[col] = `is:${String(val)}`; return b }, // rolled_back_at filter
      order() { return b },
      limit() { return b },
      maybeSingle() { queries.push(filters); return Promise.resolve(responses[call++] ?? { data: null, error: null }) },
    }
    return b
  }
  const client = { from() { return mkBuilder() } } as unknown as Client
  return { client, queries }
}

const recRow = (parent: string | null, refDate = '2026-06-15', rolledBack: string | null = null) =>
  ({ data: { parent_generation_id: parent, committed_at: '2026-06-15T00:00:00Z', reference_date: refDate, rolled_back_at: rolledBack }, error: null })
const flagRow = (id: string | null) => ({ data: id ? { id } : null, error: null })

describe('getRecLineageStatus — date-scoped, FIVE-state, account/kind-scoped', () => {
  it('no_snapshot when nothing is pinned (I1) — deterministic shared copy, never LLM prose', async () => {
    const { client } = makeClient([])
    const s = await getRecLineageStatus(client, ACCT, null)
    expect(s.state).toBe('no_snapshot')
    expect(lineageNotice(s)).toBe('No committed recommendation snapshot is available for this date.')
  })

  it('current when the parent is still the latest flag gen FOR THE REC DATE', async () => {
    const { client, queries } = makeClient([recRow('F1'), flagRow('F1')])
    const s = await getRecLineageStatus(client, ACCT, 'R1')
    expect(s.state).toBe('current')
    expect(lineageNotice(s)).toBeNull()
    // The flag lookup is DATE-scoped (kind=flag + the rec gen's reference_date), not the global head.
    expect(queries[1]).toMatchObject({ ad_account_id: ACCT, kind: 'flag', reference_date: '2026-06-15' })
  })

  it('last_known_complete when a newer flag gen committed FOR THE SAME DATE (same-date recompute)', async () => {
    const { client } = makeClient([recRow('F1'), flagRow('F2')])
    const s = await getRecLineageStatus(client, ACCT, 'R1')
    expect(s.state).toBe('last_known_complete')
    expect(lineageNotice(s)).toMatch(/last-known-complete/i)
  })

  it('REGRESSION: a normal next-day advance does NOT mark yesterday stale (date-scoped, not global head)', async () => {
    // The resolver asks for the latest flag gen for the rec gen's OWN date (2026-06-15) → still F1, even
    // though a newer flag gen exists for 2026-06-16. The date filter is what prevents the false positive.
    const { client, queries } = makeClient([recRow('F1', '2026-06-15'), flagRow('F1')])
    const s = await getRecLineageStatus(client, ACCT, 'R1')
    expect(s.state).toBe('current')
    expect(queries[1].reference_date).toBe('2026-06-15')
  })

  it('unknown (never "current") on a manifest read error', async () => {
    const { client } = makeClient([{ data: null, error: { message: 'boom' } }])
    const s = await getRecLineageStatus(client, ACCT, 'R1')
    expect(s.state).toBe('unknown')
    expect(lineageNotice(s)).toMatch(/could not be verified/i)
  })

  it('unknown when the manifest is missing (mismatched account/kind/id)', async () => {
    const { client } = makeClient([{ data: null, error: null }])
    const s = await getRecLineageStatus(client, ACCT, 'R1')
    expect(s.state).toBe('unknown')
  })

  it('unknown when no flag gen exists for the date (cannot verify)', async () => {
    const { client } = makeClient([recRow('F1'), flagRow(null)])
    const s = await getRecLineageStatus(client, ACCT, 'R1')
    expect(s.state).toBe('unknown')
  })

  it('the rec manifest read is account+kind scoped', async () => {
    const { client, queries } = makeClient([recRow('F1'), flagRow('F1')])
    await getRecLineageStatus(client, ACCT, 'R1')
    expect(queries[0]).toMatchObject({ id: 'R1', ad_account_id: ACCT, kind: 'recommendation' })
  })

  it('ROLLED_BACK: a rolled-back pin gets its own state — never last_known_complete', async () => {
    // Without the dedicated state, the (also rolled-back) parent vs the RESTORED flag lineage would read
    // last_known_complete — "a newer run committed" — the OPPOSITE of a deliberate restore to older state.
    const { client } = makeClient([recRow('F1', '2026-06-15', '2026-06-16T00:00:00Z')])
    const s = await getRecLineageStatus(client, ACCT, 'R1')
    expect(s.state).toBe('rolled_back')
    expect(lineageNotice(s)).toMatch(/rolled back.*do not act/i)
  })
})
