import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

// Release plan Acceptance: the Meta platform module is the only place that talks to Meta's API.
//   1. No Meta API host (graph.facebook.com and its siblings, hence no Graph version base URL) appears
//      in src/ or scripts/ outside src/lib/platforms/meta/. Comments count: a commented-out call is a
//      copy-paste hazard. Documentation and UI links (www./business./developers.facebook.com) are not
//      API hosts and stay allowed.
//   2. Nothing outside src/lib/platforms/ imports src/lib/platforms/meta/ (value, type, dynamic,
//      re-export or `typeof import()`), except the pure vocabulary modules and the inherently Meta-
//      specific modules listed below. Everything else goes through src/lib/platforms/registry.ts.

const ROOT = path.resolve(__dirname, '..')
const SCAN_DIRS = ['src', 'scripts']
const PLATFORMS_DIR = 'src/lib/platforms'
const META_DIR = 'src/lib/platforms/meta'
const META_API_HOST = /\bgraph(?:-video)?\.(?:facebook|instagram)\.com\b/i
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs']

/** Pure Meta vocabulary: type-only imports, none from the Meta module, no network, no secrets.
 * Any module may import these. */
const PUBLIC_META_MODULES = new Set([
  // Meta's attribution-window label, shown beside Meta-reported numbers in the UI and reports.
  'src/lib/platforms/meta/attribution.ts',
  // Normalization of Meta's delivery_sub_status evidence, read back from the warehouse by diagnostics.
  'src/lib/platforms/meta/delivery-sub-status.ts',
])

/** Inherently Meta-specific modules outside the platform directory that may import Meta modules. */
const META_SPECIFIC_IMPORTERS = new Set([
  // (The Meta reporting readers moved under src/lib/platforms/meta/reporting/ in the v1 release; core code reaches
  // them through the registry's reporting capability.)
  // The Acuity example's Meta Conversions API sender: builds Meta CAPI payloads and re-exports Meta's
  // response contract. Its path is pinned by tests/golden and by tests that mock it.
  'src/lib/capi/acuity-capi.ts',
  // ADR-062: the campaign-plan creation sequence builds Meta Graph bodies (campaign → ad set →
  // adcreative → ad under act_<id>) and sends them only through the registry's campaignCreation.
  'src/lib/campaigns/plan-creation.ts',
  // Operator scripts about Meta specifically: the two diagnostics/backfill scripts call Meta readers
  // outside the app runtime. (The setup/doctor check reaches Meta through the registry's
  // connectionCheck capability since the v1 release.)
  'scripts/backfill-breakdowns.ts',
  'scripts/diagnose-value-gate.ts',
])

const rel = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/')
const inside = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`)

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return listSourceFiles(full)
    return EXTENSIONS.includes(path.extname(full)) && !full.endsWith('.d.ts') ? [full] : []
  })
}

export function hostHits(files: string[], root: string): string[] {
  return files.flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
    META_API_HOST.test(line) ? [`${rel(root, file)}:${i + 1}`] : []))
}

export function hostViolations(files: string[], root: string): string[] {
  return hostHits(files.filter((file) => !inside(rel(root, file), META_DIR)), root)
}

/** Every module specifier a file names, including type-only, dynamic and `typeof import()` forms. */
function specifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text)
    else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) found.push(node.arguments[0].text)
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text)
    else if (ts.isExternalModuleReference(node) && ts.isStringLiteral(node.expression)) found.push(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Repository-relative target of a local specifier, without extension; null for packages. */
function target(root: string, importer: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = path.join(root, 'src', specifier.slice(2))
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(importer), specifier)
  else return null
  return rel(root, base).replace(/\.(tsx?|mts|m?js)$/, '')
}

export function importViolations(files: string[], root: string): string[] {
  return files.flatMap((file) => {
    const importer = rel(root, file)
    if (inside(importer, PLATFORMS_DIR) || META_SPECIFIC_IMPORTERS.has(importer)) return []
    return specifiers(file).flatMap((specifier) => {
      const to = target(root, file, specifier)
      if (!to || !inside(to, META_DIR) || PUBLIC_META_MODULES.has(`${to}.ts`)) return []
      return [`${importer} -> ${specifier}`]
    })
  }).sort()
}

/** Vocabulary modules that are not pure: a value import, any Meta-module import, or network/env use. */
export function impureVocabulary(modules: string[], root: string): string[] {
  return modules.flatMap((module) => {
    const file = path.join(root, module)
    const text = readFileSync(file, 'utf8')
    const valueImports = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true).statements
      .filter((s): s is ts.ImportDeclaration => ts.isImportDeclaration(s) && !s.importClause?.isTypeOnly)
    const metaImports = specifiers(file).filter((s) => inside(target(root, file, s) ?? '', META_DIR))
    const effects = /\bfetch\(|process\.env|server-only/.test(text)
    return valueImports.length > 0 || metaImports.length > 0 || effects ? [module] : []
  })
}

const realFiles = SCAN_DIRS.flatMap((dir) => listSourceFiles(path.join(ROOT, dir)))

describe('Meta platform boundary', () => {
  it('scans the real source tree and sees the Meta host where it is allowed', () => {
    expect(realFiles.length).toBeGreaterThan(500)
    // Known-present control: the same instrument finds the host inside the Meta module.
    expect(hostHits(realFiles, ROOT).some((hit) => hit.startsWith('src/lib/platforms/meta/api-version.ts:'))).toBe(true)
  })

  it('no Meta API host appears outside src/lib/platforms/meta/', () => {
    expect(hostViolations(realFiles, ROOT)).toEqual([])
  })

  it('nothing outside src/lib/platforms/ imports a Meta platform module except the listed modules', () => {
    const violations = importViolations(realFiles, ROOT)
    expect(violations, `route these through @/lib/platforms/registry:\n${violations.join('\n')}`).toEqual([])
  })

  it('every listed Meta-specific importer still exists and still imports a Meta module', () => {
    for (const importer of META_SPECIFIC_IMPORTERS) {
      const file = path.join(ROOT, importer)
      expect(existsSync(file), `${importer} no longer exists; remove it from the list`).toBe(true)
      const metaTargets = specifiers(file).map((s) => target(ROOT, file, s))
        .filter((to): to is string => !!to && inside(to, META_DIR) && !PUBLIC_META_MODULES.has(`${to}.ts`))
      expect(metaTargets.length, `${importer} no longer needs Meta modules; remove it from the list`).toBeGreaterThan(0)
    }
  })

  it('public Meta vocabulary modules stay pure: type-only imports, none from the Meta module, no network or environment', () => {
    expect(impureVocabulary([...PUBLIC_META_MODULES], ROOT)).toEqual([])
  })
})

describe('Meta platform boundary controls (planted violations)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'platform-boundary-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const plant = (file: string, body: string) => {
    const full = path.join(dir, file)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
    return full
  }
  const files = [
    plant('src/lib/engine/alias.ts', "import { metaGet } from '@/lib/platforms/meta/client'\n"),
    plant('src/lib/engine/relative.ts', "import { fetchInsights } from '../platforms/meta/fetch-insights'\n"),
    plant('src/lib/engine/type-only.ts', "import type { MetaApiError } from '@/lib/platforms/meta/client'\n"),
    plant('src/lib/engine/dynamic.ts', "export const load = () => import('@/lib/platforms/meta/fetch-ads')\n"),
    plant('src/lib/engine/reexport.ts', "export { fetchAds } from '@/lib/platforms/meta/fetch-ads'\n"),
    plant('src/lib/engine/type-query.ts', "export type F = typeof import('@/lib/platforms/meta/pacing')\n"),
    // Formerly allowlisted (moved it under the Meta module): a reader back at this path is a violation.
    plant('src/lib/reporting/meta-reader.ts', "import { metaGet } from '@/lib/platforms/meta/client'\n"),
    plant('src/lib/engine/index-import.ts', "import { metaAdPlatform } from '@/lib/platforms/meta'\n"),
    plant('scripts/script.ts', "import { metaGet } from '../src/lib/platforms/meta/client'\n"),
    plant('src/lib/engine/host.ts', "// const url = 'https://graph.facebook.com/v25.0/act_1'\n"),
    plant('src/lib/engine/video-host.ts', "export const u = 'https://graph-video.facebook.com/x'\n"),
    // Allowed shapes, each of which must NOT be reported:
    plant('src/lib/platforms/registry.ts', "import { metaAdPlatform } from './meta'\n"),
    plant('src/lib/platforms/meta/client.ts', "export const base = 'https://graph.facebook.com/v25.0'\n"),
    plant('src/lib/engine/registry-user.ts', "import { getAdPlatform } from '@/lib/platforms/registry'\n"),
    plant('src/lib/engine/vocabulary.ts', "import { ATTRIBUTION_WINDOW_LABEL } from '@/lib/platforms/meta/attribution'\n"),
    plant('src/lib/capi/acuity-capi.ts', "import { fetchMetaConversion } from '@/lib/platforms/meta/conversions-delivery'\n"),
    plant('src/lib/engine/help-link.ts', "export const help = 'https://www.facebook.com/business/help/1'\n"),
    plant('src/lib/engine/look-alike.ts', "import { x } from '@/lib/platforms/metadata/y'\n"),
  ]

  it('reports every planted import violation and none of the allowed shapes', () => {
    expect(importViolations(files, dir)).toEqual([
      'scripts/script.ts -> ../src/lib/platforms/meta/client',
      'src/lib/engine/alias.ts -> @/lib/platforms/meta/client',
      'src/lib/engine/dynamic.ts -> @/lib/platforms/meta/fetch-ads',
      'src/lib/engine/index-import.ts -> @/lib/platforms/meta',
      'src/lib/engine/reexport.ts -> @/lib/platforms/meta/fetch-ads',
      'src/lib/engine/relative.ts -> ../platforms/meta/fetch-insights',
      'src/lib/engine/type-only.ts -> @/lib/platforms/meta/client',
      'src/lib/engine/type-query.ts -> @/lib/platforms/meta/pacing',
      'src/lib/reporting/meta-reader.ts -> @/lib/platforms/meta/client',
    ])
  })

  it('reports a vocabulary module that imports a value, imports the Meta module, or reads the environment', () => {
    const vocab = [
      plant('src/lib/platforms/meta/pure.ts', "import type { X } from '@/types/x'\nexport const LABEL = 'a'\n"),
      plant('src/lib/platforms/meta/value-import.ts', "import { y } from '@/lib/utils'\nexport const z = y\n"),
      plant('src/lib/platforms/meta/meta-type-import.ts', "import type { MetaApiError } from './client'\nexport type E = MetaApiError\n"),
      plant('src/lib/platforms/meta/env.ts', "export const v = process.env.META_API_VERSION\n"),
    ].map((file) => rel(dir, file))
    expect(impureVocabulary(vocab, dir)).toEqual([
      'src/lib/platforms/meta/value-import.ts',
      'src/lib/platforms/meta/meta-type-import.ts',
      'src/lib/platforms/meta/env.ts',
    ])
  })

  it('reports every planted host outside the Meta module and none inside it', () => {
    expect(hostViolations(files, dir)).toEqual(['src/lib/engine/host.ts:1', 'src/lib/engine/video-host.ts:1'])
  })
})
