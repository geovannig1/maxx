// Ordinary loopback preview: real navigation and downloads, no browser request interception.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'

const expect = playwrightExpect.configure({ timeout: 20_000 })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
const requests = []
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => {
  if (request.url().includes('/api/reporting?')) requests.push({ url: request.url(), started: Date.now(), request })
})
page.on('requestfinished', request => {
  const item = requests.find(item => item.request === request)
  if (item) item.finished = Date.now()
})
page.on('requestfailed', request => {
  const item = requests.find(item => item.request === request)
  if (item) { item.failure = request.failure()?.errorText; item.failedAt = Date.now() }
})
const section = () => page.getByRole('region', { name: 'Campaign and ad-set performance', exact: true })
const matrix = () => section().getByRole('region', { name: 'Entity metrics, scroll for more columns' })
const folder = 'test-results/reporting-preview'
try {
  await page.goto('http://127.0.0.1:3149/preview?scenario=executive', { waitUntil: 'domcontentloaded' })
  await expect(section()).toContainText('10 of 10 ad sets')
  await expect(matrix().getByRole('row')).toHaveCount(11)
  await expect(page.getByRole('region', { name: 'Advertising results', exact: true })).toContainText('$2,200.00')
  await expect(matrix().getByRole('row', { name: /Audience 8/ })).toContainText('25.00×')
  await expect(matrix().getByRole('row', { name: /Unmeasured bookings/ })).toContainText('Unavailable')
  await expect(section().getByRole('button', { name: 'Spend, no reported bookings (1)' })).toBeVisible()
  await section().getByRole('button', { name: 'Spend, no reported bookings (1)' }).click()
  await expect(section()).toContainText('1 of 10 ad sets')
  await expect(matrix()).toContainText('Lower-spend exception')
  await expect(matrix()).not.toContainText('Unmeasured bookings')
  await expect(section()).toContainText('1 of 10 ad sets')
  await section().getByRole('button', { name: 'Clear filters' }).click()
  await section().getByRole('button', { name: 'Campaigns (3)', exact: true }).click()
  await expect(section()).toContainText('3 of 3 campaigns')
  await section().getByRole('button', { name: 'Ad sets (10)', exact: true }).click()
  await section().getByRole('checkbox', { name: 'Compare Audience 1', exact: true }).check()
  await section().getByRole('checkbox', { name: 'Compare Audience 8', exact: true }).check()
  await section().getByRole('link', { name: 'Compare selected ad sets' }).click()
  await expect(page).toHaveURL(/view=compare/)
  await expect(page.getByRole('region', { name: 'Side-by-side comparison', exact: true })).toContainText('AppointmentConfirmed ROAS')
  await page.goBack()
  await section().getByRole('button', { name: 'Clicks', exact: true }).click()
  await section().getByRole('searchbox', { name: 'Search ad sets' }).fill('Unmeasured')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(section()).toContainText('1 of 10 ad sets')
  await expect(section().getByRole('button', { name: 'Clicks', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const downloaded = page.waitForEvent('download')
  await section().getByRole('button', { name: 'Export table' }).click()
  const download = await downloaded
  const csv = await readFile(await download.path(), 'utf8')
  assert.match(csv, /Unmeasured bookings/)
  assert.match(csv, /Outbound CTR/)
  assert.doesNotMatch(csv, /Lower-spend exception/)
  assert.match(csv, /2026-09-02/)
  await section().getByRole('button', { name: 'Clear filters' }).click()
  await section().getByRole('button', { name: 'Results', exact: true }).click()
  await mkdir(folder, { recursive: true })
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    await section().scrollIntoViewIfNeeded()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px page overflow`)
    await expect(matrix().getByRole('row')).toHaveCount(11)
    const searchBounds = await section().getByRole('searchbox', { name: 'Search ad sets' }).boundingBox()
    const filterBounds = await section().getByRole('button', { name: 'Spend, no reported bookings (1)' }).boundingBox()
    assert.ok(searchBounds && filterBounds && (searchBounds.x + searchBounds.width <= filterBounds.x
      || searchBounds.y + searchBounds.height <= filterBounds.y), `${width}px search and filter overlap`)
    await matrix().evaluate(element => { element.scrollTop = element.scrollHeight; element.scrollLeft = element.scrollWidth })
    assert.ok(await matrix().evaluate(element => element.scrollLeft > 0 && element.scrollTop > 0))
    await matrix().evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0 })
    await page.screenshot({ path: `${folder}/executive-${width}.png` })
  }
  assert.deepEqual(errors, [])
  console.log('Executive workflow passed: 10 ad sets, 3 campaigns, lower-spend exception, unknown counterexample, pair comparison, URL reload, scoped CSV, and 1440/390/320px contained scrolling.')
} finally {
  console.log(JSON.stringify({ browserErrors: errors, reportingRequests: requests.map(item => ({ url: item.url,
    elapsedMs: (item.finished ?? item.failedAt ?? Date.now()) - item.started, finished: Boolean(item.finished), failure: item.failure })) }))
  await browser.close()
}
