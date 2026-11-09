import { describe, expect, it } from 'vitest'
import { validateReportingPacket } from '../../src/lib/reporting/validation'
import { referenceReportingFixture } from './reference-fixture'
import { referenceDensityFixture } from './reference-density-check'

describe('fictional 53-ad pagination population', () => {
  it('supplies 53 unique cloned ad identities with valid claim bindings and preserves the original eight-ad fixture', () => {
    const base = referenceReportingFixture(), original = JSON.stringify(base)
    const density = referenceDensityFixture(base)
    const ads = density.meta.data!.entities.filter(entity => entity.level === 'ad')
    expect(ads).toHaveLength(53)
    expect(new Set(ads.map(ad => ad.id)).size).toBe(53)
    expect(ads.at(-1)).toMatchObject({ id: '53053', name: 'Synthetic density ad 53' })
    expect(() => validateReportingPacket({ section: 'meta', context: density.context, result: density.meta, notes: [] })).not.toThrow()
    expect(JSON.stringify(base)).toBe(original)
    expect(base.meta.data!.entities.filter(entity => entity.level === 'ad')).toHaveLength(8)
    const wrongIdentity = { ...density.meta, data: { ...density.meta.data!, entities: density.meta.data!.entities.map(entity =>
      entity.id === '53053' ? { ...entity, id: 'unbound-ad' } : entity) } }
    expect(() => validateReportingPacket({ section: 'meta', context: density.context, result: wrongIdentity, notes: [] })).toThrow()
  })
})
