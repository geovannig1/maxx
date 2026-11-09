import { describe, it, expect, afterAll } from 'vitest'
import { evaluateFlag, type FlagInput, renderFlagAction } from '@/lib/flags/rules'
import { flagToRecommendationInput, type FlagRow } from '@/lib/recommendations/generate'
import { buildRecommendation, formatRecommendation } from '@/lib/recommendations/builder'
import { applyRecommendationAuthority, decideRecommendationAuthority } from '@/lib/authority/recommendation-authority'
import { applyExampleOwnerTargetsPerTest } from '../helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

/**
 * SEEDED-ACCOUNT DEMO . Builds a coherent SYNTHETIC ad account and runs it
 * through Maxx's pure production stages — evaluateFlag → flagToRecommendationInput →
 * buildRecommendation → final authority projection — then prints what Maxx may surface without exact
 * paid-cohort evidence. Zero production risk: all pure functions, no Supabase / Meta / GA4.
 *
 * Reversal-class recs (scale/pause) additionally need trend context that the real generate.ts fetches from
 * daily_insights + the setup ledger (trend_stable, exited_learning, days_since_last_change). The demo
 * supplies those per entity to reproduce the full end-to-end path (labeled [seeded] below).
 */

const TODAY = '2026-07-04'

interface SeedEntity {
  name: string
  level: 'ad' | 'adset'
  metrics: FlagInput
  // Trend context the real pipeline fetches for reversal-class entities:
  trend_stable?: boolean
  exited_learning?: boolean
  days_since_last_change?: number
  expertRead: string // what a good media buyer would expect
}

const M = (over: Partial<FlagInput>): FlagInput => ({
  spend: 0, cpa: null, cpl: null, ctr: null, frequency: null, impressions: 0, bookings: 0, leads: 0,
  roas: null, window_days: 7, entity_age_days: 14, audience_type: 'consumer', peak_ctr: null, ...over,
})

const ACCOUNT: SeedEntity[] = [
  {
    name: 'Retargeting · Warm Audience', level: 'adset',
    metrics: M({ spend: 380, cpa: 42, cpl: 22, ctr: 1.8, frequency: 1.8, impressions: 21000, bookings: 9, leads: 40, window_days: 14, entity_age_days: 24, peak_ctr: 2.0 }),
    trend_stable: true, exited_learning: true, days_since_last_change: 16,
    expertRead: 'Meta models an efficient window; exact paid outcomes must corroborate it before any scale direction.',
  },
  {
    name: 'Cold · Lookalike 1%', level: 'ad',
    metrics: M({ spend: 240, cpa: 55, cpl: 30, ctr: 1.2, frequency: 2.0, impressions: 12000, bookings: 4, leads: 18, window_days: 10, entity_age_days: 15, peak_ctr: 1.4 }),
    trend_stable: true, exited_learning: true, days_since_last_change: 12,
    expertRead: 'Meta models a plausible performer; keep is an observation, not a money change.',
  },
  {
    name: 'Broad · Untargeted Test', level: 'ad',
    metrics: M({ spend: 180, cpa: null, cpl: null, ctr: 0.5, frequency: 1.5, impressions: 6000, bookings: 0, leads: 0, window_days: 7, entity_age_days: 12 }),
    trend_stable: true, exited_learning: true, days_since_last_change: 12,
    expertRead: 'Meta models no conversions in this spend window; inspect the exact matured paid cohort before any pause direction.',
  },
  {
    name: 'Creative v3 · Studio Reel', level: 'ad',
    metrics: M({ spend: 300, cpa: 58, cpl: 32, ctr: 0.9, frequency: 4.2, impressions: 15000, bookings: 5, leads: 20, window_days: 9, entity_age_days: 18, peak_ctr: 1.8 }),
    expertRead: 'Higher frequency and lower delivery response are diagnostic observations; they do not prove fatigue or authorize a refresh.',
  },
  {
    name: 'New Launch · Broad Prospecting', level: 'adset',
    metrics: M({ spend: 12, cpa: null, cpl: null, ctr: 1.1, frequency: 1.0, impressions: 400, bookings: 0, leads: 1, window_days: 1, entity_age_days: 1 }),
    expertRead: 'Only $12 / 1 day → too early to judge; hold.',
  },
]

const results: { name: string; flag: string; rec: string; rendered: string; expertRead: string }[] = []

describe('Seeded-account demo — Maxx runs its real pipeline on a synthetic account', () => {
  for (const e of ACCOUNT) {
    it(`${e.name}`, () => {
      const flag = evaluateFlag(e.metrics)
      if (!flag) {
        results.push({ name: e.name, flag: 'none', rec: 'none', rendered: '(no flag — nothing to surface)', expertRead: e.expertRead })
        return
      }
      const flagRow: FlagRow = {
        id: e.name, entity_level: e.level,
        campaign_id: null, adset_id: e.level === 'adset' ? e.name : null, ad_id: e.level === 'ad' ? e.name : null,
        flag_type: flag.flag_type, reason: flag.reason, recommended_action: renderFlagAction(flag, 'calendar_period_signal').copy, watch_next: flag.watch_next,
        window_days: e.metrics.window_days,
        evidence: {
          spend: e.metrics.spend, bookings: e.metrics.bookings, leads: e.metrics.leads, cpa: e.metrics.cpa,
          ctr: e.metrics.ctr, frequency: e.metrics.frequency, impressions: e.metrics.impressions, window_days: e.metrics.window_days,
        },
      }
      const input = flagToRecommendationInput(flagRow, e.name, TODAY)
      // Enrich reversal-class with the trend context the real generate.ts fetches (see file header).
      const grounded = buildRecommendation({
        ...input,
        data_age_hours: 6, // fresh sync (the real pipeline supplies this from sync recency)
        trend_stable: e.trend_stable ?? input.trend_stable,
        exited_learning: e.exited_learning ?? input.exited_learning,
        days_since_last_change: e.days_since_last_change ?? input.days_since_last_change,
      })
      const authority = decideRecommendationAuthority({
        recommendation: grounded,
        intendedType: input.recommendation_type,
        basis: 'calendar_period_signal',
        plane: 'meta_modelled',
        preflight: null,
      })
      const rec = applyRecommendationAuthority(grounded, input.recommendation_type, authority)
      results.push({ name: e.name, flag: flag.flag_type, rec: rec.recommendation_type, rendered: formatRecommendation(rec), expertRead: e.expertRead })

      // Nothing Maxx surfaces is ever executable now (read-only / write mode off).
      expect(rec.action_allowed_now).toBe(false)
    })
  }

  it('withholds action-shaped language when the fake account has only modelled outcomes', () => {
    const by = (n: string) => results.find((r) => r.name.startsWith(n))!
    expect(by('Retargeting').rec).toBe('investigate')
    expect(by('Cold').rec).toBe('keep')
    expect(by('Broad · Untargeted').rec).toBe('investigate')
    expect(by('Creative v3').rec).toBe('investigate')
    expect(by('New Launch').rec).toBe('hold')
  })
})

afterAll(() => {
  const lines: string[] = []
  lines.push('\n================= SEEDED-ACCOUNT DEMO — modelled evidence boundary =================')
  lines.push('Synthetic account · pure pipeline through final authority; no Meta writes\n')
  for (const r of results) {
    lines.push(`### ${r.name}   [flag: ${r.flag} → ${r.rec.toUpperCase()}]`)
    lines.push(`Expert read: ${r.expertRead}`)
    lines.push(r.rendered)
    lines.push('')
  }
  lines.push('Modelled-only action candidates surface as INVESTIGATE, never SCALE, PAUSE, or REFRESH.')
  lines.push('=============================================================================\n')
  console.log(lines.join('\n'))
})
