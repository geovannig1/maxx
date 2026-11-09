// Run: TSX_TSCONFIG_PATH=tsconfig.scripts.json node --import tsx tests/reporting-browser/purchase-cpa-check.mjs
// Ordinary loopback application with fictional Purchase CPA data; no browser response replacement.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, request as proxyRequest } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { chromium, expect as playwrightExpect } from '@playwright/test'

import { fixtureCookie, fixtureUser } from './auth-fixture.mjs'
import { purchaseCpaFixture } from '../fixtures/reporting-purchase-cpa.ts'
import { budgetContextFixture } from '../fixtures/reporting-budget-context.ts'
import { CAMPAIGN_DAILY_INPUT_KEYS } from '../../src/lib/reporting/meta-breakdowns.ts'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS } from '../../src/lib/reporting/meta-metric-definitions.ts'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'
import { validateScopedReportingPacket } from '../../src/lib/reporting/packet-scope.ts'
import { REPORTING_PREPARED_TYPE } from '../../src/lib/reporting/prepared-contract.ts'
import { preparedReportingReply } from '../../src/lib/reporting/prepared-response.ts'
import { canonicalReportingJson, createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '../../src/lib/reporting/snapshot-contract.ts'
import { saveReportingReport, openSavedReportingReport, listSavedReportingReports } from '../../src/lib/reporting/saved-service.ts'
import { validateSavedReportReply } from '../../src/lib/reporting/saved-validation.ts'
import { savedTestClient } from '../db/reporting-saved-fixture.ts'
import { prepareParentHistoryDb } from '../db/reporting-parent-history-fixture.ts'

const budgetScenario = process.env.MAXX_REPORTING_SCENARIO === 'budget'
const output = mkdtempSync(joinPath(tmpdir(), budgetScenario ? 'maxx-budget-context-' : 'maxx-purchase-cpa-'))
const artifacts = budgetScenario ? 'test-results/reporting-preview/budget-context' : 'test-results/reporting-preview/purchase-cpa'
const appPort = Number(process.env.PURCHASE_CPA_APP_PORT ?? 3147)
const oldSavedOrigin = process.env.PURCHASE_CPA_OLD_SAVED_ORIGIN ?? 'http://127.0.0.1:3151'
const oldSavedId = process.env.PURCHASE_CPA_OLD_SAVED_ID ?? '00000000-0000-4000-8000-0000000005a1'
const expect = playwrightExpect.configure({ timeout: 25_000 })
const range = 'from=2026-09-02&to=2026-09-04'
const selected = { campaign: { level: 'campaign', id: '101' }, adset: { level: 'adset', id: '201' }, ad: '301' }
const metricKey = 'cost_per_purchase'
const costLabel = /Cost per (Meta )?reported Purchase|Cost per Meta Purchase/i
const proof = { startedAt: new Date().toISOString(), errors: [], console: [], responses: [], upgrades: [], blocked: [], requests: [], scoped: {}, browser: {}, saved: { status: 'not-run' }, oldSaved: { status: 'not-run' } }
const normalized = text => text.replace(/\s+/g, ' ').trim()

function clone(value) { return structuredClone(value) }
function valueOf(metric, prior = false) {
  const claim = prior ? metric?.previous : metric?.current
  return claim?.availability.state === 'available' && typeof claim.value === 'number' && Number.isFinite(claim.value) ? claim.value : null
}
function entity(data, level, id) { return data.meta.data.entities.find(row => row.level === level && row.id === id) }
function withoutDetails(row) { const next = { ...row }; delete next.series; delete next.comparisonSeries; delete next.breakdowns; return next }
function authorityOnlySeries(row) {
  const keys = new Set(CAMPAIGN_DAILY_INPUT_KEYS)
  const project = point => ({ ...point, metrics: Object.fromEntries(Object.entries(point.metrics).filter(([key]) => keys.has(key))) })
  return { ...row, series: (row.series ?? []).map(project), comparisonSeries: (row.comparisonSeries ?? []).map(project), breakdowns: undefined }
}
function requestScope(url, section) {
  const detailIds = section === 'meta' ? [...new Set((url.searchParams.get('details') ?? '').split(',').filter(Boolean))].sort() : []
  const wire = url.searchParams.get('historyEntity')
  let historyEntity
  if (wire) {
    try { const parsed = JSON.parse(wire); if (['campaign', 'adset'].includes(parsed.level) && typeof parsed.id === 'string') historyEntity = parsed }
    catch { historyEntity = undefined }
  }
  return { detailIds, historyEntity: detailIds.length ? undefined : historyEntity }
}

function matchesHistoryRequest(path, level, id) {
  try {
    const url = new URL(path, 'http://127.0.0.1')
    if (url.searchParams.get('section') !== 'meta') return false
    const wire = url.searchParams.get('historyEntity')
    if (!wire) return false
    const parsed = JSON.parse(wire)
    return parsed.level === level && String(parsed.id) === String(id)
  } catch {
    return false
  }
}
function scopedData(source, request) {
  const data = clone(source)
  const selectedParent = request.historyEntity
  const childLevel = selectedParent?.level === 'campaign' ? 'adset' : selectedParent?.level === 'adset' ? 'ad' : null
  const childKey = selectedParent?.level === 'campaign' ? 'campaignId' : selectedParent?.level === 'adset' ? 'adsetId' : null
  data.meta.data.entities = data.meta.data.entities.map(row => {
    const selectedAd = row.level === 'ad' && request.detailIds.includes(row.id)
    if (selectedParent && row.level === selectedParent.level && row.id === selectedParent.id) return { ...row, breakdowns: undefined }
    if (selectedAd) return row
    if (row.level === 'campaign') return authorityOnlySeries(row)
    if (selectedParent && row.level === childLevel && row[childKey] === selectedParent.id) return withoutDetails(row)
    return withoutDetails(row)
  })
  return data
}
function packet(section, data) {
  return validateReportingPacket({ section, context: data.context, result: data[section], notes: ['Fictional Purchase CPA preview. No connected Example Studio evidence.'] })
}
function assertPurchaseCpaSemantics(data) {
  const campaign = entity(data, 'campaign', selected.campaign.id)
  const ad301 = entity(data, 'ad', selected.ad)
  const ad302 = entity(data, 'ad', '302')
  const ad303 = entity(data, 'ad', '303')
  const ad304 = entity(data, 'ad', '304')
  assert.ok(META_RATIO_METRIC_DEFINITIONS.some(([key]) => key === metricKey), 'source ratio definitions include cost_per_purchase')
  assert.ok([...META_NATIVE_METRIC_DEFINITIONS.map(item => item.key), ...META_RATIO_METRIC_DEFINITIONS.map(([key]) => key)].includes(metricKey), 'scoped validator can see Purchase CPA')
  assert.equal(valueOf(data.meta.data.metrics[metricKey]), 20)
  assert.equal(valueOf(data.meta.data.metrics[metricKey], true), 10)
  assert.equal(valueOf(campaign.metrics[metricKey]), 18.75)
  assert.equal(valueOf(campaign.metrics[metricKey], true), 10)
  assert.equal(valueOf(ad301.metrics[metricKey]), 20)
  assert.equal(valueOf(ad301.metrics[metricKey], true), 10)
  assert.equal(valueOf(ad302.metrics[metricKey]), 5)
  assert.equal(valueOf(ad302.metrics[metricKey], true), 10)
  assert.equal(valueOf(ad303.metrics[metricKey]), null)
  assert.equal(valueOf(ad304.metrics[metricKey]), null)
  assert.equal(valueOf(ad301.metrics.purchase_value), null)
  assert.equal(valueOf(ad301.metrics.purchase_roas), null)
}
function assertScoped(data) {
  const raw = packet('meta', data)
  assertPurchaseCpaSemantics(data)
  proof.scoped.rawPacketValidated = true
  proof.scoped.sourceMetric = metricKey
  const campaignScoped = scopedData(data, { detailIds: [], historyEntity: selected.campaign })
  validateScopedReportingPacket(packet('meta', campaignScoped), makeReportingSnapshotScope('meta', campaignScoped.context, { historyEntity: selected.campaign }), campaignScoped.context.asOf)
  const adsetScoped = scopedData(data, { detailIds: [], historyEntity: selected.adset })
  validateScopedReportingPacket(packet('meta', adsetScoped), makeReportingSnapshotScope('meta', adsetScoped.context, { historyEntity: selected.adset }), adsetScoped.context.asOf)
  const adScoped = scopedData(data, { detailIds: [selected.ad], historyEntity: undefined })
  validateScopedReportingPacket(packet('meta', adScoped), makeReportingSnapshotScope('meta', adScoped.context, { detailIds: [selected.ad] }), adScoped.context.asOf)
  proof.scoped.selectedOnly = {
    rawEntities: raw.result.data.entities.length,
    campaignDailyKeys: Object.keys(entity(campaignScoped, 'campaign', selected.campaign.id).series[0].metrics).length,
    adsetDailyKeys: Object.keys(entity(adsetScoped, 'adset', selected.adset.id).series[0].metrics).length,
    selectedAdHasBreakdowns: Array.isArray(entity(adScoped, 'ad', selected.ad).breakdowns),
    unselectedAdNoHistory: entity(adScoped, 'ad', '302').series === undefined,
    unselectedCampaignAuthorityKeys: Object.keys(entity(adScoped, 'campaign', '102').series[0].metrics).sort(),
  }
}
async function startGateway(data) {
  const db = await prepareParentHistoryDb()
  await db.query('INSERT INTO public.ad_accounts(id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [data.context.account.id])
  const client = savedTestClient(db)
  const snapshots = new Map()
  let liveReads = 0, savedReads = 0, savedWrites = 0, listReads = 0
  async function seedSnapshot(section, scoped, request) {
    const key = `${section}:${JSON.stringify(request)}`
    if (snapshots.has(key)) return snapshots.get(key)
    const options = section === 'meta' ? { detailIds: request.detailIds, ...(request.historyEntity ? { historyEntity: request.historyEntity } : {}) } : {}
    const scope = makeReportingSnapshotScope(section, scoped.context, options)
    const value = packet(section, scoped)
    const snapshot = createReportingSnapshot(scope, value, scoped.context.asOf)
    const stored = { id: randomUUID(), fingerprint: reportingFingerprint(snapshot), createdAt: scoped.context.asOf, snapshot }
    await db.query(`INSERT INTO public.reporting_snapshots
      (id,ad_account_id,source,scope_key,scope_canonical,evidence_fingerprint,snapshot_canonical,retrieval_started_at,retrieval_completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [stored.id, snapshot.scope.accountId, snapshot.scope.source,
      reportingFingerprint(snapshot.scope), canonicalReportingJson(snapshot.scope), stored.fingerprint,
      canonicalReportingJson(snapshot), snapshot.retrieval.startedAt, snapshot.retrieval.completedAt])
    snapshots.set(key, stored)
    return stored
  }
  const server = createServer((request, response) => {
    const json = (value, status = 200, type = 'application/json') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' })
      response.end(JSON.stringify(value))
    }
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const method = request.method ?? 'GET'
      if (url.pathname === '/preview' && method === 'GET') {
        response.writeHead(302, { 'Set-Cookie': [`sb-127-auth-token=${fixtureCookie}; Path=/; SameSite=Lax`], Location: `/dashboard?${range}` })
        response.end(); return
      }
      if (url.pathname === '/__fixture/audit' && method === 'GET') return json({ liveReads, savedReads, savedWrites, listReads })
      if (url.pathname === '/api/reporting' && ['GET', 'HEAD', 'POST'].includes(method)) {
        liveReads++
        const section = url.searchParams.get('section')
        proof.requests.push({ path: url.pathname + url.search, method })
        if (!['meta', 'business', 'website', 'measurement'].includes(section)) return json({ error: 'Choose a supported reporting source.' }, 400)
        const scope = requestScope(url, section)
        const scoped = section === 'meta' ? scopedData(data, scope) : scopedData(data, { detailIds: [], historyEntity: undefined })
        const stored = await seedSnapshot(section, scoped, section === 'meta' ? scope : { detailIds: [], historyEntity: undefined })
        return json(preparedReportingReply(stored.snapshot.scope, stored, null, Date.parse(stored.snapshot.retrieval.completedAt)), 200, REPORTING_PREPARED_TYPE)
      }
      if (url.pathname === '/api/reporting/saved' && method === 'GET') { listReads++; return json(await listSavedReportingReports(client, data.context.account.id, url.searchParams.get('cursor') ?? undefined)) }
      if (url.pathname === '/api/reporting/saved' && method === 'POST') {
        savedWrites++
        const chunks = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        return json(await saveReportingReport(client, data.context.account, fixtureUser.id, JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      }
      if (url.pathname.startsWith('/api/reporting/saved/') && method === 'GET') {
        savedReads++
        const id = url.pathname.slice('/api/reporting/saved/'.length)
        return json(await openSavedReportingReport(client, data.context.account, id))
      }
      if (url.pathname === '/api/sync' && method === 'GET') return json({ status: 'synced', lastSync: data.context.asOf, dataThrough: data.context.range.to })
      if (url.pathname.startsWith('/api/')) return json({ error: 'This feature is not connected in the Purchase CPA preview.' }, 501)
      if (!['GET', 'HEAD'].includes(method)) return json({ error: 'Unsupported fictional preview action.' }, 405)
      const upstream = proxyRequest({ hostname: '127.0.0.1', port: appPort, path: request.url, method, headers: { ...request.headers, host: `127.0.0.1:${appPort}` } }, incoming => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response)
      })
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Local sample application unavailable.') })
      request.pipe(upstream)
    })().catch(error => json({ error: error instanceof Error ? error.message : 'Purchase CPA preview failed.' }, 503))
  })
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    proof.upgrades.push({ path: request.url ?? '/', accepted: pathname === '/_next/webpack-hmr' })
    if (pathname !== '/_next/webpack-hmr') { socket.destroy(); return }
    const upstream = proxyRequest({ hostname: '127.0.0.1', port: appPort, path: request.url, method: 'GET', headers: { ...request.headers, host: `127.0.0.1:${appPort}` } })
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      const headers = upstreamResponse.rawHeaders.reduce((text, value, index, all) => index % 2 === 0 ? `${text}${value}: ${all[index + 1]}\r\n` : text, '')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`)
      if (head.length) upstreamSocket.write(head)
      if (upstreamHead.length) socket.write(upstreamHead)
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('error', () => upstreamSocket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    upstream.on('response', () => { upstream.destroy(); socket.destroy() })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return { origin: `http://127.0.0.1:${address.port}`, close: async () => { await new Promise(resolve => server.close(resolve)); await db.close() } }
}
async function download(page, name) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name, exact: true }).click()
  const file = await pending
  return readFile(await file.path(), 'utf8')
}

async function expectRowsWithDate(history, date, value) {
  const rows = history.locator('tbody tr').filter({ hasText: date })
  const count = await rows.count()
  assert.ok(count > 0, `daily history contains ${date}`)
  for (let index = 0; index < count; index++) await expect(rows.nth(index)).toContainText(value)
}
async function checkHistory(page, level, id, expected) {
  const parent = level === 'campaign' ? `campaign=${id}` : `campaign=101&adset=${id}`
  await page.goto(`/performance?${range}&view=detail&level=${level}&${parent}&entity_trend=${metricKey}`, { waitUntil: 'domcontentloaded' })
  const label = level === 'campaign' ? 'Campaign' : 'Ad set'
  const history = page.getByRole('region', { name: `${label}-level daily history`, exact: true })
  await expect(history).toBeVisible()
  await expect(page.getByLabel('Daily history metric', { exact: true })).toHaveValue(metricKey)
  for (const [date, value] of expected.current) await expectRowsWithDate(history, date, value)
  await page.getByLabel('Daily history period', { exact: true }).selectOption('previous')
  for (const [date, value] of expected.previous) await expectRowsWithDate(history, date, value)
  await history.getByText('Daily values and evidence', { exact: true }).click()
  const csv = await download(page, `Export ${level === 'campaign' ? 'campaign' : 'ad set'} daily CSV`)
  for (const text of ['claim_id', 'input_claim_ids', metricKey, 'purchase_count', 'spend', '2026-09-02', '2026-08-30', 'Meta ', id]) assert.ok(csv.includes(text), `${level} CSV contains ${text}`)
  await writeFile(`${artifacts}/${level}-${id}-daily.csv`, csv)
  await page.screenshot({ path: `${artifacts}/${level}-${id}-history.png`, fullPage: true })
  return { rows: (csv.match(/\n/g) ?? []).length, url: page.url() }
}
async function checkOldSaved(browser) {
  let context
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    try { const response = await fetch(`${oldSavedOrigin}/__fixture/audit`, { signal: controller.signal }); if (!response.ok) throw new Error(`audit ${response.status}`) }
    finally { clearTimeout(timer) }
    context = await browser.newContext({ baseURL: oldSavedOrigin, viewport: { width: 1440, height: 1000 } })
    const cookieUrl = new URL(oldSavedOrigin)
    await context.addCookies([{ name: 'sb-127-auth-token', value: fixtureCookie, domain: cookieUrl.hostname, path: '/', sameSite: 'Lax' }])
    const page = await context.newPage()
    const before = await (await context.request.get(`${oldSavedOrigin}/__fixture/audit`)).json()
    const list = await (await context.request.get(`${oldSavedOrigin}/api/reporting/saved`)).json()
    if (!list.reports?.some(report => report.id === oldSavedId)) return { status: 'skipped-id-not-listed', origin: oldSavedOrigin, id: oldSavedId }
    const reply = await validateSavedReportReply(await (await context.request.get(`${oldSavedOrigin}/api/reporting/saved/${oldSavedId}`)).json())
    assert.equal(reply.saved.sources.meta.receipt.scope.historyEntity, undefined)
    await page.goto(`/performance?from=2026-09-02&to=2026-09-04&saved=${oldSavedId}&view=detail&level=campaign&campaign=101&entity_trend=${metricKey}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: 'Saved report', exact: true })).toContainText(reply.saved.title)
    await expect(page.locator('main')).toContainText(/Campaign not in this view|daily metric was not supplied|Not in this response/)
    const mainText = await page.locator('main').innerText()
    assert.ok(!mainText.includes('$20.00') || mainText.includes('Open current report'), 'Old saved packet must not reconstruct new Purchase CPA evidence')
    const after = await (await context.request.get(`${oldSavedOrigin}/__fixture/audit`)).json()
    assert.equal(after.liveReads, before.liveReads)
    assert.equal(after.liveRefreshes, before.liveRefreshes)
    assert.equal(after.savedWrites, before.savedWrites)
    return { status: 'passed', origin: oldSavedOrigin, id: oldSavedId, title: reply.saved.title, reviewIdentity: reply.saved.reviewIdentity, before, after }
  } catch (error) {
    return { status: 'skipped-unavailable', origin: oldSavedOrigin, id: oldSavedId, reason: error instanceof Error ? error.message : String(error) }
  } finally { await context?.close().catch(() => {}) }
}
try {
  await mkdir(output, { recursive: true }); await mkdir(artifacts, { recursive: true })
  const data = budgetScenario ? budgetContextFixture() : purchaseCpaFixture()
  assertScoped(data)
  const gateway = await startGateway(data)
  let browser, context, page
  try {
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ baseURL: gateway.origin, viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
    await context.addCookies([{ name: 'sb-127-auth-token', value: fixtureCookie, domain: new URL(gateway.origin).hostname, path: '/', sameSite: 'Lax' }])
    context.setDefaultTimeout(25_000)
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === gateway.origin && (['GET', 'HEAD'].includes(request.method()) || request.method() === 'POST' && ['/api/reporting', '/api/reporting/saved'].includes(url.pathname))) return route.continue()
      proof.blocked.push({ url: request.url(), method: request.method() }); return route.abort('blockedbyclient')
    })
    page = await context.newPage()
    page.on('pageerror', error => proof.errors.push(error.message))
    page.on('console', message => proof.console.push({ type: message.type(), text: message.text() }))
    page.on('requestfailed', request => proof.responses.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? null }))
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin === gateway.origin) proof.responses.push({ path: url.pathname + url.search, method: response.request().method(), status: response.status() })
      if (url.origin === gateway.origin && url.pathname.startsWith('/api/')) proof.requests.push({ path: url.pathname + url.search, method: response.request().method(), status: response.status() })
    })
    await page.goto('/preview', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
    proof.browser.hydrationProbe = await page.evaluate(() => ({
      readyState: document.readyState,
      location: window.location.href,
      scripts: [...document.scripts].filter(script => script.src.includes('_next/static/chunks')).length,
      entries: performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('/api/') || name.includes('webpack-hmr')).slice(-20),
      mainText: document.querySelector('main')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 500) ?? '',
    }))
    await expect(page.getByRole('region', { name: 'Campaign and ad-set performance', exact: true })).toContainText(costLabel)
    await expect(page.locator('main')).toContainText('$20.00')
    if (budgetScenario) {
      await expect(page.getByRole('region', { name: 'Campaign and ad-set performance', exact: true })).toContainText('Campaign budget context · current observation · Campaign 101 · $100 per day · ad-set budget ownership not established')
      await page.screenshot({ path: `${artifacts}/overview-1440.png`, fullPage: true })
    }
    await page.goto(`/performance?${range}&level=campaign&group=results&sort=${metricKey}&direction=asc`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('main')).toContainText(costLabel)
    await expect(page.locator('main')).toContainText('Fictional Purchase cost campaign 101')
    await expect(page.locator('main')).toContainText('$18.75')
    await expect(page.locator('main')).toContainText('Previous: $10.00')
    proof.browser.campaign = await checkHistory(page, 'campaign', '101', {
      current: [['2026-09-02', '$9.38'], ['2026-09-03', '$14.06'], ['2026-09-04', 'Unavailable']],
      previous: [['2026-08-30', '$10.00'], ['2026-08-31', '$10.00'], ['2026-09-01', '$10.00']],
    })
    if (budgetScenario) {
      const card = page.getByRole('region', { name: 'Budget and schedule', exact: true })
      await expect(card).toContainText('Configured budget · current observation · $100 per day')
      await expect(card.getByText('PAUSED', { exact: true }).first()).toBeVisible()
      await expect(card).toContainText('Aug 1, 2026')
      await expect(card).toContainText('current settings may differ from settings during the selected period')
      const csv = await download(page, 'Export CSV')
      for (const text of ['Configured daily budget', '100', 'meta_configuration', 'configuration_observation', 'selected historical period']) assert.ok(csv.includes(text), `campaign configuration CSV contains ${text}`)
      await writeFile(`${artifacts}/campaign-101-results-and-configuration.csv`, csv)
    }
    const parentFinding = page.locator('[data-review-id="performance:campaign:101"]')
    await expect(parentFinding).toContainText('Purchase CPA')
    const parentInspection = parentFinding.getByRole('link', { name: /Inspect Fictional Purchase cost campaign 101/i })
    const parentInspectionHref = await parentInspection.getAttribute('href')
    assert.ok(parentInspectionHref?.includes('view=detail'), 'parent finding links to detail view')
    assert.ok(parentInspectionHref?.includes('level=campaign'), 'parent finding stays at campaign level')
    assert.ok(parentInspectionHref?.includes('campaign=101'), 'parent finding keeps campaign identity')
    assert.ok(parentInspectionHref?.includes('#entity-metrics'), 'parent finding targets own evidence anchor')
    assert.ok(!parentInspectionHref?.includes('level=adset'), 'parent finding does not link to child ad set list')
    await parentInspection.click()
    await expect(page).toHaveURL(/view=detail.*level=campaign.*campaign=101.*#entity-metrics/)
    await expect(page.getByRole('heading', { name: 'Period results', exact: true })).toBeVisible()
    proof.browser.parentFinding = { href: parentInspectionHref }
    const campaignWire = proof.requests.filter(request => matchesHistoryRequest(request.path, 'campaign', '101'))
    assert.ok(campaignWire.length, 'Campaign detail must request historyEntity over the actual reporting API wire')
    await page.getByRole('link', { name: 'All ad sets in this campaign', exact: true }).click()
    await expect(page).toHaveURL(/level=adset/)
    proof.browser.adset = await checkHistory(page, 'adset', '201', {
      current: [['2026-09-02', '$9.38'], ['2026-09-03', '$14.06'], ['2026-09-04', 'Unavailable']],
      previous: [['2026-08-30', '$10.00'], ['2026-08-31', '$10.00'], ['2026-09-01', '$10.00']],
    })
    if (budgetScenario) {
      const card = page.getByRole('region', { name: 'Budget and schedule', exact: true })
      await expect(card).toContainText('Campaign budget context · current observation · Campaign 101 · $100 per day · ad-set budget ownership not established')
      await expect(card.getByText('CAMPAIGN_PAUSED', { exact: true })).toBeVisible()
      await expect(card).toContainText('Entity configuration')
      await expect(card).toContainText('Parent campaign 101 budget evidence')
      await expect(card).toContainText('Aug 2, 2026, 12:00 AM EDT')
      await page.setViewportSize({ width: 320, height: 1000 })
      await page.waitForFunction(() => document.querySelector('#primary-nav')?.getBoundingClientRect().right <= 0)
      await card.scrollIntoViewIfNeeded()
      assert.deepEqual(await card.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 ? [document.documentElement.scrollWidth, innerWidth] : []), [], 'ad-set budget evidence fits 320')
      await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toHaveAttribute('aria-expanded', 'false')
      const mobile = await card.evaluate(element => { const box = element.getBoundingClientRect(), nav = document.querySelector('#primary-nav'), navBox = nav?.getBoundingClientRect()
        const ys = [Math.max(box.top + 8, 8), Math.min(box.bottom - 8, innerHeight - 8)]
        return { card: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, viewport: { width: innerWidth, height: innerHeight }, nav: { hidden: nav?.getAttribute('aria-hidden'), inert: nav?.hasAttribute('inert'), overflow: nav ? getComputedStyle(nav).overflowX : null, visibility: nav ? getComputedStyle(nav).visibility : null, box: navBox ? { left: navBox.left, right: navBox.right } : null }, hits: ys.map(y => element.contains(document.elementFromPoint(Math.max(box.left + 8, 8), y))) } })
      assert.ok(mobile.card.left >= 0 && mobile.card.right <= mobile.viewport.width + 1 && mobile.nav.hidden === 'true' && mobile.nav.inert && mobile.nav.overflow === 'hidden' && mobile.nav.visibility === 'hidden' && mobile.hits.every(Boolean), `320px card is in viewport and closed navigation is clipped: ${JSON.stringify(mobile)}`)
      proof.browser.adsetBudgetMobile = mobile
      await page.evaluate(() => getSelection()?.removeAllRanges())
      await page.screenshot({ path: `${artifacts}/adset-201-budget-viewport-top-320.png` })
      await card.locator('p').last().scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${artifacts}/adset-201-budget-viewport-bottom-320.png` })
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(`/performance?${range}&level=adset&group=results&compare=201,202&view=compare`, { waitUntil: 'domcontentloaded' })
      const comparison = page.getByRole('region', { name: 'Side-by-side comparison', exact: true })
      await expect(comparison).toContainText('Campaign budget context · current observation · Campaign 101 · $100 per day · ad-set budget ownership not established')
      await expect(comparison).toContainText('Ad-set budget · current observation · $40 per day')
      await page.screenshot({ path: `${artifacts}/adset-comparison-1440.png`, fullPage: true })
    }
    await page.goto(`/performance?${range}&level=ad&campaign=101&adset=201&group=response&sort=${metricKey}&direction=asc`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('main')).toContainText('Fictional Purchase cost ad 301')
    await expect(page.locator('main')).toContainText('Fictional Purchase cost ad 302')
    await expect(page.locator('main')).toContainText('$5.00')
    await expect(page.locator('main')).toContainText('$20.00')
    await expect(page.locator('main')).toContainText('Unavailable')
    await page.goto(`/performance?${range}&level=ad&campaign=101&adset=201&group=response&compare=301,302&view=compare`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: 'Side-by-side comparison', exact: true })).toContainText(costLabel)
    await expect(page.locator('main')).toContainText('$5.00')
    await expect(page.locator('main')).toContainText('$20.00')
    await page.goto(`/performance?${range}&ad=301&group=results&ad_trend=${metricKey}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Fictional Purchase cost ad 301', exact: true })).toBeVisible()
    await expect(page.locator('main')).toContainText(costLabel)
    await expect(page.locator('main')).toContainText('$20.00')
    await expect(page.locator('main')).toContainText('Purchase count fell from 20 to 5')
    await expect(page.locator('main')).toContainText('Purchase CPA rose from $10 to $20')
    await expect(page.locator('main')).toContainText('Meta Ads Manager · Purchase')
    await expect(page.locator('main')).toContainText('Reported purchase value')
    await expect(page.locator('main')).toContainText('Purchase ROAS')
    await expect(page.locator('main')).toContainText('Unavailable')
    const adWire = proof.requests.filter(request => { const url = new URL(request.path, 'http://127.0.0.1'); return url.searchParams.get('details') === selected.ad })
    assert.ok(adWire.length, 'Ad detail must request detailIds over the actual reporting API wire')
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`/performance?${range}&view=detail&level=campaign&campaign=101&entity_trend=${metricKey}`, { waitUntil: 'domcontentloaded' })
      const history = page.getByRole('region', { name: 'Campaign-level daily history', exact: true })
      const budget = page.getByRole('region', { name: 'Budget and schedule', exact: true })
      await history.scrollIntoViewIfNeeded()
      const overflow = await history.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 ? [document.documentElement.scrollWidth, innerWidth] : [])
      assert.deepEqual(overflow, [], `history fits ${width}`)
      await history.screenshot({ path: `${artifacts}/campaign-history-${width}.png` })
      await budget.screenshot({ path: `${artifacts}/campaign-budget-${width}.png` })
    }
    await page.setViewportSize({ width: 794, height: 1123 })
    await page.emulateMedia({ media: 'print' })
    await page.pdf({ path: `${artifacts}/campaign-history.pdf`, format: 'A4', printBackground: true })
    const printed = execFileSync('/opt/homebrew/bin/pdftotext', ['-raw', `${artifacts}/campaign-history.pdf`, '-'], { encoding: 'utf8' })
    await writeFile(`${artifacts}/campaign-history.txt`, printed)
    assert.ok(costLabel.test(printed), 'printed Purchase CPA label')
    for (const phrase of ['Daily observations for this campaign only', '2026-09-02',
      'Configured budget · current observation', '$100 per day']) assert.ok(normalized(printed).includes(phrase), `printed ${phrase}`)
    const compactPrint = printed.replace(/\s+/g, '')
    assert.ok(compactPrint.includes('Budgetandschedule'), 'printed Budget and schedule heading')
    assert.ok(compactPrint.includes('Aug1,2026,12:00AMEDT'), 'printed exact outer start time and zone')
    const auditBeforeSave = await (await context.request.get(`${gateway.origin}/__fixture/audit`)).json()
    await page.emulateMedia({ media: null })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.locator('summary').filter({ hasText: /^Save report$/ }).click()
    await page.getByLabel('Report name', { exact: true }).fill('Fictional Purchase CPA parent history')
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reporting/saved' && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save this report', exact: true }).click()
    const savedResponse = await saving
    assert.equal(savedResponse.status(), 200)
    await page.waitForURL(/saved=/)
    const savedId = new URL(page.url()).searchParams.get('saved')
    assert.ok(savedId, 'saved view URL contains the immutable saved id')
    const saved = await validateSavedReportReply(await (await context.request.get(`${gateway.origin}/api/reporting/saved/${savedId}`)).json())
    assert.equal(saved.saved.view.pathname, '/performance')
    assert.equal(saved.saved.view.query.entity_trend, metricKey)
    assert.equal(saved.saved.view.query.level, 'campaign')
    assert.deepEqual(saved.saved.sources.meta.receipt.scope.historyEntity, selected.campaign)
    if (budgetScenario) {
      const savedFinding = saved.review.findings.find(finding => finding.id === 'performance:campaign:101')
      assert.equal(savedFinding?.budgetEvidence?.length, 1)
      assert.equal(savedFinding.budgetEvidence[0].value.dailyBudget.majorUnits, 100)
    }
    await writeFile(`${artifacts}/saved-parent-history.json`, JSON.stringify(saved, null, 2))
    await expect(page.getByRole('region', { name: 'Saved report', exact: true })).toContainText('Fictional Purchase CPA parent history')
    const auditBeforeReload = await (await context.request.get(`${gateway.origin}/__fixture/audit`)).json()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: 'Saved report', exact: true })).toContainText('Fictional Purchase CPA parent history')
    const reopened = await validateSavedReportReply(await (await context.request.get(`${gateway.origin}/api/reporting/saved/${saved.saved.id}`)).json())
    assert.deepEqual(reopened.review, saved.review)
    const auditAfterReload = await (await context.request.get(`${gateway.origin}/__fixture/audit`)).json()
    assert.equal(auditAfterReload.liveReads, auditBeforeReload.liveReads)
    assert.equal(auditAfterReload.savedWrites, auditBeforeReload.savedWrites)
    proof.saved = { status: 'passed', id: saved.saved.id, metaHistoryEntity: saved.saved.sources.meta.receipt.scope.historyEntity, auditBeforeSave, auditBeforeReload, auditAfterReload }
    proof.oldSaved = await checkOldSaved(browser)
    assert.deepEqual(proof.errors, [])
    assert.deepEqual(proof.blocked, [])
    proof.finishedAt = new Date().toISOString()
    await writeFile(`${output}/proof.json`, JSON.stringify(proof, null, 2))
    console.log(JSON.stringify({
      status: 'passed',
      proof: `${output}/proof.json`,
      artifacts,
      requests: proof.requests.length,
      upgrades: proof.upgrades.filter(item => item.accepted).length,
      scoped: proof.scoped,
      browser: proof.browser,
      saved: proof.saved,
      oldSaved: proof.oldSaved,
      blocked: proof.blocked.length,
      errors: proof.errors.length,
    }, null, 2))
  } catch (error) {
    if (page) await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }).catch(() => {})
    await writeFile(`${output}/failure.json`, JSON.stringify({ ...proof, failure: String(error), url: page?.url() }, null, 2))
    throw error
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await gateway.close()
  }
} catch (error) {
  await writeFile(`${output}/fatal.json`, JSON.stringify({ ...proof, failure: String(error) }, null, 2)).catch(() => {})
  throw error
}
