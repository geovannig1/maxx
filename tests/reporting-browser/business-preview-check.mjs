// Ordinary browser, synthetic loopback gateway; no interception or connected account calls.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'

const expect = playwrightExpect.configure({ timeout: 20_000 })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const errors = [], sourceResponses = []
page.on('pageerror', error => errors.push(error.message))
page.on('response', response => {
  const url = new URL(response.url())
  if (url.pathname === '/api/reporting') sourceResponses.push({ section: url.searchParams.get('section'), status: response.status() })
})
const services = () => page.locator('#business-types [data-business-service]')
const results = () => page.locator('#business-results')
const fullReview = () => page.getByRole('region', { name: 'Full assessment review', exact: true })
const expectServiceDestination = () => expect.poll(() => {
  const url = new URL(page.url())
  return { path: url.pathname, report: url.searchParams.get('report'), from: url.searchParams.get('from'), to: url.searchParams.get('to'), hash: url.hash }
}).toEqual({ path: '/reports', report: 'business', from: '2026-09-02', to: '2026-09-04', hash: '#business-types' })
function csvRows(text) {
  const rows = [], row = []
  let cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ }
      else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(cell); cell = '' }
    else if ((char === '\r' || char === '\n') && !quoted) {
      row.push(cell); rows.push([...row]); row.length = 0; cell = ''
      if (char === '\r' && text[i + 1] === '\n') i++
    } else cell += char
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const [columns, ...values] = rows
  columns[0] = columns[0].replace(/^\uFEFF/, '')
  return values.map(values => Object.fromEntries(columns.map((column, index) => [column, values[index]])))
}

try {
  await page.goto('http://127.0.0.1:3149/preview?scenario=business', { waitUntil: 'domcontentloaded' })
  await expect(results()).toContainText('$1,800.00')
  await expect(results()).toContainText('Recorded booked hours')
  await expect(results()).toContainText('12 h')
  await expect(results()).toContainText('Duration coverage')
  await expect(results()).toContainText('87.5%')
  await expect(page.getByRole('region', { name: 'Customer history summary', exact: true })).toContainText('active positive-price')
  await expect(page.getByRole('region', { name: 'Booking lead-time summary', exact: true })).toContainText('7.3 days')
  const overview = page.getByRole('region', { name: 'What deserves a closer look', exact: true })
  await expect(overview).toContainText('Observed improvement')
  await expect(overview.locator('[data-review-id^="business_type:"]')).toHaveCount(2)
  await expect(page.getByText('Sample-data preview: fictional metrics, not Example Studio results.')).toBeVisible()
  await page.getByRole('link', { name: 'Explore all services', exact: true }).click()
  await expectServiceDestination()
  await expect(services()).toHaveCount(8)
  const priorOnly = services().filter({ hasText: '08 Prior-only service' })
  await expect(priorOnly).toContainText('Previous: $250.00')
  await expect(priorOnly).toContainText('$0.00')
  await expect(page.locator('#business-customers')).toContainText('2026-01-01')
  await expect(page.locator('#business-customers')).toContainText('Customer-group recorded hours and duration coverage')
  await expect(page.locator('#business-customers')).toContainText('Bookings with recorded duration')
  await expect(page.locator('#business-customers')).toContainText('66.7%')
  await expect(page.locator('#business-upcoming')).toContainText('2026-09-06 – 2026-10-03')
  await expect(page.locator('#business-upcoming')).toContainText('Future recorded service')
  await expect(page.locator('#business-upcoming')).toContainText('$2,500.00')
  const search = page.getByRole('searchbox', { name: 'Search services', exact: true })
  await search.fill('seventh')
  await expect(services()).toHaveCount(1)
  await expect(results()).toContainText('$1,800.00')
  await expect(page).toHaveURL(/business_q=seventh/)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(search).toHaveValue('seventh')
  await expect(services()).toHaveCount(1)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export full business report', exact: true }).click()
  const artifact = await download
  const exported = csvRows(await readFile(await artifact.path(), 'utf8'))
  assert.equal(exported.filter(row => row.entity.startsWith('Acuity appointment type') && row.metric === 'Amount paid').length, 8)
  assert.equal(exported.find(row => row.entity.includes('08 Prior-only service') && row.metric === 'Amount paid').previous_value, '250')
  assert.equal(exported.find(row => row.entity === 'Acuity business results' && row.metric === 'Amount paid').coverage, 'partial')
  assert.equal(exported.find(row => row.entity === 'Acuity business results' && row.metric === 'Amount paid').previous_coverage, 'complete')
  const hours = exported.find(row => row.entity === 'Acuity business results' && row.metric === 'Recorded booked hours')
  assert.equal(hours.value, '12')
  assert.equal(hours.previous_value, '20')
  assert.equal(hours.coverage, 'partial')
  assert.equal(hours.previous_coverage, 'complete')
  assert.ok(exported.some(row => row.date_basis === 'service_date_et' && row.from === '2026-09-06' && row.to === '2026-10-03'))
  assert.ok(exported.filter(row => row.date_basis === 'service_date_et').every(row => row.previous_value === '' && row.comparison_from === '' && row.comparison_to === ''))
  assert.ok(!JSON.stringify(exported).includes('@example.test'))
  assert.ok(!exported.some(row => /cancel|refund|return/i.test(row.metric)))
  await search.fill('not-a-real-service')
  await expect(services()).toHaveCount(0)
  await expect(page.locator('#business-types')).toContainText('No services match')
  await expect(results()).toContainText('$1,800.00')
  await page.getByRole('button', { name: 'Clear service search', exact: true }).click()
  await expect(services()).toHaveCount(8)
  await mkdir('test-results/reporting-preview', { recursive: true })
  await page.screenshot({ path: 'test-results/reporting-preview/business-detail-1440.png', fullPage: true })
  await page.emulateMedia({ media: 'print' })
  await expect(services()).toHaveCount(8)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.pdf({ path: 'test-results/reporting-preview/business-detail.pdf', format: 'A4', printBackground: true })
  await page.emulateMedia({ media: 'screen' })
  await page.goBack()
  await expect(page).toHaveURL(/dashboard/)
  await expect(results()).toContainText('$1,800.00')
  await overview.getByRole('link', { name: 'See all assessments', exact: true }).click()
  await fullReview().getByRole('searchbox', { name: 'Search assessments' }).fill('08 Prior-only service')
  const assessment = fullReview().locator('[data-review-id="business_type:08%20Prior-only%20service"]')
  await expect(assessment).toContainText('decrease')
  await assessment.getByRole('link').click()
  await expectServiceDestination()
  await expect(services()).toHaveCount(8)
  await page.goBack()
  await expect(fullReview().getByRole('searchbox', { name: 'Search assessments' })).toHaveValue('08 Prior-only service')
  for (const width of [390, 320]) {
    await page.goto('http://127.0.0.1:3149/reports?from=2026-09-02&to=2026-09-04&report=business', { waitUntil: 'domcontentloaded' })
    await page.setViewportSize({ width, height: 844 })
    await expect(services()).toHaveCount(8)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const tableRegion = page.locator('#business-types [role="region"]').first()
    await tableRegion.evaluate(element => { element.scrollLeft = element.scrollWidth })
    assert.ok(await tableRegion.evaluate(element => element.scrollLeft > 0))
    await page.screenshot({ path: `test-results/reporting-preview/business-detail-${width}.png`, fullPage: true })
  }
  assert.deepEqual(errors, [])
  assert.ok(sourceResponses.some(response => response.section === 'business' && response.status === 200))
  console.log(`Business ordinary browser: 8 services incl prior-only/seventh, recorded hours with independent current/prior duration coverage, default positive/negative review, separate customer/lead/future scopes, ${exported.length} qualified export rows, search/reload/Back, print and desktop/390/320px layouts passed.`)
} finally {
  console.log(JSON.stringify({ sourceResponses, browserErrors: errors }))
  await browser.close()
}
