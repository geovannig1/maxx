import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The secret scan is only as strong as its allowlists. A path-scoped exception (gitleaks
 * `condition = "AND"` with `paths = ['^tests/']`) once suppressed EVERY finding under tests/, so a
 * real token pasted into a fixture would have passed the Security workflow. Exceptions must name
 * exact values; only dependency and build-output directories may be exempt by path.
 */
const ALLOWED_PATHS = new Set(["'''^node_modules/'''", "'''^\\.next/'''"])

interface AllowlistBlock { description: string; body: string }

function allowlistBlocks(toml: string): AllowlistBlock[] {
  return toml.split(/^\[\[allowlists\]\]\s*$/m).slice(1).map(raw => {
    const body = raw.split(/^\[/m)[0]
    return { description: body.match(/^description\s*=\s*"([^"]*)"/m)?.[1] ?? '(no description)', body }
  })
}

function listEntries(body: string, key: string): string[] | null {
  const match = body.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)^\\]`, 'm'))
  if (!match) return null
  return match[1].split('\n').map(line => line.trim().replace(/,$/, '')).filter(line => line.startsWith("'''"))
}

/** A literal anchored to the whole value: ^...$ with every regex metacharacter escaped. */
function isExactLiteral(entry: string): boolean {
  const pattern = entry.slice(3, -3)
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) return false
  const inner = pattern.slice(1, -1).replace(/\\./g, '')
  return !/[.*+?()[\]{}|^$\\]/.test(inner)
}

function violations(toml: string): string[] {
  const found: string[] = []
  for (const block of allowlistBlocks(toml)) {
    if (/^condition\s*=/m.test(block.body)) found.push(`${block.description}: combines conditions`)
    const paths = listEntries(block.body, 'paths')
    for (const entry of paths ?? []) if (!ALLOWED_PATHS.has(entry)) found.push(`${block.description}: path ${entry}`)
    const regexes = listEntries(block.body, 'regexes')
    if (regexes === null) continue
    if (!/^regexTarget\s*=\s*"secret"\s*$/m.test(block.body)) found.push(`${block.description}: regexes not scoped to the secret`)
    for (const entry of regexes) if (!isExactLiteral(entry)) found.push(`${block.description}: non-literal ${entry}`)
  }
  return found
}

describe('gitleaks allowlists name exact values, never source paths', () => {
  const config = readFileSync(path.join(process.cwd(), '.gitleaks.toml'), 'utf8')

  it('has allowlists to check (the parser sees the real file)', () => {
    expect(allowlistBlocks(config).length).toBeGreaterThanOrEqual(2)
    expect(allowlistBlocks(config).flatMap(block => listEntries(block.body, 'regexes') ?? []).length).toBeGreaterThan(0)
  })

  it('exempts no source path and allows only exact secret values', () => {
    expect(violations(config)).toEqual([])
  })

  it('rejects the path-scoped shape that hid every finding under tests/', () => {
    const pathScoped = `[[allowlists]]\ndescription = "fixtures"\ncondition = "AND"\nregexTarget = "line"\nregexes = [\n  '''abc123SECRETkey''',\n]\npaths = [\n  '''^tests/''',\n]\n`
    expect(violations(pathScoped)).toEqual([
      'fixtures: combines conditions',
      "fixtures: path '''^tests/'''",
      'fixtures: regexes not scoped to the secret',
      "fixtures: non-literal '''abc123SECRETkey'''",
    ])
  })

  it('rejects an issuer-prefix pattern that would admit any JWT with that issuer', () => {
    const prefix = `[[allowlists]]\ndescription = "demo"\nregexTarget = "secret"\nregexes = [\n  '''^eyJ[A-Za-z0-9_-]+\\.eyJpc3Mi[A-Za-z0-9_-]*$''',\n]\n`
    expect(violations(prefix)).toEqual(["demo: non-literal '''^eyJ[A-Za-z0-9_-]+\\.eyJpc3Mi[A-Za-z0-9_-]*$'''"])
  })
})
