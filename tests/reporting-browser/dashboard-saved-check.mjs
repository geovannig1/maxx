// Fictional loopback preview only: the existing gateway uses its real saved service and isolated PGlite.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect as playwrightExpect } from '@playwright/test'

const origin = 'http://127.0.0.1:3150'
const output = await mkdtemp(join(tmpdir(), 'maxx-dashboard-saved-'))
const expect = playwrightExpect.configure({ timeout: 30_000 })
const account = '00000000-0000-4000-8000-000000001311'
const selection = { from: '2026-09-02', to: '2026-09-04', overview_event: 'purchase',
  overview_level: 'adset', overview_q: 'Local', overview_creative_size: '5',
  overview_creative_q: 'Studio', overview_creative_sort: 'cpa' }
const proof = { startedAt: new Date().toISOString(), population: 'Fictional saved-report studio; isolated PGlite, no connected account data',
  requestedSelection: selection, timeoutMs: 30_000, audits: [], errors: [], liveRequestsWhileFrozen: [], blockedExternalRequests: [] }
let browser, page, frozen = false
try {
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(30_000); context.setDefaultNavigationTimeout(30_000)
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin === origin && (['GET', 'HEAD'].includes(request.method())
      || request.method() === 'POST' && url.pathname === '/api/reporting/saved')) return route.continue()
    proof.blockedExternalRequests.push({ origin: url.origin, path: url.pathname, method: request.method() })
    return route.abort('blockedbyclient')
  })
  page = await context.newPage()
  page.on('pageerror', error => proof.errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (frozen && url.pathname === '/api/reporting') proof.liveRequestsWhileFrozen.push({ method: request.method(), query: url.search })
  })
  const audit = async stage => {
    const response = await context.request.get(`${origin}/__fixture/audit`)
    assert.equal(response.status(), 200)
    const value = await response.json(); proof.audits.push({ stage, ...value }); return value
  }
  const banner = () => page.getByRole('region', { name: 'Saved report', exact: true })
  const assertSelection = async savedId => {
    await expect(page.getByRole('combobox', { name: 'Dashboard result event', exact: true })).toHaveValue('purchase')
    await expect(page.getByRole('searchbox', { name: 'Search ad sets', exact: true })).toHaveValue('Local')
    await expect(page.getByRole('searchbox', { name: 'Search creative', exact: true })).toHaveValue('Studio')
    await expect(page.getByLabel('Sort creative')).toHaveValue('cpa')
    const url = new URL(page.url()); assert.equal(url.pathname, '/dashboard')
    for (const [key, value] of Object.entries(selection)) assert.equal(url.searchParams.get(key), value, key)
    assert.equal(url.searchParams.get('overview_creative_page'), null, 'the populated two-ad fixture normalizes an out-of-range page')
    assert.equal(url.searchParams.get('saved'), savedId)
    await expect(page.getByRole('navigation', { name: 'Comparison level', exact: true }).getByRole('link', { name: /^Ad sets/ })).toHaveAttribute('aria-current', 'page')
  }
  await page.goto(`${origin}/preview?scenario=normal`, { waitUntil: 'domcontentloaded' })
  await page.goto(`${origin}/dashboard?${new URLSearchParams({ account, ...selection })}`, { waitUntil: 'domcontentloaded' })
  await assertSelection(null)
  const hierarchy = page.getByRole('region', { name: 'Campaign and ad-set comparison', exact: true })
  await expect(hierarchy).toContainText('1 ad sets matched · 1 supplied')
  proof.pageLimitation = 'The existing gateway supplies one matching ad set, rendered in the complete naturally scrolling hierarchy population.'
  const saveDisclosure = page.locator('summary').filter({ hasText: /^Save report$/ })
  await page.locator('[data-overview-sources] > summary').click()
  await saveDisclosure.click()
  const title = `Dashboard saved selection ${Date.now()}`
  await page.getByRole('textbox', { name: 'Report name', exact: true }).fill(title)
  const save = page.getByRole('button', { name: 'Save this report', exact: true })
  await expect(save).toBeEnabled()
  const baseline = await audit('before save')
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reporting/saved' && response.request().method() === 'POST')
  frozen = true
  await save.click()
  const response = await responsePromise; assert.equal(response.status(), 200)
  await page.waitForURL(url => /^[0-9a-f-]{36}$/.test(url.searchParams.get('saved') ?? ''))
  const id = new URL(page.url()).searchParams.get('saved')
  await expect(banner()).toContainText(title); await assertSelection(id)
  const savedResponse = await context.request.get(`${origin}/api/reporting/saved/${id}`)
  assert.equal(savedResponse.status(), 200)
  const original = await savedResponse.json()
  assert.equal(original.saved.view.pathname, '/dashboard')
  for (const [key, value] of Object.entries(selection)) assert.equal(original.saved.view.query[key], value, `saved.view.query.${key}`)
  proof.saved = { id, title, view: original.saved.view, dataIdentity: original.saved.dataIdentity, reviewIdentity: original.saved.reviewIdentity }
  await page.getByRole('link', { name: 'Measurement detail ↗', exact: true }).click()
  await expect(page.locator('#measurement-evidence')).toBeVisible()
  const measurement = new URL(page.url())
  assert.equal(measurement.pathname, '/reports'); assert.equal(measurement.searchParams.get('report'), 'website')
  assert.equal(measurement.hash, '#measurement-evidence'); assert.equal(measurement.searchParams.get('saved'), id)
  assert.equal(measurement.searchParams.get('account'), account)
  proof.measurementUrl = measurement.href
  await page.screenshot({ path: `${output}/saved-measurement.png` })
  await banner().getByRole('link', { name: 'Original saved view', exact: true }).click()
  await assertSelection(id)
  await page.getByRole('link', { name: 'Measurement detail ↗', exact: true }).click()
  await expect(page.locator('#measurement-evidence')).toBeVisible()
  await page.goBack({ waitUntil: 'domcontentloaded' }); await assertSelection(id)
  await banner().getByRole('link', { name: 'Saved reports', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Saved reports', exact: true })).toBeVisible()
  await page.getByRole('link', { name: title, exact: true }).click(); await assertSelection(id)
  await page.reload({ waitUntil: 'domcontentloaded' }); await assertSelection(id)
  await expect(banner()).toContainText(title)
  const reopened = await context.request.get(`${origin}/api/reporting/saved/${id}`)
  assert.deepEqual(await reopened.json(), original)
  await expect(page.getByRole('button', { name: /^Refresh / })).toHaveCount(0)
  const final = await audit('after measurement, original view, Back, list reopen and reload')
  assert.equal(final.liveReads, baseline.liveReads); assert.equal(final.liveRefreshes, baseline.liveRefreshes)
  assert.equal(final.savedWrites, baseline.savedWrites + 1)
  assert.deepEqual(proof.liveRequestsWhileFrozen, []); assert.deepEqual(proof.errors, [])
  await page.screenshot({ path: `${output}/saved-dashboard.png` })
  proof.result = 'pass'; proof.finishedAt = new Date().toISOString()
  console.log(JSON.stringify({ result: proof.result, savedId: id, output, pageLimitation: proof.pageLimitation }))
} catch (error) {
  proof.result = 'failed'; proof.error = String(error); proof.url = page?.url()
  if (page) await page.screenshot({ path: `${output}/failure.png` }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  await writeFile(`${output}/proof.json`, JSON.stringify(proof, null, 2))
}
