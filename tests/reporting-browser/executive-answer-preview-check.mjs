// Ordinary native fixture gateway; run only after root confirms source/UI freeze and restart.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'
import { deriveExpertReview, overviewFindings } from '../../src/lib/reporting/review/index.ts'
import { findingEvidence } from '../../src/lib/reporting/review/evidence.ts'
import { validateSavedReportReply } from '../../src/lib/reporting/saved-validation.ts'
import { EXECUTIVE_ANSWER_MODES } from './executive-answer-fixture.ts'

const expect = playwrightExpect.configure({ timeout: 25_000 })
const origin = 'http://127.0.0.1:3149', savedOrigin = 'http://127.0.0.1:3150'
const output = 'test-results/reporting-preview/executive-answer'
const proof = { startedAt: new Date().toISOString(), baseline: null,
  checkerSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), scenarios: {} }
const errors = [], blocked = [], requests = []
let browser, context, page
function csvRows(csv) {
  const rows = [], row = []; let cell = '', quoted = false
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index]
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index++ } else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = ''
      if (char === '\n') { rows.push([...row]); row.length = 0 }
    } else cell += char
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const headers = rows.shift().map(value => value.replace(/^\uFEFF/, ''))
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])))
}
try {
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true })
  const session = async target => {
    if (context) await context.close()
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
    context.setDefaultTimeout(25_000)
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === target && ['GET', 'HEAD'].includes(request.method())) return route.continue()
      blocked.push({ origin: url.origin, path: url.pathname, method: request.method() }); return route.abort('blockedbyclient')
    })
    page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.pathname.startsWith('/api/reporting')) requests.push({ path: url.pathname + url.search, status: response.status() })
    })
  }
  const opening = () => page.locator('[data-executive-result]')
  const observation = () => opening().locator('[data-executive-observation]')
  const full = () => page.locator('[data-review-id="business_platform_trend"]')
  const state = async expected => expect.poll(() => {
    const url = new URL(page.url())
    return Object.fromEntries(Object.keys(expected).map(key => [key, key === 'path' ? url.pathname : key === 'hash' ? url.hash : url.searchParams.get(key)]))
  }).toEqual(expected)
  const focus = async target => {
    await target.evaluate(element => {
      const main = document.getElementById('main-content')
      main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16
    })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const settled = async width => {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => document.fonts.ready)
    await expect.poll(() => page.locator('#primary-nav').evaluate((nav, mobile) =>
      (mobile ? nav.inert && nav.getAttribute('aria-hidden') === 'true' && getComputedStyle(nav).visibility === 'hidden' : getComputedStyle(nav).visibility === 'visible')
      && nav.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'), width < 1024)).toBe(true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  }
  const bounds = async scope => {
    await expect(scope).toHaveCount(1)
    return scope.locator('p,h2,h3,h4,a,td,th,summary').evaluateAll(elements => elements.flatMap(element => {
      const painted = element => element.checkVisibility() && ![...function* () {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) yield parent
      }()].some(parent => parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(element))
      const box = element.getBoundingClientRect(), problems = []
      if (!painted(element) || !box.width) return []
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim() || !painted(node.parentElement)) continue
        const range = document.createRange(); range.selectNodeContents(node)
        if ([...range.getClientRects()].some(rect => rect.width && (rect.left < box.left - 1 || rect.right > box.right + 1)))
          problems.push({ text: node.textContent, tag: element.tagName, width: box.width })
      }
      return problems
    }))
  }
  const nativeData = async (from = '2026-08-19', to = '2026-08-21') => {
    const packets = await Promise.all(['business', 'meta', 'website', 'measurement'].map(async section => {
      const response = await context.request.get(`${origin}/api/reporting?section=${section}&from=${from}&to=${to}`)
      assert.equal(response.status(), 200)
      const packet = validateReportingPacket(await response.json())
      assert.deepEqual(packet.context.range, { from, to })
      assert.equal(packet.context.account.name, 'Fictional executive answer studio')
      return packet
    }))
    const latest = packets.reduce((a, b) => Date.parse(a.context.asOf) > Date.parse(b.context.asOf) ? a : b)
    const data = { context: latest.context, ...Object.fromEntries(packets.map(packet => [packet.section, packet.result])) }
    const review = deriveExpertReview(data); assert.deepEqual(review.input.rejectedSources, [])
    return { data, review, finding: review.findings.find(row => row.id === 'business_platform_trend') }
  }
  const openingMatches = async expected => {
    assert.ok(expected.finding)
    await expect(observation()).toHaveText(expected.finding.observation.text)
    for (const date of [expected.data.context.range.from, expected.data.context.range.to, expected.data.context.comparison.from, expected.data.context.comparison.to])
      await expect(opening()).toContainText(date)
    assert.ok(!/healthy|no intervention|increase.*budget|pause/i.test(await observation().innerText()))
    assert.equal(await opening().evaluate(element => element.compareDocumentPosition(document.querySelector('[aria-label="Advertising results"]')) & Node.DOCUMENT_POSITION_FOLLOWING), 4)
  }
  const download = async (label, tag) => {
    const pending = page.waitForEvent('download', { timeout: 25_000 })
    await page.getByRole('button', { name: label, exact: true }).click()
    const file = await pending, bytes = await readFile(await file.path())
    await writeFile(`${output}/${tag}-${file.suggestedFilename()}`, bytes)
    return csvRows(bytes.toString('utf8'))
  }
  const printOpening = async expected => {
    const details = opening().locator(':scope > details'), evidence = findingEvidence(expected.finding)
    await expect(details).not.toHaveAttribute('open', '')
    // Observe native print events after the application's subscriptions. Do not pre-open its disclosure.
    await page.evaluate(() => {
      window.executivePrintEvents = []
      for (const name of ['beforeprint', 'afterprint']) window.addEventListener(name, () => {
        const section = document.querySelector('[data-executive-result]')
        window.executivePrintEvents.push({ name, open: section.querySelector('details').open,
          evidenceCount: section.querySelectorAll('[data-evidence-population]').length })
      })
    })
    await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' })
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
    await expect(details).toHaveAttribute('open', '')
    const cards = opening().locator('[data-evidence-population]')
    await expect(cards).toHaveCount(evidence.length); assert.ok(evidence.length > 0)
    for (let index = 0; index < evidence.length; index++) {
      await expect(cards.nth(index)).toBeVisible()
      await expect(cards.nth(index)).toContainText(evidence[index].metric.label)
    }
    await expect(details).toContainText(expected.finding.counterEvidence.text)
    assert.deepEqual(await bounds(opening()), [])
    await page.pdf({ path: `${output}/executive-opening.pdf`, format: 'A4', printBackground: true })
    await expect(details).not.toHaveAttribute('open', '')
    await page.emulateMedia({ media: 'screen' }); await settled(1440)
    await details.locator(':scope > summary').focus(); await page.keyboard.press('Enter')
    await expect(details).toHaveAttribute('open', '')
    await page.pdf({ path: `${output}/executive-opening-was-open.pdf`, format: 'A4', pageRanges: '1', printBackground: true })
    await expect(details).toHaveAttribute('open', '')
    proof.print = { evidenceCards: evidence.length, originalClosedRestored: true, originalOpenRestored: true,
      events: await page.evaluate(() => window.executivePrintEvents) }
    assert.ok(proof.print.events.filter(event => event.name === 'beforeprint').every(event => event.open && event.evidenceCount === evidence.length))
    await details.locator(':scope > summary').click()
  }

  for (const mode of EXECUTIVE_ANSWER_MODES) {
    await session(origin)
    await page.goto(`${origin}/preview?scenario=executive-answer-${mode}`, { waitUntil: 'domcontentloaded' })
    const expected = await nativeData(); await openingMatches(expected)
    const text = await observation().innerText()
    if (mode === 'opposing') assert.match(text, /booked value fell.*(opposed|opposite).*Meta.*20/i)
    if (mode === 'payments') assert.match(text, /booked value rose.*recorded amount paid fell/i)
    if (mode === 'aligned') assert.match(text, /aligned/i)
    if (mode === 'partial-payment') { assert.match(text, /booked value rose/i); assert.doesNotMatch(text, /recorded amount paid (rose|fell)/i) }
    if (mode === 'business-missing') { assert.match(text, /booked value: unavailable/i); assert.match(text, /AppointmentConfirmed.*20/i) }
    if (mode === 'meta-missing') { assert.match(text, /booked value fell.*\$400/i); assert.match(text, /Meta observations are unavailable/i) }
    if (mode === 'settling') assert.match(text, /AppointmentConfirmed[^;]*20[^;]*(settling|partial)/i)
    if (mode === 'stable') {
      assert.equal(expected.finding.status, 'unchanged')
      const highlights = overviewFindings(expected.review).filter(row => row.id !== 'business_platform_trend')
      assert.ok(highlights.some(row => row.zeroOutcomeSpend)); assert.ok(highlights.some(row => row.direction === 'improved'))
      for (const row of highlights) await expect(page.locator(`[data-review-id="${row.id}"]`)).toHaveCount(1)
      const performance = page.getByRole('region', { name: 'Campaign and ad-set performance', exact: true })
      await expect(performance).toContainText('10 of 10 ad sets')
      await expect(performance.getByRole('link', { name: 'Lower-spend exception', exact: true })).toBeVisible()
      const unknown = performance.getByRole('row').filter({ has: page.getByRole('link', { name: 'Unmeasured bookings', exact: true }) })
      await expect(unknown).toContainText('Unavailable')
      assert.equal(expected.data.meta.data.entities.find(row => row.id === 'set-7').metrics.bookings.current.value, 0)
      assert.equal(expected.data.meta.data.entities.find(row => row.id === 'set-10').metrics.bookings.current.availability.state, 'unavailable')
      assert.equal(await page.getByRole('region', { name: 'What deserves a closer look', exact: true }).evaluate(element => element.compareDocumentPosition(document.querySelector('[aria-label="Campaign and ad-set performance"]')) & Node.DOCUMENT_POSITION_FOLLOWING), 4)
      proof.stableHighlights = highlights.map(row => row.id)
    }
    for (const width of [1440, 320]) {
      await settled(width); await focus(opening()); assert.deepEqual(await bounds(opening()), [], `${mode} opening fits ${width}`)
      await page.screenshot({ path: `${output}/${mode}-${width}.png` })
      await observation().screenshot({ path: `${output}/${mode}-observation-${width}.png` })
    }
    await settled(1440)
    proof.scenarios[mode] = { observation: text, status: expected.finding.status, range: expected.data.context.range,
      comparison: expected.data.context.comparison, asOf: expected.data.context.asOf, nativeSourceValidation: true }
    if (mode !== 'opposing') continue

    const probe = await context.newPage()
    await probe.setContent('<div id="fits"><p style="width:160px;white-space:nowrap">$12345.6789</p></div><div id="bad"><p style="width:16px;white-space:nowrap">$12345.6789</p></div>')
    assert.deepEqual(await bounds(probe.locator('#fits')), []); assert.equal((await bounds(probe.locator('#bad'))).length, 1)
    await probe.close(); proof.geometryControl = { positive: true, oversizedRejected: true }
    await printOpening(expected)
    const search = page.getByRole('searchbox', { name: 'Search ad sets', exact: true })
    await search.fill('Improving lower-spend result'); await state({ overview_q: 'Improving lower-spend result' })
    const before = page.url()
    for (const [label, destination] of [
      ['Business detail', { path: '/reports', report: 'business', hash: '#business-results' }],
      ['Ad performance', { path: '/performance', level: 'adset', group: 'results' }],
      ['Full assessment', { path: '/reports', report: 'results', review_q: 'business_platform_trend', hash: '#full-assessments' }],
    ]) {
      await opening().getByRole('link', { name: label, exact: true }).focus(); await page.keyboard.press('Enter')
      await state({ ...destination, from: '2026-08-19', to: '2026-08-21' })
      if (label === 'Business detail') await expect(page.getByRole('region', { name: 'Business results', exact: true })).toContainText('$400.00')
      if (label === 'Ad performance') await expect(page.getByRole('region', { name: 'Entity metrics, scroll for more columns', exact: true })).toContainText('Lower-spend exception')
      if (label === 'Full assessment') {
        await expect(full().locator(':scope > p').last()).toHaveText(text)
        const rows = await download('Export full results', 'opposing')
        for (const ref of findingEvidence(expected.finding)) {
          const row = rows.find(row => row.claim_id === ref.metric.current.claimId)
          assert.ok(row, `Native current claim ${ref.metric.key} exported`)
          assert.equal(row.previous_claim_id, ref.metric.previous.claimId)
          assert.equal(row.value, String(ref.metric.current.value)); assert.equal(row.previous_value, String(ref.metric.previous.value))
          assert.deepEqual(JSON.parse(row.input_claim_ids), ref.metric.current.inputClaimIds)
          assert.deepEqual(JSON.parse(row.previous_input_claim_ids), ref.metric.previous.inputClaimIds)
        }
        proof.exportRows = rows.length
      }
      await page.goBack({ waitUntil: 'domcontentloaded' }); await expect.poll(() => page.url()).toBe(before)
      await openingMatches(expected); await expect(search).toHaveValue('Improving lower-spend result')
    }
    await page.reload({ waitUntil: 'domcontentloaded' }); await openingMatches(expected); await expect(search).toHaveValue('Improving lower-spend result')
    await page.getByTitle('Change the date range (applies across pages)').click()
    await page.getByLabel('From date', { exact: true }).fill('2026-08-16')
    await page.getByLabel('To date', { exact: true }).fill('2026-08-18'); await page.keyboard.press('Escape')
    await state({ from: '2026-08-16', to: '2026-08-18' })
    const changed = await nativeData('2026-08-16', '2026-08-18'); await openingMatches(changed)
    assert.equal(changed.data.business.data.metrics.booked_value.current.value, 1000)
    assert.equal(changed.data.business.data.metrics.booked_value.previous.value, 0)
    assert.equal(changed.data.meta.data.metrics.bookings.current.value, 10)
    await page.reload({ waitUntil: 'domcontentloaded' }); await openingMatches(changed)
    proof.navigation = { exactDestinations: true, backReloadFilter: true, nativeChangedDates: true }
  }

  // Read-only compatibility proof against the existing S2 stored original; no report creation or source mutation.
  await session(savedOrigin)
  // Establish the fictional cookie over HTTP without mounting current reporting and racing its source requests.
  assert.equal((await context.request.get(`${savedOrigin}/preview?scenario=normal`)).status(), 200)
  const original = JSON.parse(await readFile('test-results/reporting-preview/saved-reports/results.json', 'utf8')).original
  assert.ok(original?.id)
  const storedResponse = await context.request.get(`${savedOrigin}/api/reporting/saved/${original.id}`)
  assert.equal(storedResponse.status(), 200)
  const stored = await validateSavedReportReply(await storedResponse.json())
  const historical = stored.review.findings.find(row => row.id === 'business_platform_trend')
  assert.ok(historical)
  const currentText = deriveExpertReview(stored.data).findings.find(row => row.id === historical.id).observation.text
  assert.notEqual(historical.observation.text, currentText)
  const audit = async () => (await context.request.get(`${savedOrigin}/__fixture/audit`)).json()
  const before = await audit()
  const requestOffset = requests.length
  await page.goto(`${savedOrigin}/dashboard?saved=${original.id}`, { waitUntil: 'domcontentloaded' })
  await expect(observation()).toHaveText(historical.observation.text)
  for (const link of await opening().getByRole('link').all()) assert.equal(new URL(await link.getAttribute('href'), savedOrigin).searchParams.get('saved'), original.id)
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(observation()).toHaveText(historical.observation.text)
  const after = await audit(); assert.equal(after.liveReads, before.liveReads); assert.equal(after.liveRefreshes, before.liveRefreshes)
  assert.ok(requests.slice(requestOffset).every(request => request.path.startsWith('/api/reporting/saved/')))
  proof.savedOriginal = { id: original.id, observation: historical.observation.text, currentDerivedText: currentText, originalPreserved: true }
  await page.screenshot({ path: `${output}/saved-original.png` })
  assert.deepEqual(errors, [])
  proof.result = 'pass'; proof.finishedAt = new Date().toISOString(); console.log(JSON.stringify(proof))
} catch (error) {
  proof.result = 'failed'; proof.error = String(error)
  if (page) { proof.url = page.url(); await page.screenshot({ path: `${output}/failure.png` }).catch(() => {}) }
  throw error
} finally {
  if (browser) await browser.close()
  await writeFile(`${output}/results.json`, JSON.stringify({ ...proof, errors, blocked, requests }, null, 2))
}
