import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'
import { MetaReportSchema, type MetaReport, type ReportSection, type ReportingContext } from '@/lib/reporting/contracts'
const { get, history } = vi.hoisted(() => ({ get: vi.fn(), history: vi.fn() }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: get }))
vi.mock('@/lib/reporting/creative-assignment-reader', () => ({ readReportCreativeAssignmentEvidence: history }))
const context: ReportingContext = {
  account: { id: 'account-db', metaAccountId: '123', name: 'Test' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
function response(path: string, params: Record<string, string>) {
  if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: 'America/New_York' }
  if (path.endsWith('/campaigns')) return { data: [{ id: 'c', name: 'Campaign', effective_status: 'PAUSED' }] }
  if (path.endsWith('/adsets')) return { data: [{ id: 's', name: 'Warm name', campaign_id: 'c', effective_status: 'PAUSED', targeting: { geo_locations: { countries: ['US'] } } }] }
  if (path.endsWith('/ads')) return { data: [{ id: 'a', name: 'Historical ad', campaign_id: 'c', adset_id: 's', effective_status: 'PAUSED', creative: { id: 'creative' } }] }
  if (path.endsWith('/customaudiences')) return { data: [] }
  if (path === '/creative') return { id: 'creative', image_url: 'https://cdn.example.test/image.jpg', body: 'Real copy', link_url: 'https://example.test/rent' }
  if (path.endsWith('/insights')) {
    const range = JSON.parse(params.time_range)
    const row = { date_start: range.since, date_stop: params.time_increment === '1' ? range.since : range.until, spend: '100', reach: '90', impressions: '180', frequency: '2', campaign_id: 'c', campaign_name: 'Campaign', adset_id: 's', adset_name: 'Warm name', ad_id: 'a', ad_name: 'Historical ad' }
    if (params.breakdowns === 'publisher_platform,platform_position') return { data: [{ ...row, publisher_platform: 'instagram', platform_position: 'reels' }] }
    if (params.breakdowns) return { data: [{ ...row, [params.breakdowns]: 'test' }] }
    return { data: [row] }
  }
  throw new Error('Unexpected fixture path')
}
beforeEach(() => {
  get.mockReset(); get.mockImplementation(response)
  history.mockReset(); history.mockImplementation(async (scope: ReportingContext) => ({ accountId: scope.account.id,
    asOf: scope.asOf, state: 'unavailable', observations: [], notes: ['Synthetic history unavailable.'] }))
})

describe('Meta report reader', () => {
  it('prioritizes complete hierarchy configuration ahead of optional trend and breakdown reads', async () => {
    const started: Array<{ path: string; detail: boolean }> = []
    get.mockImplementation(async (path: string, params: Record<string, string>) => {
      started.push({ path, detail: path.endsWith('/insights') && Boolean(params.time_increment || params.breakdowns) })
      return response(path, params)
    })

    const result = await readMetaReport(context)
    const firstDetail = started.findIndex(item => item.detail)
    expect(firstDetail).toBeGreaterThan(-1)
    for (const edge of ['/campaigns', '/adsets', '/ads', '/customaudiences']) {
      const configuration = started.findIndex(item => item.path.endsWith(edge))
      expect(configuration, edge).toBeGreaterThan(-1)
      expect(configuration, `${edge} starts before optional detail`).toBeLessThan(firstDetail)
    }
    expect(result.data?.entities.map(entity => entity.level)).toEqual(['campaign', 'adset', 'ad'])
  })
  it('fetches matching playable media for one identified feed video', async () => {
    get.mockImplementation((path: string, params: Record<string, string>) => {
      if (path === '/creative') return { id: 'creative', image_url: 'https://cdn.test/poster.jpg', asset_feed_spec: { videos: [{ video_id: '22' }] } }
      if (path === '/22') return { id: '22', source: 'https://cdn.test/22.mp4', length: 10 }
      return response(path, params)
    })
    const result = await readMetaReport(context)
    expect(result.data?.metrics.spend.current.value).toBe(100)
    expect(result.data?.entities.find(entity => entity.level === 'ad')?.creative).toMatchObject({
      format: 'video', videoUrl: 'https://cdn.test/22.mp4', durationSeconds: 10, identity: { structure: 'asset_feed' },
    })
    expect(get.mock.calls.filter(([path]) => path === '/22')).toHaveLength(1)
    expect(() => validateReportingPacket({ context, section: 'meta', result, notes: [] })).not.toThrow()
  })
  it('excludes discarded duplicate inventory IDs from optional history without losing native totals', async () => {
    const scope = { ...context, account: { ...context.account, id: '00000000-0000-4000-8000-000000001311' } }
    get.mockImplementation((path: string, params: Record<string, string>) => {
      const result = response(path, params)
      if (path.endsWith('/ads')) return { data: [{ ...result.data![0], id: '303' }, { ...result.data![0], id: '303' }] }
      if (path.endsWith('/insights')) return { data: result.data!.map(row => ({ ...row, ad_id: '301' })) }
      return result
    })
    const observation = { id: '00000000-0000-4000-8000-000000000001', metaAdId: '303', metaCreativeId: '401',
      observedAt: '2026-09-05T04:00:00Z', metaUpdatedTime: '2026-08-01T00:00:00Z' }
    history.mockImplementation(async (_context: ReportingContext, ids: string[]) => ({ accountId: scope.account.id,
      asOf: scope.asOf, state: 'available', observations: [observation].filter(row => ids.includes(row.metaAdId)), notes: [] }))
    const result = await readMetaReport(scope)
    expect(result.data?.metrics.spend.current.value).toBe(100)
    expect(result.data?.entities.filter(entity => entity.level === 'ad').map(entity => entity.id)).toEqual(['301'])
    const { creativeAssignmentEvidence: evidence, ...withoutHistory } = result.data!
    expect(() => validateReportingPacket({ context: scope, section: 'meta', result: { ...result, data: withoutHistory }, notes: [] })).not.toThrow()
    expect(() => validateReportingPacket({ context: scope, section: 'meta', result, notes: [] })).not.toThrow()
    expect(history).toHaveBeenCalledWith(scope, ['301'])
    expect(evidence).toMatchObject({ state: 'available', observations: [] })
  })
  it('emits native totals while optional assignment history is pending, then retains totals on failure', async () => {
    let release!: () => void
    const stalled = new Promise<void>(resolve => { release = resolve })
    history.mockImplementation(async () => {
      await stalled
      return { accountId: context.account.id, asOf: context.asOf, state: 'unavailable', observations: [], notes: ['Synthetic timeout.'] }
    })
    const onProgress = vi.fn()
    let complete = false
    const pending = readMetaReport(context, { onProgress }).then(result => { complete = true; return result })
    try {
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(1))
      expect(onProgress.mock.calls[0][0].data.metrics.spend.current.value).toBe(100)
      expect(history).toHaveBeenCalledWith(context, ['a'])
      expect(complete).toBe(false)
      release()
      const result = await pending
      expect(result.data?.metrics.spend.current.value).toBe(100)
      expect(result.data?.creativeAssignmentEvidence).toMatchObject({ state: 'unavailable', observations: [] })
      expect(() => validateReportingPacket({ context, section: 'meta', result, notes: [] })).not.toThrow()
    } finally { release(); await pending }
  })
  it('binds available history to configured, current and prior ad IDs without adding Meta reads', async () => {
    const scope = { ...context, account: { ...context.account, id: '00000000-0000-4000-8000-000000001311' } }
    get.mockImplementation((path: string, params: Record<string, string>) => {
      const result = response(path, params)
      if (path.endsWith('/ads')) return { data: [{ ...result.data![0], id: '303' }] }
      if (path.endsWith('/insights')) return { data: result.data!.map(row => ({ ...row,
        ad_id: JSON.parse(params.time_range).since === scope.range.from ? '301' : '302' })) }
      if (path === '/creative') return { ...result, image_hash: 'native-image-hash' }
      return result
    })
    const observations = [
      { id: '00000000-0000-4000-8000-000000000001', metaAdId: '301', metaCreativeId: '401', observedAt: '2026-08-29T00:00:00Z', metaUpdatedTime: '2026-08-01T00:00:00Z' },
      { id: '00000000-0000-4000-8000-000000000002', metaAdId: '301', metaCreativeId: '401', observedAt: '2026-09-05T04:00:00Z', metaUpdatedTime: '2026-08-01T00:00:00Z' },
    ]
    history.mockResolvedValue({ accountId: scope.account.id, asOf: scope.asOf, state: 'available', observations, notes: [] })
    const result = await readMetaReport(scope)
    expect(history).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledWith(scope, ['301', '302', '303'])
    expect(result.data?.creativeAssignmentEvidence?.observations).toEqual(observations)
    expect(result.data?.entities.find(entity => entity.id === '303')?.creative?.identity).toMatchObject({
      observedAt: scope.asOf, members: [{ kind: 'image', id: 'native-image-hash', role: 'media', sourcePaths: ['/image_hash'] }],
    })
    expect(get.mock.calls.find(([path]) => path === '/creative')?.[1].fields.split(',')).toContain('image_hash')
    expect(get.mock.calls.filter(([path]) => path.endsWith('/insights'))).toHaveLength(20)
    expect(() => validateReportingPacket({ context: scope, section: 'meta', result, notes: [] })).not.toThrow()
  })
  it.each(['inventory', 'dimension', 'creative', 'trend'])('emits reconciled totals before pending optional %s, then completes the same reads', async blocker => {
    let releaseCore!: () => void, releaseDetails!: () => void
    const core = new Promise<void>(resolve => { releaseCore = resolve })
    const details = new Promise<void>(resolve => { releaseDetails = resolve })
    get.mockImplementation(async (path, params) => {
      if (path.endsWith('/insights') && params.level === 'ad' && !params.time_increment && !params.breakdowns
        && JSON.parse(params.time_range).since === context.comparison.from) await core
      if ((blocker === 'inventory' && path.endsWith('/adsets')) || (blocker === 'dimension' && params.breakdowns)
        || (blocker === 'creative' && path === '/creative') || (blocker === 'trend' && params.time_increment)) await details
      const base = response(path, params)
      if (!path.endsWith('/insights')) return base
      return { data: (base.data ?? []).map(row => ({ ...row,
        ...(params.level === 'account' ? {} : {
          results: [{ indicator: 'AppointmentConfirmed', values: [{ value: '2', attribution_windows: ['default'] }, { value: '2', attribution_windows: ['7d_click'] }] }],
          conversion_values: [{ action_type: 'AppointmentConfirmed', value: '200' }],
        }),
      })) }
    })
    const onProgress = vi.fn<(result: ReportSection<MetaReport>) => void>()
    const pending = readMetaReport(context, { detailIds: ['a'], onProgress })
    try {
      await vi.waitFor(() => expect(get.mock.calls.filter(([path, params]) => path.endsWith('/insights') && !params.time_increment && !params.breakdowns)).toHaveLength(8))
      expect(onProgress).not.toHaveBeenCalled()
      releaseCore()
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(1), { timeout: 1_000 })
      const early = onProgress.mock.calls[0][0]
      expect(early.state).toBe('partial')
      expect(early.data?.detailState).toBe('loading')
      expect(early.notes.join(' ')).toMatch(/details.*configuration.*trends.*loading/i)
      expect(early.data?.metrics.spend.current.value).toBe(100)
      expect(early.data?.metrics.bookings.current.value).toBe(2)
      expect(early.data?.metrics.cost_per_booking.current.value).toBe(50)
      expect(early.data?.metrics.appointment_roas.current.value).toBe(2)
      expect(early.data?.metrics.reach.current.value).toBe(90)
      const campaign = early.data?.entities.find(entity => entity.level === 'campaign')
      expect(early.data?.metrics.bookings.current.inputClaimIds).toEqual([campaign?.metrics.bookings.current.claimId])
      expect(early.data?.entities).toHaveLength(3)
      expect(early.data?.entities.every(entity => entity.configurationAsOf === null && entity.audience === 'unknown'
        && entity.status === 'UNKNOWN' && entity.creative === null)).toBe(true)
      expect(early.data?.series).toEqual([])
      expect(early.data?.breakdowns).toEqual([])
      expect(() => validateReportingPacket({ context, section: 'meta', result: early, notes: [] })).not.toThrow()
      releaseDetails()
      const final = await pending
      expect(final.data?.detailState).toBe('complete')
      expect(final.data?.metrics).toEqual(early.data?.metrics)
      expect(final.data?.entities.find(entity => entity.level === 'ad')).toMatchObject({
        audience: 'cold', status: 'PAUSED', creative: { id: 'creative', body: 'Real copy' },
      })
      expect(final.data?.entities.find(entity => entity.level === 'ad')?.series).toHaveLength(1)
      expect(final.data?.breakdowns.length).toBeGreaterThan(0)
      expect(() => validateReportingPacket({ context, section: 'meta', result: final, notes: [] })).not.toThrow()
      const requests = get.mock.calls.map(([path, params]) => JSON.stringify([path, params]))
      expect(new Set(requests).size).toBe(requests.length)
      expect(get.mock.calls.filter(([path]) => path.endsWith('/insights'))).toHaveLength(24)
      expect(onProgress).toHaveBeenCalledTimes(1)
    } finally { releaseCore(); releaseDetails(); await pending }
  })
  it('contains progress observer errors without discarding the final report', async () => {
    const result = await readMetaReport(context, { onProgress: () => { throw new Error('observer failed') } })
    expect(result.data?.metrics.spend.current.value).toBe(100)
    expect(result.data?.detailState).toBe('complete')
  })
  it('uses impression-date claims throughout the packet with unchanged attribution on every native query', async () => {
    const result = await readMetaReport(context, { detailIds: ['a'] })
    const claims: Array<{ window: { basis: string }; comparison: { window: { basis: string } | null } }> = []
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      if ('claimId' in value) { claims.push(value as unknown as typeof claims[number]); return }
      Object.values(value).forEach(visit)
    }
    visit(result)
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.every(claim => claim.window.basis === 'impression_date_et' && (!claim.comparison.window || claim.comparison.window.basis === 'impression_date_et'))).toBe(true)
    const queries = get.mock.calls.filter(([path]) => path.endsWith('/insights')).map(([, params]) => params)
    expect(queries).toHaveLength(24)
    expect(queries.every(query => query.action_report_time === 'impression' && JSON.stringify(JSON.parse(query.action_attribution_windows)) === JSON.stringify(['7d_click', '1d_view']))).toBe(true)
    expect(() => validateReportingPacket({ context, section: 'meta', result, notes: [] })).not.toThrow()
  })
  it('defaults to aggregate entities without bulk ad trends or placements', async () => {
    const result = await readMetaReport(context)
    const queries = get.mock.calls.filter(([path]) => path.endsWith('/insights')).map(([, params]) => params)
    expect(queries).toHaveLength(20)
    expect(queries.some(query => query.level === 'ad' && (query.time_increment || query.breakdowns))).toBe(false)
    expect(result.data?.entities.every(entity => entity.breakdowns === undefined && (entity.level === 'campaign' || entity.series === undefined))).toBe(true)
    expect(result.data?.entities.find(entity => entity.level === 'campaign')?.series).toHaveLength(1)
    expect(Object.keys(result.data!.series[0].metrics).length).toBeGreaterThanOrEqual(49)
    expect(result.data!.series[0].metrics).toHaveProperty('purchase_roas')
    expect(result.data!.series[0].metrics).toHaveProperty('engagement_rate')
    expect(result.data!.series[0].metrics).toHaveProperty('messaging_conversations_started')
    expect(result.data!.series[0].metrics).toHaveProperty('instagram_profile_visits')
    expect(queries.every(query => query.fields.includes('instagram_profile_visits') && query.fields.includes('instagram_profile_follow'))).toBe(true)
    expect(() => validateReportingPacket({ context, section: 'meta', result, notes: [] })).not.toThrow()
  })
  it('filters requested ad detail natively and never attaches it to other inventory ads', async () => {
    get.mockImplementation((path, params) => path.endsWith('/ads')
      ? { data: [{ id: 'a', name: 'Delivered' }, { id: 'b', name: 'No delivery' }] } : response(path, params))
    const result = await readMetaReport(context, { detailIds: ['a'] })
    const queries = get.mock.calls.filter(([path, params]) => path.endsWith('/insights') && params.level === 'ad' && (params.time_increment || params.breakdowns))
    expect(queries).toHaveLength(4)
    expect(queries.every(([, params]) => JSON.stringify(JSON.parse(params.filtering)) === JSON.stringify([{ field: 'ad.id', operator: 'IN', value: ['a'] }]))).toBe(true)
    expect(result.data?.entities.find(entity => entity.id === 'a')?.series).toHaveLength(1)
    expect(result.data?.entities.find(entity => entity.id === 'b')?.series).toBeUndefined()
    expect(result.data?.entities.find(entity => entity.id === 'b')?.metrics).toEqual({})
    expect(() => validateReportingPacket({ context, section: 'meta', result, notes: [] })).not.toThrow()
  })
  it('does not attach returned foreign ad detail to the requested identity', async () => {
    const result = await readMetaReport(context, { detailIds: ['b'] })
    expect(result.data?.entities.find(entity => entity.id === 'a')?.series).toBeUndefined()
    expect(result.notes.join(' ')).toContain('Meta current ad daily unavailable')
  })
  it('flags hierarchy mismatches and withholds lower-level efficiency while preserving native observations', async () => {
    get.mockImplementation((path, params) => {
      const base = response(path, params)
      if (!path.endsWith('/insights')) return base
      const count = params.level === 'ad' || params.level === 'adset' ? '3' : '2'
      return { data: (base.data ?? []).map(row => ({ ...row,
        results: [{ indicator: 'AppointmentConfirmed', values: [{ value: count, attribution_windows: ['default'] }, { value: count, attribution_windows: ['7d_click'] }] }],
        conversion_values: [{ action_type: 'AppointmentConfirmed', value: String(Number(count) * 100) }],
        actions: [{ action_type: 'purchase', value: count }], action_values: [{ action_type: 'purchase', value: String(Number(count) * 100) }],
      })) }
    })
    const onProgress = vi.fn<(result: ReportSection<MetaReport>) => void>()
    const final = await readMetaReport(context, { onProgress })
    for (const section of [onProgress.mock.calls[0][0], final]) {
      const ad = section.data?.entities.find(entity => entity.level === 'ad')
      const campaign = section.data?.entities.find(entity => entity.level === 'campaign')
      expect(ad?.metrics.bookings.current.value).toBe(3)
      expect(campaign?.metrics.bookings.current.value).toBe(2)
      expect(ad?.metrics.cost_per_booking.current.value).toBeNull()
      expect(ad?.metrics.appointment_roas.current.value).toBeNull()
      expect(ad?.metrics.purchase_roas.current.value).toBeNull()
      expect(campaign?.metrics.cost_per_booking.current.value).toBe(50)
      expect(section.notes.join(' ')).toMatch(/hierarchy|reconcil/i)
      expect(() => validateReportingPacket({ context, section: 'meta', result: section, notes: [] })).not.toThrow()
    }
  })
  it('projects account AppointmentConfirmed from complete canonical campaigns with lineage', async () => {
    get.mockImplementation((path, params) => {
      const base = response(path, params)
      if (!path.endsWith('/insights')) return base
      return { data: (base.data ?? []).map(row => ({ ...row,
        ...(params.level === 'account' ? {} : { results: [{ indicator: 'AppointmentConfirmed', values: [{ value: '2', attribution_windows: ['default'] }, { value: '2', attribution_windows: ['7d_click'] }] }], conversion_values: [{ action_type: 'AppointmentConfirmed', value: '200' }] }),
      })) }
    })
    const section = await readMetaReport(context)
    const campaign = section.data?.entities.find(entity => entity.level === 'campaign')
    expect(section.data?.metrics.bookings.current.value).toBe(2)
    expect(section.data?.metrics.bookings.current.measurementKind).toBe('derived')
    expect(section.data?.metrics.bookings.current.inputClaimIds).toEqual([campaign?.metrics.bookings.current.claimId])
    expect(section.data?.metrics.cost_per_booking.current.value).toBe(50)
    expect(section.data?.metrics.appointment_roas.current.value).toBe(2)
    expect(section.data?.metrics.reach.current.value).toBe(90)
    expect(section.data?.entities.find(entity => entity.level === 'ad')?.metrics.cost_per_booking.current.value).toBe(50)
  })
  it('validates one-day packets without canonical/native claim identity collisions', async () => {
    const oneDay = { ...context, range: { from: '2026-09-04', to: '2026-09-04' }, comparison: { from: '2026-09-03', to: '2026-09-03' } }
    const result = await readMetaReport(oneDay)
    expect(() => validateReportingPacket({ context: oneDay, section: 'meta', result, notes: [] })).not.toThrow()
    expect(result.data?.metrics.bookings.current.claimId).not.toBe(result.data?.series[0].metrics.bookings.current.claimId)
  })
  it('keeps one-day account and series safety consistent for native purchase conflicts', async () => {
    const oneDay = { ...context, range: { from: '2026-09-04', to: '2026-09-04' }, comparison: { from: '2026-09-03', to: '2026-09-03' } }
    get.mockImplementation((path, params) => {
      const base = response(path, params)
      if (!path.endsWith('/insights')) return base
      return { data: (base.data ?? []).map(row => ({ ...row, action_values: [{ action_type: 'purchase', value: params.level === 'account' ? '300' : '200' }] })) }
    })
    const result = await readMetaReport(oneDay)
    expect(result.data?.metrics.purchase_roas.current.value).toBeNull()
    expect(result.data?.series[0].metrics.purchase_roas.current.value).toBeNull()
    expect(result.data?.series[0].metrics.purchase_roas.current.availability.blockerCodes).toContain('meta_outcome_hierarchy_unreconciled')
    expect(result.data?.series[0].metrics.purchase_value.current.value).toBe(300)
    expect(() => validateReportingPacket({ context: oneDay, section: 'meta', result, notes: [] })).not.toThrow()
  })
  it('does not project incomplete campaign fields even when native account money exists', async () => {
    get.mockImplementation((path, params) => {
      const base = response(path, params)
      if (!path.endsWith('/insights')) return base
      const rows = (base.data ?? []).map(row => ({ ...row, conversion_values: [{ action_type: 'AppointmentConfirmed', value: '200' }] }))
      return { data: params.level === 'campaign' ? [...rows, { ...rows[0], campaign_id: 'missing-campaign', conversion_values: undefined }] : rows }
    })
    const onProgress = vi.fn<(result: ReportSection<MetaReport>) => void>()
    const final = await readMetaReport(context, { onProgress })
    for (const result of [onProgress.mock.calls[0][0], final]) {
      expect(result.data?.metrics.appointment_value.current.value).toBeNull()
      expect(result.data?.metrics.appointment_roas.current.value).toBeNull()
      expect(() => validateReportingPacket({ context, section: 'meta', result, notes: [] })).not.toThrow()
    }
  })
  it('retains totals when Meta rejects one optional insight field', async () => {
    get.mockImplementation((path, params) => {
      if (path.endsWith('/insights') && params.fields.includes('video_avg_time_watched_actions')) {
        throw Object.assign(new Error('Unsupported field video_avg_time_watched_actions'), { code: 100 })
      }
      return response(path, params)
    })
    const section = await readMetaReport(context)
    expect(section.data?.metrics.spend.current.value).toBe(100)
    expect(section.data?.metrics.average_watch_seconds.current.value).toBeNull()
    expect(section.notes.join(' ')).toContain('video_avg_time_watched_actions')
  })
  it('uses exact native current/prior windows and retains historical paused ads with real creative identity', async () => {
    const section = await readMetaReport(context, { detailIds: ['a'] })
    expect(section.data?.metrics.reach.current.value).toBe(90)
    expect(section.data?.metrics.reach.previous?.window.start).toBe('2026-08-30')
    const ad = section.data?.entities.find(entity => entity.level === 'ad')
    expect(ad?.status).toBe('PAUSED')
    expect(ad?.creative?.id).toBe('creative')
    expect(ad?.creative?.body).toBe('Real copy')
    expect(ad?.audience).toBe('cold')
    expect(ad?.series?.[0].date).toBe('2026-09-02')
    expect(ad?.breakdowns?.[0].label).toContain('reels')
    expect(MetaReportSchema.safeParse(section.data).success).toBe(true)
    const queries = get.mock.calls.filter(([path]) => path === '/act_123/insights').map(([, params]) => params)
    expect(queries.some(query => query.level === 'account' && !query.time_increment && !query.breakdowns)).toBe(true)
    expect(queries.every(query => query.action_report_time === 'impression')).toBe(true)
    expect(queries.every(query => !query.date_preset)).toBe(true)
  })
  it('keeps totals when unsupported breakdowns and inventory fail, without falsely complete setup', async () => {
    get.mockImplementation((path, params) => {
      if (params.breakdowns || path.endsWith('/adsets')) throw new Error('upstream details must not leak')
      return response(path, params)
    })
    const section = await readMetaReport(context)
    expect(section.state).toBe('partial')
    expect(section.data?.metrics.spend.current.value).toBe(100)
    expect(section.data?.entities.find(entity => entity.level === 'ad')?.audience).toBe('unknown')
    expect(section.notes.join(' ')).not.toContain('upstream details')
    expect(section.notes.join(' ')).toContain('placement')
  })
  it('does not present foreign currency or wrong-timezone totals as requested USD/ET', async () => {
    get.mockImplementation((path, params) => path === '/act_123' ? { id: 'act_123', currency: 'EUR', timezone_name: 'Europe/Paris' } : response(path, params))
    const onProgress = vi.fn()
    expect((await readMetaReport(context, { onProgress })).state).toBe('unavailable')
    expect(onProgress).not.toHaveBeenCalled()
  })
  it('rejects wrong-window native rows without losing historical entities', async () => {
    get.mockImplementation((path, params) => path.endsWith('/insights') && !params.time_increment ? { data: [{ date_start: '2020-01-01', date_stop: '2020-01-02', spend: '999' }] } : response(path, params))
    const section = await readMetaReport(context)
    expect(section.data?.metrics.spend.current.value).toBeNull()
    expect(section.data?.entities.find(entity => entity.id === 'a')?.status).toBe('PAUSED')
  })
  it('preserves usable breakdowns even when totals and all inventory reads fail', async () => {
    get.mockImplementation((path, params) => {
      if (path !== '/act_123' && !params.breakdowns) throw new Error('unavailable')
      return response(path, params)
    })
    const section = await readMetaReport(context)
    expect(section.state).toBe('partial')
    expect(section.data?.breakdowns.length).toBeGreaterThan(0)
    expect(section.data?.metrics.spend.current.value).toBeNull()
  })
  it('refuses duplicated native rows and repeated pagination cursors', async () => {
    get.mockImplementation((path, params) => {
      if (path.endsWith('/insights')) { const page = response(path, params) as { data: unknown[] }; return { data: [...page.data, ...page.data], paging: { next: 'ignored', cursors: { after: 'same' } } } }
      return response(path, params)
    })
    const section = await readMetaReport(context)
    expect(section.data?.metrics.spend.current.value).toBeNull()
    expect(section.notes.join(' ')).toContain('unavailable')
    expect(get.mock.calls.length).toBeLessThan(100)
  })
})
