import { ENV_VARS, envValue, type EnvRecord, type EnvVarSpec } from '../../src/config/env'
import { parseDotenv } from '../../src/mcp/env'

// The steps of `npm run setup` that talk to the user or to Supabase. Messages name variables, never
// values; secret prompts use hidden input.

export interface PromptFn { (question: string, options: { secret: boolean }): Promise<string> }

export interface CollectContext {
  current: Record<string, string>
  preAnswers: EnvRecord
  interactive: boolean
  prompt: PromptFn
  say: (line: string) => void
  /** Values already supplied (the local stack's URL and keys): taken as they are, never asked. */
  supplied?: Record<string, string>
}

const MAX_ATTEMPTS = 3
export const ASKED: readonly EnvVarSpec[] = ENV_VARS.filter((spec) => spec.setup === 'ask')
/** Without these nobody can sign in (Supabase, OWNER_EMAIL): setup does not finish without them. */
const REQUIRED_AT_SETUP = new Set(ASKED.filter((spec) => spec.required.kind === 'required').map((spec) => spec.name))

/** What Enter does at a prompt, by how much the app needs the value. */
function promptSuffix(spec: EnvVarSpec, existing: string | undefined): string {
  if (existing) return ' [set; Enter keeps it]'
  if (REQUIRED_AT_SETUP.has(spec.name)) return ''
  // The dashboard and the outcome pages read the Meta ad account; Enter leaves the checklist open.
  if (spec.required.kind === 'dashboard') return ' [the dashboard needs it; Enter to add it later]'
  return ' [optional; Enter skips]'
}
export const GENERATED: readonly EnvVarSpec[] = ENV_VARS.filter((spec) => spec.setup === 'generate')

const valid = (spec: EnvVarSpec, value: string) => spec.format.schema.safeParse(value).success
const invalidMessage = (spec: EnvVarSpec) => `${spec.name} must be ${spec.format.hint}.`

/**
 * Prompts that only make sense after an earlier answer. The Claude key belongs to the Anthropic
 * provider; it is asked when that provider is chosen, or kept when a key is already set.
 */
const ASK_WHEN: Readonly<Record<string, (values: Record<string, string>) => boolean>> = {
  ANTHROPIC_API_KEY: (values) => values.AI_PROVIDER === 'anthropic' || Boolean(values.ANTHROPIC_API_KEY),
}

export interface Collected {
  updates: Record<string, string>
  problems: string[]
  /** Variables a problem already names, so a later check does not report them again. */
  reported: string[]
}

/** Ask (or take pre-answered) values. Returns the updates and the problems that remain. */
export async function collectValues(ctx: CollectContext): Promise<Collected> {
  const updates: Record<string, string> = {}
  const problems: string[] = []
  const reported: string[] = []
  const missing = (name: string, message: string) => { problems.push(message); reported.push(name) }
  for (const spec of ASKED) {
    const supplied = ctx.supplied?.[spec.name]
    if (supplied !== undefined) {
      if (supplied !== ctx.current[spec.name]) updates[spec.name] = supplied
      continue
    }
    const existing = ctx.current[spec.name]
    const pre = envValue(ctx.preAnswers, spec.name)
    if (!ctx.interactive) {
      if (pre !== undefined && pre !== existing) {
        if (valid(spec, pre)) updates[spec.name] = pre
        else missing(spec.name, invalidMessage(spec))
      }
      if (pre === undefined && !existing && REQUIRED_AT_SETUP.has(spec.name)) missing(spec.name, `${spec.name} is not set: export it before running setup non-interactively.`)
      continue
    }
    if (ASK_WHEN[spec.name] && !ASK_WHEN[spec.name]({ ...ctx.current, ...updates })) continue
    let accepted: string | undefined
    for (let attempt = 0; attempt < MAX_ATTEMPTS && accepted === undefined; attempt++) {
      const answer = (await ctx.prompt(`${spec.prompt ?? spec.name}${promptSuffix(spec, existing)}: `, { secret: spec.secret })).trim()
      if (answer === '') {
        if (existing || !REQUIRED_AT_SETUP.has(spec.name)) break
        ctx.say(`  ${spec.name} is required.`)
        continue
      }
      if (valid(spec, answer)) accepted = answer
      else ctx.say(`  ${invalidMessage(spec)}`)
    }
    if (accepted !== undefined && accepted !== existing) updates[spec.name] = accepted
    if (accepted === undefined && !existing && REQUIRED_AT_SETUP.has(spec.name)) missing(spec.name, `${spec.name} is not set.`)
  }
  return { updates, problems, reported }
}

/** Internal secrets setup generates itself (cron, paid-touch token): only when absent. */
export function generateSecrets(current: Record<string, string>, randomHex: (bytes: number) => string): Record<string, string> {
  const updates: Record<string, string> = {}
  for (const spec of GENERATED) if (!current[spec.name]) updates[spec.name] = randomHex(32)
  return updates
}

interface AuthUser { id?: string; email?: string; email_confirmed_at?: string | null }

export type OwnerOutcome =
  | { ok: true; id: string; created: boolean; confirmed: boolean }
  | { ok: false; reason: string }

/** Create the owner (confirmed, no password: sign-in is by magic link) or find the existing one. */
export async function ensureOwner(env: EnvRecord, fetchFn: typeof fetch): Promise<OwnerOutcome> {
  const base = envValue(env, 'NEXT_PUBLIC_SUPABASE_URL')?.replace(/\/+$/, '')
  const key = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY')
  const email = envValue(env, 'OWNER_EMAIL')?.toLowerCase()
  if (!base || !key || !email) return { ok: false, reason: 'OWNER_EMAIL and the Supabase values are needed to create the owner.' }
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const signal = () => AbortSignal.timeout(8_000)
  try {
    const created = await fetchFn(`${base}/auth/v1/admin/users`, { method: 'POST', headers, body: JSON.stringify({ email, email_confirm: true }), signal: signal() })
    if (created.ok) {
      const user = await created.json() as AuthUser
      if (user.id) return { ok: true, id: user.id, created: true, confirmed: Boolean(user.email_confirmed_at) }
    }
    const listed = await fetchFn(`${base}/auth/v1/admin/users?page=1&per_page=1000`, { headers, signal: signal() })
    const users = listed.ok ? ((await listed.json()) as { users?: AuthUser[] }).users ?? [] : []
    const owner = users.find((u) => u.email?.trim().toLowerCase() === email)
    if (owner?.id) return { ok: true, id: owner.id, created: false, confirmed: Boolean(owner.email_confirmed_at) }
    return { ok: false, reason: `Supabase refused to create the owner (HTTP ${created.status}).` }
  } catch {
    return { ok: false, reason: 'Supabase Auth could not be reached.' }
  }
}

/**
 * Runs a command. `env` adds values (a password) to the child's environment only; `capture` returns
 * its standard output instead of showing it (used for values that must not reach the terminal).
 */
export type RunCommand = (command: string, args: string[], options?: { env?: Record<string, string>; capture?: boolean }) => Promise<{ code: number; stdout?: string }>

/**
 * The Supabase CLI. scripts/sb.sh is the one place that pins its version (`npx --yes supabase@<pin>`,
 * fetched on first use, no global install) and runs it outside the project root, so the CLI never
 * reads .env.local.
 */
export const SUPABASE_CLI: readonly [string, ...string[]] = ['bash', 'scripts/sb.sh']

/** `scripts/sb.sh status -o env` names → the variables the app reads. */
const LOCAL_STATUS_KEYS: Readonly<Record<string, string>> = {
  API_URL: 'NEXT_PUBLIC_SUPABASE_URL', ANON_KEY: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', SERVICE_ROLE_KEY: 'SUPABASE_SERVICE_ROLE_KEY',
}

export const LOCAL_KEYS_FALLBACK = 'Run `bash scripts/sb.sh status -o env` and copy API_URL → NEXT_PUBLIC_SUPABASE_URL, '
  + 'ANON_KEY → NEXT_PUBLIC_SUPABASE_ANON_KEY and SERVICE_ROLE_KEY → SUPABASE_SERVICE_ROLE_KEY into .env.local.'

/** The running local stack's URL and keys, read from the CLI's status output (the keys are never
 *  printed), and its Mailpit inbox URL when the CLI reports one. */
export async function readLocalSupabase(runCommand: RunCommand): Promise<{ ok: true; values: Record<string, string>; mailpitUrl: string | null } | { ok: false; reason: string }> {
  const [command, ...prefix] = SUPABASE_CLI
  const status = await runCommand(command, [...prefix, 'status', '-o', 'env'], { capture: true }).catch(() => ({ code: 127, stdout: '' }))
  const parsed = status.code === 0 ? parseDotenv(status.stdout ?? '') : {}
  const values: Record<string, string> = {}
  for (const [from, to] of Object.entries(LOCAL_STATUS_KEYS)) if (parsed[from]) values[to] = parsed[from]
  if (Object.keys(values).length !== Object.keys(LOCAL_STATUS_KEYS).length) {
    return { ok: false, reason: `The local Supabase URL and keys could not be read. ${LOCAL_KEYS_FALLBACK}` }
  }
  const mailpit = parsed.MAILPIT_URL ?? parsed.INBUCKET_URL
  return { ok: true, values, mailpitUrl: mailpit && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(mailpit) ? mailpit.replace(/\/$/, '') : null }
}

/** The URL without its password (user-info or `?password=`), and the decoded password; null when unparseable. */
function splitPassword(dbUrl: string): { url: string; password: string | null } | null {
  let url: URL
  try { url = new URL(dbUrl) } catch { return null }
  const fromQuery = url.searchParams.get('password')
  const password = url.password ? decodeURIComponent(url.password) : fromQuery
  url.password = ''
  url.searchParams.delete('password')
  return { url: url.toString(), password }
}

/**
 * `supabase db push --db-url …` applies supabase/migrations, through the pinned CLI (SUPABASE_CLI).
 * Every local user can read a process's arguments, so the password is not among them: it reaches the
 * CLI as PGPASSWORD in the child's environment, which the CLI's Postgres driver reads for a
 * password-less URL (checked with Supabase CLI 2.98.2; it does not read SUPABASE_DB_PASSWORD with
 * --db-url). The URL is never printed.
 */
export async function applySchema(dbUrl: string, runCommand: RunCommand): Promise<{ ok: boolean; reason?: string }> {
  const split = splitPassword(dbUrl)
  if (!split) return { ok: false, reason: 'SUPABASE_DB_URL is not a valid postgres:// connection string.' }
  const [command, ...prefix] = SUPABASE_CLI
  try {
    const { code } = await runCommand(command, [...prefix, 'db', 'push', '--db-url', split.url], split.password ? { env: { PGPASSWORD: split.password } } : undefined)
    return code === 0 ? { ok: true } : { ok: false, reason: `supabase db push exited with ${code}.` }
  } catch {
    return { ok: false, reason: 'The Supabase CLI could not be started (scripts/sb.sh runs it with npx; check Node.js and npm).' }
  }
}
