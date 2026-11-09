import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// the proxy forwards a per-request nonce as x-nonce. The root layout reads it (which also makes
// every page render per request, as nonces require) and hands it to the one inline script the app
// itself renders: next-themes' theme bootstrap. Next.js stamps its own scripts from the CSP header.

const requestHeaders = vi.hoisted(() => ({ value: new Headers() }))
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.value }))
vi.mock('next/font/google', () => ({ Inter: () => ({ variable: 'font-inter', className: 'font-inter' }) }))

beforeEach(() => { requestHeaders.value = new Headers() })

async function render(): Promise<string> {
  const { default: RootLayout } = await import('@/app/layout')
  return renderToStaticMarkup(await RootLayout({ children: <main>page</main> }))
}

const inlineScripts = (html: string) => [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])

describe('root layout and the CSP nonce', () => {
  it('passes the request nonce to the theme script', async () => {
    requestHeaders.value = new Headers({ 'x-nonce': 'bm9uY2UtbGF5b3V0LTAwMQ==' })
    const html = await render()
    const scripts = inlineScripts(html)
    expect(scripts.length).toBeGreaterThan(0)
    for (const tag of scripts) expect(tag).toContain('nonce="bm9uY2UtbGF5b3V0LTAwMQ=="')
    expect(html).toContain('<main>page</main>')
  })

  it('control: without a nonce header the script carries none (so the nonce above came from the request)', async () => {
    const scripts = inlineScripts(await render())
    expect(scripts.length).toBeGreaterThan(0)
    for (const tag of scripts) expect(tag).not.toContain('nonce="bm9uY2U')
  })
})
