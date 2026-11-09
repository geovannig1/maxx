import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const performanceLayout = readFileSync(join(root, 'src/app/(dashboard)/performance/layout.tsx'), 'utf8')
const commandPalette = readFileSync(join(root, 'src/components/layout/CommandPalette.tsx'), 'utf8')

describe('navigation accessibility polish', () => {
  it('keeps Performance tabs at accessible target size with visible keyboard focus', () => {
    expect(performanceLayout).toContain('minHeight: 44')
    expect(performanceLayout).toContain('focus-visible:outline-none')
    expect(performanceLayout).toContain('focus-visible:ring-2')
  })

  it('gives the command palette proper modal dialog semantics', () => {
    expect(commandPalette).toContain('role="dialog"')
    expect(commandPalette).toContain('aria-modal={true}')
    expect(commandPalette).toContain('aria-labelledby="command-palette-title"')
    expect(commandPalette).toContain('id="command-palette-title"')
  })

  it('captures, traps, and restores focus without removing keyboard command selection', () => {
    expect(commandPalette).toContain('restoreFocusRef')
    expect(commandPalette).toContain('panelRef')
    expect(commandPalette).toContain('inputRef')
    expect(commandPalette).toContain("event.key === 'Tab'")
    expect(commandPalette).toContain("event.key === 'Escape'")
    expect(commandPalette).toContain('restoreFocusRef.current?.focus()')
    expect(commandPalette).toContain("e.key === 'ArrowDown'")
    expect(commandPalette).toContain("e.key === 'Enter'")
  })
})
