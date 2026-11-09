import { describe, expect, it } from 'vitest'
import { CAUSAL_CONTRIBUTION_METRIC, LEGACY_CAUSAL_CONTRIBUTION_METRIC, isCausalContributionMetric } from '@/lib/economics/causal-metric'
import { summarizeTrackRecord } from '@/lib/cockpit/series-loader'
import { scanSources } from './_support/source-scan'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// the causal metric was named after one currency (causal_incremental_contribution_dollars). The schema
// accepts only the new name; stored rows under the old name are read as the same metric.

describe('causal contribution metric name', () => {
  it('reads the current and the legacy name, and nothing else', () => {
    expect(CAUSAL_CONTRIBUTION_METRIC).toBe('causal_incremental_contribution')
    expect(isCausalContributionMetric(CAUSAL_CONTRIBUTION_METRIC)).toBe(true)
    expect(isCausalContributionMetric(LEGACY_CAUSAL_CONTRIBUTION_METRIC)).toBe(true)
    for (const other of ['cpa', 'causal_incremental_contribution_usd', '', null, undefined]) {
      expect(isCausalContributionMetric(other), String(other)).toBe(false)
    }
  })

  it('counts a stored legacy-name outcome in the track record exactly like a current one', () => {
    const row = (metric_name: string) => ({
      flag_type: 'loser', metric_name, outcome: 'worked', outcome_note: 'clean', review_status: 'approved',
      evaluated_at: '2026-11-01T00:00:00Z', estimate_only: false,
    })
    const current = summarizeTrackRecord([row(CAUSAL_CONTRIBUTION_METRIC)] as never)
    expect(summarizeTrackRecord([row(LEGACY_CAUSAL_CONTRIBUTION_METRIC)] as never)).toEqual(current)
    // Control: an outcome on another metric is not counted, so the equality above is not vacuous.
    expect(summarizeTrackRecord([row('cpa')] as never)).not.toEqual(current)
  })

  it('names the legacy metric literally only in its alias module, and the scan finds a planted one', () => {
    const legacyNameSites = (base: string) => scanSources(base, ['src'], /contribution_dollars/)
      .map((hit) => hit.file).filter((file) => file !== 'src/lib/economics/causal-metric.ts')
    expect(legacyNameSites(process.cwd())).toEqual([])
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'causal-metric-'))
    try {
      mkdirSync(path.join(tmp, 'src'))
      writeFileSync(path.join(tmp, 'src/planted.ts'), "export const m = 'causal_incremental_contribution_dollars'\n")
      expect(legacyNameSites(tmp)).toEqual(['src/planted.ts'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
