import { describe, it, expect } from 'vitest'
import { aggregateByKey, getEntityMetaBatch } from '@/lib/flags/engine'
import type { getAdminClient } from '@/lib/supabase/admin'

// N+1 fix: the flag engine used to fetch audience_type/created_at with one `.maybeSingle()` per
// entity per window (WINDOWS = [1,3,7,30]) → O(entities × windows) round trips inside the daily cron.
// getEntityMetaBatch replaces that with ONE `.in()` query per level whose Map the engine reuses across
// all four windows. These tests pin the batched lookup's contract: id→meta mapping, the missing-row /
// null-audience defaults that match the old per-entity behavior, and that it issues a single query.

type AdminClient = ReturnType<typeof getAdminClient>

interface MetaRow {
  id: string
  audience_type: string | null
  created_at: string | null
}

// Records how getEntityMetaBatch drives the client, so we can assert it batches into one `.in()`.
interface Probe {
  fromCalls: string[]
  inCalls: Array<{ col: string; ids: string[] }>
}

function newProbe(): Probe {
  return { fromCalls: [], inCalls: [] }
}

// Minimal Supabase stand-in for the ONLY chain getEntityMetaBatch uses:
//   from(table).select(cols).in('id', ids) -> Promise<{ data }>
function makeClient(rowsByTable: Record<string, MetaRow[]>, probe: Probe): AdminClient {
  const client = {
    from(table: string) {
      probe.fromCalls.push(table)
      return {
        select() {
          return {
            in(col: string, ids: string[]) {
              probe.inCalls.push({ col, ids })
              const rows = (rowsByTable[table] ?? []).filter((r) => ids.includes(r.id))
              return Promise.resolve({ data: rows, error: null })
            },
          }
        },
      }
    },
  }
  return client as unknown as AdminClient
}

describe('getEntityMetaBatch — batched entity-metadata lookup (N+1 fix)', () => {
  it('maps each ad id to its created_at in a SINGLE .in() query (audience_type is unknown at ad level)', async () => {
    const probe = newProbe()
    // `ads` has NO audience_type column — it lives on adsets. The engine resolves an ad's audience from
    // its parent ad set; this lookup only reads created_at for the too-early age check.
    const client = makeClient(
      {
        ads: [
          { id: 'ad-1', audience_type: null, created_at: '2026-06-01T00:00:00Z' },
          { id: 'ad-2', audience_type: null, created_at: '2026-06-10T00:00:00Z' },
          { id: 'ad-3', audience_type: null, created_at: null },
        ],
      },
      probe
    )

    const map = await getEntityMetaBatch(client, 'ad', ['ad-1', 'ad-2', 'ad-3'])

    expect(map.get('ad-1')).toEqual({ audience_type: 'unknown', created_at: '2026-06-01T00:00:00Z' })
    expect(map.get('ad-2')).toEqual({ audience_type: 'unknown', created_at: '2026-06-10T00:00:00Z' })
    expect(map.get('ad-3')).toEqual({ audience_type: 'unknown', created_at: null })

    // The whole point of the fix: one query for the level, not one per entity.
    expect(probe.fromCalls).toEqual(['ads'])
    expect(probe.inCalls).toEqual([{ col: 'id', ids: ['ad-1', 'ad-2', 'ad-3'] }])
  })

  it('reads the adsets table for the adset level', async () => {
    const probe = newProbe()
    const client = makeClient(
      { adsets: [{ id: 'as-1', audience_type: 'professional', created_at: '2026-05-20T00:00:00Z' }] },
      probe
    )

    const map = await getEntityMetaBatch(client, 'adset', ['as-1'])

    expect(map.get('as-1')).toEqual({ audience_type: 'professional', created_at: '2026-05-20T00:00:00Z' })
    expect(probe.fromCalls).toEqual(['adsets'])
  })

  it('defaults a null adset audience_type to "unknown" (matches the per-entity lookup)', async () => {
    const probe = newProbe()
    const client = makeClient(
      { adsets: [{ id: 'as-1', audience_type: null, created_at: '2026-06-01T00:00:00Z' }] },
      probe
    )

    const map = await getEntityMetaBatch(client, 'adset', ['as-1'])
    expect(map.get('as-1')).toEqual({ audience_type: 'unknown', created_at: '2026-06-01T00:00:00Z' })
  })

  it('omits ids with no matching row so the engine falls back to the default meta', async () => {
    const probe = newProbe()
    const client = makeClient(
      { ads: [{ id: 'ad-1', audience_type: null, created_at: '2026-06-01T00:00:00Z' }] },
      probe
    )

    // 'ad-missing' has no row. The per-entity version returned {unknown, null} here; the batched
    // version omits it and the engine applies DEFAULT_ENTITY_META at the call site — same result.
    const map = await getEntityMetaBatch(client, 'ad', ['ad-1', 'ad-missing'])
    expect(map.has('ad-missing')).toBe(false)
    expect(map.get('ad-1')?.created_at).toBe('2026-06-01T00:00:00Z')
  })

  it('issues NO query for an empty id list (no wasteful .in([]))', async () => {
    const probe = newProbe()
    const client = makeClient({}, probe)

    const map = await getEntityMetaBatch(client, 'ad', [])
    expect(map.size).toBe(0)
    expect(probe.fromCalls).toEqual([])
    expect(probe.inCalls).toEqual([])
  })

  it('collapses duplicate ids to a single map entry', async () => {
    const probe = newProbe()
    const client = makeClient(
      { ads: [{ id: 'ad-1', audience_type: null, created_at: null }] },
      probe
    )

    const map = await getEntityMetaBatch(client, 'ad', ['ad-1', 'ad-1'])
    expect(map.size).toBe(1)
    expect(map.get('ad-1')).toEqual({ audience_type: 'unknown', created_at: null })
  })
})

describe('aggregateByKey — frequency truthfulness', () => {
  it('does not manufacture a multi-day frequency from summed daily reach', () => {
    const result = aggregateByKey([
      { ad_id: 'ad-1', spend: 10, impressions: 100, reach: 50, frequency: 2 },
      { ad_id: 'ad-1', spend: 20, impressions: 200, reach: 50, frequency: 4 },
    ], 'ad_id')

    expect(result.get('ad-1')).toMatchObject({ impressions: 300, frequency: null })
  })

  it('retains the provider-native frequency for a one-day insight only', () => {
    const result = aggregateByKey([
      { ad_id: 'ad-1', spend: 10, impressions: 100, reach: 50, frequency: 2 },
    ], 'ad_id')

    expect(result.get('ad-1')?.frequency).toBe(2)
  })
})
