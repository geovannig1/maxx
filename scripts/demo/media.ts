import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEMO_ADS } from './sample/demo-delivery'

// The sample creatives' images (a generated illustration per sample ad, and ./sample/creative.png, a
// placeholder), served from loopback over HTTPS. Report creative media URLs must be https (src/lib/reporting/contracts.ts), and the dev
// CSP's img-src allows https://127.0.0.1:* (src/lib/security/csp.ts), so this is the one local URL
// that satisfies both. The certificate is a throwaway self-signed one made with the local openssl
// for this run; its files are deleted as soon as the server holds them in memory. Nothing is
// downloaded and no trust store is changed, so an ordinary browser shows the creative placeholder
// instead of the image unless the certificate is accepted; demo:check's browser accepts it. Without
// openssl the sample creatives carry no image.

export const SAMPLE_CREATIVE_PATH = '/sample-creative.png'
// The demo runs from the repository root (start.ts spawns next from node_modules there).
const IMAGE = join(process.cwd(), 'scripts/demo/sample/creative.png')

export interface SampleMedia {
  /** The placeholder PNG. */
  imageUrl: string
  /** The generated illustration for the sample ad at this index (./sample/demo-delivery.ts order). */
  imageFor: (index: number) => string
  stop: () => Promise<void>
}

const HUES = [28, 205, 42, 265, 160, 330, 12, 190]

/** A flat, obviously illustrative creative for one sample ad: a colour field and its headline. */
export function sampleCreativeSvg(index: number): string | null {
  const ad = DEMO_ADS[index]
  if (!ad) return null
  const hue = HUES[index % HUES.length]
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 82%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 55% 48%)"/></linearGradient></defs>
<rect width="1600" height="1000" fill="url(#g)"/>
<circle cx="1240" cy="330" r="210" fill="hsl(${hue} 90% 96%)" opacity=".55"/>
<rect x="120" y="640" width="1360" height="4" fill="#fff" opacity=".7"/>
<text x="120" y="560" font-family="Helvetica, Arial, sans-serif" font-size="88" font-weight="700" fill="#fff">${escape(ad.headline)}</text>
<text x="120" y="740" font-family="Helvetica, Arial, sans-serif" font-size="48" fill="#fff" opacity=".9">Example Studio · sample creative</text>
${ad.format === 'video' ? '<polygon points="1190,250 1190,410 1330,330" fill="#fff" opacity=".9"/>' : ''}
</svg>`
}

export async function startSampleMedia(port: number, log: (line: string) => void): Promise<SampleMedia | null> {
  const directory = await mkdtemp(join(tmpdir(), 'maxx-demo-media-'))
  try {
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
        '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
    } catch {
      log('Maxx demo: openssl is not available, so the sample creatives show a placeholder instead of an image.')
      return null
    }
    const [key, cert, image] = await Promise.all([
      readFile(join(directory, 'key.pem')), readFile(join(directory, 'cert.pem')), readFile(IMAGE),
    ])
    const server = createServer({ key, cert }, (request, response) => {
      const path = new URL(request.url ?? '/', 'https://127.0.0.1').pathname
      const svgIndex = /^\/sample-creative-(\d+)\.svg$/.exec(path)
      const svg = svgIndex ? sampleCreativeSvg(Number(svgIndex[1]) - 1) : null
      const body = path === SAMPLE_CREATIVE_PATH ? image : svg ? Buffer.from(svg) : null
      if (!body || (request.method !== 'GET' && request.method !== 'HEAD')) {
        response.writeHead(404, { 'Cache-Control': 'no-store' })
        response.end()
        return
      }
      response.writeHead(200, { 'Content-Type': svg ? 'image/svg+xml' : 'image/png', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
      response.end(request.method === 'HEAD' ? undefined : body)
    })
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(port, '127.0.0.1', () => { server.off('error', fail); done() })
    })
    const stop = () => new Promise<void>((done) => {
      server.closeAllConnections()
      server.close(() => done())
    })
    return { imageUrl: `https://127.0.0.1:${port}${SAMPLE_CREATIVE_PATH}`, imageFor: (index) => `https://127.0.0.1:${port}/sample-creative-${index + 1}.svg`, stop }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
