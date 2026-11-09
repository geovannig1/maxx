// Ordinary local fictional workflow; no response replacement or connected account writes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect as playwrightExpect } from '@playwright/test'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'
import { validateSavedReportReply } from '../../src/lib/reporting/saved-validation.ts'
import { deriveExpertReview } from '../../src/lib/reporting/review/index.ts'

const historical = process.argv.includes('--historical')
const liveOnly = process.argv.includes('--live-only')
const output = `test-results/reporting-preview/ad-review/${historical ? 'historical' : 'current'}`
const expect = playwrightExpect.configure({ timeout: 25_000 })
const proof = { startedAt: new Date().toISOString(), errors: [], blocked: [], responses: [] }
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
page.on('pageerror', error => proof.errors.push(error.message))
page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/reporting')) proof.responses.push({ url: response.url(), status: response.status() }) })
await context.route('**/*', route => {
  const request = route.request(), url = new URL(request.url())
  if (['http://127.0.0.1:3149', 'http://127.0.0.1:3150'].includes(url.origin)
    && (['GET', 'HEAD'].includes(request.method()) || url.port === '3150' && request.method() === 'POST'
      && ['/api/reporting', '/api/reporting/saved', '/__fixture/current'].includes(url.pathname))) return route.continue()
  proof.blocked.push({ url: request.url(), method: request.method() }); return route.abort('blockedbyclient')
})
const normalize = text => text.replace(/\s+/g, ' ').trim()
const card = id => page.locator(`[data-review-id="${id}"]`)
const exactFindings = (review, id) => review.findings.filter(row => row.entity?.level === 'ad' && row.entity.id === id)
const matchText = async findings => {
  await expect.poll(() => page.locator('[data-ad-review] [data-review-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-review-id')).sort())).toEqual(findings.map(row => row.id).sort())
  for (const finding of findings) await expect.poll(() => card(finding.id).locator('[data-observation-text]').allTextContents().then(parts => normalize(parts.join(' ')))).toBe(normalize(finding.observation.text))
}
const savedRead = async id => {
  const response = await context.request.get(`http://127.0.0.1:3150/api/reporting/saved/${id}`)
  assert.equal(response.status(), 200); return validateSavedReportReply(await response.json())
}
try {
  if (!historical) {
    await page.goto('http://127.0.0.1:3149/preview?scenario=creative')
    const packets = await Promise.all(['meta', 'business', 'website', 'measurement'].map(async section => {
      const response = await context.request.get(`http://127.0.0.1:3149/api/reporting?section=${section}&from=2026-09-02&to=2026-09-04`)
      assert.equal(response.status(), 200); return validateReportingPacket(await response.json())
    }))
    const data = { context: packets[0].context, ...Object.fromEntries(packets.map(packet => [packet.section, packet.result])) }
    const review = deriveExpertReview(data), findings = exactFindings(review, '301')
    assert.ok(findings.length > 2); assert.deepEqual(review.input.rejectedSources, [])
    await page.goto('http://127.0.0.1:3149/creative?from=2026-09-02&to=2026-09-04')
    const execution = page.locator('article[aria-label]').filter({ has: page.getByRole('checkbox') }).filter({ hasText: 'Ad 301 · Creative' })
    await execution.getByRole('link').first().click()
    await matchText(findings)
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      const navigation = page.locator('#primary-nav nav a').first()
      if (width === 320) await expect(navigation).toBeHidden(); else await expect(navigation).toBeVisible()
      await page.locator('[data-ad-review]').scrollIntoViewIfNeeded()
      const overflow = () => page.locator('[data-ad-review]').evaluate(element => {
        const bounds = element.getBoundingClientRect(), walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), failures = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent.trim() || !node.parentElement.checkVisibility()) continue
          if (node.parentElement.closest('details:not([open])') && !node.parentElement.closest('summary')) continue
          const range = document.createRange(); range.selectNodeContents(node)
          if ([...range.getClientRects()].some(rect => rect.width && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1))) failures.push(node.textContent)
        }
        return failures
      })
      assert.deepEqual(await overflow(), [])
      const control = card(findings[0].id).locator('[data-observation-text]').first(), oldStyle = await control.getAttribute('style')
      await control.evaluate(element => { element.style.marginLeft = '3000px' })
      assert.ok((await overflow()).length > 0)
      await control.evaluate((element, style) => style === null ? element.removeAttribute('style') : element.setAttribute('style', style), oldStyle)
      assert.deepEqual(await overflow(), [])
      await page.screenshot({ path: `${output}/ad-review-${width}.png` })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('link', { name: 'All assessments for this ad', exact: true }).click()
    await expect(page.getByLabel('Exact entity', { exact: true })).toHaveValue('ad:301')
    await expect.poll(() => page.locator('[data-review-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-review-id')).sort())).toEqual(findings.map(row => row.id).sort())
    await page.reload(); await expect(page.getByLabel('Exact entity', { exact: true })).toHaveValue('ad:301')
    await page.getByRole('button', { name: 'Clear assessment filters', exact: true }).click()
    await expect(page.getByLabel('Exact entity', { exact: true })).toHaveValue('')
    await page.goBack(); await expect(page.getByLabel('Exact entity', { exact: true })).toHaveValue('ad:301')
    await card(findings[0].id).getByRole('link').click(); await matchText(findings)
    await card(findings[0].id).getByRole('link').click()
    await expect.poll(() => new URL(page.url()).hash).toBe('#ad-metrics')
    await expect(page.locator('#ad-metrics')).toBeInViewport()
    await page.getByRole('link', { name: 'Results and ROAS', exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get('group')).toBe('results')
    await expect(page.locator('#ad-metrics')).toBeInViewport()
    for (const label of ['Purchase ROAS', 'AppointmentConfirmed ROAS', 'Reported purchase value', 'Reported purchases']) {
      await expect(page.locator('#ad-metrics')).toContainText(label)
    }
    await expect(card('creative_response:301')).toContainText('Purchase count')
    await page.getByRole('link', { name: 'Website context', exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get('report')).toBe('website')
    assert.equal(new URL(page.url()).searchParams.get('ad'), null)
    await page.goBack(); await matchText(findings)
    await page.goto('http://127.0.0.1:3149/performance?from=2026-09-02&to=2026-09-04&level=ad&ad=308')
    await matchText(exactFindings(review, '308'))
    proof.live = { exactAd: '301', findingIds: findings.map(row => row.id), lowerMember: '308', completeOriginalText: true, websiteSeparate: true, mobileAndOverflowControl: true }
  }
  if (!liveOnly) {
  await page.goto('http://127.0.0.1:3150/preview?scenario=normal')
  let saved
  if (historical) {
    const original = JSON.parse(await readFile('test-results/reporting-preview/executive-reading/current/saved-original.json', 'utf8'))
    saved = await savedRead(original.saved.id); assert.deepEqual(saved, original)
  } else {
    assert.equal((await context.request.post('http://127.0.0.1:3150/__fixture/current', { headers: { Origin: 'http://127.0.0.1:3150' }, data: { mode: 'media' } })).status(), 200)
    await page.goto('http://127.0.0.1:3150/reports?from=2026-09-02&to=2026-09-04&report=results&review_entity=ad%3Aad-lower#full-assessments')
    await expect(page.getByLabel('Exact entity', { exact: true })).toHaveValue('ad:ad-lower')
    await page.locator('summary').filter({ hasText: /^Save report$/ }).click()
    await page.getByLabel('Report name', { exact: true }).fill('Fictional exact ad review')
    const button = page.getByRole('button', { name: 'Save this report', exact: true }); await expect(button).toBeEnabled()
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reporting/saved' && response.request().method() === 'POST')
    await button.click(); const response = await saving; assert.equal(response.status(), 200)
    saved = await validateSavedReportReply(await response.json())
    assert.equal(saved.review.playbookVersion, 'maxx-diagnostic-2026-09-07.v12')
    assert.equal(saved.saved.view.query.review_entity, 'ad:ad-lower')
  }
  await writeFile(`${output}/saved-original.json`, JSON.stringify(saved, null, 2))
  const findings = exactFindings(saved.review, 'ad-lower'); assert.ok(findings.length)
  await page.goto(`http://127.0.0.1:3150/performance?level=ad&ad=ad-lower&from=2026-09-02&to=2026-09-04&saved=${saved.saved.id}`)
  await matchText(findings)
  const before = await (await context.request.get('http://127.0.0.1:3150/__fixture/audit')).json()
  if (!historical) assert.equal((await context.request.post('http://127.0.0.1:3150/__fixture/current', { headers: { Origin: 'http://127.0.0.1:3150' }, data: { mode: 'stable' } })).status(), 200)
  await page.reload(); await matchText(findings)
  await page.getByRole('link', { name: 'All assessments for this ad', exact: true }).click()
  await expect(page.getByLabel('Exact entity', { exact: true })).toHaveValue('ad:ad-lower')
  assert.equal(new URL(page.url()).searchParams.get('saved'), saved.saved.id)
  await card(findings[0].id).getByRole('link').click(); await matchText(findings)
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
  const file = await downloading, csv = await readFile(await file.path(), 'utf8')
  assert.ok(csv.includes('ad-lower')); assert.ok(csv.includes('Purchase')); assert.ok(csv.includes('AppointmentConfirmed'))
  await writeFile(`${output}/ad-detail.csv`, csv)
  await page.pdf({ path: `${output}/ad-review.pdf`, format: 'A4', printBackground: true })
  const print = execFileSync('/opt/homebrew/bin/pdftotext', ['-raw', `${output}/ad-review.pdf`, '-'], { encoding: 'utf8' })
  for (const finding of findings) assert.ok(normalize(print).includes(normalize(finding.observation.text)), 'Print preserves full original observation')
  // Chromium's PDF extractor drops spaces in semibold headings; body comparisons above stay exact.
  assert.ok(print.replace(/\s/g, '').includes('Evidenceandlimits'))
  assert.ok(normalize(print).includes('Selected-period evidence'))
  assert.deepEqual(await savedRead(saved.saved.id), saved)
  const after = await (await context.request.get('http://127.0.0.1:3150/__fixture/audit')).json()
  assert.equal(after.liveReads, before.liveReads); assert.equal(after.liveRefreshes, before.liveRefreshes)
  proof.saved = { id: saved.saved.id, playbook: saved.review.playbookVersion, originalPreserved: true, findings: findings.map(row => row.id), before, after }
  }
  assert.deepEqual(proof.errors, [])
  assert.deepEqual(proof.blocked.filter(row => row.url !== 'https://example.test/creative.jpg'), [])
  assert.ok(proof.responses.every(row => row.status === 200))
  proof.finishedAt = new Date().toISOString()
  await writeFile(`${output}/proof.json`, JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2))
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  await writeFile(`${output}/failure.json`, JSON.stringify({ ...proof, failure: String(error) }, null, 2)); throw error
} finally { await browser.close() }
