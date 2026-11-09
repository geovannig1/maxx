import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scanSources } from './_support/source-scan'

// Acceptance, strict since the v1 release: outside the Acuity example adapter, its webhook route
// and its registry entry, nothing in src names Acuity: not shared code (src/lib, src/mcp, src/config), not
// the API routes, and not the screens (src/components, src/app pages). The shrink-only debt list is
// gone; any match outside the allowlist fails.

const ROOT = process.cwd()
const SCOPE = ['src']
const NAME = /acuity/i
const ALLOWED = [
  /^src\/lib\/outcomes\/adapters\/acuity\//,
  /^src\/app\/api\/webhooks\/acuity\/route\.ts$/,
  /^src\/lib\/outcomes\/registry\.ts$/,
  // The reference adapter's own conversion sender. Its path is pinned by the golden import
  // (tests/golden/outcome-semantics.golden.test.ts), which must stay byte-identical, so it cannot move
  // into the adapter folder.
  /^src\/lib\/capi\/acuity-capi\.ts$/,
  // The reference adapter's own environment variables (ACUITY_*), its external configuration contract,
  // which the env registry splices in (src/config/env-vars-core.ts names none of them).
  /^src\/config\/env-vars-adapters\.ts$/,
]

function violations(base: string): string[] {
  return scanSources(base, SCOPE, NAME)
    .filter((hit) => !ALLOWED.some((re) => re.test(hit.file)))
    .map((hit) => `${hit.file}:${hit.line}: ${hit.text.slice(0, 120)}`)
    .sort()
}

const planted = mkdtempSync(path.join(os.tmpdir(), 'maxx-acuity-boundary-'))
afterAll(() => rmSync(planted, { recursive: true, force: true }))

describe('Acuity stays inside its adapter', () => {
  it('finds the allowed adapter, registry and sender names (known-present control)', () => {
    const hits = scanSources(ROOT, SCOPE, NAME).map((h) => h.file)
    expect(hits).toContain('src/lib/outcomes/registry.ts')
    expect(hits).toContain('src/lib/capi/acuity-capi.ts')
    expect(hits.some((f) => f.startsWith('src/lib/outcomes/adapters/acuity/'))).toBe(true)
    expect(hits.some((f) => f.startsWith('src/app/api/webhooks/acuity/'))).toBe(true)
  })

  it('reports a planted name in shared code, an API route, a component and a page, and ignores the adapter (planted-violation control)', () => {
    const files: Record<string, string> = {
      'src/lib/reporting/new-reader.ts': "const source = 'Acuity'\n",
      'src/mcp/tools/acuity-tool.ts': 'export {}\n',
      'src/app/api/other/route.ts': '// reads the acuity ledger\n',
      'src/components/reporting/Card.tsx': 'export const label = "Acuity bookings"\n',
      'src/app/(dashboard)/reports/page.tsx': 'export const title = "ACUITY"\n',
      'src/lib/outcomes/adapters/acuity/client.ts': "export const name = 'Acuity'\n",
      'src/app/api/webhooks/acuity/route.ts': "export const name = 'Acuity'\n",
    }
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.join(planted, path.dirname(file)), { recursive: true })
      writeFileSync(path.join(planted, file), text)
    }
    expect(violations(planted)).toEqual([
      'src/app/(dashboard)/reports/page.tsx:1: export const title = "ACUITY"',
      'src/app/api/other/route.ts:1: // reads the acuity ledger',
      'src/components/reporting/Card.tsx:1: export const label = "Acuity bookings"',
      'src/lib/reporting/new-reader.ts:1: const source = \'Acuity\'',
      'src/mcp/tools/acuity-tool.ts:0: (path)',
    ])
  })

  it('has no Acuity name anywhere else in src', () => {
    expect(violations(ROOT)).toEqual([])
  })
})
