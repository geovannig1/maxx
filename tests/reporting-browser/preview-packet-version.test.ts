import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { REPORTING_PACKET_VERSION, expandPacket } from '@/lib/reporting/packet-format'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { fixtureCookie } from './auth-fixture.mjs'
import { progressiveGateway } from './progressive-gateway'

// The browser preview servers answer /api/reporting the way the real API does: the compact packet
// (packetVersion 2), plain JSON and every NDJSON frame alike. The browser still reads version 1, so a
// server left on it would pass every page check while no longer exercising the current wire format.

const RANGE = 'from=2026-09-02&to=2026-09-04'

function expectCurrent(body: unknown, section: string) {
  expect((body as { packetVersion?: unknown }).packetVersion).toBe(REPORTING_PACKET_VERSION)
  expect(validateReportingPacket(expandPacket(body)).section).toBe(section)
}

describe('progressive transport gateway', async () => {
  const gateway = await progressiveGateway()
  afterAll(() => gateway.close())

  it('answers a plain JSON source with the current packet version', async () => {
    expectCurrent(await (await fetch(`${gateway.url}/api/reporting?section=business&${RANGE}`)).json(), 'business')
  })

  it('streams partial and complete frames with the current packet version', async () => {
    const reply = fetch(`${gateway.url}/api/reporting?section=meta&${RANGE}`)
    const deadline = Date.now() + 10_000
    while (gateway.held.length === 0 && Date.now() < deadline) await new Promise(done => setTimeout(done, 20))
    gateway.complete()
    const frames = (await (await reply).text()).trim().split('\n').map(line => JSON.parse(line) as { kind: string; packet: unknown })
    expect(frames.map(frame => frame.kind)).toEqual(['partial', 'complete'])
    for (const frame of frames) expect((frame.packet as { packetVersion?: unknown }).packetVersion).toBe(REPORTING_PACKET_VERSION)
    expectCurrent(frames[1].packet, 'meta')
  })
})

describe('interactive sample preview (npm run preview:sample)', async () => {
  const port = await new Promise<number>(done => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as { port: number }
      probe.close(() => done(free))
    })
  })
  let child: ChildProcess | null = null
  afterAll(() => { child?.kill('SIGTERM') })

  it('answers every source with the current packet version', async () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'tests/reporting-browser/interactive-preview.ts'], {
      env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.scripts.json', MAXX_TEST_PREVIEW_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((done, fail) => {
      child!.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('Interactive synthetic preview')) done() })
      child!.once('exit', code => fail(new Error(`preview exited with ${code}`)))
    })
    for (const section of ['meta', 'business', 'website', 'measurement']) {
      const reply = await fetch(`http://127.0.0.1:${port}/api/reporting?section=${section}&${RANGE}`, { headers: { cookie: `sb-127-auth-token=${fixtureCookie}` } })
      expect(reply.status).toBe(200)
      expectCurrent(await reply.json(), section)
    }
  }, 60_000)
})
