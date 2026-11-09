import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

// The env file `npm run setup` writes: private to this machine (mode 600, written atomically), with the
// owner's existing lines and comments kept in place. Values are quoted so Next.js's loader neither
// expands `$NAME` nor truncates at ` #`.

const PLAIN = /^[A-Za-z0-9_\-.:/@+=,]*$/
const SETUP_HEADER = '# Written by npm run setup'

export function quoteEnvValue(value: string): string {
  if (PLAIN.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replace(/"/g, '\\"')}"`
}

/** Replace `KEY=` lines in place and append new keys; every other line is kept verbatim. */
export function renderUpdate(content: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates))
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n')
  const out = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (!match || !pending.has(match[1])) return line
    const value = pending.get(match[1])!
    pending.delete(match[1])
    return `${match[1]}=${quoteEnvValue(value)}`
  })
  if (pending.size > 0) {
    // A re-run adds its new keys at the end, under the header an earlier run wrote.
    if (!out.includes(SETUP_HEADER)) {
      if (out.length > 0 && out.at(-1) !== '') out.push('')
      out.push(SETUP_HEADER)
    }
    for (const [key, value] of pending) out.push(`${key}=${quoteEnvValue(value)}`)
  }
  return `${out.join('\n')}\n`
}

export interface EnvFileStore {
  read(path: string): string | null
  /** Atomic write with mode 600, also when the file already existed with a wider mode. */
  write(path: string, content: string): void
  renderUpdate: typeof renderUpdate
}

export function nodeEnvFileStore(): EnvFileStore {
  return {
    read(path) {
      try { return readFileSync(path, 'utf8') } catch { return null }
    },
    write(path, content) {
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
      writeFileSync(temp, content, { mode: 0o600, flag: 'wx' })
      chmodSync(temp, 0o600)
      renameSync(temp, path)
      chmodSync(path, 0o600)
    },
    renderUpdate,
  }
}
