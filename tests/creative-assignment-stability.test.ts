import { describe, expect, it } from 'vitest'

import {
  resolveCreativeAssignment,
  type CreativeAssignmentObservation,
} from '@/lib/creative/assignment-stability'

const META_AD_ID = '100000000000017'
const META_CREATIVE_ID = '100000000000003'
const META_UPDATED_TIME = '2026-02-20T15:00:00Z'

function observationId(label: string): string {
  const hex = [...label]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(32, '0')
    .slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function observation(
  id: string,
  observedAt: string,
  overrides: Partial<CreativeAssignmentObservation> = {},
): CreativeAssignmentObservation {
  return {
    id: observationId(id),
    metaAdId: META_AD_ID,
    metaCreativeId: META_CREATIVE_ID,
    observedAt,
    metaUpdatedTime: META_UPDATED_TIME,
    ...overrides,
  }
}

function resolve(overrides: Partial<Parameters<typeof resolveCreativeAssignment>[0]> = {}) {
  return resolveCreativeAssignment({
    timezone: 'America/New_York',
    metaAdId: META_AD_ID,
    windowStart: '2026-03-07',
    windowEnd: '2026-03-09',
    observations: [
      observation('start', '2026-03-07T05:00:00Z'),
      observation('end', '2026-03-10T04:00:00Z'),
    ],
    ...overrides,
  })
}

describe('resolveCreativeAssignment', () => {
  it('returns stable identity across the March DST transition using exact local boundaries', () => {
    const result = resolve({
      observations: [
        observation('after-selected-end', '2026-03-10T05:00:00Z', {
          metaCreativeId: '100000000000005',
          metaUpdatedTime: '2026-03-10T05:00:00Z',
        }),
        observation('interior-after-shift', '2026-03-09T05:30:00Z'),
        observation('selected-start', '2026-03-07T05:00:00Z'),
        observation('before-selected-start', '2026-03-06T12:00:00Z', {
          metaCreativeId: '100000000000006',
          metaUpdatedTime: '2026-03-06T12:00:00Z',
        }),
        observation('selected-end', '2026-03-10T04:00:00Z'),
        observation('interior-before-shift', '2026-03-08T06:30:00Z'),
      ],
    })

    expect(result).toEqual({
      state: 'observed_stable',
      metaCreativeId: META_CREATIVE_ID,
      boundaryObservationIds: [observationId('selected-start'), observationId('selected-end')],
    })
  })

  it('returns stable identity across the November DST transition using exact local boundaries', () => {
    const result = resolve({
      windowStart: '2026-10-31',
      windowEnd: '2026-11-02',
      observations: [
        observation('fall-interior-after-shift', '2026-11-02T05:30:00Z'),
        observation('fall-end', '2026-11-03T05:00:00Z'),
        observation('fall-start', '2026-10-31T04:00:00Z'),
        observation('fall-interior-first-0130', '2026-11-01T05:30:00Z'),
        observation('fall-interior-second-0130', '2026-11-01T06:30:00Z'),
      ],
    })

    expect(result).toEqual({
      state: 'observed_stable',
      metaCreativeId: META_CREATIVE_ID,
      boundaryObservationIds: [observationId('fall-start'), observationId('fall-end')],
    })
  })

  it('compares Meta mutation timestamps as instants, not timestamp spellings', () => {
    expect(resolve({
      observations: [
        observation('start', '2026-03-07T05:00:00Z'),
        observation('interior', '2026-03-08T12:00:00Z', {
          metaUpdatedTime: '2026-02-20T10:00:00-05:00',
        }),
        observation('end', '2026-03-10T04:00:00Z', {
          metaUpdatedTime: '2026-02-20T15:00:00.000Z',
        }),
      ],
    })).toEqual({
      state: 'observed_stable',
      metaCreativeId: META_CREATIVE_ID,
      boundaryObservationIds: [observationId('start'), observationId('end')],
    })
  })

  it('does not treat an observation one nanosecond after local start as the start boundary', () => {
    expect(resolve({
      observations: [
        observation('after-start', '2026-03-07T05:00:00.000000001Z'),
        observation('end', '2026-03-10T04:00:00Z'),
      ],
    })).toEqual({ state: 'blocked', blockerCode: 'assignment_history_missing' })
  })

  it.each([
    ['missing the start boundary', [observation('end', '2026-03-10T04:00:00Z')]],
    ['missing the end boundary', [observation('start', '2026-03-07T05:00:00Z')]],
    ['using an observation before the exclusive end boundary', [
      observation('start', '2026-03-07T05:00:00Z'),
      observation('not-end', '2026-03-10T03:59:59Z'),
    ]],
  ])('blocks when assignment history is incomplete: %s', (_name, observations) => {
    expect(resolve({ observations })).toEqual({
      state: 'blocked',
      blockerCode: 'assignment_history_missing',
    })
  })

  it('blocks when any boundary or interior creative identity is null', () => {
    expect(resolve({
      observations: [
        observation('start', '2026-03-07T05:00:00Z'),
        observation('interior', '2026-03-08T12:00:00Z', { metaCreativeId: null }),
        observation('end', '2026-03-10T04:00:00Z'),
      ],
    })).toEqual({ state: 'blocked', blockerCode: 'assignment_identity_missing' })
  })

  it('blocks a creative change anywhere between the selected boundaries', () => {
    expect(resolve({
      observations: [
        observation('start', '2026-03-07T05:00:00Z'),
        observation('interior', '2026-03-08T12:00:00Z', { metaCreativeId: '100000000000004' }),
        observation('end', '2026-03-10T04:00:00Z'),
      ],
    })).toEqual({ state: 'blocked', blockerCode: 'assignment_changed' })
  })

  it('blocks Meta mutation timestamps that differ below millisecond precision', () => {
    expect(resolve({
      observations: [
        observation('start', '2026-03-07T05:00:00Z', {
          metaUpdatedTime: '2026-02-20T15:00:00.000000001Z',
        }),
        observation('end', '2026-03-10T04:00:00Z', {
          metaUpdatedTime: '2026-02-20T15:00:00.000000002Z',
        }),
      ],
    })).toEqual({ state: 'blocked', blockerCode: 'ad_mutation_ambiguous' })
  })

  it.each([
    ['null mutation time', null],
    ['changed mutation time', '2026-03-08T12:00:00Z'],
  ])('blocks ambiguous Meta mutation evidence: %s', (_name, metaUpdatedTime) => {
    expect(resolve({
      observations: [
        observation('start', '2026-03-07T05:00:00Z'),
        observation('interior', '2026-03-08T12:00:00Z', { metaUpdatedTime }),
        observation('end', '2026-03-10T04:00:00Z'),
      ],
    })).toEqual({ state: 'blocked', blockerCode: 'ad_mutation_ambiguous' })
  })

  it.each([
    ['malformed start date', { windowStart: '03-07-2026' }],
    ['impossible end date', { windowEnd: '2026-02-30' }],
    ['reversed window', { windowStart: '2026-03-10', windowEnd: '2026-03-09' }],
    ['invalid timezone', { timezone: 'America/Not_A_Zone' }],
    ['blank requested ad ID', { metaAdId: ' ' }],
    ['malformed requested Meta ad ID', { metaAdId: 'meta-ad' }],
  ])('blocks invalid resolver input: %s', (_name, invalidInput) => {
    expect(resolve(invalidInput)).toEqual({
      state: 'blocked',
      blockerCode: 'assignment_evidence_invalid',
    })
  })

  it.each([
    ['blank observation ID', [
      observation('start', '2026-03-07T05:00:00Z', { id: ' ' }),
      observation('end', '2026-03-10T04:00:00Z'),
    ]],
    ['blank creative ID', [
      observation('start', '2026-03-07T05:00:00Z', { metaCreativeId: ' ' }),
      observation('end', '2026-03-10T04:00:00Z'),
    ]],
    ['mismatched observation ad ID', [
      observation('start', '2026-03-07T05:00:00Z', { metaAdId: '100000000000018' }),
      observation('end', '2026-03-10T04:00:00Z'),
    ]],
    ['timestamp without an explicit zone', [
      observation('start', '2026-03-07T00:00:00'),
      observation('end', '2026-03-10T04:00:00Z'),
    ]],
    ['impossible observation timestamp', [
      observation('start', '2026-02-30T05:00:00Z'),
      observation('end', '2026-03-10T04:00:00Z'),
    ]],
    ['malformed mutation timestamp', [
      observation('start', '2026-03-07T05:00:00Z', { metaUpdatedTime: 'not-an-instant' }),
      observation('end', '2026-03-10T04:00:00Z'),
    ]],
  ])('blocks malformed observation evidence: %s', (_name, observations) => {
    expect(resolve({ observations })).toEqual({
      state: 'blocked',
      blockerCode: 'assignment_evidence_invalid',
    })
  })

  it('blocks duplicate observation IDs before resolving history', () => {
    expect(resolve({
      observations: [
        observation('duplicate', '2026-03-06T05:00:00Z'),
        observation('duplicate', '2026-03-06T06:00:00Z'),
      ],
    })).toEqual({ state: 'blocked', blockerCode: 'assignment_evidence_invalid' })
  })

  it('blocks duplicate observation instants even when timestamp spellings differ', () => {
    expect(resolve({
      observations: [
        observation('one', '2026-03-07T05:00:00Z'),
        observation('two', '2026-03-07T00:00:00-05:00'),
        observation('end', '2026-03-10T04:00:00Z'),
      ],
    })).toEqual({ state: 'blocked', blockerCode: 'assignment_evidence_invalid' })
  })

  it('validates every supplied row before sorting or returning missing history', () => {
    expect(resolve({
      observations: [
        observation('valid-but-too-late', '2026-03-08T12:00:00Z'),
        observation('malformed-old-row', 'not-a-timestamp'),
      ],
    })).toEqual({ state: 'blocked', blockerCode: 'assignment_evidence_invalid' })
  })
})
