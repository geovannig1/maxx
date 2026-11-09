// Approved executive dashboard: ordinary local sample requests, original test media, no live sources.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { startCreativeMediaFixture } from './creative-media-fixture.mjs'

const expect = playwrightExpect.configure({ timeout: 30000 })
const base = 'http://127.0.0.1:3149'
const output = await mkdtemp(join(tmpdir(), 'maxx-dashboard-preview-'))
const media = await startCreativeMediaFixture(base)
const browser = await chromium.launch({ headless: true, proxy: { server: media.proxy }, args: ['--proxy-bypass-list=<-loopback>'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
const page = await context.newPage(), errors = [], proof = { synthetic: true, viewports: [], startedAt: new Date().toISOString() }
let metaGate = null
page.on('pageerror', error => errors.push(error.message))
await page.route('**/api/reporting?**', async route => {
  const gate = metaGate
  if (gate && new URL(route.request().url()).searchParams.get('section') === 'meta') {
    gate.seen = true
    await gate.promise
  }
  await route.continue()
})
page.setDefaultTimeout(30000)
page.setDefaultNavigationTimeout(30000)
async function scrollTo(locator) {
  await locator.evaluate(element => {
    const main = document.getElementById('main-content')
    main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16
  })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function capture(name, locator) {
  if (locator) await scrollTo(locator)
  await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' })
}
try {
  await page.goto(`${base}/preview?scenario=creative&mediaOrigin=${encodeURIComponent(media.origin)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Creative comparison', exact: true })).toBeVisible()
  await expect(page.getByLabel('Dashboard result event')).toHaveValue('appointment_confirmed')
  await expect(page.locator('[id="overview-creative-301"]')).toBeAttached()
  await expect(page.getByText('Sample-data preview: fictional metrics, not Example Studio results.', { exact: true })).toBeVisible()
  await page.getByLabel('Dashboard result event').selectOption('purchase')
  await expect(page).toHaveURL(/overview_event=purchase/)
  await expect(page.locator('[data-overview-event]')).toHaveAttribute('data-overview-event', 'purchase')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('Dashboard result event')).toHaveValue('purchase')
  await expect(page.locator('#overview-creative-301')).toBeAttached()
  await expect(page.getByText('8 ads supplied · 8 matches · 8 on this page', { exact: true })).toBeVisible()
  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.locator('#main-content').evaluate(element => { element.scrollTop = 0 })
    if (width < 1024) await expect(page.locator('#primary-nav')).toBeHidden()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await capture(`opening-${width}`)
    await capture(`creative-${width}`, page.getByRole('heading', { name: 'Creative comparison', exact: true }))
    const rows = await page.locator('tr[id^="overview-creative-"]').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { id: element.id, height: rect.height, width: rect.width }
    }))
    proof.viewports.push({ width, rows, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1) })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('radio', { name: 'Light', exact: true }).click()
  await capture('creative-light-1440', page.getByRole('heading', { name: 'Creative comparison', exact: true }))
  await page.getByRole('radio', { name: 'Dark', exact: true }).click()
  await page.getByLabel('Creative page size', { exact: true }).selectOption('5')
  await page.getByRole('button', { name: 'Next creative page' }).click()
  await expect(page.locator('#overview-creative-307')).toBeAttached()
  await page.getByRole('searchbox', { name: 'Search creative' }).fill('Outcome field unavailable')
  await expect(page.locator('#overview-creative-308')).toBeAttached()
  await expect(page.locator('#overview-creative-308')).toContainText('Unavailable')
  await page.getByRole('button', { name: 'Expand creative preview for Outcome field unavailable', exact: true }).click()
  await page.getByRole('link', { name: 'Open full ad investigation', exact: true }).click()
  await expect(page).toHaveURL(/\/creative\?/)
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('searchbox', { name: 'Search creative' })).toHaveValue('Outcome field unavailable')
  await expect(page.locator('#overview-creative-308')).toBeAttached()
  await page.getByLabel('Sort creative').selectOption('cpa')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('searchbox', { name: 'Search creative' })).toHaveValue('Outcome field unavailable')
  await expect(page.getByLabel('Sort creative')).toHaveValue('cpa')
  await page.getByRole('searchbox', { name: 'Search creative' }).fill('')
  await page.getByRole('button', { name: 'Next creative page' }).click()
  const creativeRows = () => page.locator('tr[id^="overview-creative-"]').evaluateAll(elements => elements.map(element => element.id))
  const priorRows = await creativeRows()
  await expect(page).toHaveURL(/overview_creative_page=2/)
  await page.locator('tr[id^="overview-creative-"]').first().getByRole('button', { name: /^Expand creative preview/ }).click()
  await page.getByRole('link', { name: 'Open full ad investigation', exact: true }).click()
  await expect(page).toHaveURL(/\/creative\?/)
  let releaseMeta
  metaGate = { seen: false, promise: new Promise(resolve => { releaseMeta = resolve }), release: () => releaseMeta() }
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await expect(page).toHaveURL(/overview_creative_page=2/)
  await expect.poll(() => metaGate?.seen).toBe(true)
  assert.deepEqual(await creativeRows(), [])
  metaGate.release()
  metaGate = null
  await expect(page.getByLabel('Sort creative')).toHaveValue('cpa')
  await expect.poll(creativeRows).toEqual(priorRows)
  await expect(page).toHaveURL(/overview_creative_page=2/)
  await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible()
  proof.creativeNavigationBack = { search: true, sort: true, page: true, loadingPageRetained: true, rows: priorRows }
  await page.getByLabel('Sort creative').selectOption('spend')
  await page.getByRole('searchbox', { name: 'Search creative' }).fill('')
  await page.getByRole('button', { name: 'Expand creative preview for Short studio tour', exact: true }).click()
  const video = page.getByLabel('Video creative: Short studio tour', { exact: true })
  await expect(video).toBeVisible()
  await video.evaluate(element => element.play())
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(0)
  proof.playback = true
  await capture('expanded-creative', video)
  await video.evaluate(element => element.pause())
  await page.getByRole('button', { name: 'Close creative preview for Short studio tour', exact: true }).click()
  await capture('trends-and-hierarchy', page.getByRole('heading', { name: 'Results over time', exact: true }))
  const column = page.locator('[data-overview-chart="business"] g[tabindex="0"]').first()
  if (await column.count()) { await column.focus(); await expect(page.getByRole('tooltip').first()).toBeVisible(); await page.keyboard.press('Escape'); proof.keyboardChart = true }
  await capture('business-and-journey', page.getByRole('heading', { name: 'Booking economics & outlook', exact: true }))
  await page.goto(`${base}/preview?scenario=executive`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Campaigns and ad sets', exact: true })).toBeVisible()
  const hierarchy = page.getByRole('region', { name: 'Campaign and ad-set comparison' })
  await expect(hierarchy.locator('[data-hierarchy-row]')).toHaveCount(10)
  await expect(hierarchy).toContainText('Lower-spend exception')
  await hierarchy.getByRole('link', { name: 'Campaigns (3)', exact: true }).click()
  await expect(page).toHaveURL(/overview_level=campaign/)
  await expect(hierarchy.getByRole('link', { name: 'Campaigns (3)', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(hierarchy).toContainText('Studio rentals')
  await page.getByLabel('Dashboard result event').selectOption('purchase')
  const drill = hierarchy.getByRole('link', { name: 'Full comparison', exact: true })
  const href = await drill.getAttribute('href'), query = new URL(href, base).searchParams
  assert.equal(query.get('level'), 'campaign'); assert.equal(query.get('from'), '2026-09-02'); assert.ok(query.get('account'))
  await drill.click()
  await expect(page).toHaveURL(/\/performance\?/)
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('Dashboard result event')).toHaveValue('purchase')
  proof.navigationBack = true
  await page.getByLabel('Dashboard result event').selectOption('appointment_confirmed')
  await page.getByRole('searchbox', { name: 'Search creative' }).fill('Creative 1')
  await page.getByRole('link', { name: 'Lowest CPA (7/10 eligible): Creative 8', exact: true }).click()
  await expect(page.locator('#overview-creative-ad-8')).toBeFocused()
  await expect(page.getByRole('searchbox', { name: 'Search creative' })).toHaveValue('')
  proof.creativeShortcutFocus = true
  assert.deepEqual(errors, [])
  proof.passed = true
} finally {
  metaGate?.release()
  proof.pageErrors = errors
  await writeFile(`${output}/proof.json`, JSON.stringify(proof, null, 2))
  await browser.close(); await media.close()
}
console.log(JSON.stringify(proof, null, 2))
