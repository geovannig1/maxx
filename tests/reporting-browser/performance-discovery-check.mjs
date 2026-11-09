// Ordinary loopback fixtures, native packets and isolated saved-report service; no response replacement.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'
import { validateSavedReportReply } from '../../src/lib/reporting/saved-validation.ts'
import { deriveExpertReview } from '../../src/lib/reporting/review/index.ts'

const expect = playwrightExpect.configure({ timeout: 25_000 })
const output = 'test-results/reporting-preview/performance-discovery'
const proof = { startedAt: new Date().toISOString(), checkerSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') }
const errors = [], blocked = [], requests = []
let browser, context, page
try {
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true })
  const session = async (origin, scenario) => {
    if (context) await context.close()
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
    context.setDefaultTimeout(25_000)
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      const post = origin.endsWith(':3150') && request.method() === 'POST' && ['/api/reporting', '/api/reporting/saved'].includes(url.pathname)
      if (url.origin === origin && (['GET', 'HEAD'].includes(request.method()) || post)) return route.continue()
      blocked.push({ origin: url.origin, path: url.pathname, method: request.method() }); return route.abort('blockedbyclient')
    })
    page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.pathname.startsWith('/api/reporting')) requests.push({ path: url.pathname + url.search, status: response.status(), method: response.request().method() })
    })
    await page.goto(`${origin}/preview?scenario=${scenario}`, { waitUntil: 'domcontentloaded' })
  }
  const index = () => page.getByRole('region', { name: 'Performance assessment index', exact: true })
  const level = name => index().locator(`[data-performance-level="${name}"]`)
  const ids = () => page.locator('[data-review-id]').evaluateAll(rows => rows.map(row => row.dataset.reviewId))
  const focus = async target => target.evaluate(element => {
    const main = document.getElementById('main-content')
    main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16
  })
  const geometry = async () => index().locator('a,h3,h4,p').evaluateAll(elements => elements.flatMap(element => {
    const box = element.getBoundingClientRect(), problems = []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue
      const range = document.createRange(); range.selectNodeContents(node)
      if ([...range.getClientRects()].some(rect => rect.width && (rect.left < box.left - 1 || rect.right > box.right + 1))) problems.push(node.textContent)
    }
    return problems
  }))
  await session('http://127.0.0.1:3149', 'executive-answer-stable')
  const packets = await Promise.all(['meta', 'business', 'website', 'measurement'].map(async section => {
    const response = await context.request.get(`http://127.0.0.1:3149/api/reporting?section=${section}&from=2026-08-19&to=2026-08-21`)
    assert.equal(response.status(), 200); return validateReportingPacket(await response.json())
  }))
  const latest = packets.reduce((a, b) => Date.parse(a.context.asOf) > Date.parse(b.context.asOf) ? a : b)
  const native = deriveExpertReview({ context: latest.context, ...Object.fromEntries(packets.map(packet => [packet.section, packet.result])) })
  assert.deepEqual(native.input.rejectedSources, [])
  assert.equal(latest.context.account.name, 'Fictional executive answer studio')
  await expect(index()).toBeVisible()
  for (const [name, count] of [['campaign', 3], ['adset', 10], ['ad', 10]])
    await expect(level(name).getByRole('link', { name: `All performance assessments ${count}`, exact: true })).toHaveCount(1)
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready)
    await expect.poll(() => page.locator('#primary-nav').evaluate((nav, mobile) =>
      (mobile ? nav.inert && getComputedStyle(nav).visibility === 'hidden' : getComputedStyle(nav).visibility === 'visible')
      && nav.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'), width < 1024)).toBe(true)
    await focus(index()); assert.deepEqual(await geometry(), [])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    assert.ok((await index().getByRole('link').evaluateAll(links => links.map(link => link.getBoundingClientRect().height))).every(height => height >= 44))
    await page.screenshot({ path: `${output}/index-${width}.png` })
  }
  // The same geometry instrument must reject actual oversized rendered text.
  const control = level('adset').getByRole('link', { name: 'All performance assessments 10', exact: true }).locator('span').first()
  await control.evaluate(element => { element.style.whiteSpace = 'nowrap'; element.style.fontSize = '100px' })
  assert.ok((await geometry()).length > 0)
  await control.evaluate(element => element.removeAttribute('style'))
  assert.deepEqual(await geometry(), [])
  await page.setViewportSize({ width: 1440, height: 1000 })
  const zeroLink = level('adset').getByRole('link', { name: 'Spend with an event at zero 5', exact: true })
  await zeroLink.focus(); await page.keyboard.press('Enter')
  const zeros = [3, 4, 5, 6, 7].map(number => `performance:adset:set-${number}`)
  await expect.poll(ids).toEqual(zeros)
  await expect(page.getByLabel('Performance signal', { exact: true })).toHaveValue('zero_outcome')
  await expect(page.locator('[data-review-id="performance:adset:set-7"]')).toContainText('zero AppointmentConfirmed')
  await page.reload(); await expect.poll(ids).toEqual(zeros)
  await page.getByLabel('Performance signal', { exact: true }).selectOption('improved')
  await expect.poll(ids).toEqual(['performance:adset:set-8'])
  await expect(page.locator('[data-review-id="performance:adset:set-8"]')).toContainText('AppointmentConfirmed ROAS increased from 8× to 40×')
  const drill = page.locator('[data-review-id="performance:adset:set-8"]').getByRole('link')
  const destination = new URL(await drill.getAttribute('href'), page.url())
  assert.equal(destination.searchParams.get('adset'), 'set-8')
  await drill.click(); await expect.poll(() => new URL(page.url()).searchParams.get('adset')).toBe('set-8')
  await page.goBack(); await expect.poll(ids).toEqual(['performance:adset:set-8'])
  await page.goBack(); await expect.poll(ids).toEqual(zeros)
  await page.getByRole('button', { name: 'Clear assessment filters', exact: true }).click()
  assert.equal(new URL(page.url()).searchParams.has('review_signal'), false)
  await expect(page.getByRole('status').filter({ hasText: 'matching of' })).toContainText(`${native.findings.length} matching of ${native.findings.length}`)
  proof.current = { nativeAssessments: native.findings.length, zeroAdsets: zeros, improvedAdset: 'set-8', widths: [1440, 320], geometryNegativeControl: true }

  const savedOrigin = 'http://127.0.0.1:3150'
  await session(savedOrigin, 'normal')
  await expect(index()).toBeVisible()
  await level('adset').getByRole('link', { name: /^All performance assessments/ }).click()
  await expect(page.getByLabel('Performance signal', { exact: true })).toHaveValue('all')
  await page.locator('summary').filter({ hasText: /^Save report$/ }).click()
  const title = `Performance discovery ${randomUUID().slice(0, 8)}`
  await page.getByLabel('Report name', { exact: true }).fill(title)
  const button = page.getByRole('button', { name: 'Save this report', exact: true })
  await expect(button).toBeEnabled()
  const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reporting/saved' && response.request().method() === 'POST')
  await button.click(); const response = await saving; assert.equal(response.status(), 200)
  const saved = await validateSavedReportReply(await response.json())
  assert.equal(saved.saved.view.query.review_signal, 'all')
  assert.equal(saved.saved.view.query.review_level, 'adset')
  await writeFile(`${output}/saved-original.json`, JSON.stringify(saved, null, 2))
  await page.waitForURL(url => url.searchParams.get('saved') === saved.saved.id)
  const originalIds = saved.review.findings.filter(row => row.id === `performance:adset:${row.entity?.id}`).map(row => row.id)
  await expect.poll(ids).toEqual(originalIds)
  const before = await (await context.request.get(`${savedOrigin}/__fixture/audit`)).json()
  await page.reload(); await expect.poll(ids).toEqual(originalIds)
  await page.getByRole('link', { name: 'Saved reports', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Saved reports', exact: true })).toBeVisible()
  await page.getByRole('link', { name: title, exact: true }).click()
  await expect(page.getByLabel('Performance signal', { exact: true })).toHaveValue('all')
  await expect(page.getByLabel('Assessment level', { exact: true })).toHaveValue('adset')
  await expect.poll(ids).toEqual(originalIds)
  await page.goto(`${savedOrigin}/dashboard?saved=${saved.saved.id}&from=2026-09-02&to=2026-09-04`)
  await expect(index()).toBeVisible()
  await level('adset').getByRole('link', { name: /^All performance assessments/ }).click()
  assert.equal(new URL(page.url()).searchParams.get('saved'), saved.saved.id)
  await expect.poll(ids).toEqual(originalIds)
  await page.pdf({ path: `${output}/saved-filtered-review.pdf`, format: 'A4', printBackground: true })
  await expect.poll(ids).toEqual(originalIds)
  const after = await (await context.request.get(`${savedOrigin}/__fixture/audit`)).json()
  assert.equal(after.liveReads, before.liveReads); assert.equal(after.liveRefreshes, before.liveRefreshes)
  proof.saved = { id: saved.saved.id, view: saved.saved.view, exactIds: originalIds, before, after }
  assert.deepEqual(errors, [])
  // The native general fixture supplies this nonexistent illustration (fixture.ts).
  // Keep it blocked and disclosed; never exempt an actual external destination.
  assert.deepEqual(blocked.filter(item => !(item.origin === 'https://example.test'
    && item.path === '/creative.jpg' && item.method === 'GET')), [])
  proof.blockedFictionalIllustrations = blocked.length
  assert.ok(requests.every(request => request.status === 200))
  proof.finishedAt = new Date().toISOString(); console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  proof.failure = { name: error.name, message: error.message, stack: error.stack }
  if (page) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  console.error(error); process.exitCode = 1
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ ...proof, errors, blocked, requests }, null, 2))
  if (context) await context.close()
  if (browser) await browser.close()
}
