import { describe, expect, it } from 'vitest'

import { renderWeeklyExecutiveHtml, WEEKLY_EXECUTIVE_HTML_MAX_BYTES } from '@/lib/report/weekly-executive-email'
import { buildWeeklyExecutiveDigest } from '@/lib/report/weekly-executive'
import {
  WEEKLY_REPORT_ID,
  WEEK_END,
  WEEK_START,
  weeklyExecutiveEvidenceFixture,
} from './fixtures/weekly-executive'

describe('weekly executive email renderer', () => {
  it('renders every text section from the same digest with Gmail-safe HTML parity', async () => {
    const digest = buildWeeklyExecutiveDigest(weeklyExecutiveEvidenceFixture, {
      weeklyReportId: WEEKLY_REPORT_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    })
    const html = await renderWeeklyExecutiveHtml(digest, 'https://maxx.example.com/activity/reports')

    for (const heading of ['Weekly context', 'Setup', 'Audiences', 'Placements', 'Creative', 'Tracking', 'Material changes']) {
      expect(digest.text).toContain(`## ${heading}`)
      expect(html).toContain(heading)
    }
    expect(html).toContain('Diagnostic only')
    expect(html).toContain('href="https://maxx.example.com/activity/reports"')
    expect(html).not.toMatch(/<style|display:\s*(?:flex|grid)|position:\s*(?:absolute|fixed)|var\(--/i)
    expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(WEEKLY_EXECUTIVE_HTML_MAX_BYTES)
  })

  it('escapes committed evidence strings and omits an unsafe dashboard link', async () => {
    const hostile = JSON.parse(JSON.stringify(weeklyExecutiveEvidenceFixture)) as Record<string, unknown>
    const setup = hostile.setupChanges as {
      adsets: Array<{ audience: { includedCustomAudiences: Array<{ name: string }> } }>
    }
    setup.adsets[1].audience.includedCustomAudiences[0].name = '<img src=x onerror=alert(1)>'
    const digest = buildWeeklyExecutiveDigest(hostile as unknown as typeof weeklyExecutiveEvidenceFixture, {
      weeklyReportId: WEEKLY_REPORT_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    })
    const html = await renderWeeklyExecutiveHtml(digest, 'javascript:alert(1)')

    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
    expect(html).not.toMatch(/<a\s/i)
  })

  it('keeps a large committed setup inside the Gmail-safe byte budget deterministically', async () => {
    const large = JSON.parse(JSON.stringify(weeklyExecutiveEvidenceFixture)) as typeof weeklyExecutiveEvidenceFixture
    const seedAdset = large.setupChanges!.adsets[0]
    const seedWrapper = large.setupChanges!.active_ad_wrappers[0]
    large.setupChanges!.adsets = Array.from({ length: 80 }, (_, index) => ({
      ...seedAdset,
      meta_adset_id: `adset-${String(index).padStart(3, '0')}`,
      name: `${'Long setup identity '.repeat(40)}${index}`,
    }))
    large.setupChanges!.active_ad_wrappers = Array.from({ length: 80 }, (_, index) => ({
      ...seedWrapper,
      meta_ad_id: `ad-${String(index).padStart(3, '0')}`,
      name: `${'Long creative identity '.repeat(40)}${index}`,
    }))
    const digest = buildWeeklyExecutiveDigest(large, {
      weeklyReportId: WEEKLY_REPORT_ID, weekStart: WEEK_START, weekEnd: WEEK_END,
    })
    const html = await renderWeeklyExecutiveHtml(digest, '')

    expect(Object.values(digest.sections).every((lines) => lines.length <= 10)).toBe(true)
    expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(WEEKLY_EXECUTIVE_HTML_MAX_BYTES)
  })
})
