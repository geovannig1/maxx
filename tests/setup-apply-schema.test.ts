import { describe, expect, it } from 'vitest'
import { applySchema, type RunCommand } from '../scripts/lib/setup-steps'

// `npm run setup -- --apply-schema` runs `supabase db push --db-url <url>`. A process's
// arguments are visible to every local user (ps), so the password is taken out of the URL and handed
// to the CLI as PGPASSWORD in the child's environment only. Supabase CLI 2.98.2 reads PGPASSWORD for a
// password-less --db-url (checked against a loopback fake Postgres server; it ignores
// SUPABASE_DB_PASSWORD with --db-url). Fakes only: no command or database is ever reached here.

function recorder() {
  const calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = []
  const run: RunCommand = async (command, args, options) => { calls.push({ command, args, env: options?.env }); return { code: 0 } }
  return { calls, run }
}

describe('applySchema', () => {
  it('moves the password out of the arguments into PGPASSWORD, decoded', async () => {
    const { calls, run } = recorder()
    expect(await applySchema('postgresql://postgres.abcdefghijkl:p%40ss%2Fw%3Ard@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require', run)).toEqual({ ok: true })
    expect(calls).toEqual([{
      command: 'bash',
      args: ['scripts/sb.sh', 'db', 'push', '--db-url', 'postgresql://postgres.abcdefghijkl@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require'],
      env: { PGPASSWORD: 'p@ss/w:rd' },
    }])
  })

  it('also moves a password given as a query parameter', async () => {
    const { calls, run } = recorder()
    await applySchema('postgres://postgres@db.example.test:5432/postgres?password=q%20secret&sslmode=require', run)
    expect(calls[0].args[4]).toBe('postgres://postgres@db.example.test:5432/postgres?sslmode=require')
    expect(calls[0].env).toEqual({ PGPASSWORD: 'q secret' })
  })

  it('control: a URL without a password is passed as is, with no PGPASSWORD of its own', async () => {
    const { calls, run } = recorder()
    await applySchema('postgresql://postgres@127.0.0.1:54322/postgres', run)
    expect(calls).toEqual([{ command: 'bash', args: ['scripts/sb.sh', 'db', 'push', '--db-url', 'postgresql://postgres@127.0.0.1:54322/postgres'], env: undefined }])
  })

  it('refuses a value it cannot parse instead of putting it on the command line', async () => {
    const { calls, run } = recorder()
    const result = await applySchema('not a url :secret@', run)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('SUPABASE_DB_URL')
    expect(result.reason).not.toContain('secret')
    expect(calls).toEqual([])
  })

  it('reports a failing or missing CLI without the URL', async () => {
    expect(await applySchema('postgresql://u:pw-planted@h:5432/d', async () => ({ code: 3 }))).toEqual({ ok: false, reason: 'supabase db push exited with 3.' })
    const missing = await applySchema('postgresql://u:pw-planted@h:5432/d', async () => { throw new Error('ENOENT') })
    expect(missing.ok).toBe(false)
    expect(JSON.stringify(missing)).not.toContain('pw-planted')
  })
})
