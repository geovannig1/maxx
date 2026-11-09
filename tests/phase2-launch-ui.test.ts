import { describe, expect, it } from 'vitest'
import { trustBadgeStyle } from '@/components/trust/TrustBadge'
import { COMPACT_SOURCE_CLASS, SEGMENTED_SOURCE_CLASS } from '@/components/layout/Topbar'
import { ALL_NAV_ITEMS, NAV } from '@/components/layout/nav-config'

describe('launch UI contracts', () => {
  it('trust badges use valid CSS-variable fills', () => {
    const styles = JSON.stringify([
      trustBadgeStyle('verified'),
      trustBadgeStyle('high'),
      trustBadgeStyle('low'),
      trustBadgeStyle('insufficient'),
    ])

    expect(styles).toContain('color-mix(in srgb, var(--success) 12%, transparent)')
    expect(styles).not.toContain('var(--success)1f')
    expect(styles).not.toContain('var(--accent)1f')
    expect(styles).not.toContain('var(--trust-low)1f')
  })

  it('keeps source visible below xl and segmented at xl', () => {
    expect(COMPACT_SOURCE_CLASS).toContain('inline-flex')
    expect(COMPACT_SOURCE_CLASS).toContain('xl:hidden')
    expect(COMPACT_SOURCE_CLASS).not.toMatch(/(^|\s)hidden(\s|$)/)
    expect(SEGMENTED_SOURCE_CLASS).toContain('hidden')
    expect(SEGMENTED_SOURCE_CLASS).toContain('xl:inline-flex')
  })

  it('sidebar leads with the four-route reporting loop and keeps operational surfaces secondary', () => {
    // Read the two SECTIONS, not positions in a flattened list. The old form sliced at index 4, so
    // promoting Creative into the primary loop made the secondary assertion fail with a message
    // about Diagnostics — a break that named the wrong thing entirely. The IA is a structure; assert
    // the structure.
    const [primary, secondary] = NAV
    const sidebarLabels = NAV.flatMap((section) => section.items.map((item) => item.label))

    expect(primary.items.map((item) => item.label)).toEqual([
      'Overview',
      'Ads',
      'Creative',
      'Reports',
    ])
    expect(primary.items.map((item) => item.href)).toEqual(['/dashboard', '/performance', '/creative', '/reports'])
    expect(secondary.items.map((item) => item.label)).toEqual([
      'Measurement',
      'Decisions',
      'Activity',
      'Experiments',
      'Diagnostics',
      'Launch setup',
      'Settings',
      'Ask Maxx',
    ])
    expect(sidebarLabels).not.toContain('Approvals')
    expect(sidebarLabels).not.toContain('Pending Changes')
    expect(sidebarLabels).not.toContain('Create')
    expect(sidebarLabels).not.toContain('Hooks')
    expect(sidebarLabels).not.toContain('Discovery')
    expect(sidebarLabels).not.toContain('Competitors')
    expect(sidebarLabels).not.toContain('Signals')
  })

  it('deprioritized routes remain command-palette reachable', () => {
    const allLabels = ALL_NAV_ITEMS.map((item) => item.label)

    expect(allLabels).toContain('Create')
    expect(allLabels).toContain('Hooks')
    expect(allLabels).toContain('Discovery')
    expect(allLabels).toContain('Competitors')
    expect(allLabels).toContain('Signals')
    expect(allLabels).toContain('Pending Changes')
    expect(allLabels).toContain('Approvals')
  })
})
