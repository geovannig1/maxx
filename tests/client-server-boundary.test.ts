import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { bindingKey, envReadsOf } from './helpers/env-reads'

// Regression guard for the client/server module boundary. Every 'use client' file is a client
// bundle entry: whatever it VALUE-imports (transitively) ships to the browser. This walks that graph
// statically and fails if any client entry reaches a module marked `import 'server-only'` or the
// service-role admin client. Type-only imports are skipped because TypeScript/SWC erase them.

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const ADMIN = path.join(SRC, 'lib/supabase/admin.ts')
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']

type ParsedModule = { specifiers: string[]; directive: string | null }

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return listSourceFiles(full)
    return EXTENSIONS.includes(path.extname(full)) && !full.endsWith('.d.ts') ? [full] : []
  })
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return false // `import 'x'` is a side-effect (value) import
  if (clause.isTypeOnly) return true
  if (clause.name) return false
  const bindings = clause.namedBindings
  if (!bindings || ts.isNamespaceImport(bindings)) return false
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly)
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true
  const clause = node.exportClause
  return !!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly)
}

const parseCache = new Map<string, ParsedModule>()

function parseModule(file: string): ParsedModule {
  const cached = parseCache.get(file)
  if (cached) return cached
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const first = source.statements[0]
  const directive =
    first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) ? first.expression.text : null
  const specifiers: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !isTypeOnlyImport(node)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !isTypeOnlyExport(node)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const parsed = { specifiers, directive }
  parseCache.set(file, parsed)
  return parsed
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = path.join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier)
  else return null // package import; `server-only` itself is detected by name, not resolved
  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => path.join(base, 'index' + ext)),
  ]
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null
}

function isServerModule(file: string): boolean {
  return file === ADMIN || parseModule(file).specifiers.includes('server-only')
}

/** Shortest value-import chain from `entry` to a server-only module, or null if none is reachable. */
export function findServerChain(entry: string): string[] | null {
  const previous = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (isServerModule(file)) {
      const chain: string[] = []
      for (let at: string | null = file; at; at = previous.get(at) ?? null) chain.unshift(path.relative(ROOT, at))
      return chain
    }
    // A 'use server' module is replaced by a server reference stub in the client bundle.
    if (file !== entry && parseModule(file).directive === 'use server') continue
    for (const specifier of parseModule(file).specifiers) {
      const next = resolveLocal(file, specifier)
      if (next && !previous.has(next)) {
        previous.set(next, file)
        queue.push(next)
      }
    }
  }
  return null
}

const clientEntries = listSourceFiles(SRC).filter((file) => parseModule(file).directive === 'use client')

describe('client/server module boundary', () => {
  it('finds the client entries it is meant to guard', () => {
    expect(clientEntries.length).toBeGreaterThan(50)
  })

  it('control: reaches the admin client from a known server module', () => {
    const chain = findServerChain(path.join(SRC, 'lib/sync/upsert-insights.ts'))
    expect(chain).not.toBeNull()
    expect(chain!.at(-1)).toBe('src/lib/supabase/admin.ts')
  })

  it('control: a pure utility module reaches nothing server-only', () => {
    expect(findServerChain(path.join(SRC, 'lib/utils.ts'))).toBeNull()
  })

  it('no client component value-imports server-only code', () => {
    const violations = clientEntries
      .map((entry) => findServerChain(entry))
      .filter((chain): chain is string[] => chain !== null)
      .map((chain) => chain.join(' -> '))
    expect(violations, `${violations.length} client entries reach server-only code:\n${violations.join('\n')}`).toEqual([])
  })
})

// The walk above trusts the `server-only` marker, so deleting it from a module that holds a secret
// would make that module invisible to it. This second guard ties the marker to what the module does:
// any module under src/lib or src/mcp that reads a server secret must START with `import 'server-only'`.
const SERVER_SECRET_ENV = new Set([
  'SUPABASE_SERVICE_ROLE_KEY',
  'META_ACCESS_TOKEN', 'META_CAPI_ACCESS_TOKEN', 'META_APP_SECRET',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  // AI gateway credentials (src/lib/ai): Claude API token, Microsoft Foundry, OpenAI-compatible servers.
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_API_KEY', 'OPENAI_COMPATIBLE_API_KEY',
  'CRON_SECRET', 'PAID_TOUCH_TOKEN_SECRET', 'PAID_TOUCH_TOKEN_PREVIOUS_SECRET',
  'ACUITY_API_KEY', 'ACUITY_WEBHOOK_SECRET',
  'GA4_SERVICE_ACCOUNT_JSON',
  'GMAIL_SMTP_USER', 'GMAIL_SMTP_APP_PASSWORD', 'RESEND_API_KEY',
  'CREATIFY_API_KEY',
  'SENTRY_AUTH_TOKEN',
])
// A name with this shape read from the environment is treated as a secret and must be listed above.
const SECRET_SHAPED = /(?:SECRET|_KEY|TOKEN|PASSWORD|_JSON)$/
// Known violations, each owned outside this test's change (src/mcp). The exactness assertion below
// fails as soon as one is fixed, so the entry must then be deleted rather than left as a blind spot.
const KNOWN_UNMARKED_SECRET_READERS: string[] = []

function sourceFile(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

/**
 * Env names read as `process.env.X`, `process.env['X']`, through an alias of the environment record
 * (`vars.X`, `vars['X']`, the injected `env.X`), or by destructuring it (`const { X, Y: y } = process.env`).
 * The detector is shared with tests/env-schema-population.test.ts (tests/helpers/env-reads.ts).
 */
const envNamesRead = (file: string): Set<string> => envReadsOf(file).all

/**
 * Secret names a module touches: any `.NAME` access (including through an alias of process.env),
 * `['NAME']` access, exact 'NAME' literal (key lists), or destructured `{ NAME }` / `{ NAME: x }` key.
 */
function secretsReferenced(file: string): string[] {
  const found = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && SERVER_SECRET_ENV.has(node.name.text)) found.add(node.name.text)
    if (ts.isBindingElement(node)) {
      const key = bindingKey(node)
      if (key && SERVER_SECRET_ENV.has(key)) found.add(key)
    }
    if (ts.isStringLiteralLike(node) && SERVER_SECRET_ENV.has(node.text)) found.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile(file))
  return [...found].sort()
}

function startsWithServerOnly(file: string): boolean {
  const first = sourceFile(file).statements[0]
  return !!first && ts.isImportDeclaration(first) && !first.importClause
    && ts.isStringLiteral(first.moduleSpecifier) && first.moduleSpecifier.text === 'server-only'
}

/** Files (relative to `base`) that reference a server secret without starting with the marker. */
export function unmarkedSecretReaders(files: string[], base: string): string[] {
  return files
    .filter((file) => secretsReferenced(file).length > 0 && !startsWithServerOnly(file))
    .map((file) => path.relative(base, file))
    .sort()
}

const secretScope = [...listSourceFiles(path.join(SRC, 'lib')), ...listSourceFiles(path.join(SRC, 'mcp'))]

describe('server secrets are only read by server-only modules', () => {
  it('derives the secret names actually read under src/lib and src/mcp, and every secret-shaped name is listed', () => {
    const read = new Set(secretScope.flatMap((file) => [...envNamesRead(file)]))
    const secretsRead = [...read].filter((name) => SERVER_SECRET_ENV.has(name)).sort()
    console.info(`server secrets read under src/lib + src/mcp (${secretsRead.length}): ${secretsRead.join(', ')}`)
    expect(secretsRead.length).toBeGreaterThan(10)
    const unlisted = [...read].filter((name) => !name.startsWith('NEXT_PUBLIC_') && SECRET_SHAPED.test(name)
      && !SERVER_SECRET_ENV.has(name))
    expect(unlisted, 'secret-shaped env names missing from SERVER_SECRET_ENV').toEqual([])
  })

  it('every module that reads a server secret starts with import \'server-only\' (known violations exact)', () => {
    const readers = secretScope.filter((file) => secretsReferenced(file).length > 0)
    console.info(`modules reading a server secret: ${readers.length}`)
    expect(readers.length).toBeGreaterThan(15)
    expect(unmarkedSecretReaders(secretScope, ROOT)).toEqual(KNOWN_UNMARKED_SECRET_READERS)
  })

  it('control: a planted module that reads a secret without the marker is reported; marked and public ones are not', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'secret-marker-'))
    try {
      const plant = (name: string, body: string) => {
        const file = path.join(dir, name)
        writeFileSync(file, body)
        return file
      }
      const files = [
        plant('unmarked.ts', "export const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY\n"),
        plant('unmarked-element.ts', "export const key = () => process.env['META_APP_SECRET']\n"),
        plant('unmarked-injected.ts', "export const f = (env = process.env) => env.CRON_SECRET\n"),
        plant('unmarked-late.ts', "import { x } from './y'\nimport 'server-only'\nexport const k = process.env.OPENAI_API_KEY ?? x\n"),
        plant('marked.ts', "import 'server-only'\nexport const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY\n"),
        plant('public.ts', "export const url = process.env.NEXT_PUBLIC_SUPABASE_URL\n"),
        plant('unmarked-destructured.ts', "const { CRON_SECRET } = process.env\nexport const k = CRON_SECRET\n"),
        plant('unmarked-renamed.ts', "const { META_APP_SECRET: appSecret } = process.env\nexport const k = appSecret\n"),
        plant('unmarked-alias.ts', "const vars = process.env\nexport const k = () => vars.ACUITY_API_KEY\n"),
        plant('marked-destructured.ts', "import 'server-only'\nconst { CRON_SECRET } = process.env\nexport const k = CRON_SECRET\n"),
        plant('public-destructured.ts', "const { NEXT_PUBLIC_SUPABASE_URL: url } = process.env\nexport { url }\n"),
      ]
      expect(unmarkedSecretReaders(files, dir)).toEqual([
        'unmarked-alias.ts', 'unmarked-destructured.ts', 'unmarked-element.ts', 'unmarked-injected.ts',
        'unmarked-late.ts', 'unmarked-renamed.ts', 'unmarked.ts',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('control: env names are read through destructuring and through an alias of process.env', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'env-names-'))
    try {
      const file = path.join(dir, 'reader.ts')
      writeFileSync(file, [
        'const vars = process.env',
        'export const a = vars.VENDOR_ONE_TOKEN',
        "export const b = vars['VENDOR_TWO_SECRET']",
        'const { VENDOR_THREE_API_KEY, VENDOR_FOUR_PASSWORD: four } = process.env',
        'const { VENDOR_FIVE_JSON: five } = vars',
        'export const c = (input = process.env) => input.VENDOR_SIX_TOKEN',
        'export const d = [VENDOR_THREE_API_KEY, four, five]',
        'const other = { NOT_ENV_SECRET: 1 }',
        'export const e = other.NOT_ENV_SECRET',
        '',
      ].join('\n'))
      expect([...envNamesRead(file)].sort()).toEqual([
        'VENDOR_FIVE_JSON', 'VENDOR_FOUR_PASSWORD', 'VENDOR_ONE_TOKEN', 'VENDOR_SIX_TOKEN',
        'VENDOR_THREE_API_KEY', 'VENDOR_TWO_SECRET',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
