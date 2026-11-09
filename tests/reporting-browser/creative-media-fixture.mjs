// Original local bytes; no download, source response replacement or global TLS trust.
import { createServer as httpsServer } from 'node:https'
import { createServer as httpServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export function mediaRange(header, length) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || !match[1] && !match[2]) return false
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(length - 1, Number(match[2])) : length - 1
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < length
    ? { start, end } : false
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port) })
  })
}
function ownSockets(server) {
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  return async () => {
    sockets.forEach(socket => socket.destroy())
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
}

export async function startCreativeMediaFixture(previewOrigin = 'http://127.0.0.1:3149') {
  if (previewOrigin !== 'http://127.0.0.1:3149') throw new Error('Only the existing isolated preview is allowed')
  const directory = await mkdtemp(join(tmpdir(), 'maxx-creative-preview-'))
  const assetRoot = fileURLToPath(new URL('./assets/creative-original/', import.meta.url))
  const mediaLog = [], proxyLog = [], cleanup = []
  const close = async () => {
    for (const stop of cleanup.reverse()) await stop()
    await rm(directory, { recursive: true, force: true })
  }
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
    const files = new Map(await Promise.all(['original-8.mp4', 'original-60.mp4', 'original.png'].map(async name =>
      [`/${name}`, { bytes: await readFile(join(assetRoot, name)), mime: name.endsWith('.mp4') ? 'video/mp4' : 'image/png' }])))
    files.set('/thumbnail.png', files.get('/original.png'))
    const media = httpsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (request, response) => {
      const path = new URL(request.url ?? '/', 'https://127.0.0.1').pathname
      const file = files.get(path), range = file ? mediaRange(request.headers.range, file.bytes.length) : null
      const status = !['GET', 'HEAD'].includes(request.method) ? 405 : path.startsWith('/denied/') ? 403
        : !file ? 404 : range === false ? 416 : range ? 206 : 200
      mediaLog.push({ path, method: request.method, range: request.headers.range ?? null, status })
      const headers = { 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' }
      if (status === 416) headers['Content-Range'] = `bytes */${file.bytes.length}`
      if (status === 200 || status === 206) {
        headers['Content-Type'] = file.mime
        headers['Content-Length'] = range ? range.end - range.start + 1 : file.bytes.length
        if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.bytes.length}`
      }
      response.writeHead(status, headers)
      response.end(request.method === 'HEAD' || status >= 400 ? undefined : range ? file.bytes.subarray(range.start, range.end + 1) : file.bytes)
    })
    cleanup.push(ownSockets(media))
    const mediaPort = await listen(media), origin = `https://127.0.0.1:${mediaPort}`
    // A real forward proxy restricts destination/methods. It forwards ordinary source and
    // asset bytes unchanged; no Playwright routing or API body substitution is used.
    const proxy = httpServer((request, response) => {
      let url
      try { url = new URL(request.url) } catch { response.writeHead(400).end(); return }
      const allowed = url.origin === previewOrigin && !url.username && !url.password && ['GET', 'HEAD'].includes(request.method)
      proxyLog.push({ url: url.href, method: request.method, allowed })
      if (!allowed) { response.writeHead(403).end('Outside isolated preview allowlist'); return }
      const upstream = httpRequest(url, { method: request.method, headers: { ...request.headers, host: url.host } }, incoming => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response)
      })
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      request.pipe(upstream)
    })
    proxy.on('connect', (request, socket, head) => {
      // Chromium also tunnels plain WebSocket traffic through CONNECT. Next's
      // existing gateway validates that upgrade path; retaining it permits hydration.
      const port = request.url === `127.0.0.1:${mediaPort}` ? mediaPort : request.url === '127.0.0.1:3149' ? 3149 : null
      const allowed = port !== null
      proxyLog.push({ url: `tunnel://${request.url}`, method: 'CONNECT', allowed })
      if (!allowed) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
      const upstream = connect(port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(socket); socket.pipe(upstream)
      })
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy())
      socket.on('close', () => upstream.destroy())
    })
    proxy.on('upgrade', (request, socket, head) => {
      let url
      try { url = new URL(request.url) } catch { socket.destroy(); return }
      if (url.host !== '127.0.0.1:3149' || !['ws:', 'http:'].includes(url.protocol) || url.pathname !== '/_next/webpack-hmr') { socket.destroy(); return }
      const upstream = httpRequest({ hostname: '127.0.0.1', port: 3149, path: `${url.pathname}${url.search}`,
        headers: { ...request.headers, host: '127.0.0.1:3149' } })
      upstream.on('upgrade', (response, remote, remoteHead) => {
        const headers = response.rawHeaders.reduce((out, value, index, all) => index % 2 === 0 ? `${out}${value}: ${all[index + 1]}\r\n` : out, '')
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`)
        if (head.length) remote.write(head)
        if (remoteHead.length) socket.write(remoteHead)
        remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy())
        socket.on('close', () => remote.destroy()); remote.pipe(socket); socket.pipe(remote)
      })
      upstream.on('error', () => socket.destroy()); upstream.end()
    })
    cleanup.push(ownSockets(proxy))
    const proxyPort = await listen(proxy)
    return { origin, proxy: `http://127.0.0.1:${proxyPort}`, mediaLog, proxyLog, close,
      assets: Object.fromEntries([...files].map(([path, file]) => [path, { length: file.bytes.length, mime: file.mime }])) }
  } catch (error) { await close(); throw error }
}
