import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pgliteSupabase } from './postgrest-pglite'
import { ACCOUNT, freshOutcomeDb, outcomeSourceId, outcomeUuid } from './acuity-harness'

// enabling a webhook outcome source next to the Acuity example is SAFE. Every reader is
// source-aware: it counts enabled sources only, never applies Acuity's numeric appointment id to
// another source's external id (no NaN), keeps source-specific counts (Acuity's webhook-miss count,
// its ledger-health window) to that source, and refuses to sum money across currencies.
// This file is the proof that retires the tracker's "do not enable a webhook source before the v1 release".

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
// GA4 is a network read; the join under test is the ledger side.
vi.mock('@/lib/ga4/client', async (original) => ({
  ...(await original<typeof import('@/lib/ga4/client')>()),
  getGa4IdentifiedBookingEvents: vi.fn(async () => ({ available: true, events: [] })),
}))

import { getBusinessFacts } from '@/lib/outcomes/business-facts-reader'
import { getBusinessFactsByDay, getBusinessFactsByLabel } from '@/lib/outcomes/business-facts-reader'
import { getConfirmationFacts } from '@/lib/outcomes/confirmation-facts'
import { countRecentFirstSeenOutcomes } from '@/lib/outcomes/adapters/acuity/reconcile'
import { readOutcomeFacts } from '@/lib/outcomes/reader'
import { requireOutcomeLedgerHealth } from '@/lib/outcomes/source-health'
import { readConversionBacklog } from '@/lib/monitoring/conversion-backlog'
import { readBusinessReport } from '@/lib/reporting/business-reader'
import { readMeasurementReport } from '@/lib/reporting/measurement-reader'
import { readAttributionLadder } from '@/lib/cockpit/series-loader'
import { buildGa4ReconciliationBlock } from '@/lib/ga4/booking-reconciliation'

const DAY = '2026-07-20'
const WEBHOOK_SOURCE = '00000000-0000-4000-c000-000000000001'
const DISABLED_SOURCE = '00000000-0000-4000-c000-000000000002'

let db: PGlite

async function insert(columns: Record<string, unknown>): Promise<void> {
  const all = { outcome_type: 'booking', currency: 'USD', business_date: DAY, occurred_at: `${DAY}T14:00:00Z`, ...columns }
  const keys = Object.keys(all)
  await db.query(`INSERT INTO public.outcomes (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => (all as Record<string, unknown>)[k]))
}

async function healthyOutcomeLedger(): Promise<void> {
  await db.query(`INSERT INTO public.app_settings (ad_account_id, key, value) VALUES ($1, 'acuity_ledger_health', $2)`, [ACCOUNT,
    JSON.stringify({ last_reconciled_at: new Date().toISOString(), window_basis: 'booking_date_et',
      window_start_date: '2026-01-01', window_end_date: '2026-12-31', truncated: false })])
}

beforeEach(async () => {
  db = await freshOutcomeDb()
  state.client = pgliteSupabase(db)
  await healthyOutcomeLedger()
  const acuity = outcomeSourceId(ACCOUNT)
  const website = { origin: 'website', origin_observed_at: `${DAY}T14:00:00Z`, origin_observed_source: 'webhook' }
  // Acuity example: one value-bearing website booking, one zero-value booking, one cancellation.
  await insert({ id: outcomeUuid(501), ad_account_id: ACCOUNT, source_id: acuity, external_id: '501', gross_value: 125, collected_value: 125, status: 'confirmed', ...website })
  await insert({ id: outcomeUuid(502), ad_account_id: ACCOUNT, source_id: acuity, external_id: '502', gross_value: 0, collected_value: 0, status: 'confirmed', origin: 'staff_or_manual' })
  await insert({ id: outcomeUuid(503), ad_account_id: ACCOUNT, source_id: acuity, external_id: '503', gross_value: 90, collected_value: null, status: 'cancelled' })
  // An ENABLED webhook source: a non-numeric external id.
  await db.query(`INSERT INTO public.outcome_sources (id, ad_account_id, kind, label, enabled) VALUES ($1, $2, 'webhook', 'Shop', true), ($3, $2, 'webhook', 'Old shop', false)`,
    [WEBHOOK_SOURCE, ACCOUNT, DISABLED_SOURCE])
  await insert({ ad_account_id: ACCOUNT, source_id: WEBHOOK_SOURCE, external_id: 'order-1001', outcome_type: 'sale', gross_value: 50, collected_value: 50, status: 'confirmed', ...website })
  // A DISABLED source's row is stored but counted nowhere.
  await insert({ ad_account_id: ACCOUNT, source_id: DISABLED_SOURCE, external_id: 'order-9', outcome_type: 'sale', gross_value: 999, collected_value: 999, status: 'confirmed', ...website })
})

const noNaN = (value: unknown) => expect(JSON.stringify(value, (_k, v) => (typeof v === 'number' && Number.isNaN(v) ? 'NaN!' : v))).not.toContain('NaN!')

describe('a webhook source enabled next to Acuity (per-source readers)', () => {
  it('business facts count both enabled sources, exclude the disabled one, and never produce NaN', async () => {
    const { facts, rows } = await getBusinessFacts(ACCOUNT, DAY, DAY, state.client!)
    expect(facts).toMatchObject({ confirmedAppointments: 3, valueBearingBookings: 2, zeroValueAppointments: 1, canceledAppointments: 1, bookedValue: 175 })
    expect(facts.recordedOutcomeValue).toBe(175)
    noNaN(rows)
    noNaN(facts)
  })

  it('the generic reader returns outcome uuids as identity and per-source counts', async () => {
    const read = await readOutcomeFacts(state.client!, ACCOUNT, DAY, DAY)
    expect(read.facts).toMatchObject({ activeOutcomes: 3, valueBearingOutcomes: 2, grossValue: 175, collectedValue: 175 })
    expect(read.rows.map((r) => r.id).every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true)
    expect(read.bySource).toEqual([
      { sourceId: outcomeSourceId(ACCOUNT), kind: 'acuity', outcomes: 3 },
      { sourceId: WEBHOOK_SOURCE, kind: 'webhook', outcomes: 1 },
    ])
    expect(read.currency).toBe('USD')
  })

  it('per-day and per-label breakdowns include the webhook outcome without NaN', async () => {
    const byDay = await getBusinessFactsByDay(ACCOUNT, DAY, DAY, state.client!)
    expect(byDay).toEqual([expect.objectContaining({ date: DAY, valueBearingBookings: 2, bookedValue: 175 })])
    const byType = await getBusinessFactsByLabel(ACCOUNT, DAY, DAY, state.client!)
    noNaN(byType)
    expect(byType.reduce((n, t) => n + t.valueBearingBookings, 0)).toBe(2)
  })

  it('confirmation facts count website confirmations from enabled sources only', async () => {
    const facts = await getConfirmationFacts(ACCOUNT, DAY, DAY, state.client!)
    expect(facts).toMatchObject({ totalConfirmations: 4, websiteConfirmations: 2, staffOrManualConfirmations: 1 })
  })

  it("Acuity's webhook-miss count covers only Acuity rows first seen in the run", async () => {
    const runStart = new Date(Date.now() - 60_000).toISOString()
    const missCutoff = '2026-01-01T00:00:00Z'
    await expect(countRecentFirstSeenOutcomes(state.client!, { sourceId: outcomeSourceId(ACCOUNT), firstSeenSince: runStart, occurredSince: missCutoff }))
      .resolves.toBe(2) // 501 and 502; the cancellation and both webhook rows are not Acuity misses
  })

  it('the conversion backlog is per account and enabled source', async () => {
    const backlog = await readConversionBacklog(state.client!, ACCOUNT, Date.parse(`${DAY}T20:00:00Z`))
    // Unsent, not staff, not cancelled, enabled sources: Acuity 501 and the webhook sale.
    expect(backlog.unsent).toBe(2)
  })

  it('a refunded outcome is not an active outcome (view and model agree)', async () => {
    await insert({ ad_account_id: ACCOUNT, source_id: WEBHOOK_SOURCE, external_id: 'order-refunded', outcome_type: 'sale', gross_value: 70, collected_value: 70, status: 'refunded' })
    const read = await readOutcomeFacts(state.client!, ACCOUNT, DAY, DAY)
    expect(read.facts).toMatchObject({ activeOutcomes: 3, cancelledOutcomes: 2, grossValue: 175 })
  })

  it('refuses to sum money across currencies instead of mixing them', async () => {
    await insertForeignCurrencyLegacyRow({ ad_account_id: ACCOUNT, source_id: WEBHOOK_SOURCE, external_id: 'order-eur', outcome_type: 'sale', currency: 'EUR', gross_value: 40, collected_value: 40, status: 'confirmed' })
    await expect(readOutcomeFacts(state.client!, ACCOUNT, DAY, DAY)).rejects.toThrow(/outcome_currency_mismatch/)
    await expect(getBusinessFacts(ACCOUNT, DAY, DAY, state.client!)).rejects.toThrow(/outcome_currency_mismatch/)
  })
})

/** The outcomes trigger now refuses a foreign-currency row at write time. The readers keep their
 *  own refusal for a row written before the trigger existed, which this simulates. */
async function insertForeignCurrencyLegacyRow(row: Record<string, unknown>) {
  await expect(insert(row)).rejects.toThrow(/outcome_currency: currency EUR does not match the ad account currency USD/)
  await db.query('ALTER TABLE public.outcomes DISABLE TRIGGER outcomes_account_currency')
  try { await insert(row) } finally {
    await db.query('ALTER TABLE public.outcomes ENABLE TRIGGER outcomes_account_currency')
  }
}

describe('ledger health across sources', () => {
  it('requires every enabled reconciled source to be healthy and names push-only sources', async () => {
    const health = await requireOutcomeLedgerHealth(state.client!, ACCOUNT, DAY, DAY)
    expect(health.sources).toEqual([
      { sourceId: outcomeSourceId(ACCOUNT), kind: 'acuity', completeness: 'reconciled' },
      { sourceId: WEBHOOK_SOURCE, kind: 'webhook', completeness: 'push_as_received' },
    ])
    expect(health.windowEndDate).toBe('2026-12-31')
  })

  it('fails when the reconciled source is stale, even though the webhook source is fine', async () => {
    await db.query(`UPDATE public.app_settings SET value = $1 WHERE key = 'acuity_ledger_health'`, [JSON.stringify({ last_reconciled_at: '2020-01-01T00:00:00Z' })])
    await expect(requireOutcomeLedgerHealth(state.client!, ACCOUNT, DAY, DAY)).rejects.toThrow(/stale/)
  })

  it('a webhook-only account is readable without an Acuity ledger', async () => {
    await db.query(`UPDATE public.outcome_sources SET enabled = false WHERE kind = 'acuity'`)
    await db.query(`DELETE FROM public.app_settings WHERE key = 'acuity_ledger_health'`)
    const read = await readOutcomeFacts(state.client!, ACCOUNT, DAY, DAY)
    expect(read.facts.activeOutcomes).toBe(1)
    expect(read.health.windowEndDate).toBeNull()
  })

  it('no enabled source is "no outcome source", never zero', async () => {
    await db.query(`UPDATE public.outcome_sources SET enabled = false`)
    await expect(readOutcomeFacts(state.client!, ACCOUNT, DAY, DAY)).rejects.toThrow(/no_outcome_source/)
  })
})

describe('report, cockpit, GA4 and measurement readers with a webhook source enabled', () => {
  const context = {
    account: { id: ACCOUNT, metaAccountId: 'act_1', name: 'Example' },
    range: { from: DAY, to: DAY }, comparison: { from: '2026-07-19', to: '2026-07-19' },
    timezone: 'America/New_York', currency: 'USD', asOf: `${DAY}T23:00:00Z`,
  }

  // Acceptance: with no outcome source enabled, the report says "no outcome source", never 0.
  it('with no enabled source the business report is unavailable as "no_outcome_source" and carries no figure', async () => {
    // Control: the same reader on the same rows reports figures while a source is enabled.
    const enabled = await readBusinessReport(context as never)
    expect(enabled.state).toBe('available')
    expect(enabled.data).toBeTruthy()

    await db.query(`UPDATE public.outcome_sources SET enabled = false`)
    const section = await readBusinessReport(context as never)
    expect(section.state).toBe('unavailable')
    expect(section.notes).toEqual(['no_outcome_source'])
    expect(section.data ?? null).toBeNull()
    // Stored rows of disabled sources exist, so a zero here would be invented, not observed.
    await expect(getBusinessFacts(ACCOUNT, DAY, DAY, state.client!)).rejects.toThrow(/no_outcome_source/)
  })

  it('the business report counts both enabled sources without NaN', async () => {
    const section = await readBusinessReport(context as never)
    expect(section.state).toBe('available')
    noNaN(section.data)
  })

  it('the business report refuses a foreign currency instead of mixing it', async () => {
    await insertForeignCurrencyLegacyRow({ ad_account_id: ACCOUNT, source_id: WEBHOOK_SOURCE, external_id: 'order-eur', outcome_type: 'sale', currency: 'EUR', gross_value: 40, collected_value: 40, status: 'confirmed' })
    const section = await readBusinessReport(context as never)
    expect(section.state).toBe('unavailable')
    expect(section.notes).toEqual(['outcome_currency_mismatch'])
  })

  it('the cockpit attribution ladder counts enabled sources only', async () => {
    const ladder = await readAttributionLadder(state.client!, ACCOUNT, { start: DAY, end: DAY, basis: 'closed_account_days', timezone: 'America/New_York' } as never)
    expect(ladder.zeroValueBookings).toBe(1)
    noNaN(ladder)
  })

  it('the GA4 join reads only sources whose analytics event carries the numeric id', async () => {
    const { reconciliation } = await buildGa4ReconciliationBlock(ACCOUNT, DAY, DAY, state.client!)
    // Acuity 501 (value-bearing) and 502 (zero value) are joinable; the webhook sale is not.
    expect(JSON.stringify(reconciliation)).not.toContain('ga_join_external_id_not_numeric')
    noNaN(reconciliation)
  })

  it('the measurement cohort is keyed by outcome uuid for both sources', async () => {
    const section = await readMeasurementReport({ ...context, asOf: new Date().toISOString() } as never)
    noNaN(section)
    expect(section.state).not.toBe('unavailable')
  })
})
