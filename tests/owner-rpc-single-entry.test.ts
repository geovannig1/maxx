import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// Security review L5: every owner-initiated RPC goes through one TS entry, callOwnerRpc, which refuses
// an owner id that is not the pinned owner before the database is reached. The service role remains
// the trust boundary (docs/security-model.md); this makes the identity check impossible to skip.

const OWNER_RPCS = ['create_owner_change_request', 'create_campaign_plan_version', 'create_campaign_plan_change_request']

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

const rpcSpy = vi.fn(async () => ({ data: { id: 'never' }, error: null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({ rpc: rpcSpy }) }))

afterEach(() => { delete process.env.OWNER_USER_ID; rpcSpy.mockClear() })

describe('owner RPCs have one TS entry (security review L5)', () => {
  it('no module outside src/lib/writes/owner-rpc.ts calls an owner RPC directly', () => {
    const direct = OWNER_RPCS.map((name) => new RegExp(`\\.rpc\\(\\s*['"\`]${name}['"\`]`))
    const files = sourceFiles(path.resolve('src'))
    const offenders = files.filter((file) => !file.endsWith(path.join('src', 'lib', 'writes', 'owner-rpc.ts')))
      .filter((file) => direct.some((re) => re.test(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(process.cwd(), file))
    expect(offenders).toEqual([])
    // Control: the instrument does find a direct call where one exists.
    expect(direct[0].test("await db.rpc('create_owner_change_request', {})")).toBe(true)
    expect(files.filter((file) => readFileSync(file, 'utf8').includes('callOwnerRpc(')).length).toBeGreaterThanOrEqual(3)
  })

  it('refuses a non-owner id before the database is reached, and passes the owner (control)', async () => {
    process.env.OWNER_USER_ID = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D'
    const { callOwnerRpc } = await import('@/lib/writes/owner-rpc')
    const db = { rpc: rpcSpy } as never
    const refused = await callOwnerRpc(db, 'create_campaign_plan_version', { p_owner_user_id: '00000000-0000-4000-8000-000000000000' })
    expect(refused.error?.message).toMatch(/owner_identity_mismatch/)
    expect(rpcSpy).not.toHaveBeenCalled()
    await callOwnerRpc(db, 'create_campaign_plan_version', { p_owner_user_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' })
    expect(rpcSpy).toHaveBeenCalledTimes(1)
  })
})
