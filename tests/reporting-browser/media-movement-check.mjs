import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validateSavedReportReply } from '../../src/lib/reporting/saved-validation.ts'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'
import { deriveExpertReview } from '../../src/lib/reporting/review/index.ts'

const historical = process.argv.includes('--historical-only')
const output = `test-results/reporting-preview/media-movement/${historical ? 'historical' : 'current'}`
const expect = playwrightExpect.configure({ timeout: 25_000 })
const proof = { startedAt: new Date().toISOString(), errors: [], blocked: [], responses: [] }
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
page.on('pageerror', error => proof.errors.push(error.message))
page.on('response', response => {
  const url = new URL(response.url())
  if (url.pathname.startsWith('/api/reporting')) proof.responses.push({ path: url.pathname, status: response.status() })
})
await context.route('**/*', route => {
  const request = route.request(), url = new URL(request.url())
  if (['http://127.0.0.1:3149', 'http://127.0.0.1:3150'].includes(url.origin) && (['GET', 'HEAD'].includes(request.method())
    || url.port === '3150' && request.method() === 'POST' && ['/api/reporting', '/api/reporting/saved', '/__fixture/current'].includes(url.pathname))) return route.continue()
  proof.blocked.push({ origin: url.origin, path: url.pathname, method: request.method() }); return route.abort('blockedbyclient')
})
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
const normalize = text => text.replace(/\s+/g, ' ').trim()
const assessment = id => page.locator(`[data-review-id="${id}"]`)
try {
  if (historical) {
    const archived = JSON.parse(await readFile('test-results/reporting-preview/performance-discovery/saved-original.json', 'utf8'))
    await page.goto('http://127.0.0.1:3150/preview?scenario=normal')
    const response = await context.request.get(`http://127.0.0.1:3150/api/reporting/saved/${archived.saved.id}`)
    assert.equal(response.status(), 200)
    const original = await validateSavedReportReply(await response.json())
    assert.deepEqual(original, archived)
    await page.goto(`http://127.0.0.1:3150/dashboard?saved=${original.saved.id}&from=2026-09-02&to=2026-09-04`)
    const finding = original.review.findings.find(row => row.id === 'advertising.allocation')
    await expect(assessment(finding.id)).toContainText(finding.observation.text)
    await page.reload(); await expect(assessment(finding.id)).toContainText(finding.observation.text)
    proof.historical = { id: original.saved.id, playbook: original.review.playbookVersion, exactOriginalReply: true, originalObservation: finding.observation.text }
    await page.screenshot({ path: `${output}/original.png` })
  } else {
    await page.goto('http://127.0.0.1:3149/preview?scenario=media-movement')
    const packetResponse = await context.request.get('http://127.0.0.1:3149/api/reporting?section=meta&from=2026-09-02&to=2026-09-04')
    assert.equal(packetResponse.status(), 200)
    const packet = validateReportingPacket(await packetResponse.json())
    const missing = { state: 'unavailable', data: null, asOf: null, notes: [] }
    const review = deriveExpertReview({ context: packet.context, meta: packet.result, business: missing, website: missing, measurement: missing })
    assert.deepEqual(review.input.rejectedSources, [])
    const original = review.findings.find(row => row.id === 'advertising.allocation')
    await expect(assessment(original.id)).toContainText(original.observation.text)
    await expect(assessment(original.id)).toContainText('Largest loss: Smaller loss (-$200)')
    await expect(page.locator('[data-executive-observation]')).toContainText('AppointmentConfirmed count fell (15; prior 16)')
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      const navigation = page.locator('#primary-nav nav a').first()
      if (width === 320) await expect(navigation).toBeHidden()
      else await expect(navigation).toBeVisible()
      const box = assessment(original.id)
      await box.evaluate(element => { const main = document.getElementById('main-content'); main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 16 })
      const detectOverflow = () => box.evaluate(element => {
        const box = element.getBoundingClientRect(), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), failures = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim() || !node.parentElement?.checkVisibility()) continue
          const range = document.createRange(); range.selectNodeContents(node)
          if ([...range.getClientRects()].some(rect => rect.width && (rect.left < box.left - 1 || rect.right > box.right + 1))) failures.push(node.textContent)
        }
        return failures
      })
      assert.deepEqual(await detectOverflow(), [])
      if (width === 320) {
        await box.evaluate(element => { const bad = document.createElement('span'); bad.dataset.negativeControl = 'overflow'; bad.style.whiteSpace = 'nowrap'; bad.textContent = 'OVERSIZED'.repeat(80); element.append(bad) })
        assert.ok((await detectOverflow()).length > 0)
        await box.locator('[data-negative-control]').evaluate(element => element.remove())
        assert.deepEqual(await detectOverflow(), [])
      }
      await page.screenshot({ path: `${output}/overview-${width}.png` })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await assessment(original.id).getByRole('link').click()
    await expect.poll(() => new URL(page.url()).searchParams.get('level')).toBe('campaign')
    await expect(page.getByRole('link', { name: 'Smaller loss', exact: true })).toBeVisible()
    await page.goBack(); await expect(assessment(original.id)).toContainText(original.observation.text)
    await page.reload(); await expect(assessment(original.id)).toContainText(original.observation.text)
    proof.current = { nativePlaybook: review.playbookVersion, originalObservation: original.observation.text, canonicalAccount: packet.result.data.metrics.bookings.current.value }
    await page.goto('http://127.0.0.1:3150/preview?scenario=normal')
    const changed = await context.request.post('http://127.0.0.1:3150/__fixture/current', { headers: { Origin: 'http://127.0.0.1:3150' }, data: { mode: 'media' } })
    assert.equal(changed.status(), 200)
    await page.reload(); await expect(assessment('advertising.allocation')).toContainText('Largest loss: Smaller loss (-$200)')
    await page.locator('summary').filter({ hasText: /^Save report$/ }).click()
    await page.getByLabel('Report name', { exact: true }).fill('Fictional media movement review')
    const button = page.getByRole('button', { name: 'Save this report', exact: true }); await expect(button).toBeEnabled()
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reporting/saved' && response.request().method() === 'POST')
    await button.click(); const response = await saving; assert.equal(response.status(), 200)
    const saved = await validateSavedReportReply(await response.json())
    assert.equal(saved.review.playbookVersion, 'maxx-diagnostic-2026-09-07.v10')
    await writeFile(`${output}/saved-original.json`, JSON.stringify(saved, null, 2))
    await page.waitForURL(url => url.searchParams.get('saved') === saved.saved.id)
    const finding = saved.review.findings.find(row => row.id === 'advertising.allocation')
    const before = await (await context.request.get('http://127.0.0.1:3150/__fixture/audit')).json()
    const stable = await context.request.post('http://127.0.0.1:3150/__fixture/current', { headers: { Origin: 'http://127.0.0.1:3150' }, data: { mode: 'stable' } })
    assert.equal(stable.status(), 200)
    await page.reload(); await expect(assessment(finding.id)).toContainText(finding.observation.text)
    const originalReply = await (await context.request.get(`http://127.0.0.1:3150/api/reporting/saved/${saved.saved.id}`)).json()
    assert.deepEqual(originalReply, saved)
    const lower = saved.review.findings.find(row => row.id === 'performance:adset:adset-lower')
    await page.goto(`http://127.0.0.1:3150/reports?report=results&review_q=${lower.id}&saved=${saved.saved.id}&from=2026-09-02&to=2026-09-04#full-assessments`)
    await expect(assessment(lower.id)).toContainText(lower.observation.text)
    await expect(assessment(lower.id)).toContainText('ROAS rose with lower spend despite lower reported value')
    await assessment(lower.id).getByRole('link').click()
    await expect.poll(() => new URL(page.url()).searchParams.get('adset')).toBe('adset-lower')
    await expect(page.getByRole('link', { name: 'Lower spend and value ad', exact: true })).toBeVisible()
    await page.goBack(); await expect(assessment(lower.id)).toContainText(lower.observation.text)
    await page.goto(`http://127.0.0.1:3150/reports?report=results&review_q=advertising.allocation&saved=${saved.saved.id}&from=2026-09-02&to=2026-09-04#full-assessments`)
    await expect(assessment(finding.id)).toContainText(finding.observation.text)
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export full results', exact: true }).click()
    const download = await downloading, csv = await readFile(await download.path(), 'utf8'), exported = csvRows(csv)
    await writeFile(`${output}/saved-full-results.csv`, csv)
    for (const entity of saved.data.meta.data.entities.filter(row => row.level === 'campaign' || row.level === 'adset')) {
      for (const key of ['spend', 'bookings', 'appointment_value', 'purchase_count', 'purchase_value', 'appointment_roas', 'purchase_roas']) {
        const metric = entity.metrics[key], row = exported.find(row => row.claim_id === metric.current.claimId)
        assert.ok(row, `Export includes ${entity.level} ${entity.id} ${key}`)
        assert.equal(row.value, metric.current.value === null ? '' : String(metric.current.value))
        assert.equal(row.previous_value, metric.previous?.value === null ? '' : String(metric.previous?.value))
        assert.equal(row.event, metric.event ?? '')
      }
    }
    await page.pdf({ path: `${output}/saved-media-review.pdf`, format: 'A4', printBackground: true })
    const after = await (await context.request.get('http://127.0.0.1:3150/__fixture/audit')).json()
    assert.equal(after.liveReads, before.liveReads); assert.equal(after.liveRefreshes, before.liveRefreshes)
    proof.saved = { exportRows: exported.length, id: saved.saved.id, before, after, originalObservation: normalize(finding.observation.text), originalPreservedAfterSourceChange: true }
  }
  assert.deepEqual(proof.errors, [])
  assert.deepEqual(proof.blocked.filter(row => !(row.origin === 'https://example.test' && row.path === '/creative.jpg' && row.method === 'GET')), [])
  assert.ok(proof.responses.every(row => row.status === 200))
  proof.finishedAt = new Date().toISOString()
} catch (error) {
  proof.failure = { message: error.message, stack: error.stack }; process.exitCode = 1
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2)); await context.close(); await browser.close()
}
