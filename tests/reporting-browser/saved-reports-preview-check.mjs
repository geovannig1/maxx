// Dedicated fictional saved-service/PGlite gateway. Run final acceptance only after root freeze.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validatePreparedReportingReply } from '../../src/lib/reporting/prepared-validation.ts'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'
import { validateSavedReportReply } from '../../src/lib/reporting/saved-validation.ts'

const expect = playwrightExpect.configure({ timeout: 25_000 })
const origin = 'http://127.0.0.1:3150', output = 'test-results/reporting-preview/saved-reports'
const preflight = process.argv.includes('--preflight')
const proof = { startedAt: new Date().toISOString(), baseline: null, check: preflight ? 'preflight' : 'full',
  checkerSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') }
const errors = [], blocked = [], requests = [], audits = []
let browser, page, context
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


try {
  await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true })
  const newSession = async scenario => {
    if (context) await context.close()
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
    context.setDefaultTimeout(25_000)
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      const post = request.method() === 'POST' && ['/api/reporting', '/api/reporting/saved', '/__fixture/current'].includes(url.pathname)
      if (url.origin === origin && (['GET', 'HEAD'].includes(request.method()) || post)) return route.continue()
      blocked.push({ origin: url.origin, method: request.method() }); return route.abort('blockedbyclient')
    })
    page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.pathname.startsWith('/api/reporting')) requests.push({ path: url.pathname + url.search, method: response.request().method(), status: response.status() })
    })
    await page.goto(`${origin}/preview?scenario=${scenario}`, { waitUntil: 'domcontentloaded' })
  }
  const audit = async stage => {
    const response = await context.request.get(`${origin}/__fixture/audit`); assert.equal(response.status(), 200)
    const value = await response.json(); audits.push({ stage, ...value }); return value
  }
  const publish = async mode => {
    const response = await context.request.post(`${origin}/__fixture/current`, { data: { mode }, headers: { Origin: origin } })
    assert.equal(response.status(), 200); return response.json()
  }
  const source = async section => {
    const key = 'from=2026-09-02&to=2026-09-04'
    const response = await context.request.get(`${origin}/api/reporting?section=${section}&${key}`)
    assert.equal(response.status(), 200)
    const reply = validatePreparedReportingReply(await response.json(), section, key)
    validateReportingPacket(reply.packet); assert.ok(reply.snapshot?.fingerprint)
    assert.equal(reply.packet.context.account.name, 'Fictional saved-report studio')
    return reply
  }
  const summary = () => page.locator('[data-customer-result="business_customers"]')
  const observation = async () => { await expect(summary()).toHaveCount(1); return summary().locator(':scope > p').last().innerText() }
  const banner = () => page.getByRole('region', { name: 'Saved report', exact: true })
  const saveButton = () => page.getByRole('button', { name: 'Save this report', exact: true, includeHidden: true })
  const savedReply = async id => {
    const response = await context.request.get(`${origin}/api/reporting/saved/${id}`)
    assert.equal(response.status(), 200); return validateSavedReportReply(await response.json())
  }
  const noLive = async (baseline, stage) => {
    const latest = await audit(stage)
    assert.equal(latest.liveReads, baseline.liveReads, `${stage}: live source read`)
    assert.equal(latest.liveRefreshes, baseline.liveRefreshes, `${stage}: live refresh`)
  }
  await newSession('normal')
  if (!preflight) { await publish('movement'); await page.reload({ waitUntil: 'domcontentloaded' }) }
  await expect(saveButton()).toBeEnabled()
  const packets = Object.fromEntries(await Promise.all(['meta', 'business', 'website', 'measurement'].map(async section => [section, await source(section)])))
  assert.equal(packets.business.packet.result.data.metrics.booked_value.current.value, 1400)
  const originalText = await observation(); assert.ok(originalText.includes('Booked value: $1,400'))
  const visibleNotes = () => page.locator('[data-reporting-workspace] > p[role="status"]')
  await expect(visibleNotes()).toContainText(['Fictional saved-report preview. No connected Example Studio evidence.'])
  const originalNotes = await visibleNotes().allTextContents()
  proof.preflight = { fourPreparedPackets: true, saveEnabled: true, originalText, snapshotIds: Object.fromEntries(Object.entries(packets).map(([key, reply]) => [key, reply.snapshot.id])) }
  await page.screenshot({ path: `${output}/preflight.png` })
  if (!preflight) {
    const state = async expected => expect.poll(() => {
      const url = new URL(page.url())
      return Object.fromEntries(Object.keys(expected).map(key => [key, key === 'path' ? url.pathname : key === 'hash' ? url.hash : url.searchParams.get(key)]))
    }).toEqual(expected)
    const originalView = async () => banner().getByRole('link', { name: 'Original saved view', exact: true }).click()
    const sidebar = name => page.locator('#primary-nav').getByRole('link', { name, exact: true })
    const download = async (label, tag) => {
      const pending = page.waitForEvent('download', { timeout: 25_000 })
      await page.getByRole('button', { name: label, exact: true }).click()
      const file = await pending, bytes = await readFile(await file.path())
      await writeFile(`${output}/${tag}-${file.suggestedFilename()}`, bytes)
      return csvRows(bytes.toString('utf8'))
    }
    const save = async title => {
      const disclosure = page.locator('summary').filter({ hasText: /^Save report$/ })
      await expect(disclosure).toHaveCount(1)
      await disclosure.focus(); await disclosure.press('Enter')
      await page.getByLabel('Report name', { exact: true }).fill(title)
      await expect(saveButton()).toBeEnabled()
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reporting/saved' && response.request().method() === 'POST')
      await saveButton().click()
      const response = await responsePromise
      assert.equal(response.status(), 200)
      await page.waitForURL(url => /^[0-9a-f-]{36}$/.test(url.searchParams.get('saved') ?? ''))
      const saved = await savedReply(new URL(page.url()).searchParams.get('saved'))
      await expect(banner()).toContainText(title)
      return saved
    }
    const settled = async width => {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(() => document.fonts.ready)
      await expect.poll(() => page.locator('#primary-nav').evaluate((nav, mobile) =>
        (mobile ? nav.inert && nav.getAttribute('aria-hidden') === 'true' && getComputedStyle(nav).visibility === 'hidden' : getComputedStyle(nav).visibility === 'visible')
        && nav.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'), width < 1024)).toBe(true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    }
    const focus = async target => {
      await target.evaluate(element => {
        const main = document.getElementById('main-content')
        main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16
      })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    const bounds = async scope => scope.locator('p,h3,a,td,th,summary').evaluateAll(elements => elements.flatMap(element => {
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
          problems.push({ text: node.textContent, tag: element.tagName, width: box.width })
      }
      return problems
    }))
    const customerExports = (rows, saved) => {
      const subset = rows.filter(row => row.entity.startsWith('Acuity customer'))
      const customers = saved.data.business.data.intelligence.customers.data
      const populations = [[customers.metrics, 'Acuity customer history'], ...customers.groups.map(group =>
        [group.metrics, `Acuity customer cohort · ${group.name} (${group.id})`])]
      assert.equal(subset.length, 32)
      for (const [metrics, entity] of populations) for (const metric of Object.values(metrics)) {
        const row = subset.find(row => row.entity === entity && row.metric === metric.label)
        assert.ok(row)
        for (const [period, valueKey, claimKey, inputsKey] of [['current', 'value', 'claim_id', 'input_claim_ids'], ['previous', 'previous_value', 'previous_claim_id', 'previous_input_claim_ids']]) {
          const claim = metric[period]
          assert.equal(row[valueKey], claim.availability.state === 'available' && claim.value !== null ? String(claim.value) : '')
          assert.equal(row[claimKey], claim.claimId); assert.deepEqual(JSON.parse(row[inputsKey]), claim.inputClaimIds)
        }
      }
      assert.ok(!JSON.stringify(rows).includes('@example.test'))
      return subset
    }
    const probe = await context.newPage()
    await probe.setContent('<div id="fits"><p style="width:160px;white-space:nowrap">$12345.6789</p></div><div id="bad"><p style="width:16px;white-space:nowrap">$12345.6789</p></div>')
    assert.deepEqual(await bounds(probe.locator('#fits')), []); assert.equal((await bounds(probe.locator('#bad'))).length, 1)
    await probe.close(); proof.geometryControl = { fittingAccepted: true, oversizedRejected: true }
    await expect(page.getByRole('region', { name: 'Report actions', exact: true })).toBeVisible()
    const actionBox = await page.locator('summary').filter({ hasText: /^Save report$/ }).boundingBox()
    assert.ok(actionBox && actionBox.y >= 0 && actionBox.y < 700, 'Save report is discoverable near the report header')
    const unique = randomUUID().slice(0, 8), titleA = `S2 original A ${unique}`
    const beforeSave = await audit('before save A')
    const savedA = await save(titleA), idA = savedA.saved.id
    console.log(JSON.stringify({ stage: 'saved A', id: idA }))
    assert.equal(savedA.data.business.data.metrics.booked_value.current.value, 1400)
    assert.deepEqual(savedA.notes, originalNotes); assert.match(savedA.saved.notesIdentity, /^sha256:[a-f0-9]{64}$/)
    await expect(visibleNotes()).toHaveText(originalNotes)
    assert.equal(savedA.review.findings.find(item => item.id === 'business_customers').observation.text, originalText)
    for (const section of ['meta', 'business', 'website', 'measurement']) {
      assert.equal(savedA.saved.sources[section].state, 'snapshot')
      assert.equal(savedA.saved.sources[section].receipt.id, packets[section].snapshot.id)
    }
    await noLive(beforeSave, 'save A no source calls')
    assert.equal(await observation(), originalText)
    await page.getByRole('link', { name: 'Explore customer groups', exact: true }).click()
    await state({ saved: idA, report: 'business', hash: '#business-customers' })
    assert.equal(await observation(), originalText)
    const originalBusiness = await download('Export full business report', 'original-A')
    customerExports(originalBusiness, savedA)
    await page.getByRole('tab', { name: /^Results/ }).click()
    const originalResults = await download('Export full results', 'original-A')
    assert.deepEqual(customerExports(originalResults, savedA), customerExports(originalBusiness, savedA))
    await page.getByRole('searchbox', { name: 'Search assessments', exact: true }).fill('business_customers')
    const assessment = page.locator('[data-review-id="business_customers"]')
    await expect(assessment.locator(':scope > p').last()).toHaveText(originalText)
    await noLive(beforeSave, 'original saved customer/results drills')

    const publishedB = await publish('stable')
    assert.notEqual(publishedB.ids.business, savedA.saved.sources.business.receipt.id)
    await banner().getByRole('link', { name: 'Open current report', exact: true }).click()
    await state({ saved: null })
    await expect(page.getByRole('region', { name: 'Business results', exact: true })).toContainText('$1,000.00')
    await expect(assessment.locator(':scope > p').last()).not.toHaveText(originalText)
    await expect(saveButton()).toBeEnabled()
    const currentB = await source('business')
    assert.equal(currentB.packet.result.data.metrics.booked_value.current.value, 1000)
    await page.getByRole('link', { name: 'Saved reports', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Saved reports', exact: true })).toBeVisible()
    const freezeAudit = await audit('before reopening A after B')
    const listLink = page.getByRole('link', { name: titleA, exact: true })
    await listLink.focus(); await listLink.press('Enter')
    await state({ saved: idA }); assert.equal(await observation(), originalText)
    console.log(JSON.stringify({ stage: 'current B verified; reopened A', id: idA }))
    const reopenedA = await savedReply(idA)
    assert.deepEqual(reopenedA, savedA)
    await expect(visibleNotes()).toHaveText(originalNotes)
    await page.reload({ waitUntil: 'domcontentloaded' }); assert.equal(await observation(), originalText)
    await page.goBack({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Saved reports', exact: true })).toBeVisible()
    await page.getByRole('link', { name: titleA, exact: true }).click()
    assert.equal(await observation(), originalText)
    await page.getByRole('link', { name: 'Explore customer groups', exact: true }).click()
    await state({ saved: idA, report: 'business' })
    assert.deepEqual(await download('Export full business report', 'reopened-A'), originalBusiness)
    const service = page.locator('[data-business-driver]').getByRole('link').first()
    await service.click(); await state({ saved: idA, business_q: savedA.data.business.data.types[0].id })
    await expect(page.locator('[data-business-service]')).toHaveCount(1)
    await page.getByRole('tab', { name: /^Results/ }).click()
    assert.deepEqual(await download('Export full results', 'reopened-A'), originalResults)
    for (const name of [/^Business/, /^Creative/, /^Website journey/, /^Audience report/, /^Results/]) {
      await page.getByRole('tab', { name }).click(); await state({ saved: idA })
    }
    await sidebar('Ads').click(); await state({ path: '/performance', saved: idA })
    await page.getByRole('navigation', { name: 'Reporting hierarchy', exact: true }).getByRole('link', { name: 'Campaigns', exact: true }).click()
    const table = page.getByRole('region', { name: 'Entity metrics, scroll for more columns', exact: true })
    await table.getByRole('link', { name: 'Studio rentals', exact: true }).click()
    await state({ saved: idA, level: 'adset', campaign: 'campaign-1' })
    await table.getByRole('link', { name: 'Local creators', exact: true }).click()
    await state({ saved: idA, level: 'ad', adset: 'set-1' })
    await table.getByRole('link', { name: 'Studio walkthrough', exact: true }).click()
    await state({ saved: idA, ad: 'ad-1' })
    await expect(page.getByRole('heading', { name: 'Studio walkthrough', exact: true })).toBeVisible()
    await expect(page.getByText('Additional daily history and placement breakdowns for this ad were not included in the saved report.', { exact: false })).toBeVisible()
    const adRows = await download('Export CSV', 'saved-ad')
    const ad = savedA.data.meta.data.entities.find(entity => entity.id === 'ad-1')
    const adSpend = adRows.find(row => row.metric === ad.metrics.spend.label)
    assert.equal(adSpend.claim_id, ad.metrics.spend.current.claimId); assert.equal(Number(adSpend.value), ad.metrics.spend.current.value)
    await sidebar('Creative').click(); await state({ path: '/creative', saved: idA })
    await expect(page.getByRole('heading', { name: 'Creative performance', exact: true })).toBeVisible()
    await page.locator('article[aria-label="Portrait still"]').getByRole('link', { name: 'Portrait still', exact: true }).click()
    await state({ saved: idA, ad: 'ad-2' })
    await originalView(); await state({ path: '/dashboard', saved: idA }); assert.equal(await observation(), originalText)
    await expect(page.getByTitle('Dates and data are fixed. Open current report to change dates or sync.')).toBeVisible()
    await expect(page.getByTitle('Change the date range (applies across pages)')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Refresh / })).toHaveCount(0)
    await noLive(freezeAudit, 'A navigation preserves frozen evidence')

    for (const width of [1440, 320]) {
      await settled(width); await focus(banner())
      assert.deepEqual(await bounds(banner()), [], `Saved identity/banner fits ${width}`)
      await page.screenshot({ path: `${output}/saved-banner-${width}.png` })
      await focus(page.getByRole('region', { name: 'Customer history summary', exact: true }))
      assert.deepEqual(await bounds(page.getByRole('region', { name: 'Customer history summary', exact: true })), [])
      const paragraph = summary().locator(':scope > p').last()
      const glyphs = await paragraph.evaluate(element => {
        const box = element.getBoundingClientRect(), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode()) && !node.textContent.includes('Prior booking in retained history')) { /* find the exact native observation */ }
        if (!node) throw new Error('Native prior-group wording missing')
        const start = node.textContent.indexOf('Prior booking in retained history')
        const letters = [...'Prior booking in retained history'].map((char, offset) => {
          const range = document.createRange(); range.setStart(node, start + offset); range.setEnd(node, start + offset + 1)
          const rect = range.getBoundingClientRect()
          return { char, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        })
        return { box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, letters, font: getComputedStyle(element).font, fontsStatus: document.fonts.status }
      })
      assert.equal(glyphs.fontsStatus, 'loaded')
      assert.ok(glyphs.letters.every(rect => rect.left >= glyphs.box.left - 1 && rect.right <= glyphs.box.right + 1 && rect.top >= glyphs.box.top - 1 && rect.bottom <= glyphs.box.bottom + 1))
      proof[`observationGlyphs${width}`] = glyphs
      await page.screenshot({ path: `${output}/saved-customer-${width}.png` })
      await paragraph.screenshot({ path: `${output}/saved-observation-${width}.png` })
    }
    await focus(banner()); await banner().getByRole('link', { name: 'Saved reports', exact: true }).focus(); await page.keyboard.press('Enter')
    await expect(page.getByRole('link', { name: titleA, exact: true })).toBeVisible()
    assert.deepEqual(await bounds(page.locator('#main-content')), [], 'Saved list fits320')
    await page.screenshot({ path: `${output}/saved-list-320.png` })
    await page.getByRole('link', { name: titleA, exact: true }).focus(); await page.keyboard.press('Enter')
    await page.getByRole('link', { name: 'Explore customer groups', exact: true }).click()
    await state({ saved: idA, report: 'business' }); await expect(page.locator('#business-customers')).toBeVisible()
    await page.setViewportSize({ width: 794, height: 1123 }); await page.emulateMedia({ media: 'print' })
    assert.deepEqual(await bounds(page.locator('#business-customers')), [], 'Saved customer A4 text stays in columns')
    await page.pdf({ path: `${output}/saved-A.pdf`, format: 'A4', printBackground: true })
    await page.emulateMedia({ media: 'screen' }); await settled(1440)
    await noLive(freezeAudit, 'A mobile/list/print preserves frozen evidence')
    const beforeCurrent = await audit('before explicit current exit')
    await banner().getByRole('link', { name: 'Open current report', exact: true }).click()
    await state({ saved: null }); await expect(saveButton()).toBeEnabled()
    await expect(page.getByRole('region', { name: 'Business results', exact: true })).toContainText('$1,000.00')
    await page.getByTitle('Change the date range (applies across pages)').click()
    await page.getByLabel('From date', { exact: true }).fill('2026-08-30')
    await page.getByLabel('To date', { exact: true }).fill('2026-09-01'); await page.keyboard.press('Escape')
    await state({ from: '2026-08-30', to: '2026-09-01', saved: null })
    await expect(saveButton()).toBeEnabled()
    assert.ok((await audit('after explicit current/date exit')).liveReads > beforeCurrent.liveReads)
    assert.deepEqual(await savedReply(idA), savedA)
    console.log(JSON.stringify({ stage: 'frozen navigation, exports, mobile, print and explicit exit passed' }))
    proof.original = { id: idA, title: titleA, reviewIdentity: savedA.saved.reviewIdentity, dataIdentity: savedA.saved.dataIdentity,
      originalText, originalNotes, notesIdentity: savedA.saved.notesIdentity, originalBusinessRows: originalBusiness.length, originalResultsRows: originalResults.length, customerRows: 32,
      currentB: 1000, originalA: 1400, exactReopen: true, frozenNavigationAudit: true, fixedDatesAndExplicitExit: true }

    await publish('movement'); await newSession('fallback')
    await page.locator('summary').filter({ hasText: /^Save report$/ }).click()
    await expect(page.getByRole('region', { name: 'Report actions', exact: true })).toContainText('Exact saving is unavailable for this report.')
    await expect(saveButton()).toBeDisabled(); assert.ok((await observation()).includes('$1,400'))
    await sidebar('Reports').click(); await expect(page.getByRole('button', { name: 'Export full results', exact: true })).toBeEnabled()
    await download('Export full results', 'fallback-usable')
    proof.fallback = { cannotSave: true, usefulExport: true }

    await newSession('retained'); await expect(saveButton()).toBeEnabled()
    const retainedSource = await source('business')
    const failedRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reporting'
      && new URL(response.url()).searchParams.get('section') === 'business' && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Refresh Acuity business', exact: true }).click()
    assert.equal((await failedRefresh).status(), 503)
    await expect(page.getByLabel('Acuity business source details', { exact: true })).toContainText('Refresh failed')
    const retainedAudit = await audit('retained A after failed refresh')
    const retained = await save(`S2 retained ${unique}`)
    assert.equal(retained.saved.sources.business.state, 'retained_snapshot')
    assert.equal(retained.saved.sources.business.receipt.id, retainedSource.snapshot.id)
    assert.equal(retained.data.business.data.metrics.booked_value.current.value, 1400)
    await expect(page.getByLabel('Acuity business source details', { exact: true })).toContainText('Saved previous evidence')
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(banner()).toContainText(`S2 retained ${unique}`)
    await noLive(retainedAudit, 'retained save/reopen no live reads')
    console.log(JSON.stringify({ stage: 'fallback and retained cases passed' }))
    proof.retained = { id: retained.saved.id, businessSnapshotId: retainedSource.snapshot.id, value: 1400 }

    await newSession('missing'); await expect(saveButton()).toBeEnabled()
    await expect(page.getByLabel('GA4 website source details', { exact: true })).toContainText('Unavailable')
    const missingAudit = await audit('before missing website save')
    const missing = await save(`S2 missing ${unique}`)
    assert.equal(missing.saved.sources.website.state, 'unavailable'); assert.equal(missing.data.website.data, null)
    await noLive(missingAudit, 'missing source save no live reads')
    await newSession('normal'); await expect(saveButton()).toBeEnabled()
    assert.ok((await source('website')).packet.result.data)
    const recoveryAudit = await audit('website recovered before missing-snapshot reopen')
    await page.goto(`${origin}/dashboard?from=2026-09-02&to=2026-09-04&saved=${missing.saved.id}`, { waitUntil: 'domcontentloaded' })
    await expect(banner()).toContainText(`S2 missing ${unique}`)
    await expect(page.getByLabel('GA4 website source details', { exact: true })).toContainText('Unavailable')
    assert.equal((await savedReply(missing.saved.id)).data.website.data, null)
    await noLive(recoveryAudit, 'missing saved source remains missing after recovery')
    proof.missing = { id: missing.saved.id, laterRecoveryNotSubstituted: true }

    const unknown = randomUUID(), invalidAudit = await audit('before unknown saved ID')
    await page.goto(`${origin}/dashboard?saved=${unknown}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-reporting-workspace] > div[role="status"]')).toContainText('This saved report is unavailable for the selected account.')
    await expect(summary()).toHaveCount(0); await expect(saveButton()).toHaveCount(0)
    assert.equal((await context.request.get(`${origin}/api/reporting/saved/${unknown}`)).status(), 404)
    await noLive(invalidAudit, 'unknown saved ID cannot substitute current')
    for (const invalid of ['', 'bad']) {
      const invalidInputAudit = await audit(`before invalid saved parameter ${JSON.stringify(invalid)}`)
      await page.goto(`${origin}/dashboard?saved=${invalid}`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-reporting-workspace] > div[role="status"]')).toContainText('The saved report could not be validated.')
      await expect(summary()).toHaveCount(0); await expect(saveButton()).toHaveCount(0)
      await noLive(invalidInputAudit, `invalid saved parameter ${JSON.stringify(invalid)} cannot substitute current`)
    }
    await newSession('denied')
    const deniedAudit = await audit('before denied saved open')
    await page.goto(`${origin}/dashboard?saved=${idA}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-reporting-workspace] > div[role="status"]')).toContainText('Your session cannot access this report. Sign in with the owner account.')
    await expect(summary()).toHaveCount(0); await expect(saveButton()).toHaveCount(0)
    assert.equal((await context.request.get(`${origin}/api/reporting/saved/${idA}`)).status(), 403)
    await page.goto(`${origin}/reports/saved`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#main-content').getByRole('alert')).toContainText('Your session does not have access to saved reports for this account.')
    await expect(page.getByText('No saved reports yet.', { exact: false })).toHaveCount(0)
    await noLive(deniedAudit, 'denied saved/list do not load current')
    proof.denial = { unknownId404: true, emptyAndMalformedRejected: true, ownerDenied403: true, noSubstitution: true, failedListNotEmpty: true }

  }
  assert.deepEqual(errors, [])
  proof.result = 'pass'; proof.finishedAt = new Date().toISOString(); console.log(JSON.stringify(proof))
} catch (error) {
  proof.result = 'failed'; proof.error = String(error)
  if (page) { proof.url = page.url(); await page.screenshot({ path: `${output}/failure.png` }).catch(() => {}) }
  throw error
} finally {
  if (browser) await browser.close()
  await writeFile(`${output}/results${preflight ? '-preflight' : ''}.json`, JSON.stringify({ ...proof, errors, blocked, requests, audits }, null, 2))
}
