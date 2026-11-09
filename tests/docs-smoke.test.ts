import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ENV_VARS } from '@/config/env'
import { DOCTOR_USAGE, runDoctor } from '../scripts/lib/doctor-cli'
import { SETUP_USAGE, runSetup } from '../scripts/lib/setup-flow'
import {
  SHELL_LANGS, extractCodeBlocks, markdownIn, proseProblems, splitShell, validateCommand,
  type CommandResult, type ShellCommand, type SmokeContext,
} from './helpers/doc-smoke'

// Release plan Acceptance: "every command in the docs runs in CI (docs smoke test); every env var
// documented and validated". This file runs in `npm test`, so it is part of `npm run gate` and of the
// CI `verify` job.
//
// - Every shell command in a ```bash/```sh/```shell block of the repository's documentation is split and
//   classified (tests/helpers/doc-smoke.ts). Repository commands are checked against package.json and
//   the tree; `npm run setup` and `npm run doctor` invocations are executed through the real CLI
//   argument parsers with injected fakes and `--offline` (no network, no file writes); commands that
//   need a service are checked statically (app routes exist, the clone URL is this repository).
// - Every variable-shaped name in the documents exists in src/config/env.ts (or is a development
//   variable listed in docs/configuration.md); every variable the app requires is named in
//   docs/install.md.
// - Relative links, repository paths and /api routes named in the documents exist.
// Each check has a planted control that it must reject.

const ROOT = path.resolve(__dirname, '..')
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; repository: { url: string } }

/** Documents whose shell blocks are commands a reader may run. Excludes dated plans, research notes and
 *  the vendored knowledge corpus, which are records, not instructions. */
function shellDocs(): string[] {
  const walk = (dir: string): string[] => readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir === '.' ? e.name : `${dir}/${e.name}`
    if (e.isDirectory()) {
      return ['node_modules', '.git', '.next', 'docs/plans', 'docs/research', 'docs/meta-knowledge'].includes(rel) || e.name.startsWith('.')
        ? [] : walk(rel)
    }
    return e.name.endsWith('.md') ? [rel] : []
  })
  return walk('.').sort()
}

/** User-facing documents whose prose (variables, links, paths, routes) is checked. ADRs are dated
 *  decision records and stay as written. */
const PROSE_DOCS = [
  'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
  ...markdownIn(ROOT, 'docs'), 'docs/architecture/overview.md',
]

function devPrefixes(): string[] {
  const doc = read('docs/configuration.md')
  const section = doc.slice(doc.indexOf('## Development and test variables'))
  return [...section.matchAll(/`([A-Z0-9_]+)(\*)?`/g)].map((m) => m[1])
}

function knownCodes(): Set<string> {
  const codes = new Set<string>()
  const walk = (dir: string): string[] => readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : [])
  const pattern = /(?:code:\s*|reject\(\s*\d{3}\s*,\s*|apiErrorResponse\(\s*[A-Za-z_'"/[\] .]+,\s*|CsvImportError\(\s*)'([A-Z][A-Z0-9_]+)'/g
  for (const file of [...walk('src/app/api'), ...walk('src/lib')]) {
    for (const match of read(file).matchAll(pattern)) codes.add(match[1])
  }
  return codes
}

function optionsOf(usage: string): string[] {
  return [...usage.matchAll(/^\s+(--[a-z-]+=?)/gm)].map((m) => m[1])
}

function flagCheck(script: string, allowed: string[], valued: string[] = []) {
  return (args: string[]): string | null => {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (valued.includes(arg)) { i++; continue }
      if (!allowed.some((a) => (a.endsWith('=') ? arg.startsWith(a) : arg === a))) return `\`npm run ${script}\` has no option \`${arg}\``
    }
    return null
  }
}

const ctx: SmokeContext = {
  root: ROOT,
  packageScripts: pkg.scripts,
  repositoryUrl: pkg.repository.url.replace(/\.git$/, ''),
  envNames: new Set(ENV_VARS.map((s) => s.name)),
  devPrefixes: devPrefixes(),
  envFirstSegments: new Set(ENV_VARS.filter((s) => s.name.includes('_')).map((s) => s.name.split('_')[0])),
  knownCodes: knownCodes(),
  scriptArgs: {
    setup: flagCheck('setup', [...optionsOf(SETUP_USAGE), '-y']),
    doctor: flagCheck('doctor', optionsOf(DOCTOR_USAGE)),
    demo: flagCheck('demo', [], ['--port']),
    'demo:check': flagCheck('demo:check', ['--no-browser'], ['--port']),
  },
}

function allCommands(files: string[], readFile: (f: string) => string = read): ShellCommand[] {
  return files.flatMap((file) => extractCodeBlocks(readFile(file), file)
    .filter((b) => SHELL_LANGS.has(b.lang))
    .flatMap((b) => splitShell(b)))
}

const describeProblem = (r: CommandResult) => `${r.command.file}:${r.command.line} \`${r.command.text}\`: ${r.problems.join('; ')}`

/** Runs `npm run setup|doctor -- <args>` offline through the real argument parser; exit 2 is a usage error. */
async function dryRun(script: 'setup' | 'doctor', args: string[]): Promise<number> {
  const quiet = () => {}
  const offline = async () => { throw new Error('network is not available in the docs smoke test') }
  if (script === 'doctor') {
    return runDoctor([...args.filter((a) => a !== '--offline'), '--offline'], {
      env: {}, readEnvFile: () => null, envFilePath: '.env.local', fetch: offline as typeof fetch,
      nodeVersion: 'v24.0.0', stdout: quiet, stderr: quiet,
    })
  }
  return runSetup([...args.filter((a) => a !== '--offline'), '--offline'], {
    envFilePath: '.env.test-docs-smoke', env: {}, interactive: false, prompt: async () => '',
    store: { read: () => null, write: quiet, renderUpdate: () => '' },
    fetch: offline as typeof fetch, runCommand: async () => ({ code: 0 }), randomHex: (n) => '0'.repeat(n * 2),
    stdout: quiet, stderr: quiet, nodeVersion: 'v24.0.0',
  })
}

describe('docs smoke test: shell commands', () => {
  const commands = allCommands(shellDocs())
  const results = commands.map((c) => validateCommand(c, ctx))

  it('finds the documented commands (known-present control)', () => {
    const texts = commands.map((c) => c.text)
    expect(texts).toContain('npm run demo')
    expect(texts).toContain('npm run setup')
    expect(texts).toContain('npm run doctor')
    expect(commands.length).toBeGreaterThan(30)
  })

  it('every command is classified and refers only to scripts, files, routes and variables that exist', () => {
    expect(results.filter((r) => r.problems.length > 0).map(describeProblem)).toEqual([])
  })

  it('every documented setup and doctor invocation parses through the real CLI (offline dry run)', async () => {
    const runs = commands.filter((c) => c.words[0] === 'npm' && c.words[1] === 'run' && (c.words[2] === 'setup' || c.words[2] === 'doctor'))
    expect(runs.length).toBeGreaterThanOrEqual(4)
    for (const c of runs) {
      const sep = c.words.indexOf('--')
      const code = await dryRun(c.words[2] as 'setup' | 'doctor', sep >= 0 ? c.words.slice(sep + 1) : [])
      expect(code, `${c.file}:${c.line} ${c.text}`).not.toBe(2)
    }
  })

  it('control: the dry run rejects an option the CLI does not have', async () => {
    expect(await dryRun('doctor', ['--verbose'])).toBe(2)
    expect(await dryRun('setup', ['--force'])).toBe(2)
  })

  it('controls: planted bad commands are each rejected', () => {
    const planted = [
      '```bash',
      'npm run does-not-exist',
      'npm run doctor -- --verbose',
      'npm run demo -- --colour',
      'npx tsx --tsconfig tsconfig.scripts.json scripts/no-such-script.ts',
      'node scripts/missing.mjs',
      'META_ACCES_TOKEN=x npm run dev',
      'curl -H "Authorization: Bearer $CRON_SECRETS" https://maxx.example.com/api/cron/daily-sync',
      'curl https://maxx.example.com/api/no-such-route',
      'git clone https://github.com/someone-else/maxx.git',
      'make install',
      '```',
    ].join('\n')
    const planted2 = allCommands(['planted.md'], () => planted).map((c) => validateCommand(c, ctx))
    expect(planted2.map((r) => r.problems.length > 0)).toEqual(planted2.map(() => true))
    expect(planted2).toHaveLength(10)
  })

  it('control: a correct planted block passes', () => {
    const good = [
      '```sh',
      'SUPABASE_DB_URL="<connection string>" npm run setup -- --apply-schema  # comment',
      'npx tsx --tsconfig tsconfig.scripts.json scripts/manual-sync.ts && npm run doctor -- --only=supabase,meta',
      'curl -sS -H "Authorization: Bearer $CRON_SECRET" https://maxx.example.com/api/outcomes/webhook/<source-id>',
      'T=$(date +%s); echo "$T"',
      '```',
    ].join('\n')
    const results = allCommands(['good.md'], () => good).map((c) => validateCommand(c, ctx))
    expect(results.flatMap((r) => r.problems)).toEqual([])
    expect(results.map((r) => r.kind)).toEqual(['repo', 'repo', 'repo', 'external', 'shell', 'shell'])
  })
})

describe('docs smoke test: variables, links, paths and routes in the documents', () => {
  it('every variable, link, repository path and API route the documents name exists', () => {
    expect(PROSE_DOCS.flatMap((file) => proseProblems(read(file), file, ctx))).toEqual([])
  })

  it('docs/install.md names every variable the app requires', () => {
    const install = read('docs/install.md')
    const required = ENV_VARS.filter((s) => ['required', 'production', 'dashboard'].includes(s.required.kind)).map((s) => s.name)
    expect(required.length).toBeGreaterThanOrEqual(7)
    expect(required.filter((name) => !install.includes(`\`${name}\``))).toEqual([])
  })

  it('controls: planted prose problems are each rejected', () => {
    const planted = [
      'Set `META_ACCESS_TOKENS` before the first sync.',
      'See [the guide](docs/no-such-file.md).',
      'The handler lives in `src/lib/outcomes/no-such-module.ts`.',
      'Send it to `POST /api/outcomes/no-such-route`.',
      'All `PAID_TOUCHES_*` values are optional.',
      'Point Acuity at `https://<your-domain>/api/webhooks/acuityx`.',
    ]
    for (const line of planted) expect(proseProblems(line, 'README.md', ctx), line).not.toEqual([])
  })

  it('control: correct prose passes', () => {
    const good = 'Set `CRON_SECRET` and the `PAID_TOUCH_*` values; `SB_DB_URL` is for tests. See [setup](docs/install.md), '
      + '`src/lib/outcomes/registry.ts`, `POST /api/outcomes/webhook/<source-id>` and `RATE_LIMITED`.'
    expect(proseProblems(good, 'README.md', ctx)).toEqual([])
  })
})
