import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAV } from '@/components/layout/nav-config'
import { showsGlobalTrafficSource } from '@/components/layout/Topbar'

describe('Decision cockpit navigation', () => {
  it('exposes the four reporting destinations from the September 5 rebuild', () => {
    expect(NAV[0]?.items.map(({ label, href }) => ({ label, href }))).toEqual([
      { label: 'Overview', href: '/dashboard' },
      { label: 'Ads', href: '/performance' },
      { label: 'Creative', href: '/creative' },
      { label: 'Reports', href: '/reports' },
    ])
  })

  it('every primary destination RESOLVES, and the routes they replaced still redirect', () => {
    // The nav list and the filesystem must agree. A label pointing at a route that does not exist is
    // a 404 the sidebar advertises, and it is exactly the failure a hand-maintained IA produces —
    // The design plan carried the 7-destination target for three days while three of the routes did not
    // exist. This makes the document and the tree the same fact.
    // RESOLVES, not "is a leaf page". `/activity` is itself a redirect to `/activity/change-log`,
    // which is a working destination from the reader's side and the thing that prevents a 404. This
    // asserts the route answers; it deliberately does not assert how.
    const routeFile = (href: string) => join(process.cwd(), 'src/app/(dashboard)', href, 'page.tsx')
    for (const item of NAV[0]?.items ?? []) {
      const href = item.href === '/dashboard' ? '/dashboard' : item.href
      expect(() => readFileSync(routeFile(href), 'utf8'), `${item.label} -> ${href}`).not.toThrow()
    }

    // The three promoted routes keep their old URLs alive as redirects. A bookmark predates the IA.
    for (const [legacy, target] of [
      ['performance/creative', '/creative'],
      ['performance/tests', '/experiments'],
    ] as const) {
      const shim = readFileSync(join(process.cwd(), 'src/app/(dashboard)', legacy, 'page.tsx'), 'utf8')
      expect(shim, legacy).toContain('redirect(')
      expect(shim, legacy).toContain(`'${target}'`)
    }

    // NEGATIVE CONTROL: the helper must actually be able to fail, or the loop above proves nothing.
    expect(() => readFileSync(routeFile('/zz-not-a-destination'), 'utf8')).toThrow()
  })

  it('removes the misleading global source toggle from primary cockpit routes', () => {
    expect(showsGlobalTrafficSource('/dashboard')).toBe(false)
    expect(showsGlobalTrafficSource('/performance/campaigns')).toBe(false)
    expect(showsGlobalTrafficSource('/decisions')).toBe(false)
    expect(showsGlobalTrafficSource('/activity/change-log')).toBe(false)
    expect(showsGlobalTrafficSource('/reports')).toBe(false)
  })

  it('keeps Decisions and Activity metadata at 12px and primary body copy at 14px or larger', () => {
    const files = [
      'src/components/decisions/DecisionQueue.tsx',
      'src/app/(dashboard)/activity/change-log/page.tsx',
    ].map((file) => readFileSync(join(process.cwd(), file), 'utf8')).join('\n')

    expect(files).not.toMatch(/text-\[(?:10(?:\.5)?|11(?:\.5)?)px\]/)
    expect(files).toContain('text-[14px] leading-relaxed')
  })

  it('anchors Decisions cards by durable queue item id so Today can focus the primary action', () => {
    const file = readFileSync(join(process.cwd(), 'src/components/decisions/DecisionQueue.tsx'), 'utf8')

    expect(file).toContain('id={`decision-${item.id}`}')
    expect(file).toContain('highlighted={item.id === focusedDecisionId}')
    expect(file).toContain('document.getElementById(`decision-${focusedDecisionId}`)')
    expect(readFileSync(join(process.cwd(), 'src/app/(dashboard)/decisions/page.tsx'), 'utf8'))
      .toContain('focusedDecisionId={focused?.id}')
  })
})
