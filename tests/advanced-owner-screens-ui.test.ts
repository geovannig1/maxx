import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('advanced owner screens UI contracts', () => {
  const pages = {
    competitors: read('src/app/(dashboard)/competitors/page.tsx'),
    discovery: read('src/app/(dashboard)/discovery/page.tsx'),
    signals: read('src/app/(dashboard)/signals/page.tsx'),
    create: read('src/app/(dashboard)/create/page.tsx'),
    hooks: read('src/app/(dashboard)/hooks/page.tsx'),
    briefs: read('src/app/(dashboard)/briefs/page.tsx'),
    conversions: read('src/app/(dashboard)/conversions/page.tsx'),
  }

  it('applies the shared advanced owner canvas to every command-palette screen', () => {
    for (const [name, source] of Object.entries(pages)) {
      expect(source, `${name} uses owner page shell`).toContain('owner-page')
      expect(source, `${name} uses advanced owner surface styling`).toContain('owner-surface')
      expect(source, `${name} has a page header`).toContain('<PageHeader')
    }
  })

  it('makes competitors and discovery one Intelligence workspace with cross-links', () => {
    expect(pages.competitors).toContain('Intelligence workspace')
    expect(pages.competitors).toContain('href="/discovery"')
    expect(pages.discovery).toContain('Intelligence workspace')
    expect(pages.discovery).toContain('href="/competitors"')
  })

  it('keeps advanced inspiration separate from account performance truth', () => {
    expect(pages.signals).toContain('Outside-account inspiration only')
    expect(pages.signals).toContain('not facts about your account')
    expect(pages.conversions).toContain('Meta raw diagnostic')
    expect(pages.conversions).toContain('never business ${OW.many}')
    expect(pages.conversions).not.toContain('business bookings.')
  })

  it('replaces internal enum-first copy with governed owner language', () => {
    expect(pages.create).toContain('Governed creative is blocked')
    expect(pages.create).not.toContain('title="CampaignPlan required"')
    expect(pages.briefs).toContain('Read-only legacy briefs')
    expect(pages.briefs).not.toContain('CAMPAIGN_PLAN_REQUIRED')
    expect(pages.hooks).toContain('Read-only copy library')
    expect(pages.hooks).toContain('manual library item')
  })
})
