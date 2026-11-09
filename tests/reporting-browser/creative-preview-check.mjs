// Run: TSX_TSCONFIG_PATH=tsconfig.scripts.json node --import tsx tests/reporting-browser/creative-preview-check.mjs
// Ordinary preview traffic, original local media, no API response interception.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'
import { creativeReportingFixture } from './creative-fixture.ts'
import { startCreativeMediaFixture } from './creative-media-fixture.mjs'

const expect = playwrightExpect.configure({ timeout: 20000 })
const preview = 'http://127.0.0.1:3149', output = 'test-results/reporting-preview/creative'
const media = await startCreativeMediaFixture(preview)
let browser, page
const scope = process.argv.includes('--media-only') ? 'media' : 'full'
const errors = [], sourceRequests = [], workers = [], proof = { startedAt: new Date().toISOString(), scope }

function csvRows(csv) {
  const rows = [], row = []; let cell = '', quoted = false
  for (let index = 0; index < csv.length; index++) {
    const value = csv[index]
    if (value === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index++ } else quoted = !quoted
    } else if (!quoted && (value === ',' || value === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = ''
      if (value === '\n') { rows.push([...row]); row.length = 0 }
    } else cell += value
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const headers = rows.shift().map(value => value.replace(/^\uFEFF/, ''))
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])))
}

try {
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true, proxy: { server: media.proxy }, args: ['--proxy-bypass-list=<-loopback>'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, ignoreHTTPSErrors: true })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/reporting') sourceRequests.push(request.url()) })
  page.on('worker', worker => workers.push(worker.url()))
  const path = (query = '') => `${preview}/creative?from=2026-09-02&to=2026-09-04${query}`
  const openScenario = async (mode = 'ok', ad = null) => {
    await page.goto(`${preview}/preview?scenario=creative&mediaOrigin=${encodeURIComponent(media.origin)}&mediaMode=${mode}`, { waitUntil: 'domcontentloaded' })
    await page.goto(path(ad ? `&ad=${ad}&group=results` : ''), { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: ad ? ad === '301' ? 'Short studio tour' : 'Shared display name' : 'Creative performance', exact: true })).toBeVisible()
  }
  const download = async name => {
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name, exact: true }).click()
    const file = await pending
    const csv = await readFile(await file.path(), 'utf8')
    await writeFile(`${output}/${file.suggestedFilename()}`, csv)
    return csvRows(csv)
  }
  const cellOverlaps = () => page.locator('[aria-label="Side-by-side metrics, scroll to compare"] td p').evaluateAll(paragraphs => paragraphs.flatMap(paragraph => {
    if (!paragraph.getClientRects().length) return []
    const element = paragraph.closest('td'), cell = element.getBoundingClientRect(), style = getComputedStyle(element), range = document.createRange()
    range.selectNodeContents(paragraph)
    return [...range.getClientRects()].some(rect => rect.width > 0
      && (rect.left < cell.left + parseFloat(style.paddingLeft) - 1 || rect.right > cell.right - parseFloat(style.paddingRight) + 1))
      ? [{ text: paragraph.textContent, cellWidth: cell.width, textWidth: range.getBoundingClientRect().width }] : []
  }))
  const noOverflow = async label => {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect.poll(() => page.locator('#primary-nav').evaluate((nav, mobile) => {
        const style = getComputedStyle(nav)
        return (mobile ? nav.getAttribute('aria-hidden') === 'true' && nav.inert && style.visibility === 'hidden' : style.visibility === 'visible')
          && nav.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')
      }, width < 1024)).toBe(true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label} overflow at ${width}`)
      const focus = async target => {
        await target.evaluate(element => {
          const main = document.getElementById('main-content')
          main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16
        })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      }
      if (label === 'four-way-comparison') {
        await focus(page.locator('[aria-label="Video retention comparison"] svg'))
        await page.screenshot({ path: `${output}/${label}-retention-${width}.png` })
        const region = page.getByRole('region', { name: 'Side-by-side metrics, scroll to compare', exact: true })
        await focus(region.locator('tbody tr').first())
        await region.evaluate(element => { element.scrollLeft = 0 })
        await page.screenshot({ path: `${output}/${label}-values-first-${width}.png` })
        if (width < 1024) {
          await region.focus(); await page.keyboard.press('ArrowRight')
          await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
          await region.evaluate(element => { element.scrollLeft = element.scrollWidth - element.clientWidth })
          await focus(region.locator('tbody tr').first())
          await page.screenshot({ path: `${output}/${label}-values-last-${width}.png` })
        }
      } else await focus(label === 'executions' ? page.locator('article[aria-label]').first() : page.locator('[data-creative-id="401"]'))
      if (width < 1024) assert.equal(await page.evaluate(() => document.elementFromPoint(25, 180)?.closest('#primary-nav') !== null), false, 'Closed mobile navigation must not intercept report content')
      await page.screenshot({ path: `${output}/${label}-${width}.png` })
      if (label === 'four-way-comparison') {
        const overlaps = await cellOverlaps()
        assert.deepEqual(overlaps, [], `Comparison text crosses cell boundaries at ${width}: ${JSON.stringify(overlaps.slice(0, 5))}`)
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  const metricUnchanged = async (mode = 'ok') => {
    const response = await context.request.get(`${preview}/api/reporting?section=meta&from=2026-09-02&to=2026-09-04`)
    assert.equal(response.status(), 200)
    const actual = await response.json(), expected = creativeReportingFixture(undefined, undefined, media.origin, mode)
    validateReportingPacket(actual)
    assert.deepEqual(actual.context, expected.context)
    assert.deepEqual(actual.result.data.entities.map(entity => entity.metrics), expected.meta.data.entities.map(entity => entity.metrics))
  }

  await openScenario()
  for (const section of ['meta', 'business', 'website', 'measurement']) {
    const response = await context.request.get(`${preview}/api/reporting?section=${section}&from=2026-09-02&to=2026-09-04`)
    assert.equal(response.status(), 200)
    const packet = await response.json(); validateReportingPacket(packet)
    assert.equal(packet.context.account.name, 'Synthetic creative account')
    if (section === 'business') assert.equal(packet.result.data.metrics.amount_paid.current.value, 500)
  }
  assert.equal((await context.request.get(`${preview}/api/reporting?section=unknown`)).status(), 400)
  // This false target is rejected by the local proxy before DNS or external network access.
  assert.equal((await context.request.get('http://outside-preview.invalid/control')).status(), 403)
  await metricUnchanged()
  proof.nativePackets = 4

  if (scope === 'full') {
  const cards = () => page.locator('article[aria-label]').filter({ has: page.getByRole('checkbox') })
  await expect(cards()).toHaveCount(8)
  await noOverflow('executions')
  for (const id of ['301', '302', '303', '304']) await cards().filter({ hasText: `Ad ${id} · Creative` }).getByRole('checkbox').check()
  await expect(page.getByRole('checkbox', { name: 'Compare History missing', exact: true })).toBeDisabled()
  await page.getByRole('link', { name: 'Compare selected', exact: true }).click()
  await expect(page).toHaveURL(/compare=301%2C302%2C303%2C304.*view=compare/)
  const retention = page.getByRole('region', { name: 'Video retention comparison', exact: true })
  await expect(retention).toContainText('Current preview: 8 seconds')
  await expect(retention).toContainText('Current preview: 60 seconds')
  await expect(retention).toContainText('does not establish the duration of historical media')
  const fifty = retention.getByRole('row', { name: /^50% length/ })
  await expect(fifty).toContainText('70%')
  await expect(fifty).toContainText('3,500 / 5,000 starts')
  await expect(fifty).toContainText('200 / 2,000 starts')
  await expect(fifty).toContainText('Count unavailable / starts unavailable')
  const compareRows = await download('Export CSV')
  const spends = compareRows.filter(row => row.metric === 'Spend')
  assert.equal(spends.length, 4)
  assert.deepEqual(spends.map(row => Number(row.value)).sort((a, b) => a - b), [10, 15, 25, 60])
  assert.deepEqual(spends.map(row => Number(row.previous_value)).sort((a, b) => a - b), [5, 7.5, 12.5, 30])
  assert.ok(compareRows.every(row => row.from === '2026-09-02' && row.to === '2026-09-04' && row.comparison_from === '2026-08-30' && row.source === 'meta'))
  assert.ok(compareRows.some(row => row.metric === 'Outbound clicks' && row.value === '10'))
  assert.ok(compareRows.every(row => !/ad 30[5-8];/.test(row.entity)))
  await noOverflow('four-way-comparison')
  await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' })
  assert.deepEqual(await cellOverlaps(), [], 'Printed comparison metric text must remain in each content cell')
  const printed = await page.locator('[aria-label="Side-by-side metrics, scroll to compare"] table').boundingBox()
  assert.ok(printed.x >= 0 && printed.x + printed.width <= 795, 'All four print columns fit the A4-width page')
  await page.pdf({ path: `${output}/four-way-comparison.pdf`, format: 'A4', printBackground: true })
  proof.comparisonPrint = { width: printed.width, columns: 4, contentBounds: true }
  await page.emulateMedia({ media: 'screen' }); await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(retention).toBeVisible()
  await page.getByRole('link', { name: 'Back to creative', exact: true }).click()
  await expect(page.getByRole('checkbox').filter({ visible: true })).toHaveCount(8)
  for (const id of ['301', '302', '303', '304']) await expect(cards().filter({ hasText: `Ad ${id} · Creative` }).getByRole('checkbox')).toBeChecked()
  await page.goBack({ waitUntil: 'domcontentloaded' }); await expect(retention).toBeVisible()
  await page.getByRole('link', { name: 'Back to creative', exact: true }).click()
  proof.comparison = { ads: 4, csvRows: compareRows.length, currentPriorSpend: true, nativeRetention: true }
  assert.ok(sourceRequests.length > 0 && sourceRequests.every(url => !new URL(url).searchParams.has('details')))
  console.log('Ordinary four-ad comparison, native retention, previous values, reload and Back passed.')

  await page.getByRole('button', { name: 'Shared creative', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Shared creative objects', exact: true })
  await expect(panel).toContainText('8 selected executions · 6 assigned · 2 unassigned · 8 returned by Meta')
  await expect(panel.locator('[data-creative-id]')).toHaveCount(5)
  await expect(panel.locator('[data-creative-id="401"]')).toContainText('2 executions')
  await expect(panel.locator('[data-creative-id="402"]')).toBeVisible(); await expect(panel.locator('[data-creative-id="403"]')).toBeVisible()
  await expect(panel).toContainText('History missing'); await expect(panel).toContainText('Changed creative assignment')
  await page.getByRole('button', { name: 'Clicks', exact: true }).click()
  await expect(panel.locator('[data-creative-id="406"]').getByRole('region', { name: 'Outbound clicks', exact: true }).getByText('0', { exact: true })).toHaveCount(2)
  await expect(panel.locator('[data-creative-id="407"]').getByRole('region', { name: 'Outbound clicks', exact: true }).getByText('Unavailable', { exact: true })).toHaveCount(2)
  const shared = panel.locator('[data-creative-id="401"]')
  const inputs = shared.getByRole('button', { name: 'Inputs for Outbound CTR', exact: true })
  await expect(shared.locator('[data-native-input]')).toHaveCount(0)
  await inputs.click(); await expect(inputs).toHaveAttribute('aria-expanded', 'true')
  // Numerator, denominator and native source ratio, for two ads in both periods.
  await expect(shared.locator('[data-native-input]')).toHaveCount(12)
  await expect(shared).toContainText('Ratio of summed native inputs')
  await expect(shared).toContainText('Previous inputs')
  await inputs.click()
  const disclosure = shared.locator('summary').filter({ hasText: 'Executions and assignment evidence' })
  await disclosure.click()
  await shared.locator('summary').filter({ hasText: 'Assignment evidence for Short studio tour' }).first().click()
  await expect(shared).toContainText('Boundary observation')
  await shared.getByRole('link', { name: 'Short studio tour', exact: true }).click()
  await expect(page).toHaveURL(/ad=301/)
  await expect.poll(() => sourceRequests.some(url => new URL(url).searchParams.get('details') === '301')).toBe(true)
  const history = page.getByRole('region', { name: 'Ad-level daily history', exact: true })
  await history.locator('summary').filter({ hasText: 'Daily values and evidence' }).click()
  await expect(history.getByRole('row')).toHaveCount(4)
  await expect(history).toContainText('$20.00')
  await page.getByLabel('Daily history period', { exact: true }).selectOption('previous')
  await expect(history).toContainText('$10.00')
  await expect(page.getByRole('region', { name: 'Ad placement and audience detail', exact: true })).toContainText('instagram / reels')
  await expect(page.getByRole('region', { name: 'Ad placement and audience detail', exact: true })).toContainText('$40.00')
  await page.getByRole('link', { name: 'Back to creative', exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Search ads, names or copy', exact: true })
  await search.fill('Short studio tour')
  await expect(panel).toContainText('2 selected executions · 2 assigned · 0 unassigned · 8 returned by Meta')
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(search).toHaveValue('Short studio tour')
  const racedDownload = page.waitForEvent('download', { timeout: 5000 }).catch(() => null)
  const cancelled = page.getByRole('button', { name: 'Cancel export', exact: true }).click({ force: true, timeout: 1500 }).then(() => true, () => false)
  await page.getByRole('button', { name: 'Export all group evidence', exact: true }).click()
  const cancellationObserved = await cancelled
  if (cancellationObserved) await expect(panel.getByRole('status')).toHaveText('Export cancelled.')
  else {
    const completed = await racedDownload
    assert.ok(completed, 'A fast export must yield its completed download when cancellation loses the race')
    const rows = csvRows(await readFile(await completed.path(), 'utf8'))
    assert.equal(rows.find(row => row.record_type === 'population').selected_ad_count, '2')
    await expect(panel.getByRole('status')).toHaveText('Evidence download prepared.')
  }
  const groupRows = await download('Export all group evidence')
  const population = groupRows.find(row => row.record_type === 'population')
  assert.equal(population.selected_ad_count, '2'); assert.equal(population.returned_ad_count, '8')
  assert.deepEqual(JSON.parse(population.requested_ad_ids), ['301', '302'])
  assert.ok(groupRows.some(row => row.metric_key === 'bookings' && row.record_type === 'calculation'))
  const native = groupRows.find(row => row.record_type === 'input' && row.ad_id === '301' && row.metric_key === 'spend' && row.period === 'previous')
  assert.equal(JSON.parse(native.claim_json).value, 30)
  // A cancelled task can terminate before Playwright emits its worker-created event.
  // The completed native download must still have loaded the real Next worker.
  assert.ok(workers.some(url => url.startsWith(`${preview}/_next/`) && url.includes('creative-group-export_worker')))
  assert.ok(!groupRows.some(row => row.ad_id && !['301', '302'].includes(row.ad_id)))
  const concurrentDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export all group evidence', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh Acuity business', exact: true }).click()
  const concurrentRows = csvRows(await readFile(await (await concurrentDownload).path(), 'utf8'))
  assert.equal(concurrentRows.find(row => row.record_type === 'population').selected_ad_count, '2')
  await expect(panel.getByRole('status')).toHaveText('Evidence download prepared.')
  proof.unrelatedSourceRefreshPreservesExport = true
  await search.fill('999999999999')
  await expect(panel.locator('[data-creative-id]')).toHaveCount(0)
  await expect(panel).toContainText('No returned ad executions match the current filters.')
  await search.fill('')
  await noOverflow('shared-creatives')
  await page.emulateMedia({ media: 'print' }); await page.pdf({ path: `${output}/shared-creatives.pdf`, format: 'A4', printBackground: true }); await page.emulateMedia({ media: 'screen' })
  proof.grouping = { groups: 5, unassigned: 2, csvRows: groupRows.length, realWorkers: workers.length,
    cancellation: cancellationObserved ? 'cancelled while working' : 'completed before pointer cancellation; valid download preserved' }

  await page.getByTitle('Change the date range (applies across pages)').click()
  await page.getByLabel('From date', { exact: true }).fill('2026-09-01')
  await page.getByLabel('To date', { exact: true }).fill('2026-09-03')
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/from=2026-09-01&to=2026-09-03/)
  await expect(panel).toContainText('Previous 2026-08-29 – 2026-08-31')
  await expect(panel.locator('[data-creative-id="401"]')).toContainText('$140.00')
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(panel).toContainText('$140.00')
  proof.dateSelection = '2026-09-01–03 / 2026-08-29–31'
  }

  for (const [file, length] of [['original-8.mp4', 8], ['original-60.mp4', 60]]) {
    const response = await context.request.get(`${media.origin}/${file}`)
    assert.equal(response.status(), 200); assert.equal(response.headers()['content-type'], 'video/mp4')
    const ranged = await context.request.get(`${media.origin}/${file}`, { headers: { Range: 'bytes=0-31' } })
    assert.equal(ranged.status(), 206); assert.equal((await ranged.body()).length, 32)
    assert.equal(ranged.headers()['content-range'], `bytes 0-31/${media.assets[`/${file}`].length}`)
    assert.equal((await context.request.get(`${media.origin}/${file}`, { headers: { Range: 'bytes=999999999-' } })).status(), 416)
    assert.ok(length > 0)
  }
  assert.equal((await context.request.get(`${media.origin}/missing.png`)).status(), 404)
  assert.equal((await context.request.get(`${media.origin}/denied/original.png`)).status(), 403)
  await openScenario('ok', '301')
  const video = page.getByLabel('Video creative: Short studio tour', { exact: true })
  await video.scrollIntoViewIfNeeded()
  await video.focus(); await page.keyboard.press('Space')
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(.2)
  await page.keyboard.press('Space')
  const metadata = await video.evaluate(element => ({ duration: element.duration, width: element.videoWidth, height: element.videoHeight, paused: element.paused, time: element.currentTime, controls: element.controls }))
  assert.equal(metadata.duration, 8); assert.equal(metadata.width, 320); assert.equal(metadata.height, 200); assert.equal(metadata.controls, true)
  await video.focus()
  // Chromium's native slider steps by 1% of this eight-second clip per key.
  for (let step = 0; step < 20; step++) await page.keyboard.press('ArrowRight')
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(metadata.time + 1)
  const keyboardSeek = await video.evaluate(element => element.currentTime)
  const box = await video.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 22)
  await page.mouse.click(box.x + box.width * .7, box.y + box.height - 22)
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(keyboardSeek + 2)
  await expect.poll(() => video.evaluate(element => element.seeking)).toBe(false)
  proof.playback = { ...metadata, keyboardSeek, pointerSeek: await video.evaluate(element => element.currentTime) }
  await page.screenshot({ path: `${output}/video-success.png` })
  await expect(page.getByText('Ad 301 · Creative 401', { exact: true })).toBeVisible()
  await expect(page.getByText('$60.00', { exact: true }).first()).toBeVisible()

  await openScenario('ok', '303')
  const longVideo = page.getByLabel('Video creative: Shared display name', { exact: true })
  await longVideo.focus(); await page.keyboard.press('Space')
  await expect.poll(() => longVideo.evaluate(element => element.currentTime)).toBeGreaterThan(.2)
  assert.deepEqual(await longVideo.evaluate(element => [element.duration, element.videoWidth, element.videoHeight]), [60, 320, 200])
  await page.keyboard.press('Space')
  proof.longVideo = { duration: 60, width: 320, height: 200, advanced: true }

  await openScenario('ok', '304')
  await expect(page.getByRole('region', { name: 'Ad-level daily history', exact: true })).toContainText('unavailable for this period')
  await expect(page.getByRole('region', { name: 'Ad placement and audience detail', exact: true })).toContainText('unavailable in this response')
  const decoded = page.getByAltText('Creative preview: Shared display name', { exact: true })
  await expect.poll(() => decoded.evaluate(element => element.complete && element.naturalWidth)).toBe(320)
  assert.equal(await decoded.evaluate(element => element.naturalHeight), 200)
  for (const mode of ['video-denied', 'image-denied', 'all-denied']) {
    const ad = mode === 'image-denied' ? '304' : '301'
    await openScenario(mode, ad)
    if (ad === '301') { const player = page.getByLabel('Video creative: Short studio tour', { exact: true }); await player.focus(); await page.keyboard.press('Space') }
    if (mode === 'all-denied') {
      await expect(page.getByText('The asset could not load. Its ad identity and metrics remain available.', { exact: true })).toBeVisible()
      await expect(page.locator('video')).toHaveCount(0)
    } else {
      const image = page.getByAltText(`Creative preview: ${ad === '301' ? 'Short studio tour' : 'Shared display name'}`, { exact: true })
      await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth)).toBe(320)
      if (mode === 'video-denied') await expect(page.getByText('Video playback failed; preview shown when available.', { exact: true })).toBeVisible()
      else await expect(image).toHaveAttribute('src', `${media.origin}/thumbnail.png`)
    }
    await expect(page.getByText(`Ad ${ad} · Creative ${ad === '301' ? '401' : '403'}`, { exact: true })).toBeVisible()
    await expect(page.getByText(ad === '301' ? '$60.00' : '$15.00', { exact: true }).first()).toBeVisible()
    await metricUnchanged(mode)
    await page.screenshot({ path: `${output}/${mode}.png` })
  }
  assert.ok(media.mediaLog.some(row => row.status === 206 && row.range !== 'bytes=0-31'))
  assert.ok(media.mediaLog.some(row => row.path === '/denied/original-8.mp4' && row.status === 403))
  assert.deepEqual(errors, [])
  proof.result = 'pass'; proof.finishedAt = new Date().toISOString()
  console.log(JSON.stringify(proof))
} catch (error) {
  proof.result = 'failed'; proof.failure = String(error)
  if (page) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  throw error
} finally {
  if (browser) await browser.close()
  await media.close()
  await writeFile(`${output}/results.json`, JSON.stringify({ ...proof, errors, workers, sourceRequests, media: media.mediaLog, routing: media.proxyLog }, null, 2))
  await writeFile(`${output}/results-${scope}.json`, JSON.stringify({ ...proof, errors, workers, sourceRequests, media: media.mediaLog, routing: media.proxyLog }, null, 2))
  await writeFile(`${output}/results-${proof.startedAt.replace(/[:.]/g, '-')}.json`, JSON.stringify({ ...proof, errors, workers, sourceRequests, media: media.mediaLog, routing: media.proxyLog }, null, 2))
}
