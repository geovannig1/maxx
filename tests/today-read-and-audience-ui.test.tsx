import './_support/outcome-noun-booking'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TodayReadPanel } from '@/components/dashboard/TodayReadPanel'
import { AudiencePerformanceTable } from '@/components/dashboard/AudiencePerformanceTable'
import { byAudience, byConcept, buildTodayRead, type AdRow } from '@/lib/cockpit/audience-performance'

const ADS: AdRow[] = [
  { adName: 'Warm | Daylight Set | May 2026 (7d)', status: 'PAUSED', spend: 812.60, results: 21, clicks: 1426, impressions: 52800 },
  { adName: 'Cold | Loft Tour | May 2026 (7d)', status: 'PAUSED', spend: 462.90, results: 3, clicks: 498, impressions: 27400 },
  { adName: 'gallery-walk-3', status: 'WITH_ISSUES', spend: 143.20, results: 2, clicks: 235, impressions: 9790 },
  { adName: 'Cold | Loft Tour | May 2026 (7d) (ADR-056 tagged)', status: 'ACTIVE', spend: 129.60, results: 0, clicks: 249, impressions: 8590 },
  { adName: 'Warm | Backdrop Wall | April 2026 (7d)', status: 'PAUSED', spend: 196.40, results: 5, clicks: 245, impressions: 12250 },
  { adName: 'Cold | Mirror Wall | June 2026 (7d) (ADR-056 tagged)', status: 'ACTIVE', spend: 88.15, results: 0, clicks: 73, impressions: 2430 },
  { adName: 'Warm | Daylight Set | May 2026 (7d) (ADR-056 tagged)', status: 'ACTIVE', spend: 57.70, results: 2, clicks: 55, impressions: 1610 },
]

describe('the read panel', () => {
  const markup = renderToStaticMarkup(TodayReadPanel({ read: buildTodayRead(byAudience(ADS)) }))

  it('leads with the sentence, not a number grid', () => {
    expect(markup).toContain('Cold has spent $217.75 on live ads with no bookings')
    expect(markup).toContain('What matters today')
  })

  it('puts the evidence on screen rather than behind a click', () => {
    expect(markup).toContain('Warm lifetime $38.10 per booking')
    expect(markup).not.toContain('<details')
  })

  it('speaks plainly — no enums, no jargon, no target verdict', () => {
    expect(markup).not.toMatch(/insufficient data to judge|MODELLED|provisional diagnostic|_[a-z]+_/)
    expect(markup).not.toMatch(/\btarget\b|\bscale\b|\bcut\b/i)
  })
})

describe('the audience table', () => {
  const markup = renderToStaticMarkup(
    AudiencePerformanceTable({ audiences: byAudience(ADS), concepts: byConcept(ADS) }),
  )

  it('shows each audience with its grouped economics', () => {
    expect(markup).toContain('$1,066.70')
    expect(markup).toContain('$38.10')
    expect(markup).toContain('$592.50')
    expect(markup).toContain('$197.50')
  })

  it('compares rows to the cheapest row, never to a money target', () => {
    expect(markup).toContain('cheapest')
    expect(markup).not.toMatch(/target|over budget|3\.4×\s*TARGET/i)
  })

  it('marks a group that spent with nothing to show', () => {
    const burning = renderToStaticMarkup(AudiencePerformanceTable({
      audiences: byAudience([{ adName: 'Cold | A | X', status: 'ACTIVE', spend: 300, results: 0, clicks: 10, impressions: 900 }]),
      concepts: [],
    }))
    expect(burning).toContain('no Meta results')
  })

  it('labels legacy names honestly instead of inventing an audience', () => {
    expect(markup).toContain('Unparsed')
    expect(markup).toContain('legacy names, no structure')
  })

  it('says out loud that cost per result is modelled', () => {
    expect(markup).toMatch(/Meta-modelled/)
  })

  /**
   * LIVE vs LIFETIME, which the table could not distinguish.
   *
   * `liveAds`/`liveSpend`/`liveResults` were computed for every group and rendered nowhere — a table
   * headed "Where the money went" could not say where the money is going NOW, which is the only
   * question a budget decision turns on. The owner could see Cold at $278/booking lifetime with no
   * way to tell whether Cold still has ads spending today or was paused three weeks ago.
   */
  describe('live spend, not just lifetime', () => {
    // The two DIFFER on purpose. If live and lifetime were equal, an assertion on the live figure
    // would be satisfied by the lifetime cell and would prove nothing about which one is rendered.
    const MIXED: AdRow[] = [
      { adName: 'Cold | A | X', status: 'PAUSED', spend: 760, results: 6, clicks: 100, impressions: 9000 },
      { adName: 'Cold | B | X', status: 'ACTIVE', spend: 94.35, results: 1, clicks: 20, impressions: 2000 },
    ]
    // `concepts: []` DELIBERATELY. My first version passed `byConcept(MIXED)`, and concept B's
    // LIFETIME spend is also $94.35 — so the live assertion was satisfied by an unrelated row and a
    // mutation swapping `liveSpend` for `spend` in the live column left the test green. The fixture,
    // not the component, was producing the number under test.
    const out = renderToStaticMarkup(
      AudiencePerformanceTable({ audiences: byAudience(MIXED), concepts: [] }),
    )

    it('shows what is spending now beside what was spent in total', () => {
      expect(out).toContain('$94.35')          // live only — appears nowhere else in this render
      expect(out).toContain('$854.35')        // lifetime
      expect(out).toContain('Live spend')
      expect(out).toContain('Live ads')
    })

    it('renders every column header — an empty one silently drops a column', () => {
      // Emptying a header string survived the mutation sweep: the live columns were asserted by name
      // and the rest were not, so a blank header would ship as a column of numbers with nothing
      // saying what they are.
      for (const header of [
        'Audience · concept', 'Live ads', 'Live spend', 'Ads (all time)',
        'Spend (all time)', 'Results', 'Cost / result', 'Link CTR',
      ]) {
        expect(out, header).toContain(header)
      }
    })

    it('says a group is paused rather than printing a live spend of zero', () => {
      // "$0.00 live" reads as "running and wasting nothing". "paused" is the actual state, and it is
      // a different decision.
      const paused = renderToStaticMarkup(AudiencePerformanceTable({
        audiences: byAudience([{ adName: 'Warm | A | X', status: 'PAUSED', spend: 500, results: 4, clicks: 40, impressions: 4000 }]),
        concepts: [],
      }))
      expect(paused).toContain('paused')
      expect(paused).toContain('$500.00')
    })
  })

  it('renders nothing when there is nothing to group', () => {
    expect(renderToStaticMarkup(AudiencePerformanceTable({ audiences: [], concepts: [] }))).toBe('')
  })
})
