import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SetupChecklist } from '@/components/setup/SetupChecklist'
import { demoSetupChecks, groupByIntegration, type CheckResult } from '@/lib/setup/types'

// The demo runs with Meta off on purpose; its checklist must say the Meta numbers are sample data,
// not "Missing or failing" (the install's real failure state).

const CHECKS: CheckResult[] = [
  { id: 'meta.env.META_ACCESS_TOKEN', integration: 'meta', level: 'fail', title: 'META_ACCESS_TOKEN', detail: 'META_ACCESS_TOKEN is not set.', fix: 'Set it.' },
  { id: 'supabase.env', integration: 'supabase', level: 'ok', title: 'Configuration values', detail: 'set and valid.' },
]

describe('demo setup checklist', () => {
  it('labels Meta as sample data, without a failure or a connection test', () => {
    const html = renderToStaticMarkup(<SetupChecklist groups={groupByIntegration(demoSetupChecks(CHECKS))} interactive />)
    expect(html).toContain('Sample data (no Meta connection in demo)')
    expect(html).not.toContain('Missing or failing')
    expect(html).not.toContain('META_ACCESS_TOKEN is not set')
    // the database group keeps its own test button; Meta has none
    expect(html.match(/Test connection/g)).toHaveLength(1)
  })

  it('control: outside the demo the Meta failure is shown as it is', () => {
    const html = renderToStaticMarkup(<SetupChecklist groups={groupByIntegration(CHECKS)} interactive />)
    expect(html).toContain('Missing or failing')
    expect(html).toContain('META_ACCESS_TOKEN is not set')
  })
})
