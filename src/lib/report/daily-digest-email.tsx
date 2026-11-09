import type { CSSProperties } from 'react'
import { Body, Column, Container, Head, Html, Link, Row, Section, Text, renderEmailDocument } from './email-primitives'
import {
  formatKpiValue,
  type DailyDigestKpi,
  type DailyDigestV3,
} from './daily-digest'
import {
  WEEKLY_SPEND_CONTEXT_UNAVAILABLE,
} from './daily-digest-signals'
import { formatMoney } from '@/lib/utils/format-currency'

/**
 * Gmail-safe HTML rendering of a COMMITTED v3 digest snapshot. Pure: snapshot in, string out —
 * nothing is passed in through a side channel, so this rendering and the markdown text part of the
 * same multipart message are incapable of disagreeing about any fact.
 *
 * Every constraint below is a Gmail rendering fact, not a preference:
 *   - table layout only; no flex/grid/position/CSS custom properties (Gmail supports none)
 *   - inline styles on every element; no <style> block, no media queries (Gmail iOS drops them)
 *   - one light theme with defensive mid-tones; Gmail has no prefers-color-scheme and some
 *     surfaces force-invert, so pure #ffffff/#000000 are unusable
 *   - no images and no external resources except the dashboard CTA: Gmail blocks images by
 *     default, so a skimmed digest must be complete without them
 *   - rendered source must stay well under Gmail's ~102KB clipping threshold
 */

const TEXT = '#1a1a1a'
const MUTED = '#6b7280'
const PAGE = '#fafafa'
const HAIRLINE = '#e3e3e3'
const FONT = 'Arial, Helvetica, sans-serif'

/**
 * V3 has no composite stoplight, and its three descriptive states render neutrally. KPI deltas are
 * neutral too: colouring one green or red would turn a descriptive daily comparison into a verdict.
 */
/**
 * Every `<Row>` is its own `<table>`, so without a fixed layout and an explicit width on EVERY cell
 * each row computes its own auto-layout geometry and no value lines up with its own column header.
 * These three widths are applied identically to the header row and to every KPI row.
 */
const COL_LABEL = '40%'
const COL_VALUE = '24%'
const COL_DELTA = '36%'
const fixedRow: CSSProperties = { tableLayout: 'fixed' }

const body: CSSProperties = { backgroundColor: PAGE, color: TEXT, fontFamily: FONT, margin: '0', padding: '16px 0' }
const container: CSSProperties = { backgroundColor: PAGE, maxWidth: '640px', padding: '0 16px' }
const headerTitle: CSSProperties = { color: TEXT, fontSize: '18px', fontWeight: 700, lineHeight: '24px', margin: '0' }
const headerMeta: CSSProperties = { color: MUTED, fontSize: '13px', lineHeight: '20px', margin: '2px 0 0 0' }
const heading: CSSProperties = {
  color: MUTED, fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em',
  lineHeight: '16px', margin: '24px 0 6px 0', textTransform: 'uppercase',
}
const paragraph: CSSProperties = { color: TEXT, fontSize: '14px', lineHeight: '21px', margin: '0' }
const smallMuted: CSSProperties = { color: MUTED, fontSize: '12px', lineHeight: '18px', margin: '0' }
const bulletGlyphCell: CSSProperties = { color: MUTED, fontSize: '14px', lineHeight: '21px', paddingRight: '8px', verticalAlign: 'top', width: '12px' }
const bulletTextCell: CSSProperties = { color: TEXT, fontSize: '14px', lineHeight: '21px', verticalAlign: 'top', wordBreak: 'break-word' }
const bulletRow: CSSProperties = { padding: '0 0 6px 0' }
const kpiHeadCell: CSSProperties = { borderBottom: `1px solid ${HAIRLINE}`, color: MUTED, fontSize: '11px', letterSpacing: '0.06em', padding: '0 0 6px 0', textTransform: 'uppercase' }
// `word-break` (not `overflow-wrap`, which Gmail does not reliably support) keeps a long
// unbreakable token — an ad name, a metric label — inside its fixed-width column.
const kpiCell: CSSProperties = { borderBottom: `1px solid ${HAIRLINE}`, fontSize: '14px', lineHeight: '20px', padding: '8px 0', verticalAlign: 'top', wordBreak: 'break-word' }
/** Right-aligned columns need a left gutter, or a short value butts against the next column. */
const kpiNumericHead: CSSProperties = { ...kpiHeadCell, padding: '0 0 6px 10px', textAlign: 'right' }
const kpiNumericCell: CSSProperties = { ...kpiCell, padding: '8px 0 8px 10px', textAlign: 'right' }

function usd(value: number): string {
  return `${formatMoney(value)}`
}

function signed(delta: number): string {
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`
}

/**
 * Branches on `state`, never on `noise_gated`: `no_baseline` and `within_noise` are both gated, but
 * one is a measurement that was never taken and the other one that came back flat. Printing "within
 * noise" for an absent baseline would claim a comparison nobody ever made.
 */
function deltaCell(kpi: DailyDigestKpi): { text: string; color: string; weight: number } {
  if (kpi.state === 'significant' && kpi.delta_pct !== null) {
    // Non-breaking space: the glyph and its number must never wrap apart.
    return { text: `${kpi.delta_pct > 0 ? '▲' : '▼'} ${signed(kpi.delta_pct)}`, color: TEXT, weight: 700 }
  }
  if (kpi.state === 'within_noise' && kpi.delta_pct !== null) {
    return { text: `${signed(kpi.delta_pct)} within noise`, color: MUTED, weight: 400 }
  }
  return { text: 'no comparison', color: MUTED, weight: 400 }
}

/** The CTA is the one external reference in the document; anything but http(s) is not linked. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function SectionHeading({ children }: { children: string }) {
  return <Text style={heading}>{children}</Text>
}

/** Bullets are the RENDERER's job: the structured arrays are plain sentences by contract. */
function Bullets({ lines }: { lines: string[] }) {
  return (
    <Section>
      {lines.map((line, index) => (
        <Row key={`${index}-${line.slice(0, 24)}`} style={bulletRow}>
          <Column style={bulletGlyphCell}>•</Column>
          <Column style={bulletTextCell}>{line}</Column>
        </Row>
      ))}
    </Section>
  )
}

/** An empty structured array is a STATE, not an absence of rendering: the owner must be able to
 *  tell "nothing to act on" from "this section failed to render". */
function BulletsOrEmptyState({ lines, emptyState }: { lines: string[]; emptyState: string }) {
  if (lines.length === 0) return <Text style={paragraph}>{emptyState}</Text>
  return <Bullets lines={lines} />
}

function DescriptiveState({ value }: { value: { state: string; line: string } }) {
  return (
    <Row>
      <Column
        style={{
          backgroundColor: '#f3f4f6',
          borderLeft: `4px solid ${MUTED}`,
          color: TEXT,
          fontSize: '14px',
          lineHeight: '21px',
          padding: '12px 14px',
        }}
      >
        <span style={{ fontWeight: 700 }}>{value.state.replace(/_/g, ' ')}</span>
        <br />
        {value.line}
      </Column>
    </Row>
  )
}

/**
 * A current daily budget is not historical pacing evidence. The shared boundary sentence keeps the
 * two MIME parts incapable of disagreeing about why V3 withholds a weekly budget comparison.
 */
function SpendContextSection({ pacing }: { pacing: DailyDigestV3['pacing'] }) {
  const spend = typeof pacing.spend === 'number' && Number.isFinite(pacing.spend)
    ? usd(pacing.spend)
    : 'unavailable'
  return (
    <Section>
      <Row>
        <Column style={{ fontSize: '20px', fontWeight: 700, lineHeight: '26px', paddingRight: '14px', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
          {spend}
        </Column>
        <Column style={{ color: MUTED, fontSize: '13px', lineHeight: '20px', verticalAlign: 'middle' }}>reported-day spend</Column>
      </Row>
      <Text style={{ ...smallMuted, margin: '6px 0 0 0' }}>{WEEKLY_SPEND_CONTEXT_UNAVAILABLE}</Text>
    </Section>
  )
}

function KpiTable({ kpis }: { kpis: DailyDigestKpi[] }) {
  return (
    <Section>
      <Row style={fixedRow}>
        <Column style={{ ...kpiHeadCell, width: COL_LABEL }}>Metric</Column>
        <Column style={{ ...kpiNumericHead, width: COL_VALUE }}>Today</Column>
        <Column style={{ ...kpiNumericHead, width: COL_DELTA }}>vs 7-day daily avg</Column>
      </Row>
      {kpis.map((kpi) => {
        const delta = deltaCell(kpi)
        return (
          <Row key={kpi.key} style={fixedRow}>
            <Column style={{ ...kpiCell, color: TEXT, width: COL_LABEL }}>{kpi.label}</Column>
            <Column
              style={{
                ...kpiNumericCell,
                color: kpi.value === null ? MUTED : TEXT,
                fontWeight: kpi.value === null ? 400 : 700,
                width: COL_VALUE,
              }}
            >
              {formatKpiValue(kpi)}
            </Column>
            <Column style={{ ...kpiNumericCell, color: delta.color, fontWeight: delta.weight, width: COL_DELTA }}>
              {delta.text}
            </Column>
          </Row>
        )
      })}
    </Section>
  )
}

/**
 * Without a linkable http(s) URL the ENTIRE block is omitted — chrome, label and all. Rendering the
 * button around a plain span produced a black "Open the dashboard" affordance that did nothing on
 * every send, and a dead control in a daily email trains distrust of everything else in it. Omitting
 * it also keeps the document's one external reference impossible to forge from a hostile URL.
 */
function Cta({ dashboardUrl }: { dashboardUrl: string }) {
  if (!isHttpUrl(dashboardUrl)) return null
  const label = 'Open the dashboard'
  const linkStyle: CSSProperties = { color: PAGE, fontFamily: FONT, fontSize: '14px', fontWeight: 700, textDecoration: 'none' }
  return (
    <Row style={{ margin: '24px 0 0 0' }}>
      <Column style={{ backgroundColor: TEXT, padding: '12px 20px', textAlign: 'center' }}>
        <Link href={dashboardUrl} style={linkStyle}>{label}</Link>
      </Column>
    </Row>
  )
}

function Footer({ reportDate }: { reportDate: string }) {
  return (
    <Section style={{ borderTop: `1px solid ${HAIRLINE}`, margin: '24px 0 0 0', padding: '12px 0 0 0' }}>
      <Text style={smallMuted}>{`Report date ${reportDate}. Generated from committed report facts.`}</Text>
      <Text style={{ ...smallMuted, margin: '6px 0 0 0' }}>
        Diagnostic only — no new action authority is created here.
      </Text>
      <Text style={{ ...smallMuted, margin: '6px 0 0 0' }}>
        Three planes, never mixed: the outcome ledger is the business total, Meta AppointmentConfirmed
        is a modelled estimate, and GA4 is web confirmation-event telemetry. They measure different
        populations and are not expected to agree.
      </Text>
      <Text style={{ ...smallMuted, margin: '6px 0 0 0' }}>
        Dates inside the attribution re-pull window are provisional and may still restate; today is
        usually incomplete rather than zero.
      </Text>
    </Section>
  )
}

function DailyDigestEmail({ digest, dashboardUrl }: { digest: DailyDigestV3; dashboardUrl: string }) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light" />
      </Head>
      <Body style={body}>
        <Container style={container}>
          <Text style={headerTitle}>Maxx Daily</Text>
          <Text style={headerMeta}>{digest.report_date}</Text>
          {digest.account_name.length > 0 ? <Text style={headerMeta}>{digest.account_name}</Text> : null}

          <SectionHeading>Business</SectionHeading>
          <DescriptiveState value={digest.states.business} />

          <SectionHeading>Paid delivery</SectionHeading>
          <DescriptiveState value={digest.states.paid_delivery} />

          <SectionHeading>Data confidence</SectionHeading>
          <DescriptiveState value={digest.states.data_confidence} />

          <SectionHeading>Spend context</SectionHeading>
          <SpendContextSection pacing={digest.pacing} />

          <SectionHeading>What changed</SectionHeading>
          <KpiTable kpis={digest.kpis} />

          <SectionHeading>Observed flags</SectionHeading>
          <BulletsOrEmptyState lines={digest.flags} emptyState="No observed flag was emitted." />

          <SectionHeading>Creative evidence</SectionHeading>
          <BulletsOrEmptyState lines={digest.creative} emptyState="No creative evidence was available." />

          <SectionHeading>Deterministic read</SectionHeading>
          <Text style={paragraph}>{digest.narrative.text}</Text>

          <SectionHeading>Governed actions</SectionHeading>
          <BulletsOrEmptyState lines={digest.decisions} emptyState="No governed action is present." />

          <Cta dashboardUrl={dashboardUrl} />
          <Footer reportDate={digest.report_date} />
        </Container>
      </Body>
    </Html>
  )
}

/**
 * The document carries a plain HTML5 doctype and no DTD URL: an email that is supposed to reference
 * no external host except the dashboard should not ship one (Gmail discards the doctype anyway).
 */
export async function renderDailyDigestHtml(
  digest: DailyDigestV3,
  dashboardUrl: string,
): Promise<string> {
  return renderEmailDocument(<DailyDigestEmail digest={digest} dashboardUrl={dashboardUrl} />)
}
