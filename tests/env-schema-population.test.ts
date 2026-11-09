import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ENV_VARS, envSpec } from '@/config/env'
import type { EnvVarSpec } from '@/config/env-spec'
import { envReads, listSources, upperSnakeLiterals } from './helpers/env-reads'

// Acceptance for src/config/env.ts: ONE schema lists every environment variable the app, the
// scripts and the MCP server read. Population: every TS/JS file under src/ and scripts/ plus
// next.config.ts. Each control below plants the bad case and requires it to be reported.

const ROOT = path.resolve(__dirname, '..')
const SCAN = ['src', 'scripts', 'next.config.ts']
const rel = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/')

/** Files that read `process.env[expression]`, and the names those expressions can take. */
const DYNAMIC_READS: Record<string, string[]> = {
  'src/app/api/cron/daily-sync/route.ts': ['MAXX_DAILY_EXECUTIVE_EMAIL_ENABLED', 'MAXX_WEEKLY_EXECUTIVE_EMAIL_ENABLED'],
  'src/mcp/server.ts': ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  'src/mcp/env.ts': ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WRITE_MODE_ENABLED', 'GA4_SERVICE_ACCOUNT_JSON',
    'GA4_PROPERTY_ID', 'META_ACCESS_TOKEN', 'META_APP_SECRET', 'ENABLE_MEDIA_BUYER_RECOMMENDATIONS'],
  'scripts/eval-maxx.ts': ['MAXX_CHAT_ENABLED', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
}

interface Inventory { unknown: string[]; unregisteredDynamic: string[]; staleDynamic: string[]; registeredNotLiteral: string[] }

function inventory(root: string, scan: string[], known: (name: string) => boolean, registry: Record<string, string[]>): Inventory {
  const files = scan.flatMap((entry) => listSources(path.join(root, entry)))
  const unknown = new Set<string>()
  const unregisteredDynamic: string[] = []
  const dynamicFiles = new Set<string>()
  for (const file of files) {
    const reads = envReads(file)
    const name = rel(root, file)
    for (const read of reads.names) if (!known(read)) unknown.add(`${read} (${name})`)
    if (reads.dynamic.length > 0) {
      dynamicFiles.add(name)
      if (!registry[name]) unregisteredDynamic.push(`${name}:${reads.dynamic.join(',')}`)
    }
  }
  const staleDynamic = Object.keys(registry).filter((file) => !dynamicFiles.has(file))
  const registeredNotLiteral = Object.entries(registry).flatMap(([file, names]) => {
    if (!dynamicFiles.has(file)) return []
    const literals = upperSnakeLiterals(path.join(root, file))
    return names.filter((n) => !literals.has(n)).map((n) => `${n} (${file})`)
  })
  return { unknown: [...unknown].sort(), unregisteredDynamic, staleDynamic, registeredNotLiteral }
}

const SECRET_SHAPED = /(?:SECRET|_KEY|TOKEN|PASSWORD|_JSON)$/
/** Secret-shaped names that are deliberately not secret, with the reason. */
const NOT_SECRET: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'publishable by design; the anon role holds no privilege',
  BUSINESS_PROFILE_JSON: 'business facts shown in prompts and the UI',
}

function secretViolations(specs: readonly EnvVarSpec[]): string[] {
  return specs.flatMap((spec) => {
    const out: string[] = []
    const prefixed = spec.name.startsWith('NEXT_PUBLIC_')
    if (spec.public !== prefixed) out.push(`${spec.name}: public flag disagrees with the NEXT_PUBLIC_ prefix`)
    if (spec.secret && prefixed) out.push(`${spec.name}: a secret must never be NEXT_PUBLIC_`)
    if (SECRET_SHAPED.test(spec.name) && !spec.secret && !NOT_SECRET[spec.name]) out.push(`${spec.name}: secret-shaped name is not marked secret`)
    return out
  })
}

const temp = mkdtempSync(path.join(tmpdir(), 'maxx-env-pop-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))
const plant = (name: string, body: string) => writeFileSync(path.join(temp, name), body)

describe('environment schema population', () => {
  it('control: the scan sees known reads in the real tree', () => {
    const reads = envReads(path.join(ROOT, 'src/lib/auth/owner.ts')).names
    expect([...reads]).toEqual(expect.arrayContaining(['OWNER_EMAIL', 'OWNER_USER_ID', 'NODE_ENV']))
    expect(listSources(path.join(ROOT, 'src')).length).toBeGreaterThan(500)
  })

  it('control: planted unknown, destructured, aliased and dynamic reads are all reported', () => {
    plant('a.ts', 'export const a = process.env.PLANTED_DOTTED_VAR\n')
    plant('b.ts', "const { PLANTED_DESTRUCTURED: x } = process.env\nexport const b = x\n")
    plant('c.ts', "const vars = process.env\nexport const c = vars['PLANTED_ELEMENT']\n")
    plant('d.ts', "const key = 'PLANTED_DYNAMIC'\nexport const d = process.env[key]\n")
    plant('e.ts', 'export const e = process.env.OWNER_EMAIL\n')
    const result = inventory(temp, ['.'], (n) => envSpec(n) !== undefined, {})
    expect(result.unknown).toEqual(['PLANTED_DESTRUCTURED (b.ts)', 'PLANTED_DOTTED_VAR (a.ts)', 'PLANTED_ELEMENT (c.ts)'])
    expect(result.unregisteredDynamic).toEqual(['d.ts:2'])
    // A registered dynamic read must name literals present in the file, and a stale entry is reported.
    const registered = inventory(temp, ['.'], () => true, { 'd.ts': ['PLANTED_DYNAMIC', 'PLANTED_ABSENT'], 'gone.ts': ['X_Y'] })
    expect(registered.unregisteredDynamic).toEqual([])
    expect(registered.registeredNotLiteral).toEqual(['PLANTED_ABSENT (d.ts)'])
    expect(registered.staleDynamic).toEqual(['gone.ts'])
  })

  it('every environment name read in src/, scripts/ and next.config.ts is in the schema', () => {
    const result = inventory(ROOT, SCAN, (n) => envSpec(n) !== undefined, DYNAMIC_READS)
    expect(result.unknown, 'add these to src/config/env-vars-*.ts').toEqual([])
    expect(result.unregisteredDynamic, 'register the names each dynamic read can take').toEqual([])
    expect(result.staleDynamic).toEqual([])
    expect(result.registeredNotLiteral).toEqual([])
    const dynamicNames = Object.values(DYNAMIC_READS).flat()
    expect(dynamicNames.filter((n) => envSpec(n) === undefined)).toEqual([])
  })

  it('names are unique and every spec is complete', () => {
    const names = ENV_VARS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    for (const spec of ENV_VARS) {
      expect(spec.description.length, spec.name).toBeGreaterThan(10)
      expect(spec.format.hint.length, spec.name).toBeGreaterThan(2)
      if (spec.setup === 'ask') expect(spec.prompt, spec.name).toBeTruthy()
      if (spec.default !== undefined) expect(spec.format.schema.safeParse(spec.default).success, `${spec.name} default`).toBe(true)
      if (spec.example !== undefined) expect(spec.format.schema.safeParse(spec.example).success, `${spec.name} example`).toBe(true)
      if (spec.secret) expect(spec.example, `${spec.name} must not carry an example value`).toBeUndefined()
    }
  })
})

describe('secrets are never public', () => {
  it('control: a secret NEXT_PUBLIC_ spec and an unmarked secret-shaped name are reported', () => {
    const base = ENV_VARS[0]
    const planted: EnvVarSpec[] = [
      { ...base, name: 'NEXT_PUBLIC_PLANTED_SECRET', public: true, secret: true },
      { ...base, name: 'PLANTED_API_KEY', public: false, secret: false },
      { ...base, name: 'NEXT_PUBLIC_PLANTED_FLAG', public: false, secret: false },
    ]
    expect(secretViolations(planted)).toEqual([
      'NEXT_PUBLIC_PLANTED_SECRET: a secret must never be NEXT_PUBLIC_',
      'PLANTED_API_KEY: secret-shaped name is not marked secret',
      'NEXT_PUBLIC_PLANTED_FLAG: public flag disagrees with the NEXT_PUBLIC_ prefix',
    ])
  })

  it('no secret in the schema is NEXT_PUBLIC_, and every secret-shaped name is secret', () => {
    expect(secretViolations(ENV_VARS)).toEqual([])
    expect(ENV_VARS.filter((s) => s.secret).length).toBeGreaterThan(15)
    expect(envSpec('SUPABASE_SERVICE_ROLE_KEY')?.secret).toBe(true)
    expect(envSpec('NEXT_PUBLIC_SUPABASE_URL')?.public).toBe(true)
  })
})
