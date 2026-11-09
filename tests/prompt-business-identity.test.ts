import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { scanUiText } from './_support/ui-text-scan'

// AI prompt builders never assume one business. They read the configured business profile
// (BUSINESS_PROFILE_JSON / NEXT_PUBLIC_BUSINESS_NAME) through `promptBusiness`, which falls back to neutral
// wording when the install has not described itself. The fictional example profile's name and city live
// only in src/config (the demo and test fixture), never in a prompt.

const ROOT = process.cwd()
const FIXED_BUSINESS = /Example Studio|Springfield/
const planted = mkdtempSync(path.join(os.tmpdir(), 'maxx-prompt-business-'))
afterAll(() => rmSync(planted, { recursive: true, force: true }))
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

const PROFILE = JSON.stringify({ name: 'Northwind Bikes', description: 'bicycle repair shop', city: 'Lyon', serviceArea: '15 km around Lyon' })

describe('prompt builders use the configured business', () => {
  it('finds a planted fixed name or city in prompt text (planted control)', () => {
    mkdirSync(path.join(planted, 'src/lib/x'), { recursive: true })
    writeFileSync(path.join(planted, 'src/lib/x/prompt.ts'),
      "// Example Studio in a comment is fine\nexport const p = `You analyse ads for Example Studio in ${city}`\nexport const q = 'shoots in Springfield'\n")
    expect(scanUiText(planted, ['src/lib'], FIXED_BUSINESS).map((h) => h.text)).toEqual([
      'You analyse ads for Example Studio in ${…}', 'shoots in Springfield'])
  })

  it('has no fixed business name or city in any text under src/lib or src/mcp', () => {
    expect(scanUiText(ROOT, ['src/lib', 'src/mcp'], FIXED_BUSINESS).map((h) => `${h.file}:${h.line}: ${h.text}`)).toEqual([])
  })

  it('falls back to neutral wording when the business is not configured', async () => {
    vi.stubEnv('BUSINESS_PROFILE_JSON', '')
    vi.stubEnv('NEXT_PUBLIC_BUSINESS_NAME', '')
    const { promptBusiness } = await import('@/config/prompt-business')
    const business = promptBusiness()
    expect(business.name).toBe('the business')
    expect(JSON.stringify(business)).not.toMatch(FIXED_BUSINESS)
    expect(JSON.stringify(business)).not.toMatch(/studio/i)
  })

  it('flows a configured name, description and city into the vision, competitor, copy and report prompts', async () => {
    vi.stubEnv('BUSINESS_PROFILE_JSON', PROFILE)
    vi.stubEnv('NEXT_PUBLIC_BUSINESS_NAME', 'Northwind Bikes')
    const { promptBusiness } = await import('@/config/prompt-business')
    expect(promptBusiness()).toMatchObject({ name: 'Northwind Bikes', description: 'bicycle repair shop', place: 'Lyon' })
    const { visionSystemPrompt } = await import('@/lib/creative/vision-analyzer')
    expect(visionSystemPrompt()).toContain('Northwind Bikes, bicycle repair shop in Lyon')
    const { buildCompetitorAdPrompt } = await import('@/lib/competitors/analyze-ad')
    const competitor = buildCompetitorAdPrompt({})
    expect(competitor.system).toContain('Northwind Bikes')
    expect(competitor.user).toContain("Northwind Bikes's strategy team")
    const { COPY_SYSTEM_PROMPT } = await import('@/lib/creative/copy-tone')
    expect(COPY_SYSTEM_PROMPT).toContain('copywriter for Northwind Bikes')
    const { SYSTEM_PROMPT } = await import('@/lib/report/prompt-builder')
    expect(SYSTEM_PROMPT).toContain("analyzing Northwind Bikes's supplied account evidence")
    for (const text of [visionSystemPrompt(), competitor.system, competitor.user, COPY_SYSTEM_PROMPT, SYSTEM_PROMPT]) {
      expect(text).not.toMatch(FIXED_BUSINESS)
    }
  })
})
