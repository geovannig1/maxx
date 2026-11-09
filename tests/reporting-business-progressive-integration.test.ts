import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), account: vi.fn(), admin: vi.fn(), health: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.auth } }) }))
vi.mock('@/lib/accounts/active-account', () => ({ resolveOnlyActiveAccount: mocks.account }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: mocks.admin }))
// the gate is per enabled outcome source (src/lib/outcomes/source-health.ts).
vi.mock('@/lib/outcomes/source-health', () => ({ requireOutcomeLedgerHealth: mocks.health }))
import { GET } from '@/app/api/reporting/route'
import { requestReportingPacket } from '@/lib/reporting/request-packet'
import { clearReportingCache } from '@/lib/reporting/loader'

const key = 'from=2026-09-02&to=2026-09-04'
const sourceAsOf = '2026-09-05T16:00:00.000Z'
// `outcomes` rows: the dropped Acuity columns (type id, category, calendar id) live only in raw.
const row = (id: number, date: string, service: string, email: string, price: number) => ({
  id: `00000000-0000-4000-a000-${String(id).padStart(12, '0')}`, currency: 'USD', source_enabled: true,
  ad_account_id: 'account-db', email, outcome_label: 'Studio rental',
  fulfilment_at: service, occurred_at: `${date}T12:00:00Z`, business_date: date,
  gross_value: price, collected_value: price, status: 'confirmed',
  raw: { duration: '90', appointmentTypeID: 1, category: 'Studio Rental', calendarID: 1 },
})
// PostgREST `alias:raw->key` (JSON value) and `alias:raw->>key` (text) projections.
const rawPath = (field: string) => field.match(/^([a-z_]+):raw(->>?)([A-Za-z]+)$/)
const rows = [
  row(1, '2026-09-02', '2026-09-03T15:00:00Z', 'private-repeat@example.test', 171),
  row(2, '2026-08-31', '2026-09-01T15:00:00Z', 'private-prior@example.test', 50),
  row(3, '2026-09-04', '2026-09-10T15:00:00Z', 'private-new@example.test', 200),
  row(4, '2026-08-01', '2026-08-03T15:00:00Z', 'private-repeat@example.test', 100),
]
let release = () => {}, failHistory = false
let reads: Array<{ table: string; fields: string[] }> = []
const controllers: AbortController[] = []
function client(history: Promise<void>) {
  return { from(table: string) {
    let selectedFields: string[] = []
    const filters: Array<(value: typeof rows[number]) => boolean> = []
    const query = {
      select(fields: string) {
        selectedFields = fields.split(',').map(field => field.trim())
        reads.push({ table, fields: selectedFields })
        return query
      },
      eq(field: string, value: string | boolean) { filters.push(entry => String(entry[field as keyof typeof entry]) === String(value)); return query },
      gte(field: string, value: string) { filters.push(entry => String(entry[field as keyof typeof entry]) >= value); return query },
      lte(field: string, value: string) { filters.push(entry => String(entry[field as keyof typeof entry]) <= value); return query },
      lt(field: string, value: string) { filters.push(entry => String(entry[field as keyof typeof entry]) < value); return query },
      order() { return query }, abortSignal() { return query },
      async range(from: number, to: number) {
        if (table !== 'v_business_outcomes' || selectedFields.some(field => rawPath(field) === null && !Object.hasOwn(rows[0], field))) {
          return { data: null, error: { message: 'Unsupported base-table projection' } }
        }
        if (selectedFields.includes('email')) {
          await history
          if (failHistory) return { data: null, error: { message: 'token=private-provider-detail' } }
        }
        const selected = rows.filter(entry => filters.every(filter => filter(entry))).slice(from, to + 1)
        return { data: selected.map(entry => Object.fromEntries(selectedFields.map(field => {
          const path = rawPath(field)
          if (path === null) return [field, entry[field as keyof typeof entry]]
          const value = (entry.raw as Record<string, unknown>)[path[3]]
          return [path[1], value == null ? null : path[2] === '->>' ? String(value) : value]
        }))), error: null }
      },
    }
    return query
  } }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T17:00:00Z')); vi.clearAllMocks(); clearReportingCache()
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test'); vi.stubEnv('REPORTING_PREPARED_ENABLED', 'off')
  reads = []; failHistory = false
  mocks.auth.mockResolvedValue({ data: { user: { id: 'owner', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null })
  mocks.account.mockResolvedValue({ ok: true, account: { id: 'account-db', accountId: 'act_123', accountName: 'Studio' } })
  mocks.health.mockResolvedValue({ lastReconciledAt: sourceAsOf, windowEndDate: '2026-09-04',
    sources: [{ sourceId: 'source-1', kind: 'acuity', completeness: 'reconciled' }] })
  mocks.admin.mockReturnValue(client(new Promise<void>(resolve => { release = resolve })))
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => GET(new NextRequest(`http://localhost${url}`, { ...init, signal: init.signal ?? undefined }))))
})
afterEach(() => { release(); controllers.splice(0).forEach(value => value.abort()); clearReportingCache(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function request(progress = vi.fn()) {
  const abort = new AbortController(); controllers.push(abort)
  return { abort, progress, done: requestReportingPacket('business', key, abort.signal, false, progress).catch(error => error) }
}

describe('real business adapters through loader, route and browser stream', () => {
  it('shows health-gated native core while private history waits, then returns aggregates and reuses the completed cache', async () => {
    const consumer = request()
    await vi.waitFor(() => expect(consumer.progress).toHaveBeenCalledOnce())
    const initial = consumer.progress.mock.calls[0][0]
    expect(initial.result.data.metrics.active_appointments.current.value).toBe(2)
    expect(initial.result.data.metrics.amount_paid.current.value).toBe(371)
    expect(initial.result.data.metrics.recorded_booked_hours.current.value).toBe(3)
    expect(initial.result.asOf).toBe(sourceAsOf)
    expect(initial.result.data.intelligence.customers.state).toBe('loading')
    expect(reads.every(read => read.table === 'v_business_outcomes')).toBe(true)
    expect(reads.filter(read => !read.fields.includes('email'))).toHaveLength(2)
    expect(reads.filter(read => read.fields.includes('email'))).toHaveLength(3)
    release()
    const final = await consumer.done
    expect(final.section).toBe('business')
    expect(final.result.data.intelligence.customers.state).toBe('partial')
    expect(final.result.data.intelligence.customers.data.metrics.prior_booking_customers.current.value).toBe(1)
    expect(final.result.data.intelligence.leadTime.state).toBe('available')
    expect(final.result.data.intelligence.upcoming.state).toBe('partial')
    expect(final.result.data.metrics).toEqual(initial.result.data.metrics)
    expect(JSON.stringify(final)).not.toContain('private-repeat@example.test')
    const count = reads.length, cached = request()
    expect((await cached.done).result).toEqual(final.result)
    expect(cached.progress).not.toHaveBeenCalled()
    expect(reads).toHaveLength(count)
  })
  it('preserves core after history failure and retries that source without caching unavailable enrichment', async () => {
    failHistory = true
    const consumer = request()
    await vi.waitFor(() => expect(consumer.progress).toHaveBeenCalledOnce())
    release()
    const final = await consumer.done
    expect(final.result.state).toBe('partial')
    expect(final.result.data.metrics.active_appointments.current.value).toBe(2)
    expect(final.result.data.intelligence.customers.state).toBe('unavailable')
    expect(JSON.stringify(final)).not.toContain('private-provider-detail')
    failHistory = false
    const retry = request()
    const recovered = await retry.done
    expect(recovered.result.data.intelligence.customers.state).toBe('partial')
    expect(reads.filter(read => read.fields.includes('email'))).toHaveLength(6)
  })
  it('releases an aborted observer while another observer completes the same account read', async () => {
    const first = request()
    await vi.waitFor(() => expect(first.progress).toHaveBeenCalledOnce())
    const second = request()
    await vi.waitFor(() => expect(second.progress).toHaveBeenCalledOnce())
    first.abort.abort()
    expect(await first.done).toMatchObject({ name: 'AbortError' })
    release()
    expect((await second.done).result.data.intelligence.customers.state).toBe('partial')
    expect(reads.filter(read => read.fields.includes('email'))).toHaveLength(3)
    expect(first.progress).toHaveBeenCalledOnce()
  })
  it('never reads business history or core before the owner and source-health checks succeed', async () => {
    mocks.auth.mockResolvedValueOnce({ data: { user: null }, error: null })
    expect(await request().done).toMatchObject({ kind: 'access' })
    expect(reads).toHaveLength(0)
    mocks.auth.mockResolvedValueOnce({ data: { user: { id: 'other', email: 'other@example.test' } }, error: null })
    expect(await request().done).toMatchObject({ kind: 'access' })
    expect(reads).toHaveLength(0)
    mocks.health.mockRejectedValueOnce(new Error('outcome_ledger_window_not_covered'))
    const unhealthy = request()
    expect((await unhealthy.done).result.state).toBe('unavailable')
    expect(unhealthy.progress).not.toHaveBeenCalled()
    expect(reads).toHaveLength(0)
  })
})
