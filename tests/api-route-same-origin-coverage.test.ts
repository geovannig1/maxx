import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every cookie-session mutation must refuse a cross-origin request in its own handler. src/proxy.ts
 * applies rejectCrossOriginMutation to /api/* as well, but a proxy is one layer (matcher changes and
 * middleware bypass bugs have happened); before the v1 release 31 of 40 mutating handlers relied on it alone.
 * Machine-authenticated or deliberately public routes are listed with the reason they are exempt.
 */
const ROOTS = [join(process.cwd(), 'src/app/api'), join(process.cwd(), 'src/app/auth')]
const EXEMPT: Record<string, string> = {
  'api/attribution/paid-touch': 'public by design: called cross-origin by your website, guarded by an exact origin allowlist',
  'api/outcomes/webhook/[sourceId]': 'server-to-server, authenticated by a per-source HMAC signature, no cookies',
  'api/webhooks/acuity': 'server-to-server, authenticated by Acuity\'s HMAC signature, no cookies',
}
const MUTATING = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\(/g

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return routes(full)
    return name === 'route.ts' ? [full] : []
  })
}

/** The handler body: from the first `{` after the parameter list to its matching `}`. */
function handlerBody(source: string, from: number): string {
  let depth = 0
  let at = from
  for (; at < source.length; at += 1) {
    if (source[at] === '(') depth += 1
    if (source[at] === ')') { depth -= 1; if (depth === 0) break }
  }
  const open = source.indexOf('{', at)
  depth = 0
  for (let end = open; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1
    if (source[end] === '}') { depth -= 1; if (depth === 0) return source.slice(open, end + 1) }
  }
  return source.slice(open)
}

function uncheckedHandlers(source: string): string[] {
  const missing: string[] = []
  for (const match of source.matchAll(MUTATING)) {
    const body = handlerBody(source, match.index! + match[0].length - 1)
    if (!/rejectCrossOriginMutation\(\s*\w+\s*\)/.test(body)) missing.push(match[1])
  }
  return missing
}

const files = ROOTS.flatMap(routes)
const keyOf = (file: string) => relative(join(process.cwd(), 'src/app'), join(file, '..')).replace(/\\/g, '/')
const mutating = files.filter((file) => readFileSync(file, 'utf8').match(MUTATING))

describe('every cookie-session mutation checks same-origin in its own handler', () => {
  it('finds the mutating routes (guards this test against checking nothing)', () => {
    expect(mutating.length).toBeGreaterThan(35)
    for (const key of Object.keys(EXEMPT)) expect(mutating.map(keyOf)).toContain(key)
  })

  it('the detector rejects a handler without the check and accepts one with it (control)', () => {
    expect(uncheckedHandlers('export async function POST(req: Request) { return ok(req) }')).toEqual(['POST'])
    expect(uncheckedHandlers('export async function PATCH(\n  req: Request,\n  { params }: { params: Promise<{ id: string }> },\n) {\n  const crossOrigin = rejectCrossOriginMutation(req)\n  if (crossOrigin) return crossOrigin\n}')).toEqual([])
    // A check in another handler of the same file does not count for this one.
    expect(uncheckedHandlers('export async function GET(req: Request) { rejectCrossOriginMutation(req) }\nexport async function DELETE(req: Request) { return x }')).toEqual(['DELETE'])
  })

  it.each(mutating.map((file) => [keyOf(file), file]))('%s', (key, file) => {
    if (key in EXEMPT) return
    expect(uncheckedHandlers(readFileSync(file, 'utf8')), `${key}: mutating handler without rejectCrossOriginMutation`).toEqual([])
  })
})
