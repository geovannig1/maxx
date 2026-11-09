import { beforeEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ search: '', pathname: '/performance', effects: [] as Array<() => unknown>, live: vi.fn(), saved: vi.fn() }))
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useEffect: (effect: () => unknown) => { control.effects.push(effect) },
}))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(control.search), usePathname: () => control.pathname }))
vi.mock('@/lib/use-global-controls', () => ({ useGlobalControls: () => ({ ready: true, range: { from: '2026-09-02', to: '2026-09-04' } }) }))
vi.mock('@/lib/reporting/saved-client', () => ({ readSavedReport: (...args: unknown[]) => control.saved(...args) }))
vi.mock('@/lib/reporting/request-packet', async importOriginal => ({ ...await importOriginal<object>(), requestReportingPacket: (...args: unknown[]) => control.live(...args) }))
import { useReportingData } from '@/lib/reporting/use-reporting-data'

beforeEach(() => { control.pathname = '/performance'; control.effects = []; control.live.mockReset().mockRejectedValue(new Error('Unconnected fixture')); control.saved.mockReset().mockRejectedValue(new Error('Invalid saved fixture')) })
describe('saved route cannot silently turn into current reporting', () => {
  it.each(['saved=', 'saved=malformed', 'saved=00000000-0000-4000-8000-000000000001'])('keeps %s on the exact saved path', async search => {
    control.search = search
    const report = useReportingData()
    const cleanups = control.effects.map(effect => effect())
    await Promise.resolve(); await Promise.resolve()
    expect(control.live).not.toHaveBeenCalled()
    expect(control.saved).toHaveBeenCalledOnce()
    expect(report.savedId).toBe(new URLSearchParams(search).get('saved'))
    expect(report.data).toBeNull()
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
  })
  it.each(['campaign', 'adset'])('requests selected %s history only from Meta', async level => {
    control.search = `from=2026-09-02&to=2026-09-04&view=detail&level=${level}&campaign=campaign-1&adset=set-7`
    useReportingData()
    const cleanups = control.effects.map(effect => effect())
    await Promise.resolve(); await Promise.resolve()
    expect(control.live).toHaveBeenCalledTimes(4)
    for (const [section, key] of control.live.mock.calls) {
      const params = new URLSearchParams(key)
      expect(params.get('from')).toBe('2026-09-02')
      expect(params.get('to')).toBe('2026-09-04')
      expect(params.get('historyEntity')).toBe(section === 'meta'
        ? JSON.stringify({ level, id: level === 'campaign' ? 'campaign-1' : 'set-7' }) : null)
    }
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
  })
  it.each(['/creative', '/dashboard', '/reports'])('does not request parent history for a filter on %s', async pathname => {
    control.pathname = pathname
    control.search = 'view=detail&level=campaign&campaign=campaign-1'
    useReportingData()
    const cleanups = control.effects.map(effect => effect())
    await Promise.resolve(); await Promise.resolve()
    expect(control.live).toHaveBeenCalledTimes(4)
    expect(control.live.mock.calls.every(([, key]) => !new URLSearchParams(key).has('historyEntity'))).toBe(true)
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
  })
  it('loads all four current sources when the saved parameter is absent', async () => {
    control.search = 'from=2026-09-02&to=2026-09-04'
    useReportingData()
    const cleanups = control.effects.map(effect => effect())
    await Promise.resolve(); await Promise.resolve()
    expect(control.live).toHaveBeenCalledTimes(4)
    expect(control.saved).not.toHaveBeenCalled()
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
  })
})
