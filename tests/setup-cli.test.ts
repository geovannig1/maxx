import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runSetup, type SetupDeps } from '../scripts/lib/setup-flow'
import { nodeEnvFileStore } from '../scripts/lib/env-file'
import { parseDotenv } from '../src/mcp/env'
import { OWNER_ID, fakeFetch, fakeState, type FakeCall } from './helpers/fake-services'

// `npm run setup`. Runs against offline fakes and a temp directory only: no real service, no
// real env file. Every external call goes through the injected fetch and command runner.

const SERVICE = 'service-role-planted-0123456789abcdef'
const META = 'EAAG-planted-meta-credential-0123456789'
const DB_URL = 'postgresql://postgres:planted-db-password@db.example.test:5432/postgres'
const ANSWERS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  OWNER_EMAIL: 'owner@example.test',
  META_ACCESS_TOKEN: META,
  META_AD_ACCOUNT_ID: 'act_123',
}

const root = mkdtempSync(path.join(tmpdir(), 'maxx-setup-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0

// What `scripts/sb.sh status -o env` prints for a local stack (fictional keys).
const LOCAL_ANON = 'eyJhbGciOiJIUzI1NiJ9.local-anon-planted-0123456789.sig'
const LOCAL_SERVICE = 'eyJhbGciOiJIUzI1NiJ9.local-service-planted-0123456789.sig'
const LOCAL_STATUS = `ANON_KEY="${LOCAL_ANON}"\nAPI_URL="http://127.0.0.1:54321"\nDB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"\nMAILPIT_URL="http://127.0.0.1:55324"\nSERVICE_ROLE_KEY="${LOCAL_SERVICE}"\n`

function harness(options: { env?: Record<string, string>; argv?: string[]; interactive?: boolean; prompts?: string[]; respond?: (question: string) => string; state?: ReturnType<typeof fakeState>; existing?: string } = {}) {
  const file = path.join(root, `case-${++n}`, 'fixture.local.env')
  const store = nodeEnvFileStore()
  if (options.existing !== undefined) {
    store.write(file, options.existing)
    chmodSync(file, 0o644)
  }
  const out: string[] = []
  const calls: FakeCall[] = []
  const commands: Array<{ command: string; args: string[]; env?: Record<string, string>; capture?: boolean }> = []
  const prompts = [...(options.prompts ?? [])]
  const asked: Array<{ question: string; secret: boolean }> = []
  let counter = 0
  const deps: SetupDeps = {
    envFilePath: file,
    env: options.env ?? {},
    store,
    interactive: options.interactive ?? false,
    prompt: async (question, opts) => { asked.push({ question, secret: opts.secret }); return options.respond ? options.respond(question) : prompts.shift() ?? '' },
    fetch: fakeFetch(options.state ?? fakeState({ users: [] }), calls),
    runCommand: async (command, args, options) => {
      commands.push({ command, args, ...(options?.env ? { env: options.env } : {}), ...(options?.capture ? { capture: true } : {}) })
      return options?.capture ? { code: 0, stdout: LOCAL_STATUS } : { code: 0 }
    },
    randomHex: (bytes) => (++counter).toString(16).padStart(bytes * 2, 'a'),
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
    nodeVersion: '24.1.0',
  }
  return { deps, file, out, calls, commands, asked, run: () => runSetup(options.argv ?? [], deps), read: () => parseDotenv(readFileSync(file, 'utf8')) }
}

describe('npm run setup, non-interactive (CI / non-TTY)', () => {
  it('writes the env file with mode 600, generated internal secrets and the pre-answered values', async () => {
    const h = harness({ env: ANSWERS })
    expect(await h.run()).toBe(0)
    expect(statSync(h.file).mode & 0o777).toBe(0o600)
    const written = h.read()
    for (const [key, value] of Object.entries(ANSWERS)) expect(written[key], key).toBe(value)
    expect(written.CRON_SECRET).toMatch(/^[0-9a-f]{64}$/)
    expect(written.PAID_TOUCH_TOKEN_SECRET).toMatch(/^[0-9a-f]{64}$/)
    expect(written.CRON_SECRET).not.toBe(written.PAID_TOUCH_TOKEN_SECRET)
  })

  it('is silent on success and never prints a secret', async () => {
    const h = harness({ env: ANSWERS })
    expect(await h.run()).toBe(0)
    expect(h.out).toEqual([])
    const failing = harness({ env: { ...ANSWERS, META_AD_ACCOUNT_ID: 'nope' } })
    expect(await failing.run()).toBe(1)
    const text = failing.out.join('\n')
    expect(text).toContain('META_AD_ACCOUNT_ID')
    for (const secret of [SERVICE, META, DB_URL]) expect(text).not.toContain(secret)
  })

  it('creates the owner and pins OWNER_USER_ID; an existing owner is found and pinned instead', async () => {
    const created = harness({ env: ANSWERS })
    await created.run()
    const post = created.calls.find((c) => c.method === 'POST' && c.url.endsWith('/auth/v1/admin/users'))
    expect(post?.headers.authorization).toBe(`Bearer ${SERVICE}`)
    expect(created.read().OWNER_USER_ID).toBe('22222222-2222-4333-8444-555555555555')
    const existing = harness({ env: ANSWERS, state: fakeState() })
    await existing.run()
    expect(existing.read().OWNER_USER_ID).toBe(OWNER_ID)
  })

  it('applies the schema with supabase db push only when asked, and never prints the database URL', async () => {
    const skipped = harness({ env: ANSWERS })
    await skipped.run()
    expect(skipped.commands).toEqual([])
    const applied = harness({ env: { ...ANSWERS, SUPABASE_DB_URL: DB_URL }, argv: ['--apply-schema'] })
    expect(await applied.run()).toBe(0)
    // the password never goes on the command line (any local user can list process arguments);
    // it reaches the CLI as PGPASSWORD in the child's environment.
    // through scripts/sb.sh, the one place that pins the Supabase CLI version (npx supabase@<pin>)
    expect(applied.commands).toEqual([{
      command: 'bash', args: ['scripts/sb.sh', 'db', 'push', '--db-url', 'postgresql://postgres@db.example.test:5432/postgres'],
      env: { PGPASSWORD: 'planted-db-password' },
    }])
    expect(JSON.stringify(applied.commands[0].args)).not.toContain('planted-db-password')
    expect(applied.read().SUPABASE_DB_URL).toBeUndefined()
    expect(applied.out.join('\n')).not.toContain(DB_URL)
    const missing = harness({ env: ANSWERS, argv: ['--apply-schema'] })
    expect(await missing.run()).toBe(1)
    expect(missing.out.join('\n')).toContain('SUPABASE_DB_URL')
  })

  it('--offline makes no request; an unknown option exits 2', async () => {
    const offline = harness({ env: ANSWERS, argv: ['--offline'] })
    expect(await offline.run()).toBe(0)
    expect(offline.calls).toEqual([])
    expect(await harness({ argv: ['--bogus'] }).run()).toBe(2)
  })

  it('fails when a required value is missing and names it', async () => {
    const h = harness({ env: { NEXT_PUBLIC_SUPABASE_URL: ANSWERS.NEXT_PUBLIC_SUPABASE_URL } })
    expect(await h.run()).toBe(1)
    expect(h.out.join('\n')).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('names each missing value once', async () => {
    const h = harness({ env: { NEXT_PUBLIC_SUPABASE_URL: ANSWERS.NEXT_PUBLIC_SUPABASE_URL } })
    expect(await h.run()).toBe(1)
    const lines = h.out.join('\n').split('\n').filter((line) => line.startsWith('  - '))
    for (const name of ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'OWNER_EMAIL']) {
      expect(lines.filter((line) => line.includes(name)), name).toHaveLength(1)
    }
  })
})

describe('npm run setup, re-run and interactive', () => {
  it('keeps existing values and comments, never regenerates a secret, and tightens the mode to 600', async () => {
    const existing = `# my notes\nCRON_SECRET=${'b'.repeat(64)}\nOWNER_EMAIL=keep@example.test\n`
    const h = harness({ env: { ...ANSWERS, OWNER_EMAIL: '' }, existing, argv: ['--offline'] })
    expect(await h.run()).toBe(0)
    const content = readFileSync(h.file, 'utf8')
    expect(content.startsWith('# my notes\n')).toBe(true)
    expect(h.read().CRON_SECRET).toBe('b'.repeat(64))
    expect(h.read().OWNER_EMAIL).toBe('keep@example.test')
    expect(statSync(h.file).mode & 0o777).toBe(0o600)
  })

  it('asks for secrets with hidden input, re-asks an invalid value, and Enter keeps an existing one', async () => {
    const existing = `META_AD_ACCOUNT_ID=act_999\n`
    // Order of the schema's `ask` variables: Supabase URL, anon key, service key, owner email, Meta
    // token, ad account (invalid, then Enter keeps act_999), app secret, name, timezone, currency, AI.
    const answers = ['https://abcdefghijkl.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0', SERVICE, 'owner@example.test',
      META, 'not-an-account', '', '', '', '', '', '', '']
    const h = harness({ interactive: true, prompts: answers, existing, argv: ['--offline'] })
    expect(await h.run()).toBe(0)
    expect(h.asked.find((a) => a.question.includes('service-role'))?.secret).toBe(true)
    expect(h.asked.find((a) => a.question.startsWith('Supabase project URL'))?.secret).toBe(false)
    expect(h.read().META_AD_ACCOUNT_ID).toBe('act_999')
    expect(h.out.join('\n')).toContain('META_AD_ACCOUNT_ID must be act_')
    for (const secret of [SERVICE, META]) expect(h.out.join('\n')).not.toContain(secret)
  })

  it('labels an optional prompt once and asks for the Claude key only for the Anthropic provider', async () => {
    const required = (question: string) => Object.entries({
      'Supabase project URL': ANSWERS.NEXT_PUBLIC_SUPABASE_URL, 'Supabase anon': ANSWERS.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      'Supabase service-role': SERVICE, 'Owner email': ANSWERS.OWNER_EMAIL,
    }).find(([prefix]) => question.startsWith(prefix))?.[1]
    const skipped = harness({ interactive: true, argv: ['--offline'], respond: (q) => required(q) ?? '' })
    expect(await skipped.run()).toBe(0)
    for (const { question } of skipped.asked) expect(question.match(/optional/gi)?.length ?? 0, question).toBeLessThanOrEqual(1)
    expect(skipped.asked.some((a) => a.question.startsWith('Claude API key'))).toBe(false)
    const anthropic = harness({ interactive: true, argv: ['--offline'], respond: (q) => required(q) ?? (q.startsWith('AI provider') ? 'anthropic' : '') })
    expect(await anthropic.run()).toBe(0)
    expect(anthropic.asked.find((a) => a.question.startsWith('Claude API key'))?.secret).toBe(true)
  })

  it('says the dashboard needs the Meta values instead of calling them optional', async () => {
    const h = harness({ interactive: true, argv: ['--offline'], respond: () => '' })
    await h.run()
    for (const prefix of ['Meta System User access token', 'Meta ad account id']) {
      const question = h.asked.find((a) => a.question.startsWith(prefix))?.question ?? ''
      expect(question, prefix).toContain('the dashboard needs it')
      expect(question, prefix).not.toMatch(/optional/i)
    }
    expect(h.asked.find((a) => a.question.startsWith('Business name'))?.question).toContain('[optional; Enter skips]')
  })

  it('the Supabase URL prompt names the local stack URL', async () => {
    const h = harness({ interactive: true, argv: ['--offline'], respond: () => '' })
    await h.run()
    expect(h.asked.find((a) => a.question.startsWith('Supabase project URL'))?.question).toContain('http://127.0.0.1:54321')
  })

  it('validates Supabase and warns about open sign-ups with the dashboard step', async () => {
    const h = harness({ interactive: true, prompts: Object.values(ANSWERS), state: fakeState({ disableSignup: false, users: [] }) })
    await h.run()
    expect(h.out.join('\n')).toContain('Allow new users to sign up')
  })
})

describe('env file store', () => {
  it('a re-run appends new keys under the existing setup header instead of adding a second one', () => {
    const { renderUpdate } = nodeEnvFileStore()
    const first = renderUpdate('# mine\nA=1\n', { B: '2' })
    const second = renderUpdate(first, { C: '3' })
    expect(second.match(/# Written by npm run setup/g)).toHaveLength(1)
    expect(parseDotenv(second)).toMatchObject({ A: '1', B: '2', C: '3' })
    expect(renderUpdate('A=1\n', { B: '2' })).toContain('# Written by npm run setup')
  })

  it('quotes values Next.js would otherwise expand or truncate, and round-trips them', () => {
    const store = nodeEnvFileStore()
    const file = path.join(root, 'quoting.env')
    writeFileSync(file, '')
    const { renderUpdate } = store
    const content = renderUpdate('', { BUSINESS_PROFILE_JSON: '{"name": "A #1 $HOME"}', PLAIN: 'abc' })
    expect(content).toContain(`BUSINESS_PROFILE_JSON='{"name": "A #1 $HOME"}'`)
    expect(parseDotenv(content)).toMatchObject({ BUSINESS_PROFILE_JSON: '{"name": "A #1 $HOME"}', PLAIN: 'abc' })
  })
})

describe('npm run setup --local', () => {
  it('starts the local stack through scripts/sb.sh, and reports when it cannot', async () => {
    const h = harness({ env: ANSWERS, argv: ['--local', '--offline'] })
    expect(await h.run()).toBe(0)
    expect(h.commands).toEqual([
      { command: 'bash', args: ['scripts/sb.sh', 'start'] },
      { command: 'bash', args: ['scripts/sb.sh', 'status', '-o', 'env'], capture: true },
    ])
    const failing = harness({ env: ANSWERS, argv: ['--local', '--offline'] })
    failing.deps.runCommand = async () => ({ code: 1 })
    expect(await failing.run()).toBe(1)
    expect(failing.out.join('\n')).toContain('local Supabase stack did not start')
  })

  it('writes the local URL and keys into the env file itself, never printing a key', async () => {
    const h = harness({ env: { OWNER_EMAIL: ANSWERS.OWNER_EMAIL }, argv: ['--local', '--offline'] })
    expect(await h.run()).toBe(0)
    expect(h.read()).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_SUPABASE_ANON_KEY: LOCAL_ANON, SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE,
    })
    const text = h.out.join('\n')
    expect(text).toContain('Local Supabase is up')
    // the inbox the running stack reports (a changed [local_smtp] port included)
    expect(text).toContain('Mailpit at http://127.0.0.1:55324')
    for (const secret of [LOCAL_ANON, LOCAL_SERVICE, 'postgres:postgres']) expect(text).not.toContain(secret)
  })

  it('does not ask for the Supabase values the local stack supplied', async () => {
    const h = harness({ interactive: true, argv: ['--local', '--offline'], respond: (q) => (q.startsWith('Owner email') ? ANSWERS.OWNER_EMAIL : '') })
    expect(await h.run()).toBe(0)
    expect(h.asked.filter((a) => a.question.startsWith('Supabase'))).toEqual([])
    expect(h.read().SUPABASE_SERVICE_ROLE_KEY).toBe(LOCAL_SERVICE)
  })

  it('names the manual fallback when the local keys cannot be read', async () => {
    const h = harness({ env: { OWNER_EMAIL: ANSWERS.OWNER_EMAIL }, argv: ['--local', '--offline'] })
    h.deps.runCommand = async (_command, args) => ({ code: args.includes('status') ? 1 : 0 })
    expect(await h.run()).toBe(1)
    expect(h.out.join('\n')).toContain('bash scripts/sb.sh status -o env')
  })
})
