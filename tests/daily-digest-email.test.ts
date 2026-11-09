import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEEKLY_SPEND_CONTEXT_UNAVAILABLE } from '@/lib/report/daily-digest-signals'
import { renderDailyDigestHtml } from '@/lib/report/daily-digest-email'
import {
  HOSTILE_SITE_COUNT,
  HOSTILE_STRING,
  MAXIMAL_ACCOUNT_NAME,
  injectionDigestFixture,
  maximalDigestFixture,
  minimalDigestFixture,
} from './fixtures/daily-digest-v2'

const DASHBOARD_URL = 'https://example.com/dashboard'

/** Everything between a label and the end of its table row. */
function rowFor(html: string, label: string): string {
  const start = html.indexOf(label)
  expect(start, `label not rendered: ${label}`).toBeGreaterThan(-1)
  const end = html.indexOf('</tr>', start)
  return html.slice(start, end === -1 ? undefined : end)
}

/** Visible text only: style attributes are full of digits and colour words that would confuse
 *  assertions about what the OWNER actually reads in a cell. */
function textOf(fragment: string): string {
  return fragment.replace(/<[^>]*>/g, ' ')
}

function between(html: string, from: string, to: string): string {
  const start = html.indexOf(from)
  const end = html.indexOf(to, start)
  expect(start, `missing: ${from}`).toBeGreaterThan(-1)
  expect(end, `missing: ${to}`).toBeGreaterThan(start)
  return html.slice(start, end)
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('renderDailyDigestHtml', () => {
  it('renders all three descriptive states, every KPI row, narrative, and CTA', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    expect(html).toContain(maximalDigestFixture.states.business.line)
    expect(html).toContain(maximalDigestFixture.states.paid_delivery.line)
    expect(html).toContain(maximalDigestFixture.states.data_confidence.line)
    for (const k of maximalDigestFixture.kpis) expect(html).toContain(k.label)
    expect(html).toContain(maximalDigestFixture.narrative.text)
    expect(html).toContain(DASHBOARD_URL)
  })

  it('renders every section of the fixed layout in spec order', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    const order = [
      'Maxx Daily',
      maximalDigestFixture.report_date,
      MAXIMAL_ACCOUNT_NAME,
      maximalDigestFixture.states.business.line,
      maximalDigestFixture.states.paid_delivery.line,
      maximalDigestFixture.states.data_confidence.line,
      'Spend context',
      'What changed',
      'Observed flags',
      'Creative evidence',
      'Deterministic read',
      'Governed actions',
      DASHBOARD_URL,
      'committed report facts',
    ]
    const positions = order.map((needle) => html.indexOf(needle))
    for (const [index, position] of positions.entries()) {
      expect(position, `missing: ${order[index]}`).toBeGreaterThan(-1)
      if (index > 0) expect(position, `out of order: ${order[index]}`).toBeGreaterThan(positions[index - 1])
    }
  })

  it('renders the account name from the snapshot, not from an argument', async () => {
    const html = await renderDailyDigestHtml(
      { ...maximalDigestFixture, account_name: 'Renamed Studio' },
      DASHBOARD_URL,
    )
    expect(html).toContain('Renamed Studio')
  })

  it('stays under the 90KB budget on a maximal digest', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(90_000)
  })

  it('contains no scripts, no images, and no external resources except the CTA link', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img/i)
    const urls = [...html.matchAll(/https?:\/\/[^"'\s>]+/g)].map((m) => m[0])
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith(DASHBOARD_URL))).toBe(true)
  })

  it('uses only Gmail-supported layout primitives', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    // Gmail supports none of these; a layout that depends on them collapses.
    expect(html).not.toMatch(/display\s*:\s*(flex|grid|inline-flex)/i)
    expect(html).not.toMatch(/position\s*:\s*(absolute|fixed|relative|sticky)/i)
    expect(html).not.toMatch(/--[a-z-]+\s*:/i)
    expect(html).not.toMatch(/var\(\s*--/i)
    expect(html).not.toMatch(/@media/i)
    expect(html).not.toMatch(/prefers-color-scheme/i)
    expect(html).not.toMatch(/<style/i)
    // Force-inverting surfaces make pure black and pure white unsafe.
    expect(html).not.toMatch(/#ffffff|#fff\b|#000000|#000\b/i)
    expect(html).toContain('<table')
    expect(html).toContain('name="color-scheme" content="light"')
  })
})

describe('KPI table geometry', () => {
  /**
   * Every `<Row>` is its own `<table>`. Without a fixed layout AND an explicit width on every cell,
   * each row computes independent auto-layout geometry and no value lines up with its own header —
   * measured at over 300px of stagger before this was pinned.
   */
  it('gives every KPI row the same fixed column geometry as the header row', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    const table = between(html, 'What changed', 'Observed flags')
    const rows = maximalDigestFixture.kpis.length + 1 // + the header row
    expect(countOf(table, 'table-layout:fixed')).toBe(rows)
    expect(countOf(table, 'width:40%')).toBe(rows)
    expect(countOf(table, 'width:24%')).toBe(rows)
    expect(countOf(table, 'width:36%')).toBe(rows)
  })
})

describe('delta states (never noise_gated)', () => {
  it('gives a significant delta a direction glyph and the number', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    const falling = textOf(rowFor(html, 'Meta-modelled bookings'))
    expect(falling).toContain('▼')
    expect(falling).toContain('-50.0%')
    expect(falling).not.toContain('within noise')

    const rising = textOf(rowFor(html, 'Amount Spent'))
    expect(rising).toContain('▲')
    expect(rising).toContain('+34.2%')
  })

  /**
   * Colour is reserved for the deterministic stoplight (verdict banner, pacing chip). A coloured
   * delta would be a daily performance verdict, which the spec reserves for the weekly cadence.
   */
  it('never colours a KPI delta green or red', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    const table = between(html, 'What changed', 'Observed flags')
    expect(table).not.toMatch(/#1e7f4f|#186941|#b3372c|#7a6000|#8f4700/i)
    for (const kpi of maximalDigestFixture.kpis) {
      const row = rowFor(html, kpi.label)
      expect(row, `coloured delta on ${kpi.label}`).not.toMatch(/color:#(?!1a1a1a|6b7280|e3e3e3)/i)
    }
  })

  it('renders a within_noise delta gray and labelled, with no glyph', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    const leads = rowFor(html, '>Leads<')
    expect(textOf(leads)).toContain('within noise')
    expect(leads).toContain('#6b7280')
    expect(textOf(leads)).not.toContain('▲')
    expect(textOf(leads)).not.toContain('▼')
  })

  it('never calls a no_baseline row "within noise" — an absent measurement is not a flat one', async () => {
    const html = await renderDailyDigestHtml(minimalDigestFixture, DASHBOARD_URL)
    // Every KPI in the quiet-day fixture is no_baseline, so the phrase must appear nowhere.
    expect(html).not.toContain('within noise')
    for (const kpi of minimalDigestFixture.kpis) {
      expect(textOf(rowFor(html, kpi.label))).toContain('no comparison')
    }

    // ...and it holds row-locally on a digest where OTHER rows are legitimately within noise.
    const mixed = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    const noBaseline = textOf(rowFor(mixed, 'Cost per lead'))
    expect(noBaseline).toContain('no comparison')
    expect(noBaseline).not.toContain('within noise')
  })

  it('renders a null value as unavailable, never as 0 and never as a bare dash', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    const row = textOf(rowFor(html, 'Value-bearing bookings (Acuity ledger)'))
    expect(row).toContain('unavailable')
    expect(row).not.toMatch(/\d/)
    expect(row).not.toMatch(/[—–-]\s*$/)
  })
})

describe('untrusted input', () => {
  /**
   * Ad names, account names and recommendation reasons originate in Meta and Acuity. The template
   * relies on React escaping every text child; that has to be pinned, not assumed.
   */
  it('escapes hostile text at every interpolation site', async () => {
    const html = await renderDailyDigestHtml(injectionDigestFixture, DASHBOARD_URL)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toContain(HOSTILE_STRING)
    const escaped = 'Glam &amp; Co &lt;script&gt;alert(1)&lt;/script&gt; &quot;V2&quot; it&#x27;s'
    expect(countOf(html, escaped)).toBe(HOSTILE_SITE_COUNT)
    // The safety sweep must still hold on a hostile digest, not only a friendly one.
    const urls = [...html.matchAll(/https?:\/\/[^"'\s>]+/g)].map((m) => m[0])
    expect(urls.every((u) => u.startsWith(DASHBOARD_URL))).toBe(true)
  })

  it('omits the ENTIRE CTA block when there is no linkable dashboard URL', async () => {
    // '' is the real production input when neither Vercel URL env is present.
    for (const unusable of ['', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'not a url']) {
      const html = await renderDailyDigestHtml(maximalDigestFixture, unusable)
      // Not merely unlinked: the label and the button chrome around it are both gone, so no dead
      // affordance ships. `TEXT` is the CTA button's background colour.
      expect(html).not.toContain('Open the dashboard')
      expect(html).not.toMatch(/<a\s/i)
      expect(html).not.toMatch(/background-color:\s*#1a1a1a/i)
      expect(html).not.toMatch(/javascript:/i)
      expect(html).not.toMatch(/data:text/i)
      expect(html).not.toMatch(/<script/i)
    }
    const good = await renderDailyDigestHtml(maximalDigestFixture, 'http://localhost:3000/reports')
    expect(good).toContain('href="http://localhost:3000/reports"')
    expect(good).toContain('Open the dashboard')
  })
})

describe('deterministic narrative', () => {
  it('renders only the deterministic committed narrative', async () => {
    const html = await renderDailyDigestHtml(minimalDigestFixture, DASHBOARD_URL)
    expect(minimalDigestFixture.narrative.source).toBe('deterministic')
    expect(html).toContain(minimalDigestFixture.narrative.text)
    expect(html).not.toMatch(/model read|fallback/i)
  })
})

describe('quiet day', () => {
  it('names every empty state instead of dropping the section', async () => {
    const html = await renderDailyDigestHtml(minimalDigestFixture, DASHBOARD_URL)
    expect(minimalDigestFixture.flags).toHaveLength(0)
    expect(minimalDigestFixture.creative).toHaveLength(0)
    expect(minimalDigestFixture.decisions).toHaveLength(0)
    for (const [heading, sentence] of [
      ['Observed flags', 'No observed flag was emitted.'],
      ['Creative evidence', 'No creative evidence was available.'],
      ['Governed actions', 'No governed action is present.'],
    ]) {
      expect(html).toContain(heading)
      expect(html).toContain(sentence)
    }
  })

  it('bullets the structured arrays here, not in the contract', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    for (const line of [...maximalDigestFixture.flags, ...maximalDigestFixture.creative, ...maximalDigestFixture.decisions]) {
      expect(line.startsWith('- ')).toBe(false)
      expect(html).toContain(line)
    }
    expect(html).toContain('•')
    expect(html).toContain('review weekly')
  })
})

describe('spend context', () => {
  it('renders factual spend without classifying it against a current daily budget', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    const context = between(html, 'Spend context', 'What changed')
    expect(context).toContain('$82.50')
    expect(context).toContain('reported-day spend')
    expect(context).toContain(WEEKLY_SPEND_CONTEXT_UNAVAILABLE)
    expect(context).not.toMatch(/over target|under target|pacing (green|red|yellow|orange)/i)
  })

  it('renders unavailable when factual spend could not be read', async () => {
    const html = await renderDailyDigestHtml(minimalDigestFixture, DASHBOARD_URL)
    expect(html).toContain('unavailable')
    expect(html).toContain('reported-day spend')
  })

  it('carries the same weekly-context boundary in both MIME renderings', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    expect(between(html, 'Spend context', 'What changed')).toContain(WEEKLY_SPEND_CONTEXT_UNAVAILABLE)
    expect(maximalDigestFixture.markdown).toContain(WEEKLY_SPEND_CONTEXT_UNAVAILABLE)
  })

  it('never renders non-finite factual spend as $NaN', async () => {
    const broken = {
      ...maximalDigestFixture,
      pacing: { ...maximalDigestFixture.pacing, spend: Number.NaN },
    }
    const html = await renderDailyDigestHtml(broken, DASHBOARD_URL)

    expect(html).not.toContain('NaN')
    expect(html).toContain('unavailable')
  })
})

describe('governance footer', () => {
  it('carries the report date and every standing governance note', async () => {
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    expect(html).toContain(maximalDigestFixture.report_date)
    expect(html).toContain('committed report facts')
    expect(html).toContain('Diagnostic only')
    expect(html).toContain('Acuity ledger')
    expect(html).toContain('Meta')
    expect(html).toContain('GA4')
    expect(html).toContain('provisional')
  })
})

describe('preview artifact', () => {
  it('writes a preview file when DIGEST_PREVIEW=1', async () => {
    if (process.env.DIGEST_PREVIEW !== '1') return
    const html = await renderDailyDigestHtml(maximalDigestFixture, DASHBOARD_URL)
    const target = resolve(
      fileURLToPath(new URL('../', import.meta.url)),
      'test-results/daily-digest-preview.html',
    )
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, html, 'utf8')
    expect(html.length).toBeGreaterThan(0)
  })
})
