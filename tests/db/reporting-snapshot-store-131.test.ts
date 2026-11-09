import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)
it('reopens immutable reporting through the actual repository in a new Node process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maxx-snapshot-restart-'))
  const invoke = async (operation: string) => {
    const { stdout } = await run(process.execPath,
      ['--import', 'tsx', 'tests/db/reporting-snapshot-process.ts', operation, directory], {
        cwd: process.cwd(), timeout: 25_000,
        // The child is plain Node + tsx: map Next's `server-only` marker the way every script does.
        env: { NODE_ENV: 'test', TZ: 'UTC', PATH: process.env.PATH, TSX_TSCONFIG_PATH: 'tsconfig.scripts.json' },
      })
    return JSON.parse(stdout.trim())
  }
  try {
    const written = await invoke('write'), reopened = await invoke('read')
    expect(reopened.id).toBe(written.id)
    expect(reopened.fingerprint).toBe(written.fingerprint)
    expect(reopened.pid).not.toBe(written.pid)
    expect(reopened.start).toBe('2026-09-05T17:00:40.000Z')
    expect(reopened.finish).toBe('2026-09-05T17:02:00.000Z')
    expect(reopened.zero).toBe(0)
    expect(reopened.unknown).toBeNull()
    expect(reopened.otherScope).toBeNull()
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60_000)
