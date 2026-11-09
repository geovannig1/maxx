import { describe, expect, it, vi } from 'vitest'
import { fetchAllAppointmentsByDateWindows } from '@/lib/outcomes/adapters/acuity/client'

describe('Acuity exhaustive appointment-date sweep', () => {
  it('splits a capped source window, deduplicates boundary records, and proves completion', async () => {
    const fetchWindow = vi.fn(async (start: string, end: string) => {
      if (start === '2026-01-01' && end === '2026-01-04') return [{ id: 1 }, { id: 2 }, { id: 3 }]
      if (start === '2026-01-01' && end === '2026-01-02') return [{ id: 1 }, { id: 2 }]
      return [{ id: 2 }, { id: 3 }]
    })

    const result = await fetchAllAppointmentsByDateWindows(fetchWindow, {
      minDate: '2026-01-01', maxDate: '2026-01-04', maxPerWindow: 3, maxWindows: 10,
    })

    expect(result).toMatchObject({ complete: true, blocker: null, queriedWindows: 3 })
    expect(result.rows.map((row) => row.id)).toEqual([1, 2, 3])
  })

  it('fails closed when one appointment day itself reaches the API cap', async () => {
    const result = await fetchAllAppointmentsByDateWindows(
      async () => [{ id: 1 }, { id: 2 }],
      { minDate: '2026-01-01', maxDate: '2026-01-01', maxPerWindow: 2, maxWindows: 10 },
    )
    expect(result).toMatchObject({ complete: false, blocker: 'single_appointment_day_at_cap' })
  })

  it('fails closed when the subdivision safety limit is exhausted', async () => {
    const result = await fetchAllAppointmentsByDateWindows(
      async () => [{ id: 1 }, { id: 2 }],
      { minDate: '2026-01-01', maxDate: '2026-01-04', maxPerWindow: 2, maxWindows: 1 },
    )
    expect(result).toMatchObject({ complete: false, blocker: 'appointment_window_limit_exhausted' })
  })
})
