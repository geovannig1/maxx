import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import { demoPorts, assertDemoPortsFree } from '../scripts/demo/ports'

// `npm run demo` binds three loopback ports: the gateway on --port and the app and sample backend on
// the next two. A busy one must stop the demo before anything starts, naming the
// port and the way out, instead of a half-started demo with a cryptic EADDRINUSE.

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done)))) })

function listen(): Promise<number> {
  const server = createServer()
  servers.push(server)
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)))
}

describe('demo ports', () => {
  it('uses the given port and the next two', () => {
    expect(demoPorts(3000)).toEqual({ gateway: 3000, app: 3001, backend: 3002 })
  })

  it('fails fast naming a busy port and suggesting --port', async () => {
    const busy = await listen()
    await expect(assertDemoPortsFree(busy - 1)).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${busy} \\(app\\) is already in use.*--port`, 's'))
  })

  it('control: free ports pass', async () => {
    const port = await listen()
    await new Promise((done) => servers.pop()!.close(done))
    await expect(assertDemoPortsFree(port)).resolves.toBeUndefined()
  })
})
