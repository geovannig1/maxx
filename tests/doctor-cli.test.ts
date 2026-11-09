import { describe, expect, it, vi } from 'vitest'
import { runDoctor } from '../scripts/lib/doctor-cli'
import { OWNER_ID, fakeFetch, fakeState, type FakeCall } from './helpers/fake-services'

// `npm run doctor` runs the shared checks module. Exit codes: 0 no failure, 1 a failure,
// 2 a usage error. `--json` prints one machine-readable document; `--offline` makes no request.

const SERVICE = 'service-role-planted-0123456789abcdef'
const FILE = [
  'NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijkl.supabase.co',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`,
  'OWNER_EMAIL=owner@example.test',
  `OWNER_USER_ID=${OWNER_ID}`,
  `CRON_SECRET=${'c'.repeat(64)}`,
  'META_ACCESS_TOKEN=EAAG-planted-meta-credential-0123456789',
  'META_AD_ACCOUNT_ID=act_123',
  'META_APPSECRET_PROOF_ENABLED=true',
  'META_APP_SECRET=app-secret-planted-0123456789',
  'AI_PROVIDER=none',
  'BUSINESS_PROFILE_JSON={"name":"Example"}',
].join('\n')

function doctor(argv: string[], options: { file?: string | null; state?: ReturnType<typeof fakeState> } = {}) {
  const out: string[] = []
  const err: string[] = []
  const calls: FakeCall[] = []
  const aiProbe = vi.fn(async () => 'anthropic/claude-opus-5-5 answered (stop: end_turn).')
  const run = runDoctor(argv, {
    env: {},
    readEnvFile: () => (options.file === null ? null : options.file ?? FILE),
    envFilePath: '/tmp/fixture/.env.local',
    fetch: fakeFetch(options.state ?? fakeState(), calls),
    nodeVersion: '24.1.0',
    aiProbe,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  })
  return { run, out, err, calls, aiProbe }
}

describe('npm run doctor', () => {
  it('exits 0 and prints the checks when nothing fails', async () => {
    const { run, out } = doctor([])
    expect(await run).toBe(0)
    expect(out.join('\n')).toContain('Public sign-ups disabled')
    expect(out.join('\n')).toMatch(/No failures\./)
  })

  it('exits 1 when a check fails (open sign-ups only warn; a missing schema fails)', async () => {
    expect(await doctor([], { state: fakeState({ disableSignup: false }) }).run).toBe(0)
    const missing = doctor([], { state: fakeState({ openApiTables: [] }) })
    expect(await missing.run).toBe(1)
    expect(missing.out.join('\n')).toContain('supabase db push')
  })

  it('--json prints one parseable document with ok, counts and checks, and no secret', async () => {
    const { run, out } = doctor(['--json'], { state: fakeState({ autoconfirm: true }) })
    expect(await run).toBe(0)
    expect(out).toHaveLength(1)
    const doc = JSON.parse(out[0]) as { ok: boolean; warn: number; checks: Array<{ id: string; level: string }>; envFile: { found: boolean } }
    expect(doc.ok).toBe(true)
    expect(doc.envFile.found).toBe(true)
    expect(doc.checks.find((c) => c.id === 'supabase.email_confirmation')?.level).toBe('warn')
    expect(out[0]).not.toContain(SERVICE)
  })

  it('--offline makes no request; --live adds one AI call; default makes none', async () => {
    const offline = doctor(['--offline'])
    expect(await offline.run).toBe(0)
    expect(offline.calls).toEqual([])
    const plain = doctor([])
    await plain.run
    expect(plain.aiProbe).not.toHaveBeenCalled()
    const live = doctor(['--live'])
    await live.run
    expect(live.aiProbe).toHaveBeenCalledTimes(1)
  })

  it('exits 2 on an unknown option or integration', async () => {
    const unknown = doctor(['--bogus'])
    expect(await unknown.run).toBe(2)
    expect(unknown.err.join('\n')).toContain('--bogus')
    expect(await doctor(['--only=nonsense']).run).toBe(2)
  })

  it('a missing env file is reported, and the process environment is still checked', async () => {
    const { run, out } = doctor(['--offline'], { file: null })
    expect(await run).toBe(1)
    expect(out.join('\n')).toContain('/tmp/fixture/.env.local not found')
    expect(out.join('\n')).toContain('NEXT_PUBLIC_SUPABASE_URL is not set')
  })
})
