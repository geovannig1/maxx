import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CreativeDiagnosticCard } from '@/components/creative/CreativeDiagnosticCard'
import { getCreativeDiagnostic } from '@/lib/creative/verdict'

describe('owner creative evidence surface', () => {
  it('labels the card diagnostic-only and routes decisions to Current Recommendations', () => {
    const diagnostic = getCreativeDiagnostic({
      ctr: 2,
      frequency: 4,
      earlyViewRate: 3,
      earlyViewSource: 'video_play_actions',
      thruplayRate: 2,
      retentionP25Rate: 8,
      retentionDenominator: 'video_starts',
      videoStartCoverage: 'complete',
      derivedMetricWarningCount: 0,
      impressions: 5_000,
      windowDays: 7,
    })
    const html = renderToStaticMarkup(<CreativeDiagnosticCard diagnostic={diagnostic} />)

    expect(html).toMatch(/Diagnostic only/i)
    expect(html).toMatch(/Current Recommendations/i)
    expect(html).not.toMatch(/\b(kill|scale|pause|refresh|retire|push (?:more )?budget)\b/i)
  })

  it('structurally removes the alternate creative action brain from API and owner UI', () => {
    const files = {
      engine: fs.readFileSync(path.join(process.cwd(), 'src/lib/creative/verdict.ts'), 'utf8'),
      api: fs.readFileSync(path.join(process.cwd(), 'src/app/api/ads/route.ts'), 'utf8'),
      page: fs.readFileSync(path.join(process.cwd(), 'src/app/(dashboard)/performance/ads/page.tsx'), 'utf8'),
      card: fs.readFileSync(path.join(process.cwd(), 'src/components/creative/CreativeDiagnosticCard.tsx'), 'utf8'),
    }

    expect(files.engine).not.toMatch(/CreativeAction|getCreativeVerdict|ACTION_LABEL/)
    expect(files.engine).not.toMatch(/\b(bookings|cpa|cpl|leads|spend)\b/i)
    expect(files.api).not.toMatch(/getCreativeVerdict|CreativeVerdict|const verdict|\bverdict,/)
    expect(files.page).not.toMatch(/VERDICT_PILL|CreativeVerdict|selected\.verdict|ad\.verdict/)
    expect(files.api).not.toMatch(/fatigueLevel|health_score/)
    expect(files.page).not.toMatch(/health_score|fatigue_level|Leaderboard|CpaBar|FrequencyBar|RangeBadge|getTargetRange/)
    // The ads table renders through EntityTable now, so the flag is declared on its metrics prop
    // rather than on MetricBodyCells directly. Same invariant: no provisional bands on this table.
    expect(files.page).toMatch(/MetricBodyCells[^>]+showBands=\{false\}|metrics=\{\{[\s\S]{0,400}?showBands:\s*false/)
    expect(files.page).not.toMatch(/showBands[=:]\s*\{?\s*true/)
    expect(files.page).not.toMatch(/f\.flag_type\.replace/)
    expect(files.page).not.toMatch(/recommended_action|resolveDisplayAuthority/)
    expect(files.page).not.toMatch(/adsmanager[^\n]*act=\d+/)

    for (const [name, source] of Object.entries(files)) {
      expect(source, name).not.toMatch(/pause before more budget|push more budget|queue a fresh creative|creative refresh needed|retire it/i)
    }
  })
})
