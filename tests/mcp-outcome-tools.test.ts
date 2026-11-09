import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ACCOUNT, outcomeSourceId, freshOutcomeDb, outcomeUuid } from './db/acuity-harness'
import { pgliteSupabase } from './db/postgrest-pglite'

// The business-outcome MCP tools use outcome vocabulary (get_outcomes,
// get_outcomes_by_label), read every enabled source, and keep the deprecated get_bookings_by_type
// name as an alias for one release. get_outcome_bookings is retired (no alias: a public tool name
// containing a source system's name is exactly what this removes).

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))

import { executeTool, TOOL_DEFINITIONS } from '@/mcp/tools'

const DAY = '2026-07-20'
const WEBHOOK = '00000000-0000-4000-c000-000000000001'
let db: PGlite

async function insert(columns: Record<string, unknown>): Promise<void> {
  const all = { ad_account_id: ACCOUNT, currency: 'USD', business_date: DAY, occurred_at: `${DAY}T14:00:00Z`, status: 'confirmed', ...columns }
  const keys = Object.keys(all)
  await db.query(`INSERT INTO public.outcomes (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => (all as Record<string, unknown>)[k]))
}

beforeEach(async () => {
  db = await freshOutcomeDb()
  state.client = pgliteSupabase(db)
  await db.query(`INSERT INTO public.app_settings (ad_account_id, key, value) VALUES ($1, 'acuity_ledger_health', $2)`, [ACCOUNT,
    JSON.stringify({ last_reconciled_at: new Date().toISOString(), window_basis: 'booking_date_et', window_start_date: '2026-01-01', window_end_date: '2026-12-31', truncated: false })])
  await db.query(`INSERT INTO public.outcome_sources (id, ad_account_id, kind, label, enabled) VALUES ($1, $2, 'webhook', 'Shop', true)`, [WEBHOOK, ACCOUNT])
  await insert({ id: outcomeUuid(501), source_id: outcomeSourceId(ACCOUNT), external_id: '501', outcome_type: 'booking', outcome_label: 'Studio', gross_value: 125, collected_value: 125 })
  await insert({ source_id: WEBHOOK, external_id: 'order-1', outcome_type: 'sale', outcome_label: 'Gift card', gross_value: 50, collected_value: 50 })
})

describe('outcome MCP tools', () => {
  it('lists get_outcomes and get_outcomes_by_label and no tool named after a source system', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['get_outcomes', 'get_outcomes_by_label']))
    expect(names.filter((n) => /acuity/i.test(n))).toEqual([])
  })

  it('get_outcomes counts every enabled source in outcome vocabulary', async () => {
    const out = await executeTool('get_outcomes', { start_date: DAY, end_date: DAY }) as Record<string, unknown>
    expect(out).toMatchObject({
      active_outcomes: 2, value_bearing_outcomes: 2, gross_value: 175, collected_value: 175, currency: 'USD',
      collected_value_coverage: { with_recorded_value: 2, total: 2 },
    })
    expect(out.sources).toEqual([
      { source_id: outcomeSourceId(ACCOUNT), kind: 'acuity', outcomes: 1 },
      { source_id: WEBHOOK, kind: 'webhook', outcomes: 1 },
    ])
    expect(JSON.stringify(out)).not.toMatch(/appointment|amount_paid/)
  })

  it('get_outcomes_by_label groups by label, and the deprecated alias returns the same answer', async () => {
    const out = await executeTool('get_outcomes_by_label', { start_date: DAY, end_date: DAY }) as { rows: Array<{ label: string; value_bearing_outcomes: number }> }
    expect(out.rows.map((r) => r.label).sort()).toEqual(['Gift card', 'Studio'])
    const alias = await executeTool('get_bookings_by_type', { start_date: DAY, end_date: DAY }) as Record<string, unknown>
    expect(alias).toMatchObject({ ...out, deprecated: expect.stringMatching(/get_outcomes_by_label/) })
  })

  it('reports no outcome source as unavailable, never zero', async () => {
    await db.query(`UPDATE public.outcome_sources SET enabled = false`)
    const out = await executeTool('get_outcomes', { start_date: DAY, end_date: DAY }) as Record<string, unknown>
    expect(out).toMatchObject({ error_code: 'no_outcome_source' })
    expect(out).not.toHaveProperty('active_outcomes')
  })
})
