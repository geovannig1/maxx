import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/sb.sh pins the Supabase CLI (`npx --yes supabase@<pin>`); setup's --local and --apply-schema
// run it, CI installs the same version and the documents name it for manual commands. A pin that
// drifts in one place makes a reader run a different CLI than the one the project was checked with.

const ROOT = path.resolve(__dirname, '..')
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')
const PIN = /npx --yes supabase@(\d+\.\d+\.\d+)/.exec(read('scripts/sb.sh'))?.[1]

function documents(): string[] {
  const docs = readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)
  return ['README.md', 'CONTRIBUTING.md', ...docs]
}

describe('Supabase CLI version pin', () => {
  it('scripts/sb.sh pins an exact version and CI installs the same one', () => {
    expect(PIN).toMatch(/^\d+\.\d+\.\d+$/)
    expect(read('.github/workflows/ci.yml')).toContain(`version: ${PIN}`)
  })

  it('every documented CLI command uses the pinned version', () => {
    const mentions = documents().flatMap((file) => [...read(file).matchAll(/supabase@(\d+\.\d+\.\d+)/g)].map((m) => `${file}: ${m[1]}`))
    expect(mentions.length).toBeGreaterThan(0)
    expect(mentions.filter((m) => !m.endsWith(`: ${PIN}`))).toEqual([])
  })

  it('no user-facing document tells the reader to run a bare global `supabase` command', () => {
    const bare = documents().flatMap((file) => read(file).split('\n').map((line, i) => ({ file, line: i + 1, text: line.trim() }))
      .filter(({ text }) => /^(\$ )?supabase (link|db|start|stop|status)\b/.test(text)))
    expect(bare).toEqual([])
  })
})
