import { DEMO_ADS } from './sample/demo-delivery'
import { SAMPLE_MEDIA_PREFIX, isSampleMediaPath } from '../../src/lib/reporting/sample-media'

// The sample creatives' images: a generated illustration per sample ad, served by the demo gateway
// (./gateway.ts) from the page's own origin under /sample-media/. Same-origin is what an ordinary
// browser loads without a certificate exception, and it is inside the page CSP's img-src 'self'. The
// report contract accepts this path shape besides https (src/lib/reporting/sample-media.ts).

/** The same-origin path of the illustration for the sample ad at this index (./sample/demo-delivery.ts order). */
export function sampleImageFor(index: number): string {
  return `${SAMPLE_MEDIA_PREFIX}sample-creative-${index + 1}.svg`
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

/** The image for a request path, or null when the path names no sample creative. */
export function sampleMediaBody(pathname: string): Buffer | null {
  if (!isSampleMediaPath(pathname)) return null
  const index = /^\/sample-media\/sample-creative-(\d+)\.svg$/.exec(pathname)
  const svg = index ? sampleCreativeSvg(Number(index[1]) - 1) : null
  return svg ? Buffer.from(svg) : null
}

/** Headers for a sample image: an image only, never a document that could run anything. */
export const SAMPLE_MEDIA_HEADERS = {
  'Content-Type': 'image/svg+xml',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Cache-Control': 'no-store',
} as const
