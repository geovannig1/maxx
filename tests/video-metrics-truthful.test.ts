import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  computeVideoMetrics, boundedRate, resolveEarlyViewSource, classifyVideoLength,
  milestoneSeconds, scoreRetentionForLength, DENOMINATOR_CONTRACTS, type VideoInputs,
} from '@/lib/creative/video-metrics'
import { SYSTEM_PROMPT } from '@/lib/report/prompt-builder'
import { METRIC_CATALOG } from '@/lib/metrics/catalog'

// The defect: video3sViews = videoP25, hookRate = p25/impressions, holdRate = thruplays/p25.
// p25 is 25% OF THE VIDEO LENGTH — on 60-120s creatives, ~15-30 seconds of watch time. So a deep-engagement milestone was reported as scroll-stopping power, and thruplays/p25
// could exceed 100% because ThruPlay counts a 15-second view.

const base: VideoInputs = {
  impressions: 10000,
  videoPlays: null,
  continuous2sViews: null,
  p25: 1200, p50: 600, p75: 300, p100: 150,
  thruplays: 900,
  avgWatchSeconds: 12.5,
  durationSeconds: null,
}

describe('p25 is NEVER a three-second hook', () => {
  it('with no early-view field, the early-view rate is UNAVAILABLE — not p25-derived', () => {
    const m = computeVideoMetrics(base)
    expect(m.earlyViewSource).toBe('unavailable')
    expect(m.earlyView.value).toBeNull()
    expect(m.earlyView.unavailableReason).toMatch(/p25 is a retention milestone.*never substituted/i)
    // The old code would have produced 1200/10000 = 12%.
    expect(m.earlyView.value).not.toBe(12)
  })

  it('unavailable early-view data does NOT become zero', () => {
    const m = computeVideoMetrics(base)
    expect(m.earlyView.value).toBeNull()
    expect(m.earlyView.value).not.toBe(0)
  })

  it('a PRESENT zero is a real measurement, distinct from absent', () => {
    // "the video started zero times" is a fact; "we have no early-view field" is not the same fact.
    const m = computeVideoMetrics({ ...base, videoPlays: 0 })
    expect(m.earlyViewSource).toBe('video_play_actions')
    expect(m.earlyView.value).toBe(0)
  })

  it('resolveEarlyViewSource never selects p25 under any input', () => {
    expect(resolveEarlyViewSource({ videoPlays: null, continuous2sViews: null })).toBe('unavailable')
    expect(resolveEarlyViewSource({ videoPlays: 500, continuous2sViews: null })).toBe('video_play_actions')
    expect(resolveEarlyViewSource({ videoPlays: null, continuous2sViews: 400 })).toBe('video_continuous_2_sec')
    // video_play_actions wins when both are present.
    expect(resolveEarlyViewSource({ videoPlays: 500, continuous2sViews: 400 })).toBe('video_play_actions')
  })

  it('computes the early-view rate from the REAL field and the impressions denominator', () => {
    const m = computeVideoMetrics({ ...base, videoPlays: 2500 })
    expect(m.earlyViewSource).toBe('video_play_actions')
    expect(m.earlyView.value).toBeCloseTo(25, 10)
    expect(m.earlyView.denominatorContract).toBe(DENOMINATOR_CONTRACTS.early_view_rate)
  })

  it('no label anywhere in the catalog calls p25 a hook or a 3-second view', () => {
    for (const def of METRIC_CATALOG) {
      const text = `${def.label} ${def.header} ${def.description ?? ''}`
      if (!/p25|retention 25/i.test(text)) continue
      // A NEGATION ("NOT a three-second view") is the correction, not the claim. Only an
      // AFFIRMATIVE equation of p25 with a 3s/hook signal is the defect.
      const affirms = /(?<!not )(?<!NOT )(3s|3-second|three-second)\s*(hook|view|play)?\s*(≈|=|~|proxy|is)/i
      expect(text).not.toMatch(affirms)
      expect(text).not.toMatch(/\bhook\s*\(3s/i)
    }
  })

  it('the early-view catalog entry states it is NOT a 3-second hook', () => {
    const early = METRIC_CATALOG.find((d) => d.key === 'hook_rate')!
    expect(early.label).toBe('Early-View Rate')
    expect(early.description).toMatch(/NOT a 3-second hook/i)
  })

  it('the report prompt forbids calling p25 a 3-second view or a hook', () => {
    expect(SYSTEM_PROMPT).toMatch(/NEVER call video_p25 a "3-second view", a "hook"/)
    expect(SYSTEM_PROMPT).toMatch(/RETENTION MILESTONES/)
    expect(SYSTEM_PROMPT).toMatch(/must be reported as unavailable — never as 0%/)
  })

  it('the source no longer substitutes p25 for a 3s view', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/sync/upsert-insights.ts'), 'utf8')
    expect(src).not.toMatch(/const video3sViews\s*=\s*.*videoP25/)
    expect(src).not.toMatch(/video_3s_views:\s*video3sViews/)
  })
})

describe('long-video semantics are preserved', () => {
  it('classifies length, with unknown as its own class', () => {
    expect(classifyVideoLength(15)).toBe('short')
    expect(classifyVideoLength(45)).toBe('medium')
    expect(classifyVideoLength(140)).toBe('long')
    expect(classifyVideoLength(null)).toBe('unknown')
    expect(classifyVideoLength(0)).toBe('unknown')
    expect(classifyVideoLength(NaN)).toBe('unknown')
  })

  it('states the real watch time a milestone represents', () => {
    expect(milestoneSeconds(15, 25)).toBeCloseTo(3.75, 10)
    expect(milestoneSeconds(72, 25)).toBeCloseTo(18, 10)
    expect(milestoneSeconds(140, 25)).toBeCloseTo(35, 10)
    expect(milestoneSeconds(null, 25)).toBeNull()
  })

  it('the SAME raw retention rate scores differently on a short and a long video', () => {
    const retention = boundedRate('retention_p25_rate', 2000, 10000) // 20%
    const short = scoreRetentionForLength(retention, 15)
    const long = scoreRetentionForLength(retention, 140)
    expect(short.lengthClass).toBe('short')
    expect(long.lengthClass).toBe('long')
    // 20% of a 15s video is weak; 20% of a 140s video (35s watched) is strong.
    expect(long.score!).toBeGreaterThan(short.score!)
  })

  it('a MISSING video duration reduces confidence and withholds the score', () => {
    const retention = boundedRate('retention_p25_rate', 2000, 10000)
    const unknown = scoreRetentionForLength(retention, null)
    expect(unknown.score).toBeNull()
    expect(unknown.confidence).toBeLessThan(1)
    expect(unknown.reasons.join(' ')).toMatch(/duration is unknown/i)
    expect(unknown.reasons.join(' ')).toMatch(/rather than a default length assumed/i)
  })

  it('an impressions-based retention denominator lowers confidence', () => {
    const retention = boundedRate('retention_p25_rate', 2000, 10000)
    const withPlays = scoreRetentionForLength(retention, 60, { retentionDenominatorIsImpressions: false })
    const withoutPlays = scoreRetentionForLength(retention, 60, { retentionDenominatorIsImpressions: true })
    expect(withoutPlays.confidence).toBeLessThan(withPlays.confidence)
    expect(withoutPlays.reasons.join(' ')).toMatch(/not video starts/i)
  })
})

describe('rates cannot silently exceed 100%', () => {
  it('detects the impossible relationship, preserves the raw inputs, and marks it unreliable', () => {
    // The old hold_rate: thruplays (900) ÷ p25 (600) = 150%.
    const r = boundedRate('thruplay_rate', 900, 600)
    expect(r.value).toBe(100)          // clamped so a consumer never renders 150%
    expect(r.rawValue).toBeCloseTo(150, 10) // ...but the raw ratio is KEPT
    expect(r.rawNumerator).toBe(900)
    expect(r.rawDenominator).toBe(600)
    expect(r.unreliable).toBe(true)    // ...and the clamp is never silent
    expect(r.warning).toMatch(/exceeds 100%/)
    expect(r.warning).toMatch(/do not report it as a measurement/)
  })

  it('surfaces the impossibility as a structured warning on the metrics object', () => {
    const m = computeVideoMetrics({ ...base, thruplays: 99999 })
    const w = m.warnings.find((x) => x.metric === 'thruplay_rate')
    expect(w).toBeDefined()
    expect(w!.unreliable).toBe(true)
    expect(w!.rawNumerator).toBe(99999)
    expect(w!.rawRate).toBeGreaterThan(100)
  })

  it('a valid rate produces NO warning', () => {
    expect(computeVideoMetrics({ ...base, videoPlays: 2500 }).warnings).toEqual([])
  })

  it('a zero denominator yields null, not zero and not Infinity', () => {
    const r = boundedRate('early_view_rate', 100, 0)
    expect(r.value).toBeNull()
    expect(r.unavailableReason).toMatch(/would be undefined, not zero/)
  })

  it('a negative numerator is rejected as inconsistent, not clamped to a number', () => {
    const r = boundedRate('retention_p25_rate', -5, 100)
    expect(r.value).toBeNull()
    expect(r.unreliable).toBe(true)
    expect(r.warning).toMatch(/negative numerator/)
  })

  it('non-finite inputs yield unavailable', () => {
    expect(boundedRate('early_view_rate', NaN, 100).value).toBeNull()
    expect(boundedRate('early_view_rate', 100, Infinity).value).toBeNull()
  })
})

describe('ThruPlay, retention and average watch time stay separate', () => {
  it('ThruPlay rate is measured against impressions, not a retention milestone', () => {
    const m = computeVideoMetrics({ ...base, videoPlays: 5000 })
    expect(m.thruplayRate.denominatorContract).toBe('ThruPlays ÷ impressions')
    expect(m.thruplayRate.value).toBeCloseTo(9, 10) // 900 / 10000
    // NOT 900/1200 = 75%, the old "hold rate".
    expect(m.thruplayRate.value).not.toBeCloseTo(75, 1)
  })

  it('retention uses video starts when known, impressions otherwise, and says which', () => {
    const withPlays = computeVideoMetrics({ ...base, videoPlays: 4000 })
    expect(withPlays.retentionDenominatorIsImpressions).toBe(false)
    expect(withPlays.retentionP25.value).toBeCloseTo(30, 10) // 1200 / 4000

    const withoutPlays = computeVideoMetrics(base)
    expect(withoutPlays.retentionDenominatorIsImpressions).toBe(true)
    expect(withoutPlays.retentionP25.value).toBeCloseTo(12, 10) // 1200 / 10000
  })

  it('average watch time passes through untouched — it is not a rate', () => {
    expect(computeVideoMetrics(base).avgWatchSeconds).toBe(12.5)
  })

  it('every derived rate declares its denominator contract', () => {
    const m = computeVideoMetrics({ ...base, videoPlays: 4000 })
    for (const r of [m.earlyView, m.retentionP25, m.retentionP50, m.retentionP75, m.completion, m.thruplayRate]) {
      expect(r.denominatorContract.length).toBeGreaterThan(0)
    }
  })

  it('exposes all four retention milestones', () => {
    const m = computeVideoMetrics({ ...base, videoPlays: 4000 })
    expect(m.retentionP25.value).toBeCloseTo(30, 10)
    expect(m.retentionP50.value).toBeCloseTo(15, 10)
    expect(m.retentionP75.value).toBeCloseTo(7.5, 10)
    expect(m.completion.value).toBeCloseTo(3.75, 10)
  })
})

// ── The DISPLAY surfaces, not just the derivation ────────────────────────────────
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walkAll(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walkAll(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}
const SRC_FILES = walkAll(resolve(process.cwd(), 'src'))
// Code lines only. TS comments, JSX comment openers, and lines that PROHIBIT a claim are
// documentation of the fix, not the defect.
const codeLines = (f: string) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
    .filter((l) => !/\b(NOT|never|no longer|must not|forbid|is not)\b/i.test(l))

describe('p25 is never PRESENTED as a three-second signal (broad scan)', () => {
  it('no display LABEL equates a hook with a 3-second signal or with p25', () => {
    // "hook" as a CREATIVE-CRAFT concept (the opening of a video) is legitimate. The defect is a
    // LABEL or claim that a 3-second hook is MEASURED, or that p25 stands in for one.
    const hits = SRC_FILES.flatMap((f) =>
      codeLines(f)
        .filter((l) =>
          /label[=:]\s*["'`][^"'`]*hook[^"'`]*(3s|3-second|three-second|25%)/i.test(l) ||
          /hook\s*\((3s|3-second|three-second)/i.test(l) ||
          /(3s|three-second|3-second)\s*(hook)?\s*(≈|~=|=)\s*(p?25|25%)/i.test(l) ||
          /hook (rate )?uses the 25% proxy/i.test(l),
        )
        .map((l) => `${f}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })

  it('the retired Hold metric is not rendered anywhere', () => {
    const hits = SRC_FILES.flatMap((f) =>
      codeLines(f)
        .filter((l) => /label=["'`]\s*Hold/i.test(l) || /Stat label="Hold"/i.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })

  it('no surface claims the app tracks a 3-second hook rate or a hold rate', () => {
    const hits = SRC_FILES.flatMap((f) =>
      codeLines(f)
        .filter((l) => /(tracks|already tracks).{0,40}hook rate|hold rate \(thruplay/i.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    )
    expect(hits).toEqual([])
  })

  it('RetentionCurve shows the early-view SOURCE, or "unavailable"', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/creative/RetentionCurve.tsx'), 'utf8')
    expect(src).toMatch(/Early view \(video starts\)/)
    expect(src).toMatch(/Early view \(continuous 2s\)/)
    expect(src).toMatch(/'unavailable'/)
    expect(src).not.toMatch(/Hook \(3s/)
  })

  it('RetentionCurve names its denominator, matching aggregateMetrics', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/components/creative/RetentionCurve.tsx'), 'utf8')
    // aggregateMetrics uses video starts when known, impressions otherwise — the component says which.
    expect(src).toMatch(/retentionBasis/)
    expect(src).toMatch(/video starts/)
    expect(src).toMatch(/impressions/)
  })

  it('the real video-START count is passed in explicitly with a truthful prop name', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/app/(dashboard)/performance/ads/page.tsx'), 'utf8')
    expect(page).toMatch(/videoPlays=\{sel\.video_views\}/)
    expect(page).toMatch(/earlyViewSource=\{sel\.early_view_source\}/)
  })

  it('the catalog label for video_views says STARTS, not views', () => {
    const cat = METRIC_CATALOG.find((d) => d.key === 'video_views')!
    expect(cat.label).toBe('Video Starts')
    expect(cat.description).toMatch(/NOT a p25 milestone and NOT a three-second view/)
  })

  it('the health breakdown exposes retention_score, not hook_score', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/creative/health-score.ts'), 'utf8')
    expect(src).toMatch(/retention_score: number/)
    expect(src).not.toMatch(/^\s*hook_score: number/m)
  })
})
