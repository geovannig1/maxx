import { describe, it, expect, vi } from 'vitest'
import { VERTICAL_BENCHMARKS, approvedVerticalBenchmarks, annotateWithBenchmarks } from '@/lib/targets/vertical-benchmarks'
import type { MetricEvaluation } from '@/lib/targets/target-ranges'
import { METRIC_RANGES } from '@/lib/targets/target-ranges'

const evalFor = (metric: 'ctr' | 'cpc' | 'cpm' | 'cpl', value: number): MetricEvaluation => ({
  metric,
  value,
  status: 'healthy',
  band: 'healthy',
  confidence: 'medium',
  range: METRIC_RANGES[metric],
  reason: 'test',
})

describe('VERTICAL_BENCHMARKS governance', () => {
  it('every row has a real named source and a unique insight_title (the /signals gate key)', () => {
    const titles = new Set<string>()
    for (const b of VERTICAL_BENCHMARKS) {
      expect(b.source_name.length, `${b.metric} needs a named source`).toBeGreaterThan(8)
      expect(b.insight_title.length).toBeGreaterThan(20)
      expect(titles.has(b.insight_title), `duplicate title: ${b.insight_title}`).toBe(false)
      titles.add(b.insight_title)
    }
  })

  it('NO booking-CPA benchmark exists (the recorded seed-benchmark-priors decision) — cost rows are cost_per_lead and say so', () => {
    expect(VERTICAL_BENCHMARKS.some((b) => b.metric === 'cpa')).toBe(false)
    for (const b of VERTICAL_BENCHMARKS.filter((x) => x.basis === 'cost_per_lead')) {
      expect(b.metric).toBe('cpl')
      expect(b.insight_title + b.vertical).toMatch(/lead/i)
    }
  })

  it('ranges are ordered', () => {
    for (const b of VERTICAL_BENCHMARKS) expect(b.range_low).toBeLessThanOrEqual(b.range_high)
  })
})

describe('approval gate (fail-closed)', () => {
  it('nothing is citable without approved titles', () => {
    expect(approvedVerticalBenchmarks(new Set())).toHaveLength(0)
  })

  it('only the approved title becomes citable', () => {
    const one = VERTICAL_BENCHMARKS[0]
    const rows = approvedVerticalBenchmarks(new Set([one.insight_title]))
    expect(rows).toHaveLength(1)
    expect(rows[0].metric).toBe(one.metric)
  })
})

describe('annotateWithBenchmarks — context only, never re-bands', () => {
  const ctrBench = VERTICAL_BENCHMARKS.find((b) => b.metric === 'ctr')!

  it('unapproved → evaluation returned untouched (no benchmark key)', () => {
    const [out] = annotateWithBenchmarks([evalFor('ctr', 3.2)], new Set())
    expect(out.benchmark).toBeUndefined()
    expect(out.status).toBe('healthy')
  })

  it('approved → attaches the cited external_heuristic context and NEVER alters status/band', () => {
    const before = evalFor('ctr', 0.1) // far below any benchmark range
    const [out] = annotateWithBenchmarks([before], new Set([ctrBench.insight_title]))
    expect(out.benchmark).toBeDefined()
    expect(out.benchmark!.label).toBe('external_heuristic')
    expect(out.benchmark!.source).toBe(ctrBench.source_name)
    expect(out.benchmark!.range).toMatch(/1.99%–3.92%/)
    // banding is untouched no matter how the value compares to the benchmark
    expect(out.status).toBe(before.status)
    expect(out.band).toBe(before.band)
  })

  it('cost-per-lead annotation carries the never-comparable-to-booking-CPA warning', () => {
    const cplBench = VERTICAL_BENCHMARKS.find((b) => b.metric === 'cpl')!
    const [out] = annotateWithBenchmarks([evalFor('cpl', 25)], new Set([cplBench.insight_title]))
    expect(out.benchmark!.range).toMatch(/cost per LEAD, not booking CPA/)
  })
})

describe('benchmark amounts keep their own currency', () => {
  it('labels a USD benchmark as USD in a EUR account, never relabelled as euros', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'EUR')
    try {
      const cpm = VERTICAL_BENCHMARKS.find((b) => b.metric === 'cpm')!
      const [out] = annotateWithBenchmarks([evalFor('cpm', 12)], new Set([cpm.insight_title]))
      expect(out.benchmark!.range).toContain('$13.48')
      expect(out.benchmark!.range).not.toContain('€')
    } finally { vi.unstubAllEnvs() }
  })
})
