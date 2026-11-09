import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { flagDiagnosticLabel } from '@/components/ui/badges'
import { projectFlagSurface } from '@/lib/authority/diagnostic-surface'

describe('legacy flag labels remain diagnostic on owner surfaces', () => {
  it('does not translate modelled flag types into action labels', () => {
    expect(flagDiagnosticLabel('winner')).toBe('Favorable signal')
    expect(flagDiagnosticLabel('loser')).toBe('Concerning signal')
    expect(flagDiagnosticLabel('scale_candidate')).toBe('High-delivery signal')
    expect(flagDiagnosticLabel('creative_refresh')).toBe('Fatigue signal')
  })

  it('does not render raw scale/kill/refresh flag types as owner decisions', () => {
    const files = [
      'src/app/(dashboard)/performance/flags/page.tsx',
      'src/app/(dashboard)/performance/campaigns/page.tsx',
      'src/app/(dashboard)/performance/adsets/page.tsx',
      'src/components/ui/slide-panel.tsx',
    ]
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')

    expect(source).not.toMatch(/label:\s*['"](?:Scale|Winner|Loser|Refresh Creative)['"]/)
    expect(source).not.toMatch(/flag_type\.replace\(/)
    expect(source).not.toMatch(/refresh creative immediately|plan a creative refresh|refresh creative\./i)
    expect(source).not.toMatch(/Critical\s*[—-]\s*refresh creative/i)
    expect(source).toMatch(/diagnostic/i)
  })

  it('does not expose legacy action prose through flag API/MCP projections', () => {
    const projected = projectFlagSurface({
      id: 'flag-1',
      flag_type: 'loser',
      recommended_action: 'Pause this ad immediately.',
      watch_next: 'Reduce budget tomorrow.',
    })

    expect(projected).toMatchObject({ action_authority_tier: 'diagnostic_only_legacy' })
    expect(projected).not.toHaveProperty('recommended_action_legacy_raw')
    expect(projected).not.toHaveProperty('watch_next_legacy_raw')
    expect(JSON.stringify(projected)).not.toMatch(/Pause this ad|Reduce budget tomorrow/i)
  })
})
