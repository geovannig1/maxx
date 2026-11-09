import type { SupabaseClient } from '@supabase/supabase-js'
import { vi } from 'vitest'

export const ACCOUNT = '00000000-0000-4000-8000-000000000801'
export const ACTIVATION = '00000000-0000-4000-8000-000000000802'
export const RUN = '00000000-0000-4000-8000-000000000803'
export const COHORT_RUN = '00000000-0000-4000-8000-000000000804'
export const RECENT_GENERATION = '00000000-0000-4000-8000-000000000805'
export const MATURED_GENERATION = '00000000-0000-4000-8000-000000000806'
export const RECENT_MANIFEST = '00000000-0000-4000-8000-000000000807'
export const MATURED_MANIFEST = '00000000-0000-4000-8000-000000000808'

export type Row = Record<string, unknown>

function dateRange(start: string, end: string): string[] {
  const rows: string[] = []
  const first = new Date(`${start}T00:00:00Z`).getTime()
  const last = new Date(`${end}T00:00:00Z`).getTime()
  for (let at = first; at <= last; at += 86_400_000) rows.push(new Date(at).toISOString().slice(0, 10))
  return rows
}

export function uuid(index: number): string {
  return `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`
}

export function healthyTables(touchCount = 28): Record<string, Row[]> {
  const dates = dateRange('2026-07-02', '2026-07-29')
  const perDay = new Map(dates.map((date) => [date, 1]))
  perDay.set(dates[0], touchCount - (dates.length - 1))
  const insights = dates.flatMap((date) => {
    const landing = perDay.get(date) ?? 1
    return [
      {
        id: uuid(10_000 + Number(date.slice(-2))), ad_account_id: ACCOUNT,
        date_start: date, entity_level: 'account', meta_campaign_id: null,
        meta_adset_id: null, meta_ad_id: null, spend: 10,
        landing_page_views: null, synced_at: '2026-07-30T11:00:00.000Z',
      },
      {
        id: uuid(20_000 + Number(date.slice(-2))), ad_account_id: ACCOUNT,
        date_start: date, entity_level: 'ad', meta_campaign_id: '101',
        meta_adset_id: '201', meta_ad_id: '301', spend: 10,
        landing_page_views: landing, synced_at: '2026-07-30T11:00:00.000Z',
      },
    ]
  })
  const touches: Row[] = []
  let sequence = 1
  for (const date of dates) {
    const count = perDay.get(date) ?? 1
    for (let i = 0; i < count; i += 1) {
      touches.push({
        id: uuid(sequence++), ad_account_id: ACCOUNT,
        observed_at: `${date}T16:${String(i % 60).padStart(2, '0')}:00.000Z`,
        identity_complete: true, meta_campaign_id: '101', meta_adset_id: '201', meta_ad_id: '301',
        // Distinct per touch: each fixture observation stands for its own click.
        fbclid: `fbc-${date}-${i}`,
      })
    }
  }
  return {
    ad_accounts: [{ id: ACCOUNT, account_id: 'act_1', timezone_name: 'America/New_York', is_active: true }],
    paid_measurement_activations: [{
      id: ACTIVATION, ad_account_id: ACCOUNT, activated_at: '2026-06-30T04:00:00.000Z',
      contract_version: 1, policy_version: 1,
    }],
    daily_insights: insights,
    paid_touch_observations: touches,
    outcome_touch_links: [],
    outcomes: [],
    paid_cohort_completeness_manifests: [
      {
        id: RECENT_MANIFEST, ad_account_id: ACCOUNT, evaluation_run_id: RUN,
        cohort_kind: 'recent_scale', window_start: '2026-07-16', window_end: '2026-07-29',
        source_not_before: '2026-07-30T10:00:00.000Z',
        capture_completed_at: '2026-07-30T11:00:00.000Z',
        linker_completed_at: '2026-07-30T11:00:00.000Z',
        capture_complete: true, linker_complete: true,
        contract_version: 1, policy_version: 1,
        capture_eligible_inputs: 14, captured_touches: 14,
        eligible_outcomes: 0, evaluated_outcomes: 0, linked_outcomes: 0,
        blocker_codes: [],
      },
      {
        id: MATURED_MANIFEST, ad_account_id: ACCOUNT, evaluation_run_id: RUN,
        cohort_kind: 'matured_cut', window_start: '2026-07-02', window_end: '2026-07-15',
        source_not_before: '2026-07-30T10:00:00.000Z',
        capture_completed_at: '2026-07-30T11:00:00.000Z',
        linker_completed_at: '2026-07-30T11:00:00.000Z',
        capture_complete: true, linker_complete: true,
        contract_version: 1, policy_version: 1,
        capture_eligible_inputs: touchCount - 14, captured_touches: touchCount - 14,
        eligible_outcomes: 0, evaluated_outcomes: 0, linked_outcomes: 0,
        blocker_codes: [],
      },
    ],
  }
}

export function storedMetrics(zeroValueBookings = 0, canceledLinks = 0): Row {
  return {
    cpa: null,
    roas: null,
    zero_value_bookings: zeroValueBookings,
    canceled_links: canceledLinks,
  }
}

export function cohortGeneration(overrides: Row): Row {
  return {
    id: RECENT_GENERATION,
    ad_account_id: ACCOUNT,
    evaluation_run_id: COHORT_RUN,
    cohort_kind: 'recent_scale',
    window_start: '2026-07-16',
    window_end: '2026-07-29',
    as_of_date: '2026-07-30',
    activation_id: ACTIVATION,
    contract_version: 1,
    policy_version: 2,
    account_spend: '140.25',
    landing_page_views: '20',
    captured_landing_views: '18',
    complete: true,
    blocker_codes: [],
    metrics: storedMetrics(1, 0),
    created_at: '2026-07-30T11:00:00.000Z',
    ...overrides,
  }
}

export function cohortUnit(overrides: Row): Row {
  return {
    id: uuid(910),
    ad_account_id: ACCOUNT,
    generation_id: RECENT_GENERATION,
    entity_level: 'ad',
    entity_id: '301',
    spend: '70.25',
    landing_page_views: '10',
    captured_touches: '9',
    bookings: '2',
    booked_value: '440.50',
    complete: true,
    blocker_codes: [],
    metrics: storedMetrics(1, 0),
    ...overrides,
  }
}

export function publishedCohortTables(): Record<string, Row[]> {
  return {
    ...healthyTables(),
    paid_cohort_generations: [
      cohortGeneration({}),
      cohortGeneration({
        id: MATURED_GENERATION,
        cohort_kind: 'matured_cut',
        window_start: '2026-07-02',
        window_end: '2026-07-15',
        account_spend: 300,
        landing_page_views: 30,
        captured_landing_views: 30,
        metrics: storedMetrics(),
      }),
      cohortGeneration({
        id: uuid(900),
        ad_account_id: uuid(901),
        evaluation_run_id: uuid(902),
        as_of_date: '2026-07-31',
        created_at: '2026-07-31T11:00:00.000Z',
      }),
    ],
    paid_cohort_units: [
      cohortUnit({ complete: false, blocker_codes: ['capture_coverage_mismatch'] }),
      cohortUnit({
        id: uuid(911),
        generation_id: MATURED_GENERATION,
        spend: 120,
        landing_page_views: null,
        captured_touches: 4,
        bookings: 0,
        booked_value: 0,
        metrics: storedMetrics(0, 2),
      }),
      cohortUnit({ id: uuid(912), entity_level: 'account', entity_id: 'act_1' }),
      ...Array.from({ length: 1001 }, (_, index) => cohortUnit({
        id: uuid(10_000 + index),
        entity_level: 'campaign',
        entity_id: `campaign-${index}`,
      })),
    ],
  }
}

export function invalidArtifactTables(args: { generation?: Row; unit?: Row }): Record<string, Row[]> {
  return artifactTablesWith({ generations: { 0: args.generation ?? {} }, units: { 0: args.unit ?? {} } })
}

export function artifactTablesWith(args: {
  generations?: Record<number, Row>
  units?: Record<number, Row>
}): Record<string, Row[]> {
  const tables = publishedCohortTables()
  return {
    ...tables,
    paid_cohort_generations: tables.paid_cohort_generations.map((row, index) => (
      { ...row, ...(args.generations?.[index] ?? {}) }
    )),
    paid_cohort_units: tables.paid_cohort_units.slice(0, 3).map((row, index) => (
      { ...row, ...(args.units?.[index] ?? {}) }
    )),
  }
}

export function fakeDb(tables: Record<string, Row[]>, errorTable?: string) {
  const queries: Array<{ table: string; filters: Record<string, unknown>; range?: [number, number] }> = []
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const generations = args.p_generations as Array<{ id: string; cohort_kind: string }>
    return {
      data: {
        evaluation_run_id: args.p_evaluation_run_id,
        recent_generation_id: generations.find((row) => row.cohort_kind === 'recent_scale')?.id,
        matured_generation_id: generations.find((row) => row.cohort_kind === 'matured_cut')?.id,
      },
      error: null,
    }
  })
  const from = vi.fn((table: string) => {
    let rows = [...(tables[table] ?? [])]
    let selectedColumns: string[] | null = null
    const orders: Array<{ column: string; direction: number }> = []
    let selectedRange: [number, number] | null = null
    let selectedLimit: number | null = null
    const record = { table, filters: {} as Record<string, unknown>, range: undefined as [number, number] | undefined }
    queries.push(record)
    const settle = () => {
      if (errorTable === table) return { data: null, error: { message: `${table} unavailable` } }
      let resultRows = [...rows].sort((left, right) => {
        for (const order of orders) {
          const comparison = String(left[order.column]).localeCompare(String(right[order.column]))
          if (comparison !== 0) return comparison * order.direction
        }
        return 0
      })
      if (selectedRange) resultRows = resultRows.slice(selectedRange[0], selectedRange[1] + 1)
      else if (selectedLimit !== null) resultRows = resultRows.slice(0, selectedLimit)
      return {
        data: selectedColumns
          ? resultRows.map((row) => Object.fromEntries(selectedColumns!.map((column) => [column, row[column]])))
          : resultRows,
        error: null,
      }
    }
    const chain: Record<string, unknown> = {}
    chain.select = (columns: string) => {
      selectedColumns = columns.split(',').map((column) => column.trim())
      return chain
    }
    chain.eq = (column: string, value: unknown) => {
      record.filters[column] = value
      rows = rows.filter((row) => row[column] === value)
      return chain
    }
    chain.in = (column: string, values: unknown[]) => {
      record.filters[column] = values
      rows = rows.filter((row) => values.some((value) => String(value) === String(row[column])))
      return chain
    }
    chain.gte = (column: string, value: string) => {
      record.filters[`${column}.gte`] = value
      rows = rows.filter((row) => String(row[column]) >= value)
      return chain
    }
    chain.lte = (column: string, value: string) => {
      record.filters[`${column}.lte`] = value
      rows = rows.filter((row) => String(row[column]) <= value)
      return chain
    }
    chain.order = (column: string, options?: { ascending?: boolean }) => {
      orders.push({ column, direction: options?.ascending === false ? -1 : 1 })
      return chain
    }
    chain.range = (start: number, end: number) => {
      record.range = [start, end]
      selectedRange = [start, end]
      return chain
    }
    chain.limit = (count: number) => { selectedLimit = count; return chain }
    chain.maybeSingle = async () => {
      const result = settle()
      if (result.error) return result
      const resultRows = result.data ?? []
      return { data: resultRows.length === 1 ? resultRows[0] : null, error: resultRows.length > 1 ? { message: 'multiple rows' } : null }
    }
    chain.then = (resolve: (value: ReturnType<typeof settle>) => unknown) => resolve(settle())
    return chain
  })
  const db = { from, rpc } as unknown as SupabaseClient
  return { db, queries, rpc }
}

export const context = {
  evaluationRunId: RUN,
  asOfDate: '2026-07-30',
  sourceNotBefore: '2026-07-30T10:00:00.000Z',
  appointmentSourceComplete: true,
  appointmentSourceHead: '2026-07-30T11:00:00.000Z',
  appointmentSourceWindowBasis: 'booking_date_et' as const,
  appointmentSourceWindowStart: '2025-01-01',
  appointmentSourceWindowEnd: '2027-12-31',
}
