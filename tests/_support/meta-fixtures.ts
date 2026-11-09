// SANITIZED production-shaped fixtures for the Meta native contracts.
//
// Every id, name, and URL here is synthetic. No access token, signed paging URL, real entity id, or
// customer value appears anywhere in this file — the shapes are real, the contents are not.
//
// Recommendation shape verified against Meta's Marketing API "Performance Recommendations"
// documentation (2026-07-26): data[].recommendations[], each carrying object_ids, type,
// recommendation_stage, recommendation_time, url, opportunity_score_lift, and a nested
// recommendation_content { lift_estimate, body, opportunity_score_lift }.

export const RECS_NESTED_SINGLE_GROUP = {
  data: [
    {
      recommendations: [
        {
          object_ids: ['100000000000000003'],
          recommendation_content: {
            lift_estimate: 0.14,
            body: 'Consolidate ad sets targeting overlapping audiences to exit the learning phase faster.',
            opportunity_score_lift: 6.2,
          },
          type: 'AUDIENCE_CONSOLIDATION',
          recommendation_stage: 'AVAILABLE',
          recommendation_time: '2026-07-24T09:15:00+0000',
          url: 'https://adsmanager.example.invalid/recommendation/1',
        },
      ],
    },
  ],
}

export const RECS_MULTIPLE_GROUPS = {
  data: [
    {
      recommendations: [
        {
          object_ids: ['100000000000000003', '100000000000000004'],
          recommendation_content: { lift_estimate: 0.09, body: 'Add more creative variety.', opportunity_score_lift: 3.5 },
          type: 'CREATIVE_DIVERSIFICATION',
          recommendation_stage: 'AVAILABLE',
          recommendation_time: '2026-07-25T12:00:00+0000',
          url: 'https://adsmanager.example.invalid/recommendation/2',
        },
        {
          object_ids: ['100000000000000005'],
          recommendation_content: { lift_estimate: 0.21, body: 'Raise the daily budget on the top ad set.', opportunity_score_lift: 8.1 },
          type: 'BUDGET_SCALE',
          recommendation_stage: 'AVAILABLE',
          recommendation_time: '2026-07-25T12:00:00+0000',
          url: 'https://adsmanager.example.invalid/recommendation/3',
        },
      ],
    },
    {
      recommendations: [
        {
          object_ids: ['100000000000000006'],
          recommendation_content: { lift_estimate: 0.05, body: 'Enable Advantage+ placements.', opportunity_score_lift: 2.0 },
          type: 'PLACEMENT_EXPANSION',
          recommendation_stage: 'DISMISSED',
          recommendation_time: '2026-06-01T08:00:00+0000',
          url: 'https://adsmanager.example.invalid/recommendation/4',
        },
      ],
    },
  ],
  paging: { cursors: { before: 'SYNTHETIC_BEFORE', after: 'SYNTHETIC_AFTER' } },
}

/** Optional fields absent: no lift estimate, no url, no object_ids, no opportunity score. */
export const RECS_MISSING_OPTIONAL_FIELDS = {
  data: [
    {
      recommendations: [
        {
          recommendation_content: { body: 'Review the audience definition for this ad set.' },
          type: 'AUDIENCE_REVIEW',
          recommendation_stage: 'AVAILABLE',
        },
      ],
    },
  ],
}

/** Business-level variant: recommendation_name + level instead of type. */
export const RECS_BUSINESS_LEVEL = {
  data: [
    {
      recommendations: [
        {
          object_ids: ['100000000000000007'],
          recommendation_content: { lift_estimate: 0.11, body: 'Consolidate campaigns.', opportunity_score_lift: 4.4 },
          recommendation_name: 'Campaign consolidation',
          level: 'CAMPAIGN',
          recommendation_stage: 'AVAILABLE',
          recommendation_time: '2026-07-20T10:00:00+0000',
          url: 'https://adsmanager.example.invalid/recommendation/5',
        },
      ],
    },
  ],
}

/** A REAL, meaningful state: no pending recommendations. */
export const RECS_EMPTY_PAGE = { data: [] }

/** A group present but its nested list empty. */
export const RECS_EMPTY_NESTED = { data: [{ recommendations: [] }] }

/** The regression case: the OLD top-level shape the previous parser assumed. Every field it expected
 *  is absent from the real payload, so records like this must be REJECTED, not mapped to all-nulls. */
export const RECS_MALFORMED_TOP_LEVEL = {
  data: [
    { recommendations: [{ some_unknown_key: 1, another: 'x' }] },
    { recommendations: [{ object_ids: ['100000000000000008'] }] },
  ],
}

export const RECS_NOT_AN_OBJECT = 'unexpected string body'
export const RECS_NO_DATA_KEY = { recommendations: [] }
export const RECS_DATA_NOT_ARRAY = { data: { recommendations: [] } }

/** Paging present; the parser must not choke on it and must not follow it implicitly. */
export const RECS_WITH_PAGING = {
  data: RECS_NESTED_SINGLE_GROUP.data,
  paging: {
    cursors: { before: 'SYNTHETIC_BEFORE', after: 'SYNTHETIC_AFTER' },
    // Deliberately token-free: a real Meta paging URL embeds an access token, which must never be
    // committed to a fixture or logged.
    next: 'https://graph.example.invalid/v25.0/act_000/recommendations?after=SYNTHETIC_AFTER',
  },
}

// ── Dataset /stats fixtures ───────────────────────────────────────────────────────────────────
// Verified result node (Meta docs, v25.0): { aggregation, data: [{ value, count }], start_time }.
// Hourly buckets, so a window spans several entries in `data`.

export const STATS_MATCH_KEYS = {
  data: [
    {
      aggregation: 'match_keys',
      start_time: '2026-07-25T10:00:00+0000',
      data: [
        { value: 'em', count: 120 },
        { value: 'fbp', count: 40 },
        { value: 'fbc', count: 15 },
      ],
    },
    {
      aggregation: 'match_keys',
      start_time: '2026-07-25T11:00:00+0000',
      data: [
        { value: 'em', count: 80 },
        { value: 'fbp', count: 20 },
      ],
    },
  ],
}

export const STATS_HAD_PII = {
  data: [
    { aggregation: 'had_pii', start_time: '2026-07-25T10:00:00+0000', data: [{ value: 'true', count: 190 }, { value: 'false', count: 10 }] },
  ],
}

export const STATS_EVENT_SOURCE = {
  data: [
    { aggregation: 'event_source', start_time: '2026-07-25T10:00:00+0000', data: [{ value: 'website', count: 150 }, { value: 'server', count: 60 }] },
  ],
}

export const STATS_PROCESSING_RESULTS = {
  data: [
    {
      aggregation: 'event_processing_results',
      start_time: '2026-07-25T10:00:00+0000',
      data: [{ value: 'processed', count: 200 }, { value: 'deduplicated', count: 45 }, { value: 'dropped', count: 5 }],
    },
  ],
}

export const STATS_EMPTY = { data: [] }
export const STATS_NO_DATA_KEY = { results: [] }
export const STATS_INNER_NOT_ARRAY = { data: [{ aggregation: 'match_keys', start_time: 'x', data: 'nope' }] }
export const STATS_NULL_BUCKET = { data: [null] }
