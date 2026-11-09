import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// A plain filesystem scan for rule tests. Deliberately not `rg`/`grep`: those can be ignore-aware or
// wrapped, and an empty result from them would not prove absence. Every rule test that uses this also
// plants a violation in a temporary tree and asserts the scan reports it (the known-present control).

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/

export function listSourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (SOURCE_EXTENSIONS.test(name)) out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

export interface ScanHit {
  /** Path relative to `base`, with forward slashes. */
  file: string
  line: number
  text: string
}

/** Every line under `roots` (relative to `base`) matching `pattern`, also matching file paths. */
export function scanSources(base: string, roots: readonly string[], pattern: RegExp): ScanHit[] {
  const hits: ScanHit[] = []
  for (const root of roots) {
    const abs = path.join(base, root)
    if (!existsSync(abs)) continue
    for (const file of listSourceFiles(abs)) {
      const rel = path.relative(base, file).split(path.sep).join('/')
      const lines = readFileSync(file, 'utf8').split('\n')
      let matched = false
      lines.forEach((text, i) => {
        if (pattern.test(text)) {
          hits.push({ file: rel, line: i + 1, text: text.trim() })
          matched = true
        }
      })
      if (!matched && pattern.test(rel)) hits.push({ file: rel, line: 0, text: '(path)' })
    }
  }
  return hits
}
