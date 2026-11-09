import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PaidCohortEvaluationArtifact } from '@/lib/attribution/paid-cohort-store'

const { readArtifact, projectionControl } = vi.hoisted(() => ({
  readArtifact: vi.fn(),
  projectionControl: { failWithMetadata: false },
}))

vi.mock('@/lib/attribution/paid-cohort-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/attribution/paid-cohort-store')>(),
  readLatestPaidCohortArtifact: readArtifact,
}))

vi.mock('@/lib/creative/paid-outcomes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/creative/paid-outcomes')>()
  return {
    ...actual,
    projectPaidCreativeOutcomes: (...args: Parameters<typeof actual.projectPaidCreativeOutcomes>) => {
      if (projectionControl.failWithMetadata && args[2].size > 0) {
        throw new Error('synthetic projection failure')
      }
      return actual.projectPaidCreativeOutcomes(...args)
    },
  }
})

import { readPaidCreativeOutcomes } from '@/lib/creative/paid-outcomes-store'

const ACCOUNT = '00000000-0000-4000-8000-000000000101'
const RUN = '00000000-0000-4000-8000-000000000102'
const RECENT = '00000000-0000-4000-8000-000000000103'
const MATURED = '00000000-0000-4000-8000-000000000104'
type Row = Record<string, unknown>

function uuid(index: number): string {
  return `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`
}

function unit(generationId: string, metaAdId: string) {
  return {
    id: uuid(Number(metaAdId)), generationId, metaAdId, spend: 10, landingPageViews: 2,
    capturedTouches: 1, bookings: 1, bookedValue: 100, complete: true, blockerCodes: [],
    zeroValueBookings: 0, canceledLinks: 0,
  }
}

function artifact(): PaidCohortEvaluationArtifact {
  const generation = (
    generationId: string,
    cohortKind: 'recent_scale' | 'matured_cut',
    windowStart: string,
    windowEnd: string,
  ) => ({
    generationId, cohortKind, windowStart, windowEnd, asOfDate: '2026-07-30',
    activationId: uuid(5), contractVersion: 1, policyVersion: 1, complete: true, blockerCodes: [],
  })
  return {
    evaluationRunId: RUN,
    recentScale: {
      generation: generation(RECENT, 'recent_scale', '2026-07-16', '2026-07-29'),
      adUnits: [unit(RECENT, '301'), unit(RECENT, '302')],
    },
    maturedCut: {
      generation: generation(MATURED, 'matured_cut', '2026-07-02', '2026-07-15'),
      adUnits: [unit(MATURED, '301')],
    },
  }
}

function observation(
  index: number,
  metaAdId: string,
  metaCreativeId: string,
  observedAt: string,
): Row {
  return {
    id: uuid(index), ad_account_id: ACCOUNT, meta_ad_id: metaAdId,
    meta_creative_id: metaCreativeId, observed_at: observedAt,
    meta_updated_time: '2026-06-01T12:00:00.000Z',
  }
}

interface QueryLog {
  table: string
  filters: Record<string, unknown>
  orders: string[]
  range?: [number, number]
}

interface FakeDbOptions {
  repeatFullAssignmentPage?: boolean
}

function fakeDb(
  tables: Record<string, Row[]>,
  errorTable?: string,
  options: FakeDbOptions = {},
) {
  const queries: QueryLog[] = []
  const from = vi.fn((table: string) => {
    let rows = [...(tables[table] ?? [])]
    let columns: string[] | null = null
    let range: [number, number] | undefined
    const orders: Array<{ column: string; direction: number }> = []
    const log: QueryLog = { table, filters: {}, orders: [] }
    queries.push(log)
    const settle = () => {
      if (errorTable === table) return { data: null, error: { message: `${table} unavailable` } }
      if (
        options.repeatFullAssignmentPage
        && table === 'ad_creative_assignment_observations'
        && range
      ) {
        const page = Math.floor(range[0] / 1_000)
        const source = observation(
          10_000 + page,
          '301',
          '501',
          new Date(Date.UTC(2026, 0, 1, 0, page)).toISOString(),
        )
        const row = columns
          ? Object.fromEntries(columns.map((column) => [column, source[column]]))
          : source
        const fullPage: Row[] = [row]
        fullPage.length = 1_000
        Object.defineProperty(fullPage, Symbol.iterator, {
          value: function* iterateFullPage() { yield row },
        })
        return { data: fullPage, error: null }
      }
      let result = [...rows].sort((left, right) => {
        for (const order of orders) {
          const comparison = String(left[order.column]).localeCompare(String(right[order.column]))
          if (comparison !== 0) return comparison * order.direction
        }
        return 0
      })
      if (range) result = result.slice(range[0], range[1] + 1)
      return {
        data: columns
          ? result.map((row) => Object.fromEntries(columns!.map((column) => [column, row[column]])))
          : result,
        error: null,
      }
    }
    const chain: Record<string, unknown> = {}
    chain.select = (selection: string) => {
      columns = selection.split(',').map((column) => column.trim())
      return chain
    }
    chain.eq = (column: string, value: unknown) => {
      log.filters[column] = value
      rows = rows.filter((row) => row[column] === value)
      return chain
    }
    chain.in = (column: string, values: unknown[]) => {
      log.filters[column] = values
      rows = rows.filter((row) => values.includes(row[column]))
      return chain
    }
    chain.order = (column: string, options?: { ascending?: boolean }) => {
      log.orders.push(column)
      orders.push({ column, direction: options?.ascending === false ? -1 : 1 })
      return chain
    }
    chain.range = (start: number, end: number) => {
      range = [start, end]
      log.range = range
      return chain
    }
    chain.maybeSingle = async () => {
      const result = settle()
      if (result.error) return result
      const data = result.data ?? []
      return { data: data.length === 1 ? data[0] : null, error: data.length > 1 ? { message: 'multiple' } : null }
    }
    chain.then = (resolve: (value: ReturnType<typeof settle>) => unknown) => resolve(settle())
    return chain
  })
  return { db: { from } as unknown as SupabaseClient, queries }
}

function stableTables(): Record<string, Row[]> {
  const historic = Array.from({ length: 998 }, (_, index) => observation(
    index + 1,
    '301',
    '501',
    new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  ))
  return {
    ad_accounts: [{ id: ACCOUNT, timezone_name: 'America/New_York' }],
    ad_creative_assignment_observations: [
      ...historic,
      observation(1_001, '301', '501', '2026-07-02T04:00:00.000Z'),
      observation(1_002, '301', '501', '2026-07-16T04:00:00.000Z'),
      observation(1_003, '301', '501', '2026-07-30T04:00:00.000Z'),
      observation(1_004, '302', '502', '2026-07-16T04:00:00.000Z'),
      observation(1_005, '302', '502', '2026-07-30T04:00:00.000Z'),
    ],
    creatives: [
      { ad_account_id: ACCOUNT, creative_id: '501', creative_name: 'One', thumbnail_url: 'https://img/1' },
      { ad_account_id: ACCOUNT, creative_id: '502', creative_name: 'Two', thumbnail_url: null },
      { ad_account_id: uuid(999), creative_id: '501', creative_name: 'Wrong account', thumbnail_url: null },
    ],
  }
}

describe('readPaidCreativeOutcomes', () => {
  beforeEach(() => {
    readArtifact.mockReset()
    projectionControl.failWithMetadata = false
  })

  it('validates account identity before any governed read', async () => {
    const { db, queries } = fakeDb(stableTables())
    await expect(readPaidCreativeOutcomes(db, 'not-a-uuid')).rejects.toMatchObject({ code: 'INPUT_INVALID' })
    expect(readArtifact).not.toHaveBeenCalled()
    expect(queries).toHaveLength(0)
  })

  it('returns not-published before reading account or assignment state when no pair exists', async () => {
    readArtifact.mockResolvedValue(null)
    const { db, queries } = fakeDb(stableTables())
    await expect(readPaidCreativeOutcomes(db, ACCOUNT)).resolves.toMatchObject({
      status: 'not_published', evaluation_run_id: null, recent_scale: null, matured_cut: null,
    })
    expect(queries).toHaveLength(0)
  })

  it('strictly reads timezone and all scoped required assignment history with deterministic paging', async () => {
    readArtifact.mockResolvedValue(artifact())
    const { db, queries } = fakeDb(stableTables())
    const result = await readPaidCreativeOutcomes(db, ACCOUNT)

    expect(result.status).toBe('available')
    expect(result.recent_scale?.creatives).toMatchObject([
      { meta_creative_id: '501', creative_name: 'One', contributing_meta_ad_ids: ['301'] },
      { meta_creative_id: '502', creative_name: 'Two', contributing_meta_ad_ids: ['302'] },
    ])
    const accountQuery = queries.find((query) => query.table === 'ad_accounts')
    expect(accountQuery?.filters).toEqual({ id: ACCOUNT })
    const assignmentQueries = queries.filter((query) =>
      query.table === 'ad_creative_assignment_observations'
    )
    expect(assignmentQueries.map((query) => query.range)).toEqual([[0, 999], [1000, 1999]])
    for (const query of assignmentQueries) {
      expect(query.filters).toEqual({ ad_account_id: ACCOUNT, meta_ad_id: ['301', '302'] })
      expect(query.orders).toEqual(['observed_at', 'id'])
    }
    const metadataQuery = queries.find((query) => query.table === 'creatives')
    expect(metadataQuery?.filters).toEqual({ ad_account_id: ACCOUNT, creative_id: ['501', '502'] })
  })

  it('throws the typed page-limit error after 100 consecutive full assignment pages', async () => {
    readArtifact.mockResolvedValue(artifact())
    const { db, queries } = fakeDb(stableTables(), undefined, {
      repeatFullAssignmentPage: true,
    })

    await expect(readPaidCreativeOutcomes(db, ACCOUNT)).rejects.toMatchObject({
      name: 'PaidCreativeOutcomesStoreError',
      code: 'SOURCE_PAGE_LIMIT_EXCEEDED',
    })

    const assignmentQueries = queries.filter((query) =>
      query.table === 'ad_creative_assignment_observations'
    )
    expect(queries).toHaveLength(101)
    expect(assignmentQueries).toHaveLength(100)
    expect(assignmentQueries[0].range).toEqual([0, 999])
    expect(assignmentQueries[99].range).toEqual([99_000, 99_999])
  })

  it('throws on governed account, assignment read, and assignment validation failures', async () => {
    readArtifact.mockResolvedValue(artifact())
    await expect(readPaidCreativeOutcomes(
      fakeDb(stableTables(), 'ad_accounts').db,
      ACCOUNT,
    )).rejects.toMatchObject({ code: 'SOURCE_READ_FAILED' })
    await expect(readPaidCreativeOutcomes(
      fakeDb(stableTables(), 'ad_creative_assignment_observations').db,
      ACCOUNT,
    )).rejects.toMatchObject({ code: 'SOURCE_READ_FAILED' })

    const malformed = stableTables()
    malformed.ad_creative_assignment_observations[0] = {
      ...malformed.ad_creative_assignment_observations[0], observed_at: 'not-an-instant',
    }
    await expect(readPaidCreativeOutcomes(fakeDb(malformed).db, ACCOUNT)).rejects.toMatchObject({
      code: 'SOURCE_DATA_INVALID',
    })
  })

  it('treats display metadata failure as optional without erasing governed identity or totals', async () => {
    readArtifact.mockResolvedValue(artifact())
    const result = await readPaidCreativeOutcomes(fakeDb(stableTables(), 'creatives').db, ACCOUNT)
    expect(result.status).toBe('available')
    expect(result.recent_scale?.creatives).toMatchObject([
      { meta_creative_id: '501', creative_name: null, thumbnail_url: null, outcomes: { booked_value: 100 } },
      { meta_creative_id: '502', creative_name: null, thumbnail_url: null, outcomes: { booked_value: 100 } },
    ])
  })

  it('propagates a projection failure after a successful optional metadata read', async () => {
    readArtifact.mockResolvedValue(artifact())
    projectionControl.failWithMetadata = true

    await expect(readPaidCreativeOutcomes(fakeDb(stableTables()).db, ACCOUNT))
      .rejects.toThrow('synthetic projection failure')
  })

  it('rejects an invalid account timezone even when the pair contains no ad units', async () => {
    const emptyArtifact = artifact()
    emptyArtifact.recentScale.adUnits = []
    emptyArtifact.maturedCut.adUnits = []
    readArtifact.mockResolvedValue(emptyArtifact)
    const tables = stableTables()
    tables.ad_accounts = [{ id: ACCOUNT, timezone_name: 'Not/A_Timezone' }]

    await expect(readPaidCreativeOutcomes(fakeDb(tables).db, ACCOUNT)).rejects.toMatchObject({
      code: 'SOURCE_DATA_INVALID',
    })
  })
})
