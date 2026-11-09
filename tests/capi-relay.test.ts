import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { buildFbc } from '@/lib/capi/relay-event'

// The public browser relay was REMOVED: its ?secret= lived in the PUBLIC GTM
// container, so it was a public write surface (poisonable _fbp, beacon race). The server-side Acuity
// webhook is the sole CAPI sender; buildFbc is retained (relay-event.ts) to reconstruct fbc from a
// captured fbclid. These pins fail if the relay route or its env secret ever return.

describe('public relay removal', () => {
  it('the relay route no longer exists', () => {
    expect(fs.existsSync('src/app/api/capi/relay/route.ts')).toBe(false)
  })

  it('CAPI_RELAY_SECRET is no longer referenced anywhere in src', () => {
    // Recursively scan src for the secret name — the only consumer was the deleted route.
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(entry.name) && fs.readFileSync(p, 'utf8').includes('CAPI_RELAY_SECRET')) hits.push(p)
      }
    }
    walk('src')
    expect(hits).toEqual([])
  })
})

describe('buildFbc (retained for the server CAPI sender)', () => {
  it('formats fb.1.<ms>.<fbclid>; null for empty', () => {
    expect(buildFbc('AbCdEf', 1_700_000_000_000)).toBe('fb.1.1700000000000.AbCdEf')
    expect(buildFbc('', 1)).toBeNull()
    expect(buildFbc(null, 1)).toBeNull()
    expect(buildFbc('  ', 1)).toBeNull()
  })
})
