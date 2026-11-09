import { describe, it, expect } from 'vitest'
import fs from 'fs'

// Review finding: /api/sync accepts arbitrary ranges (e.g. previous_7_days) but every run used to invoke
// the live flag-resolution + recommendation-replacement pipeline — a HISTORICAL sync could close today's
// flags and supersede today's recommendations with past data. These pins fail if the lifecycle gate is
// ever removed: flag engine + recommendation generation must run ONLY when the window contains at least
// 30 completed days and ends on the canonical current completed day.

describe('orchestrator — lifecycle gate (historical syncs are ingest/report-only)', () => {
  const src = fs.readFileSync('src/lib/sync/orchestrator.ts', 'utf8')

  it('computes the gate against the governed complete-window helper', () => {
    expect(src).toMatch(/const lifecycleRun = lifecycleWindowIsComplete\(dateStart, dateEnd\)/)
  })

  it('the flag engine call is inside the gate', () => {
    const gated = src.match(/if \(lifecycleRun\) \{[\s\S]*?runFlagEngine\(/)
    expect(gated).not.toBeNull()
  })

  it('recommendation generation is inside the gate', () => {
    const gated = src.match(/if \(lifecycleRun\) \{[\s\S]*?generateRecommendationsFromFlags\(/)
    expect(gated).not.toBeNull()
  })

  it('the cron no longer generates recommendations itself (moved into the orchestrator, pre-report)', () => {
    const cron = fs.readFileSync('src/app/api/cron/daily-sync/route.ts', 'utf8')
    expect(cron).not.toMatch(/await generateRecommendationsFromFlags\(/)
  })
})
