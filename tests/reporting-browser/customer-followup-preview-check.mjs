import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validatePreparedReportingReply } from '../../src/lib/reporting/prepared-validation.ts'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'

const expect = playwrightExpect.configure({ timeout: 25_000 })
const preview = 'http://127.0.0.1:3149', saved = 'http://127.0.0.1:3150'
const output = 'test-results/reporting-preview/customer-followup'
const proof = { startedAt: new Date().toISOString(), scope: 'ordinary fictional equal-follow-up customer results',
  checkerSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') }
const errors = [], blocked = [], fixtureMediaBlocked = [], reportingResponses = []
let browser, context, page

function csvRows(csv) {
  const lines = []; let row = [], cell = '', quoted = false
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = ''
      if (char === '\n') { lines.push(row); row = [] }
    } else cell += char
  }
  if (cell || row.length) { row.push(cell); lines.push(row) }
  const headings = lines.shift().map(value => value.replace(/^\uFEFF/, ''))
  return lines.map(values => Object.fromEntries(headings.map((heading, index) => [heading, values[index]])))
}

async function newSession(origin) {
  if (context) await context.close()
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  context.setDefaultTimeout(25_000)
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url())
    const allowedOrigin = [preview, saved].includes(url.origin)
    const savedPost = url.origin === saved && request.method() === 'POST'
      && ['/api/reporting', '/api/reporting/saved', '/__fixture/current'].includes(url.pathname)
    if (allowedOrigin && (['GET', 'HEAD'].includes(request.method()) || savedPost)) return route.continue()
    if (url.origin === 'https://example.test' && url.pathname === '/creative.jpg' && request.method() === 'GET') {
      fixtureMediaBlocked.push(url.href); return route.abort('blockedbyclient')
    }
    blocked.push({ origin: url.origin, method: request.method(), path: url.pathname }); return route.abort('blockedbyclient')
  })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', async response => {
    const url = new URL(response.url())
    if (url.pathname !== '/api/reporting') return
    reportingResponses.push({ method: response.request().method(), status: response.status(),
      url: `${url.pathname}${url.search}`, body: response.status() >= 400 ? await response.text().catch(() => '') : '' })
  })
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
}

async function settled(width) {
  await page.setViewportSize({ width, height: 1000 })
  await page.evaluate(() => document.fonts.ready)
  await expect.poll(() => page.locator('#primary-nav').evaluate((nav, mobile) =>
    (mobile ? nav.inert && nav.getAttribute('aria-hidden') === 'true' && getComputedStyle(nav).visibility === 'hidden'
      : getComputedStyle(nav).visibility === 'visible')
    && nav.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'), width < 1024)).toBe(true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
}

async function focus(target) {
  await target.evaluate(element => {
    const main = document.getElementById('main-content')
    main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16
  })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function download(label, tag) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: label, exact: true }).click()
  const file = await pending, bytes = await readFile(await file.path())
  await writeFile(`${output}/${tag}-${file.suggestedFilename()}`, bytes)
  return csvRows(bytes.toString('utf8'))
}

async function saveReport(title) {
  const details = page.locator('section[aria-label="Report actions"] details').first()
  await details.evaluate(element => { element.open = true })
  const input = details.getByLabel('Report name', { exact: true })
  await expect(input).toBeVisible()
  await input.fill(title)
  const button = details.getByRole('button', { name: 'Save this report', exact: true })
  await expect(button).toBeEnabled().catch(async error => {
    const actionText = await details.innerText().catch(() => null)
    const workspaceStatus = await page.locator('[data-reporting-workspace] [role="status"]').allTextContents().catch(() => [])
    const sourceCards = await page.locator('[data-source-state]').evaluateAll(elements => elements.map(element => element.textContent)).catch(() => [])
    throw new Error(`save_not_ready: ${JSON.stringify({ title, actionText, workspaceStatus, sourceCards,
      reportingResponses, url: page.url(), reason: error.message })}`)
  })
  const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/reporting/saved'
    && item.request().method() === 'POST', { timeout: 8_000 }).catch(async error => {
    const alert = await details.getByRole('alert').innerText({ timeout: 500 }).catch(() => null)
    const state = await button.evaluate(element => ({ disabled: element.hasAttribute('disabled'),
      text: element.textContent, url: location.href }))
    throw new Error(`save_post_missing: ${JSON.stringify({ title, alert, state, reason: error.message })}`)
  })
  await button.click()
  const result = await response
  if (result.status() !== 200) assert.equal(result.status(), 200, await result.text())
  await page.waitForURL(url => /^[0-9a-f-]{36}$/.test(url.searchParams.get('saved') ?? ''))
  return new URL(page.url()).searchParams.get('saved')
}

async function mode(value) {
  const response = await context.request.post(`${saved}/__fixture/current`, {
    headers: { Origin: saved }, data: { mode: value, from: '2026-08-02', to: '2026-08-04' },
  })
  if (response.status() !== 200) assert.equal(response.status(), 200, await response.text())
}

async function preparedSources() {
  const range = 'from=2026-08-02&to=2026-08-04'
  return Object.fromEntries(await Promise.all(['meta', 'business', 'website', 'measurement'].map(async section => {
    const response = await context.request.get(`${saved}/api/reporting?section=${section}&${range}`)
    if (response.status() !== 200) assert.equal(response.status(), 200, await response.text())
    const reply = validatePreparedReportingReply(await response.json(), section, range)
    validateReportingPacket(reply.packet)
    return [section, reply.snapshot.id]
  })))
}

try {
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true })

  await newSession(`${preview}/preview?scenario=customer-followup`)
  const packetResponse = await context.request.get(`${preview}/api/reporting?section=business&from=2026-08-02&to=2026-08-04`)
  assert.equal(packetResponse.status(), 200)
  const packet = await packetResponse.json(); validateReportingPacket(packet)
  const customers = packet.result.data.intelligence.customers.data
  assert.deepEqual(customers.followup.horizons.map(row => row.id), ['7_day', '14_day', '30_day'])
  const seven = customers.followup.horizons[0].metrics
  assert.deepEqual([seven.eligible_customers.current.value, seven.repeat_customers.current.value,
    seven.repeat_rate.current.value, seven.repeat_rate.previous.value], [2, 0, 0, 100])
  assert.ok(!JSON.stringify(packet).includes('@example.test'))

  const summary = () => page.locator('[data-customer-followup-result="business_customer_followup"]')
  await expect(summary()).toHaveCount(1)
  const reviewText = await summary().locator(':scope > p').nth(1).innerText()
  for (const clause of ['At 7-day follow-up', '0 of 2 eligible current-cohort customers',
    'Prior: 2 of 2 eligible customers (100%)', 'Observed through 2026-09-07']) assert.ok(reviewText.includes(clause), clause)
  await expect(page.getByRole('region', { name: 'Business results', exact: true })).toContainText('$1,250.00')
  for (const width of [1440, 390, 320]) {
    await settled(width); await focus(summary()); await expect(summary()).toBeVisible()
    await page.screenshot({ path: `${output}/overview-${width}.png` })
  }

  await settled(1440)
  await page.getByRole('link', { name: 'Explore customer groups', exact: true }).click()
  await expect.poll(() => new URL(page.url()).hash).toBe('#business-customers')
  const detail = page.locator('#business-customer-followup')
  await expect(detail).toContainText(reviewText)
  const table = detail.getByRole('region', { name: 'Equal follow-up customer results, scroll for columns' })
  await expect(table.locator('tbody tr')).toHaveCount(3)
  await expect(table.getByRole('rowheader')).toHaveText(['7-day follow-up', '14-day follow-up', '30-day follow-up'])
  assert.equal(await table.locator('tbody tr').first().locator('td').count(), 7)
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(detail).toContainText(reviewText)
  const rows = await download('Export full business report', 'business')
  const followupRows = rows.filter(row => row.entity.startsWith('Acuity first-observed customer follow-up'))
  assert.equal(followupRows.length, 21)
  assert.equal(followupRows.filter(row => row.entity.includes('7-day follow-up') && row.metric === 'Repeat rate'
    && row.value === '0' && row.previous_value === '100').length, 1)
  assert.ok(followupRows.every(row => row.limitations.includes('Observed through 2026-09-07')))
  assert.ok(!JSON.stringify(followupRows).match(/@example\.test|refund|return|cancel/i))
  await page.getByRole('tab', { name: /^Results/ }).click()
  await page.getByRole('searchbox', { name: 'Search assessments', exact: true }).fill('business_customer_followup')
  const finding = page.locator('[data-review-id="business_customer_followup"]')
  await expect(finding).toHaveCount(1); await expect(finding).toContainText(reviewText)
  await finding.getByText('Read full observation', { exact: true }).click()
  await expect(finding.locator('[data-evidence-population]')).toHaveCount(7)
  await page.getByRole('tab', { name: /^Business/ }).click()
  for (const width of [1440, 390, 320]) {
    await settled(width); await focus(detail); await expect(detail).toBeVisible()
    if (width < 1024) {
      await table.focus(); await page.keyboard.press('ArrowRight')
      await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    }
    await page.screenshot({ path: `${output}/detail-${width}.png` })
  }
  await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' })
  await focus(detail); await page.pdf({ path: `${output}/customer-followup.pdf`, format: 'A4', printBackground: true })
  proof.current = { reviewText, exportRows: followupRows.length, horizons: 3,
    views: ['overview', 'business detail', 'results assessment', 'csv', 'print', '1440', '390', '320'] }

  await newSession(`${saved}/preview?scenario=normal`)
  await mode('legacy')
  await page.goto(`${saved}/dashboard?from=2026-08-02&to=2026-08-04`, { waitUntil: 'domcontentloaded' })
  const legacySnapshots = await preparedSources()
  await expect(page.getByRole('button', { name: 'Save this report', exact: true, includeHidden: true })).toBeEnabled()
  const oldId = await saveReport('Original customer report without follow-up')
  await newSession(`${saved}/preview?scenario=normal`)
  await mode('followup')
  await page.goto(`${saved}/dashboard?from=2026-08-02&to=2026-08-04`, { waitUntil: 'domcontentloaded' })
  const followupSnapshots = await preparedSources()
  await expect(summary()).toContainText('At 7-day follow-up')
  const newText = await summary().locator(':scope > p').nth(1).innerText()
  const newId = await saveReport('Equal follow-up customer report')
  const before = await (await context.request.get(`${saved}/__fixture/audit`)).json()
  await mode('stable')
  await page.goto(`${saved}/reports?report=business&saved=${newId}&from=2026-08-02&to=2026-08-04#business-customer-followup`, { waitUntil: 'domcontentloaded' })
  await expect(summary()).toContainText(newText)
  const afterNew = await (await context.request.get(`${saved}/__fixture/audit`)).json()
  assert.equal(afterNew.liveReads, before.liveReads); assert.equal(afterNew.liveRefreshes, before.liveRefreshes)
  await page.goto(`${saved}/reports?report=business&saved=${oldId}&from=2026-08-02&to=2026-08-04#business-customers`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-customer-result="business_customers"]')).toHaveCount(1)
  await expect(summary()).toHaveCount(0)
  const afterOld = await (await context.request.get(`${saved}/__fixture/audit`)).json()
  assert.equal(afterOld.liveReads, before.liveReads); assert.equal(afterOld.liveRefreshes, before.liveRefreshes)
  proof.saved = { oldId, newId, newText, legacySnapshots, followupSnapshots,
    savedReadsWithoutLiveSubstitution: true, oldPacketUnchanged: true }
  proof.finishedAt = new Date().toISOString(); proof.errors = errors; proof.blocked = blocked
  proof.reportingResponses = reportingResponses
  proof.fixtureMediaBlocked = fixtureMediaBlocked.length
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  await writeFile(`${output}/result.json`, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  proof.finishedAt = new Date().toISOString(); proof.errors = errors; proof.blocked = blocked
  proof.reportingResponses = reportingResponses
  proof.fixtureMediaBlocked = fixtureMediaBlocked.length
  proof.failure = error instanceof Error ? error.stack : String(error)
  await mkdir(output, { recursive: true }); await writeFile(`${output}/result.json`, JSON.stringify(proof, null, 2))
  throw error
} finally { await context?.close(); await browser?.close() }
