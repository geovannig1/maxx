// Run against the explicitly synthetic loopback preview; no request interception.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'

const origin = 'http://127.0.0.1:3149'
// Cold route compilation exceeded Playwright's default five seconds in the
// captured server log. Use the same finite budget as the initial-page check.
const expect = playwrightExpect.configure({ timeout: 20_000 })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
const sourceResponses = []
page.on('pageerror', error => errors.push(error.message))
page.on('response', response => {
  const url = new URL(response.url())
  if (url.pathname === '/api/reporting') sourceResponses.push({ section: url.searchParams.get('section'), status: response.status() })
})

try {
  assert.equal((await fetch(`${origin}/api/sync`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${origin}/dashboard`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${origin}/api/health`)).status, 501)
  assert.equal((await fetch(`${origin}/api/reporting?section=unknown`)).status, 400)
  assert.equal((await fetch(`${origin}/api/reporting?section=meta&from=invalid&to=2026-09-04`)).status, 400)
  await page.goto(`${origin}/preview`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('region', { name: 'Business results', exact: true })).toContainText('$500.00', { timeout: 20_000 })
  await expect(page.getByRole('region', { name: 'Advertising results', exact: true })).toContainText('$120.00')
  await expect(page.getByRole('region', { name: 'Website response', exact: true })).toContainText('200')
  await expect(page.getByText('Sample-data preview: fictional metrics, not Example Studio results.')).toBeVisible()
  await expect.poll(() => [...new Set(sourceResponses.filter(response => response.status === 200).map(response => response.section))].sort())
    .toEqual(['business', 'measurement', 'meta', 'website'])
  const review = page.getByRole('region', { name: 'What deserves a closer look' })
  // Preserved native definitions make both per-ad response observations eligible in this fixture.
  await expect(review.getByText('Why it matters', { exact: true })).toHaveCount(8)
  await expect(review.locator('[data-review-id="creative_response:ad-2"]')).toHaveCount(1)
  await expect(review.locator('[data-review-id="creative_response:ad-2"]')).toContainText('Observed improvement')
  await expect(review.locator('[data-review-id="performance:campaign:campaign-1"]')).toContainText('Observed improvement')
  await review.getByText('Read full observation', { exact: true }).first().click()
  await expect(review.getByText('What could change this interpretation', { exact: true }).first()).toBeVisible()
  await expect(review.locator('[data-evidence-population]').first()).toBeVisible()
  await review.locator('a[href*="report=website"]').first().click()
  await expect(page).toHaveURL(/report=website/)
  await expect(page.locator('#website-pages')).toContainText('mobile')
  await expect(page.locator('#website-pages')).toContainText('desktop')
  await expect(page.locator('#website-pages')).toContainText('120')
  await page.goBack()
  await expect(review).toBeVisible()
  await review.getByRole('link', { name: 'See all assessments' }).click()
  const everyCheck = page.getByRole('region', { name: 'Full assessment review' })
  // Native composition, booked-value drivers and both ad-response reviews supplement the original 26 assessments.
  await expect(everyCheck.getByRole('status')).toContainText('33 matching of 33 assessments')
  await expect(everyCheck.locator('article[data-review-id]')).toHaveCount(20)
  const firstPageIds = await everyCheck.locator('article[data-review-id]').evaluateAll(nodes => nodes.map(node => node.dataset.reviewId))
  const attentionId = 'creative_attention:ad-1'
  const attentionHeading = everyCheck.locator(`[data-review-id="${attentionId}"]`).getByRole('heading', { name: /Video attention and response:/ })
  if (firstPageIds.includes(attentionId)) await expect(attentionHeading).toBeVisible()
  await everyCheck.getByRole('button', { name: 'Next assessments', exact: true }).click()
  await expect(everyCheck.locator('article[data-review-id]')).toHaveCount(13)
  const secondPageIds = await everyCheck.locator('article[data-review-id]').evaluateAll(nodes => nodes.map(node => node.dataset.reviewId))
  assert.equal([...firstPageIds, ...secondPageIds].filter(id => id === 'business_booked_value_drivers').length, 1, 'Booked-value explanation appears exactly once across assessment pages')
  for (const ad of ['ad-1', 'ad-2']) assert.equal([...firstPageIds, ...secondPageIds].filter(id => id === `creative_response:${ad}`).length, 1, `Response review for ${ad} appears exactly once across assessment pages`)
  assert.ok([...firstPageIds, ...secondPageIds].includes(attentionId), 'Creative attention remains available across assessment pages')
  if (!firstPageIds.includes(attentionId)) await expect(attentionHeading).toBeVisible()
  for (const entity of ['campaign:campaign-1', 'adset:set-1', 'ad:ad-1', 'ad:ad-2']) {
    assert.ok([...firstPageIds, ...secondPageIds].includes(`advertising.attribution:${entity}`), `Missing native composition detail for ${entity}`)
  }
  await everyCheck.getByRole('button', { name: 'Previous assessments', exact: true }).click()
  // Pagination uses ordinary history, so restore the overview explicitly before its route checks.
  await page.goto(`${origin}/dashboard?from=2026-09-02&to=2026-09-04`)
  await expect(review).toBeVisible()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('region', { name: 'Advertising results', exact: true })).toContainText('$120.00', { timeout: 20_000 })
  await page.getByRole('link', { name: 'Creative', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Compare Studio walkthrough' })).toBeVisible()
  await expect(page).toHaveURL(/from=2026-09-02/)
  await page.goBack()
  await expect(page.getByRole('region', { name: 'Business results', exact: true })).toContainText('$500.00')
  await expect(page.getByRole('region', { name: 'Website response', exact: true })).toContainText('200')
  await mkdir('test-results/reporting-preview', { recursive: true })
  await page.screenshot({ path: 'test-results/reporting-preview/ordinary-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('region', { name: 'Business results', exact: true })).toContainText('$500.00')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/reporting-preview/ordinary-mobile.png', fullPage: true })
  assert.deepEqual(errors, [])
  console.log('Ordinary preview: usable website data, complete prepared assessments, actual inspection targets, four source responses, reload, navigation/Back, desktop/mobile passed with sample data.')
} finally {
  console.log(JSON.stringify({ sourceResponses, browserErrors: errors }))
  await browser.close()
}
