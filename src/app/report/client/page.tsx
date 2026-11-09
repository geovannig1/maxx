export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { getGa4ConfirmationTelemetryBySource, getGa4TrafficBySource } from '@/lib/ga4/client'
import { getBusinessFacts } from '@/lib/outcomes/business-facts-reader'
import { aggregateMetrics, emptyMetrics, INSIGHT_METRIC_COLUMNS, type EntityMetrics } from '@/lib/metrics/aggregate'
import { priorPeriod, computeDelta, comparisonLabel, type DeltaResult } from '@/lib/insights/compare'
import { resolveRange, rangeTitle } from '@/lib/date-range'
import { ATTRIBUTION_WINDOW_LABEL } from '@/lib/platforms/meta/attribution'
import { nyToday } from '@/lib/utils/date-utils'
import { PrintButton } from '@/components/reports/PrintButton'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { readAccountSpendWindow } from '@/lib/economics/ad-spend-reader'
import { outcomeWords } from '@/config/outcome-nouns'
import { formatMoney } from '@/lib/utils/format-currency'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// A clean, print/PDF-ready CLIENT report — no dashboard chrome, light theme. Three-plane provenance:
// The outcome source supplies all-source active appointments, booked value, checkout revenue, and blended MER; GA supplies
// session-channel confirmation telemetry; Meta covers paid delivery and modelled attribution.
// Auth-gated by the proxy AND by the owner check at the top of the page component.

type Row = Record<string, unknown>

async function getReportData(from: string, to: string, prior: { from: string; to: string }) {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  const acctId = activeAccount.ok ? activeAccount.account.id : null
  const accountName = activeAccount.ok
    ? (activeAccount.account.accountName ?? 'Example Studio')
    : 'Account unavailable'

  let cur: EntityMetrics = emptyMetrics()
  let prev: EntityMetrics = emptyMetrics()
  let metaAvailable = acctId !== null
  let priorMetaAvailable = acctId !== null
  let campaignsAvailable = acctId !== null
  const campAgg = new Map<string, { spend: number; leads: number }>()

  if (acctId) {
    const { data: accRows, error: accRowsError } = await db
      .from('daily_insights')
      .select(`date_start, ${INSIGHT_METRIC_COLUMNS}`)
      .eq('ad_account_id', acctId)
      .eq('entity_level', 'account')
      .gte('date_start', prior.from)
      .lte('date_start', to)
    if (accRowsError) {
      metaAvailable = false
      priorMetaAvailable = false
    } else {
      const rows = (accRows ?? []) as Row[]
      const inWin = (r: Row, a: string, b: string) => { const d = String(r.date_start ?? ''); return d >= a && d <= b }
      cur = aggregateMetrics(rows.filter((r) => inWin(r, from, to)))
      prev = aggregateMetrics(rows.filter((r) => inWin(r, prior.from, prior.to)))
    }

    try {
      const spendAsOf = new Date().toISOString()
      const [currentSpendWindow, priorSpendWindow] = await Promise.all([
        readAccountSpendWindow(db, acctId, { start: from, end: to }, spendAsOf),
        readAccountSpendWindow(db, acctId, { start: prior.from, end: prior.to }, spendAsOf),
      ])
      metaAvailable = metaAvailable && currentSpendWindow.status === 'available'
      priorMetaAvailable = priorMetaAvailable && priorSpendWindow.status === 'available'
      cur = {
        ...cur,
        spend: currentSpendWindow.status === 'available' ? Number(currentSpendWindow.totalSpend) : 0,
      }
      prev = {
        ...prev,
        spend: priorSpendWindow.status === 'available' ? Number(priorSpendWindow.totalSpend) : 0,
      }
    } catch {
      metaAvailable = false
      priorMetaAvailable = false
    }

    const { data: campRows, error: campRowsError } = await db
      .from('daily_insights')
      .select('meta_campaign_id, spend, leads')
      .eq('ad_account_id', acctId)
      .eq('entity_level', 'campaign')
      .gte('date_start', from)
      .lte('date_start', to)
    if (campRowsError) {
      campaignsAvailable = false
    } else {
      for (const r of (campRows ?? []) as Row[]) {
        const id = r.meta_campaign_id as string | null
        if (!id) continue
        const a = campAgg.get(id) ?? { spend: 0, leads: 0 }
        a.spend += Number(r.spend ?? 0); a.leads += Number(r.leads ?? 0)
        campAgg.set(id, a)
      }
    }
    campaignsAvailable = campaignsAvailable && metaAvailable
  }

  // Campaign names
  const topIds = [...campAgg.entries()].sort((a, b) => b[1].spend - a[1].spend).slice(0, 6).map(([id]) => id)
  const nameById = new Map<string, string>()
  if (acctId && topIds.length) {
    const { data: campaigns } = await db.from('campaigns').select('campaign_id, campaign_name').eq('ad_account_id', acctId).in('campaign_id', topIds)
    for (const c of (campaigns ?? []) as Row[]) nameById.set(c.campaign_id as string, (c.campaign_name as string) ?? (c.campaign_id as string))
  }
  const topCampaigns = topIds.map((id) => ({ name: nameById.get(id) ?? id, ...campAgg.get(id)! }))

  const rev = acctId ? await getGa4ConfirmationTelemetryBySource(from, to).catch(() => null) : null
  const revPrev = acctId ? await getGa4ConfirmationTelemetryBySource(prior.from, prior.to).catch(() => null) : null
  const traffic = acctId ? await getGa4TrafficBySource(from, to).catch(() => null) : null
  // Business truth: the outcome ledger, read through the SHARED classifier. Fail-soft to NULL — the
  // page then shows the totals as unavailable. It must never fall back to a GA event sum: this is a
  // client-facing report, and telemetry with no appointment identity is not a business total.
  const businessFacts = acctId ? await getBusinessFacts(acctId, from, to).then((x) => x.facts).catch(() => null) : null
  const outcomePrev = acctId ? await getBusinessFacts(acctId, prior.from, prior.to).then((x) => x.facts).catch(() => null) : null

  return { accountName, cur, prev, metaAvailable, priorMetaAvailable, campaignsAvailable, topCampaigns, rev, revPrev, traffic, businessFacts, outcomePrev }
}

// ── light-theme presentational helpers ──
const C = { ink: '#111827', muted: '#6b7280', line: '#e5e7eb', sheet: '#ffffff', accent: '#4F46E5', good: '#059669', bad: '#dc2626' }
const usd = (n: number | null | undefined) => n == null
  ? 'unavailable'
  : formatMoney(Number(n), { maximumFractionDigits: 0 })

function Delta({ d }: { d: DeltaResult | undefined }) {
  if (!d || d.direction === 'flat') return null
  const up = d.direction === 'up'
  return <span style={{ fontSize: 11, fontWeight: 600, color: up ? C.good : C.bad, marginLeft: 6 }}>{d.value > 0 ? '+' : ''}{d.value.toFixed(0)}%</span>
}

function Kpi({ label, value, sub, d }: { label: string; value: string; sub?: string; d?: DeltaResult | undefined }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: C.muted }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: C.ink, marginTop: 3 }}>{value}<Delta d={d} /></div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function EvidenceLine({ source, role, window, scope, availability }: { source: string; role: string; window: string; scope: string; availability: string }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '9px 10px', fontSize: 11, color: C.muted, lineHeight: 1.45 }}>
      <strong style={{ color: C.ink }}>{source}</strong> · {role}<br />
      Date: {window} · Scope: {scope}<br />
      Availability: {availability}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 13, fontWeight: 700, color: C.ink, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px' }}>{children}</h2>
}

export default async function ClientReportPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  // Auth: the proxy gates every non-/api route, and this page repeats the owner check itself.
  await requireOwner()
  const sp = await searchParams
  const r = resolveRange(sp, '1m')
  const prior = priorPeriod(r.from, r.to)
  const cmp = comparisonLabel(r.from, r.to)
  const { accountName, cur, prev, metaAvailable, priorMetaAvailable, campaignsAvailable, topCampaigns, rev, revPrev, traffic, businessFacts, outcomePrev } = await getReportData(r.from, r.to, prior)

  const spend = metaAvailable ? cur.spend : null
  const paid = rev?.available ? rev.paid : null
  const organic = rev?.available ? rev.organic : null
  // Business totals come from the OUTCOME LEDGER, ALWAYS. There is no GA fallback: summing GA
  // confirmation events would substitute telemetry with no appointment identity for business truth,
  // on a CLIENT-FACING report. If the ledger is unavailable the totals are unavailable, not estimated.
  const totalRevenue = businessFacts ? businessFacts.recordedOutcomeValue : null
  const totalBookings = businessFacts ? businessFacts.valueBearingBookings : null
  const totalsSource = businessFacts ? `Outcome ledger (amount paid on active ${OW.many})` : 'UNAVAILABLE — the ledger could not be read; GA telemetry is not substituted'
  // This subtracted GA event counts from ledger bookings, and GA event VALUE from booked
  // value, to estimate an "untracked" residual. Those quantities are not comparable — one GA event can
  // double-count a booking, and GA carries the NOMINAL price while
  // the ledger carries the charged one — so the difference is not a measurement of anything. A real
  // "not web-observed" count requires the exact appointment-id join (ledgerWithoutGa). Removed rather
  // than relabelled: an unsound number with a caveat is still an unsound number on a client report.
  const untrackedBookings: number | null = null
  const untrackedRevenue: number | null = null
  // Paid ROAS requires an exact appointment-id join valued from the ledger. GA event value / spend is
  // not a ROAS, so it is not computed on this page at all.
  const mer = totalRevenue != null && spend != null && spend > 0 ? totalRevenue / spend : null
  const paidPrev = revPrev?.available ? revPrev.paid : null

  const printCss = `
    .no-print:hover { opacity: .9; }
    @media print {
      .no-print { display: none !important; }
      body { background: #fff !important; }
      .report-sheet { box-shadow: none !important; margin: 0 !important; max-width: none !important; }
      @page { margin: 1.4cm; }
    }
  `

  return (
    <div style={{ background: '#f3f4f6', minHeight: '100vh', padding: '24px 16px', fontFamily: 'var(--font-inter), Inter, system-ui, sans-serif' }}>
      <style>{printCss}</style>
      <div className="report-sheet" style={{ maxWidth: 820, margin: '0 auto', background: C.sheet, borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.12)', padding: 36, color: C.ink }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, borderBottom: `2px solid ${C.ink}`, paddingBottom: 16, marginBottom: 22 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{accountName}</div>
            <div style={{ fontSize: 14, color: C.muted, marginTop: 2 }}>Performance Report — {rangeTitle(r)}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{r.from} → {r.to} · prepared by Maxx · generated {nyToday()}</div>
          </div>
          <PrintButton />
        </div>

        <div style={{ marginBottom: 24 }}>
          <SectionTitle>Evidence scope</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <EvidenceLine source="Outcomes" role="business truth" window={`${r.from} → ${r.to}`} scope={`account active ${OW.many}`} availability={businessFacts ? 'available' : 'unavailable; not replaced by GA4'} />
            <EvidenceLine source="GA4" role="session telemetry" window={`${r.from} → ${r.to}`} scope="channel confirmation events" availability={rev?.available ? 'available; not revenue' : 'unavailable'} />
            <EvidenceLine source="Meta" role="delivery and modelled attribution" window={`${r.from} → ${r.to}`} scope="ad account/campaign delivery" availability={metaAvailable ? 'delivery available; exact paid CPA/ROAS unavailable' : 'unavailable; not zero'} />
          </div>
        </div>

        {/* Headline */}
        <div style={{ marginBottom: 24 }}>
          <SectionTitle>Headline</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <Kpi label="Ad spend" value={metaAvailable ? usd(spend) : 'unavailable'} sub={metaAvailable ? `${r.days}d` : 'complete Meta insight window unavailable; not zero'} d={metaAvailable && priorMetaAvailable && spend != null ? computeDelta(spend, prev.spend, true) : undefined} />
            <Kpi label="GA confirmation value" value={paid ? usd(paid.eventValue) : '—'} sub="paid-channel telemetry — not revenue" d={paid && paidPrev ? computeDelta(paid.eventValue, paidPrev.eventValue, false) : undefined} />
            <Kpi label="Meta paid ROAS" value="unavailable" sub="GA paid-channel sessions do not prove Meta; view-through is absent" />
            <Kpi label="Paid confirmation events" value={paid ? String(Math.round(paid.confirmationEvents)) : '—'} sub={`GA telemetry — not ${OW.many}`} d={paid && paidPrev ? computeDelta(paid.confirmationEvents, paidPrev.confirmationEvents, false) : undefined} />
          </div>
        </div>

        {/* Business truth vs channel telemetry */}
        <div style={{ marginBottom: 24 }}>
          <SectionTitle>Business results and channel telemetry</SectionTitle>
          {paid && organic ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: C.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  <th style={{ padding: '6px 8px' }}>Evidence plane</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Count</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Value basis</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Availability / scope</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: `Paid (ads) — GA confirmation events / GA event value (telemetry, not ${OW.many})`, b: paid.confirmationEvents, rv: paid.eventValue },
                  { label: 'Organic / non-paid — GA confirmation events / GA event value (telemetry)', b: organic.confirmationEvents, rv: organic.eventValue },
                  ...(untrackedBookings != null && untrackedRevenue != null && (untrackedBookings > 0 || untrackedRevenue > 0)
                    ? [{ label: `Indicative gap: ledger ${OW.many} the web never observed (phone / off-site / blocked browsers)`, b: untrackedBookings, rv: untrackedRevenue }]
                    : []),
                  { label: `Total business — ${totalsSource}`, b: totalBookings, rv: totalRevenue, total: true },
                ].map((row) => (
                  <tr key={row.label} style={{ borderTop: `1px solid ${C.line}`, fontWeight: row.total ? 700 : 400 }}>
                    <td style={{ padding: '8px' }}>{row.label}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{row.b == null ? 'unavailable' : Math.round(row.b)}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{usd(row.rv)}</td>
                    <td style={{ padding: '8px', textAlign: 'right', color: C.muted }}>{row.total ? `active ${OW.many} only` : 'not comparable to ledger total'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : businessFacts ? (
            <p style={{ fontSize: 12, color: C.muted }}>
              Total business — {totalsSource}: <strong>{Math.round(businessFacts.valueBearingBookings)}</strong> value-bearing {OW.one}(s), <strong>{usd(businessFacts.recordedOutcomeValue)}</strong> amount paid on active {OW.many} (<strong>{usd(businessFacts.bookedValue)}</strong> scheduled booked value)
              {businessFacts.zeroValueAppointments > 0 ? <> (plus {businessFacts.zeroValueAppointments} zero-value {OW.one}(s) — real {OW.many} that charged nothing)</> : null}
              {typeof businessFacts.recordedOutcomeValue === 'number' && typeof outcomePrev?.recordedOutcomeValue === 'number' ? <> ({(() => { const d = computeDelta(businessFacts.recordedOutcomeValue, outcomePrev.recordedOutcomeValue, false); return d ? `${d.value > 0 ? '+' : ''}${d.value.toFixed(0)}% vs prior` : '' })()})</> : null}.
              GA4 unavailable for this window — the paid/organic split can&apos;t be shown.
            </p>
          ) : (
            <p style={{ fontSize: 12, color: C.muted }}>outcome ledger and GA4 both unavailable for this window — the breakdown can&apos;t be shown. Unavailable, not zero.</p>
          )}
          <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>Blended active-{OW.one} amount/spend ratio (recorded collected value on active {OW.many} &divide; complete Meta spend): <strong>{mer != null ? `${mer.toFixed(2)}x` : 'unavailable'}</strong>. This is an active-{OW.one} numerator only. The paid/organic rows above are GA <em>confirmation events</em> with no {OW.one} identity, so they are telemetry only and will not sum to the business total.</p>
        </div>

        {/* Delivery */}
        <div style={{ marginBottom: 24 }}>
          <SectionTitle>Delivery (Meta)</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
            <Kpi label="Impressions" value={metaAvailable ? cur.impressions.toLocaleString() : 'unavailable'} d={metaAvailable ? computeDelta(cur.impressions, prev.impressions, false) : undefined} />
            <Kpi label="Peak daily reach" value={metaAvailable ? cur.reach.toLocaleString() : 'unavailable'} sub={metaAvailable ? 'highest daily Meta reach' : undefined} />
            <Kpi label="Clicks" value={metaAvailable ? cur.clicks.toLocaleString() : 'unavailable'} d={metaAvailable ? computeDelta(cur.clicks, prev.clicks, false) : undefined} />
            <Kpi label="CTR" value={metaAvailable && cur.ctr != null ? `${cur.ctr.toFixed(2)}%` : metaAvailable ? '—' : 'unavailable'} d={metaAvailable ? computeDelta(cur.ctr, prev.ctr, false) : undefined} />
            <Kpi label="CPM" value={metaAvailable && cur.cpm != null ? usd(cur.cpm) : metaAvailable ? '—' : 'unavailable'} d={metaAvailable ? computeDelta(cur.cpm, prev.cpm, true) : undefined} />
          </div>
        </div>

        {/* Site traffic */}
        {traffic?.available && (
          <div style={{ marginBottom: 24 }}>
            <SectionTitle>Site traffic (GA4)</SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              <Kpi label="Paid sessions" value={traffic.paid.sessions.toLocaleString()} sub={`${traffic.paid.pageViews.toLocaleString()} page views`} />
              <Kpi label="Organic sessions" value={traffic.organic.sessions.toLocaleString()} sub={`${traffic.organic.pageViews.toLocaleString()} page views`} />
              <Kpi label="Total sessions" value={(traffic.paid.sessions + traffic.organic.sessions).toLocaleString()} />
            </div>
          </div>
        )}

        {/* Top campaigns */}
        {campaignsAvailable && topCampaigns.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <SectionTitle>Top campaigns by spend</SectionTitle>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: C.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  <th style={{ padding: '6px 8px' }}>Campaign</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Spend</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Leads</th>
                </tr>
              </thead>
              <tbody>
                {topCampaigns.map((c) => (
                  <tr key={c.name} style={{ borderTop: `1px solid ${C.line}` }}>
                    <td style={{ padding: '8px' }}>{c.name}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{usd(c.spend)}</td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>{c.leads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!campaignsAvailable && (
          <p style={{ fontSize: 12, color: C.muted, marginBottom: 24 }}>Campaign delivery is unavailable because the warehouse read failed. No zero-spend conclusion was made.</p>
        )}

        {/* Methodology footer */}
        <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 14, marginTop: 8, fontSize: 10.5, color: C.muted, lineHeight: 1.6 }}>
          <strong>Methodology.</strong> Active {OW.many}, scheduled booked value, and amount paid on active {OW.many} come from the outcome ledger. Amount paid is an active-{OW.one} measure only. GA4 rows are session-channel confirmation-event counts and event values (Paid = Paid Social/Search/Shopping/Video, Display, Cross-network; Organic = all non-paid). They have no {OW.one} identity and therefore are not a subset of ledger {OW.many} or value. GA paid channels do not prove Meta platform attribution, and Meta view-through outcomes cannot carry GA session attribution, so Meta paid ROAS is withheld. Meta delivery/conversion metrics are modelled estimates under a {ATTRIBUTION_WINDOW_LABEL} attribution window. “{cmp}” deltas compare equal-length windows only when both Meta windows are complete.
        </div>
      </div>
    </div>
  )
}
