import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import pg from 'pg'

// PARSER FAIL-STOP at the pipeline boundary, against the REAL local Supabase.
//
// The defect class: a Meta response whose schema changed used to be mapped field-by-field with
// `?? null`, producing a "successful" record in which every field was null. Downstream that is
// indistinguishable from "Meta has nothing to say" — so a silent contract break read as a clean,
// empty result and the prior durable report was overwritten with confident emptiness.
//
// These tests prove the opposite now holds: a contract violation fails CLOSED, the caller reports
// unavailable with a reason, and the previously stored report is left intact.

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT = '00000000-0000-4000-8000-0000000000fb'
const META_ACCT = 'act_parser_failstop'
const DATE = '2026-05-11'

let c: pg.Client

beforeAll(async () => {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  c = new pg.Client({ connectionString: DB })
  await c.connect()
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role`)
  for (const t of ['daily_reports', 'daily_insights']) await c.query(`DELETE FROM ${t} WHERE ad_account_id=$1`, [ACCT])
  await c.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
  await c.query(`INSERT INTO ad_accounts (id, account_id) VALUES ($1,$2)`, [ACCT, META_ACCT])
  // A prior DURABLE report that must survive every failure below.
  await c.query(
    `INSERT INTO daily_reports (ad_account_id, report_date, summary_text, report_json)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [
      ACCT,
      DATE,
      'PRIOR DURABLE REPORT — must not be overwritten by a parser failure',
      JSON.stringify({ money_basis: {
        version: 1,
        basis: 'outcome_collected_value',
        source_available: false,
        revenue_complete: null,
        observed_collected_value_lower_bound: null,
        covered_outcomes: null,
        total_outcomes: null,
      } }),
    ],
  )
}, 60000)

afterAll(async () => {
  if (c) {
    for (const t of ['daily_reports', 'daily_insights']) await c.query(`DELETE FROM ${t} WHERE ad_account_id=$1`, [ACCT])
    await c.query(`DELETE FROM ad_accounts WHERE id=$1`, [ACCT])
    await c.end()
  }
})

const priorReport = async (): Promise<string | null> => {
  const r = await c.query<{ summary_text: string }>(
    `SELECT summary_text FROM daily_reports WHERE ad_account_id=$1 AND report_date=$2`, [ACCT, DATE],
  )
  return r.rows[0]?.summary_text ?? null
}

describe('recommendation parser — fails closed, never an all-null success', () => {
  afterAll(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('a changed schema reports UNAVAILABLE with a reason, not an empty list', async () => {
    vi.resetModules()
    vi.stubEnv('META_AD_ACCOUNT_ID', META_ACCT)
    // The OLD top-level shape: keys the previous mapper expected, none of which the real payload has.
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => ({ data: [{ recommendations: [{ title: 'x', message: 'y', code: 1 }] }] })),
      MetaApiError: class extends Error { code = 0 },
    }))
    const { fetchMetaRecommendations } = await import('@/lib/platforms/meta/fetch-meta-recommendations')
    const r = await fetchMetaRecommendations()

    expect(r.available).toBe(false)
    if (!r.available) {
      expect(r.reason).toMatch(/did not match the expected contract/)
      expect(r.violation?.errorClass).toBe('no_valid_records')
      expect(r.violation?.apiVersion).toMatch(/^v\d+\.\d+$/)
    }
    // The prior durable report is untouched by the failure.
    expect(await priorReport()).toMatch(/PRIOR DURABLE REPORT/)
    vi.doUnmock('@/lib/platforms/meta/client')
  })

  it('a genuinely EMPTY page is still a valid success — fail-closed is not fail-always', async () => {
    vi.resetModules()
    vi.stubEnv('META_AD_ACCOUNT_ID', META_ACCT)
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => ({ data: [] })),
      MetaApiError: class extends Error { code = 0 },
    }))
    const { fetchMetaRecommendations } = await import('@/lib/platforms/meta/fetch-meta-recommendations')
    const r = await fetchMetaRecommendations()
    expect(r.available).toBe(true)
    if (r.available) expect(r.recommendations).toEqual([])
    vi.doUnmock('@/lib/platforms/meta/client')
  })

  it('a valid nested payload parses with real values (no all-null record)', async () => {
    vi.resetModules()
    vi.stubEnv('META_AD_ACCOUNT_ID', META_ACCT)
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => ({
        data: [{
          recommendations: [{
            object_ids: ['100000000000000003'],
            recommendation_content: { lift_estimate: 0.14, body: 'Consolidate ad sets.', opportunity_score_lift: 6.2 },
            type: 'AUDIENCE_CONSOLIDATION',
            recommendation_stage: 'AVAILABLE',
            recommendation_time: '2026-07-24T09:15:00+0000',
            url: 'https://adsmanager.example.invalid/r/1',
          }],
        }],
      })),
      MetaApiError: class extends Error { code = 0 },
    }))
    const { fetchMetaRecommendations } = await import('@/lib/platforms/meta/fetch-meta-recommendations')
    const r = await fetchMetaRecommendations()
    expect(r.available).toBe(true)
    if (r.available) {
      expect(r.recommendations).toHaveLength(1)
      expect(r.recommendations[0].type).toBe('AUDIENCE_CONSOLIDATION')
      expect(r.recommendations[0].liftEstimate).toBe(0.14)
    }
    vi.doUnmock('@/lib/platforms/meta/client')
  })
})

describe('dataset diagnostics — an API failure yields unavailable, never a fabricated score', () => {
  it('reports unavailable with a reason and NEVER an EMQ number', async () => {
    vi.resetModules()
    vi.stubEnv('META_PIXEL_ID', 'PIX_TEST')
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => { throw new Error('upstream unavailable') }),
      MetaApiError: class extends Error { code = 0 },
    }))
    const { fetchDatasetQuality } = await import('@/lib/platforms/meta/fetch-dataset-quality')
    const r = await fetchDatasetQuality({ datasetId: 'PIX_TEST' })

    expect(r.available).toBe(false)
    if (!r.available) {
      expect(r.reason).toMatch(/UNAVAILABLE — do not substitute an estimate/)
      expect(JSON.stringify(r)).not.toMatch(/match_quality/)
    }
    expect(await priorReport()).toMatch(/PRIOR DURABLE REPORT/)
    vi.doUnmock('@/lib/platforms/meta/client')
  })

  it('a malformed stats envelope does NOT become a zero-filled successful record', async () => {
    vi.resetModules()
    vi.stubEnv('META_PIXEL_ID', 'PIX_TEST')
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => ({ results: [] })), // no `data` key — schema changed
      MetaApiError: class extends Error { code = 0 },
    }))
    const { fetchDatasetQuality } = await import('@/lib/platforms/meta/fetch-dataset-quality')
    const r = await fetchDatasetQuality({ datasetId: 'PIX_TEST' })
    expect(r.available).toBe(false)
    if (!r.available) expect(r.violation?.errorClass).toBe('missing_data_array')
    vi.doUnmock('@/lib/platforms/meta/client')
  })

  it('when it DOES succeed, EMQ is still null and labelled owner-observed', async () => {
    vi.resetModules()
    vi.stubEnv('META_PIXEL_ID', 'PIX_TEST')
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => ({
        data: [{ aggregation: 'match_keys', start_time: '2026-07-25T10:00:00+0000', data: [{ value: 'em', count: 100 }] }],
      })),
      MetaApiError: class extends Error { code = 0 },
    }))
    const { fetchDatasetQuality } = await import('@/lib/platforms/meta/fetch-dataset-quality')
    const r = await fetchDatasetQuality({
      datasetId: 'PIX_TEST',
      nowSec: Date.parse('2026-07-26T00:00:00Z') / 1000,
    })
    expect(r.available).toBe(true)
    if (r.available) {
      expect(r.eventMatchQuality).toBeNull()
      expect(r.eventMatchQualityNote).toMatch(/OWNER-OBSERVED/)
      expect(r.diagnostics.matchKeys[0]).toMatchObject({ value: 'em', count: 100 })
      expect(r.provenance.apiVersion).toMatch(/^v\d+\.\d+$/)
      expect(r.provenance.aggregationsReturned).toContain('match_keys')
    }
    vi.doUnmock('@/lib/platforms/meta/client')
  })
})

describe('CAPI audit persistence failure — surfaced, and delivery state left retryable', () => {
  it('a database failure after Meta acceptance does NOT stamp delivery, so the sweep retries', async () => {
    vi.resetModules()
    vi.stubEnv('ACUITY_CAPI_SEND', 'true')
    vi.stubEnv('META_PIXEL_ID', 'PIX_TEST')
    vi.stubEnv('META_CAPI_ACCESS_TOKEN', 'TOKEN')

    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ events_received: 1 }) })) as unknown as typeof fetch
    try {
      const { sendAcuityCapiEvent } = await import('@/lib/capi/acuity-capi')
      // Since the v1 release the sender resolves the recorded outcome (uuid and currency) BEFORE contacting Meta and
      // refuses to send without one, so the failing database answers that lookup and fails only the
      // audit write that follows Meta's acceptance.
      const lookup: Record<string, unknown[]> = {
        outcome_sources: [{ id: '00000000-0000-4000-8000-0000000001fb' }],
        outcomes: [{ id: '00000000-0000-4000-8000-0000000002fb', currency: 'USD' }],
      }
      const query = (table: string) => {
        const result = { data: lookup[table] ?? null, error: null }
        const builder: Record<string, unknown> = {
          then: (resolve: (value: typeof result) => unknown) => resolve(result),
          maybeSingle: async () => ({ data: null, error: null }),
        }
        for (const method of ['select', 'eq', 'in', 'limit']) builder[method] = () => builder
        return builder
      }
      const failingDb = { from: query, rpc: async () => ({ data: null, error: { message: 'connection reset' } }) }
      const out = await sendAcuityCapiEvent(
        { id: 991234, scheduledBy: null, datetimeCreated: new Date().toISOString(), email: 'x@example.invalid', price: 410, forms: [] } as never,
        null,
        failingDb as never,
      )
      expect(out.status).toBe('accepted_unrecorded')
      expect(out.deliveryRecorded).toBe(false)
      expect(out.eventId).toBe('acuity-991234')
    } finally {
      globalThis.fetch = realFetch
    }

    // Nothing was written, so the row remains eligible for the retry sweep.
    const rows = await c.query(`SELECT conversion_sent_at FROM outcomes WHERE external_id = '991234'`)
    expect(rows.rows).toHaveLength(0)
    expect(await priorReport()).toMatch(/PRIOR DURABLE REPORT/)
  })
})
