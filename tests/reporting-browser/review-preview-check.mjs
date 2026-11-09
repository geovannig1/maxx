// Normal loopback requests and native browser history/printing; no request interception.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'

const expect = playwrightExpect.configure({ timeout: 20_000 })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const full = () => page.getByRole('region', { name: 'Full assessment review', exact: true })
const cards = () => full().locator('article[data-review-id]')
const clear = () => full().getByRole('button', { name: 'Clear assessment filters' }).click()
try {
  await page.goto('http://127.0.0.1:3149/preview?scenario=review', { waitUntil: 'domcontentloaded' })
  const overview = page.getByRole('region', { name: 'What deserves a closer look', exact: true })
  await expect(overview.locator('[data-review-id="performance:adset:set-7"]')).toContainText('explicit zero AppointmentConfirmed')
  await expect(overview.locator('[data-review-id="performance:adset:set-8"]')).toContainText('Observed improvement')
  await expect(overview).toContainText('12.5× to 25×')
  await expect(overview).toContainText('subset of 45 assessments')
  await overview.getByRole('link', { name: 'See all assessments' }).click()
  await expect(full()).toContainText('45 matching of 45 assessments')
  await expect(cards()).toHaveCount(20)
  await expect(full().getByRole('table', { name: 'Review coverage' })).toContainText('Creative')
  const firstPageIds = await cards().evaluateAll(elements => elements.map(element => element.getAttribute('data-review-id')))
  await full().getByRole('button', { name: 'Next assessments' }).click()
  await expect(full()).toContainText('Page 2 of 3')
  await expect(full().getByRole('heading', { name: 'Full assessment review', exact: true })).toBeInViewport()
  await expect(full().getByRole('heading', { name: 'Full assessment review', exact: true })).toBeFocused()
  const secondPageIds = await cards().evaluateAll(elements => elements.map(element => element.getAttribute('data-review-id')))
  assert.equal(firstPageIds.some(id => secondPageIds.includes(id)), false)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(full()).toContainText('Page 2 of 3')
  await full().getByRole('button', { name: 'Next assessments' }).click()
  await expect(cards()).toHaveCount(5)
  const thirdPageIds = await cards().evaluateAll(elements => elements.map(element => element.getAttribute('data-review-id')))
  assert.equal(new Set([...firstPageIds, ...secondPageIds, ...thirdPageIds]).size, 45)
  await full().getByRole('searchbox', { name: 'Search assessments' }).fill('Unmeasured bookings')
  await expect(cards()).toHaveCount(2) // Entity assessment and the source-coverage note both match.
  const unknown = full().locator('[data-review-id="performance:adset:set-10"]')
  await expect(unknown).toContainText('AppointmentConfirmed: unavailable')
  await expect(unknown).not.toContainText('explicit zero AppointmentConfirmed')
  await expect(full().locator('[data-review-id="review.coverage"]')).toBeVisible()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(full().getByRole('searchbox', { name: 'Search assessments' })).toHaveValue('Unmeasured bookings')
  await clear()
  await full().getByRole('combobox', { name: 'Assessment area' }).selectOption('advertising')
  await full().getByRole('combobox', { name: 'Assessment level' }).selectOption('adset')
  await full().getByRole('combobox', { name: 'Assessment focus' }).selectOption('investigate')
  await full().getByRole('searchbox', { name: 'Search assessments' }).fill('Lower-spend exception')
  await expect(cards()).toHaveCount(1)
  await cards().getByRole('link', { name: /Inspect Lower-spend exception/ }).click()
  await expect(page).toHaveURL(/level=ad&adset=set-7&campaign=campaign-2/)
  await expect(page.getByRole('row', { name: /Creative 7/ })).toContainText('$60.00')
  await page.goBack()
  await expect(cards()).toHaveCount(1)
  await expect(full().getByRole('combobox', { name: 'Assessment level' })).toHaveValue('adset')
  await expect(full().getByRole('searchbox', { name: 'Search assessments' })).toHaveValue('Lower-spend exception')
  await clear()
  await full().getByRole('combobox', { name: 'Assessment area' }).selectOption('creative')
  await full().getByRole('combobox', { name: 'Assessment level' }).selectOption('ad')
  await expect(cards()).toHaveCount(10)
  await full().getByRole('searchbox', { name: 'Search assessments' }).fill('not-a-real-execution-control')
  await expect(cards()).toHaveCount(0)
  await expect(full()).toContainText('No assessments match these filters')
  await clear()
  await full().getByRole('button', { name: 'Next assessments' }).click()
  await expect(cards()).toHaveCount(20)
  const printProof = await page.evaluate(() => {
    const result = { before: null, after: null }
    const capture = () => ({ count: document.querySelectorAll('#full-assessments article[data-review-id]').length,
      open: document.querySelectorAll('#full-assessments article[data-review-id] > details[open]').length,
      url: location.href })
    window.addEventListener('beforeprint', () => { result.before = capture() }, { once: true })
    window.addEventListener('afterprint', () => { result.after = capture() }, { once: true })
    window.print()
    return result
  })
  assert.equal(printProof.before?.count, 45, 'native print omitted later assessments')
  assert.equal(printProof.before?.open, 45, 'native print omitted expanded evidence')
  assert.equal(printProof.after?.count, 20, 'print did not restore bounded screen page')
  assert.equal(printProof.after?.url, printProof.before?.url)
  await expect(full()).toContainText('Page 2 of 3')
  await expect(full()).not.toContainText(/refund|cancel|customer returns/i)
  await expect(page.getByRole('region', { name: 'Booking links and tracking', exact: true })).not.toContainText(/refund|cancel|customer returns/i)
  await mkdir('test-results/reporting-preview', { recursive: true })
  await clear()
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    if (width < 1024) {
      await expect(page.locator('#primary-nav')).toBeHidden()
      await expect.poll(() => page.locator('#primary-nav').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0)
    }
    await full().scrollIntoViewIfNeeded()
    await full().getByRole('heading', { name: 'Full assessment review', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px page overflow`)
    const controls = await full().locator('input, select, button').evaluateAll(elements => elements.filter(element => {
      const bounds = element.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0
    }).map(element => { const bounds = element.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom } }))
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j]
      assert.ok(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, `${width}px controls overlap`)
    }
    await page.screenshot({ path: `test-results/reporting-preview/review-${width}.png`, animations: 'disabled' })
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'passed', ordinaryRequests: true, assessments: 45, allPagesReachable: true,
    proactiveLowerSpendImprovementAndProblem: true, nativePrint: printProof, widths: [1440, 390, 320] }))
} finally {
  await browser.close()
}
