// Run: TSX_TSCONFIG_PATH=tsconfig.scripts.json node --import tsx tests/reporting-browser/hierarchy-history-check.mjs
// Ordinary loopback application with fictional hierarchy-history data; no browser response replacement.
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
import { hierarchyHistoryFixture } from '../fixtures/reporting-hierarchy-history.ts'
import { buildMetaBreakdowns, CAMPAIGN_DAILY_INPUT_KEYS } from '../../src/lib/reporting/meta-breakdowns.ts'
import { validateReportingPacket } from '../../src/lib/reporting/validation.ts'
import { validateScopedReportingPacket } from '../../src/lib/reporting/packet-scope.ts'
import { REPORTING_PREPARED_TYPE } from '../../src/lib/reporting/prepared-contract.ts'
import { preparedReportingReply } from '../../src/lib/reporting/prepared-response.ts'
import { canonicalReportingJson, createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '../../src/lib/reporting/snapshot-contract.ts'
import { ReportingHistoryEntitySchema } from '../../src/lib/reporting/snapshot-scope.ts'
import { saveReportingReport, openSavedReportingReport, listSavedReportingReports } from '../../src/lib/reporting/saved-service.ts'
import { validateSavedReportReply } from '../../src/lib/reporting/saved-validation.ts'
import { savedTestClient } from '../db/reporting-saved-fixture.ts'
import { prepareParentHistoryDb } from '../db/reporting-parent-history-fixture.ts'
import { applyParentBreakdownMigration } from '../db/reporting-parent-breakdown-fixture.ts'

const output = mkdtempSync(joinPath(tmpdir(), 'maxx-hierarchy-history-'))
const artifacts = 'test-results/reporting-preview/hierarchy-history'
const appPort = Number(process.env.HIERARCHY_HISTORY_APP_PORT ?? 3147)
const oldSavedOrigin = process.env.HIERARCHY_HISTORY_OLD_SAVED_ORIGIN ?? 'http://127.0.0.1:3151'
const oldSavedId = process.env.HIERARCHY_HISTORY_OLD_SAVED_ID ?? '00000000-0000-4000-8000-0000000005a1'
const expect = playwrightExpect.configure({ timeout: 25_000 })
const range = 'from=2026-09-02&to=2026-09-04'
const selected = { campaign: { level: 'campaign', id: '101' }, adset: { level: 'adset', id: '201' } }
const proof = { startedAt: new Date().toISOString(), errors: [], blocked: [], requests: [], scoped: {}, browser: {}, saved: { status: 'not-run' } }
const normalized = text => text.replace(/\s+/g, ' ').trim()

function clone(value) { return structuredClone(value) }

function authorityOnlySeries(entity) {
  const project = point => ({ ...point, metrics: Object.fromEntries(Object.entries(point.metrics).filter(([key]) => CAMPAIGN_DAILY_INPUT_KEYS.includes(key))) })
  return { ...entity, series: (entity.series ?? []).map(project), comparisonSeries: (entity.comparisonSeries ?? []).map(project), breakdowns: undefined }
}

function withoutDetails(entity) {
  const next = { ...entity }
  delete next.series; delete next.comparisonSeries; delete next.breakdowns
  return next
}

function withPausedChildren(source) {
  const data = clone(source)
  data.meta.data.entities = data.meta.data.entities.map(entity => ['201', '301'].includes(entity.id) ? { ...entity, status: 'PAUSED' } : entity)
  return data
}

function legacyScopeData(source) {
  const data = clone(source)
  data.meta.data.entities = data.meta.data.entities.map(entity => entity.level === 'campaign' ? authorityOnlySeries(entity) : withoutDetails(entity))
  return data
}

function selectedBreakdowns(context, historyEntity) {
  if (!historyEntity.breakdown) return undefined
  const labels = {
    placement: [{ publisher_platform: 'instagram', platform_position: 'reels' }, { publisher_platform: 'instagram', platform_position: 'feed' }],
    age: [{ age: '25-34' }, { age: '35-44' }], gender: [{ gender: 'female' }, { gender: 'male' }],
    region: [{ region: 'Massachusetts' }, { region: 'Georgia' }],
  }[historyEntity.breakdown]
  const native = (identity, spend, impressions) => ({ ...identity, campaign_id: historyEntity.level === 'campaign' ? historyEntity.id : '101',
    ...(historyEntity.level === 'adset' ? { adset_id: historyEntity.id } : {}), spend: String(spend), impressions: String(impressions),
    actions: [{ action_type: 'purchase', value: spend >= 50 ? '2' : '0' }],
    action_values: [{ action_type: 'purchase', value: spend >= 50 ? '240' : '0' }] })
  return buildMetaBreakdowns(context, historyEntity.breakdown,
    [native(labels[0], 80, 1200), native(labels[1], 20, 800)],
    [native(labels[0], 30, 700), native(labels[1], 70, 1300)],
    { level: historyEntity.level, id: historyEntity.id })
}

function selectedScopeData(source, historyEntity) {
  const data = clone(source)
  const childLevel = historyEntity.level === 'campaign' ? 'adset' : 'ad'
  const childKey = historyEntity.level === 'campaign' ? 'campaignId' : 'adsetId'
  data.meta.data.entities = data.meta.data.entities.map(entity => {
    if (entity.level === historyEntity.level && entity.id === historyEntity.id) return { ...entity,
      breakdowns: selectedBreakdowns(data.context, historyEntity) }
    if (entity.level === 'campaign') return authorityOnlySeries(entity)
    if (entity.level === childLevel && entity[childKey] === historyEntity.id) return withoutDetails({ ...entity, status: entity.id.endsWith('1') || entity.id === '301' ? 'PAUSED' : entity.status })
    return withoutDetails(entity)
  })
  return data
}

function packet(section, data) {
  return validateReportingPacket({ section, context: data.context, result: data[section], notes: ['Fictional hierarchy-history preview. No connected Example Studio evidence.'] })
}

function supportsHistoryScope(context) {
  try {
    const scope = makeReportingSnapshotScope('meta', context, { historyEntity: selected.adset })
    return Boolean(scope && typeof scope === 'object' && 'historyEntity' in scope)
  } catch { return false }
}

function assertScoped(data) {
  const supports = supportsHistoryScope(data.context)
  proof.scoped.rawPacketValidated = true
  assert.equal(supports, true, 'historyEntity scope support must be active for this checker')
  proof.scoped.historyScopeSupported = true
  for (const [name, historyEntity] of Object.entries(selected)) {
    const scoped = selectedScopeData(data, historyEntity)
    const meta = packet('meta', scoped)
    const entity = scoped.meta.data.entities.find(row => row.level === historyEntity.level && row.id === historyEntity.id)
    assert.ok(entity, `${name} fixture entity exists`)
    assert.ok(entity.series?.length, `${name} fixture has current daily history`)
    assert.ok(entity.comparisonSeries?.length, `${name} fixture has prior daily history`)
    const scope = makeReportingSnapshotScope('meta', scoped.context, { historyEntity })
    validateScopedReportingPacket(meta, scope, scoped.context.asOf)
  }
  const campaignScoped = selectedScopeData(data, selected.campaign), adsetScoped = selectedScopeData(data, selected.adset)
  proof.scoped.selectedOnly = {
    selectedCampaignFullKeys: Object.keys(campaignScoped.meta.data.entities.find(row => row.level === 'campaign' && row.id === '101').series[0].metrics).length,
    unselectedCampaignAuthorityKeys: Object.keys(adsetScoped.meta.data.entities.find(row => row.level === 'campaign' && row.id === '102').series[0].metrics).sort(),
    selectedAdsetFullKeys: Object.keys(adsetScoped.meta.data.entities.find(row => row.level === 'adset' && row.id === '201').series[0].metrics).length,
    unselectedAdsetNone: adsetScoped.meta.data.entities.find(row => row.level === 'adset' && row.id === '202').series === undefined,
    unselectedAdNone: adsetScoped.meta.data.entities.find(row => row.level === 'ad' && row.id === '302').series === undefined,
  }
  assert.deepEqual(proof.scoped.selectedOnly.unselectedCampaignAuthorityKeys, [...CAMPAIGN_DAILY_INPUT_KEYS].sort())
  assert.equal(proof.scoped.selectedOnly.unselectedAdsetNone, true)
  assert.equal(proof.scoped.selectedOnly.unselectedAdNone, true)
}

function requestedHistory(url) {
  const wire = url.searchParams.get('historyEntity')
  if (wire) {
    try { return ReportingHistoryEntitySchema.parse(JSON.parse(wire)) }
    catch { return null }
  }
  return null
}

async function startGateway(data) {
  const db = await prepareParentHistoryDb()
  await applyParentBreakdownMigration(db)
  await db.query('INSERT INTO public.ad_accounts(id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [data.context.account.id])
  const client = savedTestClient(db)
  const snapshots = new Map()
  let liveReads = 0, savedReads = 0, savedWrites = 0, listReads = 0
  async function seedSnapshot(section, scoped, historyEntity) {
    const key = `${section}:${historyEntity ? JSON.stringify(historyEntity) : 'base'}`
    if (snapshots.has(key)) return snapshots.get(key)
    const scope = makeReportingSnapshotScope(section, scoped.context, historyEntity ? { historyEntity } : {})
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
      const history = section === 'meta' ? requestedHistory(url) : null
      const scoped = history ? selectedScopeData(data, history) : legacyScopeData(data)
      const stored = await seedSnapshot(section, scoped, history)
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
    if (url.pathname.startsWith('/api/')) return json({ error: 'This feature is not connected in the hierarchy-history preview.' }, 501)
    if (!['GET', 'HEAD'].includes(method)) return json({ error: 'Unsupported fictional preview action.' }, 405)
    const upstream = proxyRequest({ hostname: '127.0.0.1', port: appPort, path: request.url, method, headers: { ...request.headers, host: `127.0.0.1:${appPort}` } }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Local sample application unavailable.') })
    request.pipe(upstream)
  })().catch(error => json({ error: error instanceof Error ? error.message : 'Hierarchy preview failed.' }, 503)) })
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/_next/webpack-hmr') { socket.destroy(); return }
    const upstream = proxyRequest({ hostname: '127.0.0.1', port: appPort, path: request.url, method: 'GET', headers: { ...request.headers, host: `127.0.0.1:${appPort}` } })
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      const headers = upstreamResponse.rawHeaders.reduce((text, value, i, all) => i % 2 === 0 ? `${text}${value}: ${all[i + 1]}\r\n` : text, '')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`)
      if (head.length) upstreamSocket.write(head)
      if (upstreamHead.length) socket.write(upstreamHead)
      upstreamSocket.on('error', () => socket.destroy()); socket.on('error', () => upstreamSocket.destroy())
      socket.on('close', () => upstreamSocket.destroy()); upstreamSocket.pipe(socket); socket.pipe(upstreamSocket)
    })
    upstream.on('response', () => { upstream.destroy(); socket.destroy() })
    upstream.on('error', () => socket.destroy()); upstream.end()
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

async function checkHistory(page, level, id, expected) {
  await page.goto(`/performance?${range}&view=detail&level=${level}&campaign=101${level === 'adset' ? `&adset=${id}` : ''}&entity_trend=purchase_roas`, { waitUntil: 'domcontentloaded' })
  const label = level === 'campaign' ? 'Campaign' : 'Ad set'
  const history = page.getByRole('region', { name: `${label}-level daily history`, exact: true })
  await expect(history).toBeVisible()
  await expect(page.getByLabel('Daily history metric', { exact: true })).toHaveValue('purchase_roas')
  await history.getByText('Daily values and evidence', { exact: true }).click()
  for (const text of ['2026-09-02', '2026-09-03', '2026-09-04', ...expected.current]) await expect(history).toContainText(text)
  await page.getByLabel('Daily history period', { exact: true }).selectOption('previous')
  for (const text of ['2026-08-30', '2026-08-31', '2026-09-01', ...expected.previous]) await expect(history).toContainText(text)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('Daily history period', { exact: true })).toHaveValue('previous')
  await page.getByLabel('Daily history period', { exact: true }).selectOption('current')
  await page.goBack()
  await expect(page.getByLabel('Daily history period', { exact: true })).toHaveValue('previous')
  const csv = await download(page, `Export ${level === 'campaign' ? 'campaign' : 'ad set'} daily CSV`)
  for (const text of ['claim_id', '2026-09-02', '2026-08-30', 'Meta ', id]) assert.ok(csv.includes(text), `${level} CSV contains ${text}`)
  await writeFile(`${artifacts}/${level}-${id}-daily.csv`, csv)
  await page.screenshot({ path: `${artifacts}/${level}-${id}-history.png`, fullPage: true })
  return { rows: (csv.match(/\n/g) ?? []).length, url: page.url() }
}

async function checkBreakdowns(page, level, id) {
  const label = level === 'campaign' ? 'Campaign' : 'Ad set'
  await page.goto(`/performance?${range}&view=detail&level=${level}&campaign=101${level === 'adset' ? `&adset=${id}` : ''}`, { waitUntil: 'domcontentloaded' })
  const section = page.getByRole('region', { name: `${label} placement and audience detail`, exact: true })
  await expect(section).toContainText('No additional Meta request is made until you choose one.')
  const expectedRows = { placement: 'instagram / reels', age: '25-34', gender: 'female', region: 'Massachusetts' }
  for (const dimension of ['placement', 'age', 'gender', 'region']) {
    await section.getByRole('button', { name: dimension[0].toUpperCase() + dimension.slice(1), exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`breakdown=${dimension}`))
    const table = page.getByRole('region', { name: `${label} ${dimension} metrics`, exact: true })
    await expect(table).toBeVisible()
    await expect(table).toContainText(expectedRows[dimension])
    await expect(table).toContainText('$80.00')
    await expect(table).toContainText('Previous: $30.00')
  }
  const csv = await download(page, 'Export region CSV')
  for (const text of ['region Massachusetts', 'region Georgia', 'Reported purchase value', '240']) assert.ok(csv.includes(text), `breakdown CSV contains ${text}`)
  await writeFile(`${artifacts}/${level}-${id}-region.csv`, csv)
  await section.screenshot({ path: `${artifacts}/${level}-${id}-breakdowns.png` })
  return { finalDimension: 'region', csvRows: (csv.match(/\n/g) ?? []).length, url: page.url() }
}

async function checkPreexistingOldSaved(browser) {
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
    assert.equal(reply.saved.id, oldSavedId)
    assert.equal(reply.saved.sources.meta.receipt.scope.historyEntity, undefined)
    const reviewIdentity = reply.saved.reviewIdentity
    const originalText = reply.review.findings[0]?.observation.text
    assert.ok(reviewIdentity?.startsWith('sha256:'), 'Old saved report has an immutable review identity')
    assert.ok(originalText?.includes('Booked value:'), 'Old saved report retains original review text')
    await page.goto(`/performance?from=2026-09-02&to=2026-09-04&saved=${oldSavedId}&view=detail&level=campaign&campaign=101&entity_trend=purchase_roas`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: 'Saved report', exact: true })).toContainText(reply.saved.title)
    await expect(page.getByRole('heading', { name: 'Campaign not in this view', exact: true })).toBeVisible()
    await expect(page.locator('main')).toContainText('Campaign 101 is not in the returned entities for this account, date range and filters.')
    const after = await (await context.request.get(`${oldSavedOrigin}/__fixture/audit`)).json()
    assert.equal(after.liveReads, before.liveReads)
    assert.equal(after.liveRefreshes, before.liveRefreshes)
    assert.equal(after.savedWrites, before.savedWrites)
    const currentLink = await page.getByRole('link', { name: 'Open current report', exact: true }).getAttribute('href')
    assert.ok(currentLink?.includes('/performance?'))
    assert.ok(!currentLink?.includes('saved='))
    return {
      status: 'passed', origin: oldSavedOrigin, id: oldSavedId, title: reply.saved.title,
      reviewIdentity, metaHasHistoryEntity: false, before, after, currentLink,
    }
  } catch (error) {
    return { status: 'skipped-unavailable', origin: oldSavedOrigin, id: oldSavedId, reason: error instanceof Error ? error.message : String(error) }
  } finally { await context?.close().catch(() => {}) }
}

try {
  await mkdir(output, { recursive: true }); await mkdir(artifacts, { recursive: true })
  const data = withPausedChildren(hierarchyHistoryFixture())
  assertScoped(data)
  const gateway = await startGateway(data)
  let browser, context, page
  try {
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ baseURL: gateway.origin, viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
    context.setDefaultTimeout(25_000)
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === gateway.origin && (['GET', 'HEAD'].includes(request.method()) || request.method() === 'POST' && ['/api/reporting', '/api/reporting/saved'].includes(url.pathname))) return route.continue()
      proof.blocked.push({ url: request.url(), method: request.method() }); return route.abort('blockedbyclient')
    })
    page = await context.newPage()
    page.on('pageerror', error => proof.errors.push(error.message))
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin === gateway.origin && url.pathname.startsWith('/api/')) proof.requests.push({ path: url.pathname + url.search, method: response.request().method(), status: response.status() })
    })
    await page.goto('/preview', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
    await page.goto(`/performance?${range}&level=campaign`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('link', { name: /opposite trajectory/ }).first()).toBeVisible()
    proof.browser.campaign = await checkHistory(page, 'campaign', '101', { current: ['2.40×', '1.60×', '0.00×'], previous: ['1.20×', '0.80×', '0.00×'] })
    const campaignWire = proof.requests.filter(request => { const url = new URL(request.path, 'http://127.0.0.1'); return url.searchParams.get('section') === 'meta' && url.searchParams.has('historyEntity') })
    proof.browser.requestWireAfterCampaign = { historyEntityRequests: campaignWire.map(request => request.path), allMetaRequests: proof.requests.filter(request => request.path.includes('section=meta')).map(request => request.path) }
    await writeFile(`${output}/proof.partial.json`, JSON.stringify(proof, null, 2))
    assert.ok(campaignWire.some(request => request.path.includes('%22level%22%3A%22campaign%22') && request.path.includes('%22id%22%3A%22101%22')), 'Campaign detail did not request historyEntity over the actual reporting API wire')
    proof.browser.campaignBreakdowns = await checkBreakdowns(page, 'campaign', '101')
    await page.getByRole('link', { name: 'All ad sets in this campaign', exact: true }).click()
    await expect(page).toHaveURL(/level=adset/)
    await expect(page.getByText('PAUSED · ID 201', { exact: true })).toBeVisible()
    proof.browser.children = { allAdsetsReachableIncludingPaused: true, url: page.url() }
    proof.browser.adset = await checkHistory(page, 'adset', '201', { current: ['0.00×', '1.60×', '2.40×'], previous: ['0.00×', '0.80×', '1.20×'] })
    proof.browser.adsetBreakdowns = await checkBreakdowns(page, 'adset', '201')
    await page.getByRole('link', { name: 'All ads in this ad set', exact: true }).click()
    await expect(page).toHaveURL(/level=ad/)
    await expect(page.getByText('Values show the selected period and previous equal period.')).toBeVisible()
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`/performance?${range}&view=detail&level=adset&campaign=101&adset=201&entity_trend=purchase_roas&breakdown=region`, { waitUntil: 'domcontentloaded' })
      const history = page.getByRole('region', { name: 'Ad set-level daily history', exact: true })
      await history.scrollIntoViewIfNeeded()
      const overflow = await history.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 ? [document.documentElement.scrollWidth, innerWidth] : [])
      assert.deepEqual(overflow, [], `history fits ${width}`)
      await history.screenshot({ path: `${artifacts}/adset-history-${width}.png` })
    }
    await page.setViewportSize({ width: 794, height: 1123 })
    await page.emulateMedia({ media: 'print' })
    await page.pdf({ path: `${artifacts}/adset-history.pdf`, format: 'A4', printBackground: true })
    const printed = execFileSync('/opt/homebrew/bin/pdftotext', ['-raw', `${artifacts}/adset-history.pdf`, '-'], { encoding: 'utf8' })
    await writeFile(`${artifacts}/adset-history.txt`, printed)
    for (const phrase of ['Purchase ROAS · Selected period', 'Daily observations for this ad set only', '2026-09-02', '2.40×', 'Region', 'Massachusetts']) assert.ok(normalized(printed).includes(phrase), `printed ${phrase}`)
    const wired = proof.requests.filter(request => new URL(request.path, 'http://127.0.0.1').searchParams.has('historyEntity'))
    proof.browser.requestWire = { historyEntityRequests: wired.map(request => request.path), allMetaRequests: proof.requests.map(request => request.path) }
    proof.browser.print = { adsetA4: true }
    const auditBeforeSave = await (await context.request.get(`${gateway.origin}/__fixture/audit`)).json()
    await page.emulateMedia({ media: null })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.locator('summary').filter({ hasText: /^Save report$/ }).click()
    await page.getByLabel('Report name', { exact: true }).fill('Fictional selected ad-set history')
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reporting/saved' && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save this report', exact: true }).click()
    const savedResponse = await saving
    assert.equal(savedResponse.status(), 200)
    const saved = await validateSavedReportReply(await savedResponse.json())
    assert.equal(saved.saved.view.pathname, '/performance')
    assert.equal(saved.saved.view.query.entity_trend, 'purchase_roas')
    assert.equal(saved.saved.view.query.level, 'adset')
    assert.deepEqual(saved.saved.sources.meta.receipt.scope.historyEntity, { ...selected.adset, breakdown: 'region' })
    const originalText = saved.review.findings.find(finding => finding.entity?.level === 'adset' && finding.entity.id === '201')?.observation.text
    assert.ok(originalText?.includes('Purchase ROAS increased'))
    await writeFile(`${artifacts}/saved-selected-history.json`, JSON.stringify(saved, null, 2))
    await page.goto(`/performance?${new URLSearchParams({ ...saved.saved.view.query, saved: saved.saved.id })}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: 'Saved report', exact: true })).toContainText('Fictional selected ad-set history')
    const auditBeforeReload = await (await context.request.get(`${gateway.origin}/__fixture/audit`)).json()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('region', { name: 'Saved report', exact: true })).toContainText('Fictional selected ad-set history')
    const reopened = await validateSavedReportReply(await (await context.request.get(`${gateway.origin}/api/reporting/saved/${saved.saved.id}`)).json())
    assert.deepEqual(reopened.review, saved.review)
    const auditAfterReload = await (await context.request.get(`${gateway.origin}/__fixture/audit`)).json()
    assert.equal(auditAfterReload.liveReads, auditBeforeReload.liveReads)
    proof.saved = { status: 'passed', id: saved.saved.id, metaHistoryEntity: saved.saved.sources.meta.receipt.scope.historyEntity, originalText, auditBeforeSave, auditBeforeReload, auditAfterReload }
    proof.oldSaved = await checkPreexistingOldSaved(browser)
    assert.deepEqual(proof.errors, [])
    assert.deepEqual(proof.blocked, [])
    proof.finishedAt = new Date().toISOString()
    await writeFile(`${output}/proof.json`, JSON.stringify(proof, null, 2))
    console.log(JSON.stringify(proof, null, 2))
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
