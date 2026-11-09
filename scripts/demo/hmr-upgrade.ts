import { request as proxyRequest, type Server } from 'node:http'

// Next dev sends React debug data over its HMR WebSocket; a loopback gateway in front of `next dev`
// that drops the upgrade leaves the page rendered but never hydrated. Shared by the demo gateway
// (scripts/demo/gateway.ts) and the browser preview (tests/reporting-browser/interactive-preview.ts).

/** Turbopack serves HMR at /_next/hmr; webpack at /_next/webpack-hmr. */
const NEXT_HMR_PATH = /^\/_next\/(?:hmr|webpack-hmr)(?:[/?]|$)/

export interface HmrUpgradeOptions {
  appPort: number
  /** Host header sent to the app; the client's own Host is kept when omitted. */
  host?: string
}

/** Forward Next dev's HMR upgrades on `server` to the app on 127.0.0.1; destroy every other upgrade. */
export function forwardHmrUpgrades(server: Server, options: HmrUpgradeOptions): void {
  server.on('upgrade', (request, socket, head) => {
    if (!NEXT_HMR_PATH.test(request.url ?? '')) { socket.destroy(); return }
    const headers = options.host ? { ...request.headers, host: options.host } : request.headers
    const upstream = proxyRequest({ hostname: '127.0.0.1', port: options.appPort, path: request.url, method: 'GET', headers })
    upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
      const lines = reply.rawHeaders.reduce((acc, value, i, all) => (i % 2 === 0 ? `${acc}${value}: ${all[i + 1]}\r\n` : acc), '')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines}\r\n`)
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
}
