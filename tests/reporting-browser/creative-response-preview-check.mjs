// Run only after source freeze: TSX_TSCONFIG_PATH=tsconfig.scripts.json node --import tsx tests/reporting-browser/creative-response-preview-check.mjs
// Existing fictional gateway packets are unchanged; this task needs no media server.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'

const expect = playwrightExpect.configure({ timeout: 20_000 })
const origin = 'http://127.0.0.1:3149', output = 'test-results/reporting-preview/creative-response'
const printOnly = process.argv.includes('--print-surfaces')
const responseKeys = ['spend', 'impressions', 'video_2s', 'cost_per_2s_view', 'thruplays', 'cost_per_thruplay',
  'action_video_views', 'cost_per_action_video_view', 'engagements', 'engagement_rate', 'cost_per_engagement',
  'reactions', 'comments', 'shares', 'share_rate', 'cost_per_share', 'saves',
  'messaging_conversations_started', 'cost_per_messaging_conversation_started',
  'messaging_conversations_replied', 'messaging_first_replies', 'instagram_profile_visits',
  'cost_per_instagram_profile_visit', 'instagram_profile_follows', 'cost_per_instagram_profile_follow',
  'outbound_clicks', 'outbound_ctr', 'landing_page_views', 'bookings', 'cost_per_booking',
  'appointment_value', 'appointment_roas', 'purchase_count', 'cost_per_purchase', 'purchase_value', 'purchase_roas']
const costs = [['cost_per_2s_view', 'video_2s', .015, '$0.015'], ['cost_per_thruplay', 'thruplays', .024, '$0.024'],
  ['cost_per_engagement', 'engagements', .4, '$0.40'], ['cost_per_share', 'shares', 30, '$30.00']]
const proof = { startedAt: new Date().toISOString(), scope: 'ordinary fictional creative response', check: printOnly ? 'print-surfaces' : 'full' }
const errors = [], requests = [], blocked = [], workers = []
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

function nativeExport(rows, entities) {
  assert.equal(rows.length, entities.length * responseKeys.length)
  for (const entity of entities) for (const key of responseKeys) {
    const metric = entity.metrics[key], row = rows.find(item => item.claim_id === metric.current.claimId)
    assert.ok(row, `Missing exported ad ${entity.id} / ${key}`)
    assert.ok(row.entity.includes(`(ad ${entity.id};`)); assert.equal(row.source, 'meta')
    assert.equal(row.from, '2026-09-02'); assert.equal(row.to, '2026-09-04')
    assert.equal(row.comparison_from, '2026-08-30'); assert.equal(row.comparison_to, '2026-09-01')
    assert.equal(row.previous_claim_id, metric.previous.claimId)
    for (const [period, value, ids] of [['current', 'value', 'input_claim_ids'], ['previous', 'previous_value', 'previous_input_claim_ids']]) {
      if (metric[period].value === null) assert.equal(row[value], '')
      else assert.equal(Number(row[value]), metric[period].value)
      assert.deepEqual(JSON.parse(row[ids]), metric[period].inputClaimIds)
    }
  }
}

function nativeText(metric, period) {
  const claim = metric[period], value = claim.value
  if (value === null || claim.availability.state !== 'available') return 'Unavailable'
  if (claim.unit === 'money') return value.toLocaleString('en-US', { style: 'currency', currency: 'USD',
    maximumFractionDigits: metric.key.startsWith('cost_per_') && Math.abs(value) < 1 ? 4 : 2 })
  if (claim.unit === 'percent') return `${value.toFixed(1)}%`
  if (claim.unit === 'ratio') return `${value.toFixed(2)}×`
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

try {
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  context.setDefaultTimeout(20_000)
  // Destination/method allowlist only. Local GET/HEAD bodies are never intercepted or replaced.
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin === origin && ['GET', 'HEAD'].includes(request.method())) return route.continue()
    blocked.push({ origin: url.origin, method: request.method() }); return route.abort('blockedbyclient')
  })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/reporting') requests.push(request.url()) })
  page.on('worker', worker => workers.push(worker.url()))
  const cards = () => page.locator('article[aria-label]').filter({ has: page.getByRole('checkbox') })
  const card = id => cards().filter({ hasText: `Ad ${id} · Creative` })
  const presets = () => page.getByRole('group', { name: 'Metric presets', exact: true })
  const detailMetrics = () => page.locator('section').filter({ has: presets() }).last()
  const metricRow = (scope, label) => scope.locator('dl > div').filter({ has: page.locator('dt').getByText(label, { exact: true }) })
  const download = async name => {
    const pending = page.waitForEvent('download', { timeout: 20_000 })
    await page.getByRole('button', { name, exact: true }).click()
    const file = await pending, csv = await readFile(await file.path(), 'utf8')
    await writeFile(`${output}/${file.suggestedFilename()}`, csv)
    return csvRows(csv)
  }
  const source = async (section, from = '2026-09-02', to = '2026-09-04', details = '') => {
    const response = await context.request.get(`${origin}/api/reporting?section=${section}&from=${from}&to=${to}${details ? `&details=${details}` : ''}`)
    assert.equal(response.status(), 200)
    const packet = await response.json(); validateReportingPacket(packet)
    assert.equal(packet.context.account.name, 'Synthetic creative account')
    assert.deepEqual(packet.context.range, { from, to })
    assert.equal(packet.context.timezone, 'America/New_York'); assert.equal(packet.context.currency, 'USD')
    return packet
  }
  const exactState = async expected => {
    await expect.poll(() => {
      const url = new URL(page.url())
      return Object.fromEntries(Object.keys(expected).map(key => [key, key === 'path' ? url.pathname : url.searchParams.get(key)]))
    }).toEqual(expected)
  }
  const focus = async target => {
    await target.evaluate(element => {
      const main = document.getElementById('main-content')
      main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16
    })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const bounds = async scope => scope.locator('dt,dd,td,th').evaluateAll(cells => cells.flatMap(cell => {
    const box = cell.getBoundingClientRect(), problems = [], walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
    const painted = element => {
      if (!element.checkVisibility()) return false
      if (!matchMedia('print').matches) for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false
      }
      return true
    }
    if (!painted(cell) || box.width === 0) return []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim() || !painted(node.parentElement)) continue
      const range = document.createRange(); range.selectNodeContents(node)
      if ([...range.getClientRects()].some(rect => rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1)))
        problems.push({ text: node.textContent, cellWidth: box.width,
          entity: cell.closest('article[aria-label]')?.getAttribute('aria-label'), metric: cell.parentElement.querySelector(':scope > dt')?.textContent,
          cellRight: box.right, textRight: range.getBoundingClientRect().right,
          valueColumnStart: cell.tagName === 'DT' ? cell.parentElement.querySelector(':scope > dd')?.getBoundingClientRect().left : undefined })
    }
    return problems
  }))
  const settled = async width => {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(() => page.locator('#primary-nav').evaluate((nav, mobile) => {
      return (mobile ? nav.inert && nav.getAttribute('aria-hidden') === 'true' && getComputedStyle(nav).visibility === 'hidden' : getComputedStyle(nav).visibility === 'visible')
        && nav.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running')
    }, width < 1024)).toBe(true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  }
  const printSurfaces = async (entities, campaign) => {
    await page.goto(`${origin}/creative?from=2026-09-02&to=2026-09-04`, { waitUntil: 'domcontentloaded' })
    await expect(cards()).toHaveCount(8)
    await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' })
    const labels = responseKeys.flatMap(key => entities[0].metrics[key] ? [entities[0].metrics[key].label] : [])
    await page.evaluate(labels => {
      window.addEventListener('beforeprint', () => {
        const cards = [...document.querySelectorAll('article[aria-label]')].filter(element => element.querySelector('input[type="checkbox"]'))
        const rows = cards.map(card => {
          const visible = [...card.querySelectorAll('dl > div > dt')].filter(element => element.getClientRects().length).map(element => element.textContent)
          return { id: card.textContent.match(/Ad (\d+) · Creative/)[1], missing: labels.filter(label => !visible.includes(label)) }
        })
        window.__responseCardPrint = { expected: labels, rows, missing: rows.flatMap(row => row.missing.map(label => `${row.id}: ${label}`)) }
      }, { once: true })
    }, labels)
    await page.pdf({ path: `${output}/response-cards.pdf`, format: 'A4', printBackground: true })
    const cardPrint = await page.evaluate(() => window.__responseCardPrint)
    proof.printSurfaces = { cards: cardPrint }
    await page.emulateMedia({ media: 'screen' })
    await page.goto(`${origin}/performance?from=2026-09-02&to=2026-09-04&group=response&level=campaign`, { waitUntil: 'domcontentloaded' })
    const tableRegion = page.getByRole('region', { name: 'Entity metrics, scroll for more columns', exact: true })
    await expect(tableRegion.locator('tbody tr')).toHaveCount(1)
    await page.emulateMedia({ media: 'print' })
    await expect(tableRegion).toBeHidden()
    const printed = page.locator(`[data-reporting-print-entity="${campaign.id}"]`)
    await expect(printed).toBeVisible()
    for (const key of responseKeys.filter(key => campaign.metrics[key])) {
      const metric = campaign.metrics[key], row = metricRow(printed, metric.label)
      await expect(row.locator('dd summary')).toHaveText(nativeText(metric, 'current'))
      await expect(row).toContainText(`Previous: ${nativeText(metric, 'previous')}`)
    }
    const hierarchyPrint = await printed.evaluate(entity => {
      const box = entity.getBoundingClientRect()
      return { left: box.left, right: box.right, width: box.width, viewport: innerWidth,
        metricCount: entity.querySelectorAll(':scope > dl > div').length,
        wrappedValues: [...entity.querySelectorAll('dd summary')].flatMap(summary => {
          const range = document.createRange(); range.selectNodeContents(summary)
          const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => rect.top)).size
          return lines > 1 ? [{ value: summary.textContent, lines, cellWidth: summary.closest('dd').getBoundingClientRect().width }] : []
        }) }
    })
    assert.deepEqual(await bounds(printed), [], 'A4 hierarchy current/prior text stays within value columns')
    await page.pdf({ path: `${output}/response-campaign.pdf`, format: 'A4', printBackground: true })
    await page.emulateMedia({ media: 'screen' }); await settled(1440)
    proof.printSurfaces = { cards: cardPrint, hierarchy: hierarchyPrint }
    assert.deepEqual(cardPrint.missing, [], 'Untouched Response cards must print every supplied response metric')
    assert.equal(cardPrint.rows.length, 8)
    assert.equal(hierarchyPrint.metricCount, responseKeys.length)
    assert.ok(hierarchyPrint.right <= hierarchyPrint.viewport + 1, 'Response hierarchy values must fit on A4')
    assert.deepEqual(hierarchyPrint.wrappedValues, [], 'A4 metric values must remain readable instead of wrapping into character columns')
  }

  // Validate the geometry instrument in a disposable document before navigating to the app.
  await page.setContent('<dl id="fits"><dd style="width:160px"><span style="white-space:nowrap">$12345.6789</span></dd></dl><dl id="overflows"><dd style="width:16px"><span style="white-space:nowrap">$12345.6789</span></dd></dl>')
  assert.deepEqual(await bounds(page.locator('#fits')), [])
  assert.equal((await bounds(page.locator('#overflows'))).length, 1)
  proof.geometryControls = { visibleFits: true, visibleOverflowRejected: true }
  await page.goto(`${origin}/preview?scenario=creative`, { waitUntil: 'domcontentloaded' })
  const packets = Object.fromEntries(await Promise.all(['meta', 'business', 'website', 'measurement'].map(async section => [section, await source(section)])))
  const meta = packets.meta.result.data, ads = meta.entities.filter(entity => entity.level === 'ad')
  const ad = id => ads.find(entity => entity.id === id), first = ad('301')
  assert.deepEqual(ads.map(entity => entity.id), ['301', '302', '303', '304', '305', '306', '307', '308'])
  assert.equal(packets.business.result.data.metrics.amount_paid.current.value, 500)
  assert.equal((await context.request.get(`${origin}/api/reporting?section=unknown`)).status(), 400)
  if (printOnly) {
    await printSurfaces(ads, meta.entities.find(entity => entity.level === 'campaign'))
  } else {
  for (const [key, denominator, value] of costs) for (const period of ['current', 'previous']) {
    const metric = first.metrics[key]
    assert.equal(metric[period].value, value)
    assert.deepEqual(metric[period].inputClaimIds, [first.metrics.spend[period].claimId, first.metrics[denominator][period].claimId])
  }
  assert.equal(first.metrics.engagement_rate.current.value, 1.5)
  assert.equal(first.metrics.share_rate.current.value, .02)
  assert.equal(first.metrics.messaging_conversations_started.current.value, 3)
  assert.equal(first.metrics.messaging_conversations_started.previous.value, 1)
  assert.equal(first.metrics.cost_per_messaging_conversation_started.current.value, 20)
  assert.equal(first.metrics.cost_per_messaging_conversation_started.previous.value, 30)
  assert.equal(first.metrics.instagram_profile_visits.current.value, 12)
  assert.equal(first.metrics.cost_per_instagram_profile_visit.current.value, 5)
  assert.equal(first.metrics.action_video_views.current.value, 300)
  assert.equal(first.metrics.cost_per_action_video_view.current.value, .2)
  assert.equal(ad('307').metrics.bookings.current.value, 0); assert.equal(ad('308').metrics.bookings.current.value, null)
  assert.equal(first.metrics.outbound_clicks.current.value, 10)
  assert.equal(first.metrics.landing_page_views.current.value, 8)
  assert.equal(ad('305').metrics.outbound_clicks.current.value, 5)
  assert.equal(ad('305').metrics.landing_page_views.current.value, null)
  assert.equal(ad('307').metrics.landing_page_views.current.value, 0)
  assert.equal(ad('308').metrics.landing_page_views.current.value, null)
  proof.native = { packets: 4, ads: 8, sourceAsOf: packets.meta.context.asOf, costs: Object.fromEntries(costs.map(([key,, value]) => [key, value])) }

  await page.goto(`${origin}/creative?from=2026-09-02&to=2026-09-04`, { waitUntil: 'domcontentloaded' })
  await expect(presets().getByRole('button', { name: 'Response', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(cards()).toHaveCount(8)
  await expect(page.locator('[aria-label="Response coverage"]')).toContainText('Supported messaging actions')
  await expect(page.locator('[aria-label="Response coverage"]')).toContainText('not relabeled as a three-second view')
  for (const [id, key, value] of [['307', 'bookings', '0'], ['307', 'engagements', '0'], ['307', 'cost_per_engagement', 'Unavailable'], ['308', 'bookings', 'Unavailable'], ['308', 'outbound_clicks', 'Unavailable'], ['305', 'landing_page_views', 'Unavailable'], ['307', 'landing_page_views', '0'], ['308', 'landing_page_views', 'Unavailable']])
    await expect(metricRow(card(id), ad(id).metrics[key].label).locator('dd summary')).toHaveText(value)
  await expect(metricRow(card('301'), first.metrics.messaging_conversations_started.label).locator('dd summary')).toHaveText('3')
  await expect(metricRow(card('301'), first.metrics.cost_per_messaging_conversation_started.label).locator('dd summary')).toHaveText('$20.00')
  await expect(metricRow(card('301'), first.metrics.instagram_profile_visits.label).locator('dd summary')).toHaveText('12')
  await expect(metricRow(card('301'), first.metrics.action_video_views.label).locator('dd summary')).toHaveText('300')
  const more = card('301').locator('summary').filter({ hasText: 'More response metrics' })
  await more.focus(); await more.press('Enter')
  for (const key of responseKeys) await expect(metricRow(card('301'), first.metrics[key].label)).toBeVisible()
  await expect(metricRow(card('301'), first.metrics.outbound_clicks.label).locator('dd summary')).toHaveText('10')
  await expect(metricRow(card('301'), first.metrics.landing_page_views.label).locator('dd summary')).toHaveText('8')
  const allRows = await download('Export CSV'); nativeExport(allRows, ads)
  proof.executionExport = { rows: allRows.length, lowerRows: ['307', '308'], exactCurrentPriorClaimIds: true }
  for (const width of [1440, 390, 320]) {
    await settled(width); await focus(metricRow(card('301'), first.metrics.engagements.label))
    const crossings = await bounds(cards())
    proof.cardGeometry = { width, crossings }
    assert.deepEqual(crossings, [], `Response card values fit at ${width}`)
    await page.screenshot({ path: `${output}/response-card301-${width}.png` })
    await focus(card('308')); await page.screenshot({ path: `${output}/response-card308-${width}.png` })
  }
  await settled(1440)
  const search = page.getByRole('searchbox', { name: 'Search ads, names or copy', exact: true })
  await search.fill('Short studio tour'); await expect(cards()).toHaveCount(2)
  await card('301').getByRole('link', { name: 'Short studio tour', exact: true }).click()
  await exactState({ path: '/creative', ad: '301', from: '2026-09-02', to: '2026-09-04', q: 'Short studio tour' })
  await expect(page.getByRole('heading', { name: 'Short studio tour', exact: true })).toBeVisible()
  await expect(presets().getByRole('button', { name: 'Response', exact: true })).toHaveAttribute('aria-pressed', 'true')
  for (const [key,, , value] of costs) {
    const row = metricRow(detailMetrics(), first.metrics[key].label)
    await expect(row.locator('dd summary')).toHaveText(value)
    await expect(row).toContainText(`Previous: ${value}`)
  }
  await expect(metricRow(detailMetrics(), first.metrics.cost_per_messaging_conversation_started.label).locator('dd summary')).toHaveText('$20.00')
  await expect(metricRow(detailMetrics(), first.metrics.cost_per_messaging_conversation_started.label)).toContainText('Previous: $30.00')
  await expect(metricRow(detailMetrics(), first.metrics.cost_per_instagram_profile_visit.label).locator('dd summary')).toHaveText('$5.00')
  await expect(metricRow(detailMetrics(), first.metrics.cost_per_action_video_view.label).locator('dd summary')).toHaveText('$0.20')
  for (const key of responseKeys) await expect(metricRow(detailMetrics(), first.metrics[key].label)).toBeVisible()
  await expect(metricRow(detailMetrics(), first.metrics.bookings.label)).toContainText('Previous: 1')
  nativeExport(await download('Export CSV'), [first])
  const history = page.getByRole('region', { name: 'Ad-level daily history', exact: true })
  await history.locator('summary').filter({ hasText: 'Daily values and evidence' }).click()
  const screenHistoryRows = history.locator('details tbody tr')
  await expect(screenHistoryRows).toHaveCount(3); await expect(history).toContainText('$20.00')
  await page.getByLabel('Daily history metric', { exact: true }).selectOption('cost_per_engagement')
  await expect(history).toContainText('This daily metric was not supplied')
  await expect(screenHistoryRows.locator('td').getByText('Unavailable', { exact: true }).filter({ visible: true })).toHaveCount(3)
  await page.getByLabel('Daily history period', { exact: true }).selectOption('previous')
  await expect(screenHistoryRows.locator('td').getByText('Unavailable', { exact: true }).filter({ visible: true })).toHaveCount(3)
  await page.getByLabel('Daily history metric', { exact: true }).selectOption('spend')
  await expect(history).toContainText('$10.00')
  await expect.poll(() => requests.some(url => new URL(url).searchParams.get('details') === '301')).toBe(true)
  const placement = page.getByRole('region', { name: 'Ad placement metrics', exact: true })
  await expect(placement.locator('tbody tr')).toHaveCount(2)
  const detailed = (await source('meta', '2026-09-02', '2026-09-04', '301')).result.data.entities.find(entity => entity.id === '301')
  assert.deepEqual(detailed.breakdowns.map(row => row.label), ['instagram / feed', 'instagram / reels'])
  for (const [index, row] of detailed.breakdowns.entries()) for (const period of ['current', 'previous']) {
    const spend = (index ? 20 : 40) / (period === 'previous' ? 2 : 1)
    const engagements = (index ? 60 : 90) / (period === 'previous' ? 2 : 1)
    assert.equal(row.metrics.spend[period].value, spend); assert.equal(row.metrics.engagements[period].value, engagements)
    assert.equal(row.metrics.cost_per_engagement[period].value, spend / engagements)
    assert.deepEqual(row.metrics.cost_per_engagement[period].inputClaimIds, [row.metrics.spend[period].claimId, row.metrics.engagements[period].claimId])
    assert.equal(row.metrics.cost_per_engagement[period].entity.id, `301:placement:${row.label}`)
  }
  await expect(placement).toContainText('$0.4444'); await expect(placement).toContainText('$0.3333')
  for (const [group, key] of [['Attention', 'cost_per_thruplay'], ['Engagement', 'cost_per_share'], ['Clicks', 'cost_per_lpv'], ['Results', 'appointment_roas'], ['Response', 'cost_per_engagement']]) {
    await presets().getByRole('button', { name: group, exact: true }).click()
    await expect(metricRow(detailMetrics(), first.metrics[key].label)).toBeVisible()
    await exactState({ ad: '301', group: group.toLowerCase(), q: 'Short studio tour' })
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(metricRow(detailMetrics(), first.metrics.cost_per_2s_view.label).locator('dd summary')).toHaveText('$0.015')
  for (const width of [1440, 390, 320]) {
    await settled(width); await focus(detailMetrics())
    assert.deepEqual(await bounds(detailMetrics()), [], `Response metric values fit at ${width}`)
    await page.screenshot({ path: `${output}/ad301-response-${width}.png` })
    await focus(placement); await placement.evaluate(element => { element.scrollLeft = 0 })
    if (width < 1024) {
      await placement.focus(); await page.keyboard.press('ArrowRight')
      await expect.poll(() => placement.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
      await placement.evaluate(element => { element.scrollLeft = element.scrollWidth - element.clientWidth })
    }
    assert.deepEqual(await bounds(placement), [], `Placement values fit at ${width}`)
    await page.screenshot({ path: `${output}/ad301-placement-${width}.png` })
  }
  await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' })
  assert.deepEqual(await bounds(detailMetrics()), [], 'A4 response value columns fit')
  await expect(placement).toBeHidden()
  const printedPlacements = page.getByRole('region', { name: 'Ad placement and audience detail', exact: true })
  assert.deepEqual(await bounds(printedPlacements), [], 'A4 stacked placement values fit')
  await expect(printedPlacements.locator('section').filter({ has: page.locator('h4') })).toHaveCount(2)
  await expect(printedPlacements.getByText('$0.4444', { exact: true }).filter({ visible: true })).toHaveCount(1)
  await expect(printedPlacements.getByText('$0.3333', { exact: true }).filter({ visible: true })).toHaveCount(1)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.pdf({ path: `${output}/ad301-response.pdf`, format: 'A4', printBackground: true })
  await page.emulateMedia({ media: 'screen' }); await settled(1440)
  proof.detail = { ad: '301', currentPriorCosts: true, dailyUnavailableResponse: true, measuredSpendHistory: true, placementCosts: true, responsive: [1440, 390, 320], printed: true }
  await page.getByRole('link', { name: 'Back to creative', exact: true }).click()
  await exactState({ group: 'response', q: 'Short studio tour', ad: null })
  await expect(cards()).toHaveCount(2)
  await page.goBack({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Short studio tour', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Back to creative', exact: true }).click()
  await page.getByRole('button', { name: 'Shared creative', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Shared creative objects', exact: true })
  const shared = panel.locator('[data-creative-id="401"]')
  const groupedCost = shared.getByRole('region', { name: first.metrics.cost_per_engagement.label, exact: true })
  await expect(panel).toContainText('2 selected executions · 2 assigned · 0 unassigned · 8 returned by Meta')
  await expect(groupedCost.getByText('$0.2593', { exact: true })).toHaveCount(2)
  const inputButton = groupedCost.getByRole('button', { name: `Inputs for ${first.metrics.cost_per_engagement.label}`, exact: true })
  await inputButton.focus(); await inputButton.press('Enter')
  await expect(groupedCost).toContainText('individual ad rates are not averaged')
  await expect(groupedCost.locator('[data-native-input]')).toHaveCount(12)
  const groupRows = await download('Export all group evidence')
  const population = groupRows.find(row => row.record_type === 'population')
  assert.deepEqual(JSON.parse(population.requested_ad_ids), ['301', '302'])
  assert.equal(population.selected_ad_count, '2'); assert.equal(population.returned_ad_count, '8')
  for (const period of ['current', 'previous']) {
    const calculation = groupRows.find(row => row.record_type === 'calculation' && row.metric_key === 'cost_per_engagement' && row.period === period)
    assert.equal(Number(calculation.value), 70 / 270); assert.equal(calculation.calculation, 'ratio_of_sums')
    assert.notEqual(Number(calculation.value), (.4 + 10 / 120) / 2)
    const inputs = groupRows.filter(row => row.record_type === 'input' && row.calculation === 'cost_per_engagement' && row.period === period)
    for (const id of ['301', '302']) for (const key of ['spend', 'engagements', 'cost_per_engagement'])
      assert.ok(inputs.some(row => row.ad_id === id && JSON.parse(row.claim_json).claimId === ad(id).metrics[key][period].claimId))
  }
  assert.ok(workers.some(url => url.startsWith(`${origin}/_next/`) && url.includes('creative-group-export_worker')))
  await inputButton.click()
  for (const width of [390, 320]) {
    await settled(width); await focus(groupedCost)
    const overflow = await groupedCost.locator('p.text-lg').evaluateAll(elements => elements.some(element => element.scrollWidth > element.clientWidth))
    assert.equal(overflow, false)
    await page.screenshot({ path: `${output}/group401-response-${width}.png` })
  }
  await settled(1440)
  await page.getByTitle('Change the date range (applies across pages)').click()
  await page.getByLabel('From date', { exact: true }).fill('2026-09-01')
  await page.getByLabel('To date', { exact: true }).fill('2026-09-03'); await page.keyboard.press('Escape')
  await exactState({ from: '2026-09-01', to: '2026-09-03', group: 'response', grouping: 'creative', q: 'Short studio tour' })
  await expect(groupedCost.getByText('$0.5185', { exact: true })).toHaveCount(2)
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(groupedCost.getByText('$0.5185', { exact: true })).toHaveCount(2)
  const dated = await download('Export all group evidence')
  const datedCalculation = dated.find(row => row.record_type === 'calculation' && row.metric_key === 'cost_per_engagement' && row.period === 'current')
  assert.equal(Number(datedCalculation.value), 140 / 270); assert.equal(datedCalculation.from, '2026-09-01'); assert.equal(datedCalculation.to, '2026-09-03')
  await search.fill('999999999999'); await expect(panel.locator('[data-creative-id]')).toHaveCount(0)
  await expect(panel).toContainText('No returned ad executions match the current filters.')
  proof.group = { creativeId: '401', inputs: ['301', '302'], currentPriorCost: 70 / 270, exportRows: groupRows.length, changedDateCost: 140 / 270, worker: true }
  await printSurfaces(ads, meta.entities.find(entity => entity.level === 'campaign'))
  }
  assert.deepEqual(errors, [])
  proof.result = 'pass'; proof.finishedAt = new Date().toISOString(); console.log(JSON.stringify(proof))
} catch (error) {
  proof.result = 'failed'; proof.error = String(error)
  if (page) { proof.url = page.url(); await page.screenshot({ path: `${output}/failure.png` }).catch(() => {}) }
  throw error
} finally {
  if (browser) await browser.close()
  await writeFile(`${output}/results${printOnly ? '-print-surfaces' : ''}.json`, JSON.stringify({ ...proof, errors, requests, blocked, workers }, null, 2))
}
