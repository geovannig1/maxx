import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('owner source-health UI contracts', () => {
  it('diagnostics leads with the derived plain trust verdict and keeps technical proof collapsed', () => {
    const page = read('src/app/(dashboard)/diagnostics/page.tsx')
    const verdict = read('src/components/diagnostics/PlainTrustVerdict.tsx')

    expect(page.indexOf('<PlainTrustVerdict')).toBeLessThan(page.indexOf('<VerdictHeader'))
    for (const label of ['Tracking', 'Freshness', 'Attribution', 'Paid ROAS', '<details', 'Technical proof']) {
      expect(verdict).toContain(label)
    }
  })

  it('diagnostics no longer hard-codes another account\'s blockers; unavailable is still not a pass', () => {
    const page = read('src/app/(dashboard)/diagnostics/page.tsx')
    const verdict = read('src/components/diagnostics/PlainTrustVerdict.tsx')

    expect(page).not.toContain('FRESH_BLOCKERS')
    expect(page).not.toContain('paid-touch identity incomplete')
    expect(verdict).toContain('Unavailable is not a pass and not zero')
  })

  it('settings groups casual owner settings away from admin seed actions', () => {
    const page = read('src/app/(dashboard)/settings/page.tsx')

    expect(page).toContain('Sources')
    expect(page).toContain('Safety')
    expect(page).toContain('Targets')
    expect(page).toContain('Admin')
    expect(page).toContain('<details')
    expect(page.indexOf('Admin')).toBeLessThan(page.indexOf('Seed Competitors'))
  })

  it('launch leads with governed readiness, computed from source health, before ledger forms', () => {
    const page = read('src/app/(dashboard)/launch/page.tsx')
    const readiness = read('src/components/ledger/GovernedLaunchReadiness.tsx')

    expect(readiness).toContain('Governed launch readiness')
    expect(readiness).not.toContain('READINESS_ITEMS')
    expect(page).toContain('launchReadinessChecks(sourceHealth)')
    expect(page.indexOf('<GovernedLaunchReadiness')).toBeLessThan(page.indexOf('<ManifestEditor'))
  })
})
