import './_support/outcome-noun-booking'
import { withBookingNouns } from './_support/booking-noun-source'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const files = [
  'src/lib/report/prompt-builder.ts',
  'src/lib/report/weekly.ts',
  'src/app/report/client/page.tsx',
  'src/app/(dashboard)/reports/[date]/page.tsx',
  'src/components/dashboard/KpiGrid.tsx',
  'src/components/dashboard/CampaignRoasPanel.tsx',
  'src/components/dashboard/AccountVerdict.tsx',
  'src/components/dashboard/EconomicsCard.tsx',
  'src/app/(dashboard)/dashboard/page.tsx',
]

describe('active-appointment amount_paid display contract', () => {
  it('never labels the active-only sum real or exact revenue', () => {
    const offenders = files.flatMap((file) => readFileSync(file, 'utf8').split('\n')
      .filter((line) => /real revenue|exact checkout revenue|net paid revenue/i.test(line))
      .map((line) => `${file}: ${line.trim()}`))
    expect(offenders).toEqual([])
  })

  it('names the active-only numerator without surfacing excluded exception topics', () => {
    const copy = files.map((file) => withBookingNouns(readFileSync(file, 'utf8'))).join('\n')
    expect(copy).toMatch(/amount paid on active bookings/i)
    expect(copy).not.toMatch(/canceled[^.\n]*refund|refund[^.\n]*canceled/i)
  })

  it('uses exact Meta result and unavailable ROAS labels on report surfaces', () => {
    const reportSurfaces = [
      'src/app/(dashboard)/reports/[date]/page.tsx',
      'src/components/dashboard/CampaignRoasPanel.tsx',
    ]
    const sources = reportSurfaces.map((file) => [file, readFileSync(file, 'utf8')] as const)

    for (const [file, source] of sources) {
      expect(source, file).toContain('Meta Results (modelled 7dc/1dv)')
    }
    expect(sources.map(([, source]) => source).join('\n')).toContain('Meta cost / Result')
    expect(readFileSync('src/components/dashboard/CampaignRoasPanel.tsx', 'utf8')).toContain('Exact Meta paid ROAS — unavailable')
    const offenders = sources.flatMap(([file, source]) => source.split('\n')
      .filter((line) =>
        /Bookings · Meta(?:\s*\(est\.\)|\s*est\.?)/.test(line)
        || /label="Meta paid ROAS"/.test(line)
        || />\s*Meta paid ROAS\s*</.test(line)
        || /<th[^>]*>\s*Meta ROAS\s*<\/th>/.test(line)
        || /spend, bookings, and revenue/i.test(line)
      )
      .map((line) => `${file}: ${line.trim()}`))
    expect(offenders).toEqual([])
  })
})
