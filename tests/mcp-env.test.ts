import { describe, it, expect } from 'vitest'
import { parseDotenv, isPlaceholder } from '@/mcp/env'

describe('parseDotenv', () => {
  it('parses KEY=VALUE lines, ignoring comments and blanks', () => {
    const parsed = parseDotenv(
      ['# comment', '', 'NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co', 'SUPABASE_SERVICE_ROLE_KEY=abc123', 'NOEQUALS'].join('\n')
    )
    expect(parsed).toEqual({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'abc123' })
  })
  it('strips quotes and export prefixes; takes values literally (no interpolation)', () => {
    const parsed = parseDotenv(['export A="quoted value"', "B='single'", 'C=${NOT_EXPANDED}'].join('\n'))
    expect(parsed.A).toBe('quoted value')
    expect(parsed.B).toBe('single')
    expect(parsed.C).toBe('${NOT_EXPANDED}')
  })
  it('splits on the FIRST = so values containing = survive (JWTs, base64)', () => {
    expect(parseDotenv('KEY=abc=def==').KEY).toBe('abc=def==')
  })
})

describe('isPlaceholder', () => {
  it('flags absent values and unexpanded ${VAR} placeholders — the observed live failure mode', () => {
    expect(isPlaceholder(undefined)).toBe(true)
    expect(isPlaceholder('')).toBe(true)
    expect(isPlaceholder('${NEXT_PUBLIC_SUPABASE_URL}')).toBe(true) // literal, unexpanded — passed the old existence check
    expect(isPlaceholder('https://x.supabase.co')).toBe(false)
    expect(isPlaceholder('abc123')).toBe(false)
  })
})
