/**
 * Loopback-only interactive reporting preview. Unlike Playwright's request
 * interception, this gateway lets a person inspect the same fixture-backed UI
 * in an ordinary browser without a Supabase email or real reporting sources.
 */
import { createServer, request as proxyRequest, type ServerResponse } from 'node:http'

import { fixtureCookie } from './auth-fixture.mjs'
import { fixturePacket } from '../../scripts/demo/sample/reports'
import { mediaMovementFixture } from './media-movement-fixture'
import { executiveFixture } from './executive-fixture'
import { executiveAnswerFixture, executiveAnswerMode, EXECUTIVE_ANSWER_RANGE } from './executive-answer-fixture'
import { audienceReportingFixture } from './audience-fixture'
import { businessReportingFixture } from './business-fixture'
import { customerReportingFixture } from './customer-fixture'
import { customerFollowupReportingFixture } from './customer-followup-fixture'
import { websiteReportingFixture } from './website-fixture'
import { creativeReportingFixture, creativeMediaOrigin, creativeMediaMode } from './creative-fixture'
import { referenceReportingFixture } from './reference-fixture'
import { resolveReportingRange } from '../../src/lib/reporting/range'
import { compactReportingPacket } from '../../src/lib/reporting/packet-format'
import type { ReportingPacket } from '../../src/lib/reporting/contracts'
import { forwardHmrUpgrades } from '../../scripts/demo/hmr-upgrade'

const APP_PORT = 3147
const PREVIEW_PORT = Number(process.env.MAXX_TEST_PREVIEW_PORT ?? 3149)

function sendJson(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PREVIEW_PORT}`)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, { error: 'The sample preview is read-only.' }, 405)
    return
  }

  if (url.pathname === '/preview') {
    const executiveAnswer = executiveAnswerMode(url.searchParams.get('scenario'))
    const creative = ['creative', 'reference'].includes(url.searchParams.get('scenario') ?? '')
    const mediaOrigin = creative ? creativeMediaOrigin(url.searchParams.get('mediaOrigin')) : null
    response.writeHead(302, {
      'Set-Cookie': [`sb-127-auth-token=${fixtureCookie}; Path=/; SameSite=Lax`,
        `maxx-preview-scenario=${executiveAnswer || ['media-movement', 'executive', 'review', 'business', 'customers', 'customers-stable', 'customers-missing', 'customer-followup', 'audience', 'website', 'creative', 'reference'].includes(url.searchParams.get('scenario') ?? '') ? url.searchParams.get('scenario') : 'default'}; Path=/; SameSite=Lax`,
        `maxx-preview-media-origin=${encodeURIComponent(mediaOrigin ?? '')}; Path=/; SameSite=Lax`,
        `maxx-preview-media-mode=${creative ? creativeMediaMode(url.searchParams.get('mediaMode')) : 'ok'}; Path=/; SameSite=Lax`],
      Location: executiveAnswer ? `/dashboard?from=${EXECUTIVE_ANSWER_RANGE.from}&to=${EXECUTIVE_ANSWER_RANGE.to}`
        : url.searchParams.get('scenario') === 'customer-followup' ? '/dashboard?from=2026-08-02&to=2026-08-04'
        : '/dashboard?from=2026-09-02&to=2026-09-04',
    })
    response.end()
    return
  }

  if (url.pathname === '/api/reporting') {
    const section = url.searchParams.get('section') ?? 'meta'
    if (!['meta', 'business', 'website', 'measurement'].includes(section)) {
      sendJson(response, { error: 'Choose a supported reporting source.' }, 400)
      return
    }
    try {
      const range = resolveReportingRange({
        from: url.searchParams.get('from') ?? '2026-09-02',
        to: url.searchParams.get('to') ?? '2026-09-04',
      })
      const cookies = new Map(request.headers.cookie?.split(';').map(cookie => {
        const [key, value] = cookie.trim().split('='); return [key, value] as const
      }))
      const scenario = cookies.get('maxx-preview-scenario')
      const executiveAnswer = executiveAnswerMode(scenario)
      const data = scenario === 'media-movement' ? mediaMovementFixture(range.from, range.to)
        : executiveAnswer ? executiveAnswerFixture(range.from, range.to, executiveAnswer)
        : scenario === 'creative' || scenario === 'reference' ? (scenario === 'reference' ? referenceReportingFixture : creativeReportingFixture)(range.from, range.to,
        creativeMediaOrigin(decodeURIComponent(cookies.get('maxx-preview-media-origin') ?? '')), creativeMediaMode(cookies.get('maxx-preview-media-mode')),
        (url.searchParams.get('details') ?? '').split(',').filter(id => /^\d{1,32}$/.test(id)).slice(0, 2))
        : scenario === 'website' ? websiteReportingFixture(range.from, range.to)
        : scenario === 'audience' ? audienceReportingFixture(range.from, range.to)
        : scenario === 'business' ? businessReportingFixture(range.from, range.to)
        : scenario === 'customer-followup' ? customerFollowupReportingFixture()
        : scenario?.startsWith('customers') ? customerReportingFixture(range.from, range.to, scenario === 'customers-stable' ? 'stable' : scenario === 'customers-missing' ? 'missing' : 'movement')
        : scenario === 'executive' || scenario === 'review' ? executiveFixture(range.from, range.to, scenario === 'review') : null
      // The same packetVersion 2 form as the real API's JSON reply; the browser expands it.
      sendJson(response, compactReportingPacket({
        ...(data ? { section, context: data.context, result: data[section as 'meta' | 'business' | 'website' | 'measurement'] } : fixturePacket(section, range.from, range.to)),
        notes: ['Sample-data preview: fictional metrics, not Example Studio results.'],
      } as ReportingPacket))
    } catch { sendJson(response, { error: 'Choose valid report dates.' }, 400) }
    return
  }

  if (url.pathname === '/api/sync') {
    sendJson(response, { status: 'synced', lastSync: '2026-09-05T17:00:00Z', dataThrough: '2026-09-04' })
    return
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(response, { error: 'This feature is not connected in the sample preview.' }, 501)
    return
  }

  const upstream = proxyRequest({
    hostname: '127.0.0.1',
    port: APP_PORT,
    path: request.url,
    method: request.method,
    headers: { ...request.headers, host: `127.0.0.1:${APP_PORT}` },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(response)
  })
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502)
    response.end('Local preview application is unavailable.')
  })
  request.pipe(upstream)
})

// Next dev transports React debug data over HMR. Dropping the upgrade leaves
// the rendered shell waiting for hydration even after every script has loaded.
forwardHmrUpgrades(server, { appPort: APP_PORT, host: `127.0.0.1:${APP_PORT}` })

server.listen(PREVIEW_PORT, '127.0.0.1', () => {
  console.log(`Interactive synthetic preview: http://127.0.0.1:${PREVIEW_PORT}/preview`)
})
