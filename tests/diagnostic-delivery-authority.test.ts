import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectDiagnosticAlert } from '@/lib/authority/diagnostic-surface'

const productionSurfaces = [
  'src/lib/diagnostics/opportunity.ts',
  'src/lib/diagnostics/quality-report.ts',
  'src/lib/diagnostics/to-tasks.ts',
  'src/mcp/tools/auction-diagnostics.ts',
  'src/mcp/tools/diagnosis-bundle.ts',
  'src/components/diagnostics/QualitySection.tsx',
  'src/app/(dashboard)/diagnostics/page.tsx',
]

describe('auction/delivery diagnostic authority boundary', () => {
  it('does not expose outcome-based scale scoring or action-shaped delivery states', () => {
    const source = productionSurfaces.map((path) => readFileSync(path, 'utf8')).join('\n')

    expect(source).not.toMatch(/scale opportunit|scale readiness|level:\s*['"]scale['"]|['"]hold['"]|fix efficiency/i)
    expect(source).not.toMatch(/cpaStatus|roasStatus|Cost efficiency \(CPA\)|Return \(ROAS\)/)
    expect(source).not.toMatch(/getMetricStatus|hydrateTargetOverrides/)
    expect(source).toMatch(/action_authority/)
    expect(source).toMatch(/prescriptions:\s*\[\]/)
  })

  it('does not leak legacy alert instructions, risk dollars, or action links through owner/model projections', () => {
    const projected = projectDiagnosticAlert({
      id: 'alert-1',
      alert_type: 'creative_fatigue',
      title: 'Ad is burnt out — pause and replace',
      message: 'Pause this ad now.',
      why_it_matters: 'Pause it before it drags down the campaign.',
      recommended_actions: ['Pause this ad immediately', 'Reduce budget by 30%'],
      amount_at_risk: 900,
      action_label: 'Pause This Ad',
      action_url: 'https://adsmanager.example/action',
    })

    expect(projected).toMatchObject({
      alert_type: 'auction_delivery_signal',
      title: 'Diagnostic alert: auction delivery signal',
      recommended_actions: null,
      why_it_matters: null,
      amount_at_risk: null,
      action_label: null,
      action_url: null,
      action_authority_tier: 'diagnostic_only',
    })
    expect(projected).not.toHaveProperty('legacy_raw_for_audit')
    expect(JSON.stringify(projected)).not.toMatch(/creative fatigue|pause and replace|Pause this ad|Reduce budget|900|adsmanager\.example/i)

    const legacyConfigurationClaim = projectDiagnosticAlert({
      alert_type: 'wrong_optimization_event',
      title: 'Wrong optimization event',
      message: 'Switch to AppointmentConfirmed.',
    })
    expect(legacyConfigurationClaim).toMatchObject({
      alert_type: 'configuration_observation',
      title: 'Diagnostic alert: configuration observation',
    })
    expect(JSON.stringify(legacyConfigurationClaim)).not.toMatch(/wrong optimization|AppointmentConfirmed|Switch to/i)
  })
})
