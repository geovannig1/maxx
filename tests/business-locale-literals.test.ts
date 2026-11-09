import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanSources } from './_support/source-scan'

// Acceptance: the business timezone is read from configuration everywhere. The only
// timezone literal allowed in `src` is the configuration default in src/config/business-config.ts.

const ROOT = process.cwd()
const LITERAL = /America\/New_York/
const ALLOWED = new Map([['src/config/business-config.ts', 1]])

function violations(base: string): string[] {
  const hits = scanSources(base, ['src'], LITERAL)
  const perFile = new Map<string, number>()
  for (const hit of hits) perFile.set(hit.file, (perFile.get(hit.file) ?? 0) + 1)
  return [...perFile].filter(([file, n]) => (ALLOWED.get(file) ?? 0) < n).map(([file, n]) => `${file} (${n})`)
}

const planted = mkdtempSync(path.join(os.tmpdir(), 'maxx-tz-literal-'))
afterAll(() => rmSync(planted, { recursive: true, force: true }))

describe('timezone literal rule', () => {
  it('finds the configuration default (known-present control)', () => {
    const hits = scanSources(ROOT, ['src'], LITERAL).filter((h) => h.file === 'src/config/business-config.ts')
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toContain('DEFAULT_BUSINESS_TIMEZONE')
  })

  it('reports a planted literal outside configuration (planted-violation control)', () => {
    mkdirSync(path.join(planted, 'src/lib'), { recursive: true })
    mkdirSync(path.join(planted, 'src/config'), { recursive: true })
    writeFileSync(path.join(planted, 'src/config/business-config.ts'), "export const DEFAULT_BUSINESS_TIMEZONE = 'America/New_York'\n")
    writeFileSync(path.join(planted, 'src/lib/report.ts'), "const tz = 'America/New_York'\n")
    expect(violations(planted)).toEqual(['src/lib/report.ts (1)'])
  })

  it('has no timezone literal in src outside the configuration default', () => {
    expect(violations(ROOT)).toEqual([])
  })
})
