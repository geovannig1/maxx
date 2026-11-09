import { createServer, request as proxyRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { demoPacket, type DemoCalendar } from './sample/demo-account'
import { resolveReportingRange } from '../../src/lib/reporting/range'
import { compactReportingPacket } from '../../src/lib/reporting/packet-format'
import { forwardHmrUpgrades } from './hmr-upgrade'
import { canonicalOriginReply } from './canonical-origin'

// The demo's front door (127.0.0.1 only). It signs the browser in as the fictional demo owner, serves
// the reporting API from the sample account (./sample/demo-account.ts: fictional native rows run
// through the real reporting builders, anchored to the day the demo started), refuses writes except
// the demo-safe ones, and proxies everything else to the app. Same approach as
// tests/reporting-browser/interactive-preview.ts.

export const SAMPLE_NOTE = 'Sample data: fictional metrics for a fictional business. Run npm run setup to connect your own accounts.'

/** Writes the demo allows: the outcome-source toggle, the setup checklist's connection tests, Copy
 *  studio scoring (deterministic, stores nothing), proposing, reviewing and rolling back a change
 *  (ADR-059; the app applies it with its simulated executor in demo mode, so nothing reaches Meta), and
 *  planning a campaign (ADR-062; its creation is simulated the same way). Generating and saving copy
 *  stay refused. */
const ALLOWED_WRITES = [
  /^PATCH \/api\/outcomes\/sources\/[0-9a-f-]{36}$/, /^POST \/api\/setup\/checks$/, /^POST \/api\/creative\/copy\/score$/,
  /^POST \/api\/changes$/, /^PATCH \/api\/changes\/[0-9a-f-]{36}$/, /^POST \/api\/changes\/[0-9a-f-]{36}\/rollback$/,
  // ADR-062: drafting, editing and submitting a campaign plan (AI is off in the demo: the template planner
  // drafts it), then the same /changes approval, which runs the simulated creation.
  /^POST \/api\/campaigns\/plans$/, /^POST \/api\/campaigns\/plans\/[0-9a-f-]{36}\/(?:submit|versions)$/,
]

export interface GatewayOptions {
  port: number
  appPort: number
  sessionCookie: string
  calendar: DemoCalendar
  /** The sample creatives' images (./media.ts); absent means the creatives carry no image. */
  imageFor?: (index: number) => string
}

function sendJson(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

function reporting(url: URL, response: ServerResponse, options: GatewayOptions) {
  const section = url.searchParams.get('section') ?? 'meta'
  if (!['meta', 'business', 'website', 'measurement'].includes(section)) return sendJson(response, { error: 'Choose a supported reporting source.' }, 400)
  try {
    const { from, to } = options.calendar.range
    const range = resolveReportingRange({ from: url.searchParams.get('from') ?? from, to: url.searchParams.get('to') ?? to })
    // Same packetVersion 2 form as the real API's JSON reply; the browser expands it.
    sendJson(response, compactReportingPacket({ ...demoPacket(section, { from: range.from, to: range.to }, options.calendar, options.imageFor), notes: [SAMPLE_NOTE] }))
  } catch {
    sendJson(response, { error: 'Choose valid report dates.' }, 400)
  }
}

const cookieName = (cookie: string) => cookie.slice(0, cookie.indexOf('='))
const cookieValue = (cookie: string) => cookie.slice(0, cookie.indexOf(';'))

function proxy(request: IncomingMessage, response: ServerResponse, options: GatewayOptions, withCookie: boolean) {
  const headers = { ...request.headers }
  if (!withCookie) headers.cookie = [headers.cookie, cookieValue(options.sessionCookie)].filter(Boolean).join('; ')
  const upstream = proxyRequest({ hostname: '127.0.0.1', port: options.appPort, path: request.url, method: request.method, headers }, (reply) => {
    const out = { ...reply.headers }
    if (!withCookie) out['set-cookie'] = [...(reply.headers['set-cookie'] ?? []), options.sessionCookie]
    response.writeHead(reply.statusCode ?? 502, out)
    reply.pipe(response)
  })
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' })
    response.end('The Maxx demo app is starting or unavailable; retry in a moment.')
  })
  request.pipe(upstream)
}

export function startGateway(options: GatewayOptions): Promise<Server> {
  const name = cookieName(options.sessionCookie)
  const server = createServer((request, response) => {
    const method = request.method ?? 'GET'
    // One origin (APP_URL): a page opened at localhost:<port> is sent to 127.0.0.1:<port> before it loads.
    const elsewhere = canonicalOriginReply({ method, url: request.url ?? '/', host: request.headers.host }, options.port)
    if (elsewhere) {
      response.writeHead(elsewhere.status, elsewhere.headers)
      return response.end(elsewhere.body)
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.port}`)
    const hasCookie = (request.headers.cookie ?? '').split(';').some((c) => c.trim().startsWith(`${name}=`))
    if (method !== 'GET' && method !== 'HEAD' && !ALLOWED_WRITES.some((rule) => rule.test(`${method} ${url.pathname}`))) {
      return sendJson(response, { error: 'The demo does not run this action. Run npm run setup to use Maxx with your own accounts.' }, 405)
    }
    if (url.pathname === '/' || url.pathname === '/login') {
      const { from, to } = options.calendar.range
      response.writeHead(302, { 'Set-Cookie': options.sessionCookie, Location: `/dashboard?from=${from}&to=${to}` })
      return response.end()
    }
    if (url.pathname === '/api/reporting') return reporting(url, response, options)
    proxy(request, response, options, hasCookie)
  })
  // Next dev sends React debug data over HMR; without the upgrade the page never hydrates.
  forwardHmrUpgrades(server, { appPort: options.appPort })
  return new Promise((done) => server.listen(options.port, '127.0.0.1', () => done(server)))
}
