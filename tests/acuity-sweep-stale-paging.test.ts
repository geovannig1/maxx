import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Acuity CAPI sweep closes out unsent bookings past the 48h dedup window. Its select used to exclude
// only rows already labelled 'missed-48h-window', so rows carrying ANOTHER terminal label (staff_created,
// expired, origin_unknown, no_id) kept matching: a page made of them marked nothing and stopped the loop,
// and every retryable row behind the first 500 stayed unlabelled forever. The select must exclude every
// terminal label so each page is markable, and the loop must stay bounded per run and resume next run.

vi.mock('@/lib/outcomes/adapters/acuity/client', () => ({
  getAppointment: vi.fn(), getAppointments: vi.fn(), isAcuityConfigured: vi.fn(() => true),
}))
vi.mock('@/lib/outcomes/adapters/acuity/paid-touch-link', () => ({
  paidTouchLinkConfig: vi.fn(() => null), linkAcuityPaidTouchWithFallback: vi.fn(),
}))
vi.mock('@/lib/capi/acuity-capi', () => ({ resolveSendMode: vi.fn(() => 'live'), sendAcuityCapiEvent: vi.fn() }))

const NOW = Date.parse('2026-11-08T12:00:00Z')
const STALE_AT = new Date(NOW - 72 * 3_600_000).toISOString()
type Row = { id: string; conversion_send_error: string | null; occurred_at: string }

/** Applies the filters the sweep sends: occurred_at bounds and the `or` on conversion_send_error, as PostgREST does. */
function fakeSupabase(rows: Row[]) {
  const from = vi.fn(() => {
    const f: { gte?: string; lt?: string; or?: string; update?: Record<string, unknown> } = {}
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'neq']) b[m] = vi.fn(() => b)
    b.gte = vi.fn((_c: string, v: string) => { f.gte = v; return b })
    b.lt = vi.fn((_c: string, v: string) => { f.lt = v; return b })
    b.or = vi.fn((expr: string) => { f.or = expr; return b })
    b.update = vi.fn((patch: Record<string, unknown>) => { f.update = patch; return b })
    b.in = vi.fn(async (_c: string, ids: string[]) => {
      const set = new Set(ids)
      for (const row of rows) if (set.has(row.id)) Object.assign(row, f.update)
      return { error: null }
    })
    const orMatches = (label: string | null): boolean => {
      if (!f.or) return true
      return f.or.split(/,(?![^(]*\))/).some((term) => {
        const [, op, ...rest] = term.split('.')
        const arg = rest.join('.')
        if (op === 'is' && arg === 'null') return label === null
        if (op === 'neq') return label !== null && label !== arg
        if (op === 'not' && arg.startsWith('in.(')) return label !== null && !arg.slice(4, -1).split(',').includes(label)
        throw new Error(`fake: unsupported or term ${term}`)
      })
    }
    b.limit = vi.fn(async (n: number) => ({
      data: rows.filter((r) => (!f.gte || r.occurred_at >= f.gte) && (!f.lt || r.occurred_at < f.lt)
        && orMatches(r.conversion_send_error)).slice(0, n).map((r) => ({ ...r })),
      error: null,
    }))
    return b
  })
  return { from }
}

const rowsOf = (count: number, label: string | null, prefix: string): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, conversion_send_error: label, occurred_at: STALE_AT }))

describe('Acuity CAPI sweep: stale close-out pages past terminal rows', () => {
  beforeEach(() => vi.resetModules())

  it('labels retryable stale rows that sit behind 500 rows with another terminal label', async () => {
    const rows = [...rowsOf(500, 'staff_created', 'terminal'), ...rowsOf(5, null, 'open'), ...rowsOf(3, 'transient-error', 'err')]
    const { sweepUnsentCapi } = await import('@/lib/outcomes/adapters/acuity/reconcile')
    const result = await sweepUnsentCapi(fakeSupabase(rows) as never, NOW)
    expect(result.markedMissed).toBe(8)
    expect(rows.filter((r) => r.id.startsWith('terminal')).every((r) => r.conversion_send_error === 'staff_created')).toBe(true)
    expect(rows.filter((r) => !r.id.startsWith('terminal')).every((r) => r.conversion_send_error === 'missed-48h-window')).toBe(true)
  })

  it('stays bounded per run and resumes on the next run', async () => {
    const rows = rowsOf(10_250, null, 'open')
    const db = fakeSupabase(rows)
    const { sweepUnsentCapi } = await import('@/lib/outcomes/adapters/acuity/reconcile')
    expect((await sweepUnsentCapi(db as never, NOW)).markedMissed).toBe(10_000)
    expect((await sweepUnsentCapi(db as never, NOW)).markedMissed).toBe(250)
    expect(rows.every((r) => r.conversion_send_error === 'missed-48h-window')).toBe(true)
  })
})
