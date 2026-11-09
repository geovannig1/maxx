import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
import { ThemeToggle } from '@/components/theme/ThemeToggle'
describe('theme control hydration', () => {
  it('does not assert a browser-stored selection in server markup', () => {
    const html = renderToStaticMarkup(<ThemeToggle />)
    expect(html).not.toContain('aria-checked="true"')
    expect(html).toContain('aria-label="Dark"')
    expect(html).toContain('aria-label="Light"')
  })
})
