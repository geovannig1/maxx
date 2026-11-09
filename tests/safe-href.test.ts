import { describe, it, expect } from 'vitest'
import { safeHref } from '@/lib/ui/safe-href'

// Model-authored markdown is untrusted. Only absolute http(s) URLs may become anchors in the owner's
// chat and reports; every other scheme renders as plain text.
describe('safeHref', () => {
  it('keeps absolute http and https links', () => {
    expect(safeHref('https://example.test/path?x=1')).toBe('https://example.test/path?x=1')
    expect(safeHref('http://example.test/')).toBe('http://example.test/')
  })

  it('rejects script, data and other schemes', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('JAVASCRIPT:alert(1)')).toBeNull()
    expect(safeHref('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(safeHref('vbscript:msgbox')).toBeNull()
    expect(safeHref('file:///etc/passwd')).toBeNull()
  })

  it('rejects relative, malformed and non-string values', () => {
    expect(safeHref('/dashboard')).toBeNull()
    expect(safeHref('example.test')).toBeNull()
    expect(safeHref('')).toBeNull()
    expect(safeHref(undefined)).toBeNull()
    expect(safeHref(42)).toBeNull()
  })
})
