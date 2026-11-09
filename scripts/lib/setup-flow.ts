import { parseDotenv } from '../../src/mcp/env'
import { envValue, type EnvRecord } from '../../src/config/env'
import type { CheckResult, IntegrationId } from '../../src/lib/setup/types'
import { formatChecks } from './check-output'
import type { EnvFileStore } from './env-file'
import { applySchema, collectValues, ensureOwner, generateSecrets, readLocalSupabase, SUPABASE_CLI, type PromptFn, type RunCommand } from './setup-steps'

// `npm run setup`: interactive, re-runnable first-run configuration.
// It writes the env file (mode 600), generates internal secrets, asks only for what is needed and
// validates each external value with the shared checks, optionally applies the schema, creates the
// owner and pins OWNER_USER_ID. Non-interactive (CI, non-TTY, --yes) it takes answers from the
// environment and prints nothing unless something fails. It never prints a secret.

export const SETUP_USAGE = `Usage: npm run setup -- [options]
  --yes             non-interactive: take values from the environment (implied in CI and without a TTY)
  --apply-schema    apply supabase/migrations with \`supabase db push --db-url\` (SUPABASE_DB_URL; its password goes in PGPASSWORD, not the arguments)
  --offline         no network: skip validation and owner creation
  --live            also test the AI key with one minimal call
  --local           start a local Supabase stack first (Docker; applies every migration) and write its URL and keys
The Supabase CLI runs through scripts/sb.sh at a pinned version with npx: no global install needed.
Exit codes: 0 done, 1 something needs attention, 2 usage error.`

export interface SetupDeps {
  envFilePath: string
  /** Pre-answers (the process environment). */
  env: EnvRecord
  store: EnvFileStore
  interactive: boolean
  prompt: PromptFn
  fetch: typeof fetch
  runCommand: RunCommand
  randomHex: (bytes: number) => string
  stdout: (line: string) => void
  stderr: (line: string) => void
  nodeVersion: string
  aiProbe?: (env: EnvRecord) => Promise<string>
}

interface SetupArgs { yes: boolean; applySchema: boolean; offline: boolean; live: boolean; local: boolean }

function parseArgs(argv: string[]): SetupArgs | string {
  const args: SetupArgs = { yes: false, applySchema: false, offline: false, live: false, local: false }
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') args.yes = true
    else if (arg === '--apply-schema') args.applySchema = true
    else if (arg === '--offline') args.offline = true
    else if (arg === '--live') args.live = true
    else if (arg === '--local') args.local = true
    else return `unknown option: ${arg}`
  }
  return args
}

/** supabase/config.toml [local_smtp] port: the Mailpit inbox, when the CLI does not report its URL. */
const LOCAL_MAILPIT_URL = 'http://127.0.0.1:54324'

/** Integrations whose failure means the app cannot work at all. */
const BLOCKING: readonly IntegrationId[] = ['runtime', 'supabase', 'owner']

export async function runSetup(argv: string[], deps: SetupDeps): Promise<number> {
  const args = parseArgs(argv)
  if (typeof args === 'string') {
    deps.stderr(`${args}\n${SETUP_USAGE}`)
    return 2
  }
  const interactive = deps.interactive && !args.yes
  const say = (line: string) => { if (interactive) deps.stdout(line) }
  const problems: string[] = []

  let local: Record<string, string> | undefined
  let mailpit = LOCAL_MAILPIT_URL
  if (args.local) {
    const [command, ...prefix] = SUPABASE_CLI
    const started = await deps.runCommand(command, [...prefix, 'start']).catch(() => ({ code: 127 }))
    if (started.code !== 0) problems.push('The local Supabase stack did not start (it needs Docker running; scripts/sb.sh fetches the Supabase CLI with npx).')
    else {
      const read = await readLocalSupabase(deps.runCommand)
      if (read.ok) {
        local = read.values
        mailpit = read.mailpitUrl ?? LOCAL_MAILPIT_URL
        // Printed in every mode: the one line that says where the values went (names, never a key).
        deps.stdout(`Local Supabase is up: wrote NEXT_PUBLIC_SUPABASE_URL (${local.NEXT_PUBLIC_SUPABASE_URL}), NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY to ${deps.envFilePath}. Sign-in emails: Mailpit at ${mailpit}.`)
      } else problems.push(read.reason)
    }
  }
  const original = deps.store.read(deps.envFilePath) ?? ''
  const current = parseDotenv(original)
  say(`Maxx setup: writing ${deps.envFilePath} (mode 600). Press Enter to keep a value that is already set.`)
  const generated = generateSecrets(current, deps.randomHex)
  for (const name of Object.keys(generated)) say(`  generated ${name}`)
  const collected = await collectValues({ current, preAnswers: deps.env, interactive, prompt: deps.prompt, say, supplied: local })
  problems.push(...collected.problems)
  const values: Record<string, string> = { ...current, ...generated, ...collected.updates }
  const persist = (extra: Record<string, string> = {}) => {
    Object.assign(values, extra)
    const updates = { ...generated, ...collected.updates, ...extra }
    deps.store.write(deps.envFilePath, deps.store.renderUpdate(original, updates))
  }
  persist()

  const { runChecks } = await import('../../src/lib/setup/checks')
  const checkDeps = { fetch: deps.fetch, nodeVersion: deps.nodeVersion, aiProbe: deps.aiProbe }
  if (!args.offline) {
    const early = await runChecks(values, checkDeps, { only: ['supabase', 'meta', 'ai'], live: args.live })
    for (const line of formatChecks(early, false)) say(line)
  }

  // `scripts/sb.sh start` already applied every migration to a local stack.
  if (local) say('  schema applied by the local stack')
  else if (args.applySchema || (interactive && !args.offline && /^y/i.test(await deps.prompt('Apply the database schema now with the Supabase CLI? [y/N] ', { secret: false })))) {
    const dbUrl = envValue(deps.env, 'SUPABASE_DB_URL')
      ?? (interactive ? (await deps.prompt('Database connection string (Supabase → Project Settings → Database; not saved): ', { secret: true })).trim() : '')
    if (!dbUrl) problems.push('Applying the schema needs SUPABASE_DB_URL (the database connection string; it is never saved).')
    else {
      const applied = await applySchema(dbUrl, deps.runCommand)
      if (applied.ok) say('  schema applied (supabase db push)')
      else problems.push(applied.reason ?? 'supabase db push failed.')
    }
  } else say('  Schema: run `npm run setup -- --apply-schema` with SUPABASE_DB_URL (docs/install.md, step 3).')

  if (!args.offline && envValue(values, 'OWNER_EMAIL')) {
    const owner = await ensureOwner(values, deps.fetch)
    if (owner.ok) {
      if (values.OWNER_USER_ID !== owner.id) persist({ OWNER_USER_ID: owner.id })
      say(`  owner ${owner.created ? 'created' : 'found'}; OWNER_USER_ID recorded${owner.confirmed ? '' : ' (email NOT confirmed: confirm it in Supabase → Authentication → Users)'}`)
    } else problems.push(owner.reason)
  }

  let blocking: CheckResult[] = []
  if (!args.offline) {
    const final = await runChecks(values, checkDeps, {})
    blocking = final.checks.filter((c) => c.level === 'fail' && BLOCKING.includes(c.integration))
    if (interactive) for (const line of ['', 'Checks:', ...formatChecks(final, false)]) deps.stdout(line)
  }
  // A variable collectValues already named is not reported a second time by the schema check.
  const failures = [...problems, ...blocking.filter((c) => !collected.reported.includes(c.title))
    .map((c) => `${c.detail.startsWith(c.title) ? '' : `${c.title}: `}${c.detail}${c.fix ? ` → ${c.fix}` : ''}`)]
  if (failures.length > 0) {
    deps.stderr(`Setup needs attention:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
    return 1
  }
  const mail = local ? ` The sign-in link arrives in Mailpit at ${mailpit}.` : ''
  const meta = envValue(values, 'META_ACCESS_TOKEN') && envValue(values, 'META_AD_ACCOUNT_ID') ? ''
    : '\nThe dashboard and outcome pages need META_ACCESS_TOKEN and META_AD_ACCOUNT_ID (re-run npm run setup); until then the app opens the setup checklist.'
  say(`\nNext: npm run dev, then sign in at http://localhost:3000 with the owner email.${mail} Re-run npm run doctor any time.${meta}`)
  return 0
}
