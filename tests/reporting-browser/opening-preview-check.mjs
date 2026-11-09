// Ordinary loopback sample preview: real page layout and controls, no request interception.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'

const expect = playwrightExpect.configure({ timeout: 20_000 })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const network = await page.context().newCDPSession(page)
await network.send('Network.enable')
await network.send('Network.setCacheDisabled', { cacheDisabled: true })
const errors = []
const failures = []
const measurements = []
page.on('pageerror', error => errors.push(error.message))
const dateButtons = () => page.getByTitle('Change the date range (applies across pages)').filter({ visible: true })

try {
  await page.goto('http://127.0.0.1:3149/preview', { waitUntil: 'domcontentloaded' })
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const advertising = page.getByRole('region', { name: 'Advertising results' })
    await expect(advertising).toContainText('$120.00')
    await expect(page.getByText('Sample-data preview: fictional metrics, not Example Studio results.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Refresh GA4 website' })).toBeEnabled()
    const spend = await advertising.getByText('$120.00', { exact: true }).first().boundingBox()
    const dateCount = await dateButtons().count()
    measurements.push({ viewport, spend, dateCount })
    if (dateCount !== 1) failures.push(`${viewport.width}px: ${dateCount} visible date controls`)
    if (!spend || spend.y < 0 || spend.y + spend.height > viewport.height) failures.push(`${viewport.width}px: first result below opening viewport`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  console.log(JSON.stringify({ measurements, failures }))
  assert.deepEqual(failures, [])

  // The single mobile control must actually change the source window and restore it through Back.
  await dateButtons().focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Date range' })
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320)
  await page.getByLabel('From date').fill('2026-09-01')
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/from=2026-09-01/)
  await expect(page.getByRole('region', { name: 'Advertising results' })).toContainText('$240.00')
  await page.goBack()
  await expect(page.getByRole('region', { name: 'Advertising results' })).toContainText('$120.00')

  // Primary destinations retain date access after direct navigation and a cache-bypassing reload.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const route of ['dashboard', 'performance', 'creative', 'reports']) {
      await page.goto(`http://127.0.0.1:3149/${route}?from=2026-09-02&to=2026-09-04`, { waitUntil: 'domcontentloaded' })
      await expect(dateButtons()).toHaveCount(1)
      if (route === 'creative') await expect(page.getByRole('checkbox', { name: 'Compare Studio walkthrough' })).toBeVisible()
      else if (route === 'performance') await expect(page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Compare Studio walkthrough' }) })).toContainText('$80.00')
      else await expect(page.getByRole('region', { name: 'Advertising results' })).toContainText('$120.00')
      const bounds = await dateButtons().boundingBox()
      assert.ok(bounds && bounds.height >= 44 && bounds.width >= 44)
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('http://127.0.0.1:3149/preview', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('region', { name: 'Advertising results' })).toContainText('$120.00')
  await mkdir('test-results/reporting-preview', { recursive: true })
  await page.screenshot({ path: 'test-results/reporting-preview/opening-mobile.png' })
  await page.emulateMedia({ media: 'print' })
  await expect(dateButtons()).toHaveCount(0)
  await expect(page.getByText('Compared with 2026-08-30 – 2026-09-01')).toBeVisible()
  await expect(page.getByText('Evidence as of 2026-09-05T17:00:00Z').first()).toBeVisible()
  assert.deepEqual(errors, [])
  console.log('Opening preview passed: visible results, one usable date control, keyboard dates/Back, four primary destinations, print context and source evidence.')
} finally {
  console.log(JSON.stringify({ browserErrors: errors }))
  await browser.close()
}
