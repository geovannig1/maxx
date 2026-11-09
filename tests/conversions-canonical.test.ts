import { describe, it, expect } from 'vitest'
import { canonicalConversion, CUSTOM_AGGREGATE_KEY } from '@/lib/conversions/labels'

// Meta reports the same conversion under many alias action_types (each carrying the same count), which
// inflated the /conversions table (Initiate Checkout x5 rows, Purchase x8, "TOTAL CONVERSIONS 59"). The
// canonical grouper collapses each family to one key so the table shows one row per real conversion.

describe('canonicalConversion', () => {
  it('collapses all Purchase aliases to one key', () => {
    for (const a of ['purchase', 'onsite_web_purchase', 'offsite_conversion.fb_pixel_purchase', 'offsite_purchase_add_20_s_calls', 'web_app_in_store_purchase']) {
      expect(canonicalConversion(a)?.key).toBe('purchase')
    }
  })
  it('collapses all Initiate Checkout aliases to one key', () => {
    for (const a of ['initiate_checkout', 'onsite_web_initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout', 'offsite_initiate_checkout_add_20_s_calls']) {
      expect(canonicalConversion(a)?.key).toBe('initiate_checkout')
    }
  })
  it('maps the named AppointmentConfirmed indicator to its own key', () => {
    expect(canonicalConversion('offsite_conversion.fb_pixel_custom.AppointmentConfirmed')?.key).toBe('appointment_confirmed')
  })
  it('treats the generic custom aggregate as a labeled non-conversion, distinct from AppointmentConfirmed', () => {
    const c = canonicalConversion('offsite_conversion.fb_pixel_custom')
    expect(c?.key).toBe(CUSTOM_AGGREGATE_KEY)
    expect(c?.label).toMatch(/aggregate/i)
    expect(c?.key).not.toBe('appointment_confirmed')
  })
  it('does NOT merge distinct engagement events (keeps them separate)', () => {
    expect(canonicalConversion('post_engagement')).toBeNull()
    expect(canonicalConversion('page_engagement')).toBeNull()
  })
})

// ── Named custom conversions must NOT collapse into families ──
describe('canonicalConversion — named custom conversions keep their own keys', () => {
  it('two distinct named custom purchases stay separate (no MAX-drop)', async () => {
    const a = canonicalConversion('offsite_conversion.fb_pixel_custom.EbookPurchase')
    const b = canonicalConversion('offsite_conversion.fb_pixel_custom.CoursePurchase')
    expect(a?.key).toBe('custom:ebookpurchase')
    expect(b?.key).toBe('custom:coursepurchase')
    expect(a?.key).not.toBe(b?.key)
  })
  it('named AppointmentConfirmed still maps to its family key', () => {
    expect(canonicalConversion('offsite_conversion.fb_pixel_custom.AppointmentConfirmed')?.key).toBe('appointment_confirmed')
  })
  it('standard purchase aliases still collapse to one family', () => {
    expect(canonicalConversion('offsite_conversion.fb_pixel_purchase')?.key).toBe('purchase')
    expect(canonicalConversion('onsite_web_purchase')?.key).toBe('purchase')
  })
})

  it('past-tense "initiated_checkout" alias also collapses (live residual)', async () => {
    expect(canonicalConversion('initiated_checkout')?.key).toBe('initiate_checkout')
  })
