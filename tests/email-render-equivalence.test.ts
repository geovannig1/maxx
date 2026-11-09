import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'

import { renderDailyDigestHtml } from '@/lib/report/daily-digest-email'
import { renderDailyDigestMarkdown, type DailyDigestV3 } from '@/lib/report/daily-digest'
import { buildWeeklyExecutiveDigest } from '@/lib/report/weekly-executive'
import { renderWeeklyExecutiveHtml } from '@/lib/report/weekly-executive-email'
import {
  injectionDigestFixture,
  maximalDigestFixture,
  minimalDigestFixture,
} from './fixtures/daily-digest-v2'
import {
  WEEKLY_REPORT_ID,
  WEEK_END,
  WEEK_START,
  weeklyExecutiveEvidenceFixture,
} from './fixtures/weekly-executive'
import { htmlStructure, htmlText, startTags } from './helpers/html-structure'

/**
 * Renderer-equivalence baseline for both owner emails. The `__email_baseline__` files were captured
 * from the previous renderer (@react-email/components 1.0.12 + @react-email/render 2.1.0) BEFORE it
 * was replaced, so a replacement must reproduce the same elements, attributes, inline styles, text
 * and links. Only comments, attribute order and whitespace runs are normalised away (see
 * tests/helpers/html-structure.ts, which also names the one deliberately dropped attribute).
 *
 * The plain-text MIME part is the committed digest text (`markdown` / `text`), produced without any
 * HTML library; its baseline pins that the renderer swap cannot touch it.
 */

const DASHBOARD_URL = 'https://example.com/dashboard'
const WEEKLY_URL = 'https://maxx.example.com/activity/reports'
const baseline = (name: string) => `./__email_baseline__/${name}`

function weeklyDigest(mutate?: (evidence: typeof weeklyExecutiveEvidenceFixture) => void) {
  const evidence = JSON.parse(JSON.stringify(weeklyExecutiveEvidenceFixture)) as typeof weeklyExecutiveEvidenceFixture
  mutate?.(evidence)
  return buildWeeklyExecutiveDigest(evidence, { weeklyReportId: WEEKLY_REPORT_ID, weekStart: WEEK_START, weekEnd: WEEK_END })
}

function setFirstAudienceName(evidence: typeof weeklyExecutiveEvidenceFixture, name: string) {
  const setup = evidence.setupChanges as unknown as {
    adsets: Array<{ audience: { includedCustomAudiences: Array<{ name: string }> } }>
  }
  setup.adsets[1].audience.includedCustomAudiences[0].name = name
}

describe('daily digest email matches the previous renderer', () => {
  it.each([
    ['maximal', maximalDigestFixture, DASHBOARD_URL],
    ['minimal', minimalDigestFixture, DASHBOARD_URL],
    ['injection', injectionDigestFixture, DASHBOARD_URL],
    ['no-cta', maximalDigestFixture, ''],
  ] as const)('%s: same structure, text and links', async (name, digest, url) => {
    const html = await renderDailyDigestHtml(digest, url)
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    await expect(htmlStructure(html)).toMatchFileSnapshot(baseline(`daily-${name}.html.txt`))
  })

  it.each([
    ['maximal', maximalDigestFixture],
    ['minimal', minimalDigestFixture],
    ['injection', injectionDigestFixture],
  ] as const)('%s: the plain-text part is unchanged', async (name, digest) => {
    await expect(digest.markdown).toMatchFileSnapshot(baseline(`daily-${name}.text.txt`))
  })
})

describe('weekly executive email matches the previous renderer', () => {
  it('fixture: same structure, text and links', async () => {
    const digest = weeklyDigest()
    const html = await renderWeeklyExecutiveHtml(digest, WEEKLY_URL)
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    await expect(htmlStructure(html)).toMatchFileSnapshot(baseline('weekly-fixture.html.txt'))
    await expect(digest.text).toMatchFileSnapshot(baseline('weekly-fixture.text.txt'))
  })

  it('hostile evidence and unsafe link: same structure, text and links', async () => {
    const digest = weeklyDigest((evidence) => setFirstAudienceName(evidence, '<img src=x onerror=alert(1)>'))
    const html = await renderWeeklyExecutiveHtml(digest, 'javascript:alert(1)')
    await expect(htmlStructure(html)).toMatchFileSnapshot(baseline('weekly-hostile.html.txt'))
  })
})

// A value that tries both escapes at once: close a text node into a script element, and close an
// attribute value into an event handler.
const ATTACK = '"><script>alert(1)</script><b x=" onerror="alert(2)'
const ATTACK_URL = 'https://example.com/reports?x=" onerror="alert(3)'

function assertNoInjectedMarkup(html: string) {
  const tags = startTags(html)
  expect(tags.map((tag) => tag.name)).not.toContain('script')
  expect(tags.map((tag) => tag.name)).not.toContain('b')
  for (const tag of tags) {
    expect(tag.attributes.map(([name]) => name).filter((name) => name.startsWith('on')), `<${tag.name}>`).toEqual([])
  }
  expect(html).not.toMatch(/<script/i)
}

describe('untrusted values stay escaped in both MIME parts', () => {
  it('control: the markup check rejects an unescaped value', () => {
    expect(() => assertNoInjectedMarkup(`<p>${ATTACK}</p>`)).toThrow()
    expect(() => assertNoInjectedMarkup(`<a href="${ATTACK_URL}">x</a>`)).toThrow()
  })

  it('daily: a hostile account name, KPI label, flag and dashboard URL never become markup', async () => {
    const parts: Omit<DailyDigestV3, 'markdown'> = {
      ...maximalDigestFixture,
      account_name: ATTACK,
      kpis: maximalDigestFixture.kpis.map((kpi, index) => (index === 0 ? { ...kpi, label: ATTACK } : kpi)),
      flags: [ATTACK],
    }
    const digest: DailyDigestV3 = { ...parts, markdown: renderDailyDigestMarkdown(parts) }

    const html = await renderDailyDigestHtml(digest, ATTACK_URL)

    assertNoInjectedMarkup(html)
    const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;b x=&quot; onerror=&quot;alert(2)'
    expect(html.split(escaped).length - 1).toBe(3)
    // The URL stays one attribute value: its quote is encoded, so `onerror` is part of the href.
    const link = startTags(html).find((tag) => tag.name === 'a')
    expect(link?.attributes).toContainEqual(['href', 'https://example.com/reports?x=&quot; onerror=&quot;alert(3)'])
    expect(htmlText(html)).toContain(escaped)
    // text/plain carries the value as inert text, verbatim: no markup context, and no entity
    // double-encoding that would show the owner `&lt;` instead of `<`.
    expect(digest.markdown).toContain(ATTACK)
    expect(digest.markdown).not.toContain('&lt;')
  })

  it('weekly: hostile committed evidence never becomes markup', async () => {
    const digest = weeklyDigest((evidence) => setFirstAudienceName(evidence, ATTACK))

    const html = await renderWeeklyExecutiveHtml(digest, ATTACK_URL)

    assertNoInjectedMarkup(html)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('href="https://example.com/reports?x=&quot; onerror=&quot;alert(3)"')
    expect(digest.text).toContain(ATTACK)
    expect(digest.text).not.toContain('&lt;')
  })
})
