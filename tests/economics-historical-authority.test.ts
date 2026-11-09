import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildProfitView, proposeCpaBands } from '@/lib/economics/model'
import { CHAMPION_BENCHMARK, championVerdict } from '@/lib/economics/champion'
import { judge } from '@/lib/learning/patterns'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

const { getAdminClient } = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => {
    throw new Error('champion watch must not read or write the database')
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient }))

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const explicitInputs = {
  aov: 250,
  gross_margin_rate: 0.8,
  repeat_rate: null,
  source_note: 'Owner estimate',
}

describe('historical Meta benchmark cannot become current economics policy', () => {
  it('requires explicit economics inputs and builds profit math without a champion verdict', () => {
    const view = buildProfitView({ cpa: 60, bookings: 5, inputs: explicitInputs })

    expect(view.aov).toBe(250)
    expect(view).not.toHaveProperty('champion')
    expect(view.read).not.toMatch(/champion|raise.?budget|scale/i)
  })

  it('derives proposal-only CPA bands from explicit unit economics, not the historical champion', () => {
    const bands = proposeCpaBands({
      aov: 1000,
      gross_margin_rate: 1,
      repeat_rate: 0,
      source_note: 'Owner estimate',
    })

    expect(bands).toMatchObject({ excellent: 400, healthy: 600, watch: 850 })
    expect(bands?.rationale).not.toMatch(/champion|historical Meta/i)
  })

  it('labels direct historical comparisons as audit-only with no action language', () => {
    const comparison = championVerdict(30, 10)

    expect(comparison).toMatchObject({
      context_status: 'historical_audit_only',
      action_authority: 'none',
    })
    expect(comparison.detail).not.toMatch(/raise.?budget|scale|keep|pause|kill/i)
  })

  it('does not invent universal CAPI receipt or attribution-window effects', () => {
    const prompt = read('src/lib/report/prompt-builder.ts')
    expect(CHAMPION_BENCHMARK.attribution_note).not.toMatch(/receives ~all|15.?40%/i)
    expect(CHAMPION_BENCHMARK.attribution_note).toMatch(/accepted delivery/i)
    expect(prompt).not.toMatch(/Meta receives ~all bookings/i)
    expect(prompt).toMatch(/accepted event-level response lineage/i)
  })

  it('does not shrink learned patterns toward the historical champion prior', () => {
    const result = judge({ spend: 200, bookings: 1, clicks: 10, impressions: 1000 })

    expect(result.verdict).toBe('weak')
    expect(result.recommendation).not.toMatch(/champion|shrunk|prior/i)
  })

  it('keeps the legacy champion-watch entry point inert with zero database access', async () => {
    const { runChampionWatch } = await import('@/lib/economics/champion-watch')

    await expect(runChampionWatch('account-1')).resolves.toBe(0)
    expect(getAdminClient).not.toHaveBeenCalled()
  })

  it('structurally forbids the historical benchmark from alerts, learning priors, and model defaults', () => {
    const model = read('src/lib/economics/model.ts')
    const watch = read('src/lib/economics/champion-watch.ts')
    const patterns = read('src/lib/learning/patterns.ts')
    const dailySync = read('src/app/api/cron/daily-sync/route.ts')
    const instructions = read('src/mcp/instructions.ts')
    const toolIndex = read('src/mcp/tools/index.ts')

    expect(model).not.toContain('DEFAULT_ECONOMICS_INPUTS')
    expect(model).not.toContain('CHAMPION_BENCHMARK')
    expect(model).not.toContain('championVerdict')
    expect(watch).not.toContain('CHAMPION_BENCHMARK')
    expect(watch).not.toContain('insertAlertsDeduped')
    expect(patterns).not.toContain('CHAMPION_BENCHMARK')
    expect(patterns).not.toMatch(/shrinkMean\(/)
    expect(dailySync).not.toMatch(/runChampionWatch\(/)
    expect(instructions).not.toMatch(/profit vs the champion bar/i)
    expect(toolIndex).not.toMatch(/profit view vs the champion/i)
  })
})
