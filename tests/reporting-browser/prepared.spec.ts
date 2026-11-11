import { expect, test, type Page } from '@playwright/test'
import { createServer, request as proxyRequest, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { fixtureCookie } from './auth-fixture.mjs'
import { forwardHmrUpgrades } from '../../scripts/demo/hmr-upgrade'
import { openReportingTrust, sourceRow } from './source-strip'
import { fixturePacket } from '../../scripts/demo/sample/reports'
import { preparedComplete, preparedReply, preparedRunning, preparedJobId, jobStartedAt } from '../fixtures/reporting-prepared'
import { snapshotContext } from '../fixtures/reporting-snapshot'
import { REPORTING_PREPARED_TYPE, type PreparedReportingReply, type ValidatedPreparedReportingReply } from '../../src/lib/reporting/prepared-contract'
import { makeReportingSnapshotScope } from '../../src/lib/reporting/snapshot-scope'
import { validatePreparedReportingReply } from '../../src/lib/reporting/prepared-validation'
import type { ReportingPacket } from '../../src/lib/reporting/contracts'
import { compactReportingPacket, isCompactReportingPacket } from '../../src/lib/reporting/packet-format'

type Mode = 'saved' | 'running' | 'progress' | 'ready' | 'complete' | 'failed' | 'interrupted'
type WireCall = { method: string; section: string; from: string; job: string | null; accept: string; body: string }
type HeldPoll = { response: ServerResponse; from: string; to: string; aborted: boolean }
const firstPeriod = '2026-09-02', lastDay = '2026-09-04'

function packet(section: string, from: string, to: string, asOf = snapshotContext.asOf, fresh = false): ReportingPacket {
  // Preserve all claim/account identities together when adapting the older browser fixture.
  const value = JSON.parse(JSON.stringify(fixturePacket(section, from, to))
    .replaceAll('fixture-db', snapshotContext.account.id).replaceAll('2026-09-05T17:00:00Z', asOf)) as ReportingPacket
  value.notes = ['Synthetic prepared HTTP browser fixture; no database or provider read.']
  if (value.section === 'meta' && value.result.data) {
    value.result.data.detailState = 'complete'
    if (fresh) value.result.data.metrics.spend.current.value = 180
    value.result.data.entities = value.result.data.entities.map(entity => ({
      ...Object.fromEntries(Object.entries(entity).filter(([key]) => !['series', 'comparisonSeries', 'breakdowns'].includes(key))) as typeof entity,
      creative: entity.creative ? { ...entity.creative, imageUrl: null, thumbnailUrl: null, videoUrl: null } : null,
    }))
  }
  return value
}

function envelope(mode: Mode, from: string, to: string): ValidatedPreparedReportingReply {
  const value = mode === 'complete' ? preparedComplete()
    : ['running', 'progress', 'failed', 'interrupted'].includes(mode) ? preparedRunning(mode === 'progress') : preparedReply()
  const asOf = mode === 'progress' || mode === 'complete' ? jobStartedAt : snapshotContext.asOf
  value.packet = packet('meta', from, to, asOf, mode === 'complete')
  value.scope = makeReportingSnapshotScope('meta', value.packet.context)
  if (mode === 'progress' && value.packet.section === 'meta') {
    value.packet.result.state = 'partial'
    value.packet.result.data!.detailState = 'loading'
    value.packet.result.notes = ['Optional Meta details, configuration and trends are loading.']
    value.packet.result.data!.entities = []
  }
  if (mode === 'failed' || mode === 'interrupted') value.job = { ...value.job!, status: 'failed',
    completedAt: '2026-09-05T17:02:30.000Z', failureCode: mode === 'failed' ? 'source_unavailable' : 'interrupted' }
  if (mode === 'ready') value.needsRefresh = false
  // Good fixtures must pass the same scope/evidence boundary before entering the HTTP wire.
  return validatePreparedReportingReply(value, 'meta', `from=${from}&to=${to}`)
}

/** Real GET/POST/poll requests to a loopback HTTP server, without page.route.
 * Only HTML/scripts use the isolated Next app; reporting responses are synthetic. */
async function preparedGateway() {
  const calls: WireCall[] = [], held: HeldPoll[] = [], faults: string[] = []
  const sockets = new Set<Socket>(), modes = new Map<string, Mode>(), heldPeriods = new Set<string>()
  const send = (response: ServerResponse, value: PreparedReportingReply) => {
    // The real reply carries the packetVersion 2 packet (src/lib/reporting/prepared-response.ts).
    const packet = value.packet && !isCompactReportingPacket(value.packet) ? compactReportingPacket(value.packet as ReportingPacket) : value.packet
    response.writeHead(200, { 'Content-Type': REPORTING_PREPARED_TYPE, 'Cache-Control': 'private, no-store' })
    response.end(JSON.stringify({ ...value, packet }))
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/reporting') {
        const section = url.searchParams.get('section') ?? 'meta'
        const from = url.searchParams.get('from')!, to = url.searchParams.get('to')!
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        calls.push({ method: request.method ?? '', section, from, job: url.searchParams.get('job'),
          accept: request.headers.accept ?? '', body: Buffer.concat(chunks).toString() })
        if (!['GET', 'POST'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return }
        if (section !== 'meta') {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(compactReportingPacket(packet(section, from, to)))); return
        }
        if (request.method === 'POST') modes.set(from, 'running')
        if (url.searchParams.has('job') && heldPeriods.has(from)) {
          const entry = { response, from, to, aborted: false }
          held.push(entry)
          response.on('close', () => { entry.aborted = !response.writableEnded })
          return
        }
        send(response, envelope(modes.get(from) ?? 'ready', from, to)); return
      }
      if (url.pathname.startsWith('/api/')) {
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return }
      const upstream = proxyRequest({ hostname: '127.0.0.1', port: 3147, path: request.url, method: request.method,
        headers: { ...request.headers, host: '127.0.0.1:3147' },
      }, incoming => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response) })
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      request.pipe(upstream)
    } catch (error) {
      faults.push(error instanceof Error ? error.message : 'Fixture failure')
      if (!response.headersSent) response.writeHead(500)
      response.end('Prepared browser fixture failed')
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  // Turbopack's HMR socket is /_next/hmr; dropping it leaves the page rendered but never hydrated.
  forwardHmrUpgrades(server, { appPort: 3147, host: '127.0.0.1:3147' })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(3151, '127.0.0.1', resolve) })
  return { url: 'http://127.0.0.1:3151', calls, held, faults,
    mode(mode: Mode, from = firstPeriod) { modes.set(from, mode) },
    hold(from = firstPeriod) { heldPeriods.add(from) },
    release(mode: Mode, foreignScope = false) {
      modes.set(firstPeriod, mode); heldPeriods.delete(firstPeriod)
      for (const entry of held.filter(item => item.from === firstPeriod && !item.response.writableEnded && !item.response.destroyed)) {
        let value = envelope(mode, entry.from, entry.to)
        if (foreignScope) {
          value = JSON.parse(JSON.stringify(value).replaceAll(snapshotContext.account.id, '00000000-0000-4000-8000-000000009999'))
          if (value.packet?.section === 'meta') value.packet.result.data!.metrics.spend.current.value = 999
          // It is valid on its own; rejection must come from the previously pinned account.
          validatePreparedReportingReply(value, 'meta', `from=${entry.from}&to=${entry.to}`)
        }
        send(entry.response, value)
      }
    },
    reset() { held.forEach(entry => entry.response.destroy()); calls.length = 0; held.length = 0; faults.length = 0; modes.clear(); heldPeriods.clear() },
    async close() { sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

let gateway: Awaited<ReturnType<typeof preparedGateway>>
const metaCalls = () => gateway.calls.filter(call => call.section === 'meta')
const sourceStatus = (page: Page) => sourceRow(page, 'Meta advertising')
const advertising = (page: Page) => page.getByRole('region', { name: 'Advertising results' })
// The Spend tile shows a compact total ($240); its summary's accessible name carries the exact current value.
const currentSpend = (page: Page) => advertising(page).getByLabel(/^Spend: .*\. Definition and source$/)
/** Opens the overview with its Trust panel expanded, so the source rows and Refresh buttons are visible. */
const open = async (page: Page) => { await page.goto(`${gateway.url}/dashboard?from=${firstPeriod}&to=${lastDay}`); await openReportingTrust(page) }
test.beforeAll(async () => { gateway = await preparedGateway() })
test.afterAll(async () => { await gateway.close() })
test.beforeEach(async ({ context, page }) => {
  gateway.reset()
  await page.clock.install({ time: new Date('2026-09-05T17:02:20Z') })
  await context.addCookies([{ name: 'sb-127-auth-token', value: fixtureCookie, domain: '127.0.0.1', path: '/', sameSite: 'Lax' }])
})
test.afterEach(() => { expect(gateway.faults).toEqual([]) })

test('saved evidence precedes completion, active-job reload joins without POST, then reload uses the saved publication', async ({ page }) => {
  gateway.mode('saved'); gateway.hold()
  await open(page)
  await expect(advertising(page)).toContainText('$120.00')
  await expect.poll(() => gateway.held.length).toBe(1)
  expect(gateway.held[0].response.writableEnded).toBe(false)
  expect(metaCalls().filter(call => call.method === 'POST').map(call => call.body)).toEqual(['{"refresh":false}'])
  expect(metaCalls().every(call => call.accept.includes(REPORTING_PREPARED_TYPE))).toBe(true)
  expect(metaCalls().filter(call => call.job).every(call => call.job === preparedJobId)).toBe(true)
  await expect(sourceStatus(page)).toContainText('Refreshing')
  await page.screenshot({ path: 'test-results/reporting-prepared/saved-before-completion.png', fullPage: true })
  await page.reload()
  await expect(advertising(page)).toContainText('$120.00')
  await expect.poll(() => gateway.held.length).toBe(2)
  expect(metaCalls().filter(call => call.method === 'POST')).toHaveLength(1)
  gateway.release('complete')
  await expect(sourceStatus(page)).toContainText('Available')
  await expect(advertising(page)).toContainText('$180.00')
  const beforeReload = gateway.calls.length
  await page.reload()
  await expect(advertising(page)).toContainText('$180.00')
  await expect(sourceStatus(page)).toContainText('Available')
  const reloadCalls = gateway.calls.slice(beforeReload).filter(call => call.section === 'meta')
  expect(reloadCalls).toHaveLength(1)
  expect(reloadCalls[0]).toMatchObject({ method: 'GET', job: null })
  expect(metaCalls().filter(call => call.method === 'POST')).toHaveLength(1)
})

test('running prepared progress displays actual Meta totals before optional details with no new work request', async ({ page }) => {
  gateway.mode('progress'); gateway.hold()
  await open(page)
  await expect(advertising(page)).toContainText('$120.00')
  await expect(sourceStatus(page)).toContainText('Details loading')
  await expect.poll(() => gateway.held.length).toBe(1)
  expect(metaCalls().map(call => call.method)).toEqual(['GET', 'GET'])
  expect(metaCalls()[1].job).toBe(preparedJobId)
  await page.getByLabel('Meta advertising source details').click()
  await expect(sourceStatus(page)).toContainText('Validated totals are available')
  await expect(page.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
  await page.screenshot({ path: 'test-results/reporting-prepared/totals-before-details.png', fullPage: true })
  gateway.release('complete')
  await expect(sourceStatus(page)).toContainText('Available')
  await expect(sourceStatus(page)).not.toContainText('Details loading')
  await expect(advertising(page)).toContainText('$180.00')
})

for (const failure of ['failed', 'interrupted'] as const) test(`${failure} refresh keeps saved metrics, source age and an actionable error`, async ({ page }) => {
  gateway.mode('ready')
  await open(page)
  await expect(advertising(page)).toContainText('$120.00')
  await expect(sourceStatus(page)).toContainText('Available')
  gateway.hold()
  await page.getByRole('button', { name: 'Refresh Meta advertising' }).click()
  await expect.poll(() => gateway.held.length).toBe(1)
  expect(metaCalls().filter(call => call.method === 'POST').map(call => call.body)).toEqual(['{"refresh":true}'])
  await expect(advertising(page)).toContainText('$120.00')
  gateway.release(failure)
  await expect(sourceStatus(page)).toContainText('Refresh failed')
  await page.getByLabel('Meta advertising source details').click()
  await expect(sourceStatus(page)).toContainText(failure === 'interrupted' ? 'was interrupted' : 'could not refresh')
  await expect(sourceStatus(page)).toContainText(snapshotContext.asOf)
  await expect(advertising(page)).toContainText('$120.00')
  await expect(page.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
  await expect(page.getByRole('button', { name: 'Refresh Meta advertising' })).toBeEnabled()
  await page.screenshot({ path: `test-results/reporting-prepared/${failure}-retains-saved.png`, fullPage: true })
})

test('date navigation aborts an in-flight job poll and cannot display the previous period again', async ({ page }) => {
  gateway.mode('running'); gateway.hold()
  await open(page)
  await expect(advertising(page)).toContainText('$120.00')
  await expect.poll(() => gateway.held.length).toBe(1)
  await page.evaluate(() => window.history.pushState(null, '', '/dashboard?from=2026-08-02&to=2026-08-04'))
  await expect(advertising(page)).toContainText('$240.00')
  await expect.poll(() => gateway.held[0].aborted).toBe(true)
  gateway.release('complete')
  // The header's account context comes from the new period's packet: Aug 2-4 compares with Jul 30 - Aug 1,
  // and the comparison's title carries that packet's dates, timezone and currency.
  await expect(page.getByText('vs Jul 30 – Aug 1', { exact: true })).toHaveAttribute('title', '2026-07-30 – 2026-08-01 · America/New_York · USD')
  await expect(currentSpend(page)).toHaveAccessibleName('Spend: $240.00. Definition and source')
  expect(metaCalls().filter(call => call.method === 'POST')).toHaveLength(0)
  expect(metaCalls().some(call => call.from === '2026-08-02' && call.job === null)).toBe(true)
})

test('a foreign-account publication is rejected while other source results remain usable', async ({ page }) => {
  gateway.mode('running'); gateway.hold()
  await open(page)
  await expect(advertising(page)).toContainText('$120.00')
  await expect.poll(() => gateway.held.length).toBe(1)
  gateway.release('complete', true)
  await expect(sourceStatus(page)).toContainText('Unavailable')
  await page.getByLabel('Meta advertising source details').click()
  await expect(sourceStatus(page)).toContainText('invalid prepared report')
  await expect(currentSpend(page)).toBeVisible()
  await expect(currentSpend(page)).not.toHaveAccessibleName('Spend: $120.00. Definition and source')
  await expect(advertising(page)).not.toContainText('$999.00')
  await expect(page.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
})
