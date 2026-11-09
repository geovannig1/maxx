import { describe, expect, it } from 'vitest'
import { alertMetricLabel } from '@/lib/conversions/labels'
import { pillPalette } from '@/components/ui/badges'

describe('pillPalette', () => {
  it('uses valid token fills for semantic colored pills', () => {
    expect(pillPalette({ tone: 'success' })).toMatchObject({
      background: 'var(--success-bg)',
      border: '1px solid var(--success)',
      color: 'var(--success)',
    })
    expect(pillPalette({ tone: 'warning', soft: true })).toMatchObject({
      background: 'var(--warning-bg)',
      border: '1px solid var(--warning-border)',
      color: 'var(--warning)',
    })
  })

  it('does not append alpha suffixes to CSS variables', () => {
    const styles = JSON.stringify([
      pillPalette({ tone: 'danger' }),
      pillPalette({ tone: 'accent', soft: true }),
      pillPalette({ hex: 'var(--organic-marker)', soft: true }),
    ])

    expect(styles).not.toContain('var(--danger)1f')
    expect(styles).not.toContain('var(--accent)55')
    expect(styles).not.toContain('var(--organic-marker)1f')
    expect(styles).toContain('color-mix(in srgb, var(--organic-marker) 12%, transparent)')
  })
})

describe('alertMetricLabel', () => {
  it('labels delivery metric abbreviations before conversion fallback', () => {
    expect(alertMetricLabel('cpm')).toBe('CPM')
    expect(alertMetricLabel('ctr')).toBe('CTR')
    expect(alertMetricLabel('spend')).toBe('Spend')
  })

  it('keeps Meta action types on the conversion label path', () => {
    expect(alertMetricLabel('appointment_confirmed')).toBe('Appointment Confirmed')
    expect(alertMetricLabel('offsite_conversion.fb_pixel_custom')).toBe('Custom pixel conversions')
  })
})
