import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dispatch, SetStateAction } from 'react'

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void>, pushes: vi.fn(), replacements: vi.fn(),
  pathname: '/dashboard', search: 'saved=00000000-0000-4000-8000-000000001401' }))
vi.mock('next/navigation', () => ({ usePathname: () => hooks.pathname,
  useSearchParams: () => new URLSearchParams(hooks.search), useRouter: () => ({ push: hooks.pushes, replace: hooks.replacements }) }))
// Run the hook's actual mount effect and setters with deterministic hook plumbing; no browser APIs or network are substituted inside the implementation.
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(),
  useState: <T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] => [typeof initial === 'function' ? (initial as () => T)() : initial, vi.fn()],
  useRef: <T>(initial: T) => ({ current: initial }), useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => void) => { hooks.effects.push(effect) },
}))

import { buildGlobalControlsUrl, useGlobalControls, withGlobalControlParams } from '@/lib/use-global-controls'

const savedId = '00000000-0000-4000-8000-000000001401'
const period = { preset: 'custom' as const, from: '2026-09-02', to: '2026-09-04' }
const stored = { getItem: vi.fn((key: string) => key === 'maxx.range.v1' ? JSON.stringify(period) : 'paid'), setItem: vi.fn() }

beforeEach(() => {
  hooks.pathname = '/dashboard'; hooks.search = `saved=${savedId}`; hooks.effects = []
  hooks.pushes.mockClear(); hooks.replacements.mockClear(); stored.setItem.mockClear()
  vi.stubGlobal('localStorage', stored)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('saved report shell navigation', () => {
  it.each(['/dashboard', '/performance', '/creative', '/reports'])('retains saved identity when navigating to %s', pathname => {
    const result = withGlobalControlParams(`${pathname}?group=clicks#retention`, `saved=${savedId}&from=2026-09-02&to=2026-09-04&campaign=wrong-route-filter`)
    const url = new URL(result, 'https://maxx.invalid')
    expect(url.searchParams.get('saved')).toBe(savedId)
    expect(url.searchParams.get('group')).toBe('clicks')
    expect(url.searchParams.get('from')).toBe('2026-09-02')
    expect(url.searchParams.has('campaign')).toBe(false)
    expect(url.hash).toBe('#retention')
  })
  it.each(['/settings', '/reports/saved', '/performance/campaigns', '/dashboard-extra', '/activity/reports'])('does not carry saved identity into unsupported %s', pathname => {
    const result = withGlobalControlParams(`${pathname}?saved=stale`, `saved=${savedId}&from=2026-09-02&to=2026-09-04`)
    expect(new URL(result, 'https://maxx.invalid').searchParams.has('saved')).toBe(false)
  })
  it('does not rewrite frozen dates through the shared URL builder', () => {
    expect(buildGlobalControlsUrl({ pathname: '/reports', search: `saved=${savedId}&from=2020-01-02&to=2020-01-04&report=business`,
      range: period, source: 'complete' })).toBe(`/reports?saved=${savedId}&from=2020-01-02&to=2020-01-04&report=business`)
  })
})

describe('saved report mount and control guards', () => {
  it.each([`saved=${savedId}`, `saved=${savedId}&from=broken&to=also-broken`, 'saved='])('does not restore stored dates or navigate on frozen mount: %s', search => {
    hooks.search = search
    useGlobalControls(); hooks.effects.forEach(effect => effect())
    expect(hooks.replacements).not.toHaveBeenCalled()
  })
  it('prevents date/source setters from leaving or changing saved evidence', () => {
    const controls = useGlobalControls()
    controls.setRange(period); controls.setSource('organic')
    expect(hooks.pushes).not.toHaveBeenCalled()
    expect(stored.setItem).not.toHaveBeenCalled()
  })
  it('still restores and edits dates on a current report', () => {
    hooks.search = ''
    const controls = useGlobalControls(); hooks.effects.forEach(effect => effect())
    expect(hooks.replacements).toHaveBeenCalledWith('/dashboard?from=2026-09-02&to=2026-09-04', { scroll: false })
    controls.setRange(period)
    expect(hooks.pushes).toHaveBeenCalledWith('/dashboard?from=2026-09-02&to=2026-09-04', { scroll: false })
    expect(stored.setItem).toHaveBeenCalled()
  })
})
