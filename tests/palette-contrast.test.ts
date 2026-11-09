import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The trust ramp and the ink scale are SEMANTIC, not decorative: --trust-low is the colour
 * of "mismatch", "missing" and high-severity anomalies, and TrustBadge renders failure
 * reasons in it at 11px. A console whose premise is flagging untrustworthy numbers cannot
 * render the flag below AA.
 *
 * These parse globals.css directly so the assertion is about the shipped stylesheet, not a
 * duplicated copy of the values.
 */

// Anchored to this file, not process.cwd(), so the suite is independent of where it is run from.
const CSS = readFileSync(fileURLToPath(new URL('../src/app/globals.css', import.meta.url)), 'utf8')

function srgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
}

function luminance(hex: string): number {
  const [r, g, b] = srgb(hex).map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** All values a token is given anywhere in the stylesheet (light block + both dark blocks). */
function valuesOf(token: string): string[] {
  const matches = [...CSS.matchAll(new RegExp(`--${token}:\\s*(#[0-9A-Fa-f]{3,8})\\s*;`, 'g'))]
  return matches.map(m => m[1])
}

function lightValue(token: string): string {
  const v = valuesOf(token)[0]
  expect(v, `--${token} must be defined in the light :root block`).toBeTruthy()
  return v
}

/**
 * Every ground an ink is actually painted on in the light theme. The first version of this
 * test checked only white and --bg-base, which is how --text-tertiary shipped at 4.39:1 on
 * --bg-subtle: it passed on white and failed in every tinted well, chip and table header.
 * An ink must clear its bar on EVERY ground, not the most flattering one.
 */
const LIGHT_GROUNDS: Record<string, string> = {
  white: '#FFFFFF',
  'bg-base': '#F7F8FA',
  'bg-subtle': '#F3F4F6',
}
/** Status inks are painted on their own tint pair, so that ground is added for them. */
const OWN_TINT: Record<string, string> = {
  danger: '#FEF2F2',
  warning: '#FFFBEB',
  success: '#ECFDF5',
  'trust-verified': '#ECFDF5',
  'trust-moderate': '#FFFBEB',
}

describe('light palette contrast', () => {
  it.each([
    ['text-primary', 4.5],
    ['text-secondary', 4.5],
    ['text-tertiary', 4.5],
    ['sidebar-label', 4.5],
    // Semantic ramp — read as text, including at 11px in TrustBadge.
    ['trust-low', 4.5],
    ['trust-moderate', 4.5],
    ['trust-verified', 4.5],
    ['trust-insufficient', 4.5],
    ['danger', 4.5],
    ['warning', 4.5],
    ['success', 4.5],
    // Non-text UI: icons, inert controls and boundaries clear the 3:1 bar.
    ['text-disabled', 3],
    ['border-strong', 3],
  ])('--%s meets %s:1 on every ground it is painted on', (token, min) => {
    const hex = lightValue(token)
    const grounds = { ...LIGHT_GROUNDS, ...(OWN_TINT[token] ? { 'own tint': OWN_TINT[token] } : {}) }
    for (const [name, ground] of Object.entries(grounds)) {
      expect(contrast(hex, ground), `--${token} (${hex}) on ${name} (${ground})`).toBeGreaterThanOrEqual(min)
    }
  })
})

describe('dark palette', () => {
  it('defines every themed token identically in the media query and the [data-theme] block', () => {
    // If these two drift, an explicit dark toggle renders differently from a dark OS.
    for (const token of ['bg-base', 'bg-surface', 'text-primary', 'text-disabled', 'border-strong', 'trust-low']) {
      const values = valuesOf(token)
      expect(values.length, `--${token} should appear once in light and once in each dark block`).toBe(3)
      expect(values[1], `--${token} dark values must match`).toBe(values[2])
    }
  })

  it('keeps disabled ink above the 3:1 UI bar on dark CARD surfaces, not just the page ground', () => {
    // The original dark value cleared 3:1 on --bg-base and failed on --bg-surface, where
    // most of this ink actually sits.
    const disabled = valuesOf('text-disabled')[1]
    const surface = valuesOf('bg-surface')[1]
    expect(contrast(disabled, surface)).toBeGreaterThanOrEqual(3)
  })

  it.each([
    ['text-tertiary', 4.5],
    ['sidebar-label', 4.5],
    ['trust-insufficient', 4.5],
    ['danger', 4.5],
  ])('dark --%s meets %s:1 on base, surface AND subtle', (token, min) => {
    const value = valuesOf(token)[1]
    for (const groundToken of ['bg-base', 'bg-surface', 'bg-subtle']) {
      const ground = valuesOf(groundToken)[1]
      expect(contrast(value, ground), `dark --${token} (${value}) on --${groundToken} (${ground})`)
        .toBeGreaterThanOrEqual(min)
    }
  })
})
