// Fictional loopback evidence only. Browser and media fixtures always close, including on failure.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { startCreativeMediaFixture } from './creative-media-fixture.mjs'
import { referenceReportingFixture } from './reference-fixture.ts'
import { verifyReferenceCreativeDensity } from './reference-density-check.ts'

const expect = playwrightExpect.configure({ timeout: 30000 })
const base = 'http://127.0.0.1:3149'
const scenarioUrl = `${base}/preview?scenario=reference`
const output = 'test-results/dashboard-completion'
await mkdir(output, { recursive: true })
const proof = {
  synthetic: true,
  evidence: 'Fictional Reference dashboard fixture served over loopback; no live account or customer data.',
  route: '/dashboard?from=2026-09-02&to=2026-09-04',
  scenario: 'reference',
  screenshots: [],
  viewports: [],
  interactions: {},
  geometry: {},
  sourceFailure: {},
  alerts: {},
  pageErrors: [],
  startedAt: new Date().toISOString(),
}
const media = await startCreativeMediaFixture(base)
let browser

function intersects(first, second) {
  return first.x < second.x + second.width && first.x + first.width > second.x
    && first.y < second.y + second.height && first.y + first.height > second.y
}

try {
  browser = await chromium.launch({ headless: true, proxy: { server: media.proxy }, args: ['--proxy-bypass-list=<-loopback>'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
  const fixture = referenceReportingFixture('2026-09-02', '2026-09-04', media.origin)
  const alertPopulation = { alerts: Array.from({ length: 50 }, (_, index) => ({ id: `synthetic-critical-${index + 1}`,
    severity: 'critical', is_resolved: false, title: `Fictional critical alert ${index + 1}` })), total: 73 }
  await context.route('**/api/alerts?**', async route => {
    const url = new URL(route.request().url())
    assert.equal(route.request().method(), 'GET')
    assert.equal(url.searchParams.get('severity'), 'critical')
    assert.equal(url.searchParams.get('is_resolved'), 'false')
    await route.fulfill({ json: alertPopulation })
  })
  await context.route('**/api/reporting?**', async route => {
    const section = new URL(route.request().url()).searchParams.get('section') ?? 'meta'
    assert.ok(['meta', 'business', 'website', 'measurement'].includes(section))
    await route.fulfill({ json: { section, context: fixture.context, result: fixture[section],
      notes: ['Sample-data preview: fictional metrics, not Example Studio results.'] } })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => proof.pageErrors.push(error.message))

  const executive = page.getByRole('region', { name: 'Executive interpretation' })
  const business = page.getByRole('region', { name: 'Business results' })
  const advertising = page.getByRole('region', { name: 'Advertising results' })
  const trends = page.getByRole('region', { name: 'Results over time' })
  const delivery = page.getByRole('region', { name: 'Account delivery' })
  const creative = page.getByRole('region', { name: 'Creative comparison' })
  const hierarchy = page.getByRole('region', { name: 'Campaign and ad-set comparison' })
  const lowerBusiness = page.getByRole('region', { name: 'Booking economics and outlook' })
  const afterClick = page.getByRole('region', { name: 'After the click' })
  const main = page.locator('#main-content')
  const creativeRows = () => creative.locator('tr[id^="overview-creative-"]')

  async function settle() {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }

  async function scrollTo(locator) {
    await locator.evaluate(element => {
      const main = document.getElementById('main-content')
      if (!main) throw new Error('Main scrolling region is unavailable.')
      main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16
    })
    await settle()
  }

  async function capture(name, locator) {
    if (locator) await scrollTo(locator)
    else { await main.evaluate(element => { element.scrollTop = 0 }); await settle() }
    await page.evaluate(() => document.querySelectorAll('nextjs-portal').forEach(portal => portal.remove()))
    const path = `${output}/${name}.png`
    await page.screenshot({ path, animations: 'disabled' })
    proof.screenshots.push(path)
  }

  async function setTheme(theme) {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  }

  async function viewportGeometry(label) {
    const result = await page.evaluate(() => {
      const main = document.getElementById('main-content')
      const nested = selector => {
        const section = document.querySelector(selector)
        if (!section) return ['missing section']
        return [...section.querySelectorAll('*')].filter(element => {
          const style = getComputedStyle(element)
          return ['auto', 'scroll'].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1
        }).map(element => `${element.tagName.toLowerCase()}.${element.className}`)
      }
      return {
        width: innerWidth,
        height: innerHeight,
        documentScrollWidth: document.documentElement.scrollWidth,
        noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
        main: main ? { clientHeight: main.clientHeight, scrollHeight: main.scrollHeight, overflowY: getComputedStyle(main).overflowY } : null,
        creativeNestedVerticalScroll: nested('[aria-labelledby$="-heading"]'),
        hierarchyNestedVerticalScroll: nested('[aria-label="Campaign and ad-set comparison"]'),
      }
    })
    assert.equal(result.noPageOverflow, true, `${label} has page-level horizontal overflow`)
    assert.ok(result.main && result.main.overflowY === 'auto' && result.main.scrollHeight > result.main.clientHeight,
      `${label} must use natural main-page scrolling`)
    assert.deepEqual(result.creativeNestedVerticalScroll, [], `${label} has nested creative vertical scrolling`)
    assert.deepEqual(result.hierarchyNestedVerticalScroll, [], `${label} has nested hierarchy vertical scrolling`)
    proof.viewports.push({ label, ...result })
  }

  async function captureSet(theme, width, height) {
    await setTheme(theme)
    await page.setViewportSize({ width, height })
    await settle()
    const stem = `${theme}-${width}x${height}`
    await viewportGeometry(stem)
    await capture(`${stem}-opening`)
    await capture(`${stem}-trends-delivery`, trends)
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    await capture(`${stem}-creative-table`, creative)
    await page.getByRole('button', { name: 'Attention × CPA', exact: true }).click()
    await capture(`${stem}-attention-cpa`, creative)
    await page.getByRole('button', { name: 'Table', exact: true }).click()
    await capture(`${stem}-hierarchy`, hierarchy)
    await capture(`${stem}-lower-context`, lowerBusiness)
  }

  await page.goto(`${scenarioUrl}&mediaOrigin=${encodeURIComponent(media.origin)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Creative comparison', exact: true })).toBeVisible()
  await expect(delivery).toBeAttached()
  await expect(page.getByText('Sample-data preview: fictional metrics, not Example Studio results.', { exact: true })).toBeVisible()
  const observation = executive.locator('p').nth(0)
  const qualifier = executive.locator('p').nth(1)
  await expect(observation).toHaveText('Meta spend doubled while all-source MER held at 4.17×; Sep 2 supplied 86% of booked value.')
  await expect(qualifier).toHaveText('Average booking value fell 20% to $100, while booked value per recorded hour rose 33% to $55.56.')
  await expect(observation).toBeVisible()
  await expect(qualifier).toBeVisible()
  proof.interactions.executiveReading = { observation: await observation.textContent(), qualifier: await qualifier.textContent() }
  await expect(executive).toContainText('$430.00 of $500.00')
  await expect(page.getByLabel('All-source booked value ÷ Meta spend: 4.17×', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Ad spend per booking: $24.00', { exact: true })).toBeVisible()
  await expect(executive.locator('details > summary')).not.toContainText('Freshness unverified')
  await expect(business.getByLabel('Blended business context')).not.toContainText('Freshness unverified')
  await expect(page.getByRole('banner').getByText('Example Studio', { exact: true })).toBeHidden()
  await expect(page.locator('[data-overview-sources]')).toContainText('2 of 4 sources partial')
  const alertLink = page.getByRole('link', { name: '73 unresolved critical alerts — open decision queue', exact: true })
  await expect(alertLink).toBeVisible()
  await expect(alertLink.locator('span[aria-hidden="true"]')).toHaveText('73')
  await expect(alertLink).toHaveAttribute('href', '/decisions?filter=unresolved_critical_alerts&legacy=inbox')
  proof.alerts.positive = { total: 73, returned: alertPopulation.alerts.length, label: await alertLink.getAttribute('aria-label'),
    badge: await alertLink.locator('span[aria-hidden="true"]').textContent(), href: await alertLink.getAttribute('href') }

  const businessTileTops = await business.evaluate(element => {
    const booked = element.querySelector('summary[aria-label^="Booked value:"]')?.closest('.rounded-xl')
    const context = element.querySelector('[aria-label="Blended business context"]')
    return booked && context ? [booked.getBoundingClientRect().top, context.getBoundingClientRect().top] : null
  })
  assert.ok(businessTileTops && Math.abs(businessTileTops[0] - businessTileTops[1]) <= 2,
    `Business context must share the primary desktop row; received tops ${businessTileTops}`)
  proof.geometry.businessTileTops = businessTileTops

  const openingGeometry = await executive.evaluate(element => {
    const reading = element.querySelector(':scope > div > div')?.getBoundingClientRect()
    const mer = element.querySelector(':scope > div > aside')?.getBoundingClientRect()
    return reading && mer ? { reading: { x: reading.x, y: reading.y, width: reading.width, height: reading.height },
      mer: { x: mer.x, y: mer.y, width: mer.width, height: mer.height } } : null
  })
  assert.ok(openingGeometry && !intersects(openingGeometry.reading, openingGeometry.mer), 'Desktop opening read and MER overlap')
  proof.geometry.opening = { ...openingGeometry, overlap: false }

  const trust = page.locator('[data-overview-sources]')
  const trustSummary = trust.locator(':scope > summary')
  await trustSummary.focus()
  await page.keyboard.press('Enter')
  await expect(trust).toHaveAttribute('open', '')
  await page.keyboard.press('Enter')
  await expect(trust).not.toHaveAttribute('open', '')
  proof.interactions.trustKeyboard = true

  await scrollTo(trends)
  const chartPoint = trends.locator('[data-overview-chart] g[tabindex="0"]').first()
  await chartPoint.focus()
  await expect(chartPoint).toBeFocused()
  proof.interactions.chartPointKeyboardFocus = true

  await scrollTo(creative)
  const expand = creative.getByRole('button', { name: /^Expand creative preview for / }).first()
  const expandedDetailsId = await expand.getAttribute('aria-controls')
  assert.ok(expandedDetailsId)
  await expand.focus()
  await expect(expand).toBeFocused()
  await expand.press('Enter')
  const expandedControl = creative.locator(`button[aria-controls="${expandedDetailsId}"][aria-label]`)
  await expect(expandedControl).toHaveAttribute('aria-expanded', 'true')
  await expect(creative.locator(`[id="${expandedDetailsId}"]`)).toContainText('Supplied creative')
  proof.interactions.creativeExpansionKeyboard = true
  const video = creative.locator(`[id="${expandedDetailsId}"] video`)
  await expect(video).toBeVisible()
  await video.evaluate(element => element.play())
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(.2)
  proof.interactions.videoPlayback = await video.evaluate(element => ({ duration: element.duration,
    width: element.videoWidth, height: element.videoHeight, time: element.currentTime, paused: element.paused, controls: element.controls }))
  assert.equal(proof.interactions.videoPlayback.duration, 8)
  assert.equal(proof.interactions.videoPlayback.paused, false)
  assert.equal(proof.interactions.videoPlayback.controls, true)
  assert.ok(proof.interactions.videoPlayback.width > 0 && proof.interactions.videoPlayback.height > 0)
  await video.evaluate(element => element.pause())
  await expandedControl.press('Enter')
  await expect(expandedControl).toHaveAttribute('aria-expanded', 'false')

  const focusLink = creative.getByRole('link', { name: /^Most results / }).first()
  const focusHref = await focusLink.getAttribute('href')
  assert.ok(focusHref?.startsWith('#overview-creative-'))
  await focusLink.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(`[id="${focusHref.slice(1)}"]`)).toBeFocused()
  proof.interactions.creativeFocusLinkKeyboard = true

  await page.getByRole('button', { name: 'Attention × CPA', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Attention and reported results' })).toBeVisible()
  const scatterPoint = page.locator('[data-scatter-point]').first()
  await scatterPoint.focus()
  const scatterId = await scatterPoint.getAttribute('data-scatter-point')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Table', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator(`[id="overview-creative-${scatterId}"]`)).toBeFocused()
  proof.interactions.scatterKeyboardInspection = true

  const eventSelect = page.getByLabel('Dashboard result event')
  await eventSelect.focus()
  await eventSelect.selectOption('purchase')
  await expect(page).toHaveURL(/overview_event=purchase/)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(eventSelect).toHaveValue('purchase')
  await expect(page.locator('[data-overview-event]')).toHaveAttribute('data-overview-event', 'purchase')
  proof.interactions.eventKeyboardAndReload = true

  await expect(page.getByLabel('Creative page size')).toHaveValue('25')
  assert.deepEqual(await page.getByLabel('Creative page size').locator('option').evaluateAll(options => options.map(option => option.value)), ['25', '5'])
  await expect(creativeRows()).toHaveCount(8)
  const suppliedCreativeIds = fixture.meta.data.entities.filter(entity => entity.level === 'ad').map(entity => `overview-creative-${entity.id}`)
  const defaultPageIds = await creativeRows().evaluateAll(rows => rows.map(row => row.id))
  assert.deepEqual(new Set(defaultPageIds), new Set(suppliedCreativeIds))
  await page.getByLabel('Creative page size').selectOption('5')
  await expect(creativeRows()).toHaveCount(5)
  const firstPageIds = await creativeRows().evaluateAll(rows => rows.map(row => row.id))
  await page.getByRole('button', { name: 'Next creative page', exact: true }).click()
  await expect(creativeRows()).toHaveCount(3)
  const secondPageIds = await creativeRows().evaluateAll(rows => rows.map(row => row.id))
  assert.equal(firstPageIds.length, 5)
  assert.equal(secondPageIds.length, 3)
  assert.deepEqual(firstPageIds.filter(id => secondPageIds.includes(id)), [], 'Compact creative pages must be disjoint')
  assert.deepEqual(new Set([...firstPageIds, ...secondPageIds]), new Set(suppliedCreativeIds))
  await expect(page.getByRole('button', { name: 'Next creative page', exact: true })).toBeDisabled()
  const lowerCreative = creativeRows().last()
  await lowerCreative.focus()
  await expect(lowerCreative).toBeFocused()
  proof.interactions.creativePopulation = { defaultChoice: 25, compactChoice: 5, supplied: 8,
    suppliedIds: suppliedCreativeIds, defaultPageIds, compactPages: [firstPageIds, secondPageIds],
    compactPageSizes: [firstPageIds.length, secondPageIds.length], disjoint: true, complete: true,
    lowerRankedFocused: await lowerCreative.getAttribute('id') }

  await expect(hierarchy.locator('[data-hierarchy-row]')).toHaveCount(13)
  const hierarchyIds = await hierarchy.locator('[data-hierarchy-row]').evaluateAll(rows => rows.map(row => row.dataset.hierarchyRow))
  assert.equal(new Set(hierarchyIds).size, 13)
  await expect(hierarchy.locator('[data-hierarchy-row="reference-set-13"]')).toContainText('long-name control')
  proof.interactions.hierarchyPopulation = {
    supplied: 13,
    visible: 13,
    lowerRanked: hierarchyIds.at(-1),
    longName: 'reference-set-13',
  }

  await expect(lowerBusiness).toContainText('Largest service changes')
  await expect(lowerBusiness).toContainText('Customer history')
  await expect(lowerBusiness).toContainText('Booking → service date')
  await expect(lowerBusiness).toContainText('Recorded upcoming demand')
  await expect(afterClick).toContainText('Advertising response')
  await expect(afterClick).toContainText('Website behavior')
  await expect(afterClick).toContainText('Paid-booking evidence')
  await expect(afterClick.getByLabel('Outbound clicks: 83. Definition and source', { exact: true })).toHaveText('83')
  await expect(afterClick.getByLabel('Outbound clicks: 83. Definition and source', { exact: true })).toBeVisible()
  await expect(afterClick.getByLabel('Landing-page views: 61. Definition and source', { exact: true })).toHaveText('61')
  await expect(afterClick.getByLabel('Landing-page views: 61. Definition and source', { exact: true })).toBeVisible()
  proof.interactions.nativeLandingPageViews = { outboundClicks: 83, landingPageViews: 61,
    sourceField: 'actions[action_type=landing_page_view]', distinct: true }
  proof.interactions.lowerEvidence = true

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('radio', { name: 'Match system', exact: true }).click()
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  proof.interactions.themeKeyboardAndSystem = true

  await page.setViewportSize({ width: 390, height: 844 })
  const menu = page.getByRole('button', { name: 'Open navigation' })
  await menu.focus()
  await page.keyboard.press('Enter')
  const drawer = page.getByRole('dialog', { name: 'Primary navigation' })
  await expect(drawer).toBeVisible()
  await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(menu).toBeFocused()
  proof.interactions.mobileDrawerKeyboard = true

  const touchTargets = [
    menu,
    page.getByRole('link', { name: 'Open reporting Trust summary' }),
    page.getByRole('link', { name: /critical alert/ }),
    page.getByRole('button', { name: 'Sep 2 – Sep 4' }),
    executive.locator('details > summary'),
    business.locator('details > summary').first(),
    eventSelect,
    creative.getByRole('button', { name: 'Table', exact: true }),
    creative.locator('summary').filter({ hasText: /^Find, sort and compare ads$/ }),
  ]
  const touchGeometry = []
  for (const target of touchTargets) {
    const box = await target.boundingBox()
    const identity = await target.evaluate(element => ({
      tag: element.tagName,
      text: element.textContent?.trim(),
      ariaLabel: element.getAttribute('aria-label'),
    }))
    assert.ok(box && box.width >= 43.5 && box.height >= 43.5,
      `Mobile touch target is smaller than 44 CSS px: ${JSON.stringify({ identity, box })}`)
    touchGeometry.push({ ...identity, width: box.width, height: box.height })
  }
  proof.geometry.mobileTouchTargets = touchGeometry

  await main.evaluate(element => { element.scrollTop = 0 })
  const bookedValueTop = await business.locator('summary[aria-label^="Booked value:"]').first().evaluate(element => element.getBoundingClientRect().top)
  assert.ok(bookedValueTop < 844, `Booked value must enter the opening mobile viewport; received top ${bookedValueTop}`)
  proof.geometry.mobileOpeningBookedValueTop = bookedValueTop

  await page.setViewportSize({ width: 1440, height: 1000 })
  const headerControls = await page.getByRole('banner').locator('a,button').evaluateAll(elements => elements
    .filter(element => element.checkVisibility())
    .map(element => { const box = element.getBoundingClientRect(); return { name: element.getAttribute('aria-label') || element.textContent?.trim(),
      x: box.x, y: box.y, width: box.width, height: box.height } }))
  for (let index = 0; index < headerControls.length; index++) for (let other = index + 1; other < headerControls.length; other++) {
    assert.equal(intersects(headerControls[index], headerControls[other]), false,
      `Header controls overlap: ${headerControls[index].name} / ${headerControls[other].name}`)
  }
  proof.geometry.headerControls = headerControls

  await page.goto(`${scenarioUrl}&mediaOrigin=${encodeURIComponent(media.origin)}`, { waitUntil: 'domcontentloaded' })
  await expect(creativeRows()).toHaveCount(8)
  const assetGeometry = await creative.evaluate(element => ({
    images: [...element.querySelectorAll('img')].map(image => ({ complete: image.complete, naturalWidth: image.naturalWidth,
      width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height })),
    rows: [...element.querySelectorAll('tr[id^="overview-creative-"]')].map(row => ({ id: row.id,
      width: row.getBoundingClientRect().width, height: row.getBoundingClientRect().height, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth })),
  }))
  assert.ok(assetGeometry.images.length > 0 && assetGeometry.images.every(image => image.complete && image.naturalWidth > 0 && image.width > 0 && image.height > 0))
  assert.ok(assetGeometry.rows.every(row => row.height > 0 && row.scrollWidth <= row.clientWidth + 1), 'Creative rows are clipped')
  await expect(creative).toContainText('Image')
  await expect(creative).toContainText('video')
  await expect(creative.getByLabel('Dynamic creative preview details').first()).toBeAttached()
  proof.geometry.creativeAssets = assetGeometry

  for (const [theme, width, height] of [
    ['dark', 1440, 1000], ['dark', 1280, 1000], ['dark', 390, 844],
    ['light', 1440, 1000], ['light', 390, 844],
  ]) await captureSet(theme, width, height)

  await setTheme('dark')
  await page.setViewportSize({ width: 720, height: 1000 })
  await viewportGeometry('dark-720x1000-200-percent-equivalent')
  await capture('dark-720x1000-reflow-opening')
  await capture('dark-720x1000-reflow-creative', creative)
  await capture('dark-720x1000-reflow-hierarchy', hierarchy)
  proof.geometry.reflowEquivalent = { cssViewport: '720x1000', equivalentReference: '1440px viewport at 200% browser zoom', noPageOverflow: true }

  const failMeta = async route => new URL(route.request().url()).searchParams.get('section') === 'meta'
    ? route.fulfill({ status: 503, json: { error: 'Controlled local Meta outage.' } }) : route.continue()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await setTheme('dark')
  await page.locator('[data-overview-sources] > summary').click()
  await page.route('**/api/reporting?**', failMeta)
  await page.getByRole('button', { name: 'Refresh Meta advertising', exact: true }).click()
  await expect(page.locator('[aria-label="Reporting source status"]')).toContainText('Refresh failed')
  await expect(advertising.locator('summary').filter({ hasText: /^\$120$/ }).first()).toBeVisible()
  await trustSummary.click()
  await expect(trust).not.toHaveAttribute('open', '')
  await expect(trustSummary.locator('span').filter({ hasText: /^Evidence:/ })).toHaveText('Evidence: Meta · refresh failed · retained Sep 5, 1:00 PM ET · Acuity Sep 5 · GA4 Sep 5 · Tracking Sep 5 (partial)')
  await capture('dark-1440x1000-retained-meta-refresh-failure')
  proof.sourceFailure.retainedRefresh = true
  proof.sourceFailure.retainedCollapsedSummary = await trustSummary.textContent()

  const failed = await context.newPage()
  failed.on('pageerror', error => proof.pageErrors.push(error.message))
  await failed.route('**/api/reporting?**', failMeta)
  await failed.goto(scenarioUrl, { waitUntil: 'domcontentloaded' })
  await expect(failed.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
  await expect(failed.getByRole('region', { name: 'Advertising results' }).locator('summary[aria-label^="Spend:"]')).toHaveAttribute('aria-label', 'Spend: Unavailable. Definition and source')
  await expect(failed.getByText(/Evidence: Meta unavailable · Acuity Sep 5 · GA4 Sep 5 · Tracking Sep 5 \(partial\)/)).toBeVisible()
  await expect(failed.getByText('Reporting could not load. Inspect source details above and retry.', { exact: true })).toBeHidden()
  await failed.evaluate(() => document.querySelectorAll('nextjs-portal').forEach(portal => portal.remove()))
  await failed.screenshot({ path: `${output}/dark-1440x1000-meta-source-unavailable.png`, animations: 'disabled' })
  proof.screenshots.push(`${output}/dark-1440x1000-meta-source-unavailable.png`)
  proof.sourceFailure.localFailure = true
  await failed.close()

  for (const scenario of [
    { name: 'zero', status: 200, json: { alerts: [], total: 0 }, label: 'No unresolved critical alerts — open decision queue' },
    { name: 'malformed', status: 200, json: { ...alertPopulation, total: '73' }, label: 'Unresolved critical alert status unavailable — open decision queue' },
    { name: 'failed', status: 503, json: { ...alertPopulation, error: 'Controlled local alert outage.' }, label: 'Unresolved critical alert status unavailable — open decision queue' },
  ]) {
    const alertPage = await context.newPage()
    alertPage.on('pageerror', error => proof.pageErrors.push(error.message))
    try {
      await alertPage.route('**/api/alerts?**', route => route.fulfill({ status: scenario.status, json: scenario.json }))
      const responsePromise = alertPage.waitForResponse(response => new URL(response.url()).pathname === '/api/alerts')
      await alertPage.goto(scenarioUrl, { waitUntil: 'domcontentloaded' })
      const response = await responsePromise
      assert.equal(response.status(), scenario.status)
      await response.finished()
      await alertPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const link = alertPage.getByRole('link', { name: scenario.label, exact: true })
      await expect(link).toBeVisible()
      await expect(link.locator('span[aria-hidden="true"]')).toHaveCount(0)
      await expect(link).toHaveAttribute('href', '/decisions?filter=unresolved_critical_alerts&legacy=inbox')
      if (scenario.name !== 'zero') await expect(alertPage.getByRole('link', { name: 'No unresolved critical alerts — open decision queue', exact: true })).toHaveCount(0)
      await expect(alertPage.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
      proof.alerts[scenario.name] = { status: response.status(), returned: scenario.json.alerts.length, total: scenario.json.total,
        label: await link.getAttribute('aria-label'), badgeCount: await link.locator('span[aria-hidden="true"]').count() }
      const path = `${output}/dark-1440x1000-alerts-${scenario.name}.png`
      await alertPage.evaluate(() => document.querySelectorAll('nextjs-portal').forEach(portal => portal.remove()))
      await alertPage.screenshot({ path, animations: 'disabled' })
      proof.screenshots.push(path)
    } finally { await alertPage.close() }
  }

  proof.interactions.creativeDensity53 = await verifyReferenceCreativeDensity(context, fixture, scenarioUrl, message => proof.pageErrors.push(message))
  assert.deepEqual(proof.pageErrors, [])
  proof.passed = true
  proof.finishedAt = new Date().toISOString()

  const screenshotNames = proof.screenshots.map(path => path.slice(output.length + 1))
  const cards = screenshotNames.map(name => `<figure><a href="${name}"><img src="${name}" alt="${name}"></a><figcaption>${name}</figcaption></figure>`).join('\n')
  await writeFile(`${output}/README.md`, `# Reference dashboard review preview\n\nThis package contains fictional synthetic metrics and local test media. It does not contain Example Studio results, live-account reads, or customer data.\n\nReviewed route: \`${proof.route}\` through the loopback \`reference\` scenario.\n\nThe package covers dark and light themes at 1440×1000, 1280×1000, and 390×844 where required, plus a 720px CSS reflow equivalent to a 1440px viewport at 200% zoom. It includes the opening read, trends and delivery, creative table, Attention × CPA, complete hierarchy, lower business and after-click context, partial sources, and controlled source-failure states.\n\nVerified interactions: keyboard Trust disclosure, chart focus, creative expansion and focus links, event selection with reload persistence, table/scatter inspection, system theme behavior, compact five-row pagination, lower-ranked creative focus, and the keyboard mobile drawer.\n\nTo inspect locally, run \`npm run preview:sample\`, then open \`${scenarioUrl}\`. To regenerate this package while the preview is running, run \`TSX_TSCONFIG_PATH=tsconfig.scripts.json node --import tsx tests/reporting-browser/reference-dashboard-check.mjs\`.\n\nOpen \`index.html\` for the contact sheet. Exact results are in \`proof.json\`.\n`)
  await writeFile(`${output}/index.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reference dashboard review</title><style>body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.45 Inter,system-ui,sans-serif}header{position:sticky;top:0;z-index:2;padding:20px 24px;background:#0d1117eF;border-bottom:1px solid #30363d}h1{margin:0 0 4px;font-size:24px}p{margin:0;color:#9da7b3}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:18px;padding:24px}figure{margin:0;padding:10px;background:#161b22;border:1px solid #30363d;border-radius:12px}img{display:block;width:100%;height:auto;border-radius:8px;background:#080b10}figcaption{padding-top:8px;overflow-wrap:anywhere;color:#9da7b3}</style></head><body><header><h1>Reference dashboard review</h1><p>Fictional loopback fixture · ${screenshotNames.length} selected captures · see README.md and proof.json</p></header><main class="grid">${cards}</main></body></html>`)
} catch (error) {
  proof.failure = { message: error.message, stack: error.stack }
  proof.finishedAt = new Date().toISOString()
  throw error
} finally {
  await writeFile(`${output}/proof.json`, JSON.stringify(proof, null, 2))
  await browser?.close()
  await media.close()
}

console.log(JSON.stringify({ passed: proof.passed, screenshots: proof.screenshots.length, viewports: proof.viewports.length,
  interactions: proof.interactions, sourceFailure: proof.sourceFailure, alerts: proof.alerts, pageErrors: proof.pageErrors }, null, 2))
