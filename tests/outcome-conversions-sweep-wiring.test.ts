import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

// The generic conversions sweep is what retries a failed first send (a webhook delivery never resends
// on its own). Its behaviour is proved on the shipped schema in tests/db/outcome-conversions-db.test.ts;
// this pin fails if the daily sync stops calling it, or calls it outside the lifecycle gate that also
// governs the Acuity sweep.
describe('daily sync runs the generic conversions sweep', () => {
  const src = fs.readFileSync('src/lib/sync/orchestrator.ts', 'utf8')

  it('imports the sweep from the conversions module', () => {
    expect(src).toMatch(/import \{ sweepUnsentOutcomeConversions \} from '@\/lib\/conversions\/outcome-sweep'/)
  })

  it('calls it inside the lifecycle gate, after the outcome-source reconcile step', () => {
    const acuity = src.indexOf('reconcileOutcomeSources({')
    const gated = /if \(lifecycleRun\) \{\s*try \{\s*const sweep = await sweepUnsentOutcomeConversions\(getAdminClient\(\)\)/.exec(src)
    expect(gated).not.toBeNull()
    expect(acuity).toBeGreaterThan(0)
    expect(gated!.index).toBeGreaterThan(acuity)
  })
})
