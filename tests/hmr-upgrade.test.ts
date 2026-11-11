import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { forwardHmrUpgrades } from '../scripts/demo/hmr-upgrade'

// Next dev sends React debug data over its HMR WebSocket; a loopback gateway that drops the
// upgrade leaves the page un-hydrated. Turbopack serves it at /_next/hmr, webpack at
// /_next/webpack-hmr. The demo gateway and the browser preview share one forwarder for both.

const listen = (server: Server) => new Promise<number>((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)))
const close = (server: Server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) })

/** Send a WebSocket-style upgrade and return the first response line ('' when the socket is dropped). */
function upgrade(port: number, urlPath: string): Promise<string> {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
    })
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1')
      if (data.includes('\r\n\r\n')) { socket.destroy(); done(data.split('\r\n')[0]) }
    })
    socket.on('close', () => done(data.split('\r\n')[0] ?? ''))
    socket.on('error', () => done(''))
  })
}

describe('forwardHmrUpgrades', () => {
  let app: Server
  let gateway: Server
  let rewritten: Server
  let port: number
  let rewrittenPort: number
  let appPort: number
  const seen: Array<{ url: string; host: string | undefined }> = []
  beforeAll(async () => {
    app = createServer()
    app.on('upgrade', (request: IncomingMessage, socket) => {
      seen.push({ url: request.url ?? '', host: request.headers.host })
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-App: yes\r\n\r\n')
      socket.end()
    })
    appPort = await listen(app)
    gateway = createServer()
    forwardHmrUpgrades(gateway, { appPort })
    port = await listen(gateway)
    rewritten = createServer()
    forwardHmrUpgrades(rewritten, { appPort, host: `127.0.0.1:${appPort}` })
    rewrittenPort = await listen(rewritten)
  })
  afterAll(async () => { await close(gateway); await close(rewritten); await close(app) })

  it('forwards the Turbopack and the webpack HMR paths to the app', async () => {
    expect(await upgrade(port, '/_next/hmr')).toBe('HTTP/1.1 101 Switching Protocols')
    expect(await upgrade(port, '/_next/hmr?id=1')).toBe('HTTP/1.1 101 Switching Protocols')
    expect(await upgrade(port, '/_next/webpack-hmr')).toBe('HTTP/1.1 101 Switching Protocols')
    expect(seen.map((s) => s.url)).toEqual(['/_next/hmr', '/_next/hmr?id=1', '/_next/webpack-hmr'])
  })

  it('drops every other upgrade without contacting the app (controls)', async () => {
    const before = seen.length
    for (const urlPath of ['/api/reporting', '/_next/hmrx', '/_next/static/hmr', '/x/_next/hmr']) {
      expect(await upgrade(port, urlPath), urlPath).toBe('')
    }
    expect(seen.length).toBe(before)
  })

  it('keeps the client Host header unless a host is given', async () => {
    seen.length = 0
    await upgrade(port, '/_next/hmr')
    await upgrade(rewrittenPort, '/_next/hmr')
    expect(seen[0].host).toBe(`127.0.0.1:${port}`)
    expect(seen[1].host).toBe(`127.0.0.1:${appPort}`)
  })
})

describe('the demo gateway and the browser preview share the forwarder', () => {
  const root = path.resolve(__dirname, '..')
  for (const file of ['scripts/demo/gateway.ts', 'tests/reporting-browser/interactive-preview.ts',
    'tests/reporting-browser/progressive-gateway.ts', 'tests/reporting-browser/prepared.spec.ts',
    'tests/reporting-browser/saved-preview.ts', 'tests/reporting-browser/hierarchy-history-check.mjs']) {
    it(file, () => {
      const source = readFileSync(path.join(root, file), 'utf8')
      expect(source).toMatch(/forwardHmrUpgrades\(server, \{/)
      // No second, hand-rolled upgrade handler that could again miss a path.
      expect(source).not.toMatch(/\.on\(['"]upgrade['"]/)
    })
  }
})
