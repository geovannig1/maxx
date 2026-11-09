import { afterEach, describe, expect, it, vi } from 'vitest'

// The custom conversion that represents an outcome is read from configuration under a
// generic, browser-visible name (NEXT_PUBLIC_META_OUTCOME_CONVERSION_ID), so server and browser renders
// count the same Meta actions. The old server-only name is still accepted as a deprecated fallback.

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const actions = (id: string) => [{ action_type: `offsite_conversion.custom.${id}`, value: '3' }]

async function countWith(env: Record<string, string>, id: string): Promise<number | null> {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  const { readBookingValue } = await import('@/lib/sync/insight-outcomes')
  const { metaOutcomeConversionId } = await import('@/config/business-config')
  expect(typeof metaOutcomeConversionId()).toBe('string')
  const read = readBookingValue(actions(id) as never)
  return read.matched ? read.value : null
}

describe('outcome conversion id configuration', () => {
  it('counts the action of the conversion named by the generic public variable', async () => {
    await expect(countWith({ NEXT_PUBLIC_META_OUTCOME_CONVERSION_ID: '777000', META_APPOINTMENT_CONVERSION_ID: '' }, '777000')).resolves.toBe(3)
  })

  it('still accepts the deprecated variable when the new one is unset', async () => {
    await expect(countWith({ NEXT_PUBLIC_META_OUTCOME_CONVERSION_ID: '', META_APPOINTMENT_CONVERSION_ID: '888000' }, '888000')).resolves.toBe(3)
  })

  it('the new variable wins over the deprecated one', async () => {
    const { metaOutcomeConversionId } = await import('@/config/business-config')
    vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_CONVERSION_ID', '111')
    vi.stubEnv('META_APPOINTMENT_CONVERSION_ID', '222')
    expect(metaOutcomeConversionId()).toBe('111')
  })

  it('does not count an unrelated custom conversion (control)', async () => {
    await expect(countWith({ NEXT_PUBLIC_META_OUTCOME_CONVERSION_ID: '777000', META_APPOINTMENT_CONVERSION_ID: '' }, '999999')).resolves.not.toBe(3)
  })

  it('refuses a non-numeric id', async () => {
    const { metaOutcomeConversionId } = await import('@/config/business-config')
    vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_CONVERSION_ID', 'abc')
    expect(() => metaOutcomeConversionId()).toThrow(/numeric id/)
  })
})
