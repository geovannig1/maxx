import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { envReads, envReadsOf } from './helpers/env-reads'

// one env-read detector serves both the env-schema population test (upper-snake names plus
// the dynamic reads it cannot resolve) and the secret-marker guard in client-server-boundary.test.ts
// (every name, unfiltered). This pins the two views of the same detection.

const dir = mkdtempSync(path.join(tmpdir(), 'env-reads-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const file = path.join(dir, 'reader.ts')
writeFileSync(file, [
  'const vars = process.env',                                  // 1
  'export const a = vars.VENDOR_ONE_TOKEN',                    // 2
  "export const b = process.env['VENDOR_TWO']",               // 3
  'const { VENDOR_THREE, VENDOR_FOUR: four } = process.env',  // 4
  'export const c = (env: Record<string, string>) => env.ok', // 5: injected record, lower-case name
  'export const d = (k: string) => process.env[k]',            // 6: dynamic
  "process.env['WRITTEN_ONLY'] = 'x'",                         // 7: a write, literal
  'export const e = (k: string) => { process.env[k] = "y" }', // 8: dynamic write, not a read
  'export const f = (k: string, env: Record<string, string>) => env[k]', // 9: injected record, dynamic
  'const other = { NOT_ENV: 1 }; export const g = other.NOT_ENV',        // 10
  'export const h = [four]',
  '',
].join('\n'))

describe('env reads', () => {
  it('envReadsOf reports every name read from the environment record, unfiltered', () => {
    expect([...envReadsOf(file).all].sort()).toEqual(['VENDOR_FOUR', 'VENDOR_ONE_TOKEN', 'VENDOR_THREE', 'VENDOR_TWO', 'WRITTEN_ONLY', 'ok'])
  })

  it('envReads keeps upper-snake names only', () => {
    expect([...envReads(file).names].sort()).toEqual(['VENDOR_FOUR', 'VENDOR_ONE_TOKEN', 'VENDOR_THREE', 'VENDOR_TWO', 'WRITTEN_ONLY'])
  })

  it('dynamic reads are process.env (or an explicit alias) indexed by an expression, never a write', () => {
    expect(envReads(file).dynamic).toEqual([6])
    expect(envReadsOf(file).dynamic).toEqual([6])
  })
})
