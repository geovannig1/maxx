// Run after root confirms source/UI freeze and the customer scenario gateway is ready.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'

const expect = playwrightExpect.configure({ timeout: 20_000 })
const origin = 'http://127.0.0.1:3149', output = 'test-results/reporting-preview/customer-results'
const proof = { startedAt: new Date().toISOString(), baseline: null, scope: 'ordinary fictional customer results',
  checkerSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') }
const errors = [], blocked = [], requests = []
const groupControls = [
  ['prior_booking', [200, 1000], [1, 2], [50, 1000], [1, 6]],
  ['first_observed', [1000, 0], [3, 0], [350, 0], [3, 0]],
  ['unidentified', [200, 200], [1, 1], [200, 200], [1, 1]],
]
const currency = value => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
let browser, page

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
  const headings = rows.shift().map(value => value.replace(/^\uFEFF/, ''))
  return rows.map(values => Object.fromEntries(headings.map((heading, index) => [heading, values[index]])))
}


function nativeText(metric, period) {
  const claim = metric[period], value = claim?.value
  if (value == null || claim.availability.state !== 'available') return 'Unavailable'
  if (claim.unit === 'money') return currency(value)
  if (claim.unit === 'percent') return `${value.toFixed(1)}%`
  if (claim.unit === 'hours') return value.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' h'
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}
function nativeExport(rows, customers, dates = ['2026-09-02', '2026-09-04', '2026-08-30', '2026-09-01']) {
  const selected = rows.filter(row => row.entity.startsWith('Acuity customer'))
  const populations = [[customers.metrics, 'Acuity customer history'], ...customers.groups.map(group =>
    [group.metrics, `Acuity customer cohort · ${group.name} (${group.id})`])]
  assert.equal(selected.length, populations.reduce((sum, [metrics]) => sum + Object.keys(metrics).length, 0))
  for (const [metrics, entity] of populations) for (const metric of Object.values(metrics)) {
    const row = selected.find(row => row.entity === entity && row.metric === metric.label)
    assert.ok(row, `${entity}: ${metric.label}`)
    for (const [period, valueKey, idKey, inputsKey] of [['current', 'value', 'claim_id', 'input_claim_ids'], ['previous', 'previous_value', 'previous_claim_id', 'previous_input_claim_ids']]) {
      const claim = metric[period]
      assert.equal(row[valueKey], claim.availability.state === 'available' && claim.value !== null ? String(claim.value) : '')
      assert.equal(row[idKey], claim.claimId); assert.deepEqual(JSON.parse(row[inputsKey]), claim.inputClaimIds)
    }
    assert.equal(row.source, 'outcomes'); assert.equal(row.from, dates[0]); assert.equal(row.to, dates[1])
    assert.equal(row.comparison_from, dates[2]); assert.equal(row.comparison_to, dates[3])
    assert.equal(row.date_basis, 'booking_created_date_et'); assert.ok(row.limitations.includes('retained ledger'))
  }
  assert.ok(!JSON.stringify(rows).includes('@example.test'))
  return selected
}

try {
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  context.setDefaultTimeout(20_000)
  // Destination/method guard only; no local response replacement or native data mutation.
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin === origin && ['GET', 'HEAD'].includes(request.method())) return route.continue()
    blocked.push({ origin: url.origin, method: request.method() }); return route.abort('blockedbyclient')
  })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/reporting') requests.push(request.url()) })
  const summary = () => page.locator('[data-customer-result="business_customers"]')
  const customerSection = () => page.locator('#business-customers')
  const customerTables = () => customerSection().getByRole('region')
  const finding = () => page.locator('[data-review-id="business_customers"]')
  let dateScope = 'Booking creation dates 2026-09-02 – 2026-09-04; previous 2026-08-30 – 2026-09-01 · America/New_York.'
  const observation = async () => {
    await expect(summary()).toHaveCount(1)
    await expect(summary().locator(':scope > p').first()).toHaveText(dateScope)
    assert.equal(await summary().evaluate(element => {
      const qualification = [...element.closest('section').querySelectorAll('p')].find(item => item.textContent.startsWith('Customer history:'))
      return !!qualification && element.getBoundingClientRect().bottom <= qualification.getBoundingClientRect().top
    }), true, 'Customer answer precedes detailed source qualifications')
    return summary().locator(':scope > p').last().innerText()
  }
  const source = async (section, from = '2026-09-02', to = '2026-09-04') => {
    const response = await context.request.get(`${origin}/api/reporting?section=${section}&from=${from}&to=${to}`)
    assert.equal(response.status(), 200)
    const packet = await response.json(); validateReportingPacket(packet)
    assert.deepEqual(packet.context.range, { from, to }); assert.equal(packet.context.account.name, 'Studio test account')
    assert.equal(packet.context.timezone, 'America/New_York'); assert.equal(packet.context.currency, 'USD')
    assert.ok(!JSON.stringify(packet).includes('@example.test'))
    return packet
  }
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
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(() => page.locator('#primary-nav').evaluate((nav, mobile) =>
      (mobile ? nav.inert && nav.getAttribute('aria-hidden') === 'true' && getComputedStyle(nav).visibility === 'hidden' : getComputedStyle(nav).visibility === 'visible')
      && nav.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'), width < 1024)).toBe(true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  }
  const bounds = async scope => scope.locator('td,th,p,h3,summary').evaluateAll(elements => elements.flatMap(element => {
    const painted = element => {
      if (!element.checkVisibility()) return false
      for (let parent = element.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false
      return true
    }
    const box = element.getBoundingClientRect(), problems = []
    if (!painted(element) || !box.width) return []
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || !painted(node.parentElement)) continue
      const range = document.createRange(); range.selectNodeContents(node)
      if ([...range.getClientRects()].some(rect => rect.width && (rect.left < box.left - 1 || rect.right > box.right + 1)))
        problems.push({ text: node.textContent, tag: element.tagName, width: box.width, textWidth: range.getBoundingClientRect().width })
    }
    return problems
  }))
  const download = async label => {
    const pending = page.waitForEvent('download', { timeout: 20_000 })
    await page.getByRole('button', { name: label, exact: true }).click()
    const file = await pending, csv = await readFile(await file.path(), 'utf8')
    await writeFile(`${output}/${file.suggestedFilename()}`, csv)
    return csvRows(csv)
  }
  const checkTables = async customers => {
    const fields = [['customers', 'bookings', 'paid_bookings', 'amount_paid', 'booked_value'],
      ['bookings', 'recorded_booked_hours', 'hours_per_recorded_booking', 'duration_recorded_bookings', 'duration_coverage']]
    await expect(customerTables()).toHaveCount(2)
    for (const [index, keys] of fields.entries()) {
      const table = customerTables().nth(index)
      await expect(table.locator('tbody tr')).toHaveCount(3)
      for (const group of customers.groups) {
        const row = table.locator('tbody tr').filter({ has: page.getByRole('rowheader', { name: group.name, exact: true }) })
        for (const [column, key] of keys.entries()) {
          const metric = group.metrics[key], cell = row.locator('td').nth(column)
          await expect(cell.locator('summary')).toHaveText(nativeText(metric, 'current'))
          await expect(cell).toContainText(`Previous: ${nativeText(metric, 'previous')}`)
        }
      }
    }
  }

  // Relevant good/bad geometry controls in a separate document, before native app navigation.
  await page.setContent('<div id="fits"><p style="width:160px;white-space:nowrap">$12345.6789</p></div><div id="bad"><p style="width:16px;white-space:nowrap">$12345.6789</p></div>')
  assert.deepEqual(await bounds(page.locator('#fits')), []); assert.equal((await bounds(page.locator('#bad'))).length, 1)
  proof.geometryControl = { fittingAccepted: true, oversizedRejected: true }
  await page.goto(`${origin}/preview?scenario=customers`, { waitUntil: 'domcontentloaded' })
  const packets = Object.fromEntries(await Promise.all(['meta', 'business', 'website', 'measurement'].map(async section => [section, await source(section)])))
  const native = packets.business.result.data, customers = native.intelligence.customers.data
  assert.deepEqual(customers.groups.map(group => group.id), groupControls.map(([id]) => id))
  for (const [key, current, previous] of [['booked_value', 1400, 1200], ['amount_paid', 600, 1200], ['recorded_booked_hours', 5, 7], ['value_bearing_bookings', 5, 3]]) {
    assert.equal(native.metrics[key].current.value, current); assert.equal(native.metrics[key].previous.value, previous)
  }
  for (const [id, ...values] of groupControls) for (const [index, key] of ['booked_value', 'bookings', 'amount_paid', 'recorded_booked_hours'].entries())
    for (const [periodIndex, period] of ['current', 'previous'].entries())
      assert.equal(customers.groups.find(group => group.id === id).metrics[key][period].value, values[index][periodIndex])
  assert.equal(customers.groups[2].metrics.customers.current.value, null)
  assert.equal((await context.request.get(`${origin}/api/reporting?section=not-a-source`)).status(), 400)
  const overviewText = await observation()
  for (const clause of ['Booked value: $1,400 (prior $1,200; +$200). 5 bookings (prior 3).',
    'Prior booking in retained history: $200 (prior $1,000; −$800). 1 bookings (prior 2).',
    'First observed in retained history: $1,000 (prior $0; +$1,000). 3 bookings (prior 0).',
    'Unidentified bookings: $200 (prior $200; unchanged). 1 bookings (prior 1).',
    'Group gains and losses offset one another.', 'Recorded payments: $600 (prior $1,200).',
    'Recorded hours: 5 (prior 7).', 'Recorded payments and Recorded hours move against booked value.'])
    assert.ok(overviewText.includes(clause), clause)
  proof.movement = { dateScope, answerBeforeQualifications: true, overviewText, totalCurrent: 1400, totalPrior: 1200, groups: groupControls, packetAsOf: packets.business.context.asOf }
  for (const width of [1440, 390, 320]) {
    await settled(width); await focus(page.getByRole('region', { name: 'Customer history summary', exact: true }))
    assert.deepEqual(await bounds(page.getByRole('region', { name: 'Customer history summary', exact: true })), [], `Overview text fits ${width}`)
    await page.screenshot({ path: `${output}/overview-${width}.png` })
  }
  await settled(1440)
  await page.getByRole('link', { name: 'Explore customer groups', exact: true }).focus()
  await page.keyboard.press('Enter')
  await state({ path: '/reports', report: 'business', from: '2026-09-02', to: '2026-09-04', hash: '#business-customers' })
  assert.equal(await observation(), overviewText); await checkTables(customers)
  await page.reload({ waitUntil: 'domcontentloaded' }); assert.equal(await observation(), overviewText)
  await page.goBack({ waitUntil: 'domcontentloaded' }); await state({ path: '/dashboard', from: '2026-09-02', to: '2026-09-04' })
  assert.equal(await observation(), overviewText)
  await page.getByRole('link', { name: 'Explore customer groups', exact: true }).click()
  const businessCsv = await download('Export full business report'), customerCsv = nativeExport(businessCsv, customers)
  await page.getByRole('tab', { name: /^Results/ }).click()
  await page.getByRole('searchbox', { name: 'Search assessments', exact: true }).fill('business_customers')
  await expect(finding()).toHaveCount(1)
  await expect(finding().locator(':scope > p').last()).toHaveText(overviewText)
  await finding().getByText('Read full observation', { exact: true }).click()
  for (const group of customers.groups)
    await expect(finding().locator(`[data-evidence-population="${group.metrics.booked_value.current.entity.id}"]`)).not.toHaveCount(0)
  const resultsCsv = await download('Export full results')
  assert.deepEqual(nativeExport(resultsCsv, customers), customerCsv)
  proof.exports = { businessRows: businessCsv.length, resultsRows: resultsCsv.length, customerRows: customerCsv.length, nativeCurrentPriorIds: true }
  await page.getByRole('tab', { name: /^Business/ }).click(); await checkTables(customers)
  for (const width of [1440, 390, 320]) {
    await settled(width); await focus(customerSection())
    assert.deepEqual(await bounds(customerSection()), [], `Customer columns fit ${width}`)
    for (const table of await customerTables().all()) if (width < 1024) {
      await table.focus(); await page.keyboard.press('ArrowRight')
      await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    }
    await focus(customerSection()); await page.screenshot({ path: `${output}/detail-${width}.png` })
  }
  await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' })
  assert.deepEqual(await bounds(customerSection()), [], 'A4 customer labels/values stay inside their columns')
  const wrapped = await customerSection().locator('td summary').evaluateAll(elements => elements.flatMap(element => {
    const range = document.createRange(); range.selectNodeContents(element)
    const lines = new Set([...range.getClientRects()].filter(rect => rect.width).map(rect => rect.top)).size
    return lines > 1 ? [{ value: element.textContent, lines }] : []
  }))
  assert.deepEqual(wrapped, [], 'A4 numeric values cannot wrap into character columns')
  await page.pdf({ path: `${output}/customer-results.pdf`, format: 'A4', printBackground: true })
  proof.print = { groups: 3, tables: 2, valueWraps: wrapped, observation: overviewText }
  await page.emulateMedia({ media: 'screen' }); await settled(1440)
  await page.getByTitle('Change the date range (applies across pages)').click()
  await page.getByLabel('From date', { exact: true }).fill('2026-08-30')
  await page.getByLabel('To date', { exact: true }).fill('2026-09-01'); await page.keyboard.press('Escape')
  await state({ from: '2026-08-30', to: '2026-09-01', report: 'business' })
  const historical = (await source('business', '2026-08-30', '2026-09-01')).result.data
  assert.equal(historical.metrics.booked_value.current.value, 1200); assert.equal(historical.metrics.booked_value.previous.value, 0)
  dateScope = 'Booking creation dates 2026-08-30 – 2026-09-01; previous 2026-08-27 – 2026-08-29 · America/New_York.'
  await expect(summary().locator(':scope > p').last()).not.toHaveText(overviewText)
  const changedText = await observation(); assert.ok(changedText.includes('1,200'))
  await page.reload({ waitUntil: 'domcontentloaded' }); assert.equal(await observation(), changedText)
  const historicalCsv = await download('Export full business report')
  const historicalCustomerRows = nativeExport(historicalCsv, historical.intelligence.customers.data, ['2026-08-30', '2026-09-01', '2026-08-27', '2026-08-29'])
  proof.changedDates = { from: '2026-08-30', to: '2026-09-01', current: 1200, previous: 0, observation: changedText, customerExportRows: historicalCustomerRows.length }

  await page.goto(`${origin}/preview?scenario=customers-stable`, { waitUntil: 'domcontentloaded' })
  dateScope = 'Booking creation dates 2026-09-02 – 2026-09-04; previous 2026-08-30 – 2026-09-01 · America/New_York.'
  const stable = (await source('business')).result.data
  assert.equal(stable.metrics.booked_value.current.value, 1000); assert.equal(stable.metrics.booked_value.previous.value, 1000)
  const stableText = await observation()
  assert.match(stableText, /unchanged|stable/i)
  await page.goto(`${origin}/reports?from=2026-09-02&to=2026-09-04&review_q=business_customers`, { waitUntil: 'domcontentloaded' })
  await expect(finding().locator(':scope > p').last()).toHaveText(stableText)
  await expect(finding()).toContainText(/no intervention|no change.*justif|does not justify.*intervention/i)
  proof.stable = { observation: stableText, noIntervention: true }
  await page.goto(`${origin}/preview?scenario=customers-missing`, { waitUntil: 'domcontentloaded' })
  const missing = (await source('business')).result.data
  assert.equal(missing.intelligence.customers.data, null); assert.equal(missing.metrics.booked_value.current.value, 1400)
  await expect(summary()).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Customer history summary', exact: true })).toContainText('Customer history could not be loaded')
  await expect(page.getByRole('region', { name: 'Business results', exact: true })).toContainText('$1,400.00')
  const healthy = await Promise.all(['meta', 'website', 'measurement'].map(section => source(section)))
  assert.ok(healthy.every(packet => packet.result.data !== null))
  await page.getByRole('link', { name: 'Explore customer groups', exact: true }).click()
  await expect(customerSection()).toContainText('Customer history could not be loaded'); await expect(customerTables()).toHaveCount(0)
  assert.ok(!await page.locator('#main-content').innerText().then(text => text.includes('@example.test')))
  proof.missing = { customerUnavailable: true, headlineRetained: 1400, healthyOtherPackets: 3 }
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
