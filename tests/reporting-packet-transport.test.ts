import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { fixturePacket } from '../scripts/demo/sample/reports'
import type { ReportingPacket } from '@/lib/reporting/contracts'
import { compactReportingPacket, expandPacket } from '@/lib/reporting/packet-format'
import { ReportingFrameSchema } from '@/lib/reporting/stream-contract'
import { requestReportingPacket } from '@/lib/reporting/request-packet'

// Live (non-prepared) report responses travel as packetVersion 2; the browser expands and validates them
// exactly as the v1 packets it received before, and still accepts v1.
const mocks = vi.hoisted(() => ({ auth: vi.fn(), account: vi.fn(), load: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.auth } }) }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: mocks.account,
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))
vi.mock('@/lib/reporting/loader', () => ({ loadReportingSection: mocks.load }))
import { GET } from '@/app/api/reporting/route'

const key = 'from=2026-09-02&to=2026-09-04'
const complete = () => fixturePacket('meta', '2026-09-02', '2026-09-04')
function initial(): ReportingPacket {
  const packet = complete()
  if (packet.section !== 'meta') throw new Error('Wrong fixture source')
  return { ...packet, result: { ...packet.result, state: 'partial', data: { ...packet.result.data!, detailState: 'loading' } } }
}
const request = (accept: string) => new NextRequest(`http://localhost/api/reporting?section=meta&${key}`, { headers: { Accept: accept } })
const read = (response: Response) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetcher)
  return requestReportingPacket('meta', key, new AbortController().signal)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  vi.stubEnv('REPORTING_PREPARED_ENABLED', 'off')
  mocks.auth.mockResolvedValue({ data: { user: { id: 'owner', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } } })
  const context = complete().context
  mocks.account.mockResolvedValue({ ok: true, account: { id: context.account.id, accountId: context.account.metaAccountId, accountName: context.account.name } })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('live report packet transport', () => {
  it('streams packetVersion 2 frames that the browser expands to the validated packets', async () => {
    mocks.load.mockImplementation(async (_section, context, _refresh, _ids, progress) => {
      progress?.({ ...initial(), context })
      return { ...complete(), context }
    })
    const response = await GET(request('application/x-ndjson, application/json'))
    const text = await response.clone().text()
    const frames = text.trim().split('\n').map(line => JSON.parse(line) as { kind: string; packet: unknown })
    expect(frames.map(frame => frame.kind)).toEqual(['partial', 'complete'])
    for (const frame of frames) {
      expect((frame.packet as { packetVersion?: number }).packetVersion).toBe(2)
      const expanded = expandPacket(frame.packet) as ReportingPacket
      expect(ReportingFrameSchema.parse({ kind: frame.kind, packet: expanded }).packet.context.asOf).toBe(expanded.context.asOf)
    }
    const v1 = text.length, packet = await read(response)
    expect(packet.section).toBe('meta')
    expect(packet.result.state).toBe('available')
    expect(JSON.stringify(packet.result)).toBe(JSON.stringify((expandPacket(frames[1].packet) as ReportingPacket).result))
    expect(v1).toBeLessThan(JSON.stringify(frames.map(frame => ({ ...frame, packet: expandPacket(frame.packet) }))).length)
  })

  it('answers a plain JSON request with a packetVersion 2 body that the browser expands', async () => {
    mocks.load.mockImplementation(async (_section, context) => ({ ...complete(), context }))
    const response = await GET(request('application/json'))
    const body = await response.clone().json() as { packetVersion?: number }
    expect(body.packetVersion).toBe(2)
    const packet = await read(response)
    expect(packet.result).toEqual((expandPacket(body) as ReportingPacket).result)
  })

  it('still reads plain v1 bodies and frames', async () => {
    const packet = complete()
    expect((await read(new Response(JSON.stringify(packet), { headers: { 'Content-Type': 'application/json' } }))).result).toEqual(packet.result)
    const frame = `${JSON.stringify({ kind: 'complete', packet })}\n`
    expect((await read(new Response(frame, { headers: { 'Content-Type': 'application/x-ndjson' } }))).result).toEqual(packet.result)
  })

  it('refuses a v2 frame whose index disagrees with its packet', async () => {
    const compact = compactReportingPacket(complete())
    const frame = `${JSON.stringify({ kind: 'complete', packet: { ...compact, notes: ['Not the packet notes.'] } })}\n`
    await expect(read(new Response(frame, { headers: { 'Content-Type': 'application/x-ndjson' } }))).rejects.toMatchObject({ kind: 'invalid' })
    const body = JSON.stringify({ ...compact, result: { ...compact.result, state: 'unavailable' } })
    await expect(read(new Response(body, { headers: { 'Content-Type': 'application/json' } }))).rejects.toMatchObject({ kind: 'invalid' })
  })
})
