import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CRITICAL_ALERT_QUEUE_HREF,
  criticalAlertLabel,
  unresolvedCriticalAlertTotal,
} from '@/components/layout/Topbar'
import { groupReportingSourceNotes, ReportingSourceNotes, reportingSourceSummary, reportingSourcesHealthy, reportingTrustRecency } from '@/components/reporting/ReportingWorkspace'

describe('reporting Trust chrome', () => {
  it('uses grammatical singular and plural source-attention summaries', () => {
    expect(reportingSourceSummary(1, false, 0, false)).toBe('1 source needs attention')
    expect(reportingSourceSummary(2, false, 0, false)).toBe('2 sources need attention')
  })

  it('shows the source denominator for partial evidence with grammatical singular and plural counts', () => {
    expect(reportingSourceSummary(0, false, 1, false)).toBe('1 of 4 sources partial')
    expect(reportingSourceSummary(0, false, 2, false)).toBe('2 of 4 sources partial')
    expect(reportingSourceSummary(0, false, 1, false, 1)).toBe('1 of 1 source partial')
    expect(reportingSourceSummary(0, false, 2, false, 3)).toBe('2 of 3 sources partial')
  })

  it('reads positively when every source is healthy, and when the only partial source is partial by design', () => {
    expect(reportingSourceSummary(0, false, 0, true)).toBe('All 4 sources healthy')
    expect(reportingSourceSummary(0, false, 1, false, 4, 1)).toBe('All 4 sources reporting · Tracking is a lower bound')
    expect(reportingSourcesHealthy('All 4 sources healthy')).toBe(true)
    // A partial source with an issue still reads as partial, and counts every partial source.
    expect(reportingSourceSummary(0, false, 2, false, 4, 1)).toBe('2 of 4 sources partial')
    expect(reportingSourcesHealthy('2 of 4 sources partial')).toBe(false)
    // An unavailable source is never folded into an all-clear.
    expect(reportingSourceSummary(1, false, 1, false, 4, 1)).toBe('1 source needs attention')
  })

  it('keeps four independently reported source states and their own evidence recency in the Trust summary', () => {
    expect(reportingTrustRecency([
      { label: 'Meta', state: 'available', asOf: '2026-09-05T17:00:00Z' },
      { label: 'Acuity', state: 'partial', asOf: '2026-09-04T14:00:00Z' },
      { label: 'GA4', state: 'unavailable', asOf: null },
      { label: 'Tracking', state: 'loading', asOf: null },
    ])).toBe('Meta Sep 5 · Acuity Sep 4 (partial) · GA4 unavailable · Tracking loading')
    expect(reportingTrustRecency([
      { label: 'Meta', state: 'available', asOf: '2026-09-05T02:30:00Z' },
    ])).toBe('Meta Sep 4')
  })

  it('identifies a refresh failure with the retained evidence time in ET instead of inferring staleness', () => {
    expect(reportingTrustRecency([
      { label: 'Meta', state: 'refresh failed', asOf: '2026-09-05T17:00:00Z' },
      { label: 'Acuity', state: 'available', asOf: '2026-09-05T17:30:00Z' },
    ])).toBe('Meta · refresh failed · retained Sep 5, 1:00 PM ET · Acuity Sep 5')
    expect(reportingTrustRecency([
      { label: 'Meta', state: 'refresh failed', asOf: '2026-09-05T02:30:00Z' },
    ])).toBe('Meta · refresh failed · retained Sep 4, 10:30 PM ET')
  })

  it('uses the alert API total and preserves unavailable reads as unknown', () => {
    expect(unresolvedCriticalAlertTotal({ alerts: [], total: 3 })).toBe(3)
    expect(unresolvedCriticalAlertTotal({ alerts: [], total: 0 })).toBe(0)
    expect(unresolvedCriticalAlertTotal({ alerts: [], count: 3 })).toBeNull()
    expect(unresolvedCriticalAlertTotal(null)).toBeNull()
    expect(criticalAlertLabel('available', 3)).toBe('3 unresolved critical alerts — open decision queue')
    expect(criticalAlertLabel('available', 0)).toBe('No unresolved critical alerts — open decision queue')
    expect(criticalAlertLabel('unavailable', 0)).toBe('Unresolved critical alert status unavailable — open decision queue')
    // Before setup and the first Meta sync there is no ad account to read alerts for: say so calmly.
    expect(criticalAlertLabel('not_ready', 0)).toBe('Alerts start after setup and the first Meta sync — open decision queue')
    expect(CRITICAL_ALERT_QUEUE_HREF).toBe('/decisions?filter=unresolved_critical_alerts&legacy=inbox')
  })

  it('keeps supporting reporting pages source controls directly visible', () => {
    const workspace = readFileSync('src/components/reporting/ReportingWorkspace.tsx', 'utf8')
    const topbar = readFileSync('src/components/layout/Topbar.tsx', 'utf8')
    const decisions = readFileSync('src/app/(dashboard)/decisions/page.tsx', 'utf8')
    expect(workspace).toContain("{view !== 'overview' && <section id=\"reporting-trust\"")
    expect(workspace).not.toContain("{view !== 'overview' && <details id=\"reporting-trust\"")
    expect(topbar).toContain("const reportingTrustHref = pathname === '/dashboard' ? '#reporting-trust' : '/dashboard#reporting-trust'")
    expect(decisions).toContain("readDecisionQueue(filter ? { alertScope: 'unresolved_critical' } : undefined)")
  })

  it('groups repeated source-note templates by issue while preserving overlap and originals', () => {
    const notes = [
      "Creative 101 has multiple dynamic assets; a single asset's performance cannot be identified from ad totals.",
      "Creative 101 has multiple dynamic assets; a single asset's performance cannot be identified from ad totals.",
      "Creative 102 has multiple dynamic assets; a single asset's performance cannot be identified from ad totals.",
      'Creative 101 configured story-video preview uses exact readable member video-7; alternate video identities remain preserved.',
      'Video playback or duration unavailable for creative 103; its thumbnail and metrics remain available. Meta error 500.',
      'Refresh failed on 2026-09-08 with HTTP 429 after 38 rows; retained evidence remains visible.',
    ]
    const groups = groupReportingSourceNotes(notes)
    expect(groups.find(group => group.key === 'dynamic_assets')).toMatchObject({ entityIds: ['101', '102'] })
    expect(groups.find(group => group.key === 'configured_preview')).toMatchObject({ entityIds: ['101'] })
    expect(groups.find(group => group.key === 'playback_duration')).toMatchObject({ entityIds: ['103'] })
    expect(groups.find(group => group.key === 'other')).toMatchObject({ entityIds: [] })
    expect(groups.flatMap(group => group.entityIds).filter(id => id === '101')).toHaveLength(2)
    expect(groups.flatMap(group => group.notes)).toHaveLength(5)

    const recordedShape = groupReportingSourceNotes([
      ...Array.from({ length: 45 }, (_, index) => `Creative d${index + 1} has multiple dynamic assets; a single asset's performance cannot be identified from ad totals.`),
      ...Array.from({ length: 38 }, (_, index) => `Creative d${index + 1} configured story-video preview uses exact readable member v${index + 1}; alternate identities remain preserved.`),
      ...Array.from({ length: 8 }, (_, index) => `Video playback or duration unavailable for creative d${index + 1}; its thumbnail and metrics remain available.`),
    ])
    expect(recordedShape.find(group => group.key === 'dynamic_assets')?.entityIds).toHaveLength(45)
    expect(recordedShape.find(group => group.key === 'configured_preview')?.entityIds).toHaveLength(38)
    expect(recordedShape.find(group => group.key === 'playback_duration')?.entityIds).toHaveLength(8)

    const html = renderToStaticMarkup(ReportingSourceNotes({ notes }))
    const text = html.replace(/<[^>]*>/g, '')
    expect(text).toContain('Dynamic asset ambiguity · 2 affected entities')
    expect(text).toContain('Configured story-video previews · 1 affected entity')
    expect(text).toContain('Playback or duration unavailable · 1 affected entity')
    expect(text).toContain('Other source notes · affected entities not identified')
    expect(html).toContain('<details')
    expect(html).toContain('<summary')
    expect(html).toContain('Creative IDs: 101, 102')
    expect(html).toContain('HTTP 429 after 38 rows')
  })

  it('does not infer a creative ID from an ISO date while retaining legitimate numeric IDs', () => {
    const dateNote = "Creative 2026-09-08 has multiple dynamic assets; a single asset's performance cannot be identified from ad totals."
    const numericNote = "Creative 123456789012345 has multiple dynamic assets; a single asset's performance cannot be identified from ad totals."
    const groups = groupReportingSourceNotes([dateNote, numericNote])
    expect(groups.find(group => group.key === 'dynamic_assets')).toMatchObject({ entityIds: ['123456789012345'], notes: [numericNote] })
    expect(groups.find(group => group.key === 'other')).toMatchObject({ entityIds: [], notes: [dateNote] })
  })
})
