import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// `npm run demo` ships with the repository and must not depend on the test tree (tests may be
// pruned, restructured or excluded from a package). Its sample reports live with the demo
// (scripts/demo/sample/) and the tests import them from there.

const ROOT = path.resolve(__dirname, '..')
const DEMO = path.join(ROOT, 'scripts/demo')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? sources(full) : /\.(?:ts|mts|mjs|js)$/.test(entry.name) ? [full] : []
  })
}

/** Relative module specifiers in `code` (static, re-export and dynamic imports) that resolve under tests/. */
function importsIntoTests(file: string, code: string): string[] {
  const specifiers = [...code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1])
  return specifiers.filter((s) => s.startsWith('.') && path.resolve(path.dirname(file), s).startsWith(path.join(ROOT, 'tests') + path.sep))
}

describe('the demo does not import the test tree', () => {
  it('no module under scripts/demo imports from tests/', () => {
    const files = sources(DEMO)
    expect(files.length).toBeGreaterThan(5)
    const found = files.flatMap((file) => importsIntoTests(file, readFileSync(file, 'utf8')).map((s) => `${path.relative(ROOT, file)} -> ${s}`))
    expect(found).toEqual([])
  })

  it('control: the detector finds static, dynamic and side-effect imports into tests/', () => {
    const file = path.join(DEMO, 'x.ts')
    const code = [
      "import { a } from '../../tests/reporting-browser/fixture'",
      "const b = await import('../../tests/helpers/x')",
      "import '../../tests/setup/env'",
      "import { c } from '../../src/lib/reporting/range'",
      "import { d } from './sample/reports'",
    ].join('\n')
    expect(importsIntoTests(file, code)).toEqual(['../../tests/reporting-browser/fixture', '../../tests/helpers/x', '../../tests/setup/env'])
  })
})
