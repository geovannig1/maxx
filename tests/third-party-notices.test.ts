import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  NOTICES_FILE, collectProductionPackages, generateNotices, noticesAreCurrent, renderNotices,
} from '../scripts/generate-third-party-notices.mjs'

// THIRD_PARTY_NOTICES.md is generated from package-lock.json and node_modules, and the Anthropic SDK
// family's Apache-2.0 notice (a tracked release item) must stay in it. Whether the committed file is current
// is checked at release time (`npm run notices:check`, part of `npm run release:check`), not here: as a unit
// test it failed every dependency-update PR and stopped CI before the database tests and the build ran.

const ROOT = path.resolve(__dirname, '..')

type Installed = { manifest: Record<string, unknown>; files: string[]; read: (file: string) => string }
const lock = (packages: Record<string, Record<string, unknown>>) => ({ packages: { '': {}, ...packages } })
const none = () => null

describe('third-party notices', () => {
  it('the release-time check reports a missing, current and stale notices file correctly', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'maxx-notices-'))
    const writeLock = (version: string) => writeFileSync(path.join(dir, 'package-lock.json'),
      JSON.stringify(lock({ 'node_modules/a': { version, license: 'MIT' } })))
    try {
      writeLock('1.0.0')
      expect(noticesAreCurrent(dir)).toBe(false) // no notices file yet
      writeFileSync(path.join(dir, NOTICES_FILE), generateNotices(dir))
      expect(noticesAreCurrent(dir)).toBe(true)
      writeLock('1.0.1') // a dependency changed without `npm run notices`
      expect(noticesAreCurrent(dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('carries the Apache-2.0 notice for every Anthropic SDK package Maxx depends on', () => {
    const doc = readFileSync(path.join(ROOT, NOTICES_FILE), 'utf8')
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const sdks = Object.keys(pkg.dependencies).filter((name) => name.startsWith('@anthropic-ai/'))
    expect(sdks.length).toBeGreaterThanOrEqual(4)
    for (const name of sdks) expect(doc).toMatch(new RegExp(`- \`${name}\` [0-9.]+: Apache-2.0\\. Copyright \\d{4} Anthropic, PBC\\.`))
    expect(doc).toContain('Licensed under the Apache License, Version 2.0')
  })

  it('lists production packages only, once per version, with the lockfile license', () => {
    const packages = collectProductionPackages({
      lock: lock({
        'node_modules/a': { version: '1.0.0', license: 'MIT' },
        'node_modules/b': { version: '2.0.0', license: 'ISC', dev: true },
        'node_modules/c': { version: '3.0.0', license: 'Apache-2.0', devOptional: true },
        'node_modules/x/node_modules/a': { version: '1.0.0', license: 'MIT' },
        'node_modules/d': { version: '4.0.0', license: 'LGPL-3.0-or-later', optional: true },
      }),
      readInstalled: none,
    })
    expect(packages.map((p) => `${p.name}@${p.version}:${p.license}`)).toEqual(['a@1.0.0:MIT', 'd@4.0.0:LGPL-3.0-or-later'])
    expect(renderNotices(packages)).toMatch(/\| `d` \| 4\.0\.0 \| LGPL-3\.0-or-later \| optional, platform-specific \|/)
  })

  it('control: an installed package whose package.json disagrees with the lockfile stops generation', () => {
    const installed = (license: string): Installed => ({ manifest: { license }, files: [], read: () => '' })
    const input = (license: string) => ({
      lock: lock({ 'node_modules/a': { version: '1.0.0', license: 'MIT' } }),
      readInstalled: () => installed(license),
    })
    expect(() => collectProductionPackages(input('MIT'))).not.toThrow()
    expect(() => collectProductionPackages(input('GPL-3.0'))).toThrow(/package-lock.json says MIT/)
  })

  it('control: a dependency added to the lockfile changes the rendered file', () => {
    const base = { 'node_modules/a': { version: '1.0.0', license: 'MIT' } }
    const before = renderNotices(collectProductionPackages({ lock: lock(base), readInstalled: none }))
    const after = renderNotices(collectProductionPackages({
      lock: lock({ ...base, 'node_modules/z': { version: '0.1.0', license: 'MIT' } }), readInstalled: none,
    }))
    expect(after).not.toBe(before)
  })
})
