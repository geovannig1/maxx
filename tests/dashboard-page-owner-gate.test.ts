import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Totality check: the dashboard layout is not a security boundary on its own (Next.js does not
// re-run layouts on client-side navigation), so every server-rendered page under (dashboard) must
// call requireOwner() itself. Client-rendered pages ('use client') cannot run server code; they are
// allowed because their data comes only through the owner-gated /api/* routes.
function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return pages(full)
    return name === 'page.tsx' ? [full] : []
  })
}

describe('dashboard pages check the owner themselves', () => {
  const root = join(process.cwd(), 'src/app/(dashboard)')
  const all = pages(root)

  it('finds the dashboard pages (control)', () => {
    expect(all.length).toBeGreaterThan(20)
  })

  it('every server page calls requireOwner(); every other page is a client component', () => {
    const offenders = all.filter((file) => {
      const source = readFileSync(file, 'utf8')
      const isClient = /^\s*['"]use client['"]/.test(source)
      return !isClient && !source.includes('await requireOwner()')
    })
    expect(offenders.map((f) => f.slice(root.length))).toEqual([])
  })

  it('the layout calls requireOwner() too', () => {
    expect(readFileSync(join(root, 'layout.tsx'), 'utf8')).toContain('await requireOwner()')
  })
})
