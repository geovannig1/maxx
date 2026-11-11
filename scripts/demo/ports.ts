import { createServer } from 'node:net'

// The demo's three loopback ports: the gateway you open on --port, and the app and the sample backend
// on the next two.

export interface DemoPorts { gateway: number; app: number; backend: number }

export function demoPorts(port: number): DemoPorts {
  return { gateway: port, app: port + 1, backend: port + 2 }
}

function isFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
  })
}

/** Refuse to start when any demo port is taken, naming it, before any process is started. */
export async function assertDemoPortsFree(port: number): Promise<void> {
  const ports = demoPorts(port)
  const entries = Object.entries(ports) as Array<[keyof DemoPorts, number]>
  const busy = (await Promise.all(entries.map(async ([role, p]) => ((await isFree(p)) ? null : `127.0.0.1:${p} (${role})`)))).filter(Boolean)
  if (busy.length === 0) return
  const next = port + 10
  throw new Error(`The demo needs ports ${port} to ${port + 2}, but ${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} already in use. `
    + `Stop what is using ${busy.length === 1 ? 'it' : 'them'}, or pick other ports: npm run demo -- --port ${next}`)
}
