import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; operation: string; column?: string; value?: unknown }>,
  rows: {
    daily_insights: [] as Array<Record<string, unknown>>,
    adsets: [] as Array<Record<string, unknown>>,
    campaigns: [] as Array<Record<string, unknown>>,
    api_sync_logs: [] as Array<Record<string, unknown>>,
  },
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => ({
    ok: true,
    account: {
      id: '00000000-0000-4000-8000-000000000001',
      accountId: 'act_123',
      accountName: 'Example Studio',
    },
  })),
}))

vi.mock('@/lib/outcomes/business-facts-reader', () => ({
  getBusinessFactsForWindow: vi.fn(async () => ({
    valueBearingBookings: 4,
    recordedOutcomeValue: 800,
    observedCollectedValue: 800,
    bookedValue: 900,
    amountPaidCoverage: { withRecordedAmount: 4, total: 4 },
  })),
}))

vi.mock('@/lib/outcomes/adapters/acuity/ledger-health', () => ({
  requireAcuityLedgerHealth: vi.fn(async () => ({
    available: true,
    lastReconciledAt: '2026-08-21T11:50:00.000Z',
    windowBasis: 'booking_date_et',
    windowStartDate: '2026-08-01',
    windowEndDate: '2026-08-21',
    truncated: false,
    reason: null,
  })),
}))

vi.mock('@/lib/attribution/paid-cohort-reader', () => ({
  readLatestPaidCohortPair: vi.fn(async () => null),
}))

vi.mock('@/lib/attribution/paid-eligibility-manifest', () => ({
  readPaidEligibilityManifestForWindow: vi.fn(async () => null),
}))

vi.mock('@/lib/decisions/read-model', () => ({
  readDecisionQueueForAccount: vi.fn(async () => ({ items: [{
    id: 'queue-1', source_id: 'queue-1', title: 'Review source health', summary: 'Review the governed evidence.',
    bucket: 'needs_review', lifecycle: 'ready', authority: 'owner_review', review_date: null,
  }] })),
}))

vi.mock('@/lib/decisions/queue-v2', () => ({
  decisionIdsForCockpit: vi.fn(() => ({ decisionIds: ['queue-1'], primaryDecisionId: 'queue-1' })),
}))

function fakeDb() {
  return {
    from(table: keyof typeof state.rows) {
      state.calls.push({ table, operation: 'from' })
      let rows = [...state.rows[table]]
      const builder = {
        select() { return builder },
        eq(column: string, value: unknown) {
          state.calls.push({ table, operation: 'eq', column, value })
          rows = rows.filter((row) => row[column] === value)
          return builder
        },
        gte(column: string, value: unknown) {
          state.calls.push({ table, operation: 'gte', column, value })
          rows = rows.filter((row) => String(row[column]) >= String(value))
          return builder
        },
        lte(column: string, value: unknown) {
          state.calls.push({ table, operation: 'lte', column, value })
          rows = rows.filter((row) => String(row[column]) <= String(value))
          return builder
        },
        order() { return builder },
        limit(value: number) {
          rows = rows.slice(0, value)
          return builder
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then(resolve: (result: { data: typeof rows; error: null }) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(resolve)
        },
      }
      return builder
    },
  }
}

/**
 * The [from, to] of every `daily_insights` window this load queried, in order.
 *
 * Asserted as WINDOWS rather than as a flat list of gte/lte calls: the loader now reads the prior
 * period for trends, so a raw call list mixes three concerns and breaks on any ordering change while
 * saying nothing about which periods were actually fetched.
 */
function readWindows(): Array<[string, string]> {
  const bounds = state.calls.filter((call) =>
    call.table === 'daily_insights' && (call.operation === 'gte' || call.operation === 'lte'))
  const windows: Array<[string, string]> = []
  for (let i = 0; i + 1 < bounds.length; i += 2) {
    windows.push([String(bounds[i].value), String(bounds[i + 1].value)])
  }
  return windows
}

describe('range-bound cockpit loader', () => {
  beforeEach(() => {
    state.calls = []
    state.rows.daily_insights = [
      { ad_account_id: '00000000-0000-4000-8000-000000000001', date_start: '2026-08-01', date_stop: '2026-08-01', entity_level: 'account', spend: 10, bookings: 99, synced_at: '2026-08-21T11:40:00.000Z' },
      { ad_account_id: '00000000-0000-4000-8000-000000000001', date_start: '2026-08-02', date_stop: '2026-08-02', entity_level: 'account', spend: 20, bookings: 99, synced_at: '2026-08-21T11:40:00.000Z' },
      { ad_account_id: '00000000-0000-4000-8000-000000000001', date_start: '2026-08-01', date_stop: '2026-08-01', entity_level: 'campaign', meta_campaign_id: 'campaign-1', spend: 10, bookings: 1, synced_at: '2026-08-21T11:40:00.000Z' },
      { ad_account_id: '00000000-0000-4000-8000-000000000001', date_start: '2026-08-02', date_stop: '2026-08-02', entity_level: 'campaign', meta_campaign_id: 'campaign-1', spend: 20, bookings: 2, synced_at: '2026-08-21T11:40:00.000Z' },
      { ad_account_id: '00000000-0000-4000-8000-000000000001', date_start: '2026-08-21', date_stop: '2026-08-21', entity_level: 'account', spend: 3.5, bookings: null, synced_at: '2026-08-21T12:00:00.000Z' },
    ]
    state.rows.adsets = [{ ad_account_id: '00000000-0000-4000-8000-000000000001', effective_status: 'ACTIVE', daily_budget: 90 }]
    state.rows.campaigns = []
    state.rows.api_sync_logs = [{
      ad_account_id: '00000000-0000-4000-8000-000000000001', status: 'success',
      date_range_start: '2026-08-01', date_range_end: '2026-08-02',
      completed_at: '2026-08-21T12:00:00.000Z',
    }]
  })

  it('uses account spend but campaign-grain canonical Results for exactly the selected window', async () => {
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })

    expect(cockpit.claims[cockpit.paidPerformance.spendClaimId].value).toBe(30)
    expect(cockpit.claims[cockpit.paidPerformance.resultsClaimId].value).toBe(3)
    expect(cockpit.claims[cockpit.paidPerformance.purchaseRoasClaimId].value).toBeNull()
    expect(cockpit.claims[cockpit.paidPerformance.purchaseRoasClaimId].availability.blockerCodes)
      .toContain('meta_purchase_canonical_action_missing')
    expect(cockpit.claims[cockpit.partialToday.claimIds[0]].value).toBe(3.5)
    expect(cockpit.primaryDecisionId).toBe('queue-1')

    // Every window this load touched, in order. `readMetaDelivery` issues an account-level and a
    // campaign-level query per window, so each window appears twice.
    expect(readWindows()).toEqual([
      ['2026-08-01', '2026-08-02'],
      ['2026-08-01', '2026-08-02'],
      // The equal-length prior period, read once for the trend.
      ['2026-07-30', '2026-07-31'],
      ['2026-07-30', '2026-07-31'],
    ])
  })

  it('reads the prior period ONCE even though two maturities resolve to it', async () => {
    // Aug 1-2 is fully settled against a 2026-08-21 clock, so the `settled` maturity and the
    // classifier's both produce the same comparable pair. Reading it twice would be two queries
    // returning identical rows, and would let the two copies disagree if a sync landed between them.
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })
    const prior = readWindows().filter(([from]) => from === '2026-07-30')
    expect(prior).toHaveLength(2)  // one window, account + campaign grain
  })

  it('never re-reads the requested window for the trend — it is already in hand', async () => {
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })
    const requested = readWindows().filter(([from, to]) => from === '2026-08-01' && to === '2026-08-02')
    expect(requested).toHaveLength(2)  // the original read only; a re-read would make it 4
  })

  it('reads a SHORTER prior window when part of the requested window is still settling', async () => {
    // The manufactured-decline case, driven through the real loader. Against a 2026-08-21 clock the
    // settle boundary is 2026-08-13, so a request ending 2026-08-20 is comparable only through the
    // 13th for classifier-governed claims — while spend, stamped settled, stays comparable over the
    // whole request. Two different prior windows, which is exactly why they are read per maturity.
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-20' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })
    const windows = new Set(readWindows().map(([from, to]) => `${from}:${to}`))
    // Spend: 20 days, so the prior 20 days.
    expect(windows).toContain('2026-07-12:2026-07-31')
    // Conversions: settled only through Aug 13, so 13 days, and the prior 13.
    expect(windows).toContain('2026-08-01:2026-08-13')
    expect(windows).toContain('2026-07-19:2026-07-31')
  })

  it('uses only same-alias canonical Meta purchase evidence and never a checkout or alias sum', async () => {
    for (const row of state.rows.daily_insights) {
      if (row.entity_level !== 'account' || row.date_start === '2026-08-21') continue
      row.impressions = 1_000
      row.link_clicks = 10
      row.actions = [
        { action_type: 'purchase', value: row.date_start === '2026-08-01' ? '2' : '3' },
        { action_type: 'omni_purchase', value: '99' },
        { action_type: 'lead', value: '1' },
      ]
      row.action_values = [
        { action_type: 'purchase', value: row.date_start === '2026-08-01' ? '100' : '150' },
        { action_type: 'omni_purchase', value: '9999' },
      ]
    }
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' }, now: new Date('2026-08-21T12:20:00.000Z'), db: fakeDb() as never,
    })
    const purchaseRoas = cockpit.claims[cockpit.paidPerformance.purchaseRoasClaimId]
    const costPerLead = cockpit.paidPerformance.costPerLeadClaimId
      ? cockpit.claims[cockpit.paidPerformance.costPerLeadClaimId] : null

    expect(purchaseRoas.value).toBeCloseTo(250 / 30)
    expect(purchaseRoas.inputClaimIds).toHaveLength(2)
    expect(costPerLead?.value).toBe(15)
    expect(cockpit.claims[cockpit.paidPerformance.linkCtrClaimId].value).toBe(1)
    expect(cockpit.claims[cockpit.paidPerformance.cpmClaimId].value).toBe(15)
  })

  it('withholds purchase ROAS when canonical purchase count and value cannot be paired', async () => {
    for (const row of state.rows.daily_insights) {
      if (row.entity_level !== 'account' || row.date_start === '2026-08-21') continue
      row.impressions = 1_000
      row.link_clicks = 10
      row.actions = [{ action_type: 'purchase', value: '1' }]
      row.action_values = row.date_start === '2026-08-01'
        ? [{ action_type: 'purchase', value: '100' }, { action_type: 'purchase', value: '100' }]
        : [{ action_type: 'purchase', value: '100' }]
    }
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' }, now: new Date('2026-08-21T12:20:00.000Z'), db: fakeDb() as never,
    })
    const purchaseRoas = cockpit.claims[cockpit.paidPerformance.purchaseRoasClaimId]
    expect(purchaseRoas.value).toBeNull()
    expect(purchaseRoas.availability.blockerCodes).toContain('meta_purchase_canonical_pair_invalid:2026-08-01')
  })

  it('does not display an older successful sync as current after a newer partial sync', async () => {
    state.rows.api_sync_logs = [
      {
        ad_account_id: '00000000-0000-4000-8000-000000000001', status: 'partial',
        date_range_start: '2026-08-01', date_range_end: '2026-08-02',
        completed_at: '2026-08-21T12:04:00.000Z',
      },
      {
        ad_account_id: '00000000-0000-4000-8000-000000000001', status: 'success',
        date_range_start: '2026-08-01', date_range_end: '2026-08-02',
        completed_at: '2026-08-21T12:00:00.000Z',
      },
    ]
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })

    expect(cockpit.clocks.synchronizedAt).toBeNull()
  })

  it('uses a newer partial sync for delivery only when its durable delivery gates are complete', async () => {
    state.rows.api_sync_logs = [{
      ad_account_id: '00000000-0000-4000-8000-000000000001', status: 'partial',
      date_range_start: '2026-08-01', date_range_end: '2026-08-02',
      completed_at: '2026-08-21T12:04:00.000Z', insights_fetched: 8,
      decision_gate: { gates: { insightLevelsComplete: true, metaOutcomeMetricsComplete: true } },
    }]
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })

    expect(cockpit.clocks.synchronizedAt).toBe('2026-08-21T12:04:00.000Z')
    expect(cockpit.claims[cockpit.paidPerformance.spendClaimId].value).toBe(30)
  })

  it('withholds selected-window Meta claims without a successful sync generation that covers every requested day', async () => {
    state.rows.api_sync_logs = [{
      ad_account_id: '00000000-0000-4000-8000-000000000001', status: 'success',
      date_range_start: '2026-08-02', date_range_end: '2026-08-02',
      completed_at: '2026-08-21T12:00:00.000Z',
    }]
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })

    const spend = cockpit.claims[cockpit.paidPerformance.spendClaimId]
    expect(spend.value).toBeNull()
    expect(spend.availability.blockerCodes).toContain('meta_sync_generation_window_uncovered')
    expect(spend.freshness).toMatchObject({ state: 'unknown', observedAt: null })
  })

  it('uses the covering generation completion, not the newest individual row sync, as selected-window freshness', async () => {
    state.rows.daily_insights.forEach((row) => {
      if (row.date_start !== '2026-08-21') row.synced_at = '2026-08-21T12:04:00.000Z'
    })
    state.rows.api_sync_logs[0].completed_at = '2026-08-21T11:00:00.000Z'
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })

    const spend = cockpit.claims[cockpit.paidPerformance.spendClaimId]
    expect(spend.freshness.observedAt).toBe('2026-08-21T11:00:00.000Z')
  })

  it('withholds Results when campaign spend does not reconcile to account spend', async () => {
    state.rows.daily_insights = state.rows.daily_insights.filter((row) =>
      !(row.entity_level === 'campaign' && row.date_start === '2026-08-02'))
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })

    const spend = cockpit.claims[cockpit.paidPerformance.spendClaimId]
    const results = cockpit.claims[cockpit.paidPerformance.resultsClaimId]
    expect(spend.value).toBe(30)
    expect(spend.coverage).toEqual({ state: 'complete', numerator: 2, denominator: 2 })
    expect(results.value).toBeNull()
    expect(results.availability.blockerCodes)
      .toContain('meta_campaign_spend_reconciliation_failed:2026-08-02')
    expect(cockpit.sourceHealth.find((source) => source.plane === 'meta_delivery')?.state).toBe('partial')
  })

  it('blocks canonical Results for a percentage-small but greater-than-cent spend mismatch', async () => {
    const row = state.rows.daily_insights.find((candidate) =>
      candidate.entity_level === 'campaign' && candidate.date_start === '2026-08-02')
    if (row) row.spend = 19.98
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })

    const results = cockpit.claims[cockpit.paidPerformance.resultsClaimId]
    expect(results.value).toBeNull()
    expect(results.availability.blockerCodes)
      .toContain('meta_campaign_spend_reconciliation_failed:2026-08-02')
  })

  it('reconciles campaign to account spend at one minor unit of the account currency (KWD: 0.001)', async () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'KWD')
    try {
      const row = state.rows.daily_insights.find((candidate) =>
        candidate.entity_level === 'campaign' && candidate.date_start === '2026-08-02')
      if (row) row.spend = 19.998
      const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
      const cockpit = await loadPerformanceCockpitData({
        range: { from: '2026-08-01', to: '2026-08-02' },
        now: new Date('2026-08-21T12:20:00.000Z'),
        db: fakeDb() as never,
      })
      expect(cockpit.claims[cockpit.paidPerformance.resultsClaimId].availability.blockerCodes)
        .toContain('meta_campaign_spend_reconciliation_failed:2026-08-02')
    } finally { vi.unstubAllEnvs() }
  })

  it('withholds Results when a zero-spend campaign row omits the canonical result', async () => {
    const accountRow = state.rows.daily_insights.find((candidate) =>
      candidate.entity_level === 'account' && candidate.date_start === '2026-08-01')
    const campaignRow = state.rows.daily_insights.find((candidate) =>
      candidate.entity_level === 'campaign' && candidate.date_start === '2026-08-01')
    if (accountRow) accountRow.spend = 0
    if (campaignRow) {
      campaignRow.spend = 0
      campaignRow.bookings = null
    }

    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })

    expect(cockpit.claims[cockpit.paidPerformance.spendClaimId].value).toBe(20)
    expect(cockpit.claims[cockpit.paidPerformance.resultsClaimId].value).toBeNull()
    expect(cockpit.claims[cockpit.paidPerformance.resultsClaimId].availability.blockerCodes)
      .toContain('meta_campaign_result_incomplete:2026-08-01:campaign-1')
  })
})

describe('the delivery reader counts the days it actually saw', () => {
  /**
   * `spendCoveredDays` was added to make spend coverage honest, and NOTHING tested the reader.
   * Mutating `source-readers.ts` from `accountByDate.size` back to `expectedDates.length` — exactly
   * the behaviour the change condemned — left all 4102 tests green. The builder-side cases hand the
   * field in as a literal and assert the builder echoes it: fixture and assertion agreeing by
   * construction, which is this author's signature failure and was instance six of it.
   *
   * This drives the real reader through `loadPerformanceCockpitData` and removes a day from the data.
   */
  const ACCOUNT = '00000000-0000-4000-8000-000000000001'
  /** Self-contained: this describe sits outside the block that owns the shared `beforeEach`. */
  const seed = (accountDates: string[]) => {
    state.calls = []
    state.rows.daily_insights = [
      ...accountDates.map((date) => ({
        ad_account_id: ACCOUNT, date_start: date, date_stop: date, entity_level: 'account',
        spend: 10, bookings: 99, synced_at: '2026-08-21T11:40:00.000Z',
      })),
      ...['2026-08-01', '2026-08-02'].map((date) => ({
        ad_account_id: ACCOUNT, date_start: date, date_stop: date, entity_level: 'campaign',
        meta_campaign_id: 'campaign-1', spend: 10, bookings: 1, synced_at: '2026-08-21T11:40:00.000Z',
      })),
    ]
    state.rows.adsets = [{ ad_account_id: ACCOUNT, effective_status: 'ACTIVE', daily_budget: 90 }]
    state.rows.api_sync_logs = [{
      ad_account_id: ACCOUNT, status: 'success',
      date_range_start: '2026-08-01', date_range_end: '2026-08-02',
      completed_at: '2026-08-21T12:00:00.000Z',
    }]
  }

  it('reports fewer covered days when a day has no account row', async () => {
    seed(['2026-08-01'])   // 2026-08-02 has no account row
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })
    const spend = cockpit.claims[cockpit.paidPerformance.spendClaimId]
    // One of the two expected days was present.
    expect(spend.coverage.numerator).toBe(1)
    expect(spend.coverage.denominator).toBe(2)
    expect(spend.coverage.state).toBe('partial')
  })

  it('reports every day when all rows are present', async () => {
    // Guards the case above against passing because the count is always short.
    seed(['2026-08-01', '2026-08-02'])
    const { loadPerformanceCockpitData } = await import('@/lib/cockpit/builder')
    const cockpit = await loadPerformanceCockpitData({
      range: { from: '2026-08-01', to: '2026-08-02' },
      now: new Date('2026-08-21T12:20:00.000Z'),
      db: fakeDb() as never,
    })
    const spend = cockpit.claims[cockpit.paidPerformance.spendClaimId]
    expect(spend.coverage).toMatchObject({ state: 'complete', numerator: 2, denominator: 2 })
  })
})
