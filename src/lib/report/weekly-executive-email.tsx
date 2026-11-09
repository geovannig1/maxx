import type { CSSProperties } from 'react'
import { Body, Column, Container, Head, Html, Link, Row, Section, Text, renderEmailDocument } from './email-primitives'

import type { WeeklyExecutiveDigestV1 } from '@/lib/report/weekly-executive'

export const WEEKLY_EXECUTIVE_HTML_MAX_BYTES = 90_000

const PAGE = '#ffffff'
const TEXT = '#202428'
const MUTED = '#5a6067'
const HAIRLINE = '#d8dde3'
const FONT = 'Arial, Helvetica, sans-serif'

const body: CSSProperties = {
  backgroundColor: PAGE, color: TEXT, fontFamily: FONT, margin: '0', padding: '16px 0',
}
const container: CSSProperties = { backgroundColor: PAGE, maxWidth: '640px', padding: '0 16px' }
const title: CSSProperties = { color: TEXT, fontSize: '20px', fontWeight: 700, lineHeight: '26px', margin: '0' }
const metadata: CSSProperties = { color: MUTED, fontSize: '13px', lineHeight: '20px', margin: '3px 0 0 0' }
const heading: CSSProperties = {
  borderBottom: `1px solid ${HAIRLINE}`, color: MUTED, fontSize: '12px', fontWeight: 700,
  letterSpacing: '0.07em', lineHeight: '18px', margin: '24px 0 8px 0',
  paddingBottom: '5px', textTransform: 'uppercase',
}
const paragraph: CSSProperties = { color: TEXT, fontSize: '14px', lineHeight: '21px', margin: '0' }
const bulletCell: CSSProperties = {
  color: MUTED, fontSize: '14px', lineHeight: '21px', paddingRight: '8px',
  verticalAlign: 'top', width: '12px',
}
const lineCell: CSSProperties = {
  color: TEXT, fontSize: '14px', lineHeight: '21px', verticalAlign: 'top', wordBreak: 'break-word',
}
const small: CSSProperties = { color: MUTED, fontSize: '12px', lineHeight: '18px', margin: '0' }

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

function Lines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <Text style={paragraph}>None observed.</Text>
  return (
    <Section>
      {lines.map((line, index) => (
        <Row key={`${index}-${line.slice(0, 24)}`} style={{ padding: '0 0 6px 0' }}>
          <Column style={bulletCell}>•</Column>
          <Column style={lineCell}>{line}</Column>
        </Row>
      ))}
    </Section>
  )
}

function Cta({ dashboardUrl }: { dashboardUrl: string }) {
  if (!isHttpUrl(dashboardUrl)) return null
  return (
    <Row style={{ margin: '24px 0 0 0' }}>
      <Column style={{ backgroundColor: TEXT, padding: '12px 20px', textAlign: 'center' }}>
        <Link
          href={dashboardUrl}
          style={{ color: PAGE, fontFamily: FONT, fontSize: '14px', fontWeight: 700, textDecoration: 'none' }}
        >
          Open reports
        </Link>
      </Column>
    </Row>
  )
}

function WeeklyExecutiveEmail({
  digest,
  dashboardUrl,
}: {
  digest: WeeklyExecutiveDigestV1
  dashboardUrl: string
}) {
  return (
    <Html lang="en">
      <Head><meta name="color-scheme" content="light" /></Head>
      <Body style={body}>
        <Container style={container}>
          <Text style={title}>Maxx Weekly Executive Read</Text>
          <Text style={metadata}>{`${digest.week_start}–${digest.week_end}`}</Text>
          {digest.account_name ? <Text style={metadata}>{digest.account_name}</Text> : null}

          <Row style={{ margin: '16px 0 0 0' }}>
            <Column style={{ backgroundColor: '#edf1f5', borderLeft: `4px solid ${MUTED}`, padding: '12px 14px' }}>
              <Text style={{ ...paragraph, fontWeight: 700 }}>Diagnostic only</Text>
              <Text style={{ ...small, margin: '3px 0 0 0' }}>This email creates no action authority.</Text>
            </Column>
          </Row>

          <SectionHeading>Weekly context</SectionHeading>
          <Lines lines={[
            digest.context.current_week,
            digest.context.prior_week,
            digest.context.eight_week,
            'Outcome business totals and Meta modelled attribution are different populations.',
          ]} />

          <SectionHeading>Setup</SectionHeading>
          <Lines lines={digest.sections.setup} />
          <SectionHeading>Audiences</SectionHeading>
          <Lines lines={digest.sections.audiences} />
          <SectionHeading>Placements</SectionHeading>
          <Lines lines={digest.sections.placements} />
          <SectionHeading>Creative</SectionHeading>
          <Lines lines={digest.sections.creative} />
          <SectionHeading>Tracking</SectionHeading>
          <Lines lines={digest.sections.tracking} />
          <SectionHeading>Material changes</SectionHeading>
          <Lines lines={digest.sections.material_changes} />

          <Cta dashboardUrl={dashboardUrl} />
          <Section style={{ borderTop: `1px solid ${HAIRLINE}`, margin: '24px 0 0 0', padding: '12px 0 0 0' }}>
            <Text style={small}>Generated only from the committed weekly report evidence snapshot.</Text>
            <Text style={{ ...small, margin: '5px 0 0 0' }}>
              Diagnostic only — no recommendation, prescription, or money-action authority is created here.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderWeeklyExecutiveHtml(
  digest: WeeklyExecutiveDigestV1,
  dashboardUrl: string,
): Promise<string> {
  const html = await renderEmailDocument(<WeeklyExecutiveEmail digest={digest} dashboardUrl={dashboardUrl} />)
  if (new TextEncoder().encode(html).byteLength > WEEKLY_EXECUTIVE_HTML_MAX_BYTES) {
    throw new Error('Weekly executive HTML exceeds its Gmail-safe byte budget.')
  }
  return html
}
