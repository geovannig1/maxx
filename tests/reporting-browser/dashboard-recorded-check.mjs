// Historical recorded packets in the real loopback app; never a live account read.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'
import { fixtureCookie } from './auth-fixture.mjs'

const input = process.env.MAXX_RECORDED_PACKETS
if (!input) throw new Error('Set MAXX_RECORDED_PACKETS to a JSON file of four recorded reporting packets.')
const output = await mkdtemp(join(tmpdir(), 'maxx-dashboard-recorded-'))
const assetsOnly = process.argv.includes('--original-assets')
const visualOnly = process.argv.includes('--visual-only')
const manifest = `${output}/${assetsOnly ? 'original-assets-proof' : visualOnly ? 'final-visual-proof' : 'proof'}.json`
const origin = 'http://127.0.0.1:3147'
const raw = await readFile(input, 'utf8')
const packets = JSON.parse(raw).map(validateReportingPacket)
assert.equal(packets.length, 4)
const bySection = Object.fromEntries(packets.map(packet => [packet.section, packet]))
assert.deepEqual(Object.keys(bySection).sort(), ['business', 'measurement', 'meta', 'website'])
const meta = bySection.meta.result.data, business = bySection.business.result.data
assert.ok(meta && business)
const period = bySection.meta.context
const ads = meta.entities.filter(entity => entity.level === 'ad')
const originalAssets = new Set(ads.flatMap(entity => [entity.creative?.imageUrl, entity.creative?.thumbnailUrl, entity.creative?.videoUrl]).filter(Boolean))
const adsets = meta.entities.filter(entity => entity.level === 'adset')
const sortSpend = (rows, nameTie = false) => [...rows].sort((a, b) => {
  const x = a.metrics.spend?.current, y = b.metrics.spend?.current
  const left = x?.availability.state === 'available' ? x.value : null
  const right = y?.availability.state === 'available' ? y.value : null
  const tie = () => (nameTie ? a.name.localeCompare(b.name) : 0) || a.id.localeCompare(b.id)
  if (left === null || right === null) return left === right ? tie() : left === null ? 1 : -1
  return right - left || tie()
})
const orderedAds = sortSpend(ads), orderedSets = sortSpend(adsets, true)
const badPacket = structuredClone(bySection.meta)
badPacket.result.data.metrics.spend.current.entity.id = 'wrong-account-control'
assert.throws(() => validateReportingPacket(badPacket), 'Packet validation must reject an incorrect account identity')
const proof = {
  evidence: 'Historical recorded source packets replayed locally; not a current live read or account-completeness claim.',
  input, sha256: createHash('sha256').update(raw).digest('hex'), startedAt: new Date().toISOString(),
  range: period.range, timezone: period.timezone,
  sources: Object.fromEntries(packets.map(packet => [packet.section, { state: packet.result.state, asOf: packet.result.asOf, packetAsOf: packet.context.asOf }])),
  population: { campaigns: meta.entities.filter(entity => entity.level === 'campaign').length, adsets: adsets.length, ads: ads.length,
    services: business.types.length, websiteRows: bySection.website.result.data?.rows.length ?? 0 },
  originalAssetsEnabled: assetsOnly, assetRequests: [], checks: {}, screenshots: [], viewports: [], pageErrors: [], blockedWrites: [], blockedExternalRequests: 0, reportingResponses: [],
}
const expect = playwrightExpect.configure({ timeout: 30000 })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
await context.addCookies([{ name: 'sb-127-auth-token', value: fixtureCookie, domain: '127.0.0.1', path: '/', sameSite: 'Lax' }])
let failMeta = false
let activeAssetReads = 0
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url())
  if (!['GET', 'HEAD'].includes(request.method())) {
    proof.blockedWrites.push({ method: request.method(), path: url.pathname })
    return route.fulfill({ status: 405, json: { error: 'Writes withheld during recorded evidence verification.' } })
  }
  if (url.origin !== origin) {
    if (assetsOnly && originalAssets.has(request.url()) && url.protocol === 'https:') {
      activeAssetReads++
      const result = { urlSha256: createHash('sha256').update(request.url()).digest('hex'), kind: request.resourceType() }
      try {
        const response = await fetch(request.url(), { method: 'GET', credentials: 'omit', redirect: 'error',
          headers: { Accept: request.resourceType() === 'image' ? 'image/*' : 'video/*' }, signal: AbortSignal.timeout(10000) })
        const body = Buffer.from(await response.arrayBuffer())
        Object.assign(result, { status: response.status, bytes: body.length })
        await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream', body })
      } catch (error) {
        result.error = error.name
        await route.fulfill({ status: 504, body: 'Original asset unavailable during bounded recorded-source check.' })
      } finally { proof.assetRequests.push(result); activeAssetReads-- }
      return
    }
    proof.blockedExternalRequests++
    return route.fulfill({ status: 404, body: 'External asset withheld; playability is outside this check.' })
  }
  if (url.pathname === '/api/reporting') {
    const section = url.searchParams.get('section') ?? 'meta'
    const packet = bySection[section]
    assert.ok(packet, `Unsupported reporting section: ${section}`)
    assert.equal(url.searchParams.get('from'), period.range.from)
    assert.equal(url.searchParams.get('to'), period.range.to)
    const status = failMeta && section === 'meta' ? 503 : 200
    proof.reportingResponses.push({ section, status, refresh: url.searchParams.get('refresh') === '1' })
    return route.fulfill({ status, json: status === 503 ? { error: 'Controlled Meta source failure.' } : packet })
  }
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, json: url.pathname === '/api/sync'
    ? { status: 'synced', lastSync: bySection.meta.result.asOf, dataThrough: period.range.to } : {} })
  return route.continue()
})
const page = await context.newPage()
page.on('pageerror', error => proof.pageErrors.push(error.message))
const dashboardUrl = `${origin}/dashboard?${new URLSearchParams({ account: period.account.id, from: period.range.from, to: period.range.to })}`
const creative = page.getByRole('region', { name: 'Creative comparison', exact: true })
const creativeRows = () => creative.locator('tr[id^="overview-creative-"]')
const hierarchy = page.getByRole('region', { name: 'Campaign and ad-set comparison', exact: true })
const businessRegion = page.getByRole('region', { name: 'Business results', exact: true })
const advertisingRegion = page.getByRole('region', { name: 'Advertising results', exact: true })
const lowerBusiness = page.getByRole('region', { name: 'Booking economics and outlook', exact: true })
const format = metric => {
  const claim = metric.current
  if (claim.availability.state !== 'available' || claim.value === null) return 'Unavailable'
  if (claim.unit === 'money') return claim.value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 })
  if (claim.unit === 'ratio') return `${claim.value.toFixed(2)}×`
  return claim.value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}
const summaryValue = (region, label) => region.locator('summary[aria-label]').filter({ hasText: /./ })
  .evaluateAll((nodes, prefix) => nodes.find(node => node.getAttribute('aria-label')?.startsWith(`${prefix}: `))?.textContent?.trim(), label)
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function scrollTo(locator) {
  await locator.evaluate(element => {
    const main = document.getElementById('main-content')
    main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16
  })
  await settle()
}
async function capture(name, locator) {
  if (locator) await scrollTo(locator)
  const path = `${output}/${name}.png`
  await page.screenshot({ path, animations: 'disabled' })
  proof.screenshots.push(path)
}
async function visibleTextOverflow(locator) {
  return locator.evaluate(element => {
    const bounds = element.getBoundingClientRect(), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), failures = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!node.textContent.trim() || !parent?.checkVisibility() || parent.closest('.sr-only')) continue
      if (getComputedStyle(parent).overflow === 'hidden' || parent.closest('.line-clamp-2')) continue
      const range = document.createRange(); range.selectNodeContents(node)
      if ([...range.getClientRects()].some(rect => rect.width && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1))) failures.push(node.textContent.slice(0, 100))
    }
    return failures
  })
}
try {
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })
  await expect(creative).toBeVisible()
  await expect(creativeRows()).toHaveCount(Math.min(25, ads.length))
  await expect(page.getByLabel('Dashboard result event')).toHaveValue('appointment_confirmed')
  await expect.poll(() => summaryValue(advertisingRegion, 'Reported results')).toBe(format(meta.metrics.bookings))
  await expect.poll(() => summaryValue(advertisingRegion, 'Reported ROAS')).toBe(format(meta.metrics.appointment_roas))
  await expect.poll(() => summaryValue(businessRegion, 'Booked value')).toBe(format(business.metrics.booked_value))
  proof.checks.defaultAppointment = true
  const firstRow = creative.locator(`[id="overview-creative-${orderedAds[0].id}"]`)
  await expect(firstRow.getByRole('group', { name: 'AppointmentConfirmed count', exact: true })).toContainText(format(orderedAds[0].metrics.bookings))
  if (assetsOnly || visualOnly) {
    await scrollTo(creative)
    if (assetsOnly && originalAssets.size) await expect.poll(() => activeAssetReads === 0 && proof.assetRequests.length > 0, { timeout: 22000 }).toBe(true)
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 1000 })
      await settle()
      await capture(`${assetsOnly ? 'original-assets' : 'final-blocked-assets'}-creative-${width}`, creative)
      const images = await creative.locator('img').evaluateAll(elements => elements.map(image => ({
        loaded: image.complete && image.naturalWidth > 0, width: image.naturalWidth, height: image.naturalHeight,
      })))
      const lastCells = await creativeRows().locator('td:last-child').evaluateAll(cells => cells.map(cell => {
        const value = cell.querySelector('[aria-label$=" ROAS"] > p')
        const bounds = cell.getBoundingClientRect()
        if (!value) return { measured: false }
        const range = document.createRange(); range.selectNodeContents(value)
        const lines = [...range.getClientRects()].filter(rect => rect.width > 0)
        return { measured: true, unavailable: value.textContent === 'Unavailable', lines: lines.length,
          fits: lines.every(rect => rect.left >= bounds.left && rect.right <= bounds.right) }
      }))
      assert.ok(lastCells.every(cell => cell.measured && cell.fits && (!cell.unavailable || cell.lines === 1)), 'ROAS values, including Unavailable, fit without word splitting')
      assert.deepEqual(await visibleTextOverflow(creative), [])
      proof.viewports.push({ width, loadedOriginalImages: images.filter(image => image.loaded).length, displayedImages: images.length, roasCells: lastCells })
    }
    if (assetsOnly) proof.checks.originalAssets = { suppliedDistinctUrls: originalAssets.size,
      requestedDistinctUrls: new Set(proof.assetRequests.map(result => result.urlSha256)).size,
      httpSuccess: proof.assetRequests.filter(result => result.status >= 200 && result.status < 300).length,
      failed: proof.assetRequests.filter(result => !(result.status >= 200 && result.status < 300)).length,
      playbackNotTested: true }
    else proof.checks.finalVisualWithAssetsBlocked = true
  } else {
  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.locator('#main-content').evaluate(element => { element.scrollTop = 0 })
    await settle()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    const overflow = await visibleTextOverflow(creative)
    assert.deepEqual(overflow, [], `Creative text must fit at ${width}px`)
    await capture(`opening-${width}`)
    await capture(`creative-${width}`, creative)
    await capture(`business-${width}`, lowerBusiness)
    proof.viewports.push({ width, noPageOverflow: true, creativeTextOverflow: overflow,
      creativeRowHeights: await creativeRows().evaluateAll(rows => rows.map(row => Math.round(row.getBoundingClientRect().height))) })
  }
  await creative.evaluate(element => {
    const control = document.createElement('span'); control.dataset.overflowControl = 'true'
    control.style.whiteSpace = 'nowrap'; control.textContent = 'OVERSIZED'.repeat(150); element.append(control)
  })
  assert.ok((await visibleTextOverflow(creative)).length > 0, 'Overflow detector must reject an oversized control')
  await creative.locator('[data-overflow-control]').evaluate(element => element.remove())
  proof.checks.overflowNegativeControl = true
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByLabel('Creative page size', { exact: true }).selectOption('5')
  await page.getByLabel('Dashboard result event').selectOption('purchase')
  await expect(page).toHaveURL(/overview_event=purchase/)
  await expect.poll(() => summaryValue(advertisingRegion, 'Reported results')).toBe(format(meta.metrics.purchase_count))
  await expect.poll(() => summaryValue(advertisingRegion, 'Reported ROAS')).toBe(format(meta.metrics.purchase_roas))
  await expect(firstRow.getByRole('group', { name: 'Purchase count', exact: true })).toContainText(format(orderedAds[0].metrics.purchase_count))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('Dashboard result event')).toHaveValue('purchase')
  await expect(creativeRows()).toHaveCount(5)
  await capture('purchase-1440', creative)
  proof.checks.explicitPurchaseAndReload = true
  await page.getByLabel('Dashboard result event').selectOption('appointment_confirmed')
  const seen = []
  for (let number = 1; number <= Math.ceil(ads.length / 5); number++) {
    const expected = orderedAds.slice((number - 1) * 5, number * 5).map(entity => `overview-creative-${entity.id}`)
    await expect.poll(() => creativeRows().evaluateAll(rows => rows.map(row => row.id))).toEqual(expected)
    seen.push(...expected)
    if (number < Math.ceil(ads.length / 5)) await page.getByRole('button', { name: 'Next creative page', exact: true }).click()
  }
  assert.equal(new Set(seen).size, ads.length)
  const lastAd = orderedAds.at(-1)
  await page.getByRole('searchbox', { name: 'Search creative', exact: true }).fill(lastAd.id)
  await expect(creativeRows()).toHaveCount(1)
  await expect(creativeRows().first()).toHaveAttribute('id', `overview-creative-${lastAd.id}`)
  await page.getByRole('searchbox', { name: 'Search creative', exact: true }).fill('impossible-recorded-ad-control')
  await expect(creativeRows()).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search creative', exact: true }).fill('')
  await expect(creativeRows()).toHaveCount(5)
  proof.checks.creativePopulation = { pages: Math.ceil(ads.length / 5), reached: seen.length, unique: new Set(seen).size, lowerAdIdSearch: lastAd.id, missingSearchRejected: true }
  await expect(hierarchy.locator('[data-hierarchy-row]')).toHaveCount(adsets.length)
  await expect.poll(() => hierarchy.locator('[data-hierarchy-row]').evaluateAll(rows => rows.map(row => row.dataset.hierarchyRow))).toEqual(orderedSets.map(entity => entity.id))
  const lowerRankedSet = orderedSets.at(-1)
  await expect(hierarchy.locator(`[data-hierarchy-row="${lowerRankedSet.id}"]`)).toBeAttached()
  await capture('adsets-complete', hierarchy)
  proof.checks.adsets = { supplied: adsets.length, visible: adsets.length, lowerRankedId: lowerRankedSet.id }
  await expect(lowerBusiness).toContainText('Largest service changes')
  const servicesShown = await lowerBusiness.locator('li').allTextContents()
  assert.ok(servicesShown.length > 0 && servicesShown.length <= 3)
  assert.ok(servicesShown.every(text => business.types.some(service => text.includes(service.name))))
  await expect(lowerBusiness).toContainText('Customer history')
  await expect(lowerBusiness).toContainText('Booking → service date')
  await expect(lowerBusiness).toContainText('Recorded upcoming demand')
  if (business.intelligence?.customers.data) {
    await expect.poll(() => summaryValue(lowerBusiness, 'With earlier bookings')).toBe(format(business.intelligence.customers.data.metrics.prior_booking_customers))
  }
  proof.checks.lowerBusiness = { observedServiceRows: servicesShown.length, sourceServicePopulation: business.types.length, customerContext: true, timing: true, upcoming: true }
  const businessBefore = await summaryValue(businessRegion, 'Booked value')
  const metaBefore = await summaryValue(advertisingRegion, 'Reported results')
  const rowsBefore = await creativeRows().evaluateAll(rows => rows.map(row => ({ id: row.id, text: row.textContent })))
  await page.locator('[data-overview-sources] > summary').click()
  await expect(page.getByRole('button', { name: 'Refresh Meta advertising', exact: true })).toBeEnabled()
  failMeta = true
  await page.getByRole('button', { name: 'Refresh Meta advertising', exact: true }).click()
  const source = page.locator('[data-reporting-source]').filter({ has: page.getByLabel('Meta advertising source details', { exact: true }) })
  await expect(source.getByRole('status')).toHaveText('Refresh failed')
  assert.equal(await summaryValue(advertisingRegion, 'Reported results'), metaBefore)
  assert.equal(await summaryValue(businessRegion, 'Booked value'), businessBefore)
  assert.deepEqual(await creativeRows().evaluateAll(rows => rows.map(row => ({ id: row.id, text: row.textContent }))), rowsBefore)
  await source.locator('summary').click()
  await expect(source).toContainText('Showing the previous report while fresh data is unavailable.')
  await expect(source).toContainText(bySection.meta.result.asOf)
  await page.locator('#main-content').evaluate(element => { element.scrollTop = 0 })
  await capture('meta-refresh-failed')
  proof.checks.retainedMetaFailure = { controlledStatus: 503, refreshAttemptObserved: proof.reportingResponses.some(item => item.section === 'meta' && item.status === 503 && item.refresh),
    previousMetaValuesRetained: true, previousCreativeRowsRetained: true, businessUnchanged: true, originalSourceTimestampVisible: true }
  }
  assert.deepEqual(proof.pageErrors, [])
  assert.deepEqual(proof.blockedWrites, [])
  proof.passed = true
} catch (error) {
  proof.failure = { message: error.message, stack: error.stack }
  await capture('failure').catch(() => {})
  process.exitCode = 1
} finally {
  proof.finishedAt = new Date().toISOString()
  await writeFile(manifest, JSON.stringify(proof, null, 2))
  await context.close()
  await browser.close()
}
console.log(JSON.stringify({ passed: proof.passed ?? false, checks: proof.checks, population: proof.population, failure: proof.failure?.message,
  manifest, screenshots: proof.screenshots.length }, null, 2))
