import { createServer, request as proxyRequest, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { forwardHmrUpgrades } from '../../scripts/demo/hmr-upgrade'
import { fixturePacket } from '../../scripts/demo/sample/reports'
import type { ReportingPacket } from '../../src/lib/reporting/contracts'
import { compactReportingPacket } from '../../src/lib/reporting/packet-format'

/** Real loopback HTTP bodies held open by the test, with no browser reporting
 * interception. Pages/scripts still come from the isolated Next test app. Packets go out in the
 * real API's packetVersion 2 form (JSON and every NDJSON frame); `held` keeps them expanded. */
export async function progressiveGateway() {
  const held: Array<{ response: ServerResponse; packet: ReportingPacket; closed: boolean; accept: string }> = []
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
    if (url.pathname === '/api/reporting') {
      const section = url.searchParams.get('section') ?? 'meta'
      const packet = fixturePacket(section, url.searchParams.get('from')!, url.searchParams.get('to')!)
      packet.notes = ['Sample reporting transport test: fictional metrics.']
      if (packet.section !== 'meta' || !packet.result.data) {
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(compactReportingPacket(packet))); return
      }
      packet.result.data.entities = packet.result.data.entities.map(entity => ({ ...entity,
        creative: entity.creative ? { ...entity.creative, imageUrl: null, thumbnailUrl: null, videoUrl: null } : null,
      }))
      const entry = { response, packet, closed: false, accept: request.headers.accept ?? '' }
      held.push(entry)
      response.on('close', () => { entry.closed = true })
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'private, no-store, no-transform' })
      response.flushHeaders()
      response.write(`${JSON.stringify({ kind: 'partial', packet: compactReportingPacket({ ...packet, result: { ...packet.result, state: 'partial', notes: ['Optional Meta details, configuration and trends are loading.'],
        data: { ...packet.result.data, detailState: 'loading', entities: packet.result.data.entities.map(entity => ({
          ...entity, creative: null, status: 'UNKNOWN', configurationAsOf: null, audience: 'unknown', audienceLabel: 'Configuration loading',
        })) },
      } }) })}\n`)
      return
    }
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return
    }
    const upstream = proxyRequest({ hostname: '127.0.0.1', port: 3147, path: request.url, method: request.method,
      headers: { ...request.headers, host: '127.0.0.1:3147' },
    }, incoming => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response) })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
    request.pipe(upstream)
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  // Turbopack's HMR socket is /_next/hmr; dropping it leaves the page rendered but never hydrated.
  forwardHmrUpgrades(server, { appPort: 3147, host: '127.0.0.1:3147' })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener')
  return { url: `http://127.0.0.1:${address.port}`, held,
    complete(index = held.length - 1, packet = held[index].packet) {
      const entry = held[index]
      if (!entry.closed) entry.response.end(`${JSON.stringify({ kind: 'complete', packet: compactReportingPacket(packet) })}\n`)
    },
    reset() { held.splice(0).forEach(entry => entry.response.destroy()) },
    async close() { sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
