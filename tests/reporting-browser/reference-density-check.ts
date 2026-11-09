import assert from 'node:assert/strict'
import { expect as playwrightExpect, type BrowserContext } from '@playwright/test'
import type { ReportingData, ReportMetricMap } from '../../src/lib/reporting/contracts'

const expect = playwrightExpect.configure({ timeout: 30000 })
const evidence = 'Fictional clones for pagination and search only; repeated metrics do not represent a real or reconciled account population.'

function rebindAdMetrics(metrics: ReportMetricMap, id: string): ReportMetricMap {
  const entity = { level: 'ad' as const, id }
  const claims = Object.values(metrics).flatMap(metric => [metric.current, ...(metric.previous ? [metric.previous] : [])])
  const identities = new Map(claims.map(claim => [claim.claimId,
    `report:meta:ad:${id}:${claim.metricKey.slice('meta.'.length)}:${claim.window.start}:${claim.window.end}`]))
  const rebind = (claim: typeof claims[number]) => ({ ...claim, entity, claimId: identities.get(claim.claimId)!,
    inputClaimIds: claim.inputClaimIds.map(input => identities.get(input) ?? input) })
  return Object.fromEntries(Object.entries(metrics).map(([key, metric]) => [key, { ...metric,
    current: rebind(metric.current), previous: metric.previous ? rebind(metric.previous) : null }]))
}

export function referenceDensityFixture(base: ReportingData): ReportingData {
  const meta = base.meta.data
  assert.ok(meta)
  const source = meta.entities.find(entity => entity.level === 'ad')
  assert.ok(source)
  const ads = Array.from({ length: 53 }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, '0'), id = `530${ordinal}`
    return { ...source, id, name: `Synthetic density ad ${ordinal}`, metrics: rebindAdMetrics(source.metrics, id),
      series: [], comparisonSeries: [], breakdowns: [] }
  })
  return { ...base, meta: { ...base.meta, notes: [...base.meta.notes, evidence], data: { ...meta,
    entities: [...meta.entities.filter(entity => entity.level !== 'ad'), ...ads],
    creativeAssignmentEvidence: undefined, sourceDescription: evidence } } }
}

export async function verifyReferenceCreativeDensity(context: BrowserContext, base: ReportingData, scenarioUrl: string,
  pageError: (message: string) => void) {
  const fixture = referenceDensityFixture(base)
  const suppliedIds = fixture.meta.data!.entities.filter(entity => entity.level === 'ad').map(entity => `overview-creative-${entity.id}`)
  const page = await context.newPage()
  page.on('pageerror', error => pageError(error.message))
  try {
    await page.route('**/api/reporting?**', route => new URL(route.request().url()).searchParams.get('section') === 'meta'
      ? route.fulfill({ json: { section: 'meta', context: fixture.context, result: fixture.meta, notes: [evidence] } })
      : route.fallback())
    await page.goto(scenarioUrl, { waitUntil: 'domcontentloaded' })
    const creative = page.getByRole('region', { name: 'Creative comparison' })
    const rows = creative.locator('tr[id^="overview-creative-"]')
    const next = creative.getByRole('button', { name: 'Next creative page', exact: true })
    await expect(page.getByLabel('Creative page size')).toHaveValue('25')
    const pages: string[][] = []
    for (const size of [25, 25, 3]) {
      if (pages.length) await next.click()
      await expect(rows).toHaveCount(size)
      pages.push(await rows.evaluateAll(elements => elements.map(element => element.id)))
    }
    await expect(next).toBeDisabled()
    const visited = pages.flat()
    assert.equal(visited.length, 53)
    assert.equal(new Set(visited).size, 53, 'The default pages must not repeat an ad')
    assert.deepEqual(new Set(visited), new Set(suppliedIds))
    assert.ok(pages[2].includes('overview-creative-53053'), 'Ad 53 must be reachable on the last default page')
    const search = creative.getByRole('searchbox', { name: 'Search creative', exact: true })
    await search.fill('Synthetic density ad 999')
    await expect(rows).toHaveCount(0)
    await expect(creative.getByText('No supplied ads match this search.', { exact: true })).toBeVisible()
    await search.fill('Synthetic density ad 53')
    await expect(rows).toHaveCount(1)
    const lowerAd = creative.locator('#overview-creative-53053')
    await expect(lowerAd).toContainText('Synthetic density ad 53')
    await lowerAd.focus()
    await expect(lowerAd).toBeFocused()
    return { synthetic: true, evidence, supplied: 53, suppliedIds, defaultChoice: 25,
      pages, pageSizes: pages.map(ids => ids.length), disjoint: true, complete: true,
      searchRejectedMissingAd: true, searched: 'Synthetic density ad 53', focused: await lowerAd.getAttribute('id') }
  } finally { await page.close() }
}
