/** Separate loopback-only saved-report preview. The application renders normally;
 * only fictional source packets/auth are supplied. Saving/opening uses the real
 * saved-report service and SDK through isolated PostgreSQL test transport. */
import { createServer, request as proxyRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fixtureCookie, fixtureUser } from './auth-fixture.mjs'
import { forwardHmrUpgrades } from '../../scripts/demo/hmr-upgrade'
import { preparedReportingReply } from '../../src/lib/reporting/prepared-response'
import { REPORTING_PREPARED_TYPE } from '../../src/lib/reporting/prepared-contract'
import { saveReportingReport, listSavedReportingReports, openSavedReportingReport } from '../../src/lib/reporting/saved-service'
import { prepareSavedDb, savedTestClient } from '../db/reporting-saved-fixture'
import { SAVED_PREVIEW_ACCOUNT, SAVED_PREVIEW_SOURCES, savedPreviewSnapshots, seedSavedPreviewSnapshot } from './saved-preview-fixture'
import { resolveReportingRange } from '../../src/lib/reporting/range'
import type { StoredReportingSnapshot } from '../../src/lib/reporting/snapshot-store'
import type { ReportingSectionName } from '../../src/lib/reporting/contracts'
import { SavedReportError } from '../../src/lib/reporting/saved-contract'
import { compactReportingPacket } from '../../src/lib/reporting/packet-format'

async function main() {
const origin = 'http://127.0.0.1:3150'
const db = await prepareSavedDb(), client = savedTestClient(db)
const sources = new Map<string, StoredReportingSnapshot>()
let mode: 'movement' | 'stable' | 'media' | 'followup' | 'legacy' = 'movement'
const audit = { liveReads: 0, liveRefreshes: 0, savedReads: 0, savedWrites: 0, listReads: 0 }

function json(response: ServerResponse, value: unknown, status = 200, contentType = 'application/json') {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'private, no-store' })
  response.end(JSON.stringify(value))
}
function cookies(request: IncomingMessage) {
  return new Map(request.headers.cookie?.split(';').map(cookie => {
    const split = cookie.trim().indexOf('=')
    return [cookie.trim().slice(0, split), cookie.trim().slice(split + 1)]
  }))
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > 64 * 1024) throw new Error('Fixture request exceeds the bounded command size.')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
async function publish(from: string, to: string) {
  const batch = savedPreviewSnapshots(mode, from, to)
  const seeded: Partial<Record<ReportingSectionName, StoredReportingSnapshot>> = {}
  for (const source of SAVED_PREVIEW_SOURCES) {
    const saved = await seedSavedPreviewSnapshot(db, batch[source])
    seeded[source] = saved
    sources.set(`${from}/${to}/${source}`, saved)
  }
  return seeded as Record<ReportingSectionName, StoredReportingSnapshot>
}
async function sourceSnapshot(source: ReportingSectionName, from: string, to: string) {
  const key = `${from}/${to}/${source}`
  if (!sources.has(key)) await publish(from, to)
  return sources.get(key)!
}
function proxy(request: IncomingMessage, response: ServerResponse) {
  const upstream = proxyRequest({ hostname: '127.0.0.1', port: 3147, path: request.url, method: request.method,
    headers: { ...request.headers, host: '127.0.0.1:3147' } }, incoming => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response)
  })
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Local sample application unavailable.') })
  request.pipe(upstream)
}

const server = createServer((request, response) => { void (async () => {
  const url = new URL(request.url ?? '/', origin), method = request.method ?? 'GET'
  const cookie = cookies(request), scenario = cookie.get('maxx-saved-preview') ?? 'normal'
  if (url.pathname === '/preview' && method === 'GET') {
    const selected = url.searchParams.get('scenario') ?? 'normal'
    if (!['normal', 'missing', 'retained', 'fallback', 'denied'].includes(selected)) return json(response, { error: 'Unknown fictional scenario.' }, 400)
    response.writeHead(302, { 'Set-Cookie': [`sb-127-auth-token=${fixtureCookie}; Path=/; SameSite=Lax`,
      `maxx-saved-preview=${selected}; Path=/; SameSite=Lax`], Location: '/dashboard?from=2026-09-02&to=2026-09-04' })
    response.end(); return
  }
  if (url.pathname === '/__fixture/audit' && method === 'GET') return json(response, { ...audit, mode })
  if (url.pathname === '/__fixture/current' && method === 'POST' && request.headers.origin === origin) {
    const command = await body(request)
    if (!['movement', 'stable', 'media', 'followup', 'legacy'].includes(command.mode)) return json(response, { error: 'Unknown fixture mode.' }, 400)
    mode = command.mode
    sources.clear()
    const range = resolveReportingRange({ from: typeof command.from === 'string' ? command.from : '2026-09-02',
      to: typeof command.to === 'string' ? command.to : '2026-09-04' })
    const batch = await publish(range.from, range.to)
    return json(response, { mode, ids: Object.fromEntries(SAVED_PREVIEW_SOURCES.map(source => [source, batch[source].id])) })
  }
  if (url.pathname.startsWith('/api/reporting')) {
    if (cookie.get('sb-127-auth-token') !== fixtureCookie || scenario === 'denied') return json(response, { error: 'Owner access is required to view reporting.' }, 403)
    if (method === 'POST' && request.headers.origin !== origin) return json(response, { error: 'Use the local fictional application.' }, 403)
  }
  if (url.pathname === '/api/reporting/saved' && method === 'GET') {
    audit.listReads++
    return json(response, await listSavedReportingReports(client, SAVED_PREVIEW_ACCOUNT.id, url.searchParams.get('cursor') ?? undefined))
  }
  if (url.pathname === '/api/reporting/saved' && method === 'POST') {
    audit.savedWrites++
    return json(response, await saveReportingReport(client, SAVED_PREVIEW_ACCOUNT, fixtureUser.id, await body(request)))
  }
  if (url.pathname.startsWith('/api/reporting/saved/') && method === 'GET') {
    audit.savedReads++
    const result = await openSavedReportingReport(client, SAVED_PREVIEW_ACCOUNT, url.pathname.slice('/api/reporting/saved/'.length))
    return json(response, result ?? { error: 'Saved report was not found.' }, result ? 200 : 404)
  }
  if (url.pathname === '/api/reporting' && ['GET', 'POST'].includes(method)) {
    const source = url.searchParams.get('section') as ReportingSectionName
    if (!SAVED_PREVIEW_SOURCES.includes(source)) return json(response, { error: 'Choose a supported source.' }, 400)
    const range = resolveReportingRange({ from: url.searchParams.get('from') ?? '', to: url.searchParams.get('to') ?? '' })
    if (method === 'GET') audit.liveReads++
    else audit.liveRefreshes++
    if (scenario === 'missing' && source === 'website' || scenario === 'retained' && source === 'business' && method === 'POST') {
      return json(response, { error: 'Fictional source could not refresh. Previous evidence remains available.' }, 503)
    }
    if (method === 'POST') await publish(range.from, range.to)
    const saved = await sourceSnapshot(source, range.from, range.to)
    if (scenario === 'fallback') return json(response, saved.storedPacket ?? compactReportingPacket(saved.snapshot.packet))
    // Ordinary source scope has no selected daily-detail projection. A frozen
    // ad drill must consume this inventory without requesting a new detail scope.
    if (url.searchParams.get('details')) return json(response, { error: 'Optional detail is outside this fictional source scenario.' }, 503)
    const reply = preparedReportingReply(saved.snapshot.scope, saved, null, Date.parse(saved.snapshot.retrieval.completedAt) + 30_000)
    return json(response, reply, 200, REPORTING_PREPARED_TYPE)
  }
  if (url.pathname === '/api/sync' && method === 'GET') return json(response, { status: 'synced', lastSync: new Date().toISOString(), dataThrough: '2026-09-04' })
  if (url.pathname.startsWith('/api/')) return json(response, { error: 'This feature is not connected in this fictional preview.' }, 501)
  if (!['GET', 'HEAD'].includes(method)) return json(response, { error: 'Unsupported fictional preview action.' }, 405)
  proxy(request, response)
})().catch(error => {
  const status = error instanceof SavedReportError ? { invalid: 400, not_found: 404, changed: 409, incompatible: 422, unavailable: 503 }[error.code] : 503
  json(response, { error: error instanceof SavedReportError ? error.message : 'The fictional saved-report request could not complete.' }, status)
}) })

// Turbopack's HMR socket is /_next/hmr; dropping it leaves the page rendered but never hydrated.
forwardHmrUpgrades(server, { appPort: 3147, host: '127.0.0.1:3147' })

await publish('2026-09-02', '2026-09-04')
server.listen(3150, '127.0.0.1', () => console.log(`Fictional saved-report preview ${origin}/preview · run ${randomUUID()}`))
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  server.close(() => { void db.close().then(() => { process.exitCode = 0 }) })
  server.closeAllConnections()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
