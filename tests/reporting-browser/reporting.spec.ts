import { test, expect, type Page } from '@playwright/test'
import { fixtureCookie } from './auth-fixture.mjs'
import { fixturePacket } from '../../scripts/demo/sample/reports'
import { openReportingTrust, sourceRow } from './source-strip'

async function sources(page: Page, options: { websiteFailed?: boolean; delayOld?: boolean } = {}) {
  await page.route('**/api/**', async route => {
    const request = route.request()
    if (request.method() !== 'GET') throw new Error('Browser reporting tests must not issue writes')
    const url = new URL(request.url())
    if (url.pathname === '/api/reporting') {
      const section = url.searchParams.get('section') ?? 'meta'
      if (options.websiteFailed && section === 'website' && !url.searchParams.has('refresh')) {
        await route.fulfill({ status: 503, json: { error: 'Fixture source unavailable' } }); return
      }
      const from = url.searchParams.get('from') ?? '2026-09-02'
      if (options.delayOld && from === '2026-09-02') await new Promise(resolve => setTimeout(resolve, 1000))
      await route.fulfill({ json: fixturePacket(section, from, url.searchParams.get('to') ?? '2026-09-04') })
    } else await route.fulfill({ json: url.pathname === '/api/sync' ? { status: 'synced', lastSync: '2026-09-05T17:00:00Z', dataThrough: '2026-09-04' } : {} })
  })
  await page.route('https://example.test/**', route => route.fulfill({ status: 404, body: 'Test unavailable asset' }))
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'sb-127-auth-token', value: fixtureCookie, domain: '127.0.0.1', path: '/', httpOnly: false, sameSite: 'Lax' }])
})

test('the real proxy rejects an absent session while the local test session opens reporting', async ({ browser, page }) => {
  const unauthenticated = await browser.newContext()
  const denied = await unauthenticated.newPage()
  await denied.goto('http://127.0.0.1:3147/dashboard')
  await expect(denied).toHaveURL(/\/login\?next=/)
  await unauthenticated.close()
  await sources(page)
  await page.goto('/dashboard?from=2026-09-02&to=2026-09-04')
  await expect(page.getByRole('heading', { name: 'Advertising results' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Business results' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Traffic source' })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/reporting-browser/overview-desktop.png', fullPage: true })
  // The overview's findings disclosure is now "Why this read →" in the Executive interpretation
  // (full assessments moved to /reports?report=results). Collapsed by default; opening it shows the
  // selected period's day-level evidence; closing hides it again.
  const reading = page.getByRole('region', { name: 'Executive interpretation' })
  await reading.scrollIntoViewIfNeeded()
  const why = reading.getByText('Why this read →')
  const periodEvidence = reading.getByText('2026-09-02 supplied $500.00 of $500.00 booked value (100%), with 5 of 5 paid outcomes.')
  await expect(why).toBeVisible()
  await expect(periodEvidence).toBeHidden()
  await why.click()
  await expect(periodEvidence).toBeVisible()
  await expect(reading.getByText('The other 2 dates contributed $0.00 from 0 paid outcomes', { exact: false })).toBeVisible()
  await why.click()
  await expect(periodEvidence).toBeHidden()
  await page.screenshot({ path: 'test-results/reporting-browser/overview-findings-desktop.png', fullPage: true })
})

test('a failed website source does not hide results and can be retried independently', async ({ page }) => {
  await sources(page, { websiteFailed: true })
  await page.goto('/dashboard?from=2026-09-02&to=2026-09-04')
  await expect(page.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
  await openReportingTrust(page)
  const website = sourceRow(page, 'GA4 website')
  await expect(website).toContainText('Unavailable')
  // GA4 metrics now render in the overview's "After the click" region (Website behavior).
  const sessions = page.getByRole('region', { name: 'After the click' }).getByText('Sessions', { exact: true }).locator('xpath=..')
  await expect(sessions).toBeVisible()
  await expect(sessions).not.toContainText('200')
  await page.getByRole('button', { name: 'Refresh GA4 website' }).click()
  await expect(website).toContainText('Available')
  await expect(sessions).toContainText('200')
})

test('ads filter, detail, Back and two-asset comparison preserve dates and export evidence', async ({ page }) => {
  await sources(page)
  await page.goto('/performance?from=2026-09-02&to=2026-09-04&level=ad')
  await expect(page.getByRole('heading', { name: 'Ad investigation' })).toBeVisible()
  const search = page.getByRole('searchbox')
  await search.fill('walkthrough')
  await expect(page.getByRole('link', { name: /Portrait still/ })).toHaveCount(0)
  await page.getByRole('link', { name: /Studio walkthrough/ }).click()
  await expect(page.getByRole('heading', { name: 'Studio walkthrough', exact: true })).toBeVisible()
  await page.goBack()
  await expect(search).toHaveValue('walkthrough')
  await search.fill('')
  const checks = page.getByRole('checkbox')
  // Selection lives in the URL (?compare=), so the checked state settles one render after the click;
  // check() verifies synchronously and sees the pre-navigation state.
  await checks.nth(0).click()
  await expect(checks.nth(0)).toBeChecked()
  await checks.nth(1).click()
  await expect(checks.nth(1)).toBeChecked()
  await page.getByRole('link', { name: 'Compare selected' }).click()
  await expect(page.getByRole('heading', { name: 'Side-by-side comparison' })).toBeVisible()
  await expect(page).toHaveURL(/from=2026-09-02/)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: /Export/ }).click()
  const file = await download
  expect(file.suggestedFilename()).toContain('comparison')
  const stream = await file.createReadStream()
  const chunks = []
  for await (const chunk of stream!) chunks.push(chunk)
  const csv = Buffer.concat(chunks).toString('utf8')
  expect(csv).toContain('act_123')
  expect(csv).toContain('date_basis')
  expect(csv).toContain('attribution_scope')
  expect(csv).toContain('2026-09-02')
})

test('report presets and printing work on mobile without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await sources(page)
  await page.goto('/reports?from=2026-09-02&to=2026-09-04&report=website')
  await expect(page.getByRole('tab', { name: /Website journey/ })).toHaveAttribute('aria-selected', 'true')
  // The region is named through the configurable outcome noun (P5d); 'Booking' became 'Outcome'.
  await expect(page.getByRole('region', { name: 'Outcome links and tracking' })).toContainText('Synthetic observed lower bound')
  await page.getByRole('tab', { name: /Creative/ }).click()
  await expect(page).toHaveURL(/report=creative/)
  await page.goBack()
  await expect(page.getByRole('tab', { name: /Website journey/ })).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.evaluate(() => { window.print = () => { document.body.dataset.printed = 'yes' } })
  await page.getByRole('button', { name: 'Print report' }).click()
  await expect(page.locator('body')).toHaveAttribute('data-printed', 'yes')
  await page.screenshot({ path: 'test-results/reporting-browser/reports-mobile.png', fullPage: true })
  await page.emulateMedia({ media: 'print' })
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)')
  await expect(page.getByRole('complementary', { name: 'Primary navigation' })).not.toBeVisible()
  await expect(page.getByText('Evidence as of 2026-09-05T17:00:00Z').first()).toBeVisible()
  // Landing pages are now row headers of the landing-page table.
  const pageCells = page.getByRole('rowheader', { name: '/studio-rentals', exact: true })
  await expect(pageCells).toHaveCount(2)
  await expect(pageCells.nth(0)).toBeVisible()
  await expect(pageCells.nth(1)).toBeVisible()
  expect(await page.locator('#main-content').evaluate(element => getComputedStyle(element).overflowY)).toBe('visible')
  await page.pdf({ path: 'test-results/reporting-browser/website-report.pdf', format: 'A4', printBackground: true })
})

test('date changes reject old in-flight source responses and Back restores the earlier range', async ({ page }) => {
  await sources(page, { delayOld: true })
  const started = page.waitForRequest(request => request.url().includes('/api/reporting?'))
  await page.goto('/dashboard?from=2026-09-02&to=2026-09-04')
  await started
  await page.getByTitle('Change the date range (applies across pages)').last().click()
  await page.getByLabel('From date').fill('2026-09-01')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name: 'Advertising results' })).toContainText('$240.00')
  await page.goBack()
  await expect(page.getByRole('region', { name: 'Advertising results' })).toContainText('$120.00')
  await expect(page).toHaveURL(/from=2026-09-02/)
})

test('mobile creative comparison, evidence and date controls stay reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await sources(page)
  await page.goto('/creative?from=2026-09-02&to=2026-09-04')
  // Selection lives in the URL (?compare=); assert the settled state rather than check()'s synchronous one.
  await page.getByRole('checkbox', { name: 'Compare Studio walkthrough' }).click()
  await expect(page.getByRole('checkbox', { name: 'Compare Studio walkthrough' })).toBeChecked()
  await page.getByRole('checkbox', { name: 'Compare Portrait still' }).click()
  await expect(page.getByRole('checkbox', { name: 'Compare Portrait still' })).toBeChecked()
  await page.getByRole('link', { name: 'Compare selected' }).click()
  await expect(page.getByRole('heading', { name: 'Side-by-side comparison' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByLabel(/Definition and source for spend/i).first().click()
  await expect(page.getByText('Meta spend; omitted fields remain unavailable.').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('checkbox', { name: 'Compare Studio walkthrough' })).toBeVisible()
  await page.getByTitle('Change the date range (applies across pages)').last().click()
  await expect(page.getByRole('dialog', { name: 'Date range' })).toBeVisible()
  const bounds = await page.getByRole('dialog', { name: 'Date range' }).boundingBox()
  expect(bounds?.x).toBeGreaterThanOrEqual(0)
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 320, height: 844 })
  const narrowBounds = await page.getByRole('dialog', { name: 'Date range' }).boundingBox()
  expect(narrowBounds?.x).toBeGreaterThanOrEqual(0)
  expect((narrowBounds?.x ?? 0) + (narrowBounds?.width ?? 0)).toBeLessThanOrEqual(320)
  expect(await page.getByRole('dialog', { name: 'Date range' }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.getByLabel('From date').fill('2026-09-01')
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/from=2026-09-01/)
})
