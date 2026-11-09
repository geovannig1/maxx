import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'
import { sendOutcomeConversion } from '@/lib/conversions/outcome-conversions'

// The CSV adapter: an owner upload. It cannot carry an attribution token and does not
// establish where an outcome came from, so a CSV outcome is never sent to an ad platform and a cohort
// that includes a CSV source can never be complete.

describe('csv outcome adapter', () => {
  const csv = getOutcomeAdapter('csv')!

  it('declares an upload that carries no token and no observed origin', () => {
    expect(csv.capabilities).toEqual({
      pull: false, push: false, backfill: false, carriesToken: false, originKnown: false,
      collectedValue: true, platformNativeEvents: [],
    })
    expect(csv.verifyPush).toBeUndefined()
    expect(csv.ledgerHealth).toBeUndefined()
  })

  it('accepts no source configuration keys', () => {
    expect(csv.validateConfig({}, {})).toEqual({ ok: true, value: undefined })
    expect(csv.validateConfig({}, { platformNativeEvents: ['Purchase'] }).ok).toBe(false)
  })

  it('reports itself configured (an upload needs no credentials)', async () => {
    expect(await csv.health()).toMatchObject({ configured: true })
  })
})

describe('conversions never send a CSV outcome', () => {
  function db(kind: string) {
    const outcome = {
      id: 'o-1', source_id: 's-1', outcome_type: 'sale', status: 'confirmed', origin: 'website',
      origin_observed_at: '2026-11-01T00:00:00Z', occurred_at: new Date().toISOString(), gross_value: '10', currency: 'USD',
      landing_page: 'https://shop.example/', email: 'a@b.test', conversion_sent_at: null,
    }
    const rows: Record<string, unknown> = { outcomes: outcome, outcome_sources: { kind, enabled: true, config: {} } }
    return {
      from: (table: string) => {
        const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: rows[table], error: null }) }
        return chain
      },
    } as unknown as SupabaseClient
  }

  it('skips a confirmed website-origin outcome from an enabled csv source before any network call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const result = await sendOutcomeConversion(db('csv'), 'o-1', { env: { OUTCOME_CONVERSIONS_SEND: 'true' } })
      expect(result).toEqual({ mode: 'live', status: 'skipped', skip: 'source_not_sendable' })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('control: the same outcome from a webhook source passes the source gate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ events_received: 1 })))
    try {
      const result = await sendOutcomeConversion(db('webhook'), 'o-1', { env: { OUTCOME_CONVERSIONS_SEND: 'true' } })
      expect(result).not.toMatchObject({ skip: 'source_not_sendable' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
