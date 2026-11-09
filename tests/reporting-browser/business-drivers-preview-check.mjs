// Run after root confirms integration: TSX_TSCONFIG_PATH=tsconfig.scripts.json node --import tsx tests/reporting-browser/business-drivers-preview-check.mjs
// Ordinary fictional gateway replies stay unchanged. External requests are blocked.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'

const expect = playwrightExpect.configure({ timeout: 20_000 })
const origin = 'http://127.0.0.1:3149', output = 'test-results/reporting-preview/business-drivers'
const check = process.env.BUSINESS_DRIVERS_CHECK ?? 'full'
assert.ok(['full', 'search'].includes(check))
const controls = [
  ['01 Native service', 1000, 500, 500, 0, 500],
  ['02 Native service', 700, 400, 300, 0, 300],
  ['03 Native service', 400, 400, 0, 0, 0],
  ['04 Native service', 400, 400, 0, 0, 0],
  ['05 Native service', 300, 300, 0, 0, 0],
  ['06 Native service', 200, 150, 50, 0, 50],
  ['07 Low-volume seventh service', 200, 50, 150, 0, 150],
  ['08 Prior-only service', 0, 500, -500, null, null],
]
const dollars = value => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${dollars(Math.abs(value))}`
const proof = { startedAt: new Date().toISOString(), scope: 'ordinary fictional business drivers', check }
const errors = [], blocked = [], responses = []
let browser, page

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
  const headings = rows.shift().map(value => value.replace(/^\uFEFF/, ''))
  return rows.map(values => Object.fromEntries(headings.map((heading, index) => [heading, values[index]])))
}

try {
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  // A destination/method guard only: no fulfill, response replacement or source-body mutation.
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin === origin && ['GET', 'HEAD'].includes(request.method())) return route.continue()
    blocked.push({ origin: url.origin, method: request.method() }); return route.abort('blockedbyclient')
  })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname === '/api/reporting') responses.push({ section: url.searchParams.get('section'), status: response.status() })
  })
  const drivers = () => page.locator('#business-drivers')
  const rows = () => drivers().locator('[data-business-driver]')
  const services = () => page.locator('#business-types [data-business-service]')
  const download = async label => {
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: label, exact: true }).click()
    const file = await pending, csv = await readFile(await file.path(), 'utf8')
    await writeFile(`${output}/${file.suggestedFilename()}`, csv)
    return csvRows(csv)
  }
  const exactDestination = async (hash, query = null) => {
    await expect.poll(() => {
      const url = new URL(page.url())
      return { path: url.pathname, report: url.searchParams.get('report'), from: url.searchParams.get('from'),
        to: url.searchParams.get('to'), hash: url.hash, query: url.searchParams.get('business_q') }
    }).toEqual({ path: '/reports', report: 'business', from: '2026-09-02', to: '2026-09-04', hash, query })
  }
  const focus = async target => {
    await target.evaluate(element => {
      const main = document.getElementById('main-content')
      main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16
    })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const textCrossings = () => drivers().locator('td,th').evaluateAll(cells => cells.flatMap(cell => {
    const box = cell.getBoundingClientRect(), range = document.createRange()
    if (!cell.getClientRects().length) return []
    // Measure actual visible text fragments, including wrapped evidence and prior values.
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT), problems = []
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim()) continue
      range.selectNodeContents(text)
      if ([...range.getClientRects()].some(rect => rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1)))
        problems.push({ text: text.textContent, width: box.width, textWidth: range.getBoundingClientRect().width })
    }
    return problems
  }))

  await page.goto(`${origin}/preview?scenario=business`, { waitUntil: 'domcontentloaded' })
  const response = await context.request.get(`${origin}/api/reporting?section=business&from=2026-09-02&to=2026-09-04`)
  assert.equal(response.status(), 200)
  const packet = await response.json(); validateReportingPacket(packet)
  const native = packet.result.data, totals = native.metrics
  assert.equal(packet.context.account.name, 'Studio test account')
  assert.deepEqual(packet.context.range, { from: '2026-09-02', to: '2026-09-04' })
  assert.deepEqual(packet.context.comparison, { from: '2026-08-30', to: '2026-09-01' })
  assert.equal(packet.context.timezone, 'America/New_York')
  assert.equal(totals.booked_value.current.value, 3200); assert.equal(totals.booked_value.previous.value, 2700)
  assert.equal(totals.value_bearing_bookings.current.value, 8); assert.equal(totals.value_bearing_bookings.previous.value, 9)
  assert.equal(totals.amount_paid.current.coverage.state, 'partial')
  assert.equal(totals.recorded_booked_hours.current.coverage.state, 'partial')
  for (const [name, current, previous] of controls) {
    const service = native.types.find(row => row.name === name)
    assert.ok(service); assert.equal(service.metrics.booked_value.current.value, current); assert.equal(service.metrics.booked_value.previous.value, previous)
  }
  assert.equal((await context.request.get(`${origin}/api/reporting?section=not-a-source`)).status(), 400)
  assert.ok(!JSON.stringify(packet).includes('@example.test'))
  proof.nativePacket = { services: native.types.length, current: 3200, previous: 2700, change: 500, gain: 1000, loss: -500 }

  await expect(page.getByRole('heading', { name: 'What explains booked value', exact: true })).toBeVisible()
  const overview = drivers()
  await expect(overview).toContainText('+$500.00')
  await expect(overview).toContainText('8 of 8 services')
  await page.getByRole('link', { name: 'Explore booked-value drivers', exact: true }).click()
  await exactDestination('#business-drivers')
  await expect(rows()).toHaveCount(8)
  await expect(drivers()).toContainText('Booking-count component')
  await expect(drivers()).toContainText('Value-per-booking component')
  await expect(drivers()).toContainText('complete duration')
  const displayedChanges = []
  for (const [name, current, previous, change] of controls) {
    const row = rows().filter({ hasText: name })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('cell')).toHaveText([dollars(previous), dollars(current), signed(change)])
    displayedChanges.push(Number((await row.getByRole('cell').nth(2).textContent()).replace('−', '-').replace(/[^0-9.-]/g, '')))
  }
  assert.equal(displayedChanges.filter(value => value > 0).reduce((sum, value) => sum + value, 0), 1000)
  assert.equal(displayedChanges.filter(value => value < 0).reduce((sum, value) => sum + value, 0), -500)
  assert.equal(displayedChanges.reduce((sum, value) => sum + value, 0), 500)
  await expect(drivers()).toContainText('−$500.00')
  const seventh = rows().filter({ hasText: '07 Low-volume seventh service' })
  const calculation = seventh.locator('summary').filter({ hasText: 'Inspect the calculation' })
  await calculation.focus(); await page.keyboard.press('Enter')
  await expect(seventh).toContainText('Booking-count component: $0.00')
  await expect(seventh).toContainText('Value-per-booking component: +$150.00')
  const evidence = seventh.locator('summary').filter({ hasText: 'Native calculation inputs' })
  await evidence.focus(); await page.keyboard.press('Enter')
  const nativeSeventh = native.types.find(row => row.name === '07 Low-volume seventh service')
  await expect(seventh).toContainText('Previous: $50.00 · Selected: $200.00')
  for (const period of ['current', 'previous']) await expect(seventh).toContainText(nativeSeventh.metrics.booked_value[period].claimId)
  await expect(seventh).toContainText('2026-09-05T17:00:00')
  await evidence.press('Enter')
  await calculation.press('Enter')

  const priorName = '08 Prior-only service', prior = native.types.find(row => row.name === priorName)
  await rows().filter({ hasText: priorName }).getByRole('link').click()
  const priorAnchor = `#business-service-${encodeURIComponent(prior.id)}`
  await exactDestination(priorAnchor, prior.id)
  const target = page.locator(`[id="business-service-${encodeURIComponent(prior.id)}"]`)
  await expect(target).toContainText(priorName)
  await expect.poll(async () => { const box = await target.boundingBox(); return !!box && box.y >= 0 && box.y < 500 }).toBe(true)
  const search = page.getByRole('searchbox', { name: 'Search services', exact: true })
  const searchStaysVisible = async stage => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const geometry = await search.evaluate(element => {
      const box = element.getBoundingClientRect(), main = document.getElementById('main-content').getBoundingClientRect()
      return { visible: box.top >= main.top && box.bottom <= main.bottom, top: box.top, bottom: box.bottom, mainTop: main.top, mainBottom: main.bottom }
    })
    proof.search = [...proof.search ?? [], { stage, ...geometry }]
    assert.equal(geometry.visible, true, `Service search moved outside the viewport: ${JSON.stringify(geometry)}`)
  }
  await expect(search).toHaveValue(prior.id); await expect(services()).toHaveCount(1)
  await expect(services()).toContainText(priorName); await expect(rows()).toHaveCount(8)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await exactDestination(priorAnchor, prior.id); await expect(services()).toHaveCount(1); await expect(rows()).toHaveCount(8)
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await exactDestination('#business-drivers'); await expect(rows()).toHaveCount(8)
  await search.scrollIntoViewIfNeeded(); await searchStaysVisible('before nonexistent query')
  await search.fill('not-a-real-service')
  await expect(services()).toHaveCount(0); await expect(rows()).toHaveCount(8); await expect(drivers()).toContainText('+$500.00')
  await searchStaysVisible('after nonexistent query')
  await search.fill('seventh')
  await expect(services()).toHaveCount(1); await expect(rows()).toHaveCount(8)
  await searchStaysVisible('after seventh query')

  if (check === 'full') {
  const businessCsv = await download('Export full business report')
  const exportedDrivers = businessCsv.filter(row => row.entity.startsWith('Acuity booked-value drivers'))
  assert.equal(exportedDrivers.length, 36)
  assert.equal(exportedDrivers.filter(row => row.metric === 'Booked-value change').length, 9)
  const accountRows = exportedDrivers.filter(row => row.entity.startsWith('Acuity booked-value drivers · Account'))
  for (const [label, value] of [['Booked-value change', 500], ['Booking-count component', -350], ['Value-per-booking component', 850]]) {
    const row = accountRows.find(row => row.metric === label)
    assert.equal(Number(row.value), value); assert.equal(row.previous_value, '')
    for (const key of ['booked_value', 'value_bearing_bookings']) for (const period of ['current', 'previous'])
      assert.ok(row.limitations.includes(totals[key][period].claimId))
  }
  const accountMean = accountRows.find(row => row.metric === 'Value per positive-price booking')
  assert.equal(Number(accountMean.value), 400); assert.equal(Number(accountMean.previous_value), 300)
  for (const [name, , , change, countComponent, valueComponent] of controls) {
    const serviceRows = exportedDrivers.filter(row => row.entity.includes(name))
    const difference = serviceRows.find(row => row.metric === 'Booked-value change')
    assert.equal(Number(difference.value), change)
    assert.equal(difference.source, 'maxx'); assert.equal(difference.date_basis, 'booking_created_date_et')
    assert.equal(difference.from, '2026-09-02'); assert.equal(difference.to, '2026-09-04')
    assert.equal(difference.comparison_from, '2026-08-30'); assert.equal(difference.comparison_to, '2026-09-01')
    const service = native.types.find(row => row.name === name)
    for (const period of ['current', 'previous']) assert.ok(difference.limitations.includes(service.metrics.booked_value[period].claimId))
    assert.equal(difference.previous_value, '')
    const mean = serviceRows.find(row => row.metric === 'Value per positive-price booking')
    for (const [period, column] of [['current', 'value'], ['previous', 'previous_value']]) {
      const bookings = service.metrics.value_bearing_bookings[period].value
      if (bookings === 0) assert.equal(mean[column], '')
      else assert.equal(Number(mean[column]), service.metrics.booked_value[period].value / bookings)
    }
    for (const [label, value] of [['Booking-count component', countComponent], ['Value-per-booking component', valueComponent]]) {
      const component = serviceRows.find(row => row.metric === label)
      assert.ok(component)
      if (value === null) assert.equal(component.value, '')
      else assert.equal(Number(component.value), value)
      assert.ok(component.limitations.includes('/business/data/'))
      if (value !== null) for (const period of ['current', 'previous']) {
        assert.ok(component.limitations.includes(service.metrics.booked_value[period].claimId))
        assert.ok(component.limitations.includes(service.metrics.value_bearing_bookings[period].claimId))
      }
    }
  }
  assert.ok(!JSON.stringify(businessCsv).includes('@example.test'))
  await page.getByRole('tab', { name: /^Results/ }).click()
  const resultsCsv = await download('Export full results')
  assert.deepEqual(resultsCsv.filter(row => row.entity.startsWith('Acuity booked-value drivers')), exportedDrivers)
  proof.exports = { businessRows: businessCsv.length, resultRows: resultsCsv.length, driverRows: exportedDrivers.length, allServiceInputs: true }
  await page.getByRole('tab', { name: /^Business/ }).click()
  await search.scrollIntoViewIfNeeded(); await searchStaysVisible('before clear')
  await page.getByRole('button', { name: 'Clear service search', exact: true }).click()
  await expect(rows()).toHaveCount(8)
  await searchStaysVisible('after clear')

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(() => page.locator('#primary-nav').evaluate((nav, mobile) => {
      const style = getComputedStyle(nav)
      return (mobile ? nav.getAttribute('aria-hidden') === 'true' && nav.inert && style.visibility === 'hidden' : style.visibility === 'visible')
        && nav.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')
    }, width < 1024)).toBe(true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    const region = drivers().getByRole('region').filter({ has: page.locator('table') }).first()
    await region.evaluate(element => { element.scrollLeft = 0 })
    await focus(drivers().getByRole('heading').first())
    await page.screenshot({ path: `${output}/summary-${width}.png` })
    await focus(rows().first())
    await region.evaluate(element => { element.scrollLeft = 0 })
    await page.screenshot({ path: `${output}/contributors-first-${width}.png` })
    await focus(seventh)
    await page.screenshot({ path: `${output}/seventh-service-${width}.png` })
    assert.deepEqual(await textCrossings(), [], `Driver text crosses table cells at ${width}`)
    if (width < 1024) {
      await region.focus(); await page.keyboard.press('ArrowRight')
      await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
      await region.evaluate(element => { element.scrollLeft = element.scrollWidth - element.clientWidth })
      await focus(rows().filter({ hasText: priorName }))
      assert.equal(await page.evaluate(() => document.elementFromPoint(25, 180)?.closest('#primary-nav') !== null), false)
      await page.screenshot({ path: `${output}/contributors-last-${width}.png` })
    }
  }
  await calculation.focus(); await calculation.press('Enter')
  const prePrintStates = await drivers().locator('details[data-business-calculation]').evaluateAll(details => details.map(element => element.open))
  assert.equal(prePrintStates.filter(Boolean).length, 1)
  proof.print = { prePrintStates }
  await drivers().evaluate(element => { window.__businessDriverPrintNode = element })
  await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' })
  await expect(rows()).toHaveCount(8)
  assert.deepEqual(await textCrossings(), [], 'Printed driver values remain inside their cells')
  const table = await drivers().locator('table').boundingBox()
  assert.ok(table.x >= 0 && table.x + table.width <= 795)
  proof.print.beforePdfStates = await drivers().locator('details[data-business-calculation]').evaluateAll(details => details.map(element => element.open))
  assert.deepEqual(proof.print.beforePdfStates, prePrintStates)
  await page.evaluate(() => {
    window.__businessDriverPrintEvents = []
    for (const event of ['beforeprint', 'afterprint']) window.addEventListener(event, () => {
      window.__businessDriverPrintEvents.push({ event, states: [...document.querySelectorAll('#business-drivers details[data-business-calculation]')].map(element => element.open) })
    })
    window.addEventListener('beforeprint', () => {
      const section = document.getElementById('business-drivers'), crossings = []
      for (const cell of section.querySelectorAll('td,th')) {
        const box = cell.getBoundingClientRect(), walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim()) continue
          const range = document.createRange(); range.selectNodeContents(node)
          if ([...range.getClientRects()].some(rect => rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1))) crossings.push(node.textContent)
        }
      }
      window.__businessDriverPrint = { opened: section.querySelectorAll('details[data-business-calculation][open]').length, crossings }
    }, { once: true })
  })
  await page.pdf({ path: `${output}/business-drivers.pdf`, format: 'A4', printBackground: true })
  proof.print.events = await page.evaluate(() => window.__businessDriverPrintEvents)
  proof.print.sameNode = await drivers().evaluate(element => element === window.__businessDriverPrintNode)
  assert.equal(proof.print.sameNode, true, 'Print control lost its original DOM node')
  const printed = await page.evaluate(() => window.__businessDriverPrint)
  assert.deepEqual(printed, { opened: 9, crossings: [] })
  proof.print.afterPdfStates = await drivers().locator('details[data-business-calculation]').evaluateAll(details => details.map(element => element.open))
  assert.deepEqual(proof.print.afterPdfStates, prePrintStates)
  proof.print = { ...proof.print, tableWidth: table.width, services: 8, contentBounds: true, actualBeforePrint: printed }
  await page.emulateMedia({ media: 'screen' })
  } else {
    await page.getByRole('button', { name: 'Clear service search', exact: true }).click()
    await expect(services()).toHaveCount(8); await searchStaysVisible('after clear')
  }
  assert.deepEqual(errors, [])
  assert.ok(responses.some(row => row.section === 'business' && row.status === 200))
  proof.result = 'pass'; proof.finishedAt = new Date().toISOString()
  console.log(JSON.stringify(proof))
} catch (error) {
  proof.result = 'failed'; proof.error = String(error)
  if (page) proof.page = await page.evaluate(() => ({ url: location.href, mainScroll: document.getElementById('main-content')?.scrollTop,
    target: (() => { const element = document.getElementById(location.hash.slice(1)), box = element?.getBoundingClientRect()
      return element ? { id: element.id, y: box.y, height: box.height } : null })() })).catch(() => null)
  if (page) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  throw error
} finally {
  if (browser) await browser.close()
  await writeFile(`${output}/results-${check}.json`, JSON.stringify({ ...proof, errors, responses, blocked }, null, 2))
}
