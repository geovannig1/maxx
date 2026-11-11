import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ReportCreativeSchema, type ReportCreative } from '@/lib/reporting/contracts'
import { CreativeAsset } from '@/components/reporting/CreativeAsset'
import { startGateway } from '../scripts/demo/gateway'
import { sampleImageFor } from '../scripts/demo/media'
import { demoSessionCookie } from '../scripts/demo/backend'
import { demoCalendar } from '../scripts/demo/sample/demo-account'

// The demo's sample creatives are served by the demo gateway on the page's own origin, so an ordinary
// browser shows them (a loopback https server needed a certificate exception). The creative contract
// accepts exactly that same-origin shape besides https, and nothing looser.

const creative = (imageUrl: string | null): ReportCreative => ({ id: 'c1', name: 'Sample', format: 'image', thumbnailUrl: imageUrl,
  imageUrl, videoUrl: null, durationSeconds: null, body: null, headline: null, destination: null })

describe('creative image URLs', () => {
  it('accepts https and the demo sample-media path for images', () => {
    expect(ReportCreativeSchema.safeParse(creative('https://scontent.fbcdn.net/x.jpg')).success).toBe(true)
    expect(ReportCreativeSchema.safeParse(creative(sampleImageFor(0))).success).toBe(true)
  })

  it.each(['http://127.0.0.1:3000/sample-media/a.svg', '/api/reporting', '//evil.example/sample-media/a.svg',
    '/sample-media/../api/x.svg', '/sample-media/a.svg?x=1', '/sample-media/a.html', 'sample-media/a.svg', 'javascript:alert(1)'])(
    'refuses %s', (url) => {
      expect(ReportCreativeSchema.safeParse(creative(url)).success).toBe(false)
    })

  it('keeps destination and video https-only', () => {
    expect(ReportCreativeSchema.safeParse({ ...creative(null), destination: sampleImageFor(0) }).success).toBe(false)
    expect(ReportCreativeSchema.safeParse({ ...creative(null), videoUrl: sampleImageFor(0) }).success).toBe(false)
  })

  it('renders a sample-media image and still drops an unsafe one', () => {
    expect(renderToStaticMarkup(createElement(CreativeAsset, { creative: creative(sampleImageFor(0)), name: 'Sample' })))
      .toContain(`src="${sampleImageFor(0)}"`)
    expect(renderToStaticMarkup(createElement(CreativeAsset, { creative: { ...creative(null), imageUrl: '/api/reporting' }, name: 'Unsafe' })))
      .not.toContain('<img')
  })
})

describe('demo gateway sample media', () => {
  let gateway: Server
  let app: Server
  let base: string
  const listen = (server: Server) => new Promise<number>((done) => server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)))
  const close = (server: Server) => new Promise<void>((done) => server.close(() => done()))
  beforeAll(async () => {
    app = createServer((_req, res) => res.end('APP'))
    const appPort = await listen(app)
    const probe = createServer()
    const port = await listen(probe)
    await close(probe)
    gateway = await startGateway({ port, appPort, sessionCookie: demoSessionCookie('http://127.0.0.1:1'), calendar: demoCalendar(new Date('2026-11-08T15:00:00Z')) })
    base = `http://127.0.0.1:${port}`
  })
  afterAll(async () => { await close(gateway); await close(app) })

  it('serves each sample creative as an image from its own origin, locked down', async () => {
    const reply = await fetch(`${base}${sampleImageFor(0)}`)
    expect(reply.status).toBe(200)
    expect(reply.headers.get('content-type')).toBe('image/svg+xml')
    expect(reply.headers.get('x-content-type-options')).toBe('nosniff')
    expect(reply.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(await reply.text()).toContain('<svg')
  })

  it('answers 404 for an unknown sample and does not pass the path to the app', async () => {
    const reply = await fetch(`${base}/sample-media/sample-creative-999.svg`)
    expect(reply.status).toBe(404)
    expect(await reply.text()).not.toBe('APP')
  })

  it('puts the same-origin image paths in the sample report', async () => {
    const body = await (await fetch(`${base}/api/reporting?section=meta&from=2026-09-02&to=2026-09-04`)).text()
    expect(body).toContain(sampleImageFor(0))
    expect(body).not.toMatch(/https:\/\/127\.0\.0\.1/)
  })
})
